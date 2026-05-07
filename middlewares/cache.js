/**
 * Redis response caching middleware.
 *
 * Caches GET responses in Redis with a configurable TTL.
 * Cache key = `cache:{method}:{path}:{sorted-query-string}:{userId-or-anon}`.
 * Admin user ID is included so different admins don't share cached responses
 * that may carry user-specific data.
 *
 * Skipped automatically when:
 *  - Redis is not available (graceful no-op)
 *  - Request method is not GET
 *  - Cache-Control: no-cache is sent by client
 *
 * Cache invalidation:
 *  - TTL-based (entries expire automatically)
 *  - Manual: call invalidateCache(pattern) to clear matching keys
 */

const redis = require('../config/redis');
const logger = require('../utils/logger');

// ── Cache key builder ─────────────────────────────────────────────────────────

const buildCacheKey = (req) => {
  const userId = req.user?._id?.toString() ?? 'anon';
  const query = Object.keys(req.query)
    .sort()
    .map((k) => `${k}=${req.query[k]}`)
    .join('&');
  return `cache:${req.method}:${req.path}:${query}:${userId}`;
};

// ── Cache middleware factory ───────────────────────────────────────────────────

/**
 * @param {number} ttlSeconds — how long to cache the response (default: 300s)
 */
const cacheResponse = (ttlSeconds = 300) => {
  return async (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') return next();

    // Respect Cache-Control: no-cache from client
    if (req.headers['cache-control'] === 'no-cache') return next();

    // Skip if Redis is unavailable
    if (!redis.isAvailable()) return next();

    const key = buildCacheKey(req);

    try {
      const cached = await redis.get(key);
      if (cached) {
        const parsed = JSON.parse(cached);
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Cache-Key', key);
        return res.status(200).json(parsed);
      }
    } catch (err) {
      logger.warn('Cache read error', { error: err.message, key });
      return next(); // cache miss — proceed normally
    }

    // Intercept res.json to cache the response before sending
    const originalJson = res.json.bind(res);
    res.json = async (body) => {
      res.json = originalJson; // restore to prevent infinite loop

      // Only cache successful responses
      if (res.statusCode === 200 && body?.status === 'success') {
        try {
          await redis.set(key, JSON.stringify(body), ttlSeconds);
          res.setHeader('X-Cache', 'MISS');
          res.setHeader('X-Cache-TTL', ttlSeconds);
        } catch (err) {
          logger.warn('Cache write error', { error: err.message, key });
        }
      }

      return originalJson(body);
    };

    next();
  };
};

// ── Manual cache invalidation ─────────────────────────────────────────────────

/**
 * Delete all cache keys matching a prefix pattern.
 * Example: invalidateCache('cache:GET:/api/admin/analytics')
 */
const invalidateCache = async (prefix) => {
  if (!redis.isAvailable()) return;

  try {
    // ioredis SCAN-based key deletion — safe for production (no KEYS command)
    const { client } = redis;
    if (!client) return;

    let cursor = '0';
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await client.del(...keys);
        logger.debug(`Cache: invalidated ${keys.length} keys matching ${prefix}*`);
      }
    } while (cursor !== '0');
  } catch (err) {
    logger.warn('Cache invalidation error', { error: err.message, prefix });
  }
};

// ── Pre-built cache durations for analytics routes ────────────────────────────

const { CACHE_TTL } = require('../config/security');

const cacheAnalyticsOverview = cacheResponse(CACHE_TTL.ANALYTICS_OVERVIEW);
const cacheAnalyticsErrands = cacheResponse(CACHE_TTL.ANALYTICS_ERRANDS);
const cacheAnalyticsPayments = cacheResponse(CACHE_TTL.ANALYTICS_PAYMENTS);
const cacheAnalyticsRunners = cacheResponse(CACHE_TTL.ANALYTICS_RUNNERS);
const cacheReports = cacheResponse(CACHE_TTL.REPORTS);

module.exports = {
  cacheResponse,
  invalidateCache,
  cacheAnalyticsOverview,
  cacheAnalyticsErrands,
  cacheAnalyticsPayments,
  cacheAnalyticsRunners,
  cacheReports,
};
