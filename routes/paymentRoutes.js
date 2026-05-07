const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

// ── Safaricom callback routes — NO auth middleware ────────────────────────────
// M-Pesa calls these directly. Security is via checkoutRequestId/conversationId
// validation against our Payment collection.
// In production, additionally whitelist Safaricom IP ranges at the load balancer.
router.post('/callback/stk', paymentController.handleSTKCallback);
router.post('/callback/b2c', paymentController.handleB2CCallback);

// ── Authenticated routes ──────────────────────────────────────────────────────
router.use(protect);

router.post('/initiate', restrictTo('customer'), paymentController.initiatePayment);
router.get('/poll/:paymentId', paymentController.getPaymentById);

module.exports = router;
