const mongoose = require('mongoose');
const Dispute = require('../models/Dispute');
const Errand = require('../models/Errand');
const User = require('../models/User');
const Payment = require('../models/Payment');
const {
  penalizeErrandWallet,
  completeErrandWallet,
  refundToCustomer,
} = require('../utils/walletUtils');
const { initiateB2C, normalizePhone } = require('../services/mpesaService');
const notify = require('../services/notifyService');
const logger = require('../utils/logger');

// Lazy-load socket to avoid circular deps
let _socket;
const getSocket = () => {
  if (!_socket) _socket = require('../socket/socketManager');
  return _socket;
};

const DISPUTABLE_STATUSES = ['in_progress', 'completed'];

const populateDispute = (query) =>
  query
    .populate('errand', 'title amount status trustHeld floatUsed ownMoneyUsed runnerReceives')
    .populate('raisedBy', 'name role')
    .populate('customer', 'name phone')
    .populate('runner', 'name phone rating')
    .populate('resolution.resolvedBy', 'name');

// ─── POST /api/disputes ───────────────────────────────────────────────────────
exports.raiseDispute = async (req, res) => {
  const { errandId, reason, description, evidence } = req.body;

  if (!errandId || !reason || !description) {
    return res.status(400).json({
      status: 'fail',
      message: 'errandId, reason, and description are required',
    });
  }

  const errand = await Errand.findById(errandId);
  if (!errand) return res.status(404).json({ status: 'fail', message: 'Errand not found' });

  if (!DISPUTABLE_STATUSES.includes(errand.status)) {
    return res.status(400).json({
      status: 'fail',
      message: `Disputes can only be raised on errands with status: ${DISPUTABLE_STATUSES.join(', ')} (current: '${errand.status}')`,
    });
  }

  if (!errand.runner) {
    return res.status(400).json({
      status: 'fail',
      message: 'Cannot raise a dispute on an errand with no assigned runner',
    });
  }

  const userId = req.user._id.toString();
  const isCustomer = errand.customer.toString() === userId;
  const isRunner = errand.runner.toString() === userId;

  if (!isCustomer && !isRunner) {
    return res.status(403).json({ status: 'fail', message: 'You are not a party to this errand' });
  }

  // Block duplicate open disputes for the same errand
  const existing = await Dispute.findOne({
    errand: errandId,
    status: { $in: ['pending', 'under_review'] },
  });
  if (existing) {
    return res.status(409).json({
      status: 'fail',
      message: 'An open dispute already exists for this errand',
      disputeId: existing._id,
    });
  }

  // Funds are locked for both in_progress and completed (completeErrandWallet not yet called)
  const fundsLockedAtDispute = ['in_progress', 'completed'].includes(errand.status);

  const dispute = await Dispute.create({
    errand: errandId,
    raisedBy: req.user._id,
    customer: errand.customer,
    runner: errand.runner,
    reason: reason.trim(),
    description: description.trim(),
    evidence: Array.isArray(evidence) ? evidence.slice(0, 10) : [],
    fundsLockedAtDispute,
  });

  // Track disputes raised against the runner
  await User.findByIdAndUpdate(errand.runner, { $inc: { disputesAgainst: 1 } });

  // Mark errand as disputed so it cannot be actioned further
  errand.status = 'disputed';
  errand.disputedAt = new Date();
  errand.disputeReason = reason.trim();
  await errand.save();

  const populated = await populateDispute(Dispute.findById(dispute._id));

  // Socket: notify both parties
  getSocket().emitDisputeCreated(errand.customer, errand.runner, {
    disputeId: dispute._id,
    errandId:  errand._id,
    errandTitle: errand.title,
    raisedBy: { id: req.user._id, name: req.user.name, role: req.user.role },
    reason,
  });

  // Notify admins
  notify.sendToRole({
    role: 'admin',
    title: 'Dispute Raised',
    message: `${req.user.name} raised a dispute on errand "${errand.title}".`,
    type: 'dispute',
    relatedId: dispute._id,
    relatedModel: 'Dispute',
    eventName: 'dispute-raised',
    eventData: { disputeId: dispute._id, errandId: errand._id, raisedBy: req.user.role },
  });

  // Notify the other party
  const otherPartyId = isCustomer ? errand.runner : errand.customer;
  notify.send({
    userId: otherPartyId,
    title: 'Dispute Raised Against Your Errand',
    message: `A dispute has been raised on "${errand.title}". An admin will review it shortly.`,
    type: 'dispute',
    relatedId: dispute._id,
    relatedModel: 'Dispute',
    eventName: 'dispute-raised',
    eventData: { disputeId: dispute._id, errandId: errand._id, raisedBy: req.user.role },
  });

  res.status(201).json({
    status: 'success',
    message: 'Dispute raised. An admin will review it shortly.',
    data: { dispute: populated },
  });
};

// ─── PATCH /api/disputes/:id/review ──────────────────────────────────────────
// Admin marks a dispute as under review so both parties know it is being examined.
exports.reviewDispute = async (req, res) => {
  const dispute = await Dispute.findById(req.params.id).populate('errand', 'title');
  if (!dispute) return res.status(404).json({ status: 'fail', message: 'Dispute not found' });

  if (dispute.status !== 'pending') {
    return res.status(400).json({
      status: 'fail',
      message: `Dispute is already '${dispute.status}' — only pending disputes can be marked under review`,
    });
  }

  dispute.status = 'under_review';
  await dispute.save();

  const populated = await populateDispute(Dispute.findById(dispute._id));

  getSocket().emitDisputeUpdate(dispute.customer, dispute.runner, {
    disputeId: dispute._id,
    status: 'under_review',
    errandTitle: dispute.errand?.title,
  });

  // Notify both parties
  for (const userId of [dispute.customer, dispute.runner]) {
    notify.send({
      userId,
      title: 'Dispute Under Review',
      message: `Your dispute on "${dispute.errand?.title}" is now being reviewed by an admin.`,
      type: 'dispute',
      relatedId: dispute._id,
      relatedModel: 'Dispute',
      eventName: 'dispute-under-review',
      eventData: { disputeId: dispute._id },
    });
  }

  res.status(200).json({
    status: 'success',
    message: 'Dispute marked as under review.',
    data: { dispute: populated },
  });
};

// ─── PATCH /api/disputes/:id/resolve ─────────────────────────────────────────
// Admin resolves a dispute with one of four outcomes.
// Wallet ops run inside a MongoDB session for atomicity.
exports.resolveDispute = async (req, res) => {
  const { outcome, notes, penaltyAmount, refundAmount } = req.body;

  const validOutcomes = ['runner_at_fault', 'customer_at_fault', 'no_action', 'partial'];
  if (!outcome || !validOutcomes.includes(outcome)) {
    return res.status(400).json({
      status: 'fail',
      message: `outcome is required and must be one of: ${validOutcomes.join(', ')}`,
    });
  }

  if (outcome === 'partial' && (penaltyAmount == null || penaltyAmount < 0)) {
    return res.status(400).json({
      status: 'fail',
      message: 'penaltyAmount (>= 0) is required for a partial outcome',
    });
  }

  const dispute = await Dispute.findById(req.params.id).populate('errand');
  if (!dispute) return res.status(404).json({ status: 'fail', message: 'Dispute not found' });

  if (!['pending', 'under_review'].includes(dispute.status)) {
    return res.status(400).json({
      status: 'fail',
      message: `Dispute is already '${dispute.status}' and cannot be resolved again`,
    });
  }

  const { errand, runner, customer, fundsLockedAtDispute } = dispute;

  const session = await mongoose.startSession();
  session.startTransaction();

  let actualRefund = 0;

  try {
    // ── Wallet operations by outcome ──────────────────────────────────────────
    if (fundsLockedAtDispute) {
      switch (outcome) {
        case 'runner_at_fault': {
          // Runner forfeits full collateral (errand.amount); customer gets refunded
          const penalty = errand.amount;
          actualRefund = refundAmount != null ? Math.min(refundAmount, penalty) : penalty;
          await penalizeErrandWallet(runner, errand, penalty, session);
          await refundToCustomer(customer, actualRefund, session);
          break;
        }

        case 'customer_at_fault':
        case 'no_action':
          // Runner completed (or was not at fault) — release held funds + pay commission
          await completeErrandWallet(runner, errand, session);
          actualRefund = 0;
          break;

        case 'partial': {
          const penalty = Math.min(penaltyAmount, errand.amount);
          actualRefund = refundAmount != null ? refundAmount : 0;
          await penalizeErrandWallet(runner, errand, penalty, session);
          if (actualRefund > 0) {
            await refundToCustomer(customer, actualRefund, session);
          }
          break;
        }
      }
    }
    // If fundsLockedAtDispute = false: funds were already released before dispute raised
    // (edge case — errand was confirmed before dispute). No wallet reversal needed.

    // ── Update dispute record ─────────────────────────────────────────────────
    dispute.status = 'resolved';
    dispute.resolution = {
      outcome,
      notes: notes?.trim() || null,
      penaltyAmount: outcome === 'partial' ? penaltyAmount : null,
      refundAmount: actualRefund,
      resolvedBy: req.user._id,
      resolvedAt: new Date(),
    };
    await dispute.save({ session });

    // Restore errand status to completed (was stuck at disputed)
    if (errand.status === 'disputed') {
      errand.status = 'completed';
      errand.completedAt = errand.completedAt || new Date();
      await errand.save({ session });
    }

    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    logger.error('[Dispute] resolveDispute transaction failed', { error: err.message, disputeId: dispute._id });
    return res.status(500).json({ status: 'fail', message: 'Resolution failed. Please try again.' });
  } finally {
    session.endSession();
  }

  const populated = await populateDispute(Dispute.findById(dispute._id));

  // ── Trigger M-Pesa B2C refund to customer (background) ───────────────────
  if (actualRefund > 0) {
    setImmediate(async () => {
      try {
        const customerUser = await User.findById(customer).select('name phone');
        if (customerUser?.phone) {
          const normalizedPhone = normalizePhone(customerUser.phone);
          const b2cResult = await initiateB2C({
            phone:   normalizedPhone,
            amount:  actualRefund,
            remarks: `Dispute refund - ${errand.title}`,
            occasion: `Dispute ${dispute._id}`,
          });
          await Payment.create({
            type:     'dispute_refund',
            customer: customer,
            amount:   actualRefund,
            phoneNumber: normalizedPhone,
            status:   'pending',
            mpesa: {
              conversationId:          b2cResult.conversationId,
              originatorConversationId: b2cResult.originatorConversationId,
            },
          });
          logger.info('[Dispute] B2C refund initiated', {
            disputeId: dispute._id,
            customerId: customer,
            amount: actualRefund,
          });
        }
      } catch (err) {
        // B2C failure is non-fatal — customer wallet was already credited
        logger.error('[Dispute] B2C refund initiation failed', { error: err.message, disputeId: dispute._id });
      }
    });
  }

  // ── Socket events ─────────────────────────────────────────────────────────
  getSocket().emitDisputeResolved(customer, runner, {
    disputeId: dispute._id,
    errandId:  errand._id,
    errandTitle: errand.title,
    outcome,
    refundAmount: actualRefund,
    notes: notes || null,
  });

  // ── Notifications ─────────────────────────────────────────────────────────
  notify.send({
    userId: customer,
    title: 'Dispute Resolved',
    message: buildCustomerMessage(outcome, actualRefund),
    type: 'dispute',
    relatedId: dispute._id,
    relatedModel: 'Dispute',
    eventName: 'dispute-resolved',
    eventData: { disputeId: dispute._id, outcome, refundAmount: actualRefund },
  });

  notify.send({
    userId: runner,
    title: 'Dispute Resolved',
    message: buildRunnerMessage(outcome, errand.amount, penaltyAmount),
    type: 'dispute',
    relatedId: dispute._id,
    relatedModel: 'Dispute',
    eventName: 'dispute-resolved',
    eventData: {
      disputeId: dispute._id,
      outcome,
      penaltyAmount: outcome === 'runner_at_fault' ? errand.amount : (outcome === 'partial' ? penaltyAmount : 0),
    },
  });

  res.status(200).json({
    status: 'success',
    message: 'Dispute resolved.',
    data: { dispute: populated },
  });
};

// ─── PATCH /api/disputes/:id/reject ──────────────────────────────────────────
// Admin rejects a frivolous/invalid dispute.
exports.rejectDispute = async (req, res) => {
  const { notes } = req.body;

  const dispute = await Dispute.findById(req.params.id).populate('errand');
  if (!dispute) return res.status(404).json({ status: 'fail', message: 'Dispute not found' });

  if (!['pending', 'under_review'].includes(dispute.status)) {
    return res.status(400).json({
      status: 'fail',
      message: `Dispute is already '${dispute.status}'`,
    });
  }

  const errand = dispute.errand;

  // Restore runner's locked funds and revert errand to in_progress
  if (dispute.fundsLockedAtDispute) {
    await completeErrandWallet(dispute.runner, errand);
  }

  if (errand.status === 'disputed') {
    errand.status = 'in_progress';
    await errand.save();
  }

  dispute.status = 'rejected';
  dispute.resolution = {
    outcome: 'no_action',
    notes: notes?.trim() || 'Dispute rejected by admin.',
    resolvedBy: req.user._id,
    resolvedAt: new Date(),
  };
  await dispute.save();

  const populated = await populateDispute(Dispute.findById(dispute._id));

  getSocket().emitDisputeResolved(dispute.customer, dispute.runner, {
    disputeId: dispute._id,
    errandId:  errand._id,
    outcome: 'rejected',
    notes: notes || null,
  });

  notify.send({
    userId: dispute.raisedBy,
    title: 'Dispute Rejected',
    message: `Your dispute on "${errand.title}" was reviewed and rejected. The errand continues.`,
    type: 'dispute',
    relatedId: dispute._id,
    relatedModel: 'Dispute',
    eventName: 'dispute-rejected',
    eventData: { disputeId: dispute._id, errandId: errand._id, notes: notes || null },
  });

  res.status(200).json({
    status: 'success',
    message: 'Dispute rejected. Errand restored.',
    data: { dispute: populated },
  });
};

// ─── GET /api/disputes ────────────────────────────────────────────────────────
exports.getDisputes = async (req, res) => {
  let filter = {};

  if (req.user.role === 'customer') {
    filter = { customer: req.user._id };
  } else if (req.user.role === 'runner') {
    filter = { runner: req.user._id };
  }

  const { status } = req.query;
  if (status) filter.status = status;

  const disputes = await populateDispute(
    Dispute.find(filter).sort('-createdAt')
  );

  res.status(200).json({
    status: 'success',
    results: disputes.length,
    data: { disputes },
  });
};

// ─── GET /api/disputes/:id ────────────────────────────────────────────────────
exports.getDispute = async (req, res) => {
  const dispute = await populateDispute(Dispute.findById(req.params.id));
  if (!dispute) return res.status(404).json({ status: 'fail', message: 'Dispute not found' });

  const userId = req.user._id.toString();
  const isAdmin = req.user.role === 'admin';
  const isParty =
    dispute.customer?._id?.toString() === userId ||
    dispute.runner?._id?.toString() === userId;

  if (!isAdmin && !isParty) {
    return res.status(403).json({ status: 'fail', message: 'Access denied' });
  }

  res.status(200).json({ status: 'success', data: { dispute } });
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const buildCustomerMessage = (outcome, refundAmount) => {
  switch (outcome) {
    case 'runner_at_fault':
      return `Dispute resolved in your favour. KES ${refundAmount} has been credited to your wallet.`;
    case 'customer_at_fault':
      return 'Dispute resolved. The runner was found to have fulfilled their duties correctly.';
    case 'no_action':
      return 'Dispute reviewed. No action was taken.';
    case 'partial':
      return refundAmount > 0
        ? `Dispute partially resolved. KES ${refundAmount} credited to your wallet.`
        : 'Dispute partially resolved. No refund was issued.';
    default:
      return 'Your dispute has been resolved.';
  }
};

const buildRunnerMessage = (outcome, errandAmount, penaltyAmount) => {
  switch (outcome) {
    case 'runner_at_fault':
      return `Dispute resolved against you. KES ${errandAmount} has been deducted from your wallet.`;
    case 'customer_at_fault':
      return 'Dispute resolved in your favour. Your earnings have been credited normally.';
    case 'no_action':
      return 'Dispute dismissed. Your earnings have been released.';
    case 'partial':
      return `Dispute partially resolved. KES ${penaltyAmount ?? 0} was deducted from your wallet.`;
    default:
      return 'Your dispute has been resolved.';
  }
};
