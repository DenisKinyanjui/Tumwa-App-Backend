const express = require('express');
const router = express.Router();
const reportGenerationController = require('../controllers/reportGenerationController');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { adminLimiter } = require('../middlewares/rateLimiter');

// Mounted at /api/admin/reports/generated — kept distinct from the bare
// /api/admin/reports (adminRoutes.js's legacy getReports) which is mounted
// earlier in index.js and would otherwise shadow a route at that same path.
router.use(protect);
router.use(restrictTo('admin', 'superadmin'));
router.use(adminLimiter);

// GET    /api/admin/reports/generated            — list generated report files
// POST   /api/admin/reports/generated             — generate a new report file
// GET    /api/admin/reports/generated/:id/download — signed download URL
// DELETE /api/admin/reports/generated/:id          — delete a generated report

router.get('/', reportGenerationController.list);
router.post('/', reportGenerationController.generate);
router.get('/:id/download', reportGenerationController.download);
router.delete('/:id', reportGenerationController.remove);

module.exports = router;
