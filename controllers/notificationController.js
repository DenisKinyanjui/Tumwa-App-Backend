const Notification = require('../models/Notification');
const User = require('../models/User');
const r2Service = require('../services/r2Service');

// Most notifications have no banner — only resolve signed URLs for the ones
// fanned out from an admin campaign with an image attached.
const attachBannerUrls = async (notifications) => Promise.all(
  notifications.map(async (n) => {
    if (!n.bannerImageKey) return n;
    const bannerImageUrl = await r2Service.getSignedDownloadUrl(n.bannerImageKey, 3600);
    return { ...n, bannerImageUrl };
  }),
);

// ─── GET /api/notifications ───────────────────────────────────────────────────
// Returns the authenticated user's notifications, newest first.
// Query params: isRead (true|false), type, page, limit

exports.getNotifications = async (req, res) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const skip = (page - 1) * limit;

  const filter = { user: req.user._id };
  if (req.query.isRead !== undefined) filter.isRead = req.query.isRead === 'true';
  if (req.query.type) filter.type = req.query.type;

  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find(filter).sort('-createdAt').skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({ user: req.user._id, isRead: false }),
  ]);

  const withBanners = await attachBannerUrls(notifications);

  res.status(200).json({
    status: 'success',
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    unreadCount,
    data: { notifications: withBanners },
  });
};

// ─── GET /api/notifications/unread-count ─────────────────────────────────────
exports.getUnreadCount = async (req, res) => {
  const count = await Notification.countDocuments({ user: req.user._id, isRead: false });
  res.status(200).json({ status: 'success', data: { unreadCount: count } });
};

// ─── PATCH /api/notifications/:id/read ───────────────────────────────────────
exports.markAsRead = async (req, res) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    { isRead: true },
    { new: true }
  );

  if (!notification) {
    return res.status(404).json({ status: 'fail', message: 'Notification not found' });
  }

  res.status(200).json({ status: 'success', data: { notification } });
};

// ─── PATCH /api/notifications/read-all ───────────────────────────────────────
exports.markAllAsRead = async (req, res) => {
  const { modifiedCount } = await Notification.updateMany(
    { user: req.user._id, isRead: false },
    { isRead: true }
  );

  res.status(200).json({
    status: 'success',
    message: `${modifiedCount} notification(s) marked as read`,
  });
};

// ─── DELETE /api/notifications ────────────────────────────────────────────────
// Deletes read notifications by default. Pass ?all=true to clear everything.
exports.clearNotifications = async (req, res) => {
  const filter = { user: req.user._id };
  if (req.query.all !== 'true') filter.isRead = true;

  const { deletedCount } = await Notification.deleteMany(filter);

  res.status(200).json({
    status: 'success',
    message: `${deletedCount} notification(s) deleted`,
  });
};

// ─── PATCH /api/notifications/device-token ───────────────────────────────────
// Register or update the user's FCM device token for push notifications.
exports.registerDeviceToken = async (req, res) => {
  const { token } = req.body;

  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    return res.status(400).json({ status: 'fail', message: 'A valid FCM token is required' });
  }

  await User.findByIdAndUpdate(req.user._id, { fcmToken: token.trim() });

  res.status(200).json({ status: 'success', message: 'Device token registered' });
};

// ─── DELETE /api/notifications/device-token ──────────────────────────────────
// Called on logout — removes the FCM token so the device stops receiving pushes.
exports.removeDeviceToken = async (req, res) => {
  await User.findByIdAndUpdate(req.user._id, { fcmToken: null });
  res.status(200).json({ status: 'success', message: 'Device token removed' });
};
