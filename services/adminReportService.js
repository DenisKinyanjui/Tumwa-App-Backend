const Errand = require('../models/Errand');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Dispute = require('../models/Dispute');
const Rating = require('../models/Rating');

/**
 * Return the start date for a reporting period relative to now.
 * period: 'day' | 'week' | 'month' | 'quarter' | 'year'
 */
const getPeriodStart = (period) => {
  const now = new Date();
  switch (period) {
    case 'day':     return new Date(now - 24 * 60 * 60 * 1000);
    case 'week':    return new Date(now - 7 * 24 * 60 * 60 * 1000);
    case 'month':   return new Date(now.getFullYear(), now.getMonth(), 1);
    case 'quarter': return new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    case 'year':    return new Date(now.getFullYear(), 0, 1);
    default:        return new Date(now.getFullYear(), now.getMonth(), 1);
  }
};

const groupByFormat = (period) => {
  switch (period) {
    case 'day':     return '%Y-%m-%dT%H:00'; // hourly buckets
    case 'week':    return '%Y-%m-%d';         // daily buckets
    case 'month':   return '%Y-%m-%d';         // daily buckets
    case 'quarter': return '%Y-%W';            // weekly buckets
    case 'year':    return '%Y-%m';            // monthly buckets
    default:        return '%Y-%m-%d';
  }
};

// ── Errand statistics ─────────────────────────────────────────────────────────
const getErrandStats = async (since) => {
  const [result] = await Errand.aggregate([
    {
      $facet: {
        byStatus: [
          { $group: { _id: '$status', count: { $sum: 1 }, totalValue: { $sum: '$amount' } } },
          { $sort: { _id: 1 } },
        ],
        overall: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              totalValue: { $sum: '$amount' },
              avgValue: { $avg: '$amount' },
              paidCount: { $sum: { $cond: ['$isPaid', 1, 0] } },
              completedCount: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
              disputedCount: { $sum: { $cond: [{ $eq: ['$status', 'disputed'] }, 1, 0] } },
            },
          },
        ],
        inPeriod: [
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: null, count: { $sum: 1 }, totalValue: { $sum: '$amount' } } },
        ],
      },
    },
  ]);

  return {
    overall: result.overall[0] ?? { total: 0, totalValue: 0, avgValue: 0, paidCount: 0 },
    byStatus: result.byStatus,
    inPeriod: result.inPeriod[0] ?? { count: 0, totalValue: 0 },
  };
};

// ── Payment statistics ────────────────────────────────────────────────────────
const getPaymentStats = async (since) => {
  const [result] = await Payment.aggregate([
    {
      $facet: {
        errandPayments: [
          { $match: { type: 'errand_payment', status: 'completed' } },
          { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } },
        ],
        withdrawals: [
          { $match: { type: 'withdrawal', status: 'completed' } },
          { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } },
        ],
        failed: [
          { $match: { status: 'failed' } },
          { $group: { _id: null, count: { $sum: 1 } } },
        ],
        pending: [
          { $match: { status: 'pending' } },
          { $group: { _id: null, count: { $sum: 1 } } },
        ],
        inPeriod: [
          { $match: { type: 'errand_payment', status: 'completed', completedAt: { $gte: since } } },
          { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } },
        ],
      },
    },
  ]);

  const errand = result.errandPayments[0] ?? { count: 0, total: 0 };
  const withdrawals = result.withdrawals[0] ?? { count: 0, total: 0 };
  const failed = result.failed[0] ?? { count: 0 };
  const pending = result.pending[0] ?? { count: 0 };
  const totalAttempts = errand.count + failed.count + pending.count;

  return {
    errandPayments: errand,
    withdrawals,
    failed,
    pending,
    successRate: totalAttempts > 0
      ? parseFloat(((errand.count / totalAttempts) * 100).toFixed(1))
      : 0,
    inPeriod: result.inPeriod[0] ?? { count: 0, total: 0 },
  };
};

// ── Dispute statistics ────────────────────────────────────────────────────────
const getDisputeStats = async (since) => {
  const [result] = await Dispute.aggregate([
    {
      $facet: {
        byStatus: [
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ],
        byOutcome: [
          { $match: { status: 'resolved' } },
          { $group: { _id: '$resolution.outcome', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ],
        inPeriod: [
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: null, count: { $sum: 1 } } },
        ],
        avgResolutionTime: [
          {
            $match: {
              status: { $in: ['resolved', 'rejected'] },
              'resolution.resolvedAt': { $ne: null },
            },
          },
          {
            $project: {
              resolutionMs: {
                $subtract: ['$resolution.resolvedAt', '$createdAt'],
              },
            },
          },
          { $group: { _id: null, avgMs: { $avg: '$resolutionMs' } } },
        ],
      },
    },
  ]);

  const byStatus = Object.fromEntries(result.byStatus.map((s) => [s._id, s.count]));
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const resolved = byStatus.resolved ?? 0;
  const avgMs = result.avgResolutionTime[0]?.avgMs ?? 0;

  return {
    total,
    byStatus,
    byOutcome: result.byOutcome,
    inPeriod: result.inPeriod[0]?.count ?? 0,
    resolutionRate: total > 0 ? parseFloat(((resolved / total) * 100).toFixed(1)) : 0,
    avgResolutionHours: parseFloat((avgMs / 3_600_000).toFixed(1)),
  };
};

// ── User / wallet statistics ──────────────────────────────────────────────────
const getUserStats = async (since) => {
  const [result] = await User.aggregate([
    {
      $facet: {
        byRole: [
          { $group: { _id: '$role', count: { $sum: 1 }, active: { $sum: { $cond: ['$isActive', 1, 0] } } } },
          { $sort: { _id: 1 } },
        ],
        walletSummary: [
          { $match: { role: 'runner' } },
          {
            $group: {
              _id: null,
              totalWalletBalance: { $sum: '$trustWallet.total' },
              totalLockedFunds: { $sum: '$trustWallet.locked' },
              avgWalletBalance: { $avg: '$trustWallet.total' },
              runnersWithFunds: { $sum: { $cond: [{ $gt: ['$trustWallet.total', 0] }, 1, 0] } },
            },
          },
        ],
        newInPeriod: [
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: '$role', count: { $sum: 1 } } },
        ],
      },
    },
  ]);

  return {
    byRole: result.byRole,
    walletSummary: result.walletSummary[0] ?? {
      totalWalletBalance: 0,
      totalLockedFunds: 0,
      avgWalletBalance: 0,
      runnersWithFunds: 0,
    },
    newInPeriod: result.newInPeriod,
  };
};

// ── Volume time-series ────────────────────────────────────────────────────────
const getVolumeTimeSeries = async (since, period) => {
  const format = groupByFormat(period);

  const [errands, payments] = await Promise.all([
    Errand.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format, date: '$createdAt' } },
          count: { $sum: 1 },
          totalValue: { $sum: '$amount' },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Payment.aggregate([
      { $match: { type: 'errand_payment', status: 'completed', completedAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format, date: '$completedAt' } },
          count: { $sum: 1 },
          totalValue: { $sum: '$amount' },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  return { errands, payments };
};

// ── Top runners ───────────────────────────────────────────────────────────────
const getTopRunners = async (limit = 10) => {
  return User.find({ role: 'runner', isActive: true })
    .select('name phone rating completedErrands level trustWallet disputesAgainst')
    .sort({ completedErrands: -1, rating: -1 })
    .limit(limit)
    .lean();
};

// ── Rating distribution ───────────────────────────────────────────────────────
const getRatingDistribution = async () => {
  return Rating.aggregate([
    { $group: { _id: '$stars', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
};

// ── Master report ─────────────────────────────────────────────────────────────
const buildReport = async (period = 'month') => {
  const since = getPeriodStart(period);

  const [errandStats, paymentStats, disputeStats, userStats, timeSeries, topRunners, ratingDist] =
    await Promise.all([
      getErrandStats(since),
      getPaymentStats(since),
      getDisputeStats(since),
      getUserStats(since),
      getVolumeTimeSeries(since, period),
      getTopRunners(10),
      getRatingDistribution(),
    ]);

  return {
    generatedAt: new Date(),
    period,
    since,
    errandStats,
    paymentStats,
    disputeStats,
    userStats,
    timeSeries,
    topRunners,
    ratingDistribution: ratingDist,
  };
};

module.exports = { buildReport };
