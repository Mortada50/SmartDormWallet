/**
 * @file userRepository.js
 * @description MongoDB query layer for the users collection.
 *
 * SECURITY RULES:
 *  - passwordHash, twoFactorSecret, backupCodes are select:false in the model.
 *    To fetch them, use the dedicated auth-specific query methods below.
 *  - kuraimi fields are select:false — use findWithKuraimi() only when
 *    the Service layer explicitly needs them (withdrawal processing).
 *  - NEVER expose _id in return values — always return publicId-scoped projections.
 *
 * LEAN HINT:
 *   All read methods use .lean() by default.
 *   Full Mongoose documents are only returned by save-mutating methods.
 *
 * @module repositories/userRepository
 */

'use strict';

const mongoose = require('mongoose');
const { User } = require('../models');

// ---------------------------------------------------------------------------
// Default projection — safe fields only (no sensitive data)
// ---------------------------------------------------------------------------
const SAFE_PROJECTION = {
  _id: 0,
  publicId: 1,
  fullName: 1,
  phone: 1,
  roomNumber: 1,
  role: 1,
  status: 1,
  profileImagePublicId: 1,
  hasKuriaimiAccount: 1,
  twoFactorEnabled: 1,
  failedLoginAttempts: 1,
  lockedUntil: 1,
  lastLoginAt: 1,
  createdAt: 1,
  updatedAt: 1,
};

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Find a user by their publicId (UUID).
 *
 * @param {string}  publicId
 * @param {object}  [projection] - Override default safe projection.
 * @returns {Promise<object|null>}
 */
async function findByPublicId(publicId, projection = SAFE_PROJECTION) {
  return User.findOne({ publicId }, projection).lean();
}

/**
 * Find a user by their internal ObjectId.
 * Used internally for DB-level joins — never expose result _id to API.
 *
 * @param {mongoose.Types.ObjectId} id
 * @param {object}                  [projection]
 * @returns {Promise<object|null>}
 */
async function findById(id, projection = SAFE_PROJECTION) {
  return User.findById(id, projection).lean();
}

/**
 * Find multiple users by an array of publicIds.
 * Used by expense/purchase creation to validate selected users.
 *
 * @param {string[]} publicIds
 * @returns {Promise<object[]>} Array of lean user objects (safe fields).
 */
async function findManyByPublicIds(publicIds) {
  return User
    .find({ publicId: { $in: publicIds }, status: 'active' }, SAFE_PROJECTION)
    .lean();
}

/**
 * Find multiple users by an array of internal ObjectIds.
 *
 * @param {mongoose.Types.ObjectId[]} ids
 * @returns {Promise<object[]>}
 */
async function findManyByIds(ids) {
  return User
    .find({ _id: { $in: ids }, status: 'active' }, SAFE_PROJECTION)
    .lean();
}

/**
 * Finds all active users for admin dropdown / bulk operations.
 *
 * @param {object} [filters={}]
 * @param {number} [filters.page=1]
 * @param {number} [filters.limit=50]
 * @param {string} [filters.status='active']
 * @param {string} [filters.search]
 * @returns {Promise<{ users: object[], total: number, page: number, totalPages: number }>}
 */
async function findAllPaginated(filters = {}) {
  const {
    page: rawPage = 1,
    limit: rawLimit = 50,
    status,
    search,
    role,
  } = filters;

  const page = Math.max(1, parseInt(rawPage, 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(rawLimit, 10) || 50), 200);
  const skip = (page - 1) * limit;

  const query = {};
  if (status) query.status = status;
  if (role) query.role = role;
  if (search) {
    query.$or = [
      { fullName: { $regex: search.trim(), $options: 'i' } },
      { phone: { $regex: search.trim(), $options: 'i' } },
    ];
  }

  const [users, total] = await Promise.all([
    User.find(query, SAFE_PROJECTION).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    User.countDocuments(query),
  ]);

  return { users, total, page, totalPages: Math.ceil(total / limit) };
}

/**
 * Finds a user for authentication — includes passwordHash.
 * ONLY used by AuthService during login.
 *
 * @param {string} publicId
 * @returns {Promise<object|null>}
 */
async function findForAuth(publicId) {
  return User
    .findOne({ publicId })
    .select('+passwordHash +twoFactorSecret +backupCodes')
    .lean();
}

/**
 * Finds a user with their encrypted Kuraimi account fields.
 * ONLY used by WithdrawalService when preparing a withdrawal.
 * Decryption happens in EncryptionService (Service layer).
 *
 * @param {mongoose.Types.ObjectId} userId
 * @returns {Promise<object|null>}
 */
async function findWithKuraimi(userId) {
  return User
    .findById(userId)
    .select('+kuriaimiAccountNumber +kuriaimiAccountHolder publicId fullName hasKuriaimiAccount')
    .lean();
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Creates a new user. Used by admin user creation flow.
 *
 * @param {object}                 userData
 * @param {mongoose.ClientSession} [session]
 * @returns {Promise<object>} Created user (safe fields, no _id).
 */
async function createOne(userData, session) {
  const opts = session ? { session } : {};
  const [doc] = await User.create([userData], opts);
  return doc.toObject();
}

/**
 * Updates a user's safe fields (phone, profileImagePublicId, etc.).
 * Returns the updated document. Uses findOneAndUpdate for atomicity.
 *
 * @param {string} publicId
 * @param {object} updates
 * @returns {Promise<object|null>}
 */
async function updateByPublicId(publicId, updates) {
  return User.findOneAndUpdate(
    { publicId },
    { $set: updates },
    { new: true, lean: true, projection: SAFE_PROJECTION }
  );
}

/**
 * Updates a user's Kuraimi account info (encrypted fields).
 * Called by UserService after EncryptionService has encrypted the values.
 *
 * @param {string} publicId
 * @param {object} encryptedKuriaimiData - { kuriaimiAccountNumber, kuriaimiAccountHolder }
 * @returns {Promise<object|null>}
 */
async function updateKuraimi(publicId, encryptedKuriaimiData) {
  return User.findOneAndUpdate(
    { publicId },
    {
      $set: {
        ...encryptedKuriaimiData,
        hasKuriaimiAccount: true,
      },
    },
    { new: true, lean: true, projection: SAFE_PROJECTION }
  );
}

/**
 * Increments failedLoginAttempts and optionally sets lockedUntil.
 * Used by AuthService on failed login.
 *
 * @param {string} publicId
 * @param {Date}   [lockUntil] - If provided, locks the account until this time.
 * @returns {Promise<object|null>}
 */
async function recordFailedLogin(publicId, lockUntil = null) {
  const update = { $inc: { failedLoginAttempts: 1 } };
  if (lockUntil) update.$set = { lockedUntil: lockUntil };

  return User.findOneAndUpdate({ publicId }, update, {
    new: true,
    lean: true,
    projection: { publicId: 1, failedLoginAttempts: 1, lockedUntil: 1 },
  });
}

/**
 * Resets failedLoginAttempts to 0 and clears lockedUntil on successful login.
 *
 * @param {string} publicId
 * @returns {Promise<void>}
 */
async function recordSuccessfulLogin(publicId) {
  await User.updateOne(
    { publicId },
    {
      $set: { failedLoginAttempts: 0, lastLoginAt: new Date() },
      $unset: { lockedUntil: 1 }
    }
  );
}

/**
 * Disables or enables a user account.
 *
 * @param {string}  publicId
 * @param {'active'|'disabled'} status
 * @returns {Promise<object|null>}
 */
async function setStatus(publicId, status) {
  return User.findOneAndUpdate(
    { publicId },
    { $set: { status } },
    { new: true, lean: true, projection: SAFE_PROJECTION }
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  SAFE_PROJECTION,
  findByPublicId,
  findById,
  findManyByPublicIds,
  findManyByIds,
  findAllPaginated,
  findForAuth,
  findWithKuraimi,
  createOne,
  updateByPublicId,
  updateKuraimi,
  recordFailedLogin,
  recordSuccessfulLogin,
  setStatus,
};
