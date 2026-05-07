const express = require('express');
const router = express.Router();
const disputeController = require('../controllers/disputeController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

router.use(protect);

// Customer or runner raises a dispute
router.post('/', restrictTo('customer', 'runner'), disputeController.raiseDispute);

// Anyone involved can view their own disputes; admin sees all
router.get('/', disputeController.getDisputes);
router.get('/:id', disputeController.getDispute);

// Admin-only actions
router.patch('/:id/review',  restrictTo('admin'), disputeController.reviewDispute);
router.patch('/:id/resolve', restrictTo('admin'), disputeController.resolveDispute);
router.patch('/:id/reject',  restrictTo('admin'), disputeController.rejectDispute);

module.exports = router;
