const multer = require('multer');
const NotificationCampaign = require('../models/NotificationCampaign');
const Notification = require('../models/Notification');
const r2Service = require('../services/r2Service');
const logger = require('../utils/logger');
const {
  resolveAudienceUsers, dispatchCampaign, getSystemEventStats,
} = require('../services/notificationCampaignService');
const auditLogService = require('../services/auditLogService');

// ── Pagination helper (mirrors adminController's) ────────────────────────────
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

// ── Presentation helpers ──────────────────────────────────────────────────────

const attachBannerUrl = async (campaign) => {
  if (!campaign.bannerImageKey) return { ...campaign, bannerImageUrl: null };
  const bannerImageUrl = await r2Service.getSignedDownloadUrl(campaign.bannerImageKey, 3600);
  return { ...campaign, bannerImageUrl };
};

/** Live "opened" counts for a batch of sent/failed campaigns, in one query. */
const attachOpenedCounts = async (campaigns) => {
  const ids = campaigns.filter((c) => c.delivered > 0).map((c) => c._id);
  if (!ids.length) return campaigns.map((c) => ({ ...c, opened: 0 }));

  const rows = await Notification.aggregate([
    { $match: { campaign: { $in: ids } } },
    { $group: { _id: '$campaign', opened: { $sum: { $cond: ['$isRead', 1, 0] } } } },
  ]);
  const openedById = Object.fromEntries(rows.map((r) => [String(r._id), r.opened]));

  return campaigns.map((c) => ({ ...c, opened: openedById[String(c._id)] ?? 0 }));
};

// ── GET /api/admin/notification-campaigns ─────────────────────────────────────
exports.list = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const {
    search, audience, status, dateFrom, dateTo,
  } = req.query;

  const filter = {};
  if (audience) filter.audience = audience;
  if (status) filter.status = status;
  if (search) {
    filter.$or = [
      { title: { $regex: search, $options: 'i' } },
      { message: { $regex: search, $options: 'i' } },
    ];
  }
  if (dateFrom || dateTo) {
    // Matches whichever date the campaign is "dated" by — sentAt if sent,
    // otherwise scheduledAt, otherwise createdAt (mirrors the frontend's
    // display logic for the "Sent / Scheduled" column).
    const range = {};
    if (dateFrom) range.$gte = new Date(dateFrom);
    if (dateTo) range.$lte = new Date(new Date(dateTo).getTime() + 86_400_000);
    filter.$and = [{
      $or: [
        { sentAt: range }, { scheduledAt: range },
        { $and: [{ sentAt: null }, { scheduledAt: null }, { createdAt: range }] },
      ],
    }];
  }

  const [campaigns, total] = await Promise.all([
    NotificationCampaign.find(filter).sort('-updatedAt').skip(skip).limit(limit).lean(),
    NotificationCampaign.countDocuments(filter),
  ]);

  const withOpened = await attachOpenedCounts(campaigns);
  const withBanners = await Promise.all(withOpened.map(attachBannerUrl));

  paginatedResponse(res, { campaigns: withBanners }, total, page, limit);
};

// ── GET /api/admin/notification-campaigns/stats ───────────────────────────────
exports.stats = async (req, res) => {
  const [totalSent, scheduled, drafts, failedAgg] = await Promise.all([
    NotificationCampaign.countDocuments({ status: 'sent' }),
    NotificationCampaign.countDocuments({ status: 'scheduled' }),
    NotificationCampaign.countDocuments({ status: 'draft' }),
    NotificationCampaign.aggregate([{ $group: { _id: null, total: { $sum: '$failed' } } }]),
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      totalSent,
      scheduled,
      drafts,
      failedDeliveries: failedAgg[0]?.total ?? 0,
    },
  });
};

// ── GET /api/admin/notification-campaigns/system-events ──────────────────────
exports.systemEvents = async (req, res) => {
  const events = await getSystemEventStats();
  res.status(200).json({ status: 'success', data: { events } });
};

// ── GET /api/admin/notification-campaigns/:id ─────────────────────────────────
exports.getOne = async (req, res) => {
  const campaign = await NotificationCampaign.findById(req.params.id)
    .populate('specificUserIds', 'name phone role')
    .lean();
  if (!campaign) return res.status(404).json({ status: 'fail', message: 'Notification not found' });

  const [withOpened] = await attachOpenedCounts([campaign]);
  const withBanner = await attachBannerUrl(withOpened);

  res.status(200).json({ status: 'success', data: { campaign: withBanner } });
};

// ── Create / update shared field mapping ──────────────────────────────────────

const applyPayload = (campaign, body) => {
  campaign.title = body.title;
  campaign.message = body.message;
  campaign.bannerImageKey = body.bannerImageKey || null;
  campaign.audience = body.audience;
  campaign.specificUserIds = body.audience === 'specific' ? body.specificUserIds : [];
  campaign.type = body.type;
};

// ── POST /api/admin/notification-campaigns ────────────────────────────────────
exports.create = async (req, res) => {
  const { action, scheduledAt } = req.body;

  const campaign = new NotificationCampaign({ createdBy: req.user._id });
  applyPayload(campaign, req.body);

  if (action === 'draft') {
    campaign.status = 'draft';
    await campaign.save();
  } else if (scheduledAt) {
    campaign.status = 'scheduled';
    campaign.scheduledAt = new Date(scheduledAt);
    await campaign.save();
  } else {
    await campaign.save();
    await dispatchCampaign(campaign);
  }

  logger.info('Notification campaign created', { campaignId: campaign._id, status: campaign.status, adminId: req.user._id });
  auditLogService.record({
    req, action: 'Created', module: 'Notifications', severity: 'Low',
    target: { type: 'NotificationCampaign', id: campaign._id, label: campaign.title },
    changes: { before: null, after: { title: campaign.title, status: campaign.status, audience: campaign.audience } },
  });

  const [withOpened] = await attachOpenedCounts([campaign.toObject()]);
  const withBanner = await attachBannerUrl(withOpened);
  res.status(201).json({ status: 'success', data: { campaign: withBanner } });
};

// ── PATCH /api/admin/notification-campaigns/:id ───────────────────────────────
exports.update = async (req, res) => {
  const campaign = await NotificationCampaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ status: 'fail', message: 'Notification not found' });

  if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
    return res.status(422).json({ status: 'fail', message: 'Only draft or scheduled notifications can be edited' });
  }

  const previousBannerKey = campaign.bannerImageKey;
  const beforeSnapshot = { title: campaign.title, status: campaign.status, audience: campaign.audience };
  const { action, scheduledAt } = req.body;
  applyPayload(campaign, req.body);

  if (action === 'draft') {
    campaign.status = 'draft';
    campaign.scheduledAt = null;
    await campaign.save();
  } else if (scheduledAt) {
    campaign.status = 'scheduled';
    campaign.scheduledAt = new Date(scheduledAt);
    await campaign.save();
  } else {
    campaign.scheduledAt = null;
    await campaign.save();
    await dispatchCampaign(campaign);
  }

  if (previousBannerKey && previousBannerKey !== campaign.bannerImageKey) {
    r2Service.deleteFile(previousBannerKey).catch((err) => {
      logger.error('Failed to delete replaced notification banner', { campaignId: campaign._id, error: err.message });
    });
  }

  logger.info('Notification campaign updated', { campaignId: campaign._id, status: campaign.status, adminId: req.user._id });
  auditLogService.record({
    req, action: 'Updated', module: 'Notifications', severity: 'Low',
    target: { type: 'NotificationCampaign', id: campaign._id, label: campaign.title },
    changes: { before: beforeSnapshot, after: { title: campaign.title, status: campaign.status, audience: campaign.audience } },
  });

  const [withOpened] = await attachOpenedCounts([campaign.toObject()]);
  const withBanner = await attachBannerUrl(withOpened);
  res.status(200).json({ status: 'success', data: { campaign: withBanner } });
};

// ── POST /api/admin/notification-campaigns/:id/duplicate ─────────────────────
exports.duplicate = async (req, res) => {
  const source = await NotificationCampaign.findById(req.params.id).lean();
  if (!source) return res.status(404).json({ status: 'fail', message: 'Notification not found' });

  const copy = await NotificationCampaign.create({
    title: `${source.title} (Copy)`,
    message: source.message,
    bannerImageKey: source.bannerImageKey,
    audience: source.audience,
    specificUserIds: source.specificUserIds,
    type: source.type,
    status: 'draft',
    createdBy: req.user._id,
  });

  logger.info('Notification campaign duplicated', { sourceId: source._id, copyId: copy._id, adminId: req.user._id });
  auditLogService.record({
    req, action: 'Created', module: 'Notifications', severity: 'Low',
    target: { type: 'NotificationCampaign', id: copy._id, label: copy.title },
    changes: { before: null, after: { title: copy.title, duplicatedFrom: source._id } },
  });

  const withBanner = await attachBannerUrl({ ...copy.toObject(), opened: 0 });
  res.status(201).json({ status: 'success', data: { campaign: withBanner } });
};

// ── DELETE /api/admin/notification-campaigns/:id ──────────────────────────────
exports.remove = async (req, res) => {
  const campaign = await NotificationCampaign.findByIdAndDelete(req.params.id);
  if (!campaign) return res.status(404).json({ status: 'fail', message: 'Notification not found' });

  if (campaign.bannerImageKey) {
    r2Service.deleteFile(campaign.bannerImageKey).catch((err) => {
      logger.error('Failed to delete notification banner on campaign delete', { campaignId: campaign._id, error: err.message });
    });
  }

  logger.info('Notification campaign deleted', { campaignId: campaign._id, adminId: req.user._id });
  auditLogService.record({
    req, action: 'Deleted', module: 'Notifications', severity: 'Medium',
    target: { type: 'NotificationCampaign', id: campaign._id, label: campaign.title },
    changes: { before: { title: campaign.title, status: campaign.status }, after: null },
  });
  res.status(200).json({ status: 'success', data: null });
};

// ── Banner image upload ───────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  },
});

exports.uploadBannerMiddleware = upload.single('image');

// POST /api/admin/notification-campaigns/banner-image
exports.uploadBanner = async (req, res) => {
  if (!req.file) return res.status(400).json({ status: 'fail', message: 'An image file is required' });

  const bannerImageKey = await r2Service.uploadFile(
    req.file.buffer,
    'notification-banners',
    'banner',
    req.file.mimetype,
  );
  const bannerImageUrl = await r2Service.getSignedDownloadUrl(bannerImageKey, 3600);

  res.status(201).json({ status: 'success', data: { bannerImageKey, bannerImageUrl } });
};

// Exposed for the composer's audience picker — thin re-export so the frontend
// doesn't need a second endpoint just to preview how many users match an
// audience before sending (used by the "N recipients" count in the UI).
exports.previewAudienceCount = async (req, res) => {
  const { audience, specificUserIds } = req.query;
  if (!audience) return res.status(400).json({ status: 'fail', message: 'audience is required' });

  const count = await resolveAudienceUsers({
    audience,
    specificUserIds: specificUserIds ? String(specificUserIds).split(',') : [],
  }).then((users) => users.length);

  res.status(200).json({ status: 'success', data: { count } });
};
