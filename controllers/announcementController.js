const multer = require('multer');
const Announcement = require('../models/Announcement');
const AnnouncementView = require('../models/AnnouncementView');
const r2Service = require('../services/r2Service');
const logger = require('../utils/logger');
const { getAnalytics, maybeNotifyActivation } = require('../services/announcementService');

// ── Pagination helper (mirrors adminController's / notificationCampaignController's) ──
const paginate = (query) => {
  const page = Math.max(parseInt(query.page) || 1, 1);
  const limit = Math.min(parseInt(query.limit) || 20, 100);
  return { page, limit, skip: (page - 1) * limit };
};

const paginatedResponse = (res, data, total, page, limit) =>
  res.status(200).json({
    status: 'success',
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    data,
  });

// ── Presentation ──────────────────────────────────────────────────────────────

const attachImageUrl = async (announcement) => {
  if (!announcement.image) return { ...announcement, imageUrl: null };
  const imageUrl = await r2Service.getSignedDownloadUrl(announcement.image, 3600);
  return { ...announcement, imageUrl };
};

// Mongoose's core lean() does not apply virtuals (that needs the separate
// mongoose-lean-virtuals plugin) — so `status`, computed from active/dates,
// has to be attached explicitly on every lean() result. Full Mongoose
// documents (create/update/activate/deactivate/duplicate below) already get
// it for free via `.toObject({ virtuals: true })`.
const attachStatus = (announcement) => ({ ...announcement, status: Announcement.computeStatus(announcement) });

// Translates a table "Status" filter into the equivalent active/date query —
// status itself is a virtual, not a stored field, so it can't be queried directly.
const statusFilterQuery = (status, now = new Date()) => {
  switch (status) {
    case 'draft': return { active: false, endDate: { $gte: now } };
    case 'scheduled': return { active: true, startDate: { $gt: now }, endDate: { $gte: now } };
    case 'active': return { active: true, startDate: { $lte: now }, endDate: { $gte: now } };
    case 'expired': return { endDate: { $lt: now } };
    default: return {};
  }
};

// ── GET /api/admin/announcements ──────────────────────────────────────────────
exports.list = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const {
    search, audience, trigger, status, dateFrom, dateTo,
  } = req.query;

  const filter = {};
  if (audience) filter.targetAudience = audience;
  if (trigger) filter.triggers = trigger;
  if (status) Object.assign(filter, statusFilterQuery(status));
  if (search) {
    filter.$or = [
      { title: { $regex: search, $options: 'i' } },
      { description: { $regex: search, $options: 'i' } },
    ];
  }
  if (dateFrom || dateTo) {
    const range = {};
    if (dateFrom) range.$gte = new Date(dateFrom);
    if (dateTo) range.$lte = new Date(new Date(dateTo).getTime() + 86_400_000);
    filter.startDate = range;
  }

  const [rawAnnouncements, total] = await Promise.all([
    Announcement.find(filter).sort('-updatedAt').skip(skip).limit(limit).lean(),
    Announcement.countDocuments(filter),
  ]);
  const announcements = rawAnnouncements.map(attachStatus);

  // Lightweight per-row counts for the list table (views/clicks columns) —
  // full analytics (CTR, time series, dismissals) only load on the detail page.
  const ids = announcements.map((a) => a._id);
  const counts = ids.length
    ? await AnnouncementView.aggregate([
      { $match: { announcement: { $in: ids } } },
      { $group: { _id: '$announcement', views: { $sum: 1 }, clicks: { $sum: { $cond: ['$clicked', 1, 0] } } } },
    ])
    : [];
  const countsById = Object.fromEntries(counts.map((c) => [String(c._id), c]));

  const withCounts = announcements.map((a) => ({
    ...a,
    views: countsById[String(a._id)]?.views ?? 0,
    clicks: countsById[String(a._id)]?.clicks ?? 0,
  }));
  const withImages = await Promise.all(withCounts.map(attachImageUrl));

  paginatedResponse(res, { announcements: withImages }, total, page, limit);
};

// ── GET /api/admin/announcements/:id ──────────────────────────────────────────
exports.getOne = async (req, res) => {
  const announcement = await Announcement.findById(req.params.id)
    .populate('selectedUsers', 'name phone role')
    .populate('selectedLocations', 'name region')
    .lean();
  if (!announcement) return res.status(404).json({ status: 'fail', message: 'Announcement not found' });

  const withImage = await attachImageUrl(attachStatus(announcement));
  res.status(200).json({ status: 'success', data: { announcement: withImage } });
};

// ── Shared field mapping ──────────────────────────────────────────────────────

const applyPayload = (announcement, body) => {
  announcement.title = body.title;
  announcement.subtitle = body.subtitle || null;
  announcement.description = body.description;
  announcement.image = body.image || null;
  announcement.type = body.type;
  announcement.targetAudience = body.targetAudience;
  announcement.selectedUsers = body.targetAudience === 'selected_users' ? body.selectedUsers : [];
  announcement.selectedLocations = body.targetAudience === 'selected_locations' ? body.selectedLocations : [];
  announcement.triggers = body.triggers;
  announcement.customEventName = body.triggers.includes('custom_event') ? body.customEventName || null : null;
  announcement.primaryButtonText = body.primaryButtonText || null;
  announcement.secondaryButtonText = body.secondaryButtonText || null;
  announcement.primaryAction = body.primaryAction;
  announcement.actionTarget = body.actionTarget || null;
  announcement.priority = body.priority;
  announcement.displayFrequency = body.displayFrequency;
  announcement.startDate = new Date(body.startDate);
  announcement.endDate = new Date(body.endDate);
};

// ── POST /api/admin/announcements ─────────────────────────────────────────────
exports.create = async (req, res) => {
  const announcement = new Announcement({ createdBy: req.user._id });
  applyPayload(announcement, req.body);
  announcement.active = !!req.body.activate;
  await announcement.save();

  if (announcement.active) await maybeNotifyActivation(announcement);

  logger.info('Announcement created', { announcementId: announcement._id, active: announcement.active, adminId: req.user._id });

  const withImage = await attachImageUrl(announcement.toObject({ virtuals: true }));
  res.status(201).json({ status: 'success', data: { announcement: withImage } });
};

// ── PUT /api/admin/announcements/:id ───────────────────────────────────────────
exports.update = async (req, res) => {
  const announcement = await Announcement.findById(req.params.id);
  if (!announcement) return res.status(404).json({ status: 'fail', message: 'Announcement not found' });

  const previousImage = announcement.image;
  const previousStart = announcement.startDate?.getTime();
  const previousEnd = announcement.endDate?.getTime();

  applyPayload(announcement, req.body);
  if (req.body.activate !== undefined) announcement.active = !!req.body.activate;

  // Schedule changed — this is a "new" activation window, so allow the
  // live-while-online push to fire again for it.
  if (announcement.startDate.getTime() !== previousStart || announcement.endDate.getTime() !== previousEnd) {
    announcement.activationNotified = false;
  }

  await announcement.save();
  if (announcement.active) await maybeNotifyActivation(announcement);

  if (previousImage && previousImage !== announcement.image) {
    r2Service.deleteFile(previousImage).catch((err) => {
      logger.error('Failed to delete replaced announcement image', { announcementId: announcement._id, error: err.message });
    });
  }

  logger.info('Announcement updated', { announcementId: announcement._id, active: announcement.active, adminId: req.user._id });

  const withImage = await attachImageUrl(announcement.toObject({ virtuals: true }));
  res.status(200).json({ status: 'success', data: { announcement: withImage } });
};

// ── DELETE /api/admin/announcements/:id ────────────────────────────────────────
exports.remove = async (req, res) => {
  const announcement = await Announcement.findByIdAndDelete(req.params.id);
  if (!announcement) return res.status(404).json({ status: 'fail', message: 'Announcement not found' });

  if (announcement.image) {
    r2Service.deleteFile(announcement.image).catch((err) => {
      logger.error('Failed to delete announcement image on delete', { announcementId: announcement._id, error: err.message });
    });
  }

  logger.info('Announcement deleted', { announcementId: announcement._id, adminId: req.user._id });
  res.status(200).json({ status: 'success', data: null });
};

// ── PATCH /api/admin/announcements/:id/activate ───────────────────────────────
exports.activate = async (req, res) => {
  const announcement = await Announcement.findById(req.params.id);
  if (!announcement) return res.status(404).json({ status: 'fail', message: 'Announcement not found' });

  announcement.active = true;
  await announcement.save();
  await maybeNotifyActivation(announcement);

  logger.info('Announcement activated', { announcementId: announcement._id, adminId: req.user._id });

  const withImage = await attachImageUrl(announcement.toObject({ virtuals: true }));
  res.status(200).json({ status: 'success', data: { announcement: withImage } });
};

// ── PATCH /api/admin/announcements/:id/deactivate ─────────────────────────────
exports.deactivate = async (req, res) => {
  const announcement = await Announcement.findById(req.params.id);
  if (!announcement) return res.status(404).json({ status: 'fail', message: 'Announcement not found' });

  announcement.active = false;
  // Re-activating later should be treated as a fresh activation.
  announcement.activationNotified = false;
  await announcement.save();

  logger.info('Announcement deactivated', { announcementId: announcement._id, adminId: req.user._id });

  const withImage = await attachImageUrl(announcement.toObject({ virtuals: true }));
  res.status(200).json({ status: 'success', data: { announcement: withImage } });
};

// ── POST /api/admin/announcements/:id/duplicate ───────────────────────────────
exports.duplicate = async (req, res) => {
  const source = await Announcement.findById(req.params.id).lean();
  if (!source) return res.status(404).json({ status: 'fail', message: 'Announcement not found' });

  const copy = await Announcement.create({
    title: `${source.title} (Copy)`,
    subtitle: source.subtitle,
    description: source.description,
    image: source.image,
    type: source.type,
    targetAudience: source.targetAudience,
    selectedUsers: source.selectedUsers,
    selectedLocations: source.selectedLocations,
    triggers: source.triggers,
    customEventName: source.customEventName,
    primaryButtonText: source.primaryButtonText,
    secondaryButtonText: source.secondaryButtonText,
    primaryAction: source.primaryAction,
    actionTarget: source.actionTarget,
    priority: source.priority,
    displayFrequency: source.displayFrequency,
    startDate: source.startDate,
    endDate: source.endDate,
    active: false,
    createdBy: req.user._id,
  });

  logger.info('Announcement duplicated', { sourceId: source._id, copyId: copy._id, adminId: req.user._id });

  const withImage = await attachImageUrl(copy.toObject({ virtuals: true }));
  res.status(201).json({ status: 'success', data: { announcement: withImage } });
};

// ── GET /api/admin/announcements/:id/analytics ────────────────────────────────
exports.analytics = async (req, res) => {
  const announcement = await Announcement.findById(req.params.id).select('_id').lean();
  if (!announcement) return res.status(404).json({ status: 'fail', message: 'Announcement not found' });

  const analytics = await getAnalytics(req.params.id);
  res.status(200).json({ status: 'success', data: { analytics } });
};

// ── Image upload ───────────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  },
});

exports.uploadImageMiddleware = upload.single('image');

// POST /api/admin/announcements/image
exports.uploadImage = async (req, res) => {
  if (!req.file) return res.status(400).json({ status: 'fail', message: 'An image file is required' });

  const imageKey = await r2Service.uploadFile(req.file.buffer, 'announcement-images', 'image', req.file.mimetype);
  const imageUrl = await r2Service.getSignedDownloadUrl(imageKey, 3600);

  res.status(201).json({ status: 'success', data: { imageKey, imageUrl } });
};
