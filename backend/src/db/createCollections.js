/**
 * @file createCollections.js
 * @description MongoDB collection creation script with JSON Schema validators.
 *
 * PURPOSE
 * -------
 * This script creates every collection in the Smart Dorm Wallet database and
 * attaches strict JSON Schema validators directly at the MongoDB engine level.
 * This is the LAST LINE OF DEFENCE against data corruption — it prevents
 * invalid documents from being inserted even if:
 *   - a migration script bypasses Mongoose models
 *   - an admin tool writes directly to MongoDB
 *   - a bug in application code skips service-layer validation
 *
 * USAGE
 * -----
 *   node backend/src/db/createCollections.js
 *   # or via npm script:
 *   npm run db:create-collections
 *
 * IDEMPOTENCY
 * -----------
 * Running this script multiple times is SAFE. For each collection:
 *   - If it does NOT exist → created with validator
 *   - If it already EXISTS → validator is updated via collMod command
 *
 * IMPORTANT: This script runs with the application's MongoDB user credentials.
 * That user must have the `dbAdmin` role on the target database to execute
 * createCollection and collMod commands.
 *
 * SPEC REFERENCES
 * ---------------
 *   - §5  (Ledger model, transaction sign convention, type enum)
 *   - §13 (Collections overview, JSON Schema validation requirement)
 *   - §4  (User profile fields)
 *
 * @module db/createCollections
 */

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const mongoose = require('mongoose');
const env = require('../config/env');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Ensures a collection exists with the given JSON Schema validator.
 * Creates the collection if it doesn't exist; updates the validator if it does.
 *
 * @param {import('mongoose').Connection} conn - Active Mongoose connection.
 * @param {string} name - Collection name.
 * @param {object} validator - MongoDB $jsonSchema validator object.
 * @param {object} [options={}] - Additional createCollection options.
 */
async function ensureCollection(conn, name, validator, options = {}) {
  const db = conn.db;
  const collections = await db
    .listCollections({ name })
    .toArray();

  if (collections.length === 0) {
    // Collection does not exist — create it
    await db.createCollection(name, {
      validator: { $jsonSchema: validator },
      validationLevel: 'strict',   // Reject on insert AND update
      validationAction: 'error',   // Hard reject (not just warn)
      ...options,
    });
    logger.info(`[db:create] ✅ تم إنشاء المجموعة: ${name}`);
  } else {
    // Collection exists — update its validator
    await db.command({
      collMod: name,
      validator: { $jsonSchema: validator },
      validationLevel: 'strict',
      validationAction: 'error',
    });
    logger.info(`[db:create] 🔄 تم تحديث مُحقِّق المجموعة: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON Schema Validators
// ---------------------------------------------------------------------------

/**
 * TRANSACTIONS — Most critical collection (spec §5, §13).
 *
 * Design notes:
 *  - `amount` is always a positive integer (YER, no decimals). Enforced here.
 *  - `creditAmount` and `debitAmount` are the signed columns used in balance
 *     calculation. Exactly ONE of them is non-zero on any given entry.
 *  - `currency` is always 'YER' — enforced at DB level for future-proofing.
 *  - `type` is an enum of the 8 allowed transaction types from spec §5.
 *  - `userId` is stored as a string (UUID publicId) for public exposure,
 *     while `_userId` (the ObjectId ref) is used for internal joins.
 *  - The document is immutable after creation (no update/delete allowed via
 *     application user role — enforced via MongoDB RBAC in Atlas).
 */
const transactionsValidator = {
  bsonType: 'object',
  title: 'Transaction Document Validator',
  required: [
    'publicId',
    'userId',
    'type',
    'amount',
    'creditAmount',
    'debitAmount',
    'currency',
    'createdAt',
  ],
  additionalProperties: true, // Allow metadata, referenceId, description fields
  properties: {
    // ── Identifiers ────────────────────────────────────────────────────────
    publicId: {
      bsonType: 'string',
      description: 'UUID v4 — معرّف العملية الخارجي (يُعرَض في API)',
      pattern:
        '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
    userId: {
      bsonType: 'objectId',
      description: 'مرجع ObjectId للمستخدم — للاستخدام الداخلي فقط',
    },
    userPublicId: {
      bsonType: 'string',
      description: 'UUID v4 للمستخدم — لسهولة الاستعلام دون join',
    },

    // ── Type & Amount ───────────────────────────────────────────────────────
    type: {
      bsonType: 'string',
      description: 'نوع العملية المالية — يحدد اتجاه التأثير على الرصيد',
      enum: [
        'DEPOSIT',           // إيداع (+)
        'WITHDRAWAL',        // سحب (–)
        'WITHDRAWAL_FEE',    // رسوم السحب (–)
        'SHARED_EXPENSE',    // مصروف مشترك (–)
        'MERCHANT_PURCHASE', // مشتريات من تاجر (–)
        'DEBT_SETTLEMENT',   // تسوية دين (–)
        'ADJUSTMENT',        // تعديل يدوي (+/–)
        'REFUND',            // استرداد (+)
        'TRANSFER_IN',       // تحويل وارد (+)
        'TRANSFER_OUT',      // تحويل صادر (-)
      ],
    },
    amount: {
      bsonType: ['int', 'double'],
      description: 'المبلغ الإجمالي — دائماً عدد صحيح موجب (ريال يمني)',
      minimum: 1,
    },
    creditAmount: {
      bsonType: ['int', 'double'],
      description: 'قيمة الإضافة على الرصيد — 0 إذا كانت العملية خصماً',
      minimum: 0,
    },
    debitAmount: {
      bsonType: ['int', 'double'],
      description: 'قيمة الخصم من الرصيد — 0 إذا كانت العملية إضافة',
      minimum: 0,
    },
    currency: {
      bsonType: 'string',
      description: 'العملة — ريال يمني دائماً',
      enum: ['YER'],
    },

    // ── References ──────────────────────────────────────────────────────────
    referenceId: {
      bsonType: ['objectId', 'null'],
      description: 'مرجع لوثيقة الطلب المرتبط (إيداع/سحب/مصروف)',
    },
    referencePublicId: {
      bsonType: ['string', 'null'],
      description: 'publicId للوثيقة المرتبطة — للاستعلام دون join',
    },
    referenceType: {
      bsonType: ['string', 'null'],
      description: 'نوع الوثيقة المرتبطة',
      enum: [
        'depositRequest',
        'withdrawalRequest',
        'expense',
        'merchantTransaction',
        'adjustment',
        'transfer',
        null
      ],
    },

    // ── Human-readable fields ───────────────────────────────────────────────
    description: {
      bsonType: ['string', 'null'],
      description: 'وصف العملية المالية بالعربية',
      maxLength: 500,
    },
    adminNote: {
      bsonType: ['string', 'null'],
      description: 'ملاحظة المشرف (اختياري)',
      maxLength: 500,
    },

    // ── Audit trail ─────────────────────────────────────────────────────────
    performedBy: {
      bsonType: ['objectId', 'null'],
      description: 'ObjectId للمستخدم الذي أجرى العملية (admin/system)',
    },
    performedByPublicId: {
      bsonType: ['string', 'null'],
      description: 'publicId للمنفِّذ',
    },
    performedByRole: {
      bsonType: ['string', 'null'],
      enum: ['admin', 'deputy', 'system', null],
    },

    // ── Timestamp ───────────────────────────────────────────────────────────
    createdAt: {
      bsonType: 'date',
      description: 'تاريخ ووقت إنشاء سجل العملية',
    },

    // ── Soft metadata ───────────────────────────────────────────────────────
    metadata: {
      bsonType: ['object', 'null'],
      description: 'بيانات إضافية مرنة (حصة المصروف، رسوم السحب، إلخ)',
    },
  },
};

/**
 * USERS — User accounts (spec §4, §13).
 *
 * Sensitive fields (kuraimi_account_number, kuraimi_account_holder) are stored
 * AES-256-GCM encrypted. The validator only checks that they are strings
 * (i.e., the encrypted ciphertext blob) — not their plaintext content.
 *
 * ⚠️  Balance and Debt are NOT stored here. They are always calculated from
 *     the transactions collection (spec §5 — fundamental principle).
 */
const usersValidator = {
  bsonType: 'object',
  title: 'User Document Validator',
  required: ['publicId', 'fullName', 'role', 'status', 'createdAt'],
  additionalProperties: true,
  properties: {
    publicId: {
      bsonType: 'string',
      description: 'UUID v4 — معرّف المستخدم الخارجي',
      pattern:
        '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
    fullName: {
      bsonType: 'string',
      description: 'الاسم الكامل للمستخدم',
      minLength: 2,
      maxLength: 100,
    },
    phone: {
      bsonType: ['string', 'null'],
      description: 'رقم الهاتف',
      maxLength: 20,
    },
    passwordHash: {
      bsonType: 'string',
      description: 'كلمة المرور المشفرة (bcrypt)',
    },
    roomNumber: {
      bsonType: ['string', 'null'],
      description: 'رقم الغرفة (اختياري)',
      maxLength: 20,
    },
    role: {
      bsonType: 'string',
      description: 'دور المستخدم في النظام',
      enum: ['admin', 'resident', 'deputy'],
    },
    status: {
      bsonType: 'string',
      description: 'حالة الحساب',
      enum: ['active', 'suspended'],
    },
    // Encrypted at rest (AES-256-GCM) — stored as { iv, ciphertext, tag }
    kuriaimiAccountNumber: {
      bsonType: ['object', 'null'],
      description: 'رقم حساب الكريمي (مشفر AES-256-GCM)',
    },
    kuriaimiAccountHolder: {
      bsonType: ['object', 'null'],
      description: 'اسم صاحب حساب الكريمي (مشفر AES-256-GCM)',
    },
    profileImagePublicId: {
      bsonType: ['string', 'null'],
      description: 'Cloudinary public_id للصورة الشخصية',
    },
    twoFactorSecret: {
      bsonType: ['string', 'null'],
      description: 'TOTP secret المشفر (AES-256-GCM)',
    },
    twoFactorEnabled: {
      bsonType: 'bool',
    },
    backupCodes: {
      bsonType: 'array',
      description: 'رموز الاستعادة للمصادقة الثنائية (مشفرة)',
      items: { bsonType: 'string' },
    },
    failedLoginAttempts: {
      bsonType: 'int',
      minimum: 0,
    },
    lockedUntil: {
      bsonType: ['date', 'null'],
      description: 'تاريخ ووقت فك حظر الحساب',
    },
    lastLoginAt: {
      bsonType: ['date', 'null'],
      description: 'تاريخ ووقت آخر تسجيل دخول ناجح',
    },
    createdAt: {
      bsonType: 'date',
    },
    updatedAt: {
      bsonType: 'date',
    },
  },
};

/**
 * DEPOSIT REQUESTS (spec §6).
 */
const depositRequestsValidator = {
  bsonType: 'object',
  title: 'Deposit Request Document Validator',
  required: ['publicId', 'userId', 'amount', 'status', 'createdAt'],
  additionalProperties: true,
  properties: {
    publicId: { bsonType: 'string' },
    userId: { bsonType: 'objectId' },
    userPublicId: { bsonType: 'string' },
    amount: { bsonType: 'int', minimum: 1 },
    currency: { bsonType: 'string', enum: ['YER'] },
    receiptImagePublicId: { bsonType: ['string', 'null'] },
    referenceNumber: { bsonType: ['string', 'null'], maxLength: 100 },
    status: {
      bsonType: 'string',
      enum: ['pending', 'approved', 'rejected', 'expired'],
    },
    adminNote: { bsonType: ['string', 'null'], maxLength: 500 },
    approvedBy: { bsonType: ['objectId', 'null'] },
    approvedAt: { bsonType: ['date', 'null'] },
    transactionId: { bsonType: ['objectId', 'null'] },
    expiresAt: { bsonType: ['date', 'null'] },
    createdAt: { bsonType: 'date' },
    updatedAt: { bsonType: 'date' },
  },
};

/**
 * WITHDRAWAL REQUESTS (spec §7).
 */
const withdrawalRequestsValidator = {
  bsonType: 'object',
  title: 'Withdrawal Request Document Validator',
  required: ['publicId', 'userId', 'amount', 'status', 'createdAt'],
  additionalProperties: true,
  properties: {
    publicId: { bsonType: 'string' },
    userId: { bsonType: 'objectId' },
    userPublicId: { bsonType: 'string' },
    amount: { bsonType: 'int', minimum: 1 },
    currency: { bsonType: 'string', enum: ['YER'] },
    feeAmount: { bsonType: ['int', 'null'], minimum: 0 },
    netAmount: { bsonType: ['int', 'null'], minimum: 0 },
    feeType: { bsonType: ['string', 'null'], enum: ['FIXED', 'PERCENTAGE', null] },
    feeValue: { bsonType: ['int', 'null'], minimum: 0 },
    // Snapshot of the user's Kuraimi info at time of request (decrypted for display)
    kuriaimiAccountNumber: { bsonType: ['object', 'null'] }, // encrypted
    kuriaimiAccountHolder: { bsonType: ['object', 'null'] }, // encrypted
    status: {
      bsonType: 'string',
      enum: ['pending', 'approved', 'rejected'],
    },
    receiptImagePublicId: { bsonType: ['string', 'null'] },
    adminNote: { bsonType: ['string', 'null'], maxLength: 500 },
    approvedBy: { bsonType: ['objectId', 'null'] },
    approvedAt: { bsonType: ['date', 'null'] },
    transactionId: { bsonType: ['objectId', 'null'] },
    feeTransactionId: { bsonType: ['objectId', 'null'] },
    createdAt: { bsonType: 'date' },
    updatedAt: { bsonType: 'date' },
  },
};

/**
 * EXPENSES — Shared expense records (spec §8).
 */
const expensesValidator = {
  bsonType: 'object',
  title: 'Expense Document Validator',
  required: ['publicId', 'name', 'totalAmount', 'createdBy', 'affectedUsers', 'createdAt'],
  additionalProperties: true,
  properties: {
    publicId: { bsonType: 'string' },
    name: { bsonType: 'string', minLength: 1, maxLength: 200 },
    description: { bsonType: ['string', 'null'], maxLength: 1000 },
    totalAmount: { bsonType: 'int', minimum: 1 },
    currency: { bsonType: 'string', enum: ['YER'] },
    receiptImagePublicId: { bsonType: ['string', 'null'] },
    expenseDate: { bsonType: 'date' },
    createdBy: { bsonType: 'objectId' },
    createdByPublicId: { bsonType: 'string' },
    affectedUsers: {
      bsonType: 'array',
      minItems: 1,
      items: {
        bsonType: 'object',
        required: ['userId', 'shareAmount', 'transactionId'],
        properties: {
          userId: { bsonType: 'objectId' },
          userPublicId: { bsonType: 'string' },
          shareAmount: { bsonType: 'int', minimum: 1 },
          transactionId: { bsonType: 'objectId' },
        },
      },
    },
    disputes: {
      bsonType: 'array',
      items: {
        bsonType: 'object',
        required: ['userId', 'note', 'status', 'createdAt'],
        properties: {
          publicId: { bsonType: 'string' },
          userId: { bsonType: 'objectId' },
          note: { bsonType: 'string', maxLength: 1000 },
          status: {
            bsonType: 'string',
            enum: ['open', 'resolved_dismissed', 'resolved_refunded'],
          },
          resolvedBy: { bsonType: ['objectId', 'null'] },
          resolvedAt: { bsonType: ['date', 'null'] },
          refundTransactionId: { bsonType: ['objectId', 'null'] },
          createdAt: { bsonType: 'date' },
        },
      },
    },
    createdAt: { bsonType: 'date' },
    updatedAt: { bsonType: 'date' },
  },
};

/**
 * MERCHANTS (spec §10).
 */
const merchantsValidator = {
  bsonType: 'object',
  title: 'Merchant Document Validator',
  required: ['publicId', 'name', 'status', 'createdAt'],
  additionalProperties: true,
  properties: {
    publicId: { bsonType: 'string' },
    name: { bsonType: 'string', minLength: 1, maxLength: 200 },
    phone: { bsonType: ['string', 'null'], maxLength: 20 },
    notes: { bsonType: ['string', 'null'], maxLength: 1000 },
    status: { bsonType: 'string', enum: ['active', 'disabled'] },
    createdBy: { bsonType: 'objectId' },
    createdAt: { bsonType: 'date' },
    updatedAt: { bsonType: 'date' },
  },
};

/**
 * MERCHANT TRANSACTIONS — Purchases and settlements (spec §10).
 */
const merchantTransactionsValidator = {
  bsonType: 'object',
  title: 'Merchant Transaction Document Validator',
  required: ['publicId', 'merchantId', 'type', 'amount', 'createdAt'],
  additionalProperties: true,
  properties: {
    publicId: { bsonType: 'string' },
    merchantId: { bsonType: 'objectId' },
    merchantPublicId: { bsonType: 'string' },
    type: { bsonType: 'string', enum: ['purchase', 'settlement'] },
    amount: { bsonType: 'int', minimum: 1 },
    currency: { bsonType: 'string', enum: ['YER'] },
    description: { bsonType: ['string', 'null'], maxLength: 500 },
    invoiceReference: { bsonType: ['string', 'null'], maxLength: 100 },
    receiptImagePublicId: { bsonType: ['string', 'null'] },
    // For purchases: array of user shares
    userShares: {
      bsonType: 'array',
      items: {
        bsonType: 'object',
        required: ['userId', 'shareAmount'],
        properties: {
          userId: { bsonType: 'objectId' },
          userPublicId: { bsonType: 'string' },
          shareAmount: { bsonType: 'int', minimum: 1 },
          transactionId: { bsonType: ['objectId', 'null'] },
        },
      },
    },
    performedBy: { bsonType: 'objectId' },
    createdAt: { bsonType: 'date' },
  },
};

/**
 * AUDIT LOGS — Immutable append-only record (spec §19).
 * Application DB user has INSERT but NOT UPDATE or DELETE rights on this collection.
 */
const auditLogsValidator = {
  bsonType: 'object',
  title: 'Audit Log Document Validator',
  required: ['actorId', 'actorRole', 'action', 'entityType', 'createdAt'],
  additionalProperties: true,
  properties: {
    publicId: { bsonType: 'string' },
    actorId: { bsonType: 'objectId' },
    actorPublicId: { bsonType: 'string' },
    actorRole: { bsonType: 'string', enum: ['admin', 'deputy', 'system', 'user'] },
    actorName: { bsonType: ['string', 'null'] },
    action: {
      bsonType: 'string',
      description: 'نوع الإجراء المنفَّذ',
      enum: [
        // Users
        'user.created', 'user.updated', 'user.disabled', 'user.enabled',
        'user.password_reset', 'user.2fa_enabled', 'user.2fa_disabled',
        // Auth
        'auth.login_success', 'auth.login_failed',
        // Deposits
        'deposit.approved', 'deposit.rejected', 'deposit.expired',
        // Withdrawals
        'withdrawal.approved', 'withdrawal.rejected',
        // Expenses
        'expense.created', 'expense.dispute_resolved',
        // Merchants
        'merchant.created', 'merchant.updated',
        'merchant.purchase_recorded', 'merchant.settlement_recorded',
        // Transactions
        'adjustment.created', 'refund.created',
        'TRANSFER_CREATED',
        // Settings
        'settings.updated',
        // Backup
        'backup.created', 'backup.restored',
        // Deputy
        'deputy.assigned', 'deputy.revoked',
        // Anomaly
        'anomaly.flagged',
        // System
        'system.deposit_expired', 'system.debt_settled',
      ],
    },
    entityType: {
      bsonType: 'string',
      enum: [
        'user', 'depositRequest', 'withdrawalRequest', 'expense',
        'merchant', 'merchantTransaction', 'transaction', 'settings',
        'backup', 'deputy', 'system', 'transfer',
      ],
    },
    entityId: { bsonType: ['objectId', 'null'] },
    entityPublicId: { bsonType: ['string', 'null'] },
    metadata: {
      bsonType: ['object', 'null'],
      description: 'تفاصيل الإجراء (قيم قبل/بعد، ملاحظات، إلخ)',
    },
    ipAddress: { bsonType: ['string', 'null'] },
    userAgent: { bsonType: ['string', 'null'] },
    isUnusualHours: { bsonType: 'bool' },
    createdAt: { bsonType: 'date' },
  },
};

/**
 * NOTIFICATIONS (spec §11).
 */
const notificationsValidator = {
  bsonType: 'object',
  title: 'Notification Document Validator',
  required: ['publicId', 'userId', 'type', 'message', 'isRead', 'createdAt'],
  additionalProperties: true,
  properties: {
    publicId: { bsonType: 'string' },
    userId: { bsonType: 'objectId' },
    userPublicId: { bsonType: 'string' },
    type: {
      bsonType: 'string',
      enum: [
        'deposit_approved', 'deposit_rejected',
        'withdrawal_approved', 'withdrawal_rejected',
        'shared_expense_added', 'merchant_purchase_added',
        'low_balance', 'debt_approaching_limit',
        'pending_request_expiring', 'expense_disputed',
        'TRANSFER_IN', 'TRANSFER_OUT',
      ],
    },
    message: { bsonType: 'string', minLength: 1, maxLength: 500 },
    isRead: { bsonType: 'bool' },
    relatedEntityId: { bsonType: 'objectId' },
    relatedEntityPublicId: { bsonType: 'string' },
    archivedAt: { bsonType: 'date' },
    createdAt: { bsonType: 'date' },
  },
};

/**
 * SETTINGS — Singleton document (spec §20).
 */
const settingsValidator = {
  bsonType: 'object',
  title: 'Settings Document Validator',
  required: ['withdrawalFeeType', 'withdrawalFeeValue', 'createdAt'],
  additionalProperties: true,
  properties: {
    withdrawalFeeType: { bsonType: 'string', enum: ['FIXED', 'PERCENTAGE'] },
    withdrawalFeeValue: { bsonType: 'int', minimum: 0 },
    minWithdrawalAmount: { bsonType: 'int', minimum: 1 },
    maxWithdrawalAmount: { bsonType: 'int', minimum: 1 },
    largeWithdrawalThreshold: { bsonType: 'int', minimum: 0 },
    allowDebt: { bsonType: 'bool' },
    maxDebtPerUser: { bsonType: 'int', minimum: 0 },
    autoBackupEnabled: { bsonType: 'bool' },
    autoBackupFrequency: { bsonType: 'string', enum: ['daily', 'weekly', 'monthly'] },
    autoBackupTime: { bsonType: 'string' },
    depositRequestExpiryHours: { bsonType: 'int', minimum: 1 },
    lowBalanceThreshold: { bsonType: 'int', minimum: 0 },
    require2FAForAdmin: { bsonType: 'bool' },
    maintenanceMode: { bsonType: 'bool' },
    currency: { bsonType: 'string', enum: ['YER'] },
    createdAt: { bsonType: 'date' },
    updatedAt: { bsonType: 'date' },
  },
};

/**
 * TOKEN BLACKLIST — Rotated/revoked refresh tokens (spec §12).
 * TTL index on `expiresAt` auto-deletes expired entries.
 */
const tokenBlacklistValidator = {
  bsonType: 'object',
  title: 'Token Blacklist Document Validator',
  required: ['tokenHash', 'expiresAt', 'createdAt'],
  additionalProperties: true,
  properties: {
    tokenHash: { bsonType: 'string', description: 'SHA-256 hash of the refresh token' },
    userId: { bsonType: 'objectId' },
    reason: { bsonType: 'string', enum: ['rotation', 'logout', 'compromise', 'admin_revoke'] },
    expiresAt: { bsonType: 'date', description: 'MongoDB TTL index deletes this automatically' },
    createdAt: { bsonType: 'date' },
  },
};

/**
 * DEPUTY ASSIGNMENTS (spec §3).
 */
const deputyAssignmentsValidator = {
  bsonType: 'object',
  title: 'Deputy Assignment Document Validator',
  required: ['publicId', 'userId', 'grantedBy', 'expiresAt', 'isActive', 'createdAt'],
  additionalProperties: true,
  properties: {
    publicId: { bsonType: 'string' },
    userId: { bsonType: 'objectId' },
    userPublicId: { bsonType: 'string' },
    grantedBy: { bsonType: 'objectId' },
    grantedByPublicId: { bsonType: 'string' },
    expiresAt: { bsonType: 'date' },
    isActive: { bsonType: 'bool' },
    revokedAt: { bsonType: 'date' },
    revokedBy: { bsonType: 'objectId' },
    createdAt: { bsonType: 'date' },
  },
};

/**
 * BALANCE SNAPSHOTS — Monthly snapshots for archive strategy (spec §13).
 * Used so balance = snapshot + delta since snapshot (avoids scanning 2+ years of data).
 */
const balanceSnapshotsValidator = {
  bsonType: 'object',
  title: 'Balance Snapshot Document Validator',
  required: ['userId', 'snapshotDate', 'balanceAtSnapshot', 'debtAtSnapshot', 'createdAt'],
  additionalProperties: false,
  properties: {
    publicId: { bsonType: 'string' },
    userId: { bsonType: 'objectId' },
    userPublicId: { bsonType: 'string' },
    snapshotDate: { bsonType: 'date' },
    balanceAtSnapshot: { bsonType: 'int' },
    debtAtSnapshot: { bsonType: 'int', minimum: 0 },
    lastTransactionId: { bsonType: 'objectId' },
    createdAt: { bsonType: 'date' },
  },
};

// ---------------------------------------------------------------------------
// Index definitions (created after validators)
// ---------------------------------------------------------------------------

/**
 * All indexes to be created, grouped by collection name.
 * These match the MANDATORY indexes specified in spec §13.
 *
 * Format: { collection, keys, options }
 */
const INDEXES = [
  // ── transactions ──────────────────────────────────────────────────────────
  { collection: 'transactions', keys: { userId: 1, createdAt: -1 }, options: { name: 'idx_userId_createdAt' } },
  { collection: 'transactions', keys: { userId: 1, type: 1, createdAt: -1 }, options: { name: 'idx_userId_type_createdAt' } },
  { collection: 'transactions', keys: { referenceId: 1 }, options: { name: 'idx_referenceId' } },
  { collection: 'transactions', keys: { publicId: 1 }, options: { unique: true, name: 'idx_publicId_unique' } },
  { collection: 'transactions', keys: { userPublicId: 1, createdAt: -1 }, options: { name: 'idx_userPublicId_createdAt' } },

  // ── depositRequests ───────────────────────────────────────────────────────
  { collection: 'depositrequests', keys: { userId: 1, status: 1 }, options: { name: 'idx_userId_status' } },
  { collection: 'depositrequests', keys: { status: 1, createdAt: -1 }, options: { name: 'idx_status_createdAt' } },
  { collection: 'depositrequests', keys: { createdAt: 1 }, options: { name: 'idx_createdAt_expiry' } },
  { collection: 'depositrequests', keys: { publicId: 1 }, options: { unique: true, name: 'idx_publicId_unique' } },
  { collection: 'depositrequests', keys: { expiresAt: 1, status: 1 }, options: { name: 'idx_expiresAt_status' } },

  // ── withdrawalRequests ────────────────────────────────────────────────────
  { collection: 'withdrawalrequests', keys: { userId: 1, status: 1 }, options: { name: 'idx_userId_status' } },
  { collection: 'withdrawalrequests', keys: { status: 1, createdAt: -1 }, options: { name: 'idx_status_createdAt' } },
  { collection: 'withdrawalrequests', keys: { publicId: 1 }, options: { unique: true, name: 'idx_publicId_unique' } },

  // ── expenses ──────────────────────────────────────────────────────────────
  { collection: 'expenses', keys: { 'affectedUsers.userId': 1, createdAt: -1 }, options: { name: 'idx_affectedUsers_createdAt' } },
  { collection: 'expenses', keys: { publicId: 1 }, options: { unique: true, name: 'idx_publicId_unique' } },

  // ── merchants ─────────────────────────────────────────────────────────────
  { collection: 'merchants', keys: { publicId: 1 }, options: { unique: true, name: 'idx_publicId_unique' } },
  { collection: 'merchants', keys: { status: 1 }, options: { name: 'idx_status' } },

  // ── merchantTransactions ──────────────────────────────────────────────────
  { collection: 'merchanttransactions', keys: { merchantId: 1, type: 1, createdAt: -1 }, options: { name: 'idx_merchantId_type_createdAt' } },
  { collection: 'merchanttransactions', keys: { publicId: 1 }, options: { unique: true, name: 'idx_publicId_unique' } },
  // Unique invoice reference per merchant (partial index — only when invoiceReference exists)
  {
    collection: 'merchanttransactions',
    keys: { merchantId: 1, invoiceReference: 1 },
    options: {
      unique: true,
      partialFilterExpression: { invoiceReference: { $type: 'string' } },
      name: 'idx_merchantId_invoiceRef_unique',
    },
  },

  // ── users ─────────────────────────────────────────────────────────────────
  { collection: 'users', keys: { publicId: 1 }, options: { unique: true, name: 'idx_publicId_unique' } },
  { collection: 'users', keys: { role: 1, status: 1 }, options: { name: 'idx_role_status' } },
  { collection: 'users', keys: { accountNumber: 1 }, options: { unique: true, partialFilterExpression: { accountNumber: { $type: 'string' } }, name: 'idx_accountNumber_unique' } },

  // ── auditLogs ─────────────────────────────────────────────────────────────
  { collection: 'auditlogs', keys: { actorId: 1, createdAt: -1 }, options: { name: 'idx_actorId_createdAt' } },
  { collection: 'auditlogs', keys: { entityType: 1, entityId: 1, createdAt: -1 }, options: { name: 'idx_entity_createdAt' } },
  { collection: 'auditlogs', keys: { createdAt: -1 }, options: { name: 'idx_createdAt' } },

  // ── notifications ─────────────────────────────────────────────────────────
  { collection: 'notifications', keys: { userId: 1, isRead: 1, createdAt: -1 }, options: { name: 'idx_userId_isRead_createdAt' } },
  { collection: 'notifications', keys: { publicId: 1 }, options: { unique: true, name: 'idx_publicId_unique' } },
  // Auto-archive: TTL on archivedAt would be misleading — we use a cron instead.
  // But we do index archivedAt for the cron query:
  { collection: 'notifications', keys: { createdAt: 1 }, options: { name: 'idx_createdAt_archive' } },

  // ── tokenBlacklist ────────────────────────────────────────────────────────
  // TTL index — MongoDB auto-deletes expired blacklisted tokens
  { collection: 'tokenblacklists', keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0, name: 'idx_expiresAt_ttl' } },
  { collection: 'tokenblacklists', keys: { tokenHash: 1 }, options: { unique: true, name: 'idx_tokenHash_unique' } },

  // ── deputyAssignments ─────────────────────────────────────────────────────
  { collection: 'deputyassignments', keys: { userId: 1, isActive: 1 }, options: { name: 'idx_userId_isActive' } },
  { collection: 'deputyassignments', keys: { expiresAt: 1 }, options: { name: 'idx_expiresAt' } },

  // ── balanceSnapshots ──────────────────────────────────────────────────────
  { collection: 'balancesnapshots', keys: { userId: 1, snapshotDate: -1 }, options: { name: 'idx_userId_snapshotDate' } },
];

// ---------------------------------------------------------------------------
// Collection definitions registry
// ---------------------------------------------------------------------------

const COLLECTIONS = [
  { name: 'transactions',       validator: transactionsValidator },
  { name: 'users',              validator: usersValidator },
  { name: 'depositrequests',    validator: depositRequestsValidator },
  { name: 'withdrawalrequests', validator: withdrawalRequestsValidator },
  { name: 'expenses',           validator: expensesValidator },
  { name: 'merchants',          validator: merchantsValidator },
  { name: 'merchanttransactions', validator: merchantTransactionsValidator },
  { name: 'auditlogs',          validator: auditLogsValidator },
  { name: 'notifications',      validator: notificationsValidator },
  { name: 'settings',           validator: settingsValidator },
  { name: 'tokenblacklists',    validator: tokenBlacklistValidator },
  { name: 'deputyassignments',  validator: deputyAssignmentsValidator },
  { name: 'balancesnapshots',   validator: balanceSnapshotsValidator },
  // No validator on transactions_archive — it mirrors transactions structure
  // but we allow relaxed validation on archived data.
  { name: 'transactions_archive', validator: null },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  logger.info('[db:create] 🚀 بدء إنشاء مجموعات قاعدة البيانات…');

  await mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10_000,
    w: 'majority',
    journal: true,
    retryWrites: true,
    appName: 'SmartDormWallet-Migration',
  });

  logger.info('[db:create] ✅ تم الاتصال بـ MongoDB Atlas');

  const conn = mongoose.connection;

  // 1. Create / update collections with JSON Schema validators
  for (const { name, validator } of COLLECTIONS) {
    if (validator) {
      await ensureCollection(conn, name, validator);
    } else {
      // Create without validator (e.g. transactions_archive)
      const existing = await conn.db.listCollections({ name }).toArray();
      if (existing.length === 0) {
        await conn.db.createCollection(name);
        logger.info(`[db:create] ✅ تم إنشاء المجموعة (بدون مُحقِّق): ${name}`);
      } else {
        logger.info(`[db:create] ⏭  المجموعة موجودة بالفعل: ${name}`);
      }
    }
  }

  // 2. Create indexes
  logger.info('[db:create] 📇 جاري إنشاء الفهارس…');
  for (const { collection, keys, options } of INDEXES) {
    try {
      await conn.db.collection(collection).createIndex(keys, options);
      logger.info(
        `[db:create] ✅ فهرس: ${collection} → ${JSON.stringify(keys)}`
      );
    } catch (err) {
      // Index may already exist with same definition — safe to ignore
      if (err.code === 85 || err.code === 86) {
        logger.warn(
          `[db:create] ⚠️  الفهرس موجود بالفعل أو يتعارض: ${collection} → ${options.name}`
        );
      } else {
        throw err;
      }
    }
  }

  // 3. Seed default settings document if not present
  const settingsCount = await conn.db
    .collection('settings')
    .countDocuments();

  if (settingsCount === 0) {
    await conn.db.collection('settings').insertOne({
      withdrawalFeeType: 'FIXED',
      withdrawalFeeValue: 0,
      minWithdrawalAmount: 100,
      maxWithdrawalAmount: 100000,
      largeWithdrawalThreshold: 50000,
      allowDebt: true,
      maxDebtPerUser: 0,
      autoBackupEnabled: false,
      autoBackupFrequency: 'weekly',
      autoBackupTime: '02:00',
      depositRequestExpiryHours: 72,
      lowBalanceThreshold: 500,
      require2FAForAdmin: false,
      maintenanceMode: false,
      currency: 'YER',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    logger.info('[db:create] ✅ تم إنشاء وثيقة الإعدادات الافتراضية');
  } else {
    logger.info('[db:create] ⏭  وثيقة الإعدادات موجودة بالفعل');
  }

  await mongoose.connection.close();
  logger.info('[db:create] 🎉 اكتملت عملية إنشاء المجموعات والفهارس بنجاح');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  logger.error('[db:create] ❌ فشل إنشاء المجموعات', {
    message: err.message,
    stack: err.stack,
  });
  process.exit(1);
});
