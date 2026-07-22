const express = require('express');
const router = express.Router();
const mobileAnnouncementController = require('../controllers/mobileAnnouncementController');
const { protect } = require('../middleware/authMiddleware');

// Any authenticated user (customer or runner) — in-app announcements are not
// admin-only. Kept fully separate from /api/notifications (push/inbox feed).
router.use(protect);

router.get('/', mobileAnnouncementController.getEligible);
router.get('/:id/check', mobileAnnouncementController.checkOne);
router.post('/:id/view', mobileAnnouncementController.view);
router.patch('/views/:viewId/dismiss', mobileAnnouncementController.dismiss);
router.patch('/views/:viewId/click', mobileAnnouncementController.click);

module.exports = router;
