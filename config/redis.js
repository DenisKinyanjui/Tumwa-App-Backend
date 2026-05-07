/**
 * Redis client — optional dependency.
 *
 * If REDIS_URL is not set, all methods degrade silently:
 *   get()  → null
 *   set()  → no-op
 *   del()  → no-op
 *
 * This lets the app run without Redis in development / resource-constrained
 * environments while benefiting from caching & token blacklisting in production.
 */
const logger = require('../utils/logger');

let client = null;
let isConnected = false;

const connect = async () => {
  if (!process.env.REDIS_URL) {
    logger.warn('REDIS_URL not set — Redis disabled. Caching and token blacklist will use in-memory fallback.');
    return;
  }

  try {
    const { default: Redis } = await import('ioredis').catch(() => {
      throw new Error('ioredis not installed. Run: npm install ioredis');
    });

    client = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
      connectTimeout: 5000,
      retryStrategy: (times) => {
        if (times > 5) {
          logger.error('Redis: too many retries — giving up');
          return null; // stop retrying
        }
        return Math.min(times * 200, 2000);
      },
    });

    client.on('connect', () => {
      isConnected = true;
      logger.info('Redis connected');
    });
    client.on('error', (err) => {
      isConnected = false;
      logger.error('Redis error', { error: err.message });
    });
    client.on('close', () => {
      isConnected = false;
    });

    await client.connect();
  } catch (err) {
    logger.warn(`Redis unavailable: ${err.message} — continuing without cache`);
    client = null;
  }
};

// ── Safe wrappers — never throw ──────────────────────────────────────────────

const get = async (key) => {
  if (!client || !isConnected) return null;
  try {
    return await client.get(key);
  } catch {
    return null;
  }
};

const set = async (key, value, ttlSeconds) => {
  if (!client || !isConnected) return;
  try {
    if (ttlSeconds) {
      await client.set(key, value, 'EX', ttlSeconds);
    } else {
      await client.set(key, value);
    }
  } catch { /* silent */ }
};

const del = async (key) => {
  if (!client || !isConnected) return;
  try {
    await client.del(key);
  } catch { /* silent */ }
};

const exists = async (key) => {
  if (!client || !isConnected) return false;
  try {
    return (await client.exists(key)) === 1;
  } catch {
    return false;
  }
};

const disconnect = async () => {
  if (client) {
    try {
      await client.quit();
    } catch { /* silent */ }
    client = null;
    isConnected = false;
  }
};

const isAvailable = () => isConnected && client !== null;

module.exports = { connect, disconnect, get, set, del, exists, isAvailable };
