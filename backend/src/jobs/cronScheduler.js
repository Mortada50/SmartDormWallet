/**
 * @file cronScheduler.js
 * @description Automated cron job scheduler for financial system maintenance.
 *
 * ██████████████████████████████████████████████████████████████████████████
 * ██  SCHEDULED JOBS                                                      ██
 * ██████████████████████████████████████████████████████████████████████████
 *
 * JOB 1 — Monthly Financial Snapshot (0 0 1 * *)
 *   Runs: 00:00 on the 1st of every month (UTC)
 *   Purpose:
 *     - Iterates ALL active users
 *     - Computes exact balance + debt via ledgerService (no ledger writes)
 *     - Generates SHA-256 checksum from all transaction publicIds in the period
 *     - Persists a BalanceSnapshot document per user
 *     - Enables O(recent_txns) balance queries instead of O(all_txns_ever)
 *   Failure policy:
 *     - Per-user errors are logged and skipped (partial success is better than none)
 *     - If >50% of users fail: critical alert logged + audit entry created
 *     - Job lock prevents concurrent runs
 *
 * JOB 2 — Expire Stale Deposit Requests (0 * * * *)
 *   Runs: every hour at :00
 *   Purpose:
 *     - Finds all DepositRequests where status='pending' AND expiresAt < now
 *     - Atomically sets status='expired' via bulk updateMany
 *     - Creates a system audit log entry per batch
 *   Failure policy:
 *     - Failure is logged; will retry next hour automatically
 *
 * CONCURRENCY GUARD:
 *   Each job uses a Redis SETNX lock (TTL = expected max runtime + buffer).
 *   If the lock already exists (job still running from previous schedule):
 *     → Job is skipped and a warning is logged.
 *   This prevents thundering-herd issues if a job overruns its schedule window.
 *
 * SPEC REFERENCES: §13 (Data Archiving), §6 (Deposit Expiry), §19 (Audit Log)
 *
 * @module jobs/cronScheduler
 */

'use strict';

const cron   = require('node-cron');
const crypto = require('crypto');

const logger             = require('../config/logger');
const { getClient }      = require('../config/redis');
const { User, BalanceSnapshot, DepositRequest, Transaction } = require('../models');
const { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, ACTOR_ROLES, DEPOSIT_STATUS } = require('../models');
const ledgerService      = require('../services/ledgerService');
const auditLogRepository = require('../repositories/auditLogRepository');

// ---------------------------------------------------------------------------
// Redis distributed lock helpers
// ---------------------------------------------------------------------------

/**
 * Acquires a Redis SETNX lock.
 * Returns true if lock was acquired (job may proceed).
 * Returns false if lock already held (job is already running — skip this run).
 *
 * @param {string} lockKey   - Unique key for this job.
 * @param {number} ttlSecs   - Lock TTL in seconds (safety expiry).
 * @returns {Promise<boolean>}
 */
async function acquireLock(lockKey, ttlSecs) {
  try {
    const client = await getClient();

    if (client._isRedis) {
      // ioredis: SET key value NX EX ttl
      const result = await client.set(lockKey, '1', 'NX', 'EX', ttlSecs);
      return result === 'OK';
    } else {
      // In-process fallback (InProcessCache)
      const existing = await client.get(lockKey);
      if (existing) return false;
      await client.set(lockKey, '1', 'EX', ttlSecs);
      return true;
    }
  } catch (err) {
    // On Redis failure, allow job to run (fail-open for scheduled jobs)
    logger.warn('[cronScheduler] فشل استدعاء قفل Redis — سيتم تشغيل المهمة بدون قفل', {
      lockKey,
      error: err.message,
    });
    return true;
  }
}

/**
 * Releases a Redis lock after job completion.
 * @param {string} lockKey
 */
async function releaseLock(lockKey) {
  try {
    const client = await getClient();
    await client.del(lockKey);
  } catch (err) {
    logger.warn('[cronScheduler] فشل تحرير قفل Redis', { lockKey, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// JOB 1 — Monthly Financial Snapshot
// ---------------------------------------------------------------------------

/**
 * Computes a deterministic SHA-256 checksum for a user's snapshot.
 *
 * INPUT: Sorted array of all transaction publicIds included in the snapshot.
 * The sort order ensures determinism regardless of DB insertion order.
 *
 * @param {string}   userPublicId
 * @param {number}   balanceAtSnapshot
 * @param {number}   debtAtSnapshot
 * @param {string[]} txPublicIds        - Sorted array of transaction publicIds.
 * @param {Date}     snapshotDate
 * @returns {string} SHA-256 hex digest
 */
function computeSnapshotChecksum(userPublicId, balanceAtSnapshot, debtAtSnapshot, txPublicIds, snapshotDate) {
  const payload = [
    userPublicId,
    String(balanceAtSnapshot),
    String(debtAtSnapshot),
    snapshotDate.toISOString(),
    txPublicIds.sort().join(','),
  ].join('|');

  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Processes a single user's monthly snapshot.
 * Computes balance, debt, fetches all tx publicIds, generates checksum, saves.
 *
 * @param {object} user          - Lean user document (has _id, publicId).
 * @param {Date}   snapshotDate  - First day of the month just ended (UTC midnight).
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function processUserSnapshot(user, snapshotDate) {
  try {
    // 1. Check if snapshot already exists for this user/month (idempotent)
    const existing = await BalanceSnapshot.findOne({
      userId: user._id,
      snapshotDate,
    }).lean();

    if (existing) {
      logger.debug('[monthlySnapshot] تم تخطي المستخدم — اللقطة موجودة مسبقاً', {
        userPublicId: user.publicId,
        snapshotDate,
      });
      return { success: true, skipped: true };
    }

    // 2. Calculate balance and debt from ledger (no ledger modification)
    const { balance, debt, transactionCount } = await ledgerService.calculateBalance(
      user._id,
      user.publicId,
      { bypassCache: true }  // Must use live data for monthly snapshot
    );

    // 3. Fetch the last transaction for this user (for lastTransactionId reference)
    const lastTx = await Transaction
      .findOne({ userId: user._id })
      .sort({ createdAt: -1 })
      .select('_id publicId')
      .lean();

    // 4. Fetch ALL transaction publicIds for checksum generation
    //    (only those created before snapshotDate to bound the snapshot)
    const allTxPublicIds = await Transaction
      .find({ userId: user._id, createdAt: { $lt: snapshotDate } })
      .select('publicId')
      .lean()
      .then(txs => txs.map(t => t.publicId));

    // 5. Generate checksum
    const checksum = computeSnapshotChecksum(
      user.publicId,
      balance,
      debt,
      allTxPublicIds,
      snapshotDate
    );

    // 6. Persist snapshot document
    await BalanceSnapshot.create([{
      publicId: crypto.randomUUID(),
      userId: user._id,
      userPublicId: user.publicId,
      snapshotDate,
      balanceAtSnapshot: balance,
      debtAtSnapshot: debt,
      transactionCount,
      lastTransactionId: lastTx?._id || null,
      lastTransactionPublicId: lastTx?.publicId || null,
      checksum,
    }]);

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * CRON JOB: Monthly Financial Snapshot
 * Schedule: 0 0 1 * * (midnight on 1st of each month, UTC)
 *
 * Iterates all active users in batches of 50 to avoid memory spikes,
 * then persists a BalanceSnapshot per user for the month just ended.
 */
async function runMonthlySnapshot() {
  const LOCK_KEY = 'cron:lock:monthly_snapshot';
  const LOCK_TTL = 3600; // 1 hour max runtime
  const JOB_NAME = 'Monthly Financial Snapshot';
  const startTime = Date.now();

  logger.info(`[${JOB_NAME}] ⏰ بدء مهمة اللقطة الشهرية`);

  // Acquire lock — skip if already running
  const acquired = await acquireLock(LOCK_KEY, LOCK_TTL);
  if (!acquired) {
    logger.warn(`[${JOB_NAME}] ⚠️ المهمة قيد التشغيل بالفعل — تم التخطي`);
    return;
  }

  // The snapshot date = first day of the CURRENT month (which just started)
  // We're snapshotting the month that just ENDED.
  const now = new Date();
  const snapshotDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const errors = [];

  try {
    // Process users in batches to avoid loading all into memory
    const BATCH_SIZE = 50;
    let lastId = null;
    let hasMore = true;

    while (hasMore) {
      const query = { status: 'active' };
      if (lastId) query._id = { $gt: lastId };

      const users = await User
        .find(query)
        .sort({ _id: 1 })
        .limit(BATCH_SIZE)
        .select('_id publicId fullName')
        .lean();

      if (users.length === 0) {
        hasMore = false;
        break;
      }

      // Process this batch in parallel (bounded concurrency)
      const batchResults = await Promise.all(
        users.map(user => processUserSnapshot(user, snapshotDate))
      );

      for (let i = 0; i < users.length; i++) {
        const result = batchResults[i];
        processed++;

        if (result.skipped) {
          skipped++;
        } else if (result.success) {
          succeeded++;
        } else {
          failed++;
          errors.push({ userPublicId: users[i].publicId, error: result.error });
          logger.warn(`[${JOB_NAME}] فشل معالجة مستخدم`, {
            userPublicId: users[i].publicId,
            error: result.error,
          });
        }
      }

      lastId = users[users.length - 1]._id;
      hasMore = users.length === BATCH_SIZE;
    }

    const durationMs = Date.now() - startTime;
    const failureRate = processed > 0 ? failed / processed : 0;

    // Critical alert: >50% failure rate
    if (failureRate > 0.5) {
      logger.error(`[${JOB_NAME}] 🔴 نسبة فشل حرجة`, {
        processed,
        succeeded,
        failed,
        failureRate: `${(failureRate * 100).toFixed(1)}%`,
        durationMs,
      });

      await auditLogRepository.createLog({
        actorId: null,
        actorPublicId: 'system',
        actorRole: ACTOR_ROLES.SYSTEM,
        actorName: 'النظام',
        action: AUDIT_ACTIONS.ANOMALY_FLAGGED,
        entityType: AUDIT_ENTITY_TYPES.SYSTEM,
        metadata: {
          jobName: JOB_NAME,
          snapshotDate,
          processed,
          succeeded,
          failed,
          failureRate: `${(failureRate * 100).toFixed(1)}%`,
          sampleErrors: errors.slice(0, 5),
          durationMs,
          alert: 'نسبة فشل اللقطة الشهرية تجاوزت 50% — يلزم التحقيق',
        },
      });
    } else {
      logger.info(`[${JOB_NAME}] ✅ اكتملت مهمة اللقطة الشهرية`, {
        processed,
        succeeded,
        skipped,
        failed,
        durationMs,
        snapshotDate,
      });

      // Normal completion audit log
      await auditLogRepository.createLog({
        actorId: null,
        actorPublicId: 'system',
        actorRole: ACTOR_ROLES.SYSTEM,
        actorName: 'النظام',
        action: AUDIT_ACTIONS.BACKUP_CREATED,
        entityType: AUDIT_ENTITY_TYPES.SYSTEM,
        metadata: {
          jobName: JOB_NAME,
          snapshotDate,
          processed,
          succeeded,
          skipped,
          failed,
          durationMs,
        },
      });
    }
  } catch (err) {
    // Catastrophic failure — the job itself crashed
    logger.error(`[${JOB_NAME}] 🔴 خطأ حرج في مهمة اللقطة الشهرية`, {
      error: err.message,
      stack: err.stack,
      processed,
      durationMs: Date.now() - startTime,
    });

    await auditLogRepository.createLog({
      actorId: null,
      actorPublicId: 'system',
      actorRole: ACTOR_ROLES.SYSTEM,
      actorName: 'النظام',
      action: AUDIT_ACTIONS.ANOMALY_FLAGGED,
      entityType: AUDIT_ENTITY_TYPES.SYSTEM,
      metadata: {
        jobName: JOB_NAME,
        snapshotDate,
        criticalError: err.message,
        processedBeforeFailure: processed,
        alert: 'فشل كارثي في مهمة اللقطة الشهرية',
      },
    });
  } finally {
    await releaseLock(LOCK_KEY);
  }
}

// ---------------------------------------------------------------------------
// JOB 2 — Expire Stale Deposit Requests
// ---------------------------------------------------------------------------

/**
 * CRON JOB: Expire Stale Deposit Requests
 * Schedule: 0 * * * * (top of every hour)
 *
 * Finds all deposit requests that are:
 *   - status = 'pending'
 *   - expiresAt < now
 *
 * Atomically updates their status to 'expired' via a single updateMany.
 * This is safe without a session because:
 *   - No ledger writes occur (expiry does not create transactions)
 *   - updateMany is atomic at the document level in MongoDB
 */
async function runExpireDepositRequests() {
  const LOCK_KEY = 'cron:lock:expire_deposits';
  const LOCK_TTL = 300; // 5 min max runtime
  const JOB_NAME = 'Expire Deposit Requests';
  const startTime = Date.now();

  // Acquire lock
  const acquired = await acquireLock(LOCK_KEY, LOCK_TTL);
  if (!acquired) {
    logger.debug(`[${JOB_NAME}] المهمة قيد التشغيل — تم التخطي`);
    return;
  }

  try {
    const now = new Date();

    const result = await DepositRequest.updateMany(
      {
        status: DEPOSIT_STATUS.PENDING,
        expiresAt: { $lt: now },
      },
      {
        $set: { status: DEPOSIT_STATUS.EXPIRED },
      }
    );

    const expiredCount = result.modifiedCount;

    if (expiredCount > 0) {
      logger.info(`[${JOB_NAME}] ✅ تم إلغاء ${expiredCount} طلب إيداع منتهي الصلاحية`, {
        expiredCount,
        durationMs: Date.now() - startTime,
      });

      // System audit log for the batch expiry
      await auditLogRepository.createLog({
        actorId: null,
        actorPublicId: 'system',
        actorRole: ACTOR_ROLES.SYSTEM,
        actorName: 'النظام',
        action: AUDIT_ACTIONS.SYSTEM_DEPOSIT_EXPIRED,
        entityType: AUDIT_ENTITY_TYPES.DEPOSIT_REQUEST,
        metadata: {
          jobName: JOB_NAME,
          expiredCount,
          ranAt: now.toISOString(),
          durationMs: Date.now() - startTime,
        },
      });
    } else {
      logger.debug(`[${JOB_NAME}] لا توجد طلبات إيداع منتهية الصلاحية`);
    }
  } catch (err) {
    logger.error(`[${JOB_NAME}] 🔴 خطأ في مهمة انتهاء صلاحية طلبات الإيداع`, {
      error: err.message,
      stack: err.stack,
    });
  } finally {
    await releaseLock(LOCK_KEY);
  }
}

// ---------------------------------------------------------------------------
// Scheduler registration
// ---------------------------------------------------------------------------

/**
 * Registers all cron jobs and starts the scheduler.
 * Called once from server.js after the DB connection is established.
 *
 * @returns {{ jobs: object[], stop: Function }}
 */
function startScheduler() {
  const jobs = [];

  // ── JOB 1: Monthly Snapshot — 00:00 on 1st of every month (UTC) ───────────
  const monthlySnapshotJob = cron.schedule(
    '0 0 1 * *',
    () => {
      runMonthlySnapshot().catch(err => {
        logger.error('[cronScheduler] خطأ غير محصور في مهمة اللقطة الشهرية', {
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
  jobs.push(monthlySnapshotJob);
  logger.info('[cronScheduler] ✅ جدول مهمة اللقطة الشهرية مُفعَّل (0 0 1 * *)');

  // ── JOB 2: Expire Deposits — top of every hour ────────────────────────────
  const expireDepositsJob = cron.schedule(
    '0 * * * *',
    () => {
      runExpireDepositRequests().catch(err => {
        logger.error('[cronScheduler] خطأ غير محصور في مهمة انتهاء طلبات الإيداع', {
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
  jobs.push(expireDepositsJob);
  logger.info('[cronScheduler] ✅ جدول مهمة انتهاء صلاحية الإيداعات مُفعَّل (0 * * * *)');

  // Graceful stop function
  const stop = () => {
    jobs.forEach(j => j.stop());
    logger.info('[cronScheduler] تم إيقاف جميع مهام الـ Cron');
  };

  return { jobs, stop };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  startScheduler,
  // Export individual runners for testing / manual triggering
  runMonthlySnapshot,
  runExpireDepositRequests,
  // Export helpers for unit testing
  computeSnapshotChecksum,
};
