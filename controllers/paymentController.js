const Payment = require('../models/Payment');
const Errand = require('../models/Errand');
const { creditFloat, creditEarnings, calcFees } = require('../utils/walletUtils');
const { emitPaymentEvent, emitWalletUpdate } = require('../socket/socketManager');
const { runMatchingCycle } = require('../services/matchingService');
const notify = require('../services/notifyService');
const logger = require('../utils/logger');
const {
  initiateSTKPush,
  querySTKStatus,
  parseSTKCallback,
  parseB2CCallback,
  normalizePhone,
} = require('../services/mpesaService');

// ─── POST /api/payments/initiate ─────────────────────────────────────────────
// Pay-first flow: errand details are stored in the payment; the errand itself
// is created only after the STK callback confirms success.
exports.initiatePayment = async (req, res) => {
  const { phone, errandDetails } = req.body;

  if (!phone || !errandDetails) {
    return res.status(400).json({ status: 'fail', message: 'phone and errandDetails are required' });
  }

  const { title, description, location, amount } = errandDetails;

  if (!title || !description || !location?.address || !amount) {
    return res.status(400).json({
      status: 'fail',
      message: 'errandDetails must include title, description, location.address, and amount',
    });
  }

  const numAmount = Number(amount);
  if (isNaN(numAmount) || numAmount < 1) {
    return res.status(400).json({ status: 'fail', message: 'amount must be a positive number' });
  }

  // Block duplicate pending errand payments from the same customer
  const existing = await Payment.findOne({
    customer: req.user._id,
    type: 'errand_payment',
    status: 'pending',
  });
  if (existing && existing.expiresAt > new Date()) {
    return res.status(409).json({
      status: 'fail',
      message: 'You already have a pending payment. Complete it or wait for it to expire.',
      paymentId: existing._id,
    });
  }

  let normalizedPhone;
  try {
    normalizedPhone = normalizePhone(phone);
  } catch {
    return res.status(400).json({ status: 'fail', message: 'Invalid phone number format' });
  }

  const fees = calcFees(numAmount);
  const chargeAmount = Math.ceil(fees.totalCustomerPays);

  let stkResult;
  try {
    stkResult = await initiateSTKPush({
      phone: normalizedPhone,
      amount: chargeAmount,
      accountReference: `ERR-${Date.now().toString(36).toUpperCase().slice(-6)}`,
      description: 'Tumwa Errand Pay',
    });
  } catch (err) {
    logger.payment.error('STK push error', { userId: req.user._id, error: err.message });
    return res.status(502).json({
      status: 'fail',
      message: 'Could not reach M-Pesa. Please try again shortly.',
    });
  }

  const payment = await Payment.create({
    type: 'errand_payment',
    customer: req.user._id,
    amount: chargeAmount,
    phoneNumber: normalizedPhone,
    errandData: {
      title:       title.trim(),
      description: description.trim(),
      location: {
        address:  location.address.trim(),
        pickup:   location.pickup   ?? null,
        delivery: location.delivery ?? null,
      },
      amount: numAmount,
    },
    mpesa: {
      checkoutRequestId: stkResult.checkoutRequestId,
      merchantRequestId: stkResult.merchantRequestId,
    },
  });

  logger.payment.info('STK push initiated', {
    paymentId: payment._id,
    userId: req.user._id,
    amount: chargeAmount,
    checkoutRequestId: stkResult.checkoutRequestId,
  });

  res.status(202).json({
    status: 'success',
    message: 'M-Pesa prompt sent. Complete payment on your phone.',
    data: {
      paymentId: payment._id,
      checkoutRequestId: stkResult.checkoutRequestId,
      amount: chargeAmount,
      phone: normalizedPhone,
    },
  });
};

// ─── GET /api/payments/poll/:paymentId ───────────────────────────────────────
// Frontend polls this after initiatePayment to know when the errand is created.
exports.getPaymentById = async (req, res) => {
  const payment = await Payment.findById(req.params.paymentId).select(
    'type status errand customer runner amount failureReason expiresAt completedAt mpesa'
  );

  if (!payment) {
    return res.status(404).json({ status: 'fail', message: 'Payment not found' });
  }

  const isOwner =
    (payment.customer && payment.customer.toString() === req.user._id.toString()) ||
    (payment.runner   && payment.runner.toString()   === req.user._id.toString());

  if (!isOwner && req.user.role !== 'admin') {
    return res.status(403).json({ status: 'fail', message: 'Access denied' });
  }

  // If expired + pending, query Safaricom for the real outcome
  if (payment.status === 'pending' && payment.expiresAt < new Date() && payment.mpesa?.checkoutRequestId) {
    try {
      const stkStatus = await querySTKStatus(payment.mpesa.checkoutRequestId);
      if (stkStatus.ResultCode === '0') {
        payment.status = 'completed';
        payment.completedAt = new Date();
        await payment.save();
      } else if (stkStatus.ResultCode) {
        payment.status = 'failed';
        payment.failureReason = stkStatus.ResultDesc;
        await payment.save();
      }
    } catch (err) {
      logger.payment.error('STK status query error', { paymentId: payment._id, error: err.message });
    }
  }

  res.status(200).json({
    status: 'success',
    data: {
      paymentId: payment._id,
      status:    payment.status,
      amount:    payment.amount,
      errandId:  payment.errand ?? null,
      failureReason: payment.failureReason ?? null,
      expired: payment.status === 'pending' && payment.expiresAt < new Date(),
    },
  });
};

// ─── POST /api/payments/callback/stk ─────────────────────────────────────────
exports.handleSTKCallback = async (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  let parsed;
  try {
    parsed = parseSTKCallback(req.body);
  } catch (err) {
    logger.payment.error('STK callback parse error', { error: err.message, body: req.body });
    return;
  }

  const { checkoutRequestId, success, resultCode, resultDesc, receiptNumber } = parsed;

  const payment = await Payment.findOne({ 'mpesa.checkoutRequestId': checkoutRequestId });
  if (!payment) {
    logger.payment.error('STK callback: no matching payment', { checkoutRequestId });
    return;
  }

  if (payment.status !== 'pending') {
    logger.payment.warn('STK callback: payment already settled', { paymentId: payment._id });
    return;
  }

  payment.mpesa.resultCode = resultCode;
  payment.mpesa.resultDesc = resultDesc;

  if (!success) {
    payment.status      = 'failed';
    payment.failureReason = resultDesc;
    await payment.save();

    logger.payment.info('STK callback: payment failed', { paymentId: payment._id, resultDesc });

    if (payment.type === 'errand_payment') {
      emitPaymentEvent(payment.customer, 'payment:failed', {
        paymentId: payment._id,
        reason: resultDesc,
      });
      notify.send({
        userId:    payment.customer,
        title:     'Payment Failed',
        message:   `Payment for "${payment.errandData?.title}" did not go through. Please try again.`,
        type:      'payment',
        relatedId: payment._id,
        relatedModel: 'Payment',
        eventName: 'payment-failed',
        eventData: { paymentId: payment._id, reason: resultDesc },
      });
    } else if (payment.type === 'float_deposit') {
      notify.send({
        userId:    payment.runner,
        title:     'Deposit Failed',
        message:   `Float deposit of KES ${payment.amount} did not go through. Please try again.`,
        type:      'payment',
        relatedId: payment._id,
        relatedModel: 'Payment',
        eventName: 'deposit-failed',
        eventData: { paymentId: payment._id, amount: payment.amount, reason: resultDesc },
      });
    }
    return;
  }

  // ── Payment succeeded ─────────────────────────────────────────────────────
  payment.status      = 'completed';
  payment.mpesa.receiptNumber = receiptNumber;
  payment.completedAt = new Date();

  logger.payment.info('STK callback: payment completed', {
    paymentId: payment._id,
    type:      payment.type,
    amount:    payment.amount,
    receiptNumber,
  });

  // ── float_deposit: credit runner's floatBalance ───────────────────────────
  if (payment.type === 'float_deposit') {
    await payment.save();
    await creditFloat(payment.runner, payment.amount);
    emitWalletUpdate(payment.runner, 'float_deposit');

    notify.send({
      userId:    payment.runner,
      title:     'Float Deposited',
      message:   `KES ${payment.amount} added to your float. Receipt: ${receiptNumber}.`,
      type:      'payment',
      relatedId: payment._id,
      relatedModel: 'Payment',
      eventName: 'deposit-completed',
      eventData: { paymentId: payment._id, amount: payment.amount, receiptNumber },
    });
    return;
  }

  // ── errand_payment: create the errand, then mark payment done ────────────
  const { errandData } = payment;
  if (!errandData?.title || !errandData?.amount) {
    logger.payment.error('STK callback: missing errandData — cannot create errand', { paymentId: payment._id });
    await payment.save();
    return;
  }

  const fees = calcFees(errandData.amount);

  let errand;
  try {
    errand = await Errand.create({
      customer:    payment.customer,
      title:       errandData.title,
      description: errandData.description,
      location: {
        address:     errandData.location.address,
        // Pickup coordinates stored as the main point for proximity matching
        coordinates: errandData.location.pickup ?? null,
      },
      amount:      errandData.amount,
      isPaid:      true,
      paidAt:      new Date(),
      ...fees,
    });
  } catch (err) {
    logger.payment.error('STK callback: errand creation failed', {
      paymentId: payment._id,
      error: err.message,
    });
    await payment.save();
    return;
  }

  payment.errand = errand._id;
  await payment.save();

  emitPaymentEvent(payment.customer, 'payment:success', {
    paymentId: payment._id,
    errandId:  errand._id,
    amount:    payment.amount,
    receiptNumber,
  });

  setImmediate(() => runMatchingCycle(errand._id.toString()));

  notify.send({
    userId:    payment.customer,
    title:     'Payment Confirmed — Errand Posted!',
    message:   `KES ${payment.amount} paid. "${errand.title}" is now live for runners. Receipt: ${receiptNumber}.`,
    type:      'payment',
    relatedId: payment._id,
    relatedModel: 'Payment',
    eventName: 'payment-confirmed',
    eventData: { paymentId: payment._id, errandId: errand._id, amount: payment.amount, receiptNumber },
  });

  notify.sendToRole({
    role:      'admin',
    title:     'New Paid Errand',
    message:   `KES ${payment.amount} received. Errand "${errand.title}" created.`,
    type:      'payment',
    relatedId: payment._id,
    relatedModel: 'Payment',
    eventName: 'payment-confirmed',
    eventData: { paymentId: payment._id, errandId: errand._id, customer: payment.customer, amount: payment.amount, receiptNumber },
  });
};

// ─── POST /api/payments/callback/b2c ─────────────────────────────────────────
exports.handleB2CCallback = async (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  let parsed;
  try {
    parsed = parseB2CCallback(req.body);
  } catch (err) {
    logger.payment.error('B2C callback parse error', { error: err.message });
    return;
  }

  const { conversationId, success, resultCode, resultDesc, receiptNumber, amount } = parsed;

  const payment = await Payment.findOne({ 'mpesa.conversationId': conversationId });
  if (!payment) {
    logger.payment.error('B2C callback: no matching payment', { conversationId });
    return;
  }

  if (payment.status !== 'pending') {
    logger.payment.warn('B2C callback: payment already settled', { paymentId: payment._id });
    return;
  }

  payment.mpesa.resultCode = resultCode;
  payment.mpesa.resultDesc = resultDesc;

  if (!success) {
    payment.status      = 'failed';
    payment.failureReason = resultDesc;
    await payment.save();

    await creditEarnings(payment.runner, payment.amount);
    emitWalletUpdate(payment.runner, 'withdrawal_failed');

    logger.payment.info('B2C callback: withdrawal failed, funds restored', {
      paymentId: payment._id,
      amount:    payment.amount,
      resultDesc,
    });

    notify.send({
      userId:    payment.runner,
      title:     'Withdrawal Failed',
      message:   `Withdrawal of KES ${payment.amount} failed. Your wallet has been restored.`,
      type:      'payment',
      relatedId: payment._id,
      relatedModel: 'Payment',
      eventName: 'withdrawal-failed',
      eventData: { paymentId: payment._id, amount: payment.amount, reason: resultDesc },
    });
    return;
  }

  payment.status      = 'completed';
  payment.mpesa.receiptNumber = receiptNumber;
  payment.completedAt = new Date();
  await payment.save();

  emitWalletUpdate(payment.runner, 'withdrawal_completed');

  logger.payment.info('B2C callback: withdrawal completed', {
    paymentId: payment._id,
    amount:    amount ?? payment.amount,
    receiptNumber,
  });

  notify.send({
    userId:    payment.runner,
    title:     'Withdrawal Successful',
    message:   `KES ${payment.amount} sent to your M-Pesa. Receipt: ${receiptNumber}.`,
    type:      'payment',
    relatedId: payment._id,
    relatedModel: 'Payment',
    eventName: 'withdrawal-completed',
    eventData: { paymentId: payment._id, amount: amount ?? payment.amount, receiptNumber },
  });
};
