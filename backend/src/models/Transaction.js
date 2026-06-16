/**
 * @file Transaction.js
 * @description Mongoose model for the immutable financial ledger.
 *
 * ██████████████████████████████████████████████████████████████████████████
 * ██  CRITICAL — READ THIS BEFORE MODIFYING THIS FILE                     ██
 * ██████████████████████████████████████████████████████████████████████████
 *
 * This collection is the SINGLE SOURCE OF TRUTH for all financial state.
 * Its integrity guarantees the correctness of every balance, debt, and
 * report in the system.
 *
 * IMMUTABILITY CONTRACT:
 *   - Once a transaction document is created, it MUST NEVER be updated or
 *     deleted through application code.
 *   - Corrections are made by creating new ADJUSTMENT or REFUND entries.
 *   - The MongoDB application user is granted INSERT-only rights on this
 *     collection via Atlas RBAC — UPDATE and DELETE are blocked at DB level.
 *
 * SIGN CONVENTION (spec §5):
 *   - `amount`       → always a positive integer (the magnitude)
 *   - `creditAmount` → copy of amount if this entry increases balance, else 0
 *   - `debitAmount`  → copy of amount if this entry decreases balance, else 0
 *
 * BALANCE FORMULA (spec §5):
 *   balance = SUM(creditAmount) - SUM(debitAmount) for all user transactions
 *
 * FLOATING POINT IS FORBIDDEN:
 *   All amounts are whole integers (YER). Math.floor / Math.ceil are used
 *   explicitly in the Service layer. JavaScript float arithmetic is never
 *   used for monetary values.
 *
 * LEAN HINT:
 *   Transaction queries are the most frequent in the system.
 *   ALWAYS use Transaction.find(...).asLean() for statement/balance queries.
 *   Never load full Mongoose documents for aggregation-only operations —
 *   use Model.aggregate() directly instead.
 *
 * SPEC REFERENCE: §5 (Ledger System), §13 (DB Design)
 *
 * @module models/Transaction
 */

'use strict';

const mongoose = require('mongoose');
const { createBaseSchema } = require('./_baseSchema');

// ---------------------------------------------------------------------------
// Constants — re-exported for use in Service / Repository layers
// ---------------------------------------------------------------------------

/**
 * All valid transaction types (spec §5 — Transaction Sign Convention table).
 * Importing this enum prevents magic strings across the codebase.
 */
const TRANSACTION_TYPES = Object.freeze({
  DEPOSIT: 'DEPOSIT',                     // Credit (+)
  WITHDRAWAL: 'WITHDRAWAL',               // Debit  (-)
  WITHDRAWAL_FEE: 'WITHDRAWAL_FEE',       // Debit  (-)
  SHARED_EXPENSE: 'SHARED_EXPENSE',       // Debit  (-)
  MERCHANT_PURCHASE: 'MERCHANT_PURCHASE', // Debit  (-)
  DEBT_SETTLEMENT: 'DEBT_SETTLEMENT',     // Debit  (-)
  ADJUSTMENT: 'ADJUSTMENT',               // Credit (+) or Debit (-)
  REFUND: 'REFUND',                       // Credit (+)
  TRANSFER_IN: 'TRANSFER_IN',             // Credit (+) - incoming transfer
  TRANSFER_OUT: 'TRANSFER_OUT',           // Debit  (-) - outgoing transfer
});

/**
 * Types that increase a user's balance (credit direction).
 */
const CREDIT_TYPES = Object.freeze([
  TRANSACTION_TYPES.DEPOSIT,
  TRANSACTION_TYPES.REFUND,
  TRANSACTION_TYPES.TRANSFER_IN,
  // ADJUSTMENT can be credit — determined by creditAmount > 0
]);

/**
 * Types that decrease a user's balance (debit direction).
 */
const DEBIT_TYPES = Object.freeze([
  TRANSACTION_TYPES.WITHDRAWAL,
  TRANSACTION_TYPES.WITHDRAWAL_FEE,
  TRANSACTION_TYPES.SHARED_EXPENSE,
  TRANSACTION_TYPES.MERCHANT_PURCHASE,
  TRANSACTION_TYPES.DEBT_SETTLEMENT,
  TRANSACTION_TYPES.TRANSFER_OUT,
  // ADJUSTMENT can be debit — determined by debitAmount > 0
]);

const SUPPORTED_CURRENCIES = Object.freeze(['YER']);

// ---------------------------------------------------------------------------
// Reference types (for the referenceType field)
// ---------------------------------------------------------------------------
const REFERENCE_TYPES = Object.freeze({
  DEPOSIT_REQUEST: 'depositRequest',
  WITHDRAWAL_REQUEST: 'withdrawalRequest',
  EXPENSE: 'expense',
  MERCHANT_TRANSACTION: 'merchantTransaction',
  ADJUSTMENT: 'adjustment',
  TRANSFER: 'transfer',
});

// ---------------------------------------------------------------------------
// Schema definition
// ---------------------------------------------------------------------------

const transactionSchema = createBaseSchema(
  {
    // ── User link ──────────────────────────────────────────────────────────
    /**
     * Internal ObjectId reference — used for DB-level $lookup and indexes.
     * NEVER exposed in API responses. Use userPublicId for external use.
     */
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'معرف المستخدم مطلوب'],
      index: true,
    },

    /**
     * Denormalised UUID of the user — enables query without $lookup.
     * Redundant with userId but avoids expensive joins on hot paths.
     */
    userPublicId: {
      type: String,
      required: [true, 'المعرف العام للمستخدم مطلوب'],
      index: true,
    },

    // ── Type & Amounts ─────────────────────────────────────────────────────
    type: {
      type: String,
      enum: {
        values: Object.values(TRANSACTION_TYPES),
        message: 'نوع العملية غير صحيح',
      },
      required: [true, 'نوع العملية مطلوب'],
    },

    /**
     * The absolute magnitude of the transaction.
     * Always a positive integer (YER). Never zero. Never a decimal.
     */
    amount: {
      type: Number,
      required: [true, 'مبلغ العملية مطلوب'],
      min: [1, 'المبلغ يجب أن يكون عدداً صحيحاً موجباً'],
      validate: {
        validator: Number.isInteger,
        message: 'المبلغ يجب أن يكون عدداً صحيحاً (بدون كسور)',
      },
    },

    /**
     * Amount credited to the user's balance.
     * = amount  if this is a credit-direction transaction
     * = 0       if this is a debit-direction transaction
     *
     * Set by the Service layer based on transaction type.
     * Used in the balance aggregation pipeline:
     *   balance = SUM(creditAmount) - SUM(debitAmount)
     */
    creditAmount: {
      type: Number,
      required: true,
      min: [0, 'creditAmount يجب أن يكون صفراً أو أكثر'],
      default: 0,
      validate: {
        validator: Number.isInteger,
        message: 'creditAmount يجب أن يكون عدداً صحيحاً',
      },
    },

    /**
     * Amount debited from the user's balance.
     * = amount  if this is a debit-direction transaction
     * = 0       if this is a credit-direction transaction
     */
    debitAmount: {
      type: Number,
      required: true,
      min: [0, 'debitAmount يجب أن يكون صفراً أو أكثر'],
      default: 0,
      validate: {
        validator: Number.isInteger,
        message: 'debitAmount يجب أن يكون عدداً صحيحاً',
      },
    },

    // ── Currency ───────────────────────────────────────────────────────────
    currency: {
      type: String,
      enum: {
        values: SUPPORTED_CURRENCIES,
        message: 'العملة غير مدعومة — يُستخدم YER فقط',
      },
      required: true,
      default: 'YER',
    },

    // ── Reference (link back to originating request/expense/etc.) ──────────
    /**
     * ObjectId of the originating document (depositRequest, expense, etc.).
     * Used for drill-down queries: "show me the deposit request for this tx".
     */
    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },

    /** Public UUID of the reference — for API responses without $lookup. */
    referencePublicId: {
      type: String,
      default: null,
    },

    referenceType: {
      type: String,
      enum: {
        values: Object.values(REFERENCE_TYPES),
        message: 'نوع المرجع غير صحيح',
      },
      default: null,
    },

    // ── Human-readable fields ───────────────────────────────────────────────
    description: {
      type: String,
      trim: true,
      maxlength: [500, 'الوصف لا يتجاوز 500 حرف'],
      default: null,
    },

    adminNote: {
      type: String,
      trim: true,
      maxlength: [500, 'ملاحظة المشرف لا تتجاوز 500 حرف'],
      default: null,
    },

    // ── Actor (who performed this transaction) ──────────────────────────────
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    performedByPublicId: {
      type: String,
      default: null,
    },

    performedByRole: {
      type: String,
      enum: {
        values: ['admin', 'deputy', 'system'],
        message: 'دور المنفّذ غير صحيح',
      },
      default: 'system',
    },

    // ── Flexible metadata ──────────────────────────────────────────────────
    /**
     * Extra contextual data stored as a plain object.
     * Examples:
     *   WITHDRAWAL_FEE → { feeType: 'PERCENTAGE', feeValue: 5 }
     *   SHARED_EXPENSE → { expenseName: '...', totalUsers: 4, shareIndex: 2 }
     *   MERCHANT_PURCHASE → { merchantName: '...', invoiceRef: '...' }
     */
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    // Optimistic concurrency — Mongoose increments __v on every save.
    // Used with findOneAndUpdate({__v: expectedVersion}) to detect race conditions.
    // Note: __v is NOT exposed via toJSON (stripped by _baseSchema transform),
    // but it IS used internally by the Repository layer for OCC checks.
    optimisticConcurrency: true,
  }
);

// ---------------------------------------------------------------------------
// Compound indexes (documentation — actual creation in createCollections.js)
// ---------------------------------------------------------------------------
// { userId: 1, createdAt: -1 }           — user statement queries
// { userId: 1, type: 1, createdAt: -1 }  — balance calculation by type
// { referenceId: 1 }                      — link back to request docs
// { userPublicId: 1, createdAt: -1 }      — cursor-based pagination

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const Transaction = mongoose.model('Transaction', transactionSchema);

module.exports = Transaction;
module.exports.TRANSACTION_TYPES = TRANSACTION_TYPES;
module.exports.CREDIT_TYPES = CREDIT_TYPES;
module.exports.DEBIT_TYPES = DEBIT_TYPES;
module.exports.REFERENCE_TYPES = REFERENCE_TYPES;
module.exports.SUPPORTED_CURRENCIES = SUPPORTED_CURRENCIES;
