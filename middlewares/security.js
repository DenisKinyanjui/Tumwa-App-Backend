/**
 * Security middleware stack.
 * Applied globally in index.js before all routes.
 *
 * Layers (in order of application):
 *  1. Helmet     — sets secure HTTP response headers
 *  2. Compression — gzip/br response compression
 *  3. CORS       — configurable allow-list with method/header control
 *  4. Mongo sanitize — strips $ and . from request input (NoSQL injection)
 *  5. XSS sanitize  — escapes HTML entities in string fields
 *  6. HPP        — prevents HTTP Parameter Pollution (last value wins)
 *  7. M-Pesa IP guard — callback IP allowlist (production only)
 */

const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const { CORS_ORIGINS, MPESA_CALLBACK_IPS, MPESA_ENFORCE_IP_CHECK } = require('../config/security');
const logger = require('../utils/logger');

// ── 1. Helmet ─────────────────────────────────────────────────────────────────

const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    },
  },
  hsts: {
    maxAge: 31536000,    // 1 year in seconds
    includeSubDomains: true,
    preload: true,
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginEmbedderPolicy: false, // disabled — breaks some mobile clients
});

// ── 2. Compression ────────────────────────────────────────────────────────────

const compressionMiddleware = compression({
  level: 6,           // zlib compression level (1 fastest, 9 best)
  threshold: 1024,    // only compress responses > 1 KB
  filter: (req, res) => {
    // Don't compress M-Pesa callback responses (small, no benefit)
    if (req.path.includes('/callback/')) return false;
    return compression.filter(req, res);
  },
});

// ── 3. CORS ───────────────────────────────────────────────────────────────────
// Mobile apps (React Native / Expo) do not send an Origin header for
// in-app HTTP requests, so we allow requests with no Origin.

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    if (CORS_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  credentials: true,   // needed for refresh-token cookie
  maxAge: 86400,       // preflight cache: 24 hours
};

const corsMiddleware = cors(corsOptions);

// ── 4. MongoDB injection sanitization ────────────────────────────────────────
// express-mongo-sanitize reassigns req.query which is read-only in Express 5.
// Custom implementation that mutates objects in place instead.

const stripMongoChars = (obj, req) => {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.includes('.')) {
      logger.warn('MongoDB injection attempt detected', { ip: req.ip, path: req.path, key });
      delete obj[key];
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      stripMongoChars(obj[key], req);
    }
  }
};

const mongoSanitizeMiddleware = (req, _res, next) => {
  if (req.body && typeof req.body === 'object') stripMongoChars(req.body, req);
  if (req.params && typeof req.params === 'object') stripMongoChars(req.params, req);
  // Express 5: req.query is read-only — iterate keys and sanitize values in place
  if (req.query && typeof req.query === 'object') {
    for (const key of Object.keys(req.query)) {
      if (key.startsWith('$') || key.includes('.')) {
        logger.warn('MongoDB injection attempt detected', { ip: req.ip, path: req.path, key });
        delete req.query[key];
      }
    }
  }
  next();
};

// ── 5. XSS sanitization ───────────────────────────────────────────────────────
// Recursively escapes < > " ' & in all string values of req.body / req.query.
// Keeps the API safe even if downstream code accidentally reflects input.

const escapeHtml = (str) =>
  str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');

const sanitizeValue = (value) => {
  if (typeof value === 'string') return escapeHtml(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value !== null && typeof value === 'object') return sanitizeObject(value);
  return value;
};

const sanitizeObject = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = sanitizeValue(v);
  }
  return out;
};

const xssSanitize = (req, _res, next) => {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body);
  }
  // Express 5: req.query is a read-only getter — mutate in place instead of reassigning
  if (req.query && typeof req.query === 'object') {
    const sanitized = sanitizeObject(req.query);
    for (const key of Object.keys(sanitized)) {
      req.query[key] = sanitized[key];
    }
  }
  next();
};

// ── 6. HTTP Parameter Pollution protection ────────────────────────────────────
// If the same query param appears multiple times Express builds an array.
// HPP collapses duplicates so controllers always receive a single string.

const hppProtect = (req, _res, next) => {
  // Whitelist params that legitimately accept arrays (e.g. multi-select filters)
  const whitelist = ['status', 'role', 'type'];

  for (const [key, value] of Object.entries(req.query)) {
    if (Array.isArray(value) && !whitelist.includes(key)) {
      // Keep the last value (most permissive = last wins strategy)
      req.query[key] = value[value.length - 1];
    }
  }
  next();
};

// ── 7. M-Pesa callback IP guard ───────────────────────────────────────────────

const mpesaIpGuard = (req, res, next) => {
  if (!MPESA_ENFORCE_IP_CHECK) return next();

  const clientIp =
    req.headers['x-forwarded-for']?.split(',')[0].trim() ?? req.ip;

  if (!MPESA_CALLBACK_IPS.includes(clientIp)) {
    logger.warn('M-Pesa callback from unauthorized IP', {
      ip: clientIp,
      path: req.path,
    });
    return res.status(403).json({ status: 'fail', message: 'Forbidden' });
  }
  next();
};

module.exports = {
  helmetMiddleware,
  compressionMiddleware,
  corsMiddleware,
  mongoSanitizeMiddleware,
  xssSanitize,
  hppProtect,
  mpesaIpGuard,
};
