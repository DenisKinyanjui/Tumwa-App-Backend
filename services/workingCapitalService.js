/**
 * Working Capital Limit auto-progression.
 *
 * Owns limit INCREASE/DECREASE decisions (the ceiling). Utilization (`used`) is
 * handled separately in utils/walletUtils.js's accept/complete/cancel functions —
 * this service only ever touches workingCapital.limit.
 *
 * Increase: on completion, every N completions (env-configurable), if rating
 * and dispute rate are healthy, step the limit up — capped by the runner's
 * current level's walletLimit (utils/levelUtils.js) and an absolute max.
 *
 * Decrease: only when a runner is at fault — an unexcused runner-initiated
 * cancellation, or a dispute resolved 'runner_at_fault'. Customer/admin
 * cancellations and excused runner cancellations never affect the limit.
 */

const User = require('../models/User');
const { computeLevel } = require('../utils/levelUtils');

const DEFAULT_LIMIT            = Number(process.env.DEFAULT_WORKING_CAPITAL_LIMIT) || 500;
const MAX_LIMIT                = Number(process.env.WORKING_CAPITAL_MAX_LIMIT) || 50000;
const INCREASE_STEP            = Number(process.env.WORKING_CAPITAL_INCREASE_STEP) || 500;
const DECREASE_STEP            = Number(process.env.WORKING_CAPITAL_DECREASE_STEP) || 1000;
const INCREASE_CHECK_INTERVAL  = Number(process.env.WORKING_CAPITAL_INCREASE_CHECK_INTERVAL) || 5;
const MIN_RATING_FOR_INCREASE  = Number(process.env.WORKING_CAPITAL_MIN_RATING_FOR_INCREASE) || 4.5;
const MAX_DISPUTE_RATE_FOR_INCREASE = Number(process.env.WORKING_CAPITAL_MAX_DISPUTE_RATE_FOR_INCREASE) || 0.05;

/**
 * Recalculate a runner's working capital limit after an errand lifecycle event.
 *
 * @param {string} runnerId
 * @param {object} opts
 * @param {'completed'|'cancelled'} opts.trigger
 * @param {object} [opts.errand] - the errand document (for cancelledBy/excusedCancellation)
 * @param {string} [opts.disputeOutcome] - Dispute.resolution.outcome, when triggered from a dispute resolution
 * @param {import('mongoose').ClientSession} [opts.session]
 * @returns {Promise<{limit: number, used: number}>}
 */
const recalculateWorkingCapital = async (runnerId, { trigger, errand = null, disputeOutcome = null, session }) => {
  const runner = await User.findById(runnerId).session(session);
  if (!runner) throw new Error('Runner not found');

  const level = computeLevel(runner);
  const ceiling = level.walletLimit == null ? MAX_LIMIT : Math.min(level.walletLimit, MAX_LIMIT);

  if (trigger === 'completed') {
    const eligible =
      runner.completedErrands > 0 &&
      runner.completedErrands % INCREASE_CHECK_INTERVAL === 0 &&
      runner.rating >= MIN_RATING_FOR_INCREASE &&
      runner.disputeRate <= MAX_DISPUTE_RATE_FOR_INCREASE;

    if (eligible) {
      runner.workingCapital.limit = Math.min(runner.workingCapital.limit + INCREASE_STEP, ceiling);
    }
  }

  if (trigger === 'cancelled') {
    const runnerAtFault =
      (errand?.cancelledBy === 'runner' && !errand.excusedCancellation) ||
      disputeOutcome === 'runner_at_fault';

    if (runnerAtFault) {
      runner.workingCapital.limit = Math.max(runner.workingCapital.limit - DECREASE_STEP, 0);
    }
  }

  await runner.save({ session });
  return runner.workingCapital;
};

/**
 * Reverse a previously-applied at-fault decrease — used when an admin marks a
 * runner's cancellation as excused after the fact (errand.excusedCancellation).
 * Restores DECREASE_STEP, capped at the runner's level ceiling.
 */
const reverseFaultPenalty = async (runnerId, session) => {
  const runner = await User.findById(runnerId).session(session);
  if (!runner) throw new Error('Runner not found');

  const level = computeLevel(runner);
  const ceiling = level.walletLimit == null ? MAX_LIMIT : Math.min(level.walletLimit, MAX_LIMIT);

  runner.workingCapital.limit = Math.min(runner.workingCapital.limit + DECREASE_STEP, ceiling);
  await runner.save({ session });
  return runner.workingCapital;
};

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  recalculateWorkingCapital,
  reverseFaultPenalty,
};
