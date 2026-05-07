const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { protect, verifyRefreshToken } = require('../middleware/authMiddleware');
const { authLimiter, sensitiveOpLimiter } = require('../middlewares/rateLimiter');
const { validate, schemas } = require('../middlewares/validator');

// ── Public routes ─────────────────────────────────────────────────────────────
router.post('/register', authLimiter, validate(schemas.register), authController.register);
router.post('/login', authLimiter, validate(schemas.login), authController.login);

// ── Token rotation — requires valid refresh cookie ────────────────────────────
router.post('/refresh', sensitiveOpLimiter, verifyRefreshToken, authController.refresh);

// ── Authenticated routes ──────────────────────────────────────────────────────
router.use(protect);

router.post('/logout', authController.logout);
router.get('/me', authController.getMe);
router.patch(
  '/change-password',
  sensitiveOpLimiter,
  validate(schemas.changePassword),
  authController.changePassword
);

module.exports = router;
