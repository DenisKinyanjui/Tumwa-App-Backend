const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const disputeController = require('../controllers/disputeController');
const legalController = require('../controllers/legalController');
const settingsController = require('../controllers/settingsController');
const locationController = require('../controllers/locationController');
const notificationCampaignController = require('../controllers/notificationCampaignController');
const announcementController = require('../controllers/announcementController');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { adminLimiter } = require('../middlewares/rateLimiter');
const { validate, schemas } = require('../middlewares/validator');

// All admin routes require a valid JWT AND admin role. The rate limiter is
// mounted after these so it can key by req.user._id — see rateLimiter.js.
router.use(protect);
router.use(restrictTo('admin'));
router.use(adminLimiter);

// ── Users ─────────────────────────────────────────────────────────────────────
router.get('/users', adminController.getUsers);
router.get('/users/:id', adminController.getUser);
router.patch('/users/:id', adminController.updateUser);
router.patch('/users/:id/working-capital', adminController.setWorkingCapitalLimit);
router.delete('/users/:id', adminController.deleteUser);

// ── Runner Verifications ──────────────────────────────────────────────────────
router.get('/verifications', adminController.listVerifications);
router.get('/verifications/:userId', adminController.getVerification);
router.patch('/verifications/:userId/approve', adminController.approveVerification);
router.patch('/verifications/:userId/reject', adminController.rejectVerification);
router.patch('/verifications/:userId/request-resubmission', adminController.requestResubmissionVerification);
router.patch('/verifications/:userId/reopen', adminController.reopenVerification);

// ── Errands ───────────────────────────────────────────────────────────────────
router.get('/errands', adminController.getErrands);
router.get('/errands/:id', adminController.getErrand);

// ── Trust Wallets ─────────────────────────────────────────────────────────────
router.get('/wallets', adminController.getWallets);
router.patch('/wallets/:userId', adminController.adjustWallet);

// ── Disputes — list via admin controller, resolve/reject via dispute controller ─
router.get('/disputes', adminController.getDisputes);
router.patch('/disputes/:id/resolve', disputeController.resolveDispute);
router.patch('/disputes/:id/reject', disputeController.rejectDispute);

// ── Payments ──────────────────────────────────────────────────────────────────
router.get('/payments', adminController.getPayments);

// ── Reports ───────────────────────────────────────────────────────────────────
router.get('/reports', adminController.getReports);

// ── System status ─────────────────────────────────────────────────────────────
router.get('/system-status', adminController.getSystemStatus);

// ── Broadcast ─────────────────────────────────────────────────────────────────
router.post('/broadcast', adminController.broadcast);

// ── Legal content ─────────────────────────────────────────────────────────────
router.get('/legal/terms', legalController.getTerms);
router.put('/legal/terms', legalController.updateTerms);

// ── App settings ──────────────────────────────────────────────────────────────
router.get('/settings', settingsController.getSettings);
router.patch('/settings', settingsController.updateSettings);

// ── Service areas (runner "areas of operation" list) ────────────────────────────
router.get('/locations', locationController.adminList);
router.post('/locations', locationController.adminCreate);
router.patch('/locations/:id', locationController.adminUpdate);
router.delete('/locations/:id', locationController.adminDelete);

// ── Notification campaigns ────────────────────────────────────────────────────
// Specific/static paths must come before ':id' so Express doesn't swallow them.
router.get('/notification-campaigns/stats', notificationCampaignController.stats);
router.get('/notification-campaigns/system-events', notificationCampaignController.systemEvents);
router.get('/notification-campaigns/audience-count', notificationCampaignController.previewAudienceCount);
router.post(
  '/notification-campaigns/banner-image',
  notificationCampaignController.uploadBannerMiddleware,
  notificationCampaignController.uploadBanner,
);
router.get('/notification-campaigns', notificationCampaignController.list);
router.post('/notification-campaigns', validate(schemas.notificationCampaignPayload), notificationCampaignController.create);
router.get('/notification-campaigns/:id', notificationCampaignController.getOne);
router.patch('/notification-campaigns/:id', validate(schemas.notificationCampaignPayload), notificationCampaignController.update);
router.post('/notification-campaigns/:id/duplicate', notificationCampaignController.duplicate);
router.delete('/notification-campaigns/:id', notificationCampaignController.remove);

// ── Announcements (in-app modal/banner/bottom-sheet — separate from push) ────
// Specific/static paths must come before ':id' so Express doesn't swallow them.
router.post(
  '/announcements/image',
  announcementController.uploadImageMiddleware,
  announcementController.uploadImage,
);
router.get('/announcements', announcementController.list);
router.post('/announcements', validate(schemas.announcementPayload), announcementController.create);
router.get('/announcements/:id', announcementController.getOne);
router.put('/announcements/:id', validate(schemas.announcementPayload), announcementController.update);
router.delete('/announcements/:id', announcementController.remove);
router.patch('/announcements/:id/activate', announcementController.activate);
router.patch('/announcements/:id/deactivate', announcementController.deactivate);
router.post('/announcements/:id/duplicate', announcementController.duplicate);
router.get('/announcements/:id/analytics', announcementController.analytics);

module.exports = router;
