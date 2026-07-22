const {
  parseDateRange,
  getOverview,
  getErrandAnalytics,
  getPaymentAnalytics,
  getRunnerAnalytics,
  getCustomerAnalytics,
  getDisputeAnalytics,
} = require('../services/analyticsService');

const VALID_PERIODS = ['day', 'week', 'month', 'quarter', 'year'];

const validatePeriod = (period) =>
  period && !VALID_PERIODS.includes(period)
    ? `period must be one of: ${VALID_PERIODS.join(', ')}`
    : null;

// ── GET /api/admin/analytics/overview ────────────────────────────────────────
// Returns summary KPIs across all domains for the dashboard.
// Query: period | dateFrom + dateTo
exports.overview = async (req, res) => {
  const periodErr = validatePeriod(req.query.period);
  if (periodErr) return res.status(400).json({ status: 'fail', message: periodErr });

  const { since, to } = parseDateRange(req.query);
  const data = await getOverview(since, to);

  res.status(200).json({ status: 'success', data });
};

// ── GET /api/admin/analytics/errands ─────────────────────────────────────────
// Returns errand trend charts + summary.
// Query: period | dateFrom + dateTo | status | runner | amountMin | amountMax
exports.errands = async (req, res) => {
  const periodErr = validatePeriod(req.query.period);
  if (periodErr) return res.status(400).json({ status: 'fail', message: periodErr });

  const { since, to, bucketFormat } = parseDateRange(req.query);

  const filters = {};
  const VALID_STATUSES = ['pending', 'assigned', 'in_progress', 'completed', 'cancelled', 'disputed'];
  if (req.query.status) {
    if (!VALID_STATUSES.includes(req.query.status)) {
      return res.status(400).json({
        status: 'fail',
        message: `status must be one of: ${VALID_STATUSES.join(', ')}`,
      });
    }
    filters.status = req.query.status;
  }
  if (req.query.runner) filters.runner = req.query.runner;
  if (req.query.locationField) {
    if (!['pickup', 'delivery'].includes(req.query.locationField)) {
      return res.status(400).json({ status: 'fail', message: 'locationField must be one of: pickup, delivery' });
    }
    filters.locationField = req.query.locationField;
  }
  if (req.query.amountMin) {
    const n = parseFloat(req.query.amountMin);
    if (isNaN(n)) return res.status(400).json({ status: 'fail', message: 'amountMin must be a number' });
    filters.amountMin = n;
  }
  if (req.query.amountMax) {
    const n = parseFloat(req.query.amountMax);
    if (isNaN(n)) return res.status(400).json({ status: 'fail', message: 'amountMax must be a number' });
    filters.amountMax = n;
  }

  const data = await getErrandAnalytics(since, to, bucketFormat, filters);
  res.status(200).json({ status: 'success', data });
};

// ── GET /api/admin/analytics/payments ────────────────────────────────────────
// Returns payment/revenue charts + summary.
// Query: period | dateFrom + dateTo | type (errand_payment | withdrawal)
exports.payments = async (req, res) => {
  const periodErr = validatePeriod(req.query.period);
  if (periodErr) return res.status(400).json({ status: 'fail', message: periodErr });

  const { since, to, bucketFormat } = parseDateRange(req.query);

  const filters = {};
  if (req.query.type) {
    if (!['errand_payment', 'withdrawal'].includes(req.query.type)) {
      return res.status(400).json({
        status: 'fail',
        message: 'type must be errand_payment or withdrawal',
      });
    }
    filters.type = req.query.type;
  }

  const data = await getPaymentAnalytics(since, to, bucketFormat, filters);
  res.status(200).json({ status: 'success', data });
};

// ── GET /api/admin/analytics/runners ─────────────────────────────────────────
// Returns runner performance metrics + charts.
// Query: period | dateFrom + dateTo | runner (ObjectId — triggers deep-dive)
exports.runners = async (req, res) => {
  const periodErr = validatePeriod(req.query.period);
  if (periodErr) return res.status(400).json({ status: 'fail', message: periodErr });

  const { since, to } = parseDateRange(req.query);

  const filters = {};
  if (req.query.runner) filters.runner = req.query.runner;

  const data = await getRunnerAnalytics(since, to, filters);
  res.status(200).json({ status: 'success', data });
};

// ── GET /api/admin/analytics/customers ───────────────────────────────────────
// Returns customer activity analytics.
// Query: period | dateFrom + dateTo
exports.customers = async (req, res) => {
  const periodErr = validatePeriod(req.query.period);
  if (periodErr) return res.status(400).json({ status: 'fail', message: periodErr });

  const { since, to, bucketFormat } = parseDateRange(req.query);
  const data = await getCustomerAnalytics(since, to, bucketFormat);
  res.status(200).json({ status: 'success', data });
};

// ── GET /api/admin/analytics/disputes ────────────────────────────────────────
// Returns dispute analytics.
// Query: period | dateFrom + dateTo
exports.disputes = async (req, res) => {
  const periodErr = validatePeriod(req.query.period);
  if (periodErr) return res.status(400).json({ status: 'fail', message: periodErr });

  const { since, to, bucketFormat } = parseDateRange(req.query);
  const data = await getDisputeAnalytics(since, to, bucketFormat);
  res.status(200).json({ status: 'success', data });
};
