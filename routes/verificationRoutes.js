const express = require('express');
const router = express.Router();
const verificationController = require('../controllers/verificationController');
const { apiLimiter } = require('../middlewares/rateLimiter');
const { protect } = require('../middleware/authMiddleware');

// Public — runner has verified phone but not yet logged in.
// Rate limited to prevent abuse. Issues presigned R2 PUT URLs so the client
// uploads photo bytes directly to R2, keeping /submit's JSON body tiny.
router.post('/upload-urls', apiLimiter, verificationController.getUploadUrls);

router.post('/submit', apiLimiter, verificationController.submit);

// Protected — logged-in runner checking their own status (e.g. to resubmit).
router.get('/status', protect, verificationController.getMyStatus);

module.exports = router;
