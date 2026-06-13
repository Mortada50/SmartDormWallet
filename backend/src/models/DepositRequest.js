/**
 * @file DepositRequest.js
 * @description Mongoose model for user deposit requests.
 *
 * WORKFLOW (spec §6):
 *   User submits → PENDING
 *   Admin approves → APPROVED (DEPOSIT transaction created atomically)
 *   Admin rejects  → REJECTED
 *   Auto-expiry    → EXPIRED  (after depositRequestExpiryHours hours via cron)
 *
 * DUPLICATE PREVENTION:
 *   A user may have at most ONE pending deposit request at any time.
 *   Enforced at the API layer (DepositService checks before creating).
 *   The compound index { userId: 1, status: 1 } makes this check O(log n).
 *
 * ANOMALY DETECTION:
 *   If the same referenceNumber is submitted twice by the same user within
 *   24 hours, DepositService flags it as anomalous and notifies admin.
 *
 * LEAN HINT:
 *   DepositRequest.find({ status: 'pending' }).asLean() for the admin queue.
 *   Only load full documents when changing status (atomic findOneAndUpdate).
 *
 * SPEC REFERENCE: §6 (Deposit System), §12 (Anomaly Detection)
 *
 * @module models/DepositRequest
 */

'use strict';

const mongoose = require('mongoose');
const { createBaseSchema } = require('./_baseSchema');

// ---------------------------------------------------------------------------
// Status constants
// ---------------------------------------------------------------------------

const DEPOSIT_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const depositRequestSchema = createBaseSchema({
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
    required: [true, 'مبلغ الإيداع مطلوب'],
    min: [1, 'مبلغ الإيداع يجب أن يكون أكبر من صفر'],
    validate: {
      validator: Number.isInteger,
      message: 'مبلغ الإيداع يجب أن يكون عدداً صحيحاً (ريال يمني بدون كسور)',
    },
  },

  currency: {
    type: String,
    enum: ['YER'],
    default: 'YER',
  },

  /**
   * Cloudinary public_id of the uploaded bank receipt image.
   * The full signed URL is generated on-demand (15-min expiry).
   * NEVER store full Cloudinary URLs.
   */
  receiptImagePublicId: {
    type: String,
    default: null,
  },

  /**
   * External reference number (bank transfer ref, receipt number, etc.).
   * Used for anomaly detection — duplicate refs flagged by DepositService.
   */
  referenceNumber: {
    type: String,
    trim: true,
    maxlength: [100, 'رقم المرجع لا يتجاوز 100 حرف'],
    default: null,
  },

  // ── Status ────────────────────────────────────────────────────────────────
  status: {
    type: String,
    enum: {
      values: Object.values(DEPOSIT_STATUS),
      message: 'حالة طلب الإيداع غير صحيحة',
    },
    default: DEPOSIT_STATUS.PENDING,
    required: true,
    index: true,
  },

  // ── Admin response ────────────────────────────────────────────────────────
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

  // ── Linked transaction ────────────────────────────────────────────────────
  /**
   * Set atomically when the deposit is approved.
   * Points to the DEPOSIT transaction entry in the ledger.
   * Enables "view transaction" drill-down from deposit history.
   */
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction',
    default: null,
  },

  transactionPublicId: {
    type: String,
    default: null,
  },

  // ── Expiry ────────────────────────────────────────────────────────────────
  /**
   * Calculated at creation time: createdAt + settings.depositRequestExpiryHours.
   * The expiry cron job queries { status: 'pending', expiresAt: { $lte: now } }.
   */
  expiresAt: {
    type: Date,
    required: [true, 'تاريخ انتهاء الطلب مطلوب'],
    index: true,
  },

  // ── Anomaly flags ─────────────────────────────────────────────────────────
  isAnomalyFlagged: {
    type: Boolean,
    default: false,
  },

  anomalyReason: {
    type: String,
    default: null,
  },
});

// ---------------------------------------------------------------------------
// Indexes (documentation — created by createCollections.js)
// { userId: 1, status: 1 }       — check for existing pending request
// { status: 1, createdAt: -1 }   — admin approval queue
// { expiresAt: 1, status: 1 }    — expiry cron job
// { publicId: 1 }  unique
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const DepositRequest = mongoose.model('DepositRequest', depositRequestSchema);

module.exports = DepositRequest;
module.exports.DEPOSIT_STATUS = DEPOSIT_STATUS;
