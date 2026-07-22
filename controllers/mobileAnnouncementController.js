const r2Service = require('../services/r2Service');
const {
  getEligibleForTrigger, checkSingleEligibility, recordView, recordDismiss, recordClick,
} = require('../services/announcementService');

const attachImageUrl = async (announcement) => {
  if (!announcement) return null;
  if (!announcement.image) return { ...announcement, imageUrl: null };
  const imageUrl = await r2Service.getSignedDownloadUrl(announcement.image, 3600);
  return { ...announcement, imageUrl };
};

// ── GET /api/mobile/announcements ─────────────────────────────────────────────
// Query: trigger (required), sessionId, appVersion, eventName (only used when trigger=custom_event)
exports.getEligible = async (req, res) => {
  const { trigger, sessionId, appVersion, eventName } = req.query;
  if (!trigger) return res.status(400).json({ status: 'fail', message: 'trigger is required' });

  const { top, queued } = await getEligibleForTrigger(req.user, trigger, { appVersion, sessionId, eventName });

  const [topWithImage, queuedWithImages] = await Promise.all([
    attachImageUrl(top),
    Promise.all(queued.map(attachImageUrl)),
  ]);

  res.status(200).json({ status: 'success', data: { announcement: topWithImage, queued: queuedWithImages } });
};

// ── GET /api/mobile/announcements/:id/check ───────────────────────────────────
// Used when an 'announcement:new' socket push arrives while the user is online.
exports.checkOne = async (req, res) => {
  const { sessionId, appVersion } = req.query;
  const announcement = await checkSingleEligibility(req.params.id, req.user, { appVersion, sessionId });
  const withImage = await attachImageUrl(announcement);
  res.status(200).json({ status: 'success', data: { announcement: withImage } });
};

// ── POST /api/mobile/announcements/:id/view ───────────────────────────────────
exports.view = async (req, res) => {
  const { trigger, appVersion, sessionId } = req.body;
  const view = await recordView({
    announcementId: req.params.id, userId: req.user._id, trigger, appVersion, sessionId,
  });
  res.status(201).json({ status: 'success', data: { viewId: view._id } });
};

// ── PATCH /api/mobile/announcements/views/:viewId/dismiss ─────────────────────
exports.dismiss = async (req, res) => {
  const view = await recordDismiss(req.params.viewId, req.user._id);
  if (!view) return res.status(404).json({ status: 'fail', message: 'View record not found' });
  res.status(200).json({ status: 'success', data: null });
};

// ── PATCH /api/mobile/announcements/views/:viewId/click ───────────────────────
exports.click = async (req, res) => {
  const { button } = req.body;
  if (!['primary', 'secondary'].includes(button)) {
    return res.status(400).json({ status: 'fail', message: 'button must be "primary" or "secondary"' });
  }
  const view = await recordClick(req.params.viewId, req.user._id, button);
  if (!view) return res.status(404).json({ status: 'fail', message: 'View record not found' });
  res.status(200).json({ status: 'success', data: null });
};
