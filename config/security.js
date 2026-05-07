/**
 * Central security configuration.
 * All security-related constants are sourced from environment variables
 * with sensible production defaults.
 */

// ── CORS ──────────────────────────────────────────────────────────────────────
const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:3000', 'http://localhost:19006']; // Expo default port

// ── JWT ───────────────────────────────────────────────────────────────────────
const JWT = {
  ACCESS_SECRET: process.env.JWT_SECRET,
  REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET + '_refresh',
  ACCESS_EXPIRES_IN: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  // Refresh token TTL in seconds for cookie max-age (30 days)
  REFRESH_COOKIE_MAX_AGE: parseInt(process.env.JWT_REFRESH_COOKIE_MAX_AGE || '2592000', 10),
};

// ── Cookie ────────────────────────────────────────────────────────────────────
const COOKIE = {
  REFRESH_NAME: 'tumwa_refresh',
  OPTIONS: {
    httpOnly: true,                                      // not accessible via JS
    secure: process.env.NODE_ENV === 'production',       // HTTPS only in prod
    sameSite: process.env.NODE_ENV === 'production' ? 'Strict' : 'Lax',
    maxAge: parseInt(process.env.JWT_REFRESH_COOKIE_MAX_AGE || '2592000', 10) * 1000,
    path: '/api/auth',                                   // scope to auth routes only
  },
};

// ── Rate limiting ─────────────────────────────────────────────────────────────
const RATE_LIMITS = {
  // Strict: authentication endpoints (login, register)
  AUTH: {
    windowMs: 15 * 60 * 1000,  // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_AUTH || '20', 10),
  },
  // Normal: general API usage
  API: {
    windowMs: 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_API || '200', 10),
  },
  // Strict: password change / refresh tokens
  SENSITIVE: {
    windowMs: 60 * 60 * 1000,  // 1 hour
    max: parseInt(process.env.RATE_LIMIT_SENSITIVE || '10', 10),
  },
  // Payment initiation per user
  PAYMENT: {
    windowMs: 10 * 60 * 1000,  // 10 minutes
    max: parseInt(process.env.RATE_LIMIT_PAYMENT || '5', 10),
  },
  // Admin endpoints
  ADMIN: {
    windowMs: 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_ADMIN || '100', 10),
  },
};

// ── Safaricom IP allowlist for M-Pesa callbacks ───────────────────────────────
// Production IPs — update from Safaricom developer portal if they change.
// Callbacks also validated by matching checkoutRequestId/conversationId in DB.
const MPESA_CALLBACK_IPS = process.env.MPESA_CALLBACK_IPS
  ? process.env.MPESA_CALLBACK_IPS.split(',').map((ip) => ip.trim())
  : [
      '196.201.214.200',
      '196.201.214.206',
      '196.201.213.114',
      '196.201.214.207',
      '196.201.214.208',
      '196.201.213.44',
      '196.201.212.127',
      '196.201.212.138',
      '196.201.212.129',
      '196.201.212.136',
      '196.201.212.74',
      '196.201.212.69',
    ];

// In sandbox, Safaricom sends from various IPs — disable IP check unless production.
const MPESA_ENFORCE_IP_CHECK =
  process.env.MPESA_ENFORCE_CALLBACK_IP === 'true' ||
  process.env.MPESA_ENVIRONMENT === 'production';

// ── Body size limits ──────────────────────────────────────────────────────────
const BODY_LIMITS = {
  JSON: '10kb',
  URL_ENCODED: '10kb',
};

// ── Cache TTLs (seconds) ──────────────────────────────────────────────────────
const CACHE_TTL = {
  ANALYTICS_OVERVIEW: 300,   // 5 minutes
  ANALYTICS_ERRANDS: 180,    // 3 minutes
  ANALYTICS_PAYMENTS: 180,
  ANALYTICS_RUNNERS: 300,
  REPORTS: 120,              // 2 minutes
};

// ── Password policy ───────────────────────────────────────────────────────────
const PASSWORD = {
  MIN_LENGTH: 8,
  // Require at least one letter and one number
  REGEX: /^(?=.*[A-Za-z])(?=.*\d).{8,}$/,
};

module.exports = {
  CORS_ORIGINS,
  JWT,
  COOKIE,
  RATE_LIMITS,
  MPESA_CALLBACK_IPS,
  MPESA_ENFORCE_IP_CHECK,
  BODY_LIMITS,
  CACHE_TTL,
  PASSWORD,
};
