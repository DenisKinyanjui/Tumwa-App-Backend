const { createLogger, format, transports } = require('winston');
const path = require('path');
const fs = require('fs');

// Vercel (and other serverless platforms) ship a read-only filesystem outside
// /tmp — file transports throw EROFS there, which becomes an uncaughtException
// and kills the function on every invocation. Skip file logging in that case;
// Vercel captures stdout/stderr automatically.
const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

// ── Ensure logs directory exists ──────────────────────────────────────────────
const logsDir = path.join(process.cwd(), 'logs');
if (!isServerless && !fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// ── Log formats ───────────────────────────────────────────────────────────────

const consoleFormat = format.combine(
  format.colorize(),
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length
      ? '\n' + JSON.stringify(meta, null, 2)
      : '';
    return `[${timestamp}] ${level}: ${message}${metaStr}`;
  })
);

const fileFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.errors({ stack: true }),
  format.json()
);

const isProduction = process.env.NODE_ENV === 'production';

// ── Transport setup ───────────────────────────────────────────────────────────

const buildFileTransport = (filename, level) => {
  // Use DailyRotateFile if available, fall back to plain File
  try {
    require.resolve('winston-daily-rotate-file');
    const DailyRotateFile = require('winston-daily-rotate-file');
    return new DailyRotateFile({
      filename: path.join(logsDir, `${filename}-%DATE%.log`),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      level,
      format: fileFormat,
    });
  } catch {
    return new transports.File({
      filename: path.join(logsDir, `${filename}.log`),
      level,
      format: fileFormat,
      maxsize: 20 * 1024 * 1024, // 20 MB
      maxFiles: 5,
      tailable: true,
    });
  }
};

const loggerTransports = isServerless
  ? []
  : [buildFileTransport('combined', 'info'), buildFileTransport('error', 'error')];

if (!isProduction) {
  loggerTransports.push(new transports.Console({ format: consoleFormat }));
} else if (isServerless) {
  // No file transport here — console is the only durable log sink Vercel captures.
  loggerTransports.push(
    new transports.Console({
      level: process.env.LOG_LEVEL || 'info',
      format: format.combine(format.timestamp(), format.json()),
    })
  );
} else {
  // In production keep console output minimal (for systemd/pm2 journal capture)
  loggerTransports.push(
    new transports.Console({
      level: 'warn',
      format: format.combine(format.timestamp(), format.json()),
    })
  );
}

// ── Main logger ───────────────────────────────────────────────────────────────

const logger = createLogger({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  transports: loggerTransports,
  exitOnError: false,
});

// ── Specialised child loggers ─────────────────────────────────────────────────
// Each domain logger adds a `service` field so logs can be filtered.

logger.http = logger.child({ service: 'http' });
logger.auth = logger.child({ service: 'auth' });
logger.payment = logger.child({ service: 'payment' });
logger.dispute = logger.child({ service: 'dispute' });
logger.wallet = logger.child({ service: 'wallet' });

// ── Express request logger middleware ─────────────────────────────────────────

logger.requestMiddleware = (req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    logger.http[level](`${req.method} ${req.originalUrl}`, {
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      responseTime: `${ms}ms`,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      userId: req.user?._id ?? null,
    });
  });

  next();
};

// ── Unhandled rejection / exception ──────────────────────────────────────────

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection', { reason: reason?.message ?? reason });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception — shutting down', { error: err.message, stack: err.stack });
  process.exit(1);
});

module.exports = logger;
