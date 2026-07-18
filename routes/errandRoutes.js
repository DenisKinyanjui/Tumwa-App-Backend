const express = require('express');
const router = express.Router();
const errandController = require('../controllers/errandController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

router.use(protect);

// ─── Shared ──────────────────────────────────────────────────────────────────
router.get('/', errandController.getErrands);
router.get('/runner/mine', restrictTo('runner'), errandController.getRunnerErrands);
router.get('/customer/stats', restrictTo('customer'), errandController.getMyErrandStats);
router.get('/:id', errandController.getErrand);

// ─── Customer ────────────────────────────────────────────────────────────────
// Errands are created by the STK callback after payment — direct creation is admin-only
router.post('/', restrictTo('admin'), errandController.createErrand);
router.patch('/:id/cancel',  restrictTo('customer', 'admin'), errandController.cancelErrand);
router.patch('/:id/dispute', restrictTo('customer', 'admin'), errandController.disputeErrand);
router.patch('/:id/confirm', restrictTo('customer'),          errandController.confirmDelivery);

// ─── Runner ──────────────────────────────────────────────────────────────────
// Matching-system flow: runner responds to an automated offer
router.patch('/:id/accept',        restrictTo('runner'), errandController.acceptErrand);
router.patch('/:id/decline',       restrictTo('runner'), errandController.declineErrand);
router.patch('/:id/runner-cancel', restrictTo('runner'), errandController.runnerCancelErrand);
// Legacy browse-and-accept flow (kept for backward compat / manual assignment)
router.patch('/:id/assign',   restrictTo('runner'), errandController.assignRunner);
router.patch('/:id/start',    restrictTo('runner'), errandController.startErrand);
router.patch(
  '/:id/complete',
  restrictTo('runner'),
  errandController.uploadProofPhoto,
  errandController.completeErrand,
);

// ─── Customer re-match ────────────────────────────────────────────────────────
router.post('/:id/retry-match', restrictTo('customer'), errandController.retryMatch);

// ─── Admin ───────────────────────────────────────────────────────────────────
router.patch('/:id/admin-assign', restrictTo('admin'), errandController.adminAssignRunner);
router.patch('/:id/excuse-cancellation', restrictTo('admin'), errandController.excuseCancellation);

module.exports = router;
