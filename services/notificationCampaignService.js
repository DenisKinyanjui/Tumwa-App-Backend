const User = require('../models/User');
const Notification = require('../models/Notification');
const NotificationCampaign = require('../models/NotificationCampaign');
const logger = require('../utils/logger');
const { emitToUser } = require('../socket/socketManager');
const { sendMulticastPush } = require('./pushNotificationService');

// ── Audience resolution ──────────────────────────────────────────────────────

/**
 * Resolve a campaign's audience into the concrete list of users it targets
 * at send time. Membership is a point-in-time snapshot — recorded on the
 * campaign as `recipients`/`delivered`/`failed` once dispatched.
 */
const resolveAudienceUsers = async (campaign) => {
  if (campaign.audience === 'specific') {
    return User.find({ _id: { $in: campaign.specificUserIds } })
      .select('_id fcmToken')
      .lean();
  }

  const roleFilter = campaign.audience === 'all'
    ? { role: { $in: ['customer', 'runner'] } }
    : { role: campaign.audience === 'customers' ? 'customer' : 'runner' };

  return User.find({ ...roleFilter, isActive: true }).select('_id fcmToken').lean();
};

// ── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * Fans a campaign out to its resolved audience: persists one Notification
 * per recipient (linked via `campaign` so delivery/open analytics can be
 * computed live), emits a socket event to each online user, and fires FCM
 * pushes. Mutates and saves the campaign with the resulting status/counts.
 * Never throws — failures are recorded on the campaign itself.
 */
const dispatchCampaign = async (campaign) => {
  try {
    const users = await resolveAudienceUsers(campaign);

    if (!users.length) {
      campaign.status = 'sent';
      campaign.sentAt = new Date();
      campaign.recipients = 0;
      campaign.delivered = 0;
      campaign.failed = 0;
      campaign.failureReason = null;
      await campaign.save();
      return campaign;
    }

    const docs = users.map((u) => ({
      user: u._id,
      title: campaign.title,
      message: campaign.message,
      type: campaign.type,
      campaign: campaign._id,
      bannerImageKey: campaign.bannerImageKey,
    }));

    const inserted = await Notification.insertMany(docs, { ordered: false });

    inserted.forEach((doc) => {
      emitToUser(doc.user.toString(), 'notification:new', {
        notificationId: doc._id,
        title: campaign.title,
        message: campaign.message,
      });
    });

    const tokens = users.map((u) => u.fcmToken).filter(Boolean);
    sendMulticastPush({
      tokens,
      title: campaign.title,
      body: campaign.message,
      data: { type: campaign.type, campaignId: String(campaign._id) },
    }).catch((err) => logger.error('[NotificationCampaign] push batch failed', { campaignId: campaign._id, error: err.message }));

    campaign.status = 'sent';
    campaign.sentAt = new Date();
    campaign.recipients = users.length;
    campaign.delivered = inserted.length;
    campaign.failed = users.length - inserted.length;
    campaign.failureReason = null;
    await campaign.save();
    return campaign;
  } catch (err) {
    campaign.status = 'failed';
    campaign.failureReason = err.message;
    await campaign.save().catch(() => {});
    logger.error('[NotificationCampaign] dispatch failed', { campaignId: campaign._id, error: err.message });
    return campaign;
  }
};

// ── Scheduled sweep ───────────────────────────────────────────────────────────
// Polled from index.js on a plain interval (no cron library in this backend —
// matches the existing conversation read-only sweep's style).

const runScheduledSweep = async () => {
  const due = await NotificationCampaign.find({
    status: 'scheduled',
    scheduledAt: { $lte: new Date() },
  });

  for (const campaign of due) {
    await dispatchCampaign(campaign);
  }
};

// ── System notifications catalog ─────────────────────────────────────────────
// Read-only, auto-generated notifications the platform already sends from
// domain events (see notifyService callers). Each entry's `match` filters the
// real Notification collection via the `event` field persisted at send time.

const SYSTEM_EVENT_CATALOG = [
  {
    key: 'runner_verified',
    label: 'Runner Verified',
    description: "Sent automatically when an admin approves a runner's KYC submission.",
    audience: 'runners',
    match: { event: 'verification-status-changed', title: 'Verification Approved' },
  },
  {
    key: 'withdrawal_approved',
    label: 'Withdrawal Approved',
    description: "Sent when a runner's M-Pesa withdrawal request completes successfully.",
    audience: 'runners',
    match: { event: 'withdrawal-completed' },
  },
  {
    key: 'payment_successful',
    label: 'Payment Successful',
    description: 'Sent to a customer once their STK Push payment for an errand confirms.',
    audience: 'customers',
    match: { event: 'payment-confirmed' },
  },
  {
    key: 'errand_assigned',
    label: 'Errand Assigned',
    description: 'Sent to both parties when a runner accepts and is assigned to an errand.',
    audience: 'customers',
    match: { event: 'errand-assigned' },
  },
  {
    key: 'errand_cancelled',
    label: 'Errand Cancelled',
    description: 'Sent when an errand is cancelled by either party or by an admin.',
    audience: 'customers',
    match: { event: 'errand-cancelled' },
  },
  {
    key: 'dispute_resolved',
    label: 'Dispute Resolved',
    description: 'Sent to both parties once an admin records a resolution outcome.',
    audience: 'customers',
    match: { event: 'dispute-resolved' },
  },
];

/** Live counts per system event, computed directly from the Notification collection. */
const getSystemEventStats = async () => {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  return Promise.all(SYSTEM_EVENT_CATALOG.map(async (entry) => {
    const [totalSent, last24h, mostRecent] = await Promise.all([
      Notification.countDocuments(entry.match),
      Notification.countDocuments({ ...entry.match, createdAt: { $gte: since24h } }),
      Notification.findOne(entry.match).sort('-createdAt').select('createdAt').lean(),
    ]);

    return {
      key: entry.key,
      label: entry.label,
      description: entry.description,
      audience: entry.audience,
      totalSent,
      last24h,
      lastTriggeredAt: mostRecent?.createdAt ?? null,
    };
  }));
};

module.exports = {
  resolveAudienceUsers,
  dispatchCampaign,
  runScheduledSweep,
  getSystemEventStats,
};
