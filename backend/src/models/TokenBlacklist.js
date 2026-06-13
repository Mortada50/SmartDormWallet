/**
 * @file TokenBlacklist.js
 * @description Mongoose model for invalidated refresh tokens.
 *
 * PURPOSE (spec §12 — JWT Refresh Token Rotation):
 *   When a refresh token is rotated (used to get a new access token), the old
 *   token is hashed and inserted here. If a client presents a token that
 *   exists in this collection, it is a REPLAY ATTACK — all sessions for that
 *   user are immediately invalidated.
 *
 * AUTO-CLEANUP:
 *   The TTL index on `expiresAt` automatically deletes documents after they
 *   expire. No manual cleanup job is needed for this collection.
 *   TTL index: { expiresAt: 1, expireAfterSeconds: 0 }
 *   This means MongoDB will delete the document AT OR AFTER `expiresAt`.
 *
 * STORAGE FORMAT:
 *   Token hashes are stored as SHA-256 hex strings.
 *   The hash is computed in AuthService before storage — never the raw token.
 *   This ensures the token is useless even if the blacklist is compromised.
 *
 * CACHE-FIRST STRATEGY:
 *   AuthService checks Redis first: CacheKeys.tokenBlacklist(hash).
 *   Redis TTL matches the token's remaining lifetime.
 *   MongoDB is the durable fallback for cache misses (e.g., after Redis restart).
 *
 * LEAN HINT:
 *   TokenBlacklist.findOne({ tokenHash }).asLean() — fast exists check.
 *
 * SPEC REFERENCE: §12 (Authentication & Security)
 *
 * @module models/TokenBlacklist
 */

'use strict';

const mongoose = require('mongoose');
const { createBaseSchema } = require('./_baseSchema');

// ---------------------------------------------------------------------------
// Blacklisting reasons
// ---------------------------------------------------------------------------

const BLACKLIST_REASONS = Object.freeze({
  ROTATION: 'rotation',         // Normal token rotation
  LOGOUT: 'logout',             // User explicitly logged out
  COMPROMISE: 'compromise',     // Replay attack detected — all sessions revoked
  ADMIN_REVOKE: 'admin_revoke', // Admin manually revoked user sessions
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const tokenBlacklistSchema = createBaseSchema(
  {
    /**
     * SHA-256 hex hash of the invalidated refresh token.
     * The raw token is NEVER stored.
     * Unique index ensures one blacklist entry per token hash.
     */
    tokenHash: {
      type: String,
      required: [true, 'hash الرمز المميز مطلوب'],
      unique: true,
      index: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'معرف المستخدم مطلوب'],
    },

    userPublicId: {
      type: String,
      required: true,
    },

    reason: {
      type: String,
      enum: {
        values: Object.values(BLACKLIST_REASONS),
        message: 'سبب الإلغاء غير صحيح',
      },
      required: true,
      default: BLACKLIST_REASONS.ROTATION,
    },

    /**
     * The exact timestamp when this token naturally expires.
     * MongoDB TTL index deletes this document automatically at this time.
     * Set to: now + JWT_REFRESH_EXPIRES_IN (e.g., now + 7 days).
     */
    expiresAt: {
      type: Date,
      required: [true, 'تاريخ انتهاء صلاحية الرمز المميز مطلوب'],
      index: true, // TTL index defined in createCollections.js
    },
  },
  {
    // Blacklist entries never need updatedAt
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// ---------------------------------------------------------------------------
// Indexes (documentation — created by createCollections.js)
// { expiresAt: 1 }  expireAfterSeconds: 0  ← TTL auto-cleanup
// { tokenHash: 1 }  unique
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const TokenBlacklist = mongoose.model('TokenBlacklist', tokenBlacklistSchema);

module.exports = TokenBlacklist;
module.exports.BLACKLIST_REASONS = BLACKLIST_REASONS;
