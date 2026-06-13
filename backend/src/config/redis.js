/**
 * @file redis.js
 * @description Redis client setup for BullMQ, token blacklist, and caching.
 *
 * Strategy:
 *  - If REDIS_URL is set: connects to the real Redis instance (production).
 *  - If REDIS_URL is absent: uses an in-process Map-based fallback (development
 *    / staging only). The fallback is NOT suitable for multi-instance deployments
 *    because it is not shared across processes.
 *
 * Cache TTLs (spec §15):
 *  - System settings:       300 seconds (5 min)
 *  - User balance snapshot:  30 seconds
 *  - Admin dashboard stats: 120 seconds (2 min)
 *  - Cloudinary signed URLs: NOT cached — generated fresh each time
 *
 * @module config/redis
 */

'use strict';

const env = require('./env');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// In-process fallback cache (non-production only)
// ---------------------------------------------------------------------------

/**
 * Minimal in-process Map that mimics the Redis GET/SET/DEL/EXISTS interface.
 * Each entry stores { value, expiresAt } and is lazily evicted on read.
 *
 * ⚠️  NOT suitable for multi-instance production deployments.
 *     Use Redis in production.
 */
class InProcessCache {
  constructor() {
    this._store = new Map();
    this._isRedis = false;

    // Periodic sweep to prevent unbounded memory growth
    this._sweepInterval = setInterval(() => this._sweep(), 60_000);
    this._sweepInterval.unref(); // Don't keep the process alive
  }

  async get(key) {
    const entry = this._store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return null;
    }
    return entry.value;
  }

  /**
   * @param {string} key
   * @param {string} value
   * @param {string} [mode]  - 'EX' for seconds, ignored for no expiry
   * @param {number} [ttl]   - TTL in seconds when mode === 'EX'
   */
  async set(key, value, mode, ttl) {
    const expiresAt = mode === 'EX' && ttl ? Date.now() + ttl * 1000 : null;
    this._store.set(key, { value, expiresAt });
    return 'OK';
  }

  async del(key) {
    const deleted = this._store.delete(key);
    return deleted ? 1 : 0;
  }

  async exists(key) {
    const entry = this._store.get(key);
    if (!entry) return 0;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return 0;
    }
    return 1;
  }

  async keys(pattern) {
    // Simple glob-to-regex conversion (only supports trailing *)
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return [...this._store.keys()].filter((k) => regex.test(k));
  }

  /** Remove expired entries. */
  _sweep() {
    const now = Date.now();
    for (const [key, entry] of this._store) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this._store.delete(key);
      }
    }
  }

  async quit() {
    clearInterval(this._sweepInterval);
    this._store.clear();
  }
}

// ---------------------------------------------------------------------------
// Redis client factory
// ---------------------------------------------------------------------------

let _client = null;

/**
 * Returns (or lazily creates) the Redis client.
 * Uses ioredis in production; falls back to InProcessCache in development.
 *
 * @returns {Promise<import('ioredis').Redis | InProcessCache>}
 */
async function getClient() {
  if (_client) return _client;

  if (env.REDIS_URL) {
    // Dynamic import so the package is optional in pure-dev setups
    const Redis = require('ioredis');

    _client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      reconnectOnError: (err) => {
        // Reconnect on READONLY errors (happens on Redis failover)
        return err.message.includes('READONLY');
      },
      lazyConnect: false,
    });

    _client._isRedis = true;

    _client.on('connect', () =>
      logger.info('[redis] ✅ تم الاتصال بـ Redis')
    );
    _client.on('error', (err) =>
      logger.error('[redis] خطأ في Redis', { message: err.message })
    );
    _client.on('reconnecting', () =>
      logger.warn('[redis] جاري إعادة الاتصال بـ Redis…')
    );

    await _client.ping();
    logger.info('[redis] Redis client جاهز');
  } else {
    if (env.NODE_ENV === 'production') {
      logger.warn(
        '[redis] ⚠️  REDIS_URL غير مُعيَّن في بيئة الإنتاج — يُستخدم الذاكرة الداخلية كبديل مؤقت'
      );
    } else {
      logger.info('[redis] REDIS_URL غير مُعيَّن — يُستخدم الذاكرة الداخلية (وضع التطوير)');
    }
    _client = new InProcessCache();
  }

  return _client;
}

// ---------------------------------------------------------------------------
// Cache helper wrappers (used by repositories and services)
// ---------------------------------------------------------------------------

/** Cache TTL constants (seconds) — referenced by name to avoid magic numbers */
const TTL = Object.freeze({
  SETTINGS: 300,          // 5 min  (spec §15)
  BALANCE_SNAPSHOT: 30,   // 30 s   (spec §15)
  DASHBOARD_STATS: 120,   // 2 min  (spec §15)
  SESSION_BLOCK: 1800,    // 30 min — login lockout window (spec §12)
  RATE_LIMIT: 3600,       // 1 hr   — rate limit window max
});

/**
 * Get a cached JSON value.
 *
 * @param {string} key
 * @returns {Promise<any|null>} Parsed value or null on miss.
 */
async function cacheGet(key) {
  const client = await getClient();
  const raw = await client.get(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // return as-is if not JSON
  }
}

/**
 * Set a JSON-serialisable value in the cache.
 *
 * @param {string} key
 * @param {any} value - Will be JSON.stringify'd.
 * @param {number} ttlSeconds - Time-to-live in seconds.
 * @returns {Promise<void>}
 */
async function cacheSet(key, value, ttlSeconds) {
  const client = await getClient();
  await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
}

/**
 * Delete one or more cache keys.
 *
 * @param {...string} keys
 * @returns {Promise<void>}
 */
async function cacheDel(...keys) {
  const client = await getClient();
  await Promise.all(keys.map((k) => client.del(k)));
}

/**
 * Check whether a key exists in the cache.
 *
 * @param {string} key
 * @returns {Promise<boolean>}
 */
async function cacheExists(key) {
  const client = await getClient();
  const result = await client.exists(key);
  return result === 1;
}

// ---------------------------------------------------------------------------
// Cache key factories — centralised to prevent key typos across modules
// ---------------------------------------------------------------------------

const CacheKeys = Object.freeze({
  settings: () => 'settings:singleton',
  userBalance: (userId) => `balance:${userId}`,
  dashboardStats: () => 'dashboard:stats',
  tokenBlacklist: (tokenHash) => `token_blacklist:${tokenHash}`,
  loginAttempts: (ip) => `login_attempts:${ip}`,
  userLoginAttempts: (userId) => `user_login_attempts:${userId}`,
  rateLimitKey: (userId, endpoint) => `rate_limit:${userId}:${endpoint}`,
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function disconnectRedis() {
  if (!_client) return;
  try {
    await _client.quit();
    _client = null;
    logger.info('[redis] تم قطع الاتصال بـ Redis');
  } catch (err) {
    logger.warn('[redis] تحذير أثناء إغلاق اتصال Redis', {
      message: err.message,
    });
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getClient,
  cacheGet,
  cacheSet,
  cacheDel,
  cacheExists,
  CacheKeys,
  TTL,
  disconnectRedis,
};
