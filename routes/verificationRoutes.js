const express = require('express');
const router = express.Router();
const verificationController = require('../controllers/verificationController');
const { apiLimiter } = require('../middlewares/rateLimiter');
const { protect } = require('../middleware/authMiddleware');

// Public — runner has verified phone but not yet logged in.
// Rate limited to prevent abuse. Multer handles multipart parsing.
router.post(
  '/submit',
  apiLimiter,
  verificationController.uploadMiddleware,
  verificationController.submit
);

// Protected — logged-in runner checking their own status (e.g. to resubmit).
router.get('/status', protect, verificationController.getMyStatus);

module.exports = router;
