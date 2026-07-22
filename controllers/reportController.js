const Errand = require('../models/Errand');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Dispute = require('../models/Dispute');
const Rating = require('../models/Rating');
const ServiceArea = require('../models/ServiceArea');
const RunnerVerification = require('../models/RunnerVerification');
const { parseDateRange, buildRegionExpr } = require('../services/analyticsService');

// ── Shared helpers ─────────────────────────────────────────────────────────────

const paginate = (query) => {
  const page = Math.max(parseInt(query.page) || 1, 1);
  const limit = Math.min(parseInt(query.limit) || 50, 200);
  return { page, limit, skip: (page - 1) * limit };
};

const paginatedResponse = (res, { summary, rows, charts = null }, total, page, limit) =>
  res.status(200).json({
    status: 'success',
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    summary,
    ...(charts ? { charts } : {}),
    data: rows,
  });

const buildDateFilter = (dateFrom, dateTo) => {
  if (!dateFrom && !dateTo) return null;
  const f = {};
  if (dateFrom) f.$gte = new Date(dateFrom);
  if (dateTo) f.$lte = new Date(dateTo);
  return f;
};

// ── GET /api/admin/reports/errands ────────────────────────────────────────────
// Filters: period | dateFrom | dateTo | status | runner | customer | amountMin | amountMax
// Sort:    sortBy (createdAt|amount|completedAt) | order (asc|desc)
exports.errandsReport = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const {
    status, runner, customer,
    amountMin, amountMax,
    sortBy = 'createdAt', order = 'desc',
  } = req.query;

  const { since, to } = parseDateRange(req.query);
  const dateFilter = buildDateFilter(req.query.dateFrom ?? since, req.query.dateTo ?? to);

  // ── Build filter ─────────────────────────────────────────────────────────
  const filter = {};
  if (dateFilter) filter.createdAt = dateFilter;
  if (status) filter.status = status;
  if (runner) filter.runner = runner;
  if (customer) filter.customer = customer;
  if (amountMin || amountMax) {
    filter.amount = {};
    if (amountMin) filter.amount.$gte = parseFloat(amountMin);
    if (amountMax) filter.amount.$lte = parseFloat(amountMax);
  }

  const ALLOWED_SORTS = ['createdAt', 'amount', 'completedAt', 'status'];
  const sortField = ALLOWED_SORTS.includes(sortBy) ? sortBy : 'createdAt';

  // ── Run queries in parallel ──────────────────────────────────────────────
  const [errands, total, summary] = await Promise.all([
    Errand.find(filter)
      .populate('customer', 'name phone')
      .populate('runner', 'name phone rating level')
      .sort({ [sortField]: order === 'asc' ? 1 : -1 })
      .skip(skip)
      .limit(limit)
      .lean(),

    Errand.countDocuments(filter),

    Errand.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalErrands: { $sum: 1 },
          totalValue: { $sum: '$amount' },
          avgAmount: { $avg: '$amount' },
          completedCount: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          pendingCount: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
          cancelledCount: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
          disputedCount: { $sum: { $cond: [{ $eq: ['$status', 'disputed'] }, 1, 0] } },
          paidCount: { $sum: { $cond: ['$isPaid', 1, 0] } },
        },
      },
    ]),
  ]);

  const s = summary[0] ?? {
    totalErrands: 0, totalValue: 0, avgAmount: 0,
    completedCount: 0, pendingCount: 0, cancelledCount: 0,
    disputedCount: 0, paidCount: 0,
  };

  paginatedResponse(
    res,
    {
      summary: {
        totalErrands: s.totalErrands,
        totalValue: parseFloat((s.totalValue ?? 0).toFixed(2)),
        avgAmount: parseFloat((s.avgAmount ?? 0).toFixed(2)),
        completedCount: s.completedCount,
        pendingCount: s.pendingCount,
        cancelledCount: s.cancelledCount,
        disputedCount: s.disputedCount,
        paidCount: s.paidCount,
        completionRate:
          s.totalErrands > 0
            ? parseFloat(((s.completedCount / s.totalErrands) * 100).toFixed(1))
            : 0,
      },
      rows: errands,
    },
    total,
    page,
    limit
  );
};

// ── GET /api/admin/reports/payments ───────────────────────────────────────────
// Filters: period | dateFrom | dateTo | type | status | amountMin | amountMax
exports.paymentsReport = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const {
    type, status, amountMin, amountMax,
    sortBy = 'createdAt', order = 'desc',
  } = req.query;

  const { since, to } = parseDateRange(req.query);
  const dateFilter = buildDateFilter(req.query.dateFrom ?? since, req.query.dateTo ?? to);

  const filter = {};
  if (dateFilter) filter.createdAt = dateFilter;
  if (type) filter.type = type;
  if (status) filter.status = status;
  if (amountMin || amountMax) {
    filter.amount = {};
    if (amountMin) filter.amount.$gte = parseFloat(amountMin);
    if (amountMax) filter.amount.$lte = parseFloat(amountMax);
  }

  const ALLOWED_SORTS = ['createdAt', 'amount', 'completedAt'];
  const sortField = ALLOWED_SORTS.includes(sortBy) ? sortBy : 'createdAt';

  const [payments, total, summary] = await Promise.all([
    Payment.find(filter)
      .populate('customer', 'name phone')
      .populate('runner', 'name phone')
      .populate('errand', 'title amount status')
      .sort({ [sortField]: order === 'asc' ? 1 : -1 })
      .skip(skip)
      .limit(limit)
      .lean(),

    Payment.countDocuments(filter),

    Payment.aggregate([
      { $match: filter },
      {
        $facet: {
          overall: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                totalAmount: { $sum: '$amount' },
                avgAmount: { $avg: '$amount' },
              },
            },
          ],
          byType: [
            { $group: { _id: '$type', count: { $sum: 1 }, total: { $sum: '$amount' } } },
          ],
          byStatus: [
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ],
          completed: [
            { $match: { status: 'completed' } },
            { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } },
          ],
          failed: [
            { $match: { status: 'failed' } },
            { $group: { _id: null, count: { $sum: 1 } } },
          ],
        },
      },
    ]),
  ]);

  const agg = summary[0] ?? {};
  const overall = agg.overall?.[0] ?? { total: 0, totalAmount: 0, avgAmount: 0 };
  const completed = agg.completed?.[0] ?? { count: 0, total: 0 };
  const failedCount = agg.failed?.[0]?.count ?? 0;
  const byType = Object.fromEntries((agg.byType ?? []).map((t) => [t._id, { count: t.count, total: t.total }]));
  const byStatus = Object.fromEntries((agg.byStatus ?? []).map((s) => [s._id, s.count]));

  paginatedResponse(
    res,
    {
      summary: {
        total: overall.total,
        totalAmount: parseFloat((overall.totalAmount ?? 0).toFixed(2)),
        avgAmount: parseFloat((overall.avgAmount ?? 0).toFixed(2)),
        completedCount: completed.count,
        completedAmount: parseFloat((completed.total ?? 0).toFixed(2)),
        failedCount,
        successRate:
          overall.total > 0
            ? parseFloat(((completed.count / overall.total) * 100).toFixed(1))
            : 0,
        byType,
        byStatus,
      },
      rows: payments,
    },
    total,
    page,
    limit
  );
};

// ── GET /api/admin/reports/runners ────────────────────────────────────────────
// Filters: period | dateFrom | dateTo | level | minRating | minErrands | isActive
// Each row includes per-runner errand + wallet stats
exports.runnersReport = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const {
    level, isActive, minRating, minErrands,
    sortBy = 'completedErrands', order = 'desc',
  } = req.query;

  const { since, to } = parseDateRange(req.query);
  const dateFilter = buildDateFilter(req.query.dateFrom ?? since, req.query.dateTo ?? to);

  const filter = { role: 'runner' };
  if (level) filter.level = parseInt(level);
  if (isActive !== undefined) filter.isActive = isActive === 'true';
  if (minRating) filter.rating = { $gte: parseFloat(minRating) };
  if (minErrands) filter.completedErrands = { $gte: parseInt(minErrands) };

  const ALLOWED_SORTS = ['completedErrands', 'rating', 'createdAt', 'level', 'wallet.earnings'];
  const sortField = ALLOWED_SORTS.includes(sortBy) ? sortBy : 'completedErrands';

  const [runners, total, aggregateStats] = await Promise.all([
    User.find(filter)
      .select('name phone level rating completedErrands ratingCount disputesAgainst wallet isActive createdAt')
      .sort({ [sortField]: order === 'asc' ? 1 : -1 })
      .skip(skip)
      .limit(limit)
      .lean(),

    User.countDocuments(filter),

    // Overall stats for the filtered set
    User.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalRunners: { $sum: 1 },
          activeRunners: { $sum: { $cond: ['$isActive', 1, 0] } },
          avgRating: { $avg: '$rating' },
          avgCompletedErrands: { $avg: '$completedErrands' },
          totalCompletedErrands: { $sum: '$completedErrands' },
          totalWalletBalance: { $sum: '$wallet.earnings' },
        },
      },
    ]),
  ]);

  // Enrich runners with computed fields + period errand counts
  const runnerIds = runners.map((r) => r._id);
  const errandCounts = dateFilter
    ? await Errand.aggregate([
        { $match: { runner: { $in: runnerIds }, createdAt: dateFilter } },
        {
          $group: {
            _id: '$runner',
            periodErrands: { $sum: 1 },
            periodCompleted: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            periodValue: { $sum: '$amount' },
          },
        },
      ])
    : [];

  const errandMap = Object.fromEntries(
    errandCounts.map((e) => [e._id.toString(), e])
  );

  const rows = runners.map((r) => {
    const periodData = errandMap[r._id.toString()] ?? {
      periodErrands: 0, periodCompleted: 0, periodValue: 0,
    };
    return {
      ...r,
      availableBalance: r.wallet?.earnings ?? 0,
      disputeRate:
        r.completedErrands > 0
          ? parseFloat((r.disputesAgainst / r.completedErrands).toFixed(3))
          : 0,
      periodStats: {
        errands: periodData.periodErrands,
        completed: periodData.periodCompleted,
        value: parseFloat((periodData.periodValue ?? 0).toFixed(2)),
      },
    };
  });

  const agg = aggregateStats[0] ?? {
    totalRunners: 0, activeRunners: 0, avgRating: 0,
    avgCompletedErrands: 0, totalCompletedErrands: 0,
    totalWalletBalance: 0,
  };

  paginatedResponse(
    res,
    {
      summary: {
        totalRunners: agg.totalRunners,
        activeRunners: agg.activeRunners,
        avgRating: parseFloat((agg.avgRating ?? 0).toFixed(2)),
        avgCompletedErrands: parseFloat((agg.avgCompletedErrands ?? 0).toFixed(1)),
        totalCompletedErrands: agg.totalCompletedErrands,
        totalWalletBalance: parseFloat((agg.totalWalletBalance ?? 0).toFixed(2)),
      },
      rows,
    },
    total,
    page,
    limit
  );
};

// ── GET /api/admin/reports/disputes ───────────────────────────────────────────
// Filters: period | dateFrom | dateTo | status | runner | customer
exports.disputesReport = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const {
    status, runner, customer,
    sortBy = 'createdAt', order = 'desc',
  } = req.query;

  const { since, to } = parseDateRange(req.query);
  const dateFilter = buildDateFilter(req.query.dateFrom ?? since, req.query.dateTo ?? to);

  const filter = {};
  if (dateFilter) filter.createdAt = dateFilter;
  if (status) filter.status = status;
  if (runner) filter.runner = runner;
  if (customer) filter.customer = customer;

  const ALLOWED_SORTS = ['createdAt', 'status', 'resolution.resolvedAt'];
  const sortField = ALLOWED_SORTS.includes(sortBy) ? sortBy : 'createdAt';

  const [disputes, total, summary] = await Promise.all([
    Dispute.find(filter)
      .populate('errand', 'title amount status')
      .populate('raisedBy', 'name role')
      .populate('customer', 'name phone')
      .populate('runner', 'name phone rating level')
      .populate('resolution.resolvedBy', 'name')
      .sort({ [sortField]: order === 'asc' ? 1 : -1 })
      .skip(skip)
      .limit(limit)
      .lean(),

    Dispute.countDocuments(filter),

    Dispute.aggregate([
      { $match: filter },
      {
        $facet: {
          overall: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
                resolved: { $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0] } },
                rejected: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
              },
            },
          ],
          byOutcome: [
            { $match: { status: 'resolved' } },
            { $group: { _id: '$resolution.outcome', count: { $sum: 1 } } },
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
                resolutionMs: { $subtract: ['$resolution.resolvedAt', '$createdAt'] },
              },
            },
            { $group: { _id: null, avgMs: { $avg: '$resolutionMs' } } },
          ],
          fundStats: [
            {
              $group: {
                _id: null,
                totalLockedAtDispute: { $sum: '$fundsLockedAtDispute' },
                totalPenalties: { $sum: '$resolution.penaltyAmount' },
                totalRefunds: { $sum: '$resolution.refundAmount' },
              },
            },
          ],
        },
      },
    ]),
  ]);

  const agg = summary[0] ?? {};
  const overall = agg.overall?.[0] ?? { total: 0, pending: 0, resolved: 0, rejected: 0 };
  const byOutcome = Object.fromEntries((agg.byOutcome ?? []).map((o) => [o._id, o.count]));
  const avgMs = agg.avgResolutionTime?.[0]?.avgMs ?? 0;
  const funds = agg.fundStats?.[0] ?? { totalLockedAtDispute: 0, totalPenalties: 0, totalRefunds: 0 };

  paginatedResponse(
    res,
    {
      summary: {
        total: overall.total,
        pending: overall.pending,
        resolved: overall.resolved,
        rejected: overall.rejected,
        resolutionRate:
          overall.total > 0
            ? parseFloat(((overall.resolved / overall.total) * 100).toFixed(1))
            : 0,
        avgResolutionHours: parseFloat((avgMs / 3_600_000).toFixed(1)),
        byOutcome,
        fundStats: {
          totalLockedAtDispute: parseFloat((funds.totalLockedAtDispute ?? 0).toFixed(2)),
          totalPenalties: parseFloat((funds.totalPenalties ?? 0).toFixed(2)),
          totalRefunds: parseFloat((funds.totalRefunds ?? 0).toFixed(2)),
        },
      },
      rows: disputes,
    },
    total,
    page,
    limit
  );
};

// ── GET /api/admin/reports/customers ──────────────────────────────────────────
// Filters: period | dateFrom | dateTo | isActive | search
exports.customersReport = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const { isActive, search, sortBy = 'createdAt', order = 'desc' } = req.query;

  const { since, to } = parseDateRange(req.query);
  const dateFilter = buildDateFilter(req.query.dateFrom ?? since, req.query.dateTo ?? to);

  const filter = { role: 'customer' };
  if (dateFilter) filter.createdAt = dateFilter;
  if (isActive !== undefined) filter.isActive = isActive === 'true';
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
    ];
  }

  const ALLOWED_SORTS = ['createdAt', 'name'];
  const sortField = ALLOWED_SORTS.includes(sortBy) ? sortBy : 'createdAt';

  const [customers, total, aggregateStats] = await Promise.all([
    User.find(filter)
      .select('name phone isActive createdAt')
      .sort({ [sortField]: order === 'asc' ? 1 : -1 })
      .skip(skip)
      .limit(limit)
      .lean(),

    User.countDocuments(filter),

    User.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: ['$isActive', 1, 0] } },
        },
      },
    ]),
  ]);

  // Enrich with errand activity per customer
  const customerIds = customers.map((c) => c._id);
  const errandStats = await Errand.aggregate([
    { $match: { customer: { $in: customerIds } } },
    {
      $group: {
        _id: '$customer',
        totalErrands: { $sum: 1 },
        completedErrands: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        totalSpend: { $sum: '$amount' },
        lastErrandAt: { $max: '$createdAt' },
      },
    },
  ]);

  const errandMap = Object.fromEntries(
    errandStats.map((e) => [e._id.toString(), e])
  );

  const rows = customers.map((c) => {
    const stats = errandMap[c._id.toString()] ?? {
      totalErrands: 0, completedErrands: 0, totalSpend: 0, lastErrandAt: null,
    };
    return {
      ...c,
      errandStats: {
        total: stats.totalErrands,
        completed: stats.completedErrands,
        totalSpend: parseFloat((stats.totalSpend ?? 0).toFixed(2)),
        lastErrandAt: stats.lastErrandAt,
      },
    };
  });

  const agg = aggregateStats[0] ?? { total: 0, active: 0 };

  paginatedResponse(
    res,
    {
      summary: {
        totalCustomers: agg.total,
        activeCustomers: agg.active,
        inactiveCustomers: agg.total - agg.active,
      },
      rows,
    },
    total,
    page,
    limit
  );
};

// ── GET /api/admin/reports/locations ──────────────────────────────────────────
// Filters: period | dateFrom | dateTo | status (ServiceArea status)
// One row per ServiceArea, enriched with errand count/revenue in the period.
exports.locationsReport = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const { status, sortBy = 'name', order = 'asc' } = req.query;

  const { since, to } = parseDateRange(req.query);
  const dateFilter = { createdAt: { $gte: since, $lte: to } };

  const filter = {};
  if (status) filter.status = status;

  const ALLOWED_SORTS = ['name', 'region', 'sortOrder', 'createdAt'];
  const sortField = ALLOWED_SORTS.includes(sortBy) ? sortBy : 'name';

  const [areas, total] = await Promise.all([
    ServiceArea.find(filter)
      .sort({ [sortField]: order === 'asc' ? 1 : -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ServiceArea.countDocuments(filter),
  ]);

  const allAreaNames = (await ServiceArea.find().select('name').lean()).map((a) => a.name);
  const regionExpr = buildRegionExpr(allAreaNames, 'pickup');

  const [regionStats, growth] = await Promise.all([
    Errand.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: regionExpr,
          errandCount: { $sum: 1 },
          revenue: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$amount', 0] } },
        },
      },
    ]),
    Errand.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: { region: regionExpr, month: { $dateToString: { format: '%Y-%m', date: '$createdAt' } } },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const statsMap = Object.fromEntries(regionStats.map((r) => [r._id, r]));
  const growthByRegion = {};
  growth.forEach((g) => {
    const region = g._id.region;
    if (!growthByRegion[region]) growthByRegion[region] = [];
    growthByRegion[region].push({ label: g._id.month, count: g.count });
  });

  const rows = areas.map((a) => {
    const stats = statsMap[a.name] ?? { errandCount: 0, revenue: 0 };
    return {
      ...a,
      errandCount: stats.errandCount,
      revenue: parseFloat((stats.revenue ?? 0).toFixed(2)),
      growthTrend: (growthByRegion[a.name] ?? []).sort((x, y) => x.label.localeCompare(y.label)),
    };
  });

  const summary = {
    totalRegions: total,
    activeRegions: await ServiceArea.countDocuments({ ...filter, status: 'active' }),
    totalErrands: regionStats.reduce((sum, r) => sum + r.errandCount, 0),
    totalRevenue: parseFloat(regionStats.reduce((sum, r) => sum + (r.revenue ?? 0), 0).toFixed(2)),
  };

  paginatedResponse(res, { summary, rows }, total, page, limit);
};

// ── GET /api/admin/reports/verifications ──────────────────────────────────────
// Filters: period | dateFrom | dateTo | status
exports.verificationsReport = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const { status, sortBy = 'submittedAt', order = 'desc' } = req.query;

  const { since, to } = parseDateRange(req.query);
  const dateFilter = { createdAt: { $gte: since, $lte: to } };

  const filter = { ...dateFilter };
  if (status) filter.status = status;

  const ALLOWED_SORTS = ['submittedAt', 'reviewedAt', 'createdAt', 'status'];
  const sortField = ALLOWED_SORTS.includes(sortBy) ? sortBy : 'submittedAt';

  const [verifications, total, summary] = await Promise.all([
    RunnerVerification.find(filter)
      .populate('user', 'name phone level rating')
      .sort({ [sortField]: order === 'asc' ? 1 : -1 })
      .skip(skip)
      .limit(limit)
      .lean(),

    RunnerVerification.countDocuments(filter),

    RunnerVerification.aggregate([
      { $match: filter },
      {
        $facet: {
          byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          avgReviewTime: [
            { $match: { reviewedAt: { $ne: null } } },
            { $project: { reviewMs: { $subtract: ['$reviewedAt', '$submittedAt'] } } },
            { $group: { _id: null, avgMs: { $avg: '$reviewMs' } } },
          ],
        },
      },
    ]),
  ]);

  const agg = summary[0] ?? {};
  const byStatus = Object.fromEntries((agg.byStatus ?? []).map((s) => [s._id, s.count]));
  const avgMs = agg.avgReviewTime?.[0]?.avgMs ?? 0;

  paginatedResponse(
    res,
    {
      summary: {
        total,
        pending: byStatus.pending ?? 0,
        approved: byStatus.approved ?? 0,
        rejected: byStatus.rejected ?? 0,
        resubmissionRequested: byStatus.resubmission_requested ?? 0,
        avgReviewHours: parseFloat((avgMs / 3_600_000).toFixed(1)),
      },
      rows: verifications,
    },
    total,
    page,
    limit
  );
};
