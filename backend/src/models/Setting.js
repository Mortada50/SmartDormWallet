/**
 * @file Setting.js
 * @description Mongoose model for system-wide configuration (singleton document).
 *
 * SINGLETON PATTERN:
 *   There is exactly ONE Settings document in the collection.
 *   It is created by createCollections.js with default values.
 *   SettingRepository.get() always returns this single document.
 *   SettingRepository.update() uses findOneAndUpdate({}, ..., { new: true }).
 *
 * CACHING (spec §15, §20):
 *   Settings are cached in Redis with TTL = 300 seconds (5 minutes).
 *   Cache key: CacheKeys.settings() = 'settings:singleton'
 *   Cache is invalidated on every update in SettingService.
 *   SettingRepository.get() always checks cache first; falls back to MongoDB.
 *   ⚠️  Never query MongoDB for settings on every request — always use cache.
 *
 * STARTUP LOAD:
 *   Settings are loaded into the in-process cache on server startup (server.js).
 *   This ensures the first request never hits MongoDB for settings.
 *
 * LEAN HINT:
 *   Setting.findOne().asLean() — always. Settings are read-only in 99% of calls.
 *
 * SPEC REFERENCE: §20 (System Settings)
 *
 * @module models/Setting
 */

'use strict';

const mongoose = require('mongoose');
const { createBaseSchema } = require('./_baseSchema');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const settingSchema = createBaseSchema({
  // ── Withdrawal Fee ─────────────────────────────────────────────────────────
  withdrawalFeeType: {
    type: String,
    enum: {
      values: ['FIXED', 'PERCENTAGE'],
      message: 'نوع الرسوم يجب أن يكون FIXED أو PERCENTAGE',
    },
    required: true,
    default: 'FIXED',
  },

  /**
   * For FIXED: the fee amount in YER.
   * For PERCENTAGE: the percentage (integer 1–100, or 0 for no fee).
   * Fee is always rounded UP (Math.ceil) in WithdrawalService (spec §5).
   */
  withdrawalFeeValue: {
    type: Number,
    required: true,
    default: 0,
    min: [0, 'قيمة الرسوم لا يمكن أن تكون سالبة'],
    validate: {
      validator: Number.isInteger,
      message: 'قيمة الرسوم يجب أن تكون عدداً صحيحاً',
    },
  },

  // ── Withdrawal Limits ──────────────────────────────────────────────────────
  minWithdrawalAmount: {
    type: Number,
    required: true,
    default: 100,
    min: [1, 'الحد الأدنى للسحب يجب أن يكون أكبر من صفر'],
    validate: {
      validator: Number.isInteger,
      message: 'الحد الأدنى للسحب يجب أن يكون عدداً صحيحاً',
    },
  },

  maxWithdrawalAmount: {
    type: Number,
    required: true,
    default: 100_000,
    min: [1, 'الحد الأقصى للسحب يجب أن يكون أكبر من صفر'],
    validate: {
      validator: Number.isInteger,
      message: 'الحد الأقصى للسحب يجب أن يكون عدداً صحيحاً',
    },
  },

  /**
   * Withdrawals exceeding this amount trigger a high-value confirmation dialog
   * on the frontend (user must type the amount). Server also validates.
   */
  largeWithdrawalThreshold: {
    type: Number,
    required: true,
    default: 50_000,
    min: [0, 'حد السحب الكبير لا يمكن أن يكون سالباً'],
    validate: {
      validator: Number.isInteger,
      message: 'حد السحب الكبير يجب أن يكون عدداً صحيحاً',
    },
  },

  // ── Debt Management ────────────────────────────────────────────────────────
  /**
   * If false: any expense/purchase that would cause a negative balance is BLOCKED.
   * If true: the charge proceeds and the deficit becomes outstanding debt.
   */
  allowDebt: {
    type: Boolean,
    required: true,
    default: true,
  },

  /**
   * Maximum debt per user in YER.
   * 0 = unlimited.
   * When user debt reaches 80% of this value: admin notification.
   * When user debt reaches 100%: new charges are blocked.
   */
  maxDebtPerUser: {
    type: Number,
    required: true,
    default: 0,
    min: [0, 'الحد الأقصى للدين لا يمكن أن يكون سالباً'],
    validate: {
      validator: Number.isInteger,
      message: 'الحد الأقصى للدين يجب أن يكون عدداً صحيحاً',
    },
  },

  // ── Auto Backup ────────────────────────────────────────────────────────────
  autoBackupEnabled: {
    type: Boolean,
    required: true,
    default: false,
  },

  autoBackupFrequency: {
    type: String,
    enum: {
      values: ['daily', 'weekly', 'monthly'],
      message: 'تكرار النسخ الاحتياطي يجب أن يكون daily أو weekly أو monthly',
    },
    default: 'weekly',
  },

  /** HH:MM format — the time of day to run the auto backup. */
  autoBackupTime: {
    type: String,
    match: [/^\d{2}:\d{2}$/, 'وقت النسخ الاحتياطي يجب أن يكون بصيغة HH:MM'],
    default: '02:00',
  },

  // ── Deposit Expiry ─────────────────────────────────────────────────────────
  /**
   * Hours before a PENDING deposit request is auto-marked as EXPIRED.
   * Default: 72 hours (3 days). Minimum: 1 hour.
   */
  depositRequestExpiryHours: {
    type: Number,
    required: true,
    default: 72,
    min: [1, 'مدة انتهاء طلب الإيداع يجب أن تكون ساعة على الأقل'],
    validate: {
      validator: Number.isInteger,
      message: 'مدة انتهاء طلب الإيداع يجب أن تكون عدداً صحيحاً',
    },
  },

  // ── Balance Alerts ─────────────────────────────────────────────────────────
  /**
   * When user's balance drops below this amount, they receive a LOW_BALANCE
   * in-app notification.
   */
  lowBalanceThreshold: {
    type: Number,
    required: true,
    default: 500,
    min: [0, 'حد الرصيد المنخفض لا يمكن أن يكون سالباً'],
    validate: {
      validator: Number.isInteger,
      message: 'حد الرصيد المنخفض يجب أن يكون عدداً صحيحاً',
    },
  },

  // ── Security ───────────────────────────────────────────────────────────────
  /**
   * When true: admin account requires TOTP 2FA on every login.
   */
  require2FAForAdmin: {
    type: Boolean,
    required: true,
    default: false,
  },

  /**
   * When true: system is in maintenance mode. Non-admin users cannot log in or make API calls.
   */
  maintenanceMode: {
    type: Boolean,
    required: true,
    default: false,
  },

  // ── Currency (informational) ───────────────────────────────────────────────
  /**
   * System currency. Always 'YER'. Stored for informational display only.
   * DO NOT use this to switch currency — amounts are always YER integers.
   */
  currency: {
    type: String,
    enum: ['YER'],
    required: true,
    default: 'YER',
  },
});

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const Setting = mongoose.model('Setting', settingSchema);

module.exports = Setting;
