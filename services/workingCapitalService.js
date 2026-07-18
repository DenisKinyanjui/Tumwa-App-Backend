/**
 * Working Capital Limit auto-progression.
 *
 * Owns limit INCREASE/DECREASE decisions (the ceiling). Utilization (`used`) is
 * handled separately in utils/walletUtils.js's accept/complete/cancel functions —
 * this service only ever touches workingCapital.limit.
 *
 * Config (default limit, steps, thresholds) is admin-editable at runtime via
 * the AppSettings singleton (see services/settingsService.js) — not env vars.
 *
 * Increase: on completion, every N completions, if rating and dispute rate
 * are healthy, step the limit up — capped by the runner's current level's
 * walletLimit (utils/levelUtils.js) and the admin-configured max.
 *
 * Decrease: only when a runner is at fault — an unexcused runner-initiated
 * cancellation, or a dispute resolved 'runner_at_fault'. Customer/admin
 * cancellations and excused runner cancellations never affect the limit.
 */

const User = require('../models/User');
const { computeLevel } = require('../utils/levelUtils');
const { getSettings } = require('./settingsService');

const getDefaultLimit = async () => (await getSettings()).workingCapital.defaultLimit;
const getMaxLimit = async () => (await getSettings()).workingCapital.maxLimit;

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

  const { workingCapital: cfg } = await getSettings();
  const level = computeLevel(runner);
  const ceiling = level.walletLimit == null ? cfg.maxLimit : Math.min(level.walletLimit, cfg.maxLimit);

  if (trigger === 'completed') {
    const eligible =
      runner.completedErrands > 0 &&
      runner.completedErrands % cfg.increaseCheckInterval === 0 &&
      runner.rating >= cfg.minRatingForIncrease &&
      runner.disputeRate <= cfg.maxDisputeRateForIncrease;

    if (eligible) {
      runner.workingCapital.limit = Math.min(runner.workingCapital.limit + cfg.increaseStep, ceiling);
    }
  }

  if (trigger === 'cancelled') {
    const runnerAtFault =
      (errand?.cancelledBy === 'runner' && !errand.excusedCancellation) ||
      disputeOutcome === 'runner_at_fault';

    if (runnerAtFault) {
      runner.workingCapital.limit = Math.max(runner.workingCapital.limit - cfg.decreaseStep, 0);
    }
  }

  await runner.save({ session });
  return runner.workingCapital;
};

/**
 * Reverse a previously-applied at-fault decrease — used when an admin marks a
 * runner's cancellation as excused after the fact (errand.excusedCancellation).
 * Restores decreaseStep, capped at the runner's level ceiling.
 */
const reverseFaultPenalty = async (runnerId, session) => {
  const runner = await User.findById(runnerId).session(session);
  if (!runner) throw new Error('Runner not found');

  const { workingCapital: cfg } = await getSettings();
  const level = computeLevel(runner);
  const ceiling = level.walletLimit == null ? cfg.maxLimit : Math.min(level.walletLimit, cfg.maxLimit);

  runner.workingCapital.limit = Math.min(runner.workingCapital.limit + cfg.decreaseStep, ceiling);
  await runner.save({ session });
  return runner.workingCapital;
};

module.exports = {
  getDefaultLimit,
  getMaxLimit,
  recalculateWorkingCapital,
  reverseFaultPenalty,
};
