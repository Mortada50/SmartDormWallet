/**
 * @file AuditLog.js
 * @description Mongoose model for the immutable audit trail.
 *
 * IMMUTABILITY CONTRACT (spec §19):
 *   Audit log documents are APPEND-ONLY.
 *   - No UPDATE or DELETE operations are permitted through application code.
 *   - Enforced at MongoDB Atlas RBAC level: the app DB user has INSERT-only
 *     rights on the auditlogs collection.
 *   - The Repository layer for AuditLog exposes ONLY createLog() — no update
 *     or delete methods exist.
 *
 * WHAT IS LOGGED (spec §19):
 *   See the ACTION enum below for the complete list of 40+ auditable events.
 *   Every admin action, system event, and anomaly must produce an audit entry.
 *
 * DEPUTY ACTION LABELLING (spec §3):
 *   When actorRole === 'deputy', the audit log entry is visually distinguished
 *   in the admin UI. The deputy user's publicId is stored in actorPublicId.
 *
 * UNUSUAL HOURS (spec §12):
 *   Requests between 02:00–05:00 local time are flagged with isUnusualHours:true.
 *   This is a detection-only flag — it does not block operations.
 *
 * LEAN HINT:
 *   AuditLog.find(...).asLean() always — audit logs are read-only by design.
 *   Never load audit logs as full Mongoose documents.
 *
 * SPEC REFERENCE: §19 (Audit Log System)
 *
 * @module models/AuditLog
 */

'use strict';

const mongoose = require('mongoose');
const { createBaseSchema } = require('./_baseSchema');

// ---------------------------------------------------------------------------
// Action enum — complete list from spec §19
// ---------------------------------------------------------------------------

const AUDIT_ACTIONS = Object.freeze({
  // Users
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_DISABLED: 'user.disabled',
  USER_ENABLED: 'user.enabled',
  USER_PASSWORD_RESET: 'user.password_reset',
  USER_2FA_ENABLED: 'user.2fa_enabled',
  USER_2FA_DISABLED: 'user.2fa_disabled',

  // Auth
  AUTH_LOGIN_SUCCESS: 'auth.login_success',
  AUTH_LOGIN_FAILED: 'auth.login_failed',

  // Deposits
  DEPOSIT_APPROVED: 'deposit.approved',
  DEPOSIT_REJECTED: 'deposit.rejected',
  DEPOSIT_EXPIRED: 'deposit.expired',

  // Withdrawals
  WITHDRAWAL_APPROVED: 'withdrawal.approved',
  WITHDRAWAL_REJECTED: 'withdrawal.rejected',

  // Expenses
  EXPENSE_CREATED: 'expense.created',
  EXPENSE_DISPUTE_RESOLVED: 'expense.dispute_resolved',

  // Merchants
  MERCHANT_CREATED: 'merchant.created',
  MERCHANT_UPDATED: 'merchant.updated',
  MERCHANT_PURCHASE_RECORDED: 'merchant.purchase_recorded',
  MERCHANT_SETTLEMENT_RECORDED: 'merchant.settlement_recorded',

  // Transactions
  ADJUSTMENT_CREATED: 'adjustment.created',
  REFUND_CREATED: 'refund.created',

  // Settings
  SETTINGS_UPDATED: 'settings.updated',

  // Backup
  BACKUP_CREATED: 'backup.created',
  BACKUP_RESTORED: 'backup.restored',

  // Deputy
  DEPUTY_ASSIGNED: 'deputy.assigned',
  DEPUTY_REVOKED: 'deputy.revoked',

  // Anomaly
  ANOMALY_FLAGGED: 'anomaly.flagged',

  // System
  SYSTEM_DEPOSIT_EXPIRED: 'system.deposit_expired',
  SYSTEM_DEBT_SETTLED: 'system.debt_settled',
});

const AUDIT_ENTITY_TYPES = Object.freeze({
  USER: 'user',
  DEPOSIT_REQUEST: 'depositRequest',
  WITHDRAWAL_REQUEST: 'withdrawalRequest',
  EXPENSE: 'expense',
  MERCHANT: 'merchant',
  MERCHANT_TRANSACTION: 'merchantTransaction',
  TRANSACTION: 'transaction',
  SETTINGS: 'settings',
  BACKUP: 'backup',
  DEPUTY: 'deputy',
  SYSTEM: 'system',
});

const ACTOR_ROLES = Object.freeze({
  ADMIN: 'admin',
  DEPUTY: 'deputy',
  SYSTEM: 'system',
  USER: 'user',
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const auditLogSchema = createBaseSchema({
  // ── Actor (who performed the action) ──────────────────────────────────────
  actorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'معرف المنفّذ مطلوب'],
    index: true,
  },

  actorPublicId: {
    type: String,
    required: true,
  },

  actorRole: {
    type: String,
    enum: {
      values: Object.values(ACTOR_ROLES),
      message: 'دور المنفّذ غير صحيح',
    },
    required: [true, 'دور المنفّذ مطلوب'],
  },

  actorName: {
    type: String, // Denormalised for display without join
  },

  // ── Action ────────────────────────────────────────────────────────────────
  action: {
    type: String,
    enum: {
      values: Object.values(AUDIT_ACTIONS),
      message: 'الإجراء غير معروف',
    },
    required: [true, 'الإجراء مطلوب'],
    index: true,
  },

  // ── Affected entity ───────────────────────────────────────────────────────
  entityType: {
    type: String,
    enum: {
      values: Object.values(AUDIT_ENTITY_TYPES),
      message: 'نوع الكيان غير معروف',
    },
    required: [true, 'نوع الكيان مطلوب'],
    index: true,
  },

  entityId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },

  entityPublicId: {
    type: String,
    default: null,
  },

  // ── Change details ────────────────────────────────────────────────────────
  /**
   * Flexible metadata object containing action-specific details.
   *
   * Examples:
   *   user.updated → { changedFields: { fullName: { before: '...', after: '...' } } }
   *   deposit.approved → { amount: 5000, adminNote: '...' }
   *   anomaly.flagged → { type: 'duplicate_reference', referenceNumber: '...' }
   *   settings.updated → { changedKeys: ['withdrawalFeeType'], before: {...}, after: {...} }
   */
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },

  // ── Request context ────────────────────────────────────────────────────────
  ipAddress: {
    type: String,
    default: null,
  },

  userAgent: {
    type: String,
    maxlength: 500,
    default: null,
  },

  /**
   * Flagged when the action was performed between 02:00–05:00 local time.
   * Detection-only — does not block the operation (spec §12).
   */
  isUnusualHours: {
    type: Boolean,
    default: false,
  },
},
{
  // Audit logs never need an updatedAt — they are immutable.
  timestamps: { createdAt: true, updatedAt: false },
});

// ---------------------------------------------------------------------------
// Indexes (documentation — created by createCollections.js)
// { actorId: 1, createdAt: -1 }
// { entityType: 1, entityId: 1, createdAt: -1 }
// { createdAt: -1 }
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Safety guard — pre-save hook that prevents accidental updates
// ---------------------------------------------------------------------------
/**
 * Mongoose does not prevent update() calls on existing documents by default.
 * This hook runs before findOneAndUpdate / updateOne operations.
 *
 * ⚠️  IMPORTANT: This is a defensive check in the application layer.
 *     The primary enforcement is MongoDB Atlas RBAC (INSERT-only for app user).
 *     Both layers together make the audit log truly append-only.
 */
auditLogSchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], function () {
  throw new Error(
    '[AuditLog] 🔴 سجلات التدقيق غير قابلة للتعديل — ' +
    'استخدم AuditLogRepository.createLog() فقط'
  );
});

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

module.exports = AuditLog;
module.exports.AUDIT_ACTIONS = AUDIT_ACTIONS;
module.exports.AUDIT_ENTITY_TYPES = AUDIT_ENTITY_TYPES;
module.exports.ACTOR_ROLES = ACTOR_ROLES;
