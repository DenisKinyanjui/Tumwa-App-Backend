const Errand = require('../models/Errand');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Dispute = require('../models/Dispute');
const Rating = require('../models/Rating');
const ServiceArea = require('../models/ServiceArea');
const RunnerVerification = require('../models/RunnerVerification');
const { escapeRegex } = require('../utils/regex');

// ── Date helpers ──────────────────────────────────────────────────────────────

const PERIOD_START = {
  day: () => new Date(Date.now() - 24 * 60 * 60 * 1000),
  week: () => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  month: () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  quarter: () =>
    new Date(
      new Date().getFullYear(),
      Math.floor(new Date().getMonth() / 3) * 3,
      1
    ),
  year: () => new Date(new Date().getFullYear(), 0, 1),
};

const TIME_BUCKET_FORMAT = {
  day: '%Y-%m-%dT%H:00',    // hourly
  week: '%Y-%m-%d',          // daily
  month: '%Y-%m-%d',         // daily
  quarter: '%Y-%W',          // weekly (ISO week)
  year: '%Y-%m',             // monthly
};

/**
 * Parse dateFrom / dateTo query params.
 * Falls back to period shorthand (day|week|month|quarter|year).
 * Returns { since: Date, to: Date, bucketFormat: string }
 */
const parseDateRange = (query = {}) => {
  const { dateFrom, dateTo, period = 'month' } = query;

  const since = dateFrom
    ? new Date(dateFrom)
    : (PERIOD_START[period] ?? PERIOD_START.month)();

  const to = dateTo ? new Date(dateTo) : new Date();

  // Pick bucket granularity from period or auto-detect from range span
  let effectivePeriod = period;
  if (dateFrom && dateTo) {
    const days = (to - since) / (1000 * 60 * 60 * 24);
    if (days <= 2) effectivePeriod = 'day';
    else if (days <= 31) effectivePeriod = 'week';
    else if (days <= 92) effectivePeriod = 'month';
    else if (days <= 365) effectivePeriod = 'quarter';
    else effectivePeriod = 'year';
  }

  return { since, to, bucketFormat: TIME_BUCKET_FORMAT[effectivePeriod] ?? '%Y-%m-%d' };
};

// ── Overview (dashboard summary) ──────────────────────────────────────────────

const getOverview = async (since, to) => {
  const dateFilter = { $gte: since, $lte: to };

  const [userStats, errandStats, paymentStats, disputeStats, walletStats, escrowStats, workingCapitalStats] =
    await Promise.all([
      // User counts by role
      User.aggregate([
        {
          $facet: {
            byRole: [
              {
                $group: {
                  _id: '$role',
                  total: { $sum: 1 },
                  active: { $sum: { $cond: ['$isActive', 1, 0] } },
                },
              },
            ],
            newInPeriod: [
              { $match: { createdAt: dateFilter } },
              { $group: { _id: '$role', count: { $sum: 1 } } },
            ],
            verificationByStatus: [
              { $match: { role: 'runner' } },
              { $group: { _id: '$verificationStatus', count: { $sum: 1 } } },
            ],
          },
        },
      ]),

      // Errand counts + value
      Errand.aggregate([
        {
          $facet: {
            overall: [
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  totalValue: { $sum: '$amount' },
                  avgAmount: { $avg: '$amount' },
                  completedCount: {
                    $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] },
                  },
                  pendingCount: {
                    $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] },
                  },
                  cancelledCount: {
                    $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] },
                  },
                  disputedCount: {
                    $sum: { $cond: [{ $eq: ['$status', 'disputed'] }, 1, 0] },
                  },
                },
              },
            ],
            inPeriod: [
              { $match: { createdAt: dateFilter } },
              {
                $group: {
                  _id: null,
                  count: { $sum: 1 },
                  totalValue: { $sum: '$amount' },
                  completedCount: {
                    $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] },
                  },
                },
              },
            ],
            commission: [
              { $match: { status: 'completed', completedAt: dateFilter } },
              { $group: { _id: null, total: { $sum: '$platformEarns' } } },
            ],
          },
        },
      ]),

      // Revenue + withdrawals
      Payment.aggregate([
        {
          $facet: {
            revenue: [
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
            inPeriodRevenue: [
              {
                $match: {
                  type: 'errand_payment',
                  status: 'completed',
                  completedAt: dateFilter,
                },
              },
              { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } },
            ],
            pendingWithdrawals: [
              { $match: { type: 'withdrawal', status: 'pending' } },
              { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } },
            ],
          },
        },
      ]),

      // Disputes
      Dispute.aggregate([
        {
          $facet: {
            byStatus: [
              { $group: { _id: '$status', count: { $sum: 1 } } },
            ],
            inPeriod: [
              { $match: { createdAt: dateFilter } },
              { $group: { _id: null, count: { $sum: 1 } } },
            ],
          },
        },
      ]),

      // Wallet totals — runner withdrawable earnings vs. customer reusable credit
      User.aggregate([
        {
          $facet: {
            runnerWallet: [
              { $match: { role: 'runner' } },
              { $group: { _id: null, total: { $sum: '$wallet.earnings' } } },
            ],
            customerWallet: [
              { $match: { role: 'customer' } },
              { $group: { _id: null, total: { $sum: '$customerWallet.balance' } } },
            ],
          },
        },
      ]),

      // Escrow — errand funds already paid in but not yet released to the
      // runner (not completed/confirmed) or refunded (not cancelled).
      Errand.aggregate([
        { $match: { isPaid: true, status: { $in: ['assigned', 'in_progress', 'completed'] } } },
        { $group: { _id: null, total: { $sum: '$trustHeld' } } },
      ]),

      // Working capital utilization — how much of each runner's risk limit
      // is currently tied up in active errands (not a cash balance, see
      // workingCapital comment in models/User.js).
      User.aggregate([
        { $match: { role: 'runner', 'workingCapital.limit': { $gt: 0 } } },
        {
          $group: {
            _id: null,
            totalLimit: { $sum: '$workingCapital.limit' },
            totalUsed: { $sum: '$workingCapital.used' },
            avgUtilization: {
              $avg: { $divide: ['$workingCapital.used', '$workingCapital.limit'] },
            },
          },
        },
      ]),
    ]);

  // ── Shape user data ────────────────────────────────────────────────────────
  const byRole = Object.fromEntries(
    userStats[0].byRole.map((r) => [r._id, { total: r.total, active: r.active }])
  );
  const newInPeriod = Object.fromEntries(
    userStats[0].newInPeriod.map((r) => [r._id, r.count])
  );
  const totalUsers =
    (byRole.customer?.total ?? 0) + (byRole.runner?.total ?? 0);
  const verificationByStatus = Object.fromEntries(
    userStats[0].verificationByStatus.map((r) => [r._id ?? 'none', r.count])
  );

  // ── Shape errand data ──────────────────────────────────────────────────────
  const errandOverall = errandStats[0].overall[0] ?? {
    total: 0, totalValue: 0, avgAmount: 0,
    completedCount: 0, pendingCount: 0, cancelledCount: 0, disputedCount: 0,
  };
  const errandInPeriod = errandStats[0].inPeriod[0] ?? {
    count: 0, totalValue: 0, completedCount: 0,
  };
  const commissionTotal = errandStats[0].commission[0]?.total ?? 0;
  const completionRate =
    errandOverall.total > 0
      ? parseFloat(
          ((errandOverall.completedCount / errandOverall.total) * 100).toFixed(1)
        )
      : 0;

  // ── Shape payment data ─────────────────────────────────────────────────────
  const revenue = paymentStats[0].revenue[0] ?? { count: 0, total: 0 };
  const withdrawals = paymentStats[0].withdrawals[0] ?? { count: 0, total: 0 };
  const failedCount = paymentStats[0].failed[0]?.count ?? 0;
  const inPeriodRevenue = paymentStats[0].inPeriodRevenue[0] ?? { count: 0, total: 0 };
  const pendingWithdrawals = paymentStats[0].pendingWithdrawals[0] ?? { count: 0, total: 0 };
  const totalPaymentAttempts = revenue.count + failedCount;
  const paymentSuccessRate =
    totalPaymentAttempts > 0
      ? parseFloat(((revenue.count / totalPaymentAttempts) * 100).toFixed(1))
      : 0;

  // ── Shape dispute data ─────────────────────────────────────────────────────
  const disputeByStatus = Object.fromEntries(
    disputeStats[0].byStatus.map((d) => [d._id, d.count])
  );
  const totalDisputes = Object.values(disputeByStatus).reduce((a, b) => a + b, 0);

  // ── Wallet / escrow data ───────────────────────────────────────────────────
  const runnerWalletTotal = walletStats[0]?.runnerWallet[0]?.total ?? 0;
  const customerWalletTotal = walletStats[0]?.customerWallet[0]?.total ?? 0;
  const escrowTotal = escrowStats[0]?.total ?? 0;

  // ── Working capital data ───────────────────────────────────────────────────
  const wc = workingCapitalStats[0] ?? { totalLimit: 0, totalUsed: 0, avgUtilization: 0 };

  return {
    period: { since, to },
    users: {
      total: totalUsers,
      customers: byRole.customer ?? { total: 0, active: 0 },
      runners: {
        ...(byRole.runner ?? { total: 0, active: 0 }),
        verification: {
          pending: verificationByStatus.pending ?? 0,
          approved: verificationByStatus.approved ?? 0,
          rejected: verificationByStatus.rejected ?? 0,
          none: verificationByStatus.none ?? 0,
        },
      },
      newInPeriod,
    },
    errands: {
      total: errandOverall.total,
      totalValue: errandOverall.totalValue,
      avgAmount: parseFloat((errandOverall.avgAmount ?? 0).toFixed(2)),
      completedCount: errandOverall.completedCount,
      pendingCount: errandOverall.pendingCount,
      cancelledCount: errandOverall.cancelledCount,
      disputedCount: errandOverall.disputedCount,
      completionRate,
      inPeriod: errandInPeriod,
    },
    payments: {
      revenue,
      withdrawals,
      pendingWithdrawals,
      failedCount,
      inPeriodRevenue,
      paymentSuccessRate,
      netBalance: revenue.total - withdrawals.total,
      commission: parseFloat(commissionTotal.toFixed(2)),
    },
    disputes: {
      total: totalDisputes,
      byStatus: disputeByStatus,
      inPeriod: disputeStats[0].inPeriod[0]?.count ?? 0,
    },
    wallets: {
      runnerWalletTotal: parseFloat(runnerWalletTotal.toFixed(2)),
      customerWalletTotal: parseFloat(customerWalletTotal.toFixed(2)),
      escrowTotal: parseFloat(escrowTotal.toFixed(2)),
    },
    workingCapital: {
      totalLimit: parseFloat((wc.totalLimit ?? 0).toFixed(2)),
      totalUsed: parseFloat((wc.totalUsed ?? 0).toFixed(2)),
      avgUtilization: parseFloat((((wc.avgUtilization ?? 0)) * 100).toFixed(1)),
    },
  };
};

// ── Errand analytics ──────────────────────────────────────────────────────────

// Prefer the structured `location.pickupLocality`/`deliveryLocality`
// captured at booking time (see CreateErrand.tsx's reverse-geocode →
// Errand.location) — an exact, case-insensitive match against an
// admin-managed zone name. Older errands (booked before this existed) or
// ones whose geocoder didn't resolve a locality fall back to fuzzy-matching
// the relevant half of the free-text `location.address` — it's stored as
// "From: {pickup} → To: {delivery}" (see CreateErrand.tsx), so the address
// is split on that arrow and only the pickup-side or delivery-side half is
// searched, matching `field`. Bucketing into "Other" only happens once both
// signals miss. Takes the area name list explicitly (rather than querying
// inside) so callers that already have it — e.g. locationController
// computing per-zone counts — don't re-fetch it.
const buildRegionExpr = (areaNames, field = 'pickup') => {
  if (areaNames.length === 0) {
    return { $ifNull: ['$location.address', 'Unknown'] };
  }

  const localityField = field === 'delivery' ? '$location.deliveryLocality' : '$location.pickupLocality';
  const addressHalfIndex = field === 'delivery' ? 1 : 0;
  const addressHalf = {
    $ifNull: [
      { $arrayElemAt: [{ $split: [{ $ifNull: ['$location.address', ''] }, '→'] }, addressHalfIndex] },
      '',
    ],
  };

  const exactLocalityBranches = areaNames.map((name) => ({
    case: {
      $eq: [
        { $toLower: { $ifNull: [localityField, ''] } },
        name.toLowerCase(),
      ],
    },
    then: name,
  }));

  const addressSubstringBranches = areaNames.map((name) => ({
    case: {
      $regexMatch: {
        input: addressHalf,
        regex: escapeRegex(name),
        options: 'i',
      },
    },
    then: name,
  }));

  return {
    $switch: {
      branches: [...exactLocalityBranches, ...addressSubstringBranches],
      default: 'Other',
    },
  };
};

const getErrandAnalytics = async (since, to, bucketFormat, filters = {}) => {
  const { status, runner, amountMin, amountMax, locationField = 'pickup' } = filters;

  // Build base match for filtered queries
  const baseMatch = { createdAt: { $gte: since, $lte: to } };
  if (status) baseMatch.status = status;
  if (runner) baseMatch.runner = new (require('mongoose').Types.ObjectId)(runner);
  if (amountMin || amountMax) {
    baseMatch.amount = {};
    if (amountMin) baseMatch.amount.$gte = parseFloat(amountMin);
    if (amountMax) baseMatch.amount.$lte = parseFloat(amountMax);
  }

  // All areas regardless of status — a retired zone's historical errands
  // should still attribute to its name rather than fall into "Other".
  const areaNames = (await ServiceArea.find().select('name').lean()).map((a) => a.name);
  const regionExpr = buildRegionExpr(areaNames, locationField);

  const [timeSeries, byStatus, topLocations, completionTrend] = await Promise.all([
    // Line chart — errands over time
    Errand.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: { $dateToString: { format: bucketFormat, date: '$createdAt' } },
          count: { $sum: 1 },
          totalValue: { $sum: '$amount' },
          completedCount: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] },
          },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          label: '$_id',
          count: 1,
          totalValue: { $round: ['$totalValue', 2] },
          completedCount: 1,
          _id: 0,
        },
      },
    ]),

    // Pie chart — by status (all time, affected by filters except date)
    Errand.aggregate([
      { $match: { ...(status ? { status } : {}), ...(runner ? { runner: baseMatch.runner } : {}) } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalValue: { $sum: '$amount' },
        },
      },
      { $sort: { count: -1 } },
      { $project: { label: '$_id', count: 1, totalValue: { $round: ['$totalValue', 2] }, _id: 0 } },
    ]),

    // Bar chart — top 10 regions by errand count
    Errand.aggregate([
      { $match: baseMatch },
      { $group: { _id: regionExpr, count: { $sum: 1 }, totalValue: { $sum: '$amount' } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
      { $project: { label: '$_id', count: 1, totalValue: { $round: ['$totalValue', 2] }, _id: 0 } },
    ]),

    // Line chart — completion rate over time
    Errand.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: { $dateToString: { format: bucketFormat, date: '$createdAt' } },
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          label: '$_id',
          completionRate: {
            $cond: [
              { $gt: ['$total', 0] },
              { $round: [{ $multiply: [{ $divide: ['$completed', '$total'] }, 100] }, 1] },
              0,
            ],
          },
          _id: 0,
        },
      },
    ]),
  ]);

  // Summary for the filtered period
  const [summary] = await Errand.aggregate([
    { $match: baseMatch },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        totalValue: { $sum: '$amount' },
        avgAmount: { $avg: '$amount' },
        completedCount: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        paidCount: { $sum: { $cond: ['$isPaid', 1, 0] } },
      },
    },
  ]);

  const s = summary ?? { count: 0, totalValue: 0, avgAmount: 0, completedCount: 0, paidCount: 0 };

  return {
    summary: {
      total: s.count,
      totalValue: parseFloat((s.totalValue ?? 0).toFixed(2)),
      avgAmount: parseFloat((s.avgAmount ?? 0).toFixed(2)),
      completedCount: s.completedCount,
      paidCount: s.paidCount,
      completionRate:
        s.count > 0
          ? parseFloat(((s.completedCount / s.count) * 100).toFixed(1))
          : 0,
    },
    charts: {
      timeSeries: {
        type: 'line',
        title: 'Errands Over Time',
        data: timeSeries,
      },
      byStatus: {
        type: 'pie',
        title: 'Errands by Status',
        data: byStatus,
      },
      topLocations: {
        type: 'bar',
        title: locationField === 'delivery' ? 'Top 10 Delivery Regions' : 'Top 10 Pickup Regions',
        data: topLocations,
      },
      completionTrend: {
        type: 'line',
        title: 'Completion Rate Over Time (%)',
        data: completionTrend,
      },
    },
  };
};

// ── Payment analytics ─────────────────────────────────────────────────────────

const getPaymentAnalytics = async (since, to, bucketFormat, filters = {}) => {
  const { type } = filters;

  const baseMatch = { completedAt: { $gte: since, $lte: to }, status: 'completed' };
  if (type) baseMatch.type = type;

  const [revenueSeries, byType, byStatus, withdrawalSeries] = await Promise.all([
    // Line chart — revenue over time (errand payments only)
    Payment.aggregate([
      { $match: { ...baseMatch, type: 'errand_payment' } },
      {
        $group: {
          _id: { $dateToString: { format: bucketFormat, date: '$completedAt' } },
          count: { $sum: 1 },
          total: { $sum: '$amount' },
          avgAmount: { $avg: '$amount' },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          label: '$_id',
          count: 1,
          total: { $round: ['$total', 2] },
          avgAmount: { $round: ['$avgAmount', 2] },
          _id: 0,
        },
      },
    ]),

    // Bar chart — errand payments vs withdrawals
    Payment.aggregate([
      { $match: { status: 'completed', completedAt: { $gte: since, $lte: to } } },
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 },
          total: { $sum: '$amount' },
        },
      },
      { $project: { label: '$_id', count: 1, total: { $round: ['$total', 2] }, _id: 0 } },
    ]),

    // Pie chart — by payment status (all time in range)
    Payment.aggregate([
      { $match: { createdAt: { $gte: since, $lte: to } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $project: { label: '$_id', count: 1, _id: 0 } },
    ]),

    // Line chart — withdrawal amounts over time
    Payment.aggregate([
      { $match: { type: 'withdrawal', status: 'completed', completedAt: { $gte: since, $lte: to } } },
      {
        $group: {
          _id: { $dateToString: { format: bucketFormat, date: '$completedAt' } },
          count: { $sum: 1 },
          total: { $sum: '$amount' },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          label: '$_id',
          count: 1,
          total: { $round: ['$total', 2] },
          _id: 0,
        },
      },
    ]),
  ]);

  // Summary
  const [paymentSummary] = await Payment.aggregate([
    { $match: { createdAt: { $gte: since, $lte: to } } },
    {
      $facet: {
        revenue: [
          { $match: { type: 'errand_payment', status: 'completed' } },
          { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' }, avg: { $avg: '$amount' } } },
        ],
        withdrawals: [
          { $match: { type: 'withdrawal', status: 'completed' } },
          { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } },
        ],
        failed: [{ $match: { status: 'failed' } }, { $group: { _id: null, count: { $sum: 1 } } }],
        pending: [{ $match: { status: 'pending' } }, { $group: { _id: null, count: { $sum: 1 } } }],
      },
    },
  ]);

  const rev = paymentSummary?.revenue[0] ?? { count: 0, total: 0, avg: 0 };
  const with_ = paymentSummary?.withdrawals[0] ?? { count: 0, total: 0 };
  const failedCount = paymentSummary?.failed[0]?.count ?? 0;
  const pendingCount = paymentSummary?.pending[0]?.count ?? 0;
  const totalAttempts = rev.count + failedCount + pendingCount;

  return {
    summary: {
      revenue: {
        count: rev.count,
        total: parseFloat((rev.total ?? 0).toFixed(2)),
        avgTransaction: parseFloat((rev.avg ?? 0).toFixed(2)),
      },
      withdrawals: {
        count: with_.count,
        total: parseFloat((with_.total ?? 0).toFixed(2)),
      },
      failedCount,
      pendingCount,
      successRate:
        totalAttempts > 0
          ? parseFloat(((rev.count / totalAttempts) * 100).toFixed(1))
          : 0,
      netBalance: parseFloat(((rev.total ?? 0) - (with_.total ?? 0)).toFixed(2)),
    },
    charts: {
      revenueSeries: {
        type: 'line',
        title: 'Revenue Over Time (KES)',
        data: revenueSeries,
      },
      paymentTypes: {
        type: 'bar',
        title: 'Payments vs Withdrawals',
        data: byType,
      },
      paymentStatus: {
        type: 'pie',
        title: 'Payment Status Breakdown',
        data: byStatus,
      },
      withdrawalSeries: {
        type: 'line',
        title: 'Withdrawals Over Time (KES)',
        data: withdrawalSeries,
      },
    },
  };
};

// ── Runner analytics ──────────────────────────────────────────────────────────

const getRunnerAnalytics = async (since, to, filters = {}) => {
  const { runner } = filters; // optional: single runner deep-dive

  const [
    levelDistribution,
    ratingDistribution,
    topRunners,
    runnerGrowth,
    individualStats,
  ] = await Promise.all([
    // Bar chart — runners by level
    User.aggregate([
      { $match: { role: 'runner', isActive: true } },
      { $group: { _id: '$level', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $project: { label: { $concat: ['Level ', { $toString: '$_id' }] }, count: 1, _id: 0 } },
    ]),

    // Pie chart — star rating distribution
    Rating.aggregate([
      { $group: { _id: '$stars', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      {
        $project: {
          label: { $concat: [{ $toString: '$_id' }, ' Stars'] },
          count: 1,
          _id: 0,
        },
      },
    ]),

    // Table — top 20 runners
    User.find({ role: 'runner', isActive: true })
      .select('name phone level rating completedErrands disputesAgainst wallet createdAt')
      .sort({ completedErrands: -1, rating: -1 })
      .limit(20)
      .lean(),

    // Line chart — new runners registered over time
    User.aggregate([
      { $match: { role: 'runner', createdAt: { $gte: since, $lte: to } } },
      {
        $group: {
          _id: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: '$createdAt',
            },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { label: '$_id', count: 1, _id: 0 } },
    ]),

    // Deep-dive stats for a specific runner (optional)
    runner
      ? (async () => {
          const mongoose = require('mongoose');
          const runnerId = new mongoose.Types.ObjectId(runner);

          const [errandHistory, paymentHistory, disputes, ratings] = await Promise.all([
            Errand.aggregate([
              { $match: { runner: runnerId, createdAt: { $gte: since, $lte: to } } },
              { $group: { _id: '$status', count: { $sum: 1 }, totalValue: { $sum: '$amount' } } },
            ]),
            Payment.aggregate([
              { $match: { runner: runnerId, status: 'completed', completedAt: { $gte: since, $lte: to } } },
              { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } },
            ]),
            Dispute.countDocuments({ runner: runnerId, createdAt: { $gte: since, $lte: to } }),
            Rating.aggregate([
              { $match: { runner: runnerId } },
              { $group: { _id: null, avg: { $avg: '$stars' }, count: { $sum: 1 } } },
            ]),
          ]);

          return {
            errandsByStatus: errandHistory,
            withdrawals: paymentHistory[0] ?? { count: 0, total: 0 },
            disputeCount: disputes,
            rating: ratings[0] ?? { avg: 0, count: 0 },
          };
        })()
      : Promise.resolve(null),
  ]);

  // Aggregate runner performance metrics
  const [runnerMetrics] = await User.aggregate([
    { $match: { role: 'runner' } },
    {
      $group: {
        _id: null,
        totalRunners: { $sum: 1 },
        activeRunners: { $sum: { $cond: ['$isActive', 1, 0] } },
        avgRating: { $avg: '$rating' },
        avgCompletedErrands: { $avg: '$completedErrands' },
        totalCompletedErrands: { $sum: '$completedErrands' },
        totalWalletBalance: { $sum: '$wallet.earnings' },
        runnersWithDisputes: {
          $sum: { $cond: [{ $gt: ['$disputesAgainst', 0] }, 1, 0] },
        },
      },
    },
  ]);

  const metrics = runnerMetrics ?? {
    totalRunners: 0, activeRunners: 0, avgRating: 0,
    avgCompletedErrands: 0, totalCompletedErrands: 0,
    totalWalletBalance: 0, runnersWithDisputes: 0,
  };

  // Shape topRunners for table output
  const topRunnersFormatted = topRunners.map((r) => ({
    _id: r._id,
    name: r.name,
    phone: r.phone,
    level: r.level,
    rating: r.rating,
    completedErrands: r.completedErrands,
    disputesAgainst: r.disputesAgainst,
    disputeRate:
      r.completedErrands > 0
        ? parseFloat((r.disputesAgainst / r.completedErrands).toFixed(3))
        : 0,
    // Runner earnings have no separate "locked" concept — see wallet.earnings
    // comment in models/User.js.
    walletBalance: r.wallet?.earnings ?? 0,
    availableBalance: r.wallet?.earnings ?? 0,
    memberSince: r.createdAt,
  }));

  return {
    summary: {
      totalRunners: metrics.totalRunners,
      activeRunners: metrics.activeRunners,
      avgRating: parseFloat((metrics.avgRating ?? 0).toFixed(2)),
      avgCompletedErrands: parseFloat((metrics.avgCompletedErrands ?? 0).toFixed(1)),
      totalCompletedErrands: metrics.totalCompletedErrands,
      totalWalletBalance: parseFloat((metrics.totalWalletBalance ?? 0).toFixed(2)),
      runnersWithDisputes: metrics.runnersWithDisputes,
    },
    charts: {
      levelDistribution: {
        type: 'bar',
        title: 'Runners by Level',
        data: levelDistribution,
      },
      ratingDistribution: {
        type: 'pie',
        title: 'Rating Distribution',
        data: ratingDistribution,
      },
      runnerGrowth: {
        type: 'line',
        title: 'New Runner Registrations',
        data: runnerGrowth,
      },
    },
    topRunners: {
      type: 'table',
      title: 'Top 20 Runners by Completed Errands',
      data: topRunnersFormatted,
    },
    runnerDetail: individualStats,
  };
};

// ── Customer activity analytics ───────────────────────────────────────────────

const getCustomerAnalytics = async (since, to, bucketFormat) => {
  const dateFilter = { $gte: since, $lte: to };

  const [topCustomers, customerGrowth, spendDistribution] = await Promise.all([
    // Table — top 20 customers by errand spend
    Errand.aggregate([
      { $match: { status: 'completed', completedAt: dateFilter } },
      {
        $group: {
          _id: '$customer',
          errandCount: { $sum: 1 },
          totalSpend: { $sum: '$amount' },
          avgSpend: { $avg: '$amount' },
        },
      },
      { $sort: { totalSpend: -1 } },
      { $limit: 20 },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'customer',
        },
      },
      { $unwind: '$customer' },
      {
        $project: {
          name: '$customer.name',
          phone: '$customer.phone',
          errandCount: 1,
          totalSpend: { $round: ['$totalSpend', 2] },
          avgSpend: { $round: ['$avgSpend', 2] },
          _id: 0,
        },
      },
    ]),

    // Line chart — new customers over time
    User.aggregate([
      { $match: { role: 'customer', createdAt: dateFilter } },
      {
        $group: {
          _id: { $dateToString: { format: bucketFormat, date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { label: '$_id', count: 1, _id: 0 } },
    ]),

    // Bar chart — spend ranges
    Errand.aggregate([
      { $match: { status: 'completed', completedAt: dateFilter } },
      {
        $bucket: {
          groupBy: '$amount',
          boundaries: [0, 500, 1000, 2500, 5000, 10000, Infinity],
          default: 'Other',
          output: { count: { $sum: 1 }, totalValue: { $sum: '$amount' } },
        },
      },
      {
        $project: {
          label: {
            $switch: {
              branches: [
                { case: { $eq: ['$_id', 0] }, then: 'KES 0–500' },
                { case: { $eq: ['$_id', 500] }, then: 'KES 500–1K' },
                { case: { $eq: ['$_id', 1000] }, then: 'KES 1K–2.5K' },
                { case: { $eq: ['$_id', 2500] }, then: 'KES 2.5K–5K' },
                { case: { $eq: ['$_id', 5000] }, then: 'KES 5K–10K' },
                { case: { $eq: ['$_id', 10000] }, then: 'KES 10K+' },
              ],
              default: 'Other',
            },
          },
          count: 1,
          totalValue: { $round: ['$totalValue', 2] },
          _id: 0,
        },
      },
    ]),
  ]);

  const [customerMetrics] = await User.aggregate([
    { $match: { role: 'customer' } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        active: { $sum: { $cond: ['$isActive', 1, 0] } },
        newInPeriod: {
          $sum: { $cond: [{ $gte: ['$createdAt', since] }, 1, 0] },
        },
      },
    },
  ]);

  const cm = customerMetrics ?? { total: 0, active: 0, newInPeriod: 0 };

  return {
    summary: {
      totalCustomers: cm.total,
      activeCustomers: cm.active,
      newInPeriod: cm.newInPeriod,
    },
    charts: {
      customerGrowth: {
        type: 'line',
        title: 'New Customer Registrations',
        data: customerGrowth,
      },
      spendDistribution: {
        type: 'bar',
        title: 'Errand Amount Distribution',
        data: spendDistribution,
      },
    },
    topCustomers: {
      type: 'table',
      title: 'Top 20 Customers by Spend',
      data: topCustomers,
    },
  };
};

// ── Dispute analytics ─────────────────────────────────────────────────────────

const getDisputeAnalytics = async (since, to, bucketFormat) => {
  const dateFilter = { $gte: since, $lte: to };

  const [byStatus, byOutcome, timeSeries, avgResolution] = await Promise.all([
    // Pie chart — dispute status breakdown
    Dispute.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $project: { label: '$_id', count: 1, _id: 0 } },
    ]),

    // Pie chart — resolution outcomes
    Dispute.aggregate([
      { $match: { status: 'resolved' } },
      { $group: { _id: '$resolution.outcome', count: { $sum: 1 } } },
      { $project: { label: '$_id', count: 1, _id: 0 } },
    ]),

    // Line chart — disputes raised over time
    Dispute.aggregate([
      { $match: { createdAt: dateFilter } },
      {
        $group: {
          _id: { $dateToString: { format: bucketFormat, date: '$createdAt' } },
          count: { $sum: 1 },
          resolvedCount: {
            $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0] },
          },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { label: '$_id', count: 1, resolvedCount: 1, _id: 0 } },
    ]),

    // Avg resolution time
    Dispute.aggregate([
      {
        $match: {
          status: { $in: ['resolved', 'rejected'] },
          'resolution.resolvedAt': { $ne: null },
        },
      },
      {
        $project: {
          resolutionMs: { $subtract: ['$resolution.resolvedAt', '$createdAt'] },
        },
      },
      { $group: { _id: null, avgMs: { $avg: '$resolutionMs' }, count: { $sum: 1 } } },
    ]),
  ]);

  const [disputeSummary] = await Dispute.aggregate([
    {
      $facet: {
        total: [{ $count: 'count' }],
        inPeriod: [
          { $match: { createdAt: dateFilter } },
          { $count: 'count' },
        ],
        resolved: [{ $match: { status: 'resolved' } }, { $count: 'count' }],
        pending: [{ $match: { status: 'pending' } }, { $count: 'count' }],
      },
    },
  ]);

  const total = disputeSummary?.total[0]?.count ?? 0;
  const resolved = disputeSummary?.resolved[0]?.count ?? 0;
  const pending = disputeSummary?.pending[0]?.count ?? 0;
  const inPeriod = disputeSummary?.inPeriod[0]?.count ?? 0;
  const avgMs = avgResolution[0]?.avgMs ?? 0;

  return {
    summary: {
      total,
      resolved,
      pending,
      inPeriod,
      resolutionRate:
        total > 0 ? parseFloat(((resolved / total) * 100).toFixed(1)) : 0,
      avgResolutionHours: parseFloat((avgMs / 3_600_000).toFixed(1)),
    },
    charts: {
      byStatus: {
        type: 'pie',
        title: 'Disputes by Status',
        data: byStatus,
      },
      byOutcome: {
        type: 'pie',
        title: 'Resolution Outcomes',
        data: byOutcome,
      },
      timeSeries: {
        type: 'line',
        title: 'Disputes Over Time',
        data: timeSeries,
      },
    },
  };
};

// ── Location analytics ────────────────────────────────────────────────────────

const getLocationAnalytics = async (since, to, bucketFormat) => {
  const dateFilter = { createdAt: { $gte: since, $lte: to } };
  const areaNames = (await ServiceArea.find().select('name').lean()).map((a) => a.name);
  const regionExpr = buildRegionExpr(areaNames, 'pickup');

  const [topRegions, revenueByRegion, growthTrend, summary] = await Promise.all([
    // Bar chart — top 10 regions by errand count
    Errand.aggregate([
      { $match: dateFilter },
      { $group: { _id: regionExpr, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
      { $project: { label: '$_id', count: 1, _id: 0 } },
    ]),

    // Bar chart — revenue by region (completed errands only)
    Errand.aggregate([
      { $match: { ...dateFilter, status: 'completed' } },
      { $group: { _id: regionExpr, total: { $sum: '$amount' } } },
      { $sort: { total: -1 } },
      { $limit: 10 },
      { $project: { label: '$_id', total: { $round: ['$total', 2] }, _id: 0 } },
    ]),

    // Line chart — errand volume over time for the top region bucket
    Errand.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: { $dateToString: { format: bucketFormat, date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { label: '$_id', count: 1, _id: 0 } },
    ]),

    // Summary
    Errand.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          totalValue: { $sum: '$amount' },
          regions: { $addToSet: regionExpr },
        },
      },
    ]),
  ]);

  const s = summary[0] ?? { total: 0, totalValue: 0, regions: [] };

  return {
    summary: {
      totalErrands: s.total,
      totalValue: parseFloat((s.totalValue ?? 0).toFixed(2)),
      activeRegions: (s.regions ?? []).filter((r) => r !== 'Other').length,
    },
    charts: {
      topRegions: {
        type: 'bar',
        title: 'Top Regions by Errands',
        data: topRegions,
      },
      revenueByRegion: {
        type: 'bar',
        title: 'Revenue by Region',
        data: revenueByRegion,
      },
      growthTrend: {
        type: 'line',
        title: 'Errand Volume Over Time',
        data: growthTrend,
      },
    },
  };
};

// ── Verification analytics ────────────────────────────────────────────────────

const getVerificationAnalytics = async (since, to) => {
  const dateFilter = { createdAt: { $gte: since, $lte: to } };

  const [byStatus, timeSeries, avgReview] = await Promise.all([
    // Pie chart — verification status breakdown
    RunnerVerification.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $project: { label: '$_id', count: 1, _id: 0 } },
    ]),

    // Line chart — submissions over time
    RunnerVerification.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { label: '$_id', count: 1, _id: 0 } },
    ]),

    // Avg review time for decided verifications
    RunnerVerification.aggregate([
      { $match: { reviewedAt: { $ne: null } } },
      { $project: { reviewMs: { $subtract: ['$reviewedAt', '$submittedAt'] } } },
      { $group: { _id: null, avgMs: { $avg: '$reviewMs' }, count: { $sum: 1 } } },
    ]),
  ]);

  const statusMap = Object.fromEntries(byStatus.map((s) => [s.label, s.count]));
  const total = Object.values(statusMap).reduce((a, b) => a + b, 0);
  const avgMs = avgReview[0]?.avgMs ?? 0;

  return {
    summary: {
      total,
      pending: statusMap.pending ?? 0,
      approved: statusMap.approved ?? 0,
      rejected: statusMap.rejected ?? 0,
      resubmissionRequested: statusMap.resubmission_requested ?? 0,
      avgReviewHours: parseFloat((avgMs / 3_600_000).toFixed(1)),
    },
    charts: {
      byStatus: {
        type: 'pie',
        title: 'Verification Status Breakdown',
        data: byStatus,
      },
      timeSeries: {
        type: 'line',
        title: 'Verification Submissions Over Time',
        data: timeSeries,
      },
    },
  };
};

module.exports = {
  parseDateRange,
  getOverview,
  getErrandAnalytics,
  getPaymentAnalytics,
  getRunnerAnalytics,
  getCustomerAnalytics,
  getDisputeAnalytics,
  getLocationAnalytics,
  getVerificationAnalytics,
  buildRegionExpr,
};
