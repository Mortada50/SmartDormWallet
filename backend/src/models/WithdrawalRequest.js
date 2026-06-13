/**
 * @file WithdrawalRequest.js
 * @description Mongoose model for user withdrawal requests.
 *
 * CRITICAL RULES (spec §7):
 *  🔴 Approval WITHOUT a receipt image is BLOCKED at the API layer.
 *     The receiptImagePublicId field MUST be set before calling approve().
 *
 *  🔴 Withdrawal approval creates TWO ledger entries atomically:
 *     1. WITHDRAWAL  transaction for the requested amount
 *     2. WITHDRAWAL_FEE transaction for the computed fee
 *     Both are created inside a single MongoDB session (startSession()).
 *
 * PRE-CONDITIONS (validated by WithdrawalService before creation):
 *  - User has a Kuraimi account (hasKuriaimiAccount === true)
 *  - User has sufficient balance (amount + estimated fee ≤ current balance)
 *  - No existing PENDING withdrawal for this user
 *  - amount ≥ settings.minWithdrawalAmount
 *  - amount ≤ settings.maxWithdrawalAmount
 *
 * FEE SNAPSHOT:
 *  feeType, feeValue, feeAmount, netAmount are snapshotted at approval time
 *  from system settings. This ensures historical accuracy even if settings
 *  change later.
 *
 * HIGH-VALUE CONFIRMATION:
 *  If amount > settings.largeWithdrawalThreshold, the frontend shows a
 *  confirmation dialog. The server validates the submitted amount matches
 *  the request amount. This is enforced in WithdrawalService.
 *
 * LEAN HINT:
 *   WithdrawalRequest.find({ status: 'pending' }).asLean() for admin queue.
 *
 * SPEC REFERENCE: §7 (Withdrawal System)
 *
 * @module models/WithdrawalRequest
 */

'use strict';

const mongoose = require('mongoose');
const { createBaseSchema } = require('./_baseSchema');

// ---------------------------------------------------------------------------
// Status constants
// ---------------------------------------------------------------------------

const WITHDRAWAL_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
});

const FEE_TYPES = Object.freeze({
  FIXED: 'FIXED',
  PERCENTAGE: 'PERCENTAGE',
});

// ---------------------------------------------------------------------------
// Encrypted field sub-schema (mirrors User model's Kuraimi fields)
// ---------------------------------------------------------------------------
const EncryptedFieldSchema = new mongoose.Schema(
  {
    iv: { type: String, required: true },
    ciphertext: { type: String, required: true },
    tag: { type: String, required: true },
  },
  { _id: false }
);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const withdrawalRequestSchema = createBaseSchema({
  // ── User link ─────────────────────────────────────────────────────────────
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'معرف المستخدم مطلوب'],
    index: true,
  },

  userPublicId: {
    type: String,
    required: [true, 'المعرف العام للمستخدم مطلوب'],
  },

  // ── Request details ───────────────────────────────────────────────────────
  amount: {
    type: Number,
    required: [true, 'مبلغ السحب مطلوب'],
    min: [1, 'مبلغ السحب يجب أن يكون أكبر من صفر'],
    validate: {
      validator: Number.isInteger,
      message: 'مبلغ السحب يجب أن يكون عدداً صحيحاً',
    },
  },

  currency: {
    type: String,
    enum: ['YER'],
    default: 'YER',
  },

  // ── Fee snapshot (set at approval time) ──────────────────────────────────
  /**
   * Fee type snapshotted from settings at the moment of approval.
   * Preserved for historical accuracy regardless of future settings changes.
   */
  feeType: {
    type: String,
    enum: {
      values: Object.values(FEE_TYPES),
      message: 'نوع الرسوم غير صحيح',
    },
    default: null,
  },

  /**
   * The fee rate/value snapshotted from settings at approval time.
   * For FIXED: the absolute amount. For PERCENTAGE: the percentage (1-100).
   */
  feeValue: {
    type: Number,
    min: 0,
    default: null,
    validate: {
      validator: (v) => v === null || Number.isInteger(v),
      message: 'قيمة الرسوم يجب أن تكون عدداً صحيحاً',
    },
  },

  /**
   * The computed fee amount in YER.
   * Always Math.ceil'd (spec §5 — "always round UP on fee calculations").
   * Set by WithdrawalService at approval time.
   */
  feeAmount: {
    type: Number,
    min: 0,
    default: null,
    validate: {
      validator: (v) => v === null || Number.isInteger(v),
      message: 'مبلغ الرسوم يجب أن يكون عدداً صحيحاً',
    },
  },

  /**
   * Net amount received by user = amount - feeAmount.
   * Displayed on withdrawal receipt.
   */
  netAmount: {
    type: Number,
    min: 0,
    default: null,
    validate: {
      validator: (v) => v === null || Number.isInteger(v),
      message: 'صافي المبلغ يجب أن يكون عدداً صحيحاً',
    },
  },

  // ── Kuraimi account snapshot (AES-256-GCM encrypted) ─────────────────────
  /**
   * Snapshot of user's Kuraimi info at time of request creation.
   * Encrypted with the same AES-256-GCM key as the User model.
   * Required for processing the withdrawal even if user later changes their info.
   * select: false — only decrypted server-side for admin processing.
   */
  kuriaimiAccountNumber: {
    type: EncryptedFieldSchema,
    select: false,
    default: null,
  },

  kuriaimiAccountHolder: {
    type: EncryptedFieldSchema,
    select: false,
    default: null,
  },

  // ── Status ────────────────────────────────────────────────────────────────
  status: {
    type: String,
    enum: {
      values: Object.values(WITHDRAWAL_STATUS),
      message: 'حالة طلب السحب غير صحيحة',
    },
    default: WITHDRAWAL_STATUS.PENDING,
    required: true,
    index: true,
  },

  // ── Admin response ────────────────────────────────────────────────────────
  /**
   * 🔴 CRITICAL: This field MUST be set before approval.
   * WithdrawalService rejects approval if receiptImagePublicId is null.
   * API layer validates: multipart form with receipt file required.
   */
  receiptImagePublicId: {
    type: String,
    default: null,
  },

  adminNote: {
    type: String,
    trim: true,
    maxlength: [500, 'ملاحظة المشرف لا تتجاوز 500 حرف'],
    default: null,
  },

  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },

  approvedByPublicId: {
    type: String,
    default: null,
  },

  approvedAt: {
    type: Date,
    default: null,
  },

  // ── Linked transactions (set atomically on approval) ──────────────────────
  /** The WITHDRAWAL ledger entry */
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction',
    default: null,
  },

  transactionPublicId: {
    type: String,
    default: null,
  },

  /** The WITHDRAWAL_FEE ledger entry */
  feeTransactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction',
    default: null,
  },

  feeTransactionPublicId: {
    type: String,
    default: null,
  },
});

// ---------------------------------------------------------------------------
// Indexes (documentation — created by createCollections.js)
// { userId: 1, status: 1 }       — check for existing pending request
// { status: 1, createdAt: -1 }   — admin approval queue
// { publicId: 1 }  unique
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const WithdrawalRequest = mongoose.model('WithdrawalRequest', withdrawalRequestSchema);

module.exports = WithdrawalRequest;
module.exports.WITHDRAWAL_STATUS = WITHDRAWAL_STATUS;
module.exports.FEE_TYPES = FEE_TYPES;
