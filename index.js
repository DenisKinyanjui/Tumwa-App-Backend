require('dotenv').config();
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');

// ── Internal modules ──────────────────────────────────────────────────────────
const logger = require('./utils/logger');
const redis = require('./config/redis');
const {
  helmetMiddleware,
  compressionMiddleware,
  corsMiddleware,
  mongoSanitizeMiddleware,
  xssSanitize,
  hppProtect,
  mpesaIpGuard,
} = require('./middlewares/security');
const { apiLimiter, adminLimiter } = require('./middlewares/rateLimiter');
const { BODY_LIMITS } = require('./config/security');

// ── Route modules ─────────────────────────────────────────────────────────────
const authRoutes = require('./routes/authRoutes');
const errandRoutes = require('./routes/errandRoutes');
const disputeRoutes = require('./routes/disputeRoutes');
const runnerRoutes = require('./routes/runnerRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const adminRoutes = require('./routes/adminRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const reportRoutes = require('./routes/reportRoutes');
const walletRoutes = require('./routes/walletRoutes');
const verificationRoutes = require('./routes/verificationRoutes');
const legalRoutes = require('./routes/legalRoutes');

const { initSocket } = require('./socket/socketManager');

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();
const httpServer = http.createServer(app);

// Trust first proxy (needed for correct req.ip behind nginx/load balancer)
app.set('trust proxy', 1);

// ── Global security middleware (order matters) ────────────────────────────────
app.use(helmetMiddleware);          // HTTP security headers
app.use(compressionMiddleware);     // gzip responses
app.use(corsMiddleware);            // CORS allow-list
app.use(cookieParser());            // parse httpOnly refresh-token cookies

// Body parsers — applied before sanitizers
app.use(express.json({ limit: BODY_LIMITS.JSON }));
app.use(express.urlencoded({ extended: false, limit: BODY_LIMITS.URL_ENCODED }));

// Input sanitization
app.use(mongoSanitizeMiddleware);   // strip $ / . from input (NoSQL injection)
app.use(xssSanitize);              // escape HTML entities
app.use(hppProtect);               // collapse duplicate query params

// Request logging
app.use(logger.requestMiddleware);

// ── Health check — no auth, no rate limit ─────────────────────────────────────
app.get('/health', (_req, res) => {
  const mongoState = ['disconnected', 'connected', 'connecting', 'disconnecting'];

  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    services: {
      mongodb: mongoState[mongoose.connection.readyState] ?? 'unknown',
      redis: redis.isAvailable() ? 'connected' : 'unavailable',
    },
    memory: {
      heapUsedMB: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1),
      heapTotalMB: (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(1),
    },
  });
});

// ── API routes ────────────────────────────────────────────────────────────────

// Auth — own limiter applied per-route inside authRoutes
app.use('/api/auth', authRoutes);

// M-Pesa callbacks — IP guard only, no auth or rate limit
// (Safaricom calls these directly; rate limit would block legitimate callbacks)
app.use('/api/payments/callback', mpesaIpGuard);

// General API — global rate limiter
app.use('/api', apiLimiter);

app.use('/api/errands', errandRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/disputes', disputeRoutes);
app.use('/api/runners', runnerRoutes);
app.use('/api/verification', verificationRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/legal', legalRoutes);

// Admin routes — stricter rate limiter applied on top
app.use('/api/admin', adminLimiter, adminRoutes);
app.use('/api/admin/analytics', adminLimiter, analyticsRoutes);
app.use('/api/admin/reports', adminLimiter, reportRoutes);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ status: 'fail', message: `Route ${req.originalUrl} not found` });
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, _res, _next) => {
  // CORS errors from our corsMiddleware
  if (err.message?.startsWith('CORS:')) {
    return _res.status(403).json({ status: 'fail', message: err.message });
  }

  logger.error('Unhandled error', {
    message: err.message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
    path: req.path,
    method: req.method,
    userId: req.user?._id ?? null,
  });

  _res.status(err.status || 500).json({
    status: 'error',
    message:
      process.env.NODE_ENV === 'production'
        ? 'Something went wrong. Please try again.'
        : err.message || 'Internal server error',
  });
});

// ── Startup ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

const start = async () => {
  try {
    // Connect MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    logger.info('MongoDB connected');

    // Connect Redis (optional — failure is non-fatal)
    await redis.connect();

    // Initialise Socket.io on the shared HTTP server
    initSocket(httpServer);

    httpServer.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`, {
        env: process.env.NODE_ENV || 'development',
        port: PORT,
      });
    });
  } catch (err) {
    logger.error('Startup failed', { error: err.message });
    process.exit(1);
  }
};

// ── Graceful shutdown ─────────────────────────────────────────────────────────

let isShuttingDown = false;

const shutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`${signal} received — graceful shutdown started`);

  // Stop accepting new connections
  httpServer.close(async () => {
    logger.info('HTTP server closed');

    try {
      await mongoose.connection.close(false);
      logger.info('MongoDB connection closed');
    } catch (err) {
      logger.error('Error closing MongoDB', { error: err.message });
    }

    try {
      await redis.disconnect();
      logger.info('Redis connection closed');
    } catch { /* silent */ }

    logger.info('Graceful shutdown complete');
    process.exit(0);
  });

  // Force-kill if shutdown takes more than 15 seconds
  setTimeout(() => {
    logger.error('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 15_000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
