const express = require('express');
const router = express.Router();
const legalController = require('../controllers/legalController');

// Public — no auth required, consumed by the mobile app at registration
router.get('/terms', legalController.getTerms);
router.get('/privacy', legalController.getPrivacyPolicy);

module.exports = router;
