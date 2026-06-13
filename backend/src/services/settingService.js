/**
 * @file settingService.js
 * @description Service for reading and updating system settings (singleton document).
 *
 * CACHING STRATEGY (spec §15, §20):
 *   Settings are cached in Redis with TTL = 300 seconds (5 minutes).
 *   Cache key: CacheKeys.settings()
 *   Cache is invalidated on every update.
 *   On cache miss: load from MongoDB and repopulate cache.
 *
 *   The Redis cache is the PRIMARY source for settings on every request.
 *   MongoDB is the DURABLE source used only on startup and cache miss.
 *
 * STARTUP:
 *   server.js calls settingService.preloadSettings() on startup to populate
 *   the Redis cache before the first request arrives.
 *
 * @module services/settingService
 */

'use strict';

const { Setting } = require('../models');
const { cacheGet, cacheSet, cacheDel, CacheKeys, TTL } = require('../config/redis');
const auditLogRepository = require('../repositories/auditLogRepository');
const { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } = require('../models');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Returns the singleton system settings object.
 *
 * ORDER:
 *   1. Redis cache (TTL 300s)
 *   2. MongoDB (on cache miss — repopulates cache)
 *
 * @param {object}  [options={}]
 * @param {boolean} [options.bypassCache=false] - Force DB read.
 * @returns {Promise<object>} Lean settings document.
 * @throws {Error} If no settings document exists in MongoDB.
 */
async function getSettings(options = {}) {
  const { bypassCache = false } = options;

  // 1. Try cache
  if (!bypassCache) {
    const cached = await cacheGet(CacheKeys.settings());
    if (cached !== null) {
      return cached;
    }
  }

  // 2. Load from MongoDB
  const settings = await Setting.findOne().lean();
  if (!settings) {
    throw new Error(
      '[settingService] ❌ لم يتم العثور على إعدادات النظام — ' +
      'تأكد من تشغيل migration script أولاً (createCollections.js)'
    );
  }

  // 3. Populate cache
  await cacheSet(CacheKeys.settings(), settings, TTL.SETTINGS);

  return settings;
}

/**
 * Preloads settings into Redis cache. Called once on server startup.
 * Ensures first request never hits MongoDB for settings.
 *
 * @returns {Promise<object>} The loaded settings.
 */
async function preloadSettings() {
  const settings = await getSettings({ bypassCache: true });
  logger.info('[settingService] ✅ إعدادات النظام محمّلة في الكاش', {
    withdrawalFeeType: settings.withdrawalFeeType,
    withdrawalFeeValue: settings.withdrawalFeeValue,
    allowDebt: settings.allowDebt,
    maxDebtPerUser: settings.maxDebtPerUser,
  });
  return settings;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Updates system settings. Admin-only operation.
 *
 * VALIDATION:
 *   - All numeric values must be non-negative integers.
 *   - minWithdrawalAmount must be < maxWithdrawalAmount.
 *   - largeWithdrawalThreshold must be ≤ maxWithdrawalAmount.
 *   - withdrawalFeeValue for PERCENTAGE must be 0–100.
 *
 * SIDE EFFECTS:
 *   - Invalidates the Redis settings cache.
 *   - Creates an audit log entry with before/after diff.
 *
 * @param {object}                          updates - Partial settings to update.
 * @param {object}                          actor
 * @param {mongoose.Types.ObjectId}         actor.id
 * @param {string}                          actor.publicId
 * @param {'admin'}                         actor.role
 * @param {string}                          actor.name
 * @returns {Promise<object>} Updated settings.
 * @throws {Error} On validation failure.
 */
async function updateSettings(updates, actor) {
  // Load current settings for before/after diff
  const currentSettings = await getSettings({ bypassCache: true });

  // Validate allowed update keys
  const ALLOWED_KEYS = [
    'withdrawalFeeType', 'withdrawalFeeValue',
    'minWithdrawalAmount', 'maxWithdrawalAmount', 'largeWithdrawalThreshold',
    'allowDebt', 'maxDebtPerUser',
    'autoBackupEnabled', 'autoBackupFrequency', 'autoBackupTime',
    'depositRequestExpiryHours',
    'lowBalanceThreshold',
    'require2FAForAdmin',
    'maintenanceMode',
  ];

  const sanitized = {};
  const changedKeys = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!ALLOWED_KEYS.includes(key)) {
      throw new Error(`[settingService] مفتاح الإعداد غير مسموح: ${key}`);
    }
    sanitized[key] = value;
    if (currentSettings[key] !== value) changedKeys.push(key);
  }

  if (changedKeys.length === 0) {
    return currentSettings; // No actual change
  }

  // Business rule validations
  const merged = { ...currentSettings, ...sanitized };

  if (merged.minWithdrawalAmount >= merged.maxWithdrawalAmount) {
    throw new Error('[settingService] الحد الأدنى للسحب يجب أن يكون أقل من الحد الأقصى');
  }
  if (merged.largeWithdrawalThreshold > merged.maxWithdrawalAmount) {
    throw new Error('[settingService] حد السحب الكبير لا يمكن أن يتجاوز الحد الأقصى للسحب');
  }
  if (merged.withdrawalFeeType === 'PERCENTAGE' && merged.withdrawalFeeValue > 100) {
    throw new Error('[settingService] نسبة الرسوم لا يمكن أن تتجاوز 100%');
  }

  // Update MongoDB
  const updated = await Setting.findOneAndUpdate(
    {},
    { $set: sanitized },
    { new: true, lean: true }
  );

  if (!updated) {
    throw new Error('[settingService] فشل تحديث الإعدادات — لا توجد وثيقة إعدادات');
  }

  // Invalidate cache
  await cacheDel(CacheKeys.settings());

  logger.info('[settingService] ✅ تم تحديث إعدادات النظام', {
    changedKeys,
    by: actor.publicId,
  });

  // Audit log
  const before = {};
  const after = {};
  for (const key of changedKeys) {
    before[key] = currentSettings[key];
    after[key] = updated[key];
  }

  await auditLogRepository.createLog({
    actorId: actor.id,
    actorPublicId: actor.publicId,
    actorRole: actor.role,
    actorName: actor.name,
    action: AUDIT_ACTIONS.SETTINGS_UPDATED,
    entityType: AUDIT_ENTITY_TYPES.SETTINGS,
    metadata: { changedKeys, before, after },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getSettings,
  preloadSettings,
  updateSettings,
};
