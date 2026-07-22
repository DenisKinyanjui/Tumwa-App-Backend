const Report = require('../models/Report');
const r2Service = require('../services/r2Service');
const { generateReport } = require('../services/reportGenerationService');

const paginate = (query) => {
  const page = Math.max(parseInt(query.page) || 1, 1);
  const limit = Math.min(parseInt(query.limit) || 20, 100);
  return { page, limit, skip: (page - 1) * limit };
};

// ── GET /api/admin/reports/generated ──────────────────────────────────────────
// Query: type | status | page | limit
exports.list = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const { type, status } = req.query;

  const filter = {};
  if (type) filter.type = type;
  if (status) filter.status = status;

  const [reports, total] = await Promise.all([
    Report.find(filter)
      .populate('generatedBy', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Report.countDocuments(filter),
  ]);

  res.status(200).json({
    status: 'success',
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    data: { reports },
  });
};

// ── POST /api/admin/reports/generated ─────────────────────────────────────────
// Body: { type, format, filters }
exports.generate = async (req, res) => {
  const { type, format, filters = {} } = req.body;

  if (!type || !format) {
    return res.status(400).json({ status: 'fail', message: 'type and format are required' });
  }

  try {
    const report = await generateReport({ type, format, filters, generatedBy: req.user._id });
    res.status(201).json({ status: 'success', data: { report } });
  } catch (err) {
    res.status(400).json({ status: 'fail', message: err.message });
  }
};

// ── GET /api/admin/reports/generated/:id/download ─────────────────────────────
exports.download = async (req, res) => {
  const report = await Report.findById(req.params.id).lean();
  if (!report) return res.status(404).json({ status: 'fail', message: 'Report not found' });
  if (report.status !== 'completed' || !report.filePath) {
    return res.status(400).json({ status: 'fail', message: `Report is ${report.status}, not ready for download` });
  }

  const url = await r2Service.getSignedDownloadUrl(report.filePath);
  res.status(200).json({ status: 'success', data: { url } });
};

// ── DELETE /api/admin/reports/generated/:id ───────────────────────────────────
exports.remove = async (req, res) => {
  const report = await Report.findById(req.params.id);
  if (!report) return res.status(404).json({ status: 'fail', message: 'Report not found' });

  if (report.filePath) {
    await r2Service.deleteFile(report.filePath);
  }
  await report.deleteOne();

  res.status(200).json({ status: 'success', message: 'Report deleted' });
};
