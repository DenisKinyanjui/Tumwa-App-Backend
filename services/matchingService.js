/**
 * matchingService — real-time runner matching engine.
 *
 * Flow (happy path):
 *   runMatchingCycle(errandId)
 *     → fetchEligibleRunners(errand)   — DB query: available, enough float, in radius
 *     → rankCandidates(runners)        — sort: distance → rating → cancelCount
 *     → offerToRunner(errand, runner)  — emit errand:request + 15s timeout
 *       ↓ runner accepts (REST /accept)
 *     → validateAcceptance(errand, runnerId) — called by controller
 *       ↓ timeout fires
 *     → handleOfferTimeout(errandId, runnerId) — move to next runner
 *       ↓ all candidates exhausted
 *     → handleNoRunner(errand)         — emit errand:no_runner to customer
 *
 * Cancellation re-trigger:
 *   handleRunnerCancellation(errand, runnerId)
 *     → penalise runner (cooldown, optional ranking penalty)
 *     → reset errand to pending
 *     → runMatchingCycle(errandId)     — immediate re-match
 */

const User    = require('../models/User');
const Errand  = require('../models/Errand');
const { haversineKm } = require('../utils/distanceCalculator');
const notify  = require('./notifyService');
const baseLogger = require('../utils/logger');

const logger = baseLogger.child({ service: 'matching' });

// ── Configuration (all overridable via env vars) ──────────────────────────────

const MATCH_RADIUS_KM        = parseFloat(process.env.MATCH_RADIUS_KM)           || 5;
const OFFER_TIMEOUT_MS       = parseInt(process.env.OFFER_TIMEOUT_MS,       10)  || 15_000;
const MAX_OFFERS_PER_CYCLE   = parseInt(process.env.MAX_OFFERS_PER_CYCLE,   10)  || 5;
const MAX_TOTAL_ATTEMPTS     = parseInt(process.env.MAX_TOTAL_ATTEMPTS,     10)  || 15;
const CANCEL_THRESHOLD       = parseInt(process.env.RUNNER_CANCEL_THRESHOLD, 10) || 3;
const CANCEL_COOLDOWN_MS     = parseInt(process.env.RUNNER_CANCEL_COOLDOWN_MS, 10) || 5 * 60_000;   // 5 min
const MATCHING_PENALTY_MS    = parseInt(process.env.RUNNER_MATCHING_PENALTY_MS, 10) || 24 * 3600_000; // 24 h

// ── In-memory timeout store ───────────────────────────────────────────────────
// Map<errandId:string, NodeJS.Timeout>
const activeTimeouts = new Map();

// Lazy-loaded to break the circular dep chain: socketManager ← errandController ← matchingService ← socketManager
let _socket;
const getSocket = () => {
  if (!_socket) _socket = require('../socket/socketManager');
  return _socket;
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Main entry point.
 * Call this after a paid errand is created, or after a runner cancels.
 */
const runMatchingCycle = async (errandId) => {
  clearOfferTimeout(errandId);

  let errand;
  try {
    errand = await Errand.findById(errandId);
  } catch (err) {
    logger.error('runMatchingCycle: DB lookup failed', { errandId, error: err.message });
    return;
  }

  if (!errand) {
    logger.error('runMatchingCycle: errand not found', { errandId });
    return;
  }

  if (errand.status !== 'pending') {
    logger.info('runMatchingCycle: skipped — errand not pending', {
      errandId, status: errand.status,
    });
    return;
  }

  if (errand.matchingState.attempts >= MAX_TOTAL_ATTEMPTS) {
    logger.warn('runMatchingCycle: max attempts reached', {
      errandId, attempts: errand.matchingState.attempts,
    });
    await handleNoRunner(errand);
    return;
  }

  // Tell the customer we are searching
  getSocket().emitToUser(errand.customer.toString(), 'errand:searching', {
    errandId: errand._id,
    message:  'Finding a runner near you…',
  });

  const candidates = await fetchEligibleRunners(errand);

  if (!candidates.length) {
    logger.warn('runMatchingCycle: no eligible runners', { errandId });
    await handleNoRunner(errand);
    return;
  }

  await offerToRunner(errand, candidates[0]);
};

/**
 * Validate that the given runner is allowed to accept this errand.
 * Throws a structured error (with .httpStatus) on failure.
 * Called inside the controller transaction — does NOT write to DB.
 */
const validateAcceptance = (errand, runnerId) => {
  if (errand.status !== 'pending') {
    const err = new Error(`Errand is no longer pending (status: ${errand.status})`);
    err.httpStatus = 409;
    throw err;
  }

  const offer = errand.matchingState?.currentOffer;
  if (!offer?.runnerId || offer.runnerId.toString() !== runnerId.toString()) {
    const err = new Error('You were not offered this errand or the offer has expired');
    err.httpStatus = 403;
    throw err;
  }

  if (offer.expiresAt && new Date(offer.expiresAt) < new Date()) {
    const err = new Error('The offer has expired — please wait for the next cycle');
    err.httpStatus = 410;
    throw err;
  }
};

/**
 * Called after the controller has committed the runner's acceptance.
 * Clears the timeout and notifies any other runners the errand is gone.
 */
const onRunnerAccepted = (errandId, runnerId) => {
  clearOfferTimeout(errandId);
  // No other runners have live offers (sequential model), but emit a
  // safeguard 'errand:expired' to the room in case of stale UI state.
  getSocket().emitToRoom(`errand:${errandId}`, 'errand:expired', {
    errandId,
    reason:  'accepted',
    message: 'This errand was accepted by another runner.',
  });
};

/**
 * Apply cancellation penalties and restart matching.
 * Called AFTER the controller has already:
 *   - reversed the wallet (cancelErrandWallet)
 *   - set errand.status = 'pending', errand.runner = null (committed in a session)
 */
const handleRunnerCancellation = async (errand, runnerId) => {
  // ── Penalise runner ────────────────────────────────────────────────────
  const runner = await User.findByIdAndUpdate(
    runnerId,
    {
      $inc: { cancelCount: 1 },
      'availability.status': 'available',
    },
    { new: true },
  ).lean();

  const penaltyUpdates = {
    cooldownUntil: new Date(Date.now() + CANCEL_COOLDOWN_MS),
  };

  if (runner.cancelCount >= CANCEL_THRESHOLD) {
    penaltyUpdates.matchingPenaltyUntil = new Date(Date.now() + MATCHING_PENALTY_MS);
    logger.warn('Matching penalty applied to runner', {
      runnerId,
      cancelCount: runner.cancelCount,
    });
  }

  await User.findByIdAndUpdate(runnerId, penaltyUpdates);

  // ── Reset matching offer state ─────────────────────────────────────────
  await Errand.findByIdAndUpdate(errand._id, {
    'matchingState.status': 'searching',
    'matchingState.currentOffer.runnerId':  null,
    'matchingState.currentOffer.offeredAt': null,
    'matchingState.currentOffer.expiresAt': null,
  });

  // ── Notify customer ────────────────────────────────────────────────────
  getSocket().emitToUser(errand.customer.toString(), 'errand:cancelled', {
    errandId:    errand._id,
    cancelledBy: 'runner',
    message:     'Runner cancelled. Finding another runner…',
  });

  await notify.send({
    userId:       errand.customer,
    title:        'Runner Cancelled',
    message:      `The runner for "${errand.title}" cancelled. We're finding a new one…`,
    type:         'errand',
    relatedId:    errand._id,
    relatedModel: 'Errand',
    eventName:    'errand-runner-cancelled',
    eventData:    { errandId: errand._id, cancelledBy: 'runner' },
  });

  logger.info('Runner cancellation processed — restarting match', {
    errandId: errand._id, runnerId, cancelCount: runner.cancelCount,
  });

  // ── Re-trigger matching ────────────────────────────────────────────────
  setImmediate(() => runMatchingCycle(errand._id.toString()));
};

/**
 * Clear any active offer timeout for an errand (idempotent).
 */
const clearOfferTimeout = (errandId) => {
  const key = errandId.toString();
  const handle = activeTimeouts.get(key);
  if (handle) {
    clearTimeout(handle);
    activeTimeouts.delete(key);
  }
};

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Query the DB for runners eligible to receive an offer for this errand.
 * Eligibility:
 *   - role === 'runner', isActive, availability.status === 'available'
 *   - cooldownUntil is null or in the past
 *   - (floatBalance − heldFloat) >= errand.amount  (spec requirement)
 *   - has reported a location AND is within MATCH_RADIUS_KM
 *   - not already in matchingState.offeredTo
 *
 * Returns candidates sorted by rankCandidates (distance → rating → cancelCount).
 * Capped at MAX_OFFERS_PER_CYCLE entries.
 */
const fetchEligibleRunners = async (errand) => {
  const { lat: eLat, lng: eLng } = errand.location?.coordinates || {};
  const hasCoords = !!(eLat && eLng);

  if (!hasCoords) {
    logger.warn('fetchEligibleRunners: errand has no coordinates — radius filter disabled', {
      errandId: errand._id,
    });
  }

  const now = new Date();
  const alreadyOffered = new Set(
    (errand.matchingState.offeredTo || []).map((id) => id.toString()),
  );

  // Single DB query — float check via $expr
  const runners = await User.find({
    role:     'runner',
    isActive: true,
    'availability.status': 'available',
    $or: [
      { cooldownUntil: null },
      { cooldownUntil: { $lte: now } },
    ],
    $expr: {
      $gte: [
        { $subtract: ['$wallet.floatBalance', '$wallet.heldFloat'] },
        errand.amount,
      ],
    },
  }).lean();

  const candidates = [];

  for (const runner of runners) {
    // Skip already-offered runners
    if (alreadyOffered.has(runner._id.toString())) continue;

    // Location & radius filter
    const rLat = runner.availability?.latitude;
    const rLng = runner.availability?.longitude;

    if (!rLat || !rLng) {
      // Runner has no stored location — skip (can't verify proximity)
      continue;
    }

    const distKm = hasCoords
      ? haversineKm({ lat: rLat, lng: rLng }, { lat: eLat, lng: eLng })
      : 0;

    if (hasCoords && distKm > MATCH_RADIUS_KM) continue;

    runner._distanceKm = distKm;
    candidates.push(runner);
  }

  candidates.sort(rankCandidates);

  return candidates.slice(0, MAX_OFFERS_PER_CYCLE);
};

/**
 * Sort comparator — lower score = better candidate.
 * Penalised runners are always ranked last.
 */
const rankCandidates = (a, b) => {
  const now = Date.now();
  const aPenalised = a.matchingPenaltyUntil && a.matchingPenaltyUntil > now;
  const bPenalised = b.matchingPenaltyUntil && b.matchingPenaltyUntil > now;
  if (aPenalised !== bPenalised) return aPenalised ? 1 : -1;

  // 1. Distance (closest first, 0.1 km tolerance bucket to avoid micro-oscillation)
  const distDiff = (a._distanceKm ?? 0) - (b._distanceKm ?? 0);
  if (Math.abs(distDiff) > 0.1) return distDiff;

  // 2. Rating (highest first)
  if (b.rating !== a.rating) return b.rating - a.rating;

  // 3. Cancel count (most reliable first)
  return (a.cancelCount ?? 0) - (b.cancelCount ?? 0);
};

/**
 * Send an offer to a single runner, update DB state, and schedule the timeout.
 */
const offerToRunner = async (errand, runner) => {
  const expiresAt = new Date(Date.now() + OFFER_TIMEOUT_MS);

  // Atomic update — set offer + add runner to offeredTo + increment attempts
  await Errand.findByIdAndUpdate(errand._id, {
    'matchingState.status':             'offered',
    'matchingState.currentOffer.runnerId':  runner._id,
    'matchingState.currentOffer.offeredAt': new Date(),
    'matchingState.currentOffer.expiresAt': expiresAt,
    $addToSet: { 'matchingState.offeredTo': runner._id },
    $inc:      { 'matchingState.attempts': 1 },
    'matchingState.lastSearchAt': new Date(),
  });

  // Mark runner as receiving a request so they don't get double-offered
  await User.findByIdAndUpdate(runner._id, {
    'availability.status': 'receiving_request',
  });

  // Emit offer to the runner
  getSocket().emitToUser(runner._id.toString(), 'errand:request', {
    errand: {
      _id:              errand._id,
      title:            errand.title,
      description:      errand.description,
      location:         errand.location,
      amount:           errand.amount,
      runnerCommission: errand.runnerCommission,
      platformRunnerFee:errand.platformRunnerFee,
      runnerReceives:   errand.runnerReceives,
      trustHeld:        errand.trustHeld,
      distanceKm:       runner._distanceKm != null
                          ? Math.round(runner._distanceKm * 10) / 10
                          : null,
    },
    expiresAt: expiresAt.toISOString(),
    timeoutMs: OFFER_TIMEOUT_MS,
  });

  // Tell the customer someone is reviewing their errand
  getSocket().emitRunnerOffered(errand.customer.toString(), errand._id);

  logger.info('Offer sent', {
    errandId: errand._id,
    runnerId: runner._id,
    distanceKm: runner._distanceKm,
    expiresAt,
  });

  // Schedule timeout → fire if no accept/decline within OFFER_TIMEOUT_MS
  const handle = setTimeout(
    () => handleOfferTimeout(errand._id.toString(), runner._id.toString()),
    OFFER_TIMEOUT_MS,
  );
  activeTimeouts.set(errand._id.toString(), handle);
};

/**
 * Fired when the offer timeout elapses with no runner response.
 * Resets runner status, clears offer, and continues the matching cycle.
 */
const handleOfferTimeout = async (errandId, runnerId) => {
  activeTimeouts.delete(errandId);

  logger.info('Offer timed out — moving to next candidate', { errandId, runnerId });

  let errand;
  try {
    errand = await Errand.findById(errandId);
  } catch (err) {
    logger.error('handleOfferTimeout: DB lookup failed', { errandId, error: err.message });
    return;
  }

  if (!errand || errand.status !== 'pending') return;

  // Guard: only act if the timed-out offer is still the current one
  if (errand.matchingState?.currentOffer?.runnerId?.toString() !== runnerId) return;

  // Reset runner status: receiving_request → available
  await User.findByIdAndUpdate(runnerId, {
    'availability.status': 'available',
  });

  // Notify runner the offer expired
  getSocket().emitToUser(runnerId, 'errand:expired', {
    errandId,
    reason:  'timeout',
    message: 'Offer expired.',
  });

  // Clear the offer from the errand
  await Errand.findByIdAndUpdate(errandId, {
    'matchingState.status':             'searching',
    'matchingState.currentOffer.runnerId':  null,
    'matchingState.currentOffer.offeredAt': null,
    'matchingState.currentOffer.expiresAt': null,
  });

  // Continue matching with the next candidate
  await runMatchingCycle(errandId);
};

/**
 * Called when no eligible runner exists or all candidates were exhausted.
 * Transitions the errand to 'marketplace' so it appears in the runner browse screen.
 */
const handleNoRunner = async (errand) => {
  await Errand.findByIdAndUpdate(errand._id, {
    status:                               'marketplace',
    'matchingState.status':               'no_runner',
    'matchingState.currentOffer.runnerId':  null,
    'matchingState.currentOffer.offeredAt': null,
    'matchingState.currentOffer.expiresAt': null,
  });

  // Notify customer + broadcast errand to all runners' browse screens
  getSocket().emitMarketplaceFallback(errand.customer.toString(), {
    _id:               errand._id,
    title:             errand.title,
    description:       errand.description,
    location:          errand.location,
    amount:            errand.amount,
    runnerCommission:  errand.runnerCommission,
    platformRunnerFee: errand.platformRunnerFee,
    runnerReceives:    errand.runnerReceives,
    trustHeld:         errand.trustHeld,
    status:            'marketplace',
    customer:          errand.customer,
    createdAt:         errand.createdAt,
  });

  await notify.send({
    userId:       errand.customer,
    title:        'Expanding Search',
    message:      `No nearby runners for "${errand.title}". We've opened it to all runners in the marketplace.`,
    type:         'errand',
    relatedId:    errand._id,
    relatedModel: 'Errand',
    eventName:    'errand-marketplace',
    eventData:    { errandId: errand._id },
  });

  logger.warn('No runner found — moved to marketplace', { errandId: errand._id });
};

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  runMatchingCycle,
  validateAcceptance,
  onRunnerAccepted,
  handleRunnerCancellation,
  clearOfferTimeout,
  // Expose config constants for tests / admin endpoints
  MATCH_RADIUS_KM,
  OFFER_TIMEOUT_MS,
  MAX_TOTAL_ATTEMPTS,
};
