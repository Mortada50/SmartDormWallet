/**
 * @file User.js
 * @description Mongoose model for user accounts.
 *
 * ARCHITECTURAL RULES (enforced here):
 *  ✅ publicId (UUID v4) — the ONLY identifier exposed via API. Never _id.
 *  ✅ _id and __v stripped from toJSON/toObject via _baseSchema transform.
 *  ✅ No balance or debt fields — ALWAYS calculated from transactions collection.
 *  ✅ Kuraimi fields stored as encrypted objects {iv, ciphertext, tag}.
 *     Encryption/decryption happens in the Service layer ONLY.
 *  ✅ No financial or encryption logic in pre-save hooks.
 *  ✅ autoCreate: false, autoIndex: false — collection managed by createCollections.js.
 *
 * LEAN HINT:
 *   Use User.find(...).asLean() for all read-only queries (profile view,
 *   admin list, etc.) to avoid unnecessary Mongoose document overhead.
 *   Only use full documents when calling .save() after mutation.
 *
 * SPEC REFERENCE: §4 (User Profile), §12 (Security), §13 (DB Design)
 *
 * @module models/User
 */

'use strict';

const mongoose = require('mongoose');
const { createBaseSchema } = require('./_baseSchema');

// ---------------------------------------------------------------------------
// Encrypted field sub-schema
// Stores the AES-256-GCM output: { iv, ciphertext, tag }
// The plaintext value is NEVER stored. Decryption is done in EncryptionService.
// ---------------------------------------------------------------------------
const EncryptedFieldSchema = new mongoose.Schema(
  {
    iv: { type: String, required: true },         // Base64 — 12-byte nonce
    ciphertext: { type: String, required: true },  // Base64 — encrypted payload
    tag: { type: String, required: true },         // Base64 — 16-byte auth tag
  },
  { _id: false } // No separate _id for subdocuments
);

// ---------------------------------------------------------------------------
// Schema definition
// ---------------------------------------------------------------------------

const userSchema = createBaseSchema({
  // ── Identity ──────────────────────────────────────────────────────────────
  fullName: {
    type: String,
    required: [true, 'الاسم الكامل مطلوب'],
    trim: true,
    minlength: [2, 'الاسم يجب أن يكون حرفين على الأقل'],
    maxlength: [100, 'الاسم يجب ألا يتجاوز 100 حرف'],
  },

  phone: {
    type: String,
    trim: true,
    maxlength: [20, 'رقم الهاتف يجب ألا يتجاوز 20 رقماً'],
    default: null,
  },

  roomNumber: {
    type: String,
    trim: true,
    maxlength: [20, 'رقم الغرفة يجب ألا يتجاوز 20 حرفاً'],
    default: null,
  },

  /**
   * رقم الحساب الفريد لكل مستخدم (6 أرقام).
   * null للمستخدمين القدامى الذين لم يُفعِّلوا رقم الحساب بعد.
   * بمجرد التفعيل، لا يمكن تغييره.
   */
  accountNumber: {
    type: String,
    default: null,
    match: [/^[0-9]{6}$/, 'رقم الحساب يجب أن يكون 6 أرقام'],
  },

  // ── Authentication ────────────────────────────────────────────────────────
  /**
   * Hashed password (bcrypt, cost factor ≥ 12).
   * Hashing is performed in AuthService, NOT in a pre-save hook.
   * select: false — never returned in queries unless explicitly requested.
   */
  passwordHash: {
    type: String,
    required: [true, 'كلمة المرور مطلوبة'],
    select: false,
  },

  // ── Role & Status ─────────────────────────────────────────────────────────
  role: {
    type: String,
    enum: {
      values: ['admin', 'resident', 'deputy'],
      message: 'الدور يجب أن يكون admin أو resident أو deputy',
    },
    required: [true, 'الدور مطلوب'],
    default: 'resident',
  },

  status: {
    type: String,
    enum: {
      values: ['active', 'suspended'],
      message: 'الحالة يجب أن تكون active أو suspended',
    },
    required: true,
    default: 'active',
  },

  // ── Beneficiaries ─────────────────────────────────────────────────────────
  savedBeneficiaries: {
    type: [{
      name: { type: String, required: true },
      accountNumber: { type: String, required: true },
      addedAt: { type: Date, default: Date.now }
    }],
    default: []
  },

  // ── Profile ───────────────────────────────────────────────────────────────
  /**
   * Cloudinary public_id ONLY — never a full URL.
   * Signed URL is generated on-demand in CloudinaryService (15-min expiry).
   */
  profileImagePublicId: {
    type: String,
    default: null,
  },

  // ── Kuraimi Account (AES-256-GCM encrypted) ───────────────────────────────
  /**
   * ⚠️  SENSITIVE DATA — encrypted at rest.
   * Structure: { iv: String, ciphertext: String, tag: String }
   * Encryption/decryption is performed ONLY in EncryptionService.
   * These fields are select: false — not returned unless explicitly needed.
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

  /**
   * Boolean flags indicating whether Kuraimi info has been set.
   * Used for pre-condition checks without decrypting sensitive data.
   */
  hasKuriaimiAccount: {
    type: Boolean,
    default: false,
  },

  // ── Two-Factor Authentication ─────────────────────────────────────────────
  /**
   * TOTP secret — stored encrypted (AES-256-GCM, same pattern as Kuraimi fields).
   * select: false — only fetched during 2FA verification flow.
   */
  twoFactorSecret: {
    type: String,
    select: false,
    default: null,
  },

  twoFactorEnabled: {
    type: Boolean,
    default: false,
  },

  /**
   * Single-use backup codes (bcrypt-hashed, 8 codes).
   * select: false — only fetched during backup code verification.
   */
  backupCodes: {
    type: [String],
    select: false,
    default: [],
  },

  // ── Login security ────────────────────────────────────────────────────────
  /**
   * Counter of consecutive failed login attempts.
   * Reset to 0 on successful login. Account locked when ≥ 3 (spec §12).
   */
  failedLoginAttempts: {
    type: Number,
    default: 0,
    min: 0,
  },

  /**
   * When set, the account is locked until this date.
   * Checked on every login attempt in AuthService.
   */
  lockedUntil: {
    type: Date,
    default: null,
  },

  lastLoginAt: {
    type: Date,
    default: null,
  },
});

// ---------------------------------------------------------------------------
// Indexes
// NOTE: These are defined here for documentation purposes only.
// Actual index creation is done in createCollections.js.
// autoIndex: false prevents Mongoose from creating them automatically.
//
// Indexes managed by createCollections.js:
//   { publicId: 1 }  unique
//   { role: 1, status: 1 }
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Virtuals
// ---------------------------------------------------------------------------

/**
 * Virtual: isLocked
 * Returns true if the account is currently locked due to failed login attempts.
 * Used by AuthService — NOT stored in DB.
 */
userSchema.virtual('isLocked').get(function () {
  return this.lockedUntil != null && this.lockedUntil > new Date();
});

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const User = mongoose.model('User', userSchema);

module.exports = User;
