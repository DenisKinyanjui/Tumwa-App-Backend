/**
 * Level configuration for runners.
 *
 * Progression requirements (all conditions must be met simultaneously):
 *   minErrands      — minimum completed errands
 *   minRating       — minimum average star rating
 *   maxDisputeRate  — maximum allowed ratio of disputes to completed errands
 *
 * Privileges granted at each level:
 *   maxErrandAmount — highest errand value the runner may accept (null = unlimited)
 *   walletLimit     — suggested maximum trust wallet top-up (null = unlimited)
 */
const LEVEL_CONFIG = [
  {
    level: 1,
    label: 'Rookie',
    minErrands: 0,
    minRating: 0,
    maxDisputeRate: Infinity,
    maxErrandAmount: 500,
    walletLimit: 500,
  },
  {
    level: 2,
    label: 'Reliable',
    minErrands: 5,
    minRating: 3.5,
    maxDisputeRate: Infinity,
    maxErrandAmount: 1500,
    walletLimit: 1000,
  },
  {
    level: 3,
    label: 'Trusted',
    minErrands: 15,
    minRating: 4.0,
    maxDisputeRate: 0.10, // ≤ 10% dispute rate
    maxErrandAmount: 3000,
    walletLimit: 2000,
  },
  {
    level: 4,
    label: 'Elite',
    minErrands: 30,
    minRating: 4.5,
    maxDisputeRate: 0.05, // ≤ 5% dispute rate
    maxErrandAmount: 10000,
    walletLimit: 5000,
  },
  {
    level: 5,
    label: 'Legend',
    minErrands: 60,
    minRating: 4.8,
    maxDisputeRate: 0.02, // ≤ 2% dispute rate
    maxErrandAmount: null,  // unlimited
    walletLimit: null,      // unlimited
  },
];

/**
 * Determine the highest level a runner currently qualifies for.
 * Iterates from highest to lowest and returns the first match.
 *
 * @param {object} runner - plain object or Mongoose doc with:
 *   { completedErrands, rating, ratingCount, disputesAgainst }
 * @returns {object} the matching LEVEL_CONFIG entry
 */
const computeLevel = (runner) => {
  const { completedErrands = 0, rating = 0, disputesAgainst = 0 } = runner;
  const disputeRate = completedErrands > 0 ? disputesAgainst / completedErrands : 0;

  for (let i = LEVEL_CONFIG.length - 1; i >= 0; i--) {
    const cfg = LEVEL_CONFIG[i];
    if (
      completedErrands >= cfg.minErrands &&
      rating >= cfg.minRating &&
      disputeRate <= cfg.maxDisputeRate
    ) {
      return cfg;
    }
  }

  return LEVEL_CONFIG[0]; // always at least level 1
};

/**
 * Check whether the runner's stored level needs to change.
 * Updates runner.level in-place if it does.
 *
 * @param {mongoose.Document} runner
 * @returns {{ leveledUp: boolean, newLevel: number, config: object }}
 */
const checkAndUpdateLevel = (runner) => {
  const config = computeLevel(runner);
  const leveledUp = config.level > runner.level;

  if (leveledUp) {
    runner.level = config.level;
  }

  return { leveledUp, newLevel: config.level, config };
};

/**
 * Return the config for a specific level number.
 */
const getLevelConfig = (level) => LEVEL_CONFIG.find((c) => c.level === level) || LEVEL_CONFIG[0];

/**
 * Return progress metrics toward the next level for a runner.
 */
const getLevelProgress = (runner) => {
  const current = computeLevel(runner);
  const nextConfig = LEVEL_CONFIG.find((c) => c.level === current.level + 1);

  if (!nextConfig) {
    return { currentLevel: current, nextLevel: null, progress: null };
  }

  const disputeRate =
    runner.completedErrands > 0 ? runner.disputesAgainst / runner.completedErrands : 0;

  return {
    currentLevel: current,
    nextLevel: nextConfig,
    progress: {
      errands: {
        current: runner.completedErrands,
        required: nextConfig.minErrands,
        met: runner.completedErrands >= nextConfig.minErrands,
      },
      rating: {
        current: parseFloat((runner.rating || 0).toFixed(2)),
        required: nextConfig.minRating,
        met: (runner.rating || 0) >= nextConfig.minRating,
      },
      disputeRate: {
        current: parseFloat(disputeRate.toFixed(4)),
        maxAllowed: nextConfig.maxDisputeRate === Infinity ? null : nextConfig.maxDisputeRate,
        met: disputeRate <= nextConfig.maxDisputeRate,
      },
    },
  };
};

module.exports = { LEVEL_CONFIG, computeLevel, checkAndUpdateLevel, getLevelConfig, getLevelProgress };
