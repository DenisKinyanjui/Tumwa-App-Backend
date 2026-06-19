const express = require('express');
const router = express.Router();
const verificationController = require('../controllers/verificationController');
const { apiLimiter } = require('../middlewares/rateLimiter');

// Public — runner has verified phone but not yet logged in.
// Rate limited to prevent abuse. Multer handles multipart parsing.
router.post(
  '/submit',
  apiLimiter,
  verificationController.uploadMiddleware,
  verificationController.submit
);

module.exports = router;
