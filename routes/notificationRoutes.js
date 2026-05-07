const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { protect } = require('../middleware/authMiddleware');

router.use(protect);

// Device token management (must come before /:id routes to avoid param conflicts)
router.patch('/device-token', notificationController.registerDeviceToken);
router.delete('/device-token', notificationController.removeDeviceToken);

// Unread badge count — lightweight endpoint for app header badge
router.get('/unread-count', notificationController.getUnreadCount);

// Bulk operations
router.patch('/read-all', notificationController.markAllAsRead);
router.delete('/', notificationController.clearNotifications);

// List and single-item
router.get('/', notificationController.getNotifications);
router.patch('/:id/read', notificationController.markAsRead);

module.exports = router;
