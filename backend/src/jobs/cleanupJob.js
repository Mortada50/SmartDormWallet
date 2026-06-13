/**
 * @file cleanupJob.js
 * @description Daily database hygiene job — removes stale archived notifications
 *              and expired token blacklist entries.
 *
 * ██████████████████████████████████████████████████████████████████████████
 * ██  CLEANUP OPERATIONS                                                  ██
 * ██████████████████████████████████████████████████████████████████████████
 *
 * OPERATION 1 — Delete Stale Archived Notifications:
 *   Condition: archivedAt IS NOT NULL AND archivedAt < (now - 30 days)
 *   Method: Notification.deleteMany() — bulk deletion, no session needed.
 *   Why safe: Archived notifications have already been processed; they serve
 *              no financial purpose. Deletion is irreversible but intentional.
 *   Log: COUNT of deleted documents.
 *
 * OPERATION 2 — Prune Expired Token Blacklist Entries:
 *   Condition: expiresAt < now
 *   Method: TokenBlacklist.deleteMany()
 *   Why safe: MongoDB TTL index (expireAfterSeconds: 0) already handles this
 *              automatically. This job is a SECOND LINE OF DEFENCE to catch
 *              any entries that slip through (e.g., index lag, Atlas M2 limits).
 *   Log: COUNT of deleted documents.
 *
 * SCHEDULE: 0 0 * * * (daily at midnight UTC)
 *
 * CONCURRENCY GUARD: Redis SETNX lock (TTL: 30 min) prevents double-runs.
 *
 * ERROR POLICY: Errors are logged but DO NOT crash the process.
 *               The job retries the next day automatically.
 *
 * SPEC REFERENCES: §15 (Redis TTL), §12 (Token security), §13 (Data hygiene)
 *
 * @module jobs/cleanupJob
 */

'use strict';

const cron   = require('node-cron');
const logger = require('../config/logger');
const { getClient } = require('../config/redis');
const { Notification, TokenBlacklist } = require('../models');

// ---------------------------------------------------------------------------
// Lock helpers (local — mirrors cronScheduler.js approach)
// ---------------------------------------------------------------------------

async function acquireLock(lockKey, ttlSecs) {
  try {
    const client = await getClient();
    if (client._isRedis) {
      const result = await client.set(lockKey, '1', 'NX', 'EX', ttlSecs);
      return result === 'OK';
    } else {
      const existing = await client.get(lockKey);
      if (existing) return false;
      await client.set(lockKey, '1', 'EX', ttlSecs);
      return true;
    }
  } catch {
    return true; // Fail-open
  }
}

async function releaseLock(lockKey) {
  try {
    const client = await getClient();
    await client.del(lockKey);
  } catch { /* silent */ }
}

// ---------------------------------------------------------------------------
// OPERATION 1 — Delete Stale Archived Notifications
// ---------------------------------------------------------------------------

/**
 * Deletes notification documents that were archived more than 30 days ago.
 *
 * SAFETY:
 *   - Only deletes documents where archivedAt IS NOT NULL (archived, not active).
 *   - 30-day grace period ensures users have enough time to read before archival.
 *   - This is a data hygiene operation — not a financial operation.
 *
 * @returns {Promise<number>} Number of deleted documents.
 */
async function deleteStaleNotifications() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const result = await Notification.deleteMany({
    archivedAt: { $lt: thirtyDaysAgo },
  });

  return result.deletedCount;
}

// ---------------------------------------------------------------------------
// OPERATION 2 — Prune Expired Token Blacklist
// ---------------------------------------------------------------------------

/**
 * Deletes TokenBlacklist documents whose expiresAt has passed.
 *
 * WHY THIS EXISTS:
 *   MongoDB TTL indexes run on a background thread every 60 seconds.
 *   On Atlas M2 / M5, the TTL thread may lag under load.
 *   This explicit deletion catches any stale entries the TTL index missed.
 *
 *   An expired blacklist entry is harmless (the JWT itself is expired too),
 *   but accumulation wastes storage and slows lookup queries.
 *
 * @returns {Promise<number>} Number of deleted documents.
 */
async function pruneExpiredTokens() {
  const result = await TokenBlacklist.deleteMany({
    expiresAt: { $lt: new Date() },
  });

  return result.deletedCount;
}

// ---------------------------------------------------------------------------
// Master cleanup runner
// ---------------------------------------------------------------------------

/**
 * Runs all cleanup operations sequentially.
 * Each operation runs independently — failure of one does not block others.
 *
 * @returns {Promise<void>}
 */
async function runCleanup() {
  const LOCK_KEY = 'cron:lock:daily_cleanup';
  const LOCK_TTL = 1800; // 30 min
  const JOB_NAME = 'Daily Cleanup';
  const startTime = Date.now();

  logger.info(`[${JOB_NAME}] ⏰ بدء مهمة التنظيف اليومي`);

  const acquired = await acquireLock(LOCK_KEY, LOCK_TTL);
  if (!acquired) {
    logger.warn(`[${JOB_NAME}] ⚠️ المهمة قيد التشغيل — تم التخطي`);
    return;
  }

  const results = {
    notifications: { deleted: 0, error: null },
    tokens: { deleted: 0, error: null },
  };

  // ── Operation 1: Stale Notifications ────────────────────────────────────
  try {
    results.notifications.deleted = await deleteStaleNotifications();
    logger.info(`[${JOB_NAME}] 🗑️  الإشعارات المؤرشفة المحذوفة: ${results.notifications.deleted}`);
  } catch (err) {
    results.notifications.error = err.message;
    logger.error(`[${JOB_NAME}] ❌ فشل حذف الإشعارات المؤرشفة`, {
      error: err.message,
    });
  }

  // ── Operation 2: Expired Token Blacklist ─────────────────────────────────
  try {
    results.tokens.deleted = await pruneExpiredTokens();
    logger.info(`[${JOB_NAME}] 🗑️  الرموز المنتهية الصلاحية المحذوفة: ${results.tokens.deleted}`);
  } catch (err) {
    results.tokens.error = err.message;
    logger.error(`[${JOB_NAME}] ❌ فشل تنظيف قائمة الرموز الملغاة`, {
      error: err.message,
    });
  }

  const durationMs = Date.now() - startTime;
  const hasErrors = results.notifications.error || results.tokens.error;

  logger.info(`[${JOB_NAME}] ${hasErrors ? '⚠️ اكتملت مع أخطاء' : '✅ اكتملت بنجاح'}`, {
    durationMs,
    notifications: results.notifications,
    tokens: results.tokens,
  });

  await releaseLock(LOCK_KEY);
}

// ---------------------------------------------------------------------------
// Scheduler registration
// ---------------------------------------------------------------------------

/**
 * Registers the daily cleanup cron job.
 * Called from server.js after DB connection.
 *
 * @returns {{ job: object, stop: Function }}
 */
function startCleanupJob() {
  const job = cron.schedule(
    '0 0 * * *',   // Daily at midnight UTC
    () => {
      runCleanup().catch(err => {
        logger.error('[cleanupJob] خطأ غير محصور في مهمة التنظيف اليومي', {
          error: err.message,
          stack: err.stack,
        });
      });
    },
    {
      scheduled: true,
      timezone: 'UTC',
    }
  );

  logger.info('[cleanupJob] ✅ جدول مهمة التنظيف اليومي مُفعَّل (0 0 * * *)');

  return {
    job,
    stop: () => {
      job.stop();
      logger.info('[cleanupJob] تم إيقاف مهمة التنظيف اليومي');
    },
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  startCleanupJob,
  // Export for manual triggering / testing
  runCleanup,
  deleteStaleNotifications,
  pruneExpiredTokens,
};
