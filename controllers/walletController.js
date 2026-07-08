const User = require('../models/User');
const Errand = require('../models/Errand');
const Payment = require('../models/Payment');
const Dispute = require('../models/Dispute');
const { creditEarnings } = require('../utils/walletUtils');
const { initiateSTKPush, initiateB2C, normalizePhone } = require('../services/mpesaService');
const logger = require('../utils/logger');

// ── GET /api/wallet ───────────────────────────────────────────────────────────
exports.getWallet = async (req, res) => {
  const user = await User.findById(req.user._id).select('wallet');
  if (!user) {
    return res.status(404).json({ status: 'fail', message: 'User not found' });
  }

  const activeErrands = await Errand.countDocuments({
    runner: req.user._id,
    status: { $in: ['assigned', 'in_progress'] },
  });

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [earningsAgg, withdrawnAgg] = await Promise.all([
    Errand.aggregate([
      { $match: { runner: req.user._id, isPaid: true, paidAt: { $gte: monthStart } } },
      {
        $group: {
          _id: null,
          total: {
            $sum: {
              $cond: ['$ownMoneyUsed', { $add: ['$amount', '$runnerReceives'] }, '$runnerReceives'],
            },
          },
        },
      },
    ]),
    Payment.aggregate([
      { $match: { runner: req.user._id, type: 'withdrawal', status: 'completed', completedAt: { $gte: monthStart } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);

  const { floatBalance, heldFloat, earnings, trustBalance } = user.wallet;
  const availableFloat = Math.max(0, floatBalance - heldFloat);
  const withdrawable = availableFloat + earnings;

  return res.status(200).json({
    status: 'success',
    data: {
      floatBalance,
      heldFloat,
      availableFloat,
      earnings,
      withdrawable,
      trustBalance,
      activeErrands,
      monthlyEarnings: earningsAgg[0]?.total || 0,
      monthlyWithdrawn: withdrawnAgg[0]?.total || 0,
    },
  });
};

// ── GET /api/wallet/transactions ──────────────────────────────────────────────
exports.getTransactions = async (req, res) => {
  const runnerId = req.user._id;

  const [deposits, withdrawals, earnedErrands, penalizedDisputes] = await Promise.all([
    Payment.find({ runner: runnerId, type: 'float_deposit', status: 'completed' })
      .select('amount completedAt createdAt'),
    Payment.find({ runner: runnerId, type: 'withdrawal', status: 'completed' })
      .select('amount completedAt createdAt'),
    Errand.find({ runner: runnerId, isPaid: true })
      .select('amount runnerReceives ownMoneyUsed paidAt confirmedAt'),
    Dispute.find({
      runner: runnerId,
      status: 'resolved',
      'resolution.outcome': { $in: ['runner_at_fault', 'partial'] },
    }).select('errand resolution'),
  ]);

  const shortCode = (id) => id.toString().slice(-6).toUpperCase();

  const transactions = [
    ...deposits.map((p) => ({
      id: `deposit-${p._id}`,
      type: 'topup',
      title: 'Float top up',
      subtitle: 'M-Pesa',
      amount: p.amount,
      direction: 'credit',
      date: p.completedAt || p.createdAt,
    })),
    ...withdrawals.map((p) => ({
      id: `withdrawal-${p._id}`,
      type: 'withdrawal',
      title: 'Withdrawal',
      subtitle: 'M-Pesa',
      amount: p.amount,
      direction: 'debit',
      date: p.completedAt || p.createdAt,
    })),
    ...earnedErrands.map((e) => ({
      id: `earning-${e._id}`,
      type: 'earning',
      title: 'Payment received',
      subtitle: `Errand #${shortCode(e._id)}`,
      amount: e.ownMoneyUsed ? e.amount + e.runnerReceives : e.runnerReceives,
      direction: 'credit',
      date: e.paidAt || e.confirmedAt,
    })),
    ...penalizedDisputes.map((d) => ({
      id: `dispute-${d._id}`,
      type: 'payment',
      title: 'Payment to customer',
      subtitle: `Errand #${shortCode(d.errand)}`,
      amount: d.resolution.outcome === 'runner_at_fault'
        ? (d.resolution.refundAmount ?? d.resolution.penaltyAmount ?? 0)
        : (d.resolution.penaltyAmount ?? 0),
      direction: 'debit',
      date: d.resolution.resolvedAt,
    })),
  ].filter((t) => t.date && t.amount > 0);

  transactions.sort((a, b) => new Date(b.date) - new Date(a.date));

  return res.status(200).json({ status: 'success', data: transactions });
};

// ── POST /api/wallet/deposit-float ───────────────────────────────────────────
exports.depositFloat = async (req, res) => {
  const { amount, phone } = req.body;

  if (!amount || !phone) {
    return res.status(400).json({ status: 'fail', message: 'amount and phone are required' });
  }

  const numAmount = Number(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ status: 'fail', message: 'amount must be a positive number' });
  }

  if (numAmount < 10) {
    return res.status(400).json({ status: 'fail', message: 'Minimum deposit is KES 10' });
  }

  let normalizedPhone;
  try {
    normalizedPhone = normalizePhone(phone);
  } catch {
    return res.status(400).json({ status: 'fail', message: 'Invalid phone number format' });
  }

  // Block duplicate pending deposits
  const pendingDeposit = await Payment.findOne({
    runner: req.user._id,
    type: 'float_deposit',
    status: 'pending',
  });
  if (pendingDeposit && pendingDeposit.expiresAt > new Date()) {
    return res.status(409).json({
      status: 'fail',
      message: 'You already have a pending deposit. Check your M-Pesa prompt.',
      paymentId: pendingDeposit._id,
    });
  }

  const ceiled = Math.ceil(numAmount);

  let stkResult;
  try {
    stkResult = await initiateSTKPush({
      phone: normalizedPhone,
      amount: ceiled,
      accountReference: `FLOAT-${req.user._id.toString().slice(-6).toUpperCase()}`,
      description: 'Tumwa Float Deposit',
    });
  } catch (err) {
    logger.wallet.error('Float deposit STK push error', { userId: req.user._id, error: err.message });
    return res.status(502).json({
      status: 'fail',
      message: err.message || 'Failed to initiate M-Pesa payment. Please try again.',
    });
  }

  const payment = await Payment.create({
    type: 'float_deposit',
    runner: req.user._id,
    amount: ceiled,
    phoneNumber: normalizedPhone,
    mpesa: {
      checkoutRequestId: stkResult.checkoutRequestId,
      merchantRequestId: stkResult.merchantRequestId,
    },
  });

  logger.wallet.info('Float deposit initiated', {
    paymentId: payment._id,
    userId: req.user._id,
    amount: ceiled,
    checkoutRequestId: stkResult.checkoutRequestId,
  });

  return res.status(200).json({
    status: 'success',
    message: 'STK push sent. Enter your M-Pesa PIN to complete the deposit.',
    data: {
      paymentId: payment._id,
      amount: ceiled,
      phone: normalizedPhone,
    },
  });
};

// ── POST /api/wallet/withdraw ─────────────────────────────────────────────────
exports.withdrawEarnings = async (req, res) => {
  const { amount, phone } = req.body;

  if (!amount || !phone) {
    return res.status(400).json({ status: 'fail', message: 'amount and phone are required' });
  }

  const numAmount = Number(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ status: 'fail', message: 'amount must be a positive number' });
  }

  if (numAmount < 10) {
    return res.status(400).json({ status: 'fail', message: 'Minimum withdrawal is KES 10' });
  }

  const user = await User.findById(req.user._id).select('wallet');
  if (!user) {
    return res.status(404).json({ status: 'fail', message: 'User not found' });
  }

  const { floatBalance, heldFloat, earnings } = user.wallet;
  const availableFloat = Math.max(0, floatBalance - heldFloat);
  const withdrawable   = availableFloat + earnings;

  if (numAmount > withdrawable) {
    return res.status(400).json({
      status: 'fail',
      message: `Cannot withdraw KES ${numAmount.toFixed(2)} — your withdrawable balance is KES ${withdrawable.toFixed(2)}`,
    });
  }

  let normalizedPhone;
  try {
    normalizedPhone = normalizePhone(phone);
  } catch {
    return res.status(400).json({ status: 'fail', message: 'Invalid phone number format' });
  }

  // Block duplicate pending withdrawals
  const pendingWithdrawal = await Payment.findOne({
    runner: req.user._id,
    type: 'withdrawal',
    status: 'pending',
  });
  if (pendingWithdrawal && pendingWithdrawal.expiresAt > new Date()) {
    return res.status(409).json({
      status: 'fail',
      message: 'You already have a pending withdrawal. Please wait for it to complete.',
      paymentId: pendingWithdrawal._id,
    });
  }

  const floored = Math.floor(numAmount);

  // Optimistic debit — drain earnings first, then floatBalance
  const fromEarnings = Math.min(floored, earnings);
  const fromFloat    = floored - fromEarnings;
  const walletInc    = {};
  if (fromEarnings > 0) walletInc['wallet.earnings']     = -fromEarnings;
  if (fromFloat    > 0) walletInc['wallet.floatBalance'] = -fromFloat;
  await User.findByIdAndUpdate(req.user._id, { $inc: walletInc });

  let b2cResult;
  try {
    b2cResult = await initiateB2C({
      phone: normalizedPhone,
      amount: floored,
      remarks: 'Tumwa Earnings Withdrawal',
      occasion: `WITHDRAW-${req.user._id.toString().slice(-6).toUpperCase()}`,
    });
  } catch (err) {
    // Restore debited funds on B2C initiation failure
    await creditEarnings(req.user._id, floored);
    logger.wallet.error('B2C initiation error, funds restored', { userId: req.user._id, error: err.message });
    return res.status(502).json({
      status: 'fail',
      message: 'Could not reach M-Pesa. Your wallet has not been charged. Please try again.',
    });
  }

  const payment = await Payment.create({
    type: 'withdrawal',
    runner: req.user._id,
    amount: floored,
    phoneNumber: normalizedPhone,
    mpesa: {
      conversationId: b2cResult.conversationId,
      originatorConversationId: b2cResult.originatorConversationId,
    },
  });

  logger.wallet.info('Withdrawal initiated', {
    paymentId: payment._id,
    userId: req.user._id,
    amount: floored,
    conversationId: b2cResult.conversationId,
  });

  return res.status(200).json({
    status: 'success',
    message: `KES ${floored.toFixed(2)} withdrawal initiated. Funds will arrive on your M-Pesa shortly.`,
    data: {
      paymentId: payment._id,
      amount: floored,
      phone: normalizedPhone,
    },
  });
};
