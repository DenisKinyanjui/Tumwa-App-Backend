const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analyticsController');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { adminLimiter } = require('../middlewares/rateLimiter');

// All analytics routes require a valid JWT and admin role. The rate limiter
// is mounted after these so it can key by req.user._id — see rateLimiter.js.
router.use(protect);
router.use(restrictTo('admin', 'superadmin'));
router.use(adminLimiter);

// GET /api/admin/analytics/overview    — dashboard KPIs
// GET /api/admin/analytics/errands     — errand trends + charts
// GET /api/admin/analytics/payments    — revenue + payment charts
// GET /api/admin/analytics/runners     — runner performance + charts
// GET /api/admin/analytics/customers   — customer activity + charts
// GET /api/admin/analytics/disputes    — dispute trends + charts

router.get('/overview', analyticsController.overview);
router.get('/errands', analyticsController.errands);
router.get('/payments', analyticsController.payments);
router.get('/runners', analyticsController.runners);
router.get('/customers', analyticsController.customers);
router.get('/disputes', analyticsController.disputes);

module.exports = router;
