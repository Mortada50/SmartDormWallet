/**
 * @file BalanceSnapshot.js
 * @description Mongoose model for monthly balance snapshots.
 *
 * PURPOSE — ARCHIVE STRATEGY (spec §13):
 *   Transactions older than 2 years are moved to transactions_archive by a
 *   monthly background job. To avoid full ledger scans for archived users,
 *   a balance snapshot is taken before archiving.
 *
 *   Live balance calculation:
 *     balance = snapshot.balanceAtSnapshot + SUM(transactions since snapshot)
 *
 *   This makes balance calculation O(months since last snapshot + recent txns)
 *   instead of O(all transactions ever) for long-running accounts.
 *
 * SNAPSHOT CREATION:
 *   Created by the monthly archive job in jobs/archiveTransactions.js.
 *   One snapshot per user per month.
 *   The snapshot captures the user's exact balance AT lastTransactionId time.
 *
 * INTEGRITY:
 *   BalanceService verifies: snapshot.balanceAtSnapshot + delta === current balance
 *   If there is a mismatch, it falls back to full ledger recalculation and
 *   creates an anomaly audit log entry.
 *
 * LEAN HINT:
 *   BalanceSnapshot.findOne({ userId }).sort({ snapshotDate: -1 }).asLean()
 *   to get the most recent snapshot for a user.
 *
 * SPEC REFERENCE: §13 (Data Archiving Policy)
 *
 * @module models/BalanceSnapshot
 */

'use strict';

const mongoose = require('mongoose');
const { createBaseSchema } = require('./_baseSchema');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const balanceSnapshotSchema = createBaseSchema(
  {
    // ── User ──────────────────────────────────────────────────────────────────
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'معرف المستخدم مطلوب'],
      index: true,
    },

    userPublicId: {
      type: String,
      required: true,
    },

    // ── Snapshot date ─────────────────────────────────────────────────────────
    /**
     * The month/year this snapshot represents.
     * Always set to the first day of the month at midnight UTC.
     * Example: 2025-01-01T00:00:00.000Z for January 2025.
     */
    snapshotDate: {
      type: Date,
      required: [true, 'تاريخ اللقطة مطلوب'],
      index: true,
    },

    // ── Financial state at snapshot time ─────────────────────────────────────
    /**
     * The user's exact balance at the time the snapshot was taken.
     * Can be negative (if user is in debt).
     * This is the SUM(creditAmount) - SUM(debitAmount) for ALL transactions
     * up to and including lastTransactionId.
     */
    balanceAtSnapshot: {
      type: Number,
      required: [true, 'الرصيد عند اللقطة مطلوب'],
      validate: {
        validator: Number.isInteger,
        message: 'الرصيد يجب أن يكون عدداً صحيحاً',
      },
    },

    /**
     * The user's outstanding debt at snapshot time.
     * Always >= 0. Debt = MAX(0, -balance) when balance is negative.
     */
    debtAtSnapshot: {
      type: Number,
      required: [true, 'الدين عند اللقطة مطلوب'],
      min: [0, 'الدين لا يمكن أن يكون سالباً'],
      validate: {
        validator: Number.isInteger,
        message: 'الدين يجب أن يكون عدداً صحيحاً',
      },
    },

    /**
     * The ObjectId of the last transaction included in this snapshot.
     * Transactions with createdAt > this transaction are NOT in the snapshot.
     * Used by BalanceService to calculate the delta since the snapshot.
     */
    lastTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction',
      default: null,
    },

    lastTransactionPublicId: {
      type: String,
      default: null,
    },

    /**
     * Total number of transactions included in this snapshot.
     * Used for integrity verification.
     */
    transactionCount: {
      type: Number,
      min: 0,
      default: 0,
      validate: {
        validator: Number.isInteger,
        message: 'عدد العمليات يجب أن يكون عدداً صحيحاً',
      },
    },

    /**
     * SHA-256 checksum of all transaction publicIds included in this snapshot.
     * Used to verify snapshot integrity during balance recalculation.
     */
    checksum: {
      type: String,
      default: null,
    },
  },
  {
    // Snapshots never change after creation
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// ---------------------------------------------------------------------------
// Compound unique index: one snapshot per user per month
// Enforced at application level by the archive job.
// Index: { userId: 1, snapshotDate: -1 }
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const BalanceSnapshot = mongoose.model('BalanceSnapshot', balanceSnapshotSchema);

module.exports = BalanceSnapshot;
