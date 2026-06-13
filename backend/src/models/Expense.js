/**
 * @file Expense.js
 * @description Mongoose model for shared expense records.
 *
 * ROUNDING POLICY (spec §5 — Shared Expense Division):
 *   baseShare = Math.floor(totalAmount / numUsers)
 *   remainder = totalAmount % numUsers
 *   First `remainder` users get (baseShare + 1), rest get baseShare.
 *   This guarantees SUM(shares) === totalAmount (no YER lost).
 *   ⚠️  This logic lives in ExpenseService — NOT in this model.
 *
 * DEBT HANDLING:
 *   If a user's balance would go negative after their share is deducted,
 *   their debt increases. Whether this is allowed is controlled by:
 *   settings.allowDebt and settings.maxDebtPerUser.
 *   The check happens in ExpenseService before creating ledger entries.
 *
 * ATOMIC CREATION (spec §8):
 *   All SHARED_EXPENSE ledger entries for all users are created inside a
 *   single MongoDB session (startSession()) alongside the Expense document.
 *
 * DISPUTE SYSTEM:
 *   Users can flag an expense they believe is incorrect.
 *   Disputes are embedded in the expense document as an array.
 *   Admin resolves via dismiss or REFUND transaction.
 *
 * LEAN HINT:
 *   Expense.find({ 'affectedUsers.userId': id }).asLean() for user view.
 *   Use .select('affectedUsers.shareAmount affectedUsers.userId') to avoid
 *   loading the full disputes array when not needed.
 *
 * SPEC REFERENCE: §8 (Shared Expense System), §5 (Rounding Policy)
 *
 * @module models/Expense
 */

'use strict';

const mongoose = require('mongoose');
const { createBaseSchema } = require('./_baseSchema');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISPUTE_STATUS = Object.freeze({
  OPEN: 'open',
  RESOLVED_DISMISSED: 'resolved_dismissed',
  RESOLVED_REFUNDED: 'resolved_refunded',
});

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

/**
 * Per-user share record embedded inside an expense document.
 * One entry per affected user.
 */
const UserShareSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    userPublicId: { type: String, required: true },
    userName: { type: String }, // Denormalised for display without join

    shareAmount: {
      type: Number,
      required: true,
      min: [1, 'حصة المستخدم يجب أن تكون ريالاً واحداً على الأقل'],
      validate: {
        validator: Number.isInteger,
        message: 'حصة المستخدم يجب أن تكون عدداً صحيحاً',
      },
    },

    /** ObjectId of the SHARED_EXPENSE transaction created for this user. */
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction',
      default: null,
    },

    transactionPublicId: { type: String, default: null },
  },
  { _id: false }
);

/**
 * Dispute sub-document embedded in the expense.
 * One entry per dispute raised.
 */
const DisputeSchema = new mongoose.Schema(
  {
    publicId: {
      type: String,
      required: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    userPublicId: { type: String, required: true },
    userName: { type: String },

    note: {
      type: String,
      required: [true, 'ملاحظة الاعتراض مطلوبة'],
      trim: true,
      maxlength: [1000, 'الملاحظة لا تتجاوز 1000 حرف'],
    },

    status: {
      type: String,
      enum: {
        values: Object.values(DISPUTE_STATUS),
        message: 'حالة الاعتراض غير صحيحة',
      },
      default: DISPUTE_STATUS.OPEN,
    },

    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    resolvedByPublicId: { type: String, default: null },
    resolvedAt: { type: Date, default: null },

    /** Set when resolution = resolved_refunded */
    refundTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction',
      default: null,
    },
    refundTransactionPublicId: { type: String, default: null },
    refundAmount: {
      type: Number,
      default: null,
      validate: {
        validator: (v) => v === null || Number.isInteger(v),
        message: 'مبلغ الاسترداد يجب أن يكون عدداً صحيحاً',
      },
    },

    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

// ---------------------------------------------------------------------------
// Main schema
// ---------------------------------------------------------------------------

const expenseSchema = createBaseSchema({
  // ── Expense details ───────────────────────────────────────────────────────
  name: {
    type: String,
    required: [true, 'اسم المصروف مطلوب'],
    trim: true,
    minlength: [1, 'اسم المصروف لا يمكن أن يكون فارغاً'],
    maxlength: [200, 'اسم المصروف لا يتجاوز 200 حرف'],
  },

  description: {
    type: String,
    trim: true,
    maxlength: [1000, 'الوصف لا يتجاوز 1000 حرف'],
    default: null,
  },

  totalAmount: {
    type: Number,
    required: [true, 'إجمالي مبلغ المصروف مطلوب'],
    min: [1, 'إجمالي المبلغ يجب أن يكون أكبر من صفر'],
    validate: {
      validator: Number.isInteger,
      message: 'إجمالي المبلغ يجب أن يكون عدداً صحيحاً (ريال يمني بدون كسور)',
    },
  },

  currency: {
    type: String,
    enum: ['YER'],
    default: 'YER',
  },

  /**
   * Cloudinary public_id of the optional expense receipt image.
   * Signed URL generated on-demand (15-min expiry).
   */
  receiptImagePublicId: {
    type: String,
    default: null,
  },

  /**
   * Date of the expense (may differ from document createdAt).
   * Defaults to the current date at creation time.
   */
  expenseDate: {
    type: Date,
    default: Date.now,
  },

  // ── Creator ───────────────────────────────────────────────────────────────
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'معرف المنشئ مطلوب'],
  },

  createdByPublicId: {
    type: String,
    required: true,
  },

  // ── Per-user shares ───────────────────────────────────────────────────────
  /**
   * Array of per-user share records.
   * Populated atomically with ledger entries in ExpenseService.
   * minItems: 1 enforced by MongoDB JSON Schema validator.
   */
  affectedUsers: {
    type: [UserShareSchema],
    validate: {
      validator: (arr) => arr.length >= 1,
      message: 'يجب اختيار مستخدم واحد على الأقل للمصروف المشترك',
    },
  },

  // ── Disputes ──────────────────────────────────────────────────────────────
  disputes: {
    type: [DisputeSchema],
    default: [],
  },
});

// ---------------------------------------------------------------------------
// Indexes (documentation — created by createCollections.js)
// { 'affectedUsers.userId': 1, createdAt: -1 }  — user's expense view
// { publicId: 1 }  unique
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Virtuals
// ---------------------------------------------------------------------------

/** Number of open (unresolved) disputes */
expenseSchema.virtual('openDisputeCount').get(function () {
  return this.disputes.filter((d) => d.status === DISPUTE_STATUS.OPEN).length;
});

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const Expense = mongoose.model('Expense', expenseSchema);

module.exports = Expense;
module.exports.DISPUTE_STATUS = DISPUTE_STATUS;
