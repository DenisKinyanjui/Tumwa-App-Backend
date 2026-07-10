const mongoose = require('mongoose');
const multer = require('multer');
const Errand = require('../models/Errand');
const User = require('../models/User');
const RunnerVerification = require('../models/RunnerVerification');
const r2Service = require('../services/r2Service');
const {
  calcFees,
  hasEnoughFloat,
  acceptErrandWallet,
  completeErrandWallet,
  cancelErrandWallet,
  penalizeErrandWallet,
} = require('../utils/walletUtils');
const { haversineKm } = require('../utils/distanceCalculator');
const {
  runMatchingCycle,
  validateAcceptance,
  onRunnerAccepted,
  handleRunnerCancellation,
  clearOfferTimeout,
} = require('../services/matchingService');
const { emitToNearbyRunners, emitErrandUpdate, emitWalletUpdate } = require('../socket/socketManager');
const notify = require('../services/notifyService');

const populateErrand = (query) =>
  query
    .populate('customer', 'name phone')
    .populate('runner', 'name phone rating wallet');

// Attaches each runner's verification selfie as a short-lived signed URL
// (runner.photoUrl) so the customer app can show it as a profile picture.
// Only called for customer-facing responses — the selfie is otherwise a
// private KYC document used solely for admin verification review.
const attachRunnerPhotos = async (errands) => {
  const runnerIds = [...new Set(
    errands.filter((e) => e.runner).map((e) => e.runner._id.toString())
  )];
  if (runnerIds.length === 0) return errands;

  const verifications = await RunnerVerification.find({ user: { $in: runnerIds } })
    .select('user selfieKey')
    .lean();

  const photoUrlByRunner = new Map();
  await Promise.all(verifications.map(async (v) => {
    if (!v.selfieKey) return;
    const url = await r2Service.getSignedDownloadUrl(v.selfieKey, 3600);
    photoUrlByRunner.set(v.user.toString(), url);
  }));

  errands.forEach((e) => {
    if (e.runner) e.runner.photoUrl = photoUrlByRunner.get(e.runner._id.toString()) || null;
  });
  return errands;
};

// Attaches a short-lived signed URL for the runner's proof-of-completion
// photo (if one was uploaded) so the customer/runner apps can display it.
const attachProofPhotoUrl = async (errand) => {
  if (errand.proofPhotoKey) {
    errand.proofPhotoUrl = await r2Service.getSignedDownloadUrl(errand.proofPhotoKey, 3600);
  }
  return errand;
};

// Single optional image upload for PATCH /errands/:id/complete
const proofPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
});
exports.uploadProofPhoto = proofPhotoUpload.single('proofPhoto');

// ─── Customer ────────────────────────────────────────────────────────────────

// POST /api/errands
exports.createErrand = async (req, res) => {
  const { title, description, location, amount } = req.body;

  if (!title || !description || !location?.address || !amount) {
    return res.status(400).json({
      status: 'fail',
      message: 'title, description, location.address, and amount are required',
    });
  }

  const fees = calcFees(Number(amount));

  const errand = await Errand.create({
    customer: req.user._id,
    title,
    description,
    location,
    amount: Number(amount),
    ...fees,
  });

  setImmediate(() => runMatchingCycle(errand._id.toString()));

  res.status(201).json({ status: 'success', data: { errand, fees } });
};

// PATCH /api/errands/:id/cancel
exports.cancelErrand = async (req, res) => {
  const errand = await Errand.findById(req.params.id);
  if (!errand) return res.status(404).json({ status: 'fail', message: 'Errand not found' });

  const isOwner = errand.customer.toString() === req.user._id.toString();
  const isAdmin = req.user.role === 'admin';

  if (!isOwner && !isAdmin) {
    return res.status(403).json({ status: 'fail', message: 'Access denied' });
  }

  const cancellableByCustomer = ['pending', 'marketplace', 'assigned'];
  const cancellableByAdmin    = ['pending', 'marketplace', 'assigned', 'in_progress'];
  const allowed = isAdmin ? cancellableByAdmin : cancellableByCustomer;

  if (!allowed.includes(errand.status)) {
    return res.status(400).json({
      status: 'fail',
      message: `Cannot cancel an errand with status '${errand.status}'`,
    });
  }

  // Reverse wallet operations if runner was assigned
  if (errand.runner && !errand.floatReleased) {
    await cancelErrandWallet(errand.runner, errand);
  }

  errand.status      = 'cancelled';
  errand.cancelledAt = new Date();
  await errand.save();

  if (errand.runner) {
    notify.send({
      userId:       errand.runner,
      title:        'Errand Cancelled',
      message:      `"${errand.title}" was cancelled. Float restored.`,
      type:         'errand',
      relatedId:    errand._id,
      relatedModel: 'Errand',
      eventName:    'errand-cancelled',
      eventData:    { errandId: errand._id, title: errand.title },
    });
  }

  res.status(200).json({ status: 'success', message: 'Errand cancelled', data: { errand } });
};

// PATCH /api/errands/:id/dispute
exports.disputeErrand = async (req, res) => {
  const errand = await Errand.findById(req.params.id);
  if (!errand) return res.status(404).json({ status: 'fail', message: 'Errand not found' });

  const isOwner = errand.customer.toString() === req.user._id.toString();
  const isAdmin = req.user.role === 'admin';

  if (!isOwner && !isAdmin) {
    return res.status(403).json({ status: 'fail', message: 'Access denied' });
  }

  if (errand.status !== 'in_progress') {
    return res.status(400).json({
      status: 'fail',
      message: `Disputes can only be raised on in_progress errands (current: '${errand.status}')`,
    });
  }

  const { reason } = req.body;
  if (!reason) {
    return res.status(400).json({ status: 'fail', message: 'A dispute reason is required' });
  }

  errand.status        = 'disputed';
  errand.disputedAt    = new Date();
  errand.disputeReason = reason;
  await errand.save();

  notify.sendToRole({
    role:         'admin',
    title:        'Dispute Raised',
    message:      `Dispute on "${errand.title}" by ${req.user.name}.`,
    type:         'dispute',
    relatedId:    errand._id,
    relatedModel: 'Errand',
    eventName:    'errand-disputed',
    eventData:    { errandId: errand._id, title: errand.title, reason },
  });

  res.status(200).json({
    status:  'success',
    message: 'Dispute raised. Admin will review.',
    data:    { errand },
  });
};

// ─── Runner ──────────────────────────────────────────────────────────────────

// PATCH /api/errands/:id/assign  (runner accepts errand)
exports.assignRunner = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const errand = await Errand.findById(req.params.id).session(session);
    if (!errand) {
      await session.abortTransaction();
      return res.status(404).json({ status: 'fail', message: 'Errand not found' });
    }

    if (!['pending', 'marketplace'].includes(errand.status)) {
      await session.abortTransaction();
      return res.status(400).json({
        status: 'fail',
        message: `Cannot accept an errand with status '${errand.status}'`,
      });
    }

    if (errand.customer.toString() === req.user._id.toString()) {
      await session.abortTransaction();
      return res.status(400).json({ status: 'fail', message: 'You cannot run your own errand' });
    }

    const runner = await User.findById(req.user._id).session(session);

    if (runner.verificationStatus !== 'approved') {
      await session.abortTransaction();
      return res.status(403).json({
        status: 'fail',
        message: 'Your account must pass verification before you can accept errands',
      });
    }

    // Float check: zero float is allowed (own-money mode)
    const availableFloat = runner.wallet.floatBalance - runner.wallet.heldFloat;
    if (availableFloat < 0) {
      await session.abortTransaction();
      return res.status(400).json({ status: 'fail', message: 'Wallet in invalid state' });
    }

    // Update wallet atomically (inside session so it rolls back if errand.save fails)
    const { floatUsed, ownMoneyUsed } = await acceptErrandWallet(runner._id, errand, session);

    errand.runner       = runner._id;
    errand.status       = 'assigned';
    errand.assignedAt   = new Date();
    errand.floatUsed    = floatUsed;
    errand.ownMoneyUsed = ownMoneyUsed;
    await errand.save({ session });

    await session.commitTransaction();

    const populated = await populateErrand(Errand.findById(errand._id));

    emitErrandUpdate(populated.toObject(), errand.customer, runner._id);

    notify.send({
      userId:       errand.customer,
      title:        'Runner Assigned',
      message:      `${runner.name} accepted "${errand.title}".`,
      type:         'errand',
      relatedId:    errand._id,
      relatedModel: 'Errand',
      eventName:    'errand-assigned',
      eventData:    { errandId: errand._id, runner: { id: runner._id, name: runner.name } },
    });

    const floatMessage = ownMoneyUsed
      ? `You accepted "${errand.title}". Using own money (no float held).`
      : `You accepted "${errand.title}". KES ${errand.amount} float locked. Customer funds (KES ${errand.trustHeld}) in escrow.`;

    notify.send({
      userId:       runner._id,
      title:        'Errand Accepted',
      message:      floatMessage,
      type:         'errand',
      relatedId:    errand._id,
      relatedModel: 'Errand',
      eventName:    'errand-assigned',
      eventData:    { errandId: errand._id, floatUsed, ownMoneyUsed, trustHeld: errand.trustHeld },
    });

    res.status(200).json({
      status:  'success',
      message: floatMessage,
      data:    { errand: populated },
    });
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

// ─── Matching-flow endpoints ──────────────────────────────────────────────────

// PATCH /api/errands/:id/accept
// Runner accepts an offer sent by the matching system.
// Only the runner currently holding the active offer may accept.
exports.acceptErrand = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const errand = await Errand.findById(req.params.id).session(session);
    if (!errand) {
      await session.abortTransaction();
      return res.status(404).json({ status: 'fail', message: 'Errand not found' });
    }

    if (errand.customer.toString() === req.user._id.toString()) {
      await session.abortTransaction();
      return res.status(400).json({ status: 'fail', message: 'You cannot run your own errand' });
    }

    // Validate offer ownership and expiry (throws with .httpStatus on failure)
    try {
      validateAcceptance(errand, req.user._id.toString());
    } catch (err) {
      await session.abortTransaction();
      return res.status(err.httpStatus || 403).json({ status: 'fail', message: err.message });
    }

    const runner = await User.findById(req.user._id).session(session);

    if (runner.verificationStatus !== 'approved') {
      await session.abortTransaction();
      return res.status(403).json({
        status: 'fail',
        message: 'Your account must pass verification before you can accept errands',
      });
    }

    // Cooldown check — extra guard (matching service also checks, but belt-and-suspenders)
    if (runner.cooldownUntil && runner.cooldownUntil > new Date()) {
      await session.abortTransaction();
      const waitSec = Math.ceil((runner.cooldownUntil - Date.now()) / 1000);
      return res.status(429).json({
        status:  'fail',
        message: `You are in cooldown. Try again in ${waitSec}s.`,
        cooldownUntil: runner.cooldownUntil,
      });
    }

    const availableFloat = runner.wallet.floatBalance - runner.wallet.heldFloat;
    if (availableFloat < errand.amount) {
      await session.abortTransaction();
      return res.status(400).json({
        status:  'fail',
        message: `Insufficient float. Available: KES ${availableFloat.toFixed(2)}, required: KES ${errand.amount}`,
      });
    }

    const { floatUsed, ownMoneyUsed } = await acceptErrandWallet(runner._id, errand, session);

    errand.runner       = runner._id;
    errand.status       = 'assigned';
    errand.assignedAt   = new Date();
    errand.floatUsed    = floatUsed;
    errand.ownMoneyUsed = ownMoneyUsed;
    // Clear matching state — assignment complete
    errand.matchingState.status                  = 'idle';
    errand.matchingState.currentOffer.runnerId   = null;
    errand.matchingState.currentOffer.offeredAt  = null;
    errand.matchingState.currentOffer.expiresAt  = null;
    await errand.save({ session });

    // availability.status was already updated by acceptErrandWallet — 'busy'
    // only if this errand exhausted the runner's remaining float.

    await session.commitTransaction();

    // Clear in-memory timeout and notify affected runners
    onRunnerAccepted(errand._id.toString(), runner._id.toString());

    const populated = await populateErrand(Errand.findById(errand._id));

    emitErrandUpdate(populated.toObject(), errand.customer, runner._id);

    notify.send({
      userId:       errand.customer,
      title:        'Runner On The Way!',
      message:      `${runner.name} accepted "${errand.title}" and is heading to you.`,
      type:         'errand',
      relatedId:    errand._id,
      relatedModel: 'Errand',
      eventName:    'errand-accepted',
      eventData:    { errandId: errand._id, runner: { id: runner._id, name: runner.name } },
    });

    const floatMsg = ownMoneyUsed
      ? `You accepted "${errand.title}" (own-money mode — no float held).`
      : `You accepted "${errand.title}". KES ${errand.amount} float locked.`;

    notify.send({
      userId:       runner._id,
      title:        'Errand Accepted',
      message:      floatMsg,
      type:         'errand',
      relatedId:    errand._id,
      relatedModel: 'Errand',
      eventName:    'errand-accepted-runner',
      eventData:    { errandId: errand._id, floatUsed, ownMoneyUsed },
    });

    return res.status(200).json({
      status:  'success',
      message: floatMsg,
      data:    { errand: populated },
    });
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

// PATCH /api/errands/:id/decline
// Runner explicitly declines an offer, freeing the slot for the next candidate.
exports.declineErrand = async (req, res) => {
  const errand = await Errand.findById(req.params.id);
  if (!errand) return res.status(404).json({ status: 'fail', message: 'Errand not found' });

  const offer = errand.matchingState?.currentOffer;
  if (!offer?.runnerId || offer.runnerId.toString() !== req.user._id.toString()) {
    return res.status(403).json({
      status:  'fail',
      message: 'You have no active offer on this errand',
    });
  }

  // Clear in-memory timeout so handleOfferTimeout doesn't fire
  clearOfferTimeout(errand._id.toString());

  // Reset runner status
  await User.findByIdAndUpdate(req.user._id, {
    'availability.status': 'available',
  });

  // Clear offer, stay in searching mode
  await Errand.findByIdAndUpdate(errand._id, {
    'matchingState.status':             'searching',
    'matchingState.currentOffer.runnerId':  null,
    'matchingState.currentOffer.offeredAt': null,
    'matchingState.currentOffer.expiresAt': null,
  });

  // Continue matching immediately
  setImmediate(() => runMatchingCycle(errand._id.toString()));

  return res.status(200).json({ status: 'success', message: 'Offer declined' });
};

// PATCH /api/errands/:id/runner-cancel
// Runner cancels an errand they already accepted (status: assigned).
// Reverses wallet, applies cooldown penalty, and re-triggers matching.
exports.runnerCancelErrand = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const errand = await Errand.findById(req.params.id).session(session);
    if (!errand) {
      await session.abortTransaction();
      return res.status(404).json({ status: 'fail', message: 'Errand not found' });
    }

    if (!errand.runner || errand.runner.toString() !== req.user._id.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ status: 'fail', message: 'You are not assigned to this errand' });
    }

    if (errand.status !== 'assigned') {
      await session.abortTransaction();
      return res.status(400).json({
        status:  'fail',
        message: `Cannot cancel an errand with status '${errand.status}'. Only assigned errands may be cancelled by runners.`,
      });
    }

    // Reverse wallet — must happen before we clear runner from errand
    if (!errand.floatReleased) {
      await cancelErrandWallet(errand.runner, errand, session);
    }

    // Reset errand to pending so it can be re-matched
    errand.status       = 'pending';
    errand.runner       = null;
    errand.assignedAt   = null;
    errand.floatUsed    = false;
    errand.ownMoneyUsed = false;
    errand.cancelledBy  = 'runner'; // audit trail
    await errand.save({ session });

    await session.commitTransaction();

    // Apply penalties + notify customer + restart matching (all outside the transaction)
    setImmediate(() => handleRunnerCancellation(errand, req.user._id.toString()));

    return res.status(200).json({
      status:  'success',
      message: "Errand returned to pool. We'll find another runner for the customer.",
    });
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

// POST /api/errands/:id/retry-match
// Customer requests a fresh matching cycle after errand:no_runner.
// Resets the offeredTo list so previously tried runners can be re-offered.
exports.retryMatch = async (req, res) => {
  const errand = await Errand.findById(req.params.id);
  if (!errand) return res.status(404).json({ status: 'fail', message: 'Errand not found' });

  if (errand.customer.toString() !== req.user._id.toString()) {
    return res.status(403).json({ status: 'fail', message: 'Access denied' });
  }

  const canRetry =
    ['pending', 'marketplace'].includes(errand.status) &&
    ['no_runner', 'searching', 'idle'].includes(errand.matchingState?.status);

  if (!canRetry) {
    return res.status(400).json({
      status:  'fail',
      message: `Cannot retry matching for an errand with status '${errand.status}' / matching '${errand.matchingState?.status}'`,
    });
  }

  // Full reset: wipe tried-runners list so we get a fresh pool
  // Also reset status from 'marketplace' back to 'pending' so matching runs again
  await Errand.findByIdAndUpdate(errand._id, {
    status:                           'pending',
    'matchingState.status':           'searching',
    'matchingState.offeredTo':        [],
    'matchingState.attempts':         0,
    'matchingState.currentOffer.runnerId':  null,
    'matchingState.currentOffer.offeredAt': null,
    'matchingState.currentOffer.expiresAt': null,
  });

  setImmediate(() => runMatchingCycle(errand._id.toString()));

  return res.status(200).json({
    status:  'success',
    message: 'Re-matching started. You will be notified when a runner accepts.',
  });
};

// PATCH /api/errands/:id/start
exports.startErrand = async (req, res) => {
  const errand = await Errand.findById(req.params.id);
  if (!errand) return res.status(404).json({ status: 'fail', message: 'Errand not found' });

  if (errand.status !== 'assigned') {
    return res.status(400).json({
      status: 'fail',
      message: `Cannot start an errand with status '${errand.status}'`,
    });
  }

  if (errand.runner.toString() !== req.user._id.toString()) {
    return res.status(403).json({ status: 'fail', message: 'Only the assigned runner can start this errand' });
  }

  errand.status    = 'in_progress';
  errand.startedAt = new Date();
  await errand.save();

  // Runner stays 'busy' — already set on accept. No status change needed here.

  const populated = await populateErrand(Errand.findById(errand._id));

  emitErrandUpdate(populated.toObject(), errand.customer, errand.runner);

  notify.send({
    userId:       errand.customer,
    title:        'Errand In Progress',
    message:      `Your runner started "${errand.title}".`,
    type:         'errand',
    relatedId:    errand._id,
    relatedModel: 'Errand',
    eventName:    'errand-in-progress',
    eventData:    { errandId: errand._id, startedAt: errand.startedAt },
  });

  res.status(200).json({ status: 'success', message: 'Errand started', data: { errand: populated } });
};

// PATCH /api/errands/:id/complete  (runner marks complete, awaits customer confirm)
exports.completeErrand = async (req, res) => {
  const errand = await Errand.findById(req.params.id);
  if (!errand) return res.status(404).json({ status: 'fail', message: 'Errand not found' });

  if (errand.status !== 'in_progress') {
    return res.status(400).json({
      status: 'fail',
      message: `Cannot complete an errand with status '${errand.status}'`,
    });
  }

  if (errand.runner.toString() !== req.user._id.toString()) {
    return res.status(403).json({ status: 'fail', message: 'Only the assigned runner can complete this errand' });
  }

  const { proofOfCompletion } = req.body;
  if (!proofOfCompletion) {
    return res.status(400).json({ status: 'fail', message: 'proofOfCompletion is required' });
  }

  if (req.file) {
    const key = await r2Service.uploadFile(
      req.file.buffer,
      `errand-proof/${errand._id}`,
      'proof',
      req.file.mimetype,
    );
    errand.proofPhotoKey = key;
  }

  errand.status            = 'completed';
  errand.proofOfCompletion = proofOfCompletion;
  errand.completedAt       = new Date();
  await errand.save();

  const populated = await attachProofPhotoUrl(
    (await populateErrand(Errand.findById(errand._id))).toObject(),
  );

  emitErrandUpdate(populated, errand.customer, errand.runner);

  notify.send({
    userId:       errand.customer,
    title:        'Errand Completed — Please Confirm',
    message:      `"${errand.title}" is done. Please confirm delivery to release payment to the runner.`,
    type:         'errand',
    relatedId:    errand._id,
    relatedModel: 'Errand',
    eventName:    'errand-completed',
    eventData:    { errandId: errand._id, proofOfCompletion },
  });

  res.status(200).json({
    status:  'success',
    message: 'Errand marked as complete. Awaiting customer confirmation.',
    data:    { errand: populated },
  });
};

// PATCH /api/errands/:id/confirm  (customer confirms delivery → releases payment)
exports.confirmDelivery = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const errand = await Errand.findById(req.params.id).session(session);
    if (!errand) {
      await session.abortTransaction();
      return res.status(404).json({ status: 'fail', message: 'Errand not found' });
    }

    if (errand.status !== 'completed') {
      await session.abortTransaction();
      return res.status(400).json({
        status: 'fail',
        message: `Can only confirm a completed errand (current: '${errand.status}')`,
      });
    }

    if (errand.customer.toString() !== req.user._id.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ status: 'fail', message: 'Only the customer can confirm delivery' });
    }

    if (errand.floatReleased) {
      await session.abortTransaction();
      return res.status(400).json({ status: 'fail', message: 'Payment already released' });
    }

    // Release escrow and credit runner earnings atomically
    await completeErrandWallet(errand.runner, errand, session);

    await User.findByIdAndUpdate(errand.runner, { $inc: { completedErrands: 1 } }).session(session);

    errand.status        = 'confirmed';
    errand.confirmedAt   = new Date();
    errand.floatReleased = true;
    errand.isPaid        = true;
    errand.paidAt        = new Date();
    await errand.save({ session });

    // Runner is free to accept new errands
    await User.findByIdAndUpdate(errand.runner, {
      'availability.status': 'available',
    }, { session });

    await session.commitTransaction();

    emitErrandUpdate(errand.toObject(), errand.customer, errand.runner);
    emitWalletUpdate(errand.runner, 'earnings_released');

    notify.send({
      userId:       errand.runner,
      title:        'Payment Released! 🎉',
      message:      `"${errand.title}" confirmed. KES ${errand.runnerReceives} added to your earnings.`,
      type:         'errand',
      relatedId:    errand._id,
      relatedModel: 'Errand',
      eventName:    'errand-confirmed',
      eventData:    { errandId: errand._id, runnerReceives: errand.runnerReceives },
    });

    res.status(200).json({
      status:  'success',
      message: `Delivery confirmed. KES ${errand.runnerReceives} released to runner.`,
      data:    { errand },
    });
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

// ─── Admin ───────────────────────────────────────────────────────────────────

exports.adminAssignRunner = async (req, res) => {
  const { runnerId } = req.body;
  if (!runnerId) {
    return res.status(400).json({ status: 'fail', message: 'runnerId is required' });
  }

  const errand = await Errand.findById(req.params.id);
  if (!errand) return res.status(404).json({ status: 'fail', message: 'Errand not found' });

  if (!['pending', 'marketplace', 'assigned'].includes(errand.status)) {
    return res.status(400).json({
      status: 'fail',
      message: `Cannot reassign an errand with status '${errand.status}'`,
    });
  }

  const runner = await User.findById(runnerId);
  if (!runner) return res.status(404).json({ status: 'fail', message: 'Runner not found' });
  if (runner.role !== 'runner') {
    return res.status(400).json({ status: 'fail', message: 'Target user is not a runner' });
  }

  // Reverse previous runner's wallet if reassigning
  const isReassignment = errand.runner && errand.runner.toString() !== runnerId;
  if (isReassignment && !errand.floatReleased) {
    const previousRunnerId = errand.runner;

    await cancelErrandWallet(previousRunnerId, errand);
    // Previous runner is no longer tied to this errand — free them up
    await User.findByIdAndUpdate(previousRunnerId, {
      'availability.status': 'available',
    });

    notify.send({
      userId:       previousRunnerId,
      title:        'Errand Reassigned',
      message:      `You were unassigned from "${errand.title}" by an admin.`,
      type:         'errand',
      relatedId:    errand._id,
      relatedModel: 'Errand',
      eventName:    'errand-unassigned',
      eventData:    { errandId: errand._id },
    });
  }

  const { floatUsed, ownMoneyUsed } = await acceptErrandWallet(runner._id, errand);

  errand.runner       = runner._id;
  errand.status       = 'assigned';
  errand.assignedAt   = new Date();
  errand.floatUsed    = floatUsed;
  errand.ownMoneyUsed = ownMoneyUsed;
  await errand.save();

  // availability.status was already updated by acceptErrandWallet — 'busy'
  // only if this errand exhausted the runner's remaining float.

  const populated = await populateErrand(Errand.findById(errand._id));

  emitErrandUpdate(populated.toObject(), errand.customer, runner._id);

  notify.send({
    userId:       errand.customer,
    title:        'Runner Assigned',
    message:      `${runner.name} has been assigned to "${errand.title}".`,
    type:         'errand',
    relatedId:    errand._id,
    relatedModel: 'Errand',
    eventName:    'errand-assigned',
    eventData:    { errandId: errand._id, runner: { id: runner._id, name: runner.name } },
  });

  const floatMessage = ownMoneyUsed
    ? `An admin assigned you to "${errand.title}" (own-money mode — no float held).`
    : `An admin assigned you to "${errand.title}". KES ${errand.amount} float locked.`;

  notify.send({
    userId:       runner._id,
    title:        'Errand Assigned',
    message:      floatMessage,
    type:         'errand',
    relatedId:    errand._id,
    relatedModel: 'Errand',
    eventName:    'errand-assigned',
    eventData:    { errandId: errand._id, floatUsed, ownMoneyUsed, trustHeld: errand.trustHeld },
  });

  res.status(200).json({
    status:  'success',
    message: `Runner assigned by admin.`,
    data:    { errand: populated },
  });
};

// ─── Shared ───────────────────────────────────────────────────────────────────

exports.getErrands = async (req, res) => {
  if (req.user.role === 'runner') {
    // For runners: return all pending errands sorted by proximity (if location known)
    const runner = await User.findById(req.user._id).lean();
    const rLat   = runner.availability?.latitude;
    const rLng   = runner.availability?.longitude;

    const errands = await populateErrand(
      Errand.find({ status: 'marketplace' }).sort('-createdAt'),
    );

    const withDistance = errands.map((e) => {
      const obj  = e.toObject();
      const eLat = e.location?.coordinates?.lat;
      const eLng = e.location?.coordinates?.lng;
      if (rLat && rLng && eLat && eLng) {
        obj.distanceKm = Math.round(
          haversineKm({ lat: rLat, lng: rLng }, { lat: eLat, lng: eLng }) * 10,
        ) / 10;
      } else {
        obj.distanceKm = null;
      }
      return obj;
    });

    // Sort: errands with known distance first (closest first), unknown last
    withDistance.sort((a, b) => {
      if (a.distanceKm === null && b.distanceKm === null) return 0;
      if (a.distanceKm === null) return 1;
      if (b.distanceKm === null) return -1;
      return a.distanceKm - b.distanceKm;
    });

    return res.status(200).json({
      status: 'success',
      results: withDistance.length,
      data: { errands: withDistance },
    });
  }

  let filter = {};
  if (req.user.role === 'customer') {
    filter = { customer: req.user._id };
  }

  const errandDocs = await populateErrand(
    Errand.find(filter).sort('-createdAt'),
  );

  let errands = errandDocs;
  if (req.user.role === 'customer') {
    errands = await attachRunnerPhotos(errandDocs.map((e) => e.toObject()));
  }

  res.status(200).json({ status: 'success', results: errands.length, data: { errands } });
};

exports.getRunnerErrands = async (req, res) => {
  const errands = await populateErrand(
    Errand.find({ runner: req.user._id }).sort('-updatedAt')
  );

  res.status(200).json({ status: 'success', results: errands.length, data: { errands } });
};

exports.getErrand = async (req, res) => {
  const errandDoc = await populateErrand(Errand.findById(req.params.id));

  if (!errandDoc) return res.status(404).json({ status: 'fail', message: 'Errand not found' });

  if (
    req.user.role === 'customer' &&
    errandDoc.customer._id.toString() !== req.user._id.toString()
  ) {
    return res.status(403).json({ status: 'fail', message: 'Access denied' });
  }

  const errand = await attachProofPhotoUrl(errandDoc.toObject());

  res.status(200).json({ status: 'success', data: { errand } });
};
