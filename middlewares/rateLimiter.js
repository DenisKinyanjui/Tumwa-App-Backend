/**
 * Rate limiting middleware.
 *
 * Uses express-rate-limit. When Redis is available, uses a shared store
 * (via rate-limit-redis) so limits are enforced across multiple instances.
 * Falls back to in-memory store otherwise.
 *
 * Available limiters:
 *   authLimiter       — login / register (strict)
 *   sensitiveOpLimiter — refresh token / password change (very strict)
 *   passwordResetLimiter — forgot-password / reset-password (very strict)
 *   apiLimiter        — general API routes
 *   paymentLimiter    — payment initiation (per user ID when authenticated)
 *   adminLimiter      — admin panel routes
 */

const rateLimit = require('express-rate-limit');
const { RATE_LIMITS } = require('../config/security');
const logger = require('../utils/logger');

// ── Store selection ───────────────────────────────────────────────────────────

const buildStore = () => {
  if (!process.env.REDIS_URL) return undefined; // use default MemoryStore

  try {
    const { RedisStore } = require('rate-limit-redis');
    const redis = require('../config/redis');
    // rate-limit-redis needs a sendCommand function
    return new RedisStore({
      sendCommand: (...args) => {
        // Only use if Redis is actually connected
        if (!redis.isAvailable()) throw new Error('Redis not ready');
        return redis.client?.call(...args);
      },
    });
  } catch {
    // Package not installed or Redis not ready — fall back to memory store
    return undefined;
  }
};

// ── Skip function — never rate-limit health checks ────────────────────────────

const skipHealthCheck = (req) => req.path === '/health';

// ── Standard rate-limit error response ───────────────────────────────────────

const rateLimitHandler = (req, res, _next, options) => {
  logger.warn('Rate limit exceeded', {
    ip: req.ip,
    path: req.path,
    method: req.method,
    limit: options.max,
    windowMs: options.windowMs,
    userId: req.user?._id ?? null,
  });

  res.status(429).json({
    status: 'fail',
    message: 'Too many requests. Please wait and try again.',
    retryAfter: Math.ceil(options.windowMs / 1000 / 60), // minutes
  });
};

// ── Limiter factory ───────────────────────────────────────────────────────────

const createLimiter = (config, keyOverride) =>
  rateLimit({
    windowMs: config.windowMs,
    max: config.max,
    standardHeaders: true,   // return RateLimit-* headers
    legacyHeaders: false,     // disable X-RateLimit-* (older format)
    store: buildStore(),
    skip: skipHealthCheck,
    handler: rateLimitHandler,
    // trust proxy is configured at app level (app.set('trust proxy', 1))
    validate: { trustProxy: false, keyGeneratorIpFallback: false },
    ...(keyOverride ? { keyGenerator: keyOverride } : {}),
  });

// ── Auth limiter (login, register) ────────────────────────────────────────────
// Keyed by IP address only — before user is authenticated.
const authLimiter = createLimiter(RATE_LIMITS.AUTH);

// ── Sensitive operations (refresh token, password change) ─────────────────────
const sensitiveOpLimiter = createLimiter(RATE_LIMITS.SENSITIVE);

// ── Forgot-password / reset-password (unauthenticated, email-sending) ─────────
const passwordResetLimiter = createLimiter(RATE_LIMITS.PASSWORD_RESET);

// ── General API limiter ───────────────────────────────────────────────────────
const apiLimiter = createLimiter(RATE_LIMITS.API);

// ── Payment initiation — keyed by authenticated user ID ──────────────────────
// Falls back to IP if user not yet attached to req.
const paymentLimiter = createLimiter(
  RATE_LIMITS.PAYMENT,
  (req) => (req.user ? `payment_${req.user._id}` : req.ip)
);

// ── Admin routes limiter ──────────────────────────────────────────────────────
const adminLimiter = createLimiter(RATE_LIMITS.ADMIN);

module.exports = {
  authLimiter,
  sensitiveOpLimiter,
  passwordResetLimiter,
  apiLimiter,
  paymentLimiter,
  adminLimiter,
};
