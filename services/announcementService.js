const mongoose = require('mongoose');
const Announcement = require('../models/Announcement');
const AnnouncementView = require('../models/AnnouncementView');
const RunnerVerification = require('../models/RunnerVerification');
const ServiceArea = require('../models/ServiceArea');
const logger = require('../utils/logger');
const { emitToRoom, emitToUser } = require('../socket/socketManager');

const PRIORITY_RANK = { critical: 3, high: 2, normal: 1, low: 0 };

// ── Audience resolution ──────────────────────────────────────────────────────

/** A runner's operating-area ServiceArea ids, resolved from their verification's area-name strings. */
const resolveRunnerAreaIds = async (user) => {
  if (user.role !== 'runner') return [];
  const verification = await RunnerVerification.findOne({ user: user._id }).select('areasOfOperation').lean();
  if (!verification?.areasOfOperation?.length) return [];
  const areas = await ServiceArea.find({ name: { $in: verification.areasOfOperation } }).select('_id').lean();
  return areas.map((a) => a._id);
};

/** Mongo $or clause matching every targetAudience value `user` currently qualifies for. */
const buildAudienceQuery = (user, runnerAreaIds) => {
  const clauses = [{ targetAudience: 'everyone' }, { targetAudience: 'selected_users', selectedUsers: user._id }];

  if (user.role === 'customer') {
    clauses.push({ targetAudience: 'customers' });
  }
  if (user.role === 'runner') {
    clauses.push({ targetAudience: 'runners' });
    clauses.push({ targetAudience: user.verificationStatus === 'approved' ? 'verified_runners' : 'unverified_runners' });
    clauses.push({ targetAudience: user.isActive ? 'active_runners' : 'suspended_runners' });
    if (runnerAreaIds.length) {
      clauses.push({ targetAudience: 'selected_locations', selectedLocations: { $in: runnerAreaIds } });
    }
  }

  return { $or: clauses };
};

/** Doc-level audience check for a single already-fetched announcement (used by the socket-push single-check path). */
const matchesAudience = (announcement, user, runnerAreaIds) => {
  switch (announcement.targetAudience) {
    case 'everyone': return true;
    case 'customers': return user.role === 'customer';
    case 'runners': return user.role === 'runner';
    case 'verified_runners': return user.role === 'runner' && user.verificationStatus === 'approved';
    case 'unverified_runners': return user.role === 'runner' && user.verificationStatus !== 'approved';
    case 'active_runners': return user.role === 'runner' && user.isActive === true;
    case 'suspended_runners': return user.role === 'runner' && user.isActive === false;
    case 'selected_users':
      return announcement.selectedUsers.some((id) => id.toString() === user._id.toString());
    case 'selected_locations':
      return user.role === 'runner' && announcement.selectedLocations.some(
        (locId) => runnerAreaIds.some((id) => id.toString() === locId.toString()),
      );
    default: return false;
  }
};

// ── Display-frequency filtering ───────────────────────────────────────────────

/** Keeps only the candidates whose displayFrequency rule the user hasn't already exhausted. */
const filterByFrequency = async (candidates, userId, { appVersion, sessionId } = {}) => {
  if (!candidates.length) return [];

  const ids = candidates.map((c) => c._id);
  const views = await AnnouncementView.find({ announcement: { $in: ids }, user: userId }).lean();

  const historyByAnnouncement = new Map();
  views.forEach((v) => {
    const key = v.announcement.toString();
    if (!historyByAnnouncement.has(key)) historyByAnnouncement.set(key, []);
    historyByAnnouncement.get(key).push(v);
  });

  return candidates.filter((c) => {
    const history = historyByAnnouncement.get(c._id.toString()) ?? [];
    switch (c.displayFrequency) {
      case 'once_ever': return history.length === 0;
      case 'once_per_version': return !history.some((v) => v.appVersion && v.appVersion === appVersion);
      case 'once_per_session': return !history.some((v) => v.sessionId && v.sessionId === sessionId);
      case 'until_dismissed': return !history.some((v) => v.dismissed);
      case 'every_trigger':
      default:
        return true;
    }
  });
};

// ── Bulk eligibility (GET /api/mobile/announcements) ─────────────────────────

/**
 * Resolves the announcements eligible to show `user` right now for `trigger`,
 * split into the single highest-priority one to display immediately and the
 * rest to queue behind it.
 */
const getEligibleForTrigger = async (user, trigger, { appVersion, sessionId, eventName } = {}) => {
  const now = new Date();
  const runnerAreaIds = await resolveRunnerAreaIds(user);
  const audienceQuery = buildAudienceQuery(user, runnerAreaIds);

  const triggerQuery = trigger === 'custom_event' && eventName
    ? { triggers: 'custom_event', customEventName: eventName }
    : { triggers: trigger };

  const candidates = await Announcement.find({
    ...audienceQuery,
    ...triggerQuery,
    active: true,
    startDate: { $lte: now },
    endDate: { $gte: now },
  }).lean();

  candidates.sort((a, b) => (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0)
    || new Date(a.createdAt) - new Date(b.createdAt));

  const eligible = await filterByFrequency(candidates, user._id, { appVersion, sessionId });
  const [top = null, ...queued] = eligible;
  return { top, queued };
};

/** Single-announcement eligibility check, ignoring the triggers[] requirement — used for the real-time socket-push path. */
const checkSingleEligibility = async (announcementId, user, { appVersion, sessionId } = {}) => {
  if (!mongoose.isValidObjectId(announcementId)) return null;

  const now = new Date();
  const announcement = await Announcement.findOne({
    _id: announcementId, active: true, startDate: { $lte: now }, endDate: { $gte: now },
  }).lean();
  if (!announcement) return null;

  const runnerAreaIds = await resolveRunnerAreaIds(user);
  if (!matchesAudience(announcement, user, runnerAreaIds)) return null;

  const [passed] = await filterByFrequency([announcement], user._id, { appVersion, sessionId });
  return passed ?? null;
};

// ── View/dismiss/click recording ──────────────────────────────────────────────

const recordView = ({ announcementId, userId, trigger, appVersion, sessionId }) =>
  AnnouncementView.create({ announcement: announcementId, user: userId, trigger, appVersion, sessionId });

const recordDismiss = (viewId, userId) =>
  AnnouncementView.findOneAndUpdate(
    { _id: viewId, user: userId },
    { dismissed: true, dismissedAt: new Date() },
    { new: true },
  );

const recordClick = (viewId, userId, button) =>
  AnnouncementView.findOneAndUpdate(
    { _id: viewId, user: userId },
    { clicked: true, clickedAt: new Date(), clickedButton: button },
    { new: true },
  );

// ── Analytics ─────────────────────────────────────────────────────────────────

const getAnalytics = async (announcementId) => {
  const objectId = new mongoose.Types.ObjectId(announcementId);

  const [summary] = await AnnouncementView.aggregate([
    { $match: { announcement: objectId } },
    {
      $group: {
        _id: null,
        views: { $sum: 1 },
        dismissals: { $sum: { $cond: ['$dismissed', 1, 0] } },
        clicks: { $sum: { $cond: ['$clicked', 1, 0] } },
        lastSeen: { $max: '$viewedAt' },
        uniqueUsers: { $addToSet: '$user' },
      },
    },
  ]);

  const views = summary?.views ?? 0;
  const clicks = summary?.clicks ?? 0;

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const daily = await AnnouncementView.aggregate([
    { $match: { announcement: objectId, viewedAt: { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$viewedAt' } },
        views: { $sum: 1 },
        clicks: { $sum: { $cond: ['$clicked', 1, 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  return {
    views,
    dismissals: summary?.dismissals ?? 0,
    clicks,
    ctr: views > 0 ? Math.round((clicks / views) * 1000) / 10 : 0,
    lastSeen: summary?.lastSeen ?? null,
    activeUsersReached: summary?.uniqueUsers?.length ?? 0,
    timeSeries: daily.map((d) => ({ date: d._id, views: d.views, clicks: d.clicks })),
  };
};

// ── Real-time "just went live" push ───────────────────────────────────────────

const notifyAudienceOfActivation = (announcement) => {
  const payload = { announcementId: announcement._id };
  switch (announcement.targetAudience) {
    case 'everyone':
      emitToRoom('customers', 'announcement:new', payload);
      emitToRoom('runners', 'announcement:new', payload);
      break;
    case 'customers':
      emitToRoom('customers', 'announcement:new', payload);
      break;
    case 'selected_users':
      announcement.selectedUsers.forEach((id) => emitToUser(id.toString(), 'announcement:new', payload));
      break;
    // runners / verified_runners / unverified_runners / active_runners /
    // suspended_runners / selected_locations all narrow down FROM the runner
    // pool — broadcast to the room and let each client's eligibility check
    // (checkSingleEligibility) apply the precise sub-filter.
    default:
      emitToRoom('runners', 'announcement:new', payload);
      break;
  }
};

/** Emits the activation push for one announcement if it's due and hasn't fired yet, marking it notified. */
const maybeNotifyActivation = async (announcement) => {
  if (announcement.activationNotified) return;
  const now = new Date();
  if (!announcement.active || announcement.startDate > now || announcement.endDate < now) return;

  notifyAudienceOfActivation(announcement);
  announcement.activationNotified = true;
  await announcement.save();
};

/** Polled from index.js — catches scheduled announcements crossing into their active window while admins aren't watching. */
const runActivationSweep = async () => {
  const now = new Date();
  const due = await Announcement.find({
    active: true, activationNotified: false, startDate: { $lte: now }, endDate: { $gte: now },
  });

  for (const announcement of due) {
    try {
      notifyAudienceOfActivation(announcement);
      announcement.activationNotified = true;
      await announcement.save();
    } catch (err) {
      logger.error('[Announcement] activation sweep failed', { announcementId: announcement._id, error: err.message });
    }
  }
};

module.exports = {
  resolveRunnerAreaIds,
  getEligibleForTrigger,
  checkSingleEligibility,
  recordView,
  recordDismiss,
  recordClick,
  getAnalytics,
  maybeNotifyActivation,
  runActivationSweep,
};
