/**
 * @file rateLimitMiddleware.js
 * @description Redis-backed rate limiting middleware (spec §12).
 *
 * RATE LIMIT POLICIES:
 *   - Login endpoint:        10 attempts / 15 min per IP  (brute force protection)
 *   - API endpoints (auth'd): 100 req / 1 min per user
 *   - Admin endpoints:       200 req / 1 min per user
 *   - Public endpoints:       30 req / 1 min per IP
 *
 * IMPLEMENTATION:
 *   Uses Redis INCR + EXPIRE for sliding window counter.
 *   On Redis failure: ALLOWS the request (fail-open) to avoid blocking legitimate users.
 *
 * @module middleware/rateLimitMiddleware
 */

'use strict';

const { cacheGet, cacheSet, getClient, CacheKeys, TTL } = require('../config/redis');
const { sendError } = require('./errorMiddleware');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Core rate limit factory
// ---------------------------------------------------------------------------

/**
 * Creates a rate-limiting middleware.
 *
 * @param {object} options
 * @param {number}   options.max         - Max requests allowed in the window.
 * @param {number}   options.windowSecs  - Window size in seconds.
 * @param {Function} [options.keyFn]     - Custom key function: (req) => string.
 *                                         Default: IP-based.
 * @param {string}   [options.message]   - Arabic error message.
 * @returns {import('express').RequestHandler}
 */
function createRateLimit({ max, windowSecs, keyFn, message }) {
  return async (req, res, next) => {
    try {
      const key = keyFn
        ? keyFn(req)
        : `rate_limit:ip:${req.ip}:${req.path}`;

      const client = await getClient();

      // Atomic increment
      let current;
      if (client._isRedis) {
        // ioredis: use INCR then conditional EXPIRE
        current = await client.incr(key);
        if (current === 1) {
          await client.expire(key, windowSecs);
        }
      } else {
        // In-process fallback: read/increment/write
        const stored = await client.get(key);
        current = stored ? JSON.parse(stored) + 1 : 1;
        await client.set(key, JSON.stringify(current), 'EX', windowSecs);
      }

      // Add rate limit headers
      res.set({
        'X-RateLimit-Limit': max,
        'X-RateLimit-Remaining': Math.max(0, max - current),
      });

      if (current > max) {
        return sendError(
          res,
          429,
          'RATE_LIMIT_EXCEEDED',
          message || `تجاوزت الحد المسموح — حاول بعد ${windowSecs} ثانية`
        );
      }

      next();
    } catch (err) {
      // Fail-open: log and allow request on Redis error
      logger.warn('[rateLimitMiddleware] Redis غير متاح — السماح بالطلب', {
        error: err.message,
        path: req.path,
      });
      next();
    }
  };
}

// ---------------------------------------------------------------------------
// Preconfigured limits (spec §12)
// ---------------------------------------------------------------------------

/** Login brute-force protection: 10 attempts / 15 min / IP */
const loginRateLimit = createRateLimit({
  max: 10,
  windowSecs: 15 * 60,
  keyFn: (req) => `rate_limit:login:${req.ip}`,
  message: 'تجاوزت عدد محاولات الدخول المسموح بها — حاول بعد 15 دقيقة',
});

/** Authenticated API: 100 req / min / user */
const apiRateLimit = createRateLimit({
  max: 100,
  windowSecs: 60,
  keyFn: (req) => `rate_limit:api:${req.user?.publicId || req.ip}`,
  message: 'تجاوزت حد الطلبات المسموح به — حاول بعد دقيقة',
});

/** Admin API: 200 req / min / user */
const adminApiRateLimit = createRateLimit({
  max: 200,
  windowSecs: 60,
  keyFn: (req) => `rate_limit:admin:${req.user?.publicId || req.ip}`,
});

/** Financial Endpoints: 5 req / min / user */
const financialRateLimit = createRateLimit({
  max: 5,
  windowSecs: 60,
  keyFn: (req) => `rate_limit:financial:${req.user?.publicId || req.ip}`,
  message: 'الرجاء الانتظار دقيقة قبل تقديم طلب مالي جديد',
});

/** Public endpoints: 30 req / min / IP */
const publicRateLimit = createRateLimit({
  max: 30,
  windowSecs: 60,
  keyFn: (req) => `rate_limit:public:${req.ip}`,
});

module.exports = {
  createRateLimit,
  loginRateLimit,
  apiRateLimit,
  adminApiRateLimit,
  publicRateLimit,
  financialRateLimit,
};
