const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { adminLimiter } = require('../middlewares/rateLimiter');

// All report routes require a valid JWT and admin role. The rate limiter is
// mounted after these so it can key by req.user._id — see rateLimiter.js.
router.use(protect);
router.use(restrictTo('admin', 'superadmin'));
router.use(adminLimiter);

// GET /api/admin/reports/errands    — paginated errand list + summary
// GET /api/admin/reports/payments   — paginated payment list + summary
// GET /api/admin/reports/runners    — paginated runner performance table + summary
// GET /api/admin/reports/disputes   — paginated dispute list + summary
// GET /api/admin/reports/customers  — paginated customer activity list + summary

router.get('/errands', reportController.errandsReport);
router.get('/payments', reportController.paymentsReport);
router.get('/runners', reportController.runnersReport);
router.get('/disputes', reportController.disputesReport);
router.get('/customers', reportController.customersReport);

module.exports = router;
