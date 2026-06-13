/**
 * @file MerchantTransaction.js
 * @description Mongoose model for merchant purchases and settlements.
 *
 * TWO TRANSACTION TYPES:
 *   'purchase'    — Admin records a purchase from a merchant.
 *                   Cost is split among selected users.
 *                   Creates one MERCHANT_PURCHASE ledger entry per user.
 *                   Increases merchant outstanding balance.
 *
 *   'settlement'  — Admin pays a merchant.
 *                   Decreases merchant outstanding balance.
 *                   Does NOT create user ledger entries (it's between
 *                   the admin/organisation and the merchant).
 *
 * DUPLICATE INVOICE PREVENTION (spec §10):
 *   invoiceReference is optional. When provided, the compound index
 *   { merchantId: 1, invoiceReference: 1 } (partial, sparse) prevents
 *   duplicate submissions to the same merchant.
 *
 * SETTLEMENT GUARD:
 *   MerchantService must verify that settlement amount ≤ outstanding balance
 *   BEFORE creating this document. The model does not enforce this — it's
 *   a business rule enforced in the Service layer.
 *
 * OUTSTANDING BALANCE CALCULATION:
 *   SUM(amount WHERE type='purchase') - SUM(amount WHERE type='settlement')
 *   Performed by MerchantRepository.calculateOutstandingBalance(merchantId).
 *
 * LEAN HINT:
 *   MerchantTransaction.find({ merchantId, type }).asLean() for merchant ledger.
 *   Use aggregate() for outstanding balance calculation.
 *
 * SPEC REFERENCE: §10 (Merchant System)
 *
 * @module models/MerchantTransaction
 */

'use strict';

const mongoose = require('mongoose');
const { createBaseSchema } = require('./_baseSchema');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERCHANT_TRANSACTION_TYPES = Object.freeze({
  PURCHASE: 'purchase',
  SETTLEMENT: 'settlement',
});

// ---------------------------------------------------------------------------
// Sub-schema: per-user share (for purchases only)
// ---------------------------------------------------------------------------

const UserShareSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    userPublicId: { type: String, required: true },
    userName: { type: String },

    shareAmount: {
      type: Number,
      required: true,
      min: [1, 'حصة المستخدم يجب أن تكون ريالاً واحداً على الأقل'],
      validate: {
        validator: Number.isInteger,
        message: 'حصة المستخدم يجب أن تكون عدداً صحيحاً',
      },
    },

    /** ObjectId of the MERCHANT_PURCHASE transaction created for this user. */
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction',
      default: null,
    },
    transactionPublicId: { type: String, default: null },
  },
  { _id: false }
);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const merchantTransactionSchema = createBaseSchema({
  // ── Merchant link ─────────────────────────────────────────────────────────
  merchantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Merchant',
    required: [true, 'معرف التاجر مطلوب'],
    index: true,
  },

  merchantPublicId: {
    type: String,
    required: [true, 'المعرف العام للتاجر مطلوب'],
  },

  merchantName: {
    type: String, // Denormalised for display
  },

  // ── Transaction type ───────────────────────────────────────────────────────
  type: {
    type: String,
    enum: {
      values: Object.values(MERCHANT_TRANSACTION_TYPES),
      message: 'نوع عملية التاجر يجب أن يكون purchase أو settlement',
    },
    required: [true, 'نوع العملية مطلوب'],
  },

  // ── Amount ────────────────────────────────────────────────────────────────
  amount: {
    type: Number,
    required: [true, 'مبلغ العملية مطلوب'],
    min: [1, 'المبلغ يجب أن يكون أكبر من صفر'],
    validate: {
      validator: Number.isInteger,
      message: 'المبلغ يجب أن يكون عدداً صحيحاً',
    },
  },

  currency: {
    type: String,
    enum: ['YER'],
    default: 'YER',
  },

  // ── Purchase-specific fields ───────────────────────────────────────────────
  description: {
    type: String,
    trim: true,
    maxlength: [500, 'الوصف لا يتجاوز 500 حرف'],
    default: null,
  },

  /**
   * Optional invoice reference number.
   * When provided, the compound partial unique index on
   * { merchantId, invoiceReference } prevents duplicate submissions.
   */
  invoiceReference: {
    type: String,
    trim: true,
    maxlength: [100, 'رقم الفاتورة لا يتجاوز 100 حرف'],
    default: null,
  },

  /**
   * Per-user shares — populated for purchases, empty for settlements.
   * Created atomically with MERCHANT_PURCHASE ledger entries.
   */
  userShares: {
    type: [UserShareSchema],
    default: [],
  },

  // ── Settlement-specific fields ────────────────────────────────────────────
  /**
   * Cloudinary public_id of settlement receipt image.
   * Optional — admin may upload receipt for record-keeping.
   */
  receiptImagePublicId: {
    type: String,
    default: null,
  },

  settlementNotes: {
    type: String,
    trim: true,
    maxlength: [500, 'ملاحظات التسوية لا تتجاوز 500 حرف'],
    default: null,
  },

  // ── Actor ─────────────────────────────────────────────────────────────────
  performedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'معرف المنفّذ مطلوب'],
  },

  performedByPublicId: {
    type: String,
    required: true,
  },
});

// ---------------------------------------------------------------------------
// Indexes (documentation — created by createCollections.js)
// { merchantId: 1, type: 1, createdAt: -1 }
// { publicId: 1 }  unique
// { merchantId: 1, invoiceReference: 1 }  partial unique (sparse)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const MerchantTransaction = mongoose.model(
  'MerchantTransaction',
  merchantTransactionSchema
);

module.exports = MerchantTransaction;
module.exports.MERCHANT_TRANSACTION_TYPES = MERCHANT_TRANSACTION_TYPES;
