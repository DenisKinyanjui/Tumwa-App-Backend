const Errand = require('../models/Errand');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Dispute = require('../models/Dispute');
const RunnerVerification = require('../models/RunnerVerification');
const ServiceArea = require('../models/ServiceArea');
const { parseDateRange, buildRegionExpr } = require('./analyticsService');

// Generated files are capped at this many data rows — the row-level tables
// are meant for audit/record-keeping, not for dumping the entire collection.
// Admins needing more should narrow the date range/filters.
const MAX_ROWS = 5000;

const buildDateFilter = (dateFrom, dateTo) => {
  if (!dateFrom && !dateTo) return null;
  const f = {};
  if (dateFrom) f.$gte = new Date(dateFrom);
  if (dateTo) f.$lte = new Date(dateTo);
  return f;
};

// ── Revenue / Finance (both slice Payment; finance includes all types) ────────
const getFinanceData = async (filters, { revenueOnly }) => {
  const { since, to } = parseDateRange(filters);
  const dateFilter = buildDateFilter(filters.dateFrom ?? since, filters.dateTo ?? to);

  const baseFilter = dateFilter ? { createdAt: dateFilter } : {};
  const revenueFilter = revenueOnly ? { ...baseFilter, type: 'errand_payment' } : baseFilter;

  const [rows, totals, commission] = await Promise.all([
    Payment.find(revenueFilter)
      .populate('customer', 'name phone')
      .populate('runner', 'name phone')
      .populate('errand', 'title amount')
      .sort({ createdAt: -1 })
      .limit(MAX_ROWS)
      .lean(),

    Payment.aggregate([
      { $match: baseFilter },
      {
        $facet: {
          revenue: [{ $match: { type: 'errand_payment', status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }],
          refunds: [{ $match: { type: 'dispute_refund', status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }],
          withdrawals: [{ $match: { type: 'withdrawal', status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }],
        },
      },
    ]),

    Errand.aggregate([
      { $match: dateFilter ? { createdAt: dateFilter, status: 'completed' } : { status: 'completed' } },
      { $group: { _id: null, commission: { $sum: '$platformEarns' } } },
    ]),

    // Escrow — funds paid but not yet released/refunded (point-in-time, not period-scoped)
  ]);

  const escrow = await Errand.aggregate([
    { $match: { isPaid: true, status: { $in: ['assigned', 'in_progress', 'completed'] } } },
    { $group: { _id: null, total: { $sum: '$trustHeld' } } },
  ]);

  const t = totals[0] ?? {};
  return {
    summary: {
      revenue: parseFloat((t.revenue?.[0]?.total ?? 0).toFixed(2)),
      commission: parseFloat((commission[0]?.commission ?? 0).toFixed(2)),
      escrow: parseFloat((escrow[0]?.total ?? 0).toFixed(2)),
      refunds: parseFloat((t.refunds?.[0]?.total ?? 0).toFixed(2)),
      withdrawals: parseFloat((t.withdrawals?.[0]?.total ?? 0).toFixed(2)),
    },
    rows: rows.map((p) => ({
      date: p.createdAt,
      type: p.type,
      status: p.status,
      amount: p.amount,
      customer: p.customer?.name ?? '',
      runner: p.runner?.name ?? '',
      errand: p.errand?.title ?? '',
      mpesaReceipt: p.mpesa?.receiptNumber ?? '',
    })),
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'type', label: 'Type' },
      { key: 'status', label: 'Status' },
      { key: 'amount', label: 'Amount (KES)' },
      { key: 'customer', label: 'Customer' },
      { key: 'runner', label: 'Runner' },
      { key: 'errand', label: 'Errand' },
      { key: 'mpesaReceipt', label: 'M-Pesa Receipt' },
    ],
  };
};

// ── Transactions (all payment types, unfiltered by type) ───────────────────────
const getTransactionsData = async (filters) => getFinanceData(filters, { revenueOnly: false });
const getRevenueData = async (filters) => getFinanceData(filters, { revenueOnly: true });

// ── Withdrawals ────────────────────────────────────────────────────────────────
const getWithdrawalsData = async (filters) => {
  const { since, to } = parseDateRange(filters);
  const dateFilter = buildDateFilter(filters.dateFrom ?? since, filters.dateTo ?? to);

  const filter = { type: 'withdrawal' };
  if (dateFilter) filter.createdAt = dateFilter;
  if (filters.status) filter.status = filters.status;

  const [rows, summary] = await Promise.all([
    Payment.find(filter)
      .populate('runner', 'name phone')
      .sort({ createdAt: -1 })
      .limit(MAX_ROWS)
      .lean(),
    Payment.aggregate([
      { $match: filter },
      {
        $facet: {
          completed: [{ $match: { status: 'completed' } }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } }],
          pending: [{ $match: { status: 'pending' } }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } }],
          failed: [{ $match: { status: 'failed' } }, { $count: 'count' }],
        },
      },
    ]),
  ]);

  const agg = summary[0] ?? {};
  return {
    summary: {
      completedCount: agg.completed?.[0]?.count ?? 0,
      completedTotal: parseFloat((agg.completed?.[0]?.total ?? 0).toFixed(2)),
      pendingCount: agg.pending?.[0]?.count ?? 0,
      pendingTotal: parseFloat((agg.pending?.[0]?.total ?? 0).toFixed(2)),
      failedCount: agg.failed?.[0]?.count ?? 0,
    },
    rows: rows.map((p) => ({
      date: p.createdAt,
      runner: p.runner?.name ?? '',
      phone: p.phoneNumber,
      amount: p.amount,
      status: p.status,
      completedAt: p.completedAt ?? '',
      mpesaReceipt: p.mpesa?.receiptNumber ?? '',
    })),
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'runner', label: 'Runner' },
      { key: 'phone', label: 'Phone' },
      { key: 'amount', label: 'Amount (KES)' },
      { key: 'status', label: 'Status' },
      { key: 'completedAt', label: 'Completed At' },
      { key: 'mpesaReceipt', label: 'M-Pesa Receipt' },
    ],
  };
};

// ── Customer Activity ─────────────────────────────────────────────────────────
const getCustomerActivityData = async (filters) => {
  const { since, to } = parseDateRange(filters);
  const dateFilter = buildDateFilter(filters.dateFrom ?? since, filters.dateTo ?? to);

  const filter = { role: 'customer' };
  if (dateFilter) filter.createdAt = dateFilter;

  const customers = await User.find(filter)
    .select('name phone isActive createdAt')
    .sort({ createdAt: -1 })
    .limit(MAX_ROWS)
    .lean();

  const customerIds = customers.map((c) => c._id);
  const errandStats = await Errand.aggregate([
    { $match: { customer: { $in: customerIds } } },
    {
      $group: {
        _id: '$customer',
        totalErrands: { $sum: 1 },
        completedErrands: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        totalSpend: { $sum: '$amount' },
      },
    },
  ]);
  const statsMap = Object.fromEntries(errandStats.map((e) => [e._id.toString(), e]));

  const rows = customers.map((c) => {
    const s = statsMap[c._id.toString()] ?? { totalErrands: 0, completedErrands: 0, totalSpend: 0 };
    return {
      name: c.name,
      phone: c.phone,
      joined: c.createdAt,
      isReturning: s.totalErrands > 1,
      totalErrands: s.totalErrands,
      completedErrands: s.completedErrands,
      totalSpend: parseFloat((s.totalSpend ?? 0).toFixed(2)),
    };
  });

  return {
    summary: {
      newCustomers: customers.length,
      returningCustomers: rows.filter((r) => r.isReturning).length,
      totalSpend: parseFloat(rows.reduce((sum, r) => sum + r.totalSpend, 0).toFixed(2)),
      completedErrands: rows.reduce((sum, r) => sum + r.completedErrands, 0),
    },
    rows,
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'phone', label: 'Phone' },
      { key: 'joined', label: 'Joined' },
      { key: 'isReturning', label: 'Returning' },
      { key: 'totalErrands', label: 'Total Errands' },
      { key: 'completedErrands', label: 'Completed Errands' },
      { key: 'totalSpend', label: 'Total Spend (KES)' },
    ],
  };
};

// ── Runner Performance ─────────────────────────────────────────────────────────
const getRunnerPerformanceData = async (filters) => {
  const filter = { role: 'runner' };
  if (filters.status !== undefined) filter.isActive = filters.status === 'active';

  const runners = await User.find(filter)
    .select('name phone level rating completedErrands disputesAgainst wallet workingCapital createdAt')
    .sort({ completedErrands: -1 })
    .limit(MAX_ROWS)
    .lean();

  const rows = runners.map((r) => {
    const totalAttempts = r.completedErrands + r.disputesAgainst;
    return {
      name: r.name,
      phone: r.phone,
      level: r.level,
      rating: r.rating,
      completionRate: r.completedErrands > 0 ? 100 : 0,
      cancellationRate:
        totalAttempts > 0 ? parseFloat(((r.disputesAgainst / totalAttempts) * 100).toFixed(1)) : 0,
      workingCapitalLimit: r.workingCapital?.limit ?? 0,
      earnings: r.wallet?.earnings ?? 0,
    };
  });

  return {
    summary: {
      totalRunners: rows.length,
      avgRating: parseFloat((rows.reduce((sum, r) => sum + r.rating, 0) / (rows.length || 1)).toFixed(2)),
      totalEarnings: parseFloat(rows.reduce((sum, r) => sum + r.earnings, 0).toFixed(2)),
    },
    rows,
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'phone', label: 'Phone' },
      { key: 'level', label: 'Level' },
      { key: 'rating', label: 'Rating' },
      { key: 'completionRate', label: 'Completion Rate (%)' },
      { key: 'cancellationRate', label: 'Cancellation Rate (%)' },
      { key: 'workingCapitalLimit', label: 'Working Capital Limit (KES)' },
      { key: 'earnings', label: 'Earnings (KES)' },
    ],
  };
};

// ── Errands ────────────────────────────────────────────────────────────────────
const getErrandsData = async (filters) => {
  const { since, to } = parseDateRange(filters);
  const dateFilter = buildDateFilter(filters.dateFrom ?? since, filters.dateTo ?? to);

  const filter = {};
  if (dateFilter) filter.createdAt = dateFilter;
  if (filters.status) filter.status = filters.status;
  if (filters.runner) filter.runner = filters.runner;
  if (filters.customer) filter.customer = filters.customer;

  const [rows, summary] = await Promise.all([
    Errand.find(filter)
      .populate('customer', 'name')
      .populate('runner', 'name')
      .sort({ createdAt: -1 })
      .limit(MAX_ROWS)
      .lean(),

    Errand.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          created: { $sum: 1 },
          assigned: { $sum: { $cond: [{ $in: ['$status', ['assigned', 'in_progress', 'completed', 'confirmed']] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $in: ['$status', ['completed', 'confirmed']] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
          avgCompletionMs: {
            $avg: {
              $cond: [
                { $and: [{ $ne: ['$completedAt', null] }, { $ne: ['$assignedAt', null] }] },
                { $subtract: ['$completedAt', '$assignedAt'] },
                null,
              ],
            },
          },
        },
      },
    ]),
  ]);

  const s = summary[0] ?? { created: 0, assigned: 0, completed: 0, cancelled: 0, avgCompletionMs: 0 };

  return {
    summary: {
      created: s.created,
      assigned: s.assigned,
      completed: s.completed,
      cancelled: s.cancelled,
      avgCompletionHours: parseFloat(((s.avgCompletionMs ?? 0) / 3_600_000).toFixed(1)),
    },
    rows: rows.map((e) => ({
      title: e.title,
      customer: e.customer?.name ?? '',
      runner: e.runner?.name ?? '',
      amount: e.amount,
      status: e.status,
      createdAt: e.createdAt,
      completedAt: e.completedAt ?? '',
    })),
    columns: [
      { key: 'title', label: 'Errand' },
      { key: 'customer', label: 'Customer' },
      { key: 'runner', label: 'Runner' },
      { key: 'amount', label: 'Amount (KES)' },
      { key: 'status', label: 'Status' },
      { key: 'createdAt', label: 'Created' },
      { key: 'completedAt', label: 'Completed' },
    ],
  };
};

// ── Verification ───────────────────────────────────────────────────────────────
const getVerificationData = async (filters) => {
  const { since, to } = parseDateRange(filters);
  const dateFilter = buildDateFilter(filters.dateFrom ?? since, filters.dateTo ?? to);

  const filter = {};
  if (dateFilter) filter.createdAt = dateFilter;
  if (filters.status) filter.status = filters.status;

  const [rows, byStatus, avgReview] = await Promise.all([
    RunnerVerification.find(filter)
      .populate('user', 'name phone')
      .sort({ submittedAt: -1 })
      .limit(MAX_ROWS)
      .lean(),
    RunnerVerification.aggregate([{ $match: filter }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    RunnerVerification.aggregate([
      { $match: { ...filter, reviewedAt: { $ne: null } } },
      { $project: { reviewMs: { $subtract: ['$reviewedAt', '$submittedAt'] } } },
      { $group: { _id: null, avgMs: { $avg: '$reviewMs' } } },
    ]),
  ]);

  const statusMap = Object.fromEntries(byStatus.map((s) => [s._id, s.count]));

  return {
    summary: {
      pending: statusMap.pending ?? 0,
      approved: statusMap.approved ?? 0,
      rejected: statusMap.rejected ?? 0,
      avgReviewHours: parseFloat(((avgReview[0]?.avgMs ?? 0) / 3_600_000).toFixed(1)),
    },
    rows: rows.map((v) => ({
      runner: v.user?.name ?? '',
      phone: v.user?.phone ?? '',
      status: v.status,
      submittedAt: v.submittedAt,
      reviewedAt: v.reviewedAt ?? '',
      reviewedBy: v.reviewedBy?.name ?? '',
    })),
    columns: [
      { key: 'runner', label: 'Runner' },
      { key: 'phone', label: 'Phone' },
      { key: 'status', label: 'Status' },
      { key: 'submittedAt', label: 'Submitted' },
      { key: 'reviewedAt', label: 'Reviewed' },
      { key: 'reviewedBy', label: 'Reviewed By' },
    ],
  };
};

// ── Disputes ───────────────────────────────────────────────────────────────────
const getDisputesData = async (filters) => {
  const { since, to } = parseDateRange(filters);
  const dateFilter = buildDateFilter(filters.dateFrom ?? since, filters.dateTo ?? to);

  const filter = {};
  if (dateFilter) filter.createdAt = dateFilter;
  if (filters.status) filter.status = filters.status;

  const [rows, summary] = await Promise.all([
    Dispute.find(filter)
      .populate('errand', 'title amount')
      .populate('customer', 'name')
      .populate('runner', 'name')
      .sort({ createdAt: -1 })
      .limit(MAX_ROWS)
      .lean(),

    Dispute.aggregate([
      { $match: filter },
      {
        $facet: {
          overall: [
            {
              $group: {
                _id: null,
                open: { $sum: { $cond: [{ $in: ['$status', ['pending', 'under_review']] }, 1, 0] } },
                resolved: { $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0] } },
                totalRefunds: { $sum: '$resolution.refundAmount' },
              },
            },
          ],
          avgResolutionTime: [
            { $match: { 'resolution.resolvedAt': { $ne: null } } },
            { $project: { ms: { $subtract: ['$resolution.resolvedAt', '$createdAt'] } } },
            { $group: { _id: null, avgMs: { $avg: '$ms' } } },
          ],
        },
      },
    ]),
  ]);

  const agg = summary[0] ?? {};
  const overall = agg.overall?.[0] ?? { open: 0, resolved: 0, totalRefunds: 0 };
  const avgMs = agg.avgResolutionTime?.[0]?.avgMs ?? 0;

  return {
    summary: {
      open: overall.open,
      resolved: overall.resolved,
      refundAmounts: parseFloat((overall.totalRefunds ?? 0).toFixed(2)),
      avgResolutionHours: parseFloat((avgMs / 3_600_000).toFixed(1)),
    },
    rows: rows.map((d) => ({
      errand: d.errand?.title ?? '',
      customer: d.customer?.name ?? '',
      runner: d.runner?.name ?? '',
      reason: d.reason,
      status: d.status,
      refundAmount: d.resolution?.refundAmount ?? 0,
      createdAt: d.createdAt,
      resolvedAt: d.resolution?.resolvedAt ?? '',
    })),
    columns: [
      { key: 'errand', label: 'Errand' },
      { key: 'customer', label: 'Customer' },
      { key: 'runner', label: 'Runner' },
      { key: 'reason', label: 'Reason' },
      { key: 'status', label: 'Status' },
      { key: 'refundAmount', label: 'Refund Amount (KES)' },
      { key: 'createdAt', label: 'Opened' },
      { key: 'resolvedAt', label: 'Resolved' },
    ],
  };
};

// ── Locations ──────────────────────────────────────────────────────────────────
const getLocationsData = async (filters) => {
  const { since, to } = parseDateRange(filters);
  const dateFilter = { createdAt: { $gte: since, $lte: to } };

  const areas = await ServiceArea.find(filters.status ? { status: filters.status } : {})
    .sort({ name: 1 })
    .limit(MAX_ROWS)
    .lean();

  const allAreaNames = areas.map((a) => a.name);
  const regionExpr = buildRegionExpr(allAreaNames, 'pickup');

  const regionStats = await Errand.aggregate([
    { $match: dateFilter },
    {
      $group: {
        _id: regionExpr,
        errandCount: { $sum: 1 },
        revenue: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$amount', 0] } },
      },
    },
  ]);
  const statsMap = Object.fromEntries(regionStats.map((r) => [r._id, r]));

  const rows = areas.map((a) => {
    const s = statsMap[a.name] ?? { errandCount: 0, revenue: 0 };
    return {
      name: a.name,
      region: a.region,
      status: a.status,
      errandCount: s.errandCount,
      revenue: parseFloat((s.revenue ?? 0).toFixed(2)),
    };
  });

  return {
    summary: {
      totalRegions: rows.length,
      activeRegions: rows.filter((r) => r.status === 'active').length,
      totalErrands: rows.reduce((sum, r) => sum + r.errandCount, 0),
      totalRevenue: parseFloat(rows.reduce((sum, r) => sum + r.revenue, 0).toFixed(2)),
    },
    rows,
    columns: [
      { key: 'name', label: 'Region' },
      { key: 'region', label: 'County' },
      { key: 'status', label: 'Status' },
      { key: 'errandCount', label: 'Errands' },
      { key: 'revenue', label: 'Revenue (KES)' },
    ],
  };
};

const HANDLERS = {
  revenue: getRevenueData,
  finance: getTransactionsData,
  transactions: getTransactionsData,
  customer_activity: getCustomerActivityData,
  runner_performance: getRunnerPerformanceData,
  errands: getErrandsData,
  verification: getVerificationData,
  withdrawals: getWithdrawalsData,
  disputes: getDisputesData,
  locations: getLocationsData,
};

/**
 * Dispatch to the data-fetch for a report type.
 * @returns {Promise<{ summary: object, rows: object[], columns: {key,label}[] }>}
 */
exports.getReportData = async (type, filters = {}) => {
  const handler = HANDLERS[type];
  if (!handler) throw new Error(`Unsupported report type: ${type}`);
  return handler(filters);
};

exports.MAX_ROWS = MAX_ROWS;
