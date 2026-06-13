/**
 * @file DeputyAssignment.js
 * @description Mongoose model for temporary deputy admin assignments.
 *
 * DEPUTY ADMIN RULES (spec §3):
 *   - Admin may assign ONE active deputy at a time.
 *   - Deputy can ONLY: approve/reject deposits and withdrawals.
 *   - Deputy CANNOT: create users, configure settings, or access audit logs.
 *   - Deputy status is TIME-LIMITED — admin sets an expiry date/time.
 *   - All deputy actions are labelled separately in audit logs (actorRole: 'deputy').
 *   - Expiry enforcement is performed by AuthMiddleware on every request.
 *
 * ACTIVE DEPUTY CONSTRAINT:
 *   Only one active deputy may exist at any time.
 *   Enforced in DeputyService before creating a new assignment:
 *     - Check { isActive: true } — if found, revoke it first.
 *   The model does not enforce this uniqueness — it is a business rule.
 *
 * AUTO-EXPIRY:
 *   The expiry cron job (or AuthMiddleware) checks expiresAt < now.
 *   When expired, isActive is set to false and an audit log entry is created.
 *
 * LEAN HINT:
 *   DeputyAssignment.findOne({ isActive: true }).asLean() for auth checks.
 *
 * SPEC REFERENCE: §3 (Admin Resilience — Deputy Admin)
 *
 * @module models/DeputyAssignment
 */

'use strict';

const mongoose = require('mongoose');
const { createBaseSchema } = require('./_baseSchema');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const deputyAssignmentSchema = createBaseSchema(
  {
    // ── Assigned user ──────────────────────────────────────────────────────
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'معرف المستخدم المُعيَّن كنائب مطلوب'],
      index: true,
    },

    userPublicId: {
      type: String,
      required: true,
    },

    userName: {
      type: String, // Denormalised for audit log display
    },

    // ── Who granted the assignment ─────────────────────────────────────────
    grantedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'معرف المشرف الذي أجرى التعيين مطلوب'],
    },

    grantedByPublicId: {
      type: String,
      required: true,
    },

    grantedByName: {
      type: String, // Denormalised
    },

    // ── Time window ────────────────────────────────────────────────────────
    /**
     * The assignment is valid until this timestamp.
     * AuthMiddleware must check: isActive === true AND expiresAt > now.
     * When expired, the deputy reverts to a regular user role.
     */
    expiresAt: {
      type: Date,
      required: [true, 'تاريخ انتهاء صلاحية التعيين مطلوب'],
      index: true,
    },

    // ── Status ─────────────────────────────────────────────────────────────
    isActive: {
      type: Boolean,
      required: true,
      default: true,
      index: true,
    },

    // ── Revocation info (set when admin revokes before expiry) ──────────────
    revokedAt: {
      type: Date,
      default: null,
    },

    revokedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    revokedByPublicId: {
      type: String,
      default: null,
    },

    /** 'expired' = auto-expired by system; 'manual' = revoked by admin */
    revocationReason: {
      type: String,
      enum: ['expired', 'manual', null],
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// ---------------------------------------------------------------------------
// Indexes (documentation — created by createCollections.js)
// { userId: 1, isActive: 1 }
// { expiresAt: 1 }
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Virtual: isCurrentlyActive
// True only when isActive === true AND expiresAt is in the future.
// ---------------------------------------------------------------------------
deputyAssignmentSchema.virtual('isCurrentlyActive').get(function () {
  return this.isActive && this.expiresAt > new Date();
});

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const DeputyAssignment = mongoose.model('DeputyAssignment', deputyAssignmentSchema);

module.exports = DeputyAssignment;
