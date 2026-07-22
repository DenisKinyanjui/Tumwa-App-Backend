const AuditLog = require('../models/AuditLog');

const paginate = (query) => {
  const page = Math.max(parseInt(query.page) || 1, 1);
  const limit = Math.min(parseInt(query.limit) || 25, 200);
  return { page, limit, skip: (page - 1) * limit };
};

const buildDateFilter = (dateFrom, dateTo) => {
  if (!dateFrom && !dateTo) return null;
  const f = {};
  if (dateFrom) f.$gte = new Date(dateFrom);
  if (dateTo) f.$lte = new Date(dateTo);
  return f;
};

const buildFilter = (query) => {
  const { module, action, severity, adminId, status, search, dateFrom, dateTo } = query;

  const filter = {};
  if (module) filter.module = module;
  if (action) filter.action = action;
  if (severity) filter.severity = severity;
  if (status) filter.status = status;
  if (adminId) filter['actor.id'] = adminId;

  const dateFilter = buildDateFilter(dateFrom, dateTo);
  if (dateFilter) filter.createdAt = dateFilter;

  if (search) {
    const rx = { $regex: search, $options: 'i' };
    filter.$or = [
      { 'actor.name': rx },
      { 'actor.email': rx },
      { 'target.label': rx },
      { requestId: rx },
      { action: rx },
      { module: rx },
      { reason: rx },
    ];
  }

  return filter;
};

// GET /api/admin/audit-logs
exports.list = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const filter = buildFilter(req.query);

  const [logs, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(filter),
  ]);

  res.status(200).json({
    status: 'success',
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    data: { logs },
  });
};

// GET /api/admin/audit-logs/:id
exports.getById = async (req, res) => {
  const log = await AuditLog.findById(req.params.id).lean();
  if (!log) return res.status(404).json({ status: 'fail', message: 'Audit log entry not found' });
  res.status(200).json({ status: 'success', data: { log } });
};

// GET /api/admin/audit-logs/stats
// Query: dateFrom | dateTo (optional — scopes everything except "Events Today")
exports.stats = async (req, res) => {
  const filter = buildFilter(req.query);
  delete filter.$or; // KPI counts, not a search — search only applies to the list/table

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [total, eventsToday, highRisk, failed, mostActive] = await Promise.all([
    AuditLog.countDocuments(filter),
    AuditLog.countDocuments({ ...filter, createdAt: { ...(filter.createdAt || {}), $gte: startOfToday } }),
    AuditLog.countDocuments({ ...filter, severity: { $in: ['High', 'Critical'] } }),
    AuditLog.countDocuments({ ...filter, status: 'failed' }),
    AuditLog.aggregate([
      { $match: filter },
      { $group: { _id: '$actor.id', name: { $first: '$actor.name' }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 },
    ]),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      totalEvents: total,
      eventsToday,
      highRiskEvents: highRisk,
      failedActions: failed,
      mostActiveAdmin: mostActive[0] ? { id: mostActive[0]._id, name: mostActive[0].name, count: mostActive[0].count } : null,
    },
  });
};

// GET /api/admin/audit-logs/security-insights
// Lightweight, on-demand anomaly scan — not a stored/cached model, since the
// underlying AuditLog collection is small enough to aggregate per-request and
// "insights" should always reflect current data, not a stale snapshot.
exports.securityInsights = async (_req, res) => {
  const day = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const month = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [failedLogins, suspensions, commissionChanges, refunds, verificationApprovals] = await Promise.all([
    AuditLog.aggregate([
      { $match: { action: 'Login', status: 'failed', createdAt: { $gte: day } } },
      { $group: { _id: '$actor.id', name: { $first: '$actor.name' }, count: { $sum: 1 } } },
      { $match: { count: { $gte: 3 } } },
      { $sort: { count: -1 } },
    ]),
    AuditLog.countDocuments({ action: 'Suspended', createdAt: { $gte: week } }),
    AuditLog.find({ module: 'Settings', action: 'Settings Changed', reason: { $regex: 'commission', $options: 'i' }, createdAt: { $gte: month } })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('actor.name createdAt changes')
      .lean(),
    AuditLog.aggregate([
      { $match: { action: 'Refunded', createdAt: { $gte: week } } },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$changes.after.amount' } } },
    ]),
    AuditLog.countDocuments({ module: 'Verification', action: 'Approved', createdAt: { $gte: day } }),
  ]);

  const insights = [];

  failedLogins.forEach((f) => {
    insights.push({
      id: `failed-login-${f._id}`,
      severity: 'high',
      title: 'Multiple failed admin login attempts',
      description: `${f.name} had ${f.count} failed login attempts in the last 24 hours.`,
    });
  });

  if (suspensions >= 5) {
    insights.push({
      id: 'runner-suspensions',
      severity: 'medium',
      title: 'High number of runner suspensions',
      description: `${suspensions} accounts were suspended in the last 7 days.`,
    });
  }

  commissionChanges.forEach((c, i) => {
    insights.push({
      id: `commission-change-${i}`,
      severity: 'high',
      title: 'Commission settings changed',
      description: `${c.actor.name} changed platform commission settings on ${new Date(c.createdAt).toLocaleString('en-KE')}.`,
    });
  });

  const refundStats = refunds[0];
  if (refundStats?.count >= 3 && refundStats.total >= 5000) {
    insights.push({
      id: 'large-refunds',
      severity: 'medium',
      title: 'Large refund activity',
      description: `KES ${refundStats.total.toLocaleString()} refunded across ${refundStats.count} actions in the last 7 days.`,
    });
  }

  if (verificationApprovals >= 10) {
    insights.push({
      id: 'verification-volume',
      severity: 'low',
      title: 'High volume of verification approvals',
      description: `${verificationApprovals} runner verifications were approved in the last 24 hours.`,
    });
  }

  res.status(200).json({ status: 'success', data: { insights } });
};

// GET /api/admin/audit-logs/options
// Static filter option lists — kept server-side so the frontend enum always
// matches AuditLog's actual schema enums instead of a hand-copied duplicate.
exports.options = async (_req, res) => {
  res.status(200).json({
    status: 'success',
    data: {
      modules: AuditLog.MODULES,
      actions: AuditLog.ACTIONS,
      severities: AuditLog.SEVERITIES,
    },
  });
};
