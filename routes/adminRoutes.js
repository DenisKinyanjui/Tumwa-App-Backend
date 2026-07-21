const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const disputeController = require('../controllers/disputeController');
const legalController = require('../controllers/legalController');
const settingsController = require('../controllers/settingsController');
const locationController = require('../controllers/locationController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

// All admin routes require a valid JWT AND admin role
router.use(protect);
router.use(restrictTo('admin'));

// ── Users ─────────────────────────────────────────────────────────────────────
router.get('/users', adminController.getUsers);
router.get('/users/:id', adminController.getUser);
router.patch('/users/:id', adminController.updateUser);
router.patch('/users/:id/working-capital', adminController.setWorkingCapitalLimit);
router.delete('/users/:id', adminController.deleteUser);

// ── Runner Verifications ──────────────────────────────────────────────────────
router.get('/verifications/:userId', adminController.getVerification);
router.patch('/verifications/:userId/approve', adminController.approveVerification);
router.patch('/verifications/:userId/reject', adminController.rejectVerification);

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

// ── System status ─────────────────────────────────────────────────────────────
router.get('/system-status', adminController.getSystemStatus);

// ── Broadcast ─────────────────────────────────────────────────────────────────
router.post('/broadcast', adminController.broadcast);

// ── Legal content ─────────────────────────────────────────────────────────────
router.get('/legal/terms', legalController.getTerms);
router.put('/legal/terms', legalController.updateTerms);

// ── App settings ──────────────────────────────────────────────────────────────
router.get('/settings', settingsController.getSettings);
router.patch('/settings', settingsController.updateSettings);

// ── Service areas (runner "areas of operation" list) ────────────────────────────
router.get('/locations', locationController.adminList);
router.post('/locations', locationController.adminCreate);
router.patch('/locations/:id', locationController.adminUpdate);
router.delete('/locations/:id', locationController.adminDelete);

module.exports = router;
