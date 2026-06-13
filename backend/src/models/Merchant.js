/**
 * @file Merchant.js
 * @description Mongoose model for merchant profiles.
 *
 * OUTSTANDING BALANCE:
 *   A merchant's outstanding balance is a VIRTUAL value.
 *   It is NEVER stored on this document.
 *   Calculation: SUM(purchases) - SUM(settlements) from MerchantTransaction.
 *   Performed by MerchantRepository.calculateOutstandingBalance(merchantId).
 *
 * SETTLEMENT GUARD (spec §10):
 *   Settlement amount > outstanding balance MUST be rejected at the API level.
 *   This check is performed in MerchantService, NOT in this model.
 *
 * DUPLICATE INVOICE (spec §10):
 *   An optional invoiceReference field on MerchantTransaction has a
 *   partial unique compound index: { merchantId, invoiceReference }.
 *   This prevents duplicate invoice submission to the same merchant.
 *
 * LEAN HINT:
 *   Merchant.find({ status: 'active' }).asLean() for purchase dropdown.
 *   The outstanding balance virtual requires aggregation, not lean queries.
 *
 * SPEC REFERENCE: §10 (Merchant System)
 *
 * @module models/Merchant
 */

'use strict';

const mongoose = require('mongoose');
const { createBaseSchema } = require('./_baseSchema');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERCHANT_STATUS = Object.freeze({
  ACTIVE: 'active',
  DISABLED: 'disabled',
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const merchantSchema = createBaseSchema({
  name: {
    type: String,
    required: [true, 'اسم التاجر مطلوب'],
    trim: true,
    minlength: [1, 'اسم التاجر لا يمكن أن يكون فارغاً'],
    maxlength: [200, 'اسم التاجر لا يتجاوز 200 حرف'],
  },

  phone: {
    type: String,
    trim: true,
    maxlength: [20, 'رقم الهاتف لا يتجاوز 20 رقماً'],
    default: null,
  },

  notes: {
    type: String,
    trim: true,
    maxlength: [1000, 'الملاحظات لا تتجاوز 1000 حرف'],
    default: null,
  },

  status: {
    type: String,
    enum: {
      values: Object.values(MERCHANT_STATUS),
      message: 'حالة التاجر غير صحيحة — يجب أن تكون active أو disabled',
    },
    default: MERCHANT_STATUS.ACTIVE,
    required: true,
    index: true,
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
});

// ---------------------------------------------------------------------------
// Indexes (documentation — created by createCollections.js)
// { publicId: 1 }  unique
// { status: 1 }
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const Merchant = mongoose.model('Merchant', merchantSchema);

module.exports = Merchant;
module.exports.MERCHANT_STATUS = MERCHANT_STATUS;
