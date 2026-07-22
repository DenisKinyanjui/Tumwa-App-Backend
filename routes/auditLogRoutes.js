const express = require('express');
const router = express.Router();
const auditLogController = require('../controllers/auditLogController');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { adminLimiter } = require('../middlewares/rateLimiter');
const { validatePagination } = require('../middlewares/validator');

// Mounted at /api/admin/audit-logs — see index.js.
router.use(protect);
router.use(restrictTo('admin', 'superadmin'));
router.use(adminLimiter);

// GET /api/admin/audit-logs                  — paginated, filterable, searchable list
// GET /api/admin/audit-logs/options           — module/action/severity enum values
// GET /api/admin/audit-logs/stats             — KPI summary (total, today, high-risk, failed, most active admin)
// GET /api/admin/audit-logs/security-insights — anomaly scan (failed logins, suspensions, etc.)
// GET /api/admin/audit-logs/:id               — single entry detail

router.get('/', validatePagination, auditLogController.list);
router.get('/options', auditLogController.options);
router.get('/stats', auditLogController.stats);
router.get('/security-insights', auditLogController.securityInsights);
router.get('/:id', auditLogController.getById);

module.exports = router;
