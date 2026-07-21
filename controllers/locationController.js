const ServiceArea = require('../models/ServiceArea');
const Errand = require('../models/Errand');
const logger = require('../utils/logger');
const { escapeRegex } = require('../utils/regex');
const { buildRegionExpr } = require('../services/analyticsService');

const VALID_STATUSES = ['active', 'inactive', 'retired'];

// GET /api/locations
// Public — called during runner onboarding (before login) to populate the
// "areas of operation" picker. Only active areas, cheapest-first sort.
exports.getActiveAreas = async (req, res) => {
  const areas = await ServiceArea.find({ status: 'active' })
    .sort({ sortOrder: 1, name: 1 })
    .select('name')
    .lean();

  res.status(200).json({ status: 'success', data: { areas: areas.map((a) => a.name) } });
};

// GET /api/admin/locations
// Includes a rolling 7-day errand count per zone (same address→region
// bucketing as the analytics topLocations chart), so the admin table can
// show demand alongside each zone without a separate round trip.
exports.adminList = async (req, res) => {
  const areas = await ServiceArea.find().sort({ sortOrder: 1, name: 1 }).lean();
  const areaNames = areas.map((a) => a.name);

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const counts = await Errand.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $group: { _id: buildRegionExpr(areaNames), count: { $sum: 1 } } },
  ]);
  const countByName = Object.fromEntries(counts.map((c) => [c._id, c.count]));

  const areasWithCounts = areas.map((a) => ({ ...a, errandCount7d: countByName[a.name] ?? 0 }));

  res.status(200).json({ status: 'success', data: { areas: areasWithCounts } });
};

// POST /api/admin/locations
exports.adminCreate = async (req, res) => {
  const name = req.body.name?.trim();
  if (!name) {
    return res.status(422).json({ status: 'fail', message: 'Area name is required' });
  }

  const existing = await ServiceArea.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i') });
  if (existing) {
    return res.status(409).json({ status: 'fail', message: 'That area already exists' });
  }

  const region = req.body.region?.trim() || '';
  const sortOrder = req.body.sortOrder !== undefined ? Number(req.body.sortOrder) : (await ServiceArea.countDocuments());
  const area = await ServiceArea.create({ name, region, sortOrder });

  logger.info('Service area created', { areaId: area._id, name, adminId: req.user._id });
  res.status(201).json({ status: 'success', data: { area } });
};

// PATCH /api/admin/locations/:id
exports.adminUpdate = async (req, res) => {
  const patch = {};
  if (req.body.name !== undefined) {
    const name = req.body.name?.trim();
    if (!name) return res.status(422).json({ status: 'fail', message: 'Area name cannot be empty' });

    const existing = await ServiceArea.findOne({
      _id: { $ne: req.params.id },
      name: new RegExp(`^${escapeRegex(name)}$`, 'i'),
    });
    if (existing) return res.status(409).json({ status: 'fail', message: 'That area already exists' });

    patch.name = name;
  }
  if (req.body.region !== undefined) patch.region = req.body.region?.trim() || '';
  if (req.body.status !== undefined) {
    if (!VALID_STATUSES.includes(req.body.status)) {
      return res.status(422).json({ status: 'fail', message: 'Invalid zone status' });
    }
    patch.status = req.body.status;
  }
  if (req.body.sortOrder !== undefined) patch.sortOrder = Number(req.body.sortOrder);

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ status: 'fail', message: 'No valid fields to update' });
  }

  // Any admin edit counts as the zone having been reviewed.
  patch.autoDetected = false;

  const area = await ServiceArea.findByIdAndUpdate(req.params.id, patch, {
    new: true,
    runValidators: true,
  });
  if (!area) return res.status(404).json({ status: 'fail', message: 'Area not found' });

  logger.info('Service area updated', { areaId: area._id, patch, adminId: req.user._id });
  res.status(200).json({ status: 'success', data: { area } });
};

// DELETE /api/admin/locations/:id
exports.adminDelete = async (req, res) => {
  const area = await ServiceArea.findByIdAndDelete(req.params.id);
  if (!area) return res.status(404).json({ status: 'fail', message: 'Area not found' });

  logger.info('Service area deleted', { areaId: area._id, name: area.name, adminId: req.user._id });
  res.status(200).json({ status: 'success', data: null });
};
