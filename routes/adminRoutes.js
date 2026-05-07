const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const disputeController = require('../controllers/disputeController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

// All admin routes require a valid JWT AND admin role
router.use(protect);
router.use(restrictTo('admin'));

// ── Users ─────────────────────────────────────────────────────────────────────
router.get('/users', adminController.getUsers);
router.get('/users/:id', adminController.getUser);
router.patch('/users/:id', adminController.updateUser);

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

// ── Broadcast ─────────────────────────────────────────────────────────────────
router.post('/broadcast', adminController.broadcast);

module.exports = router;
