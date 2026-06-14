/**
 * @file merchantRepository.js
 * @description MongoDB query layer for the merchants collection.
 *
 * ARCHITECTURAL RULES:
 *  - Zero business logic here — queries only.
 *  - All read queries use .lean() for minimal memory allocation.
 *  - Write queries require a session (atomic operations).
 *  - Outstanding balance is NEVER stored — computed via aggregation.
 *
 * OUTSTANDING BALANCE CALCULATION (spec §10):
 *   SUM(amount WHERE type='purchase') - SUM(amount WHERE type='settlement')
 *   Performed by aggregateOutstandingBalance(merchantId).
 *
 * @module repositories/merchantRepository
 */

'use strict';

const mongoose = require('mongoose');
const { Merchant, MerchantTransaction, MERCHANT_STATUS, MERCHANT_TRANSACTION_TYPES } = require('../models');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Finds a merchant by its publicId.
 *
 * @param {string}                 publicId
 * @param {mongoose.ClientSession} [session]
 * @returns {Promise<object|null>} Lean merchant document or null.
 */
async function findByPublicId(publicId, session) {
  const q = Merchant.findOne({ publicId }).lean();
  if (session) q.session(session);
  return q;
}

/**
 * Finds all merchants with optional filters and offset pagination (admin view).
 *
 * @param {object} [filters={}]
 * @param {number} [filters.page=1]
 * @param {number} [filters.limit=20]
 * @param {string} [filters.status]  - 'active' | 'disabled'
 * @param {string} [filters.search]  - Searches merchant name.
 * @returns {Promise<{ merchants: object[], total: number, page: number, totalPages: number }>}
 */
async function findAllPaginated(filters = {}) {
  const {
    page: rawPage = 1,
    limit: rawLimit = 20,
    status,
    search,
  } = filters;

  const page = Math.max(1, parseInt(rawPage, 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(rawLimit, 10) || 20), 100);
  const skip = (page - 1) * limit;

  const query = {};
  if (status && Object.values(MERCHANT_STATUS).includes(status)) {
    query.status = status;
  }
  if (search) {
    query.name = { $regex: search.trim(), $options: 'i' };
  }

  const [merchants, total] = await Promise.all([
    Merchant.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Merchant.countDocuments(query),
  ]);

  return { merchants, total, page, totalPages: Math.ceil(total / limit) };
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Creates a new merchant document within a session.
 *
 * @param {object}                 data    - Merchant data to persist.
 * @param {mongoose.ClientSession} session - Required.
 * @returns {Promise<object>} The created merchant (plain object).
 */
async function createOne(data, session) {
  if (!session) {
    throw new Error('[merchantRepository] session مطلوب لإنشاء تاجر');
  }
  const [doc] = await Merchant.create([data], { session, ordered: true });
  logger.info('[merchantRepository] ✅ تم إنشاء تاجر جديد', {
    publicId: doc.publicId,
    name: doc.name,
  });
  return doc.toObject();
}

/**
 * Updates a merchant by its publicId using findOneAndUpdate.
 *
 * @param {string} publicId  - Public UUID of the merchant.
 * @param {object} updates   - Fields to $set on the document.
 * @returns {Promise<object|null>} Updated lean merchant or null if not found.
 */
async function updateByPublicId(publicId, updates) {
  return Merchant.findOneAndUpdate(
    { publicId },
    { $set: updates },
    { new: true, lean: true }
  );
}

/**
 * Activates or disables a merchant by its publicId.
 *
 * @param {string}                  publicId - Public UUID.
 * @param {'active'|'disabled'}     status   - Target status.
 * @returns {Promise<object|null>} Updated lean merchant or null if not found.
 */
async function setStatus(publicId, status) {
  return Merchant.findOneAndUpdate(
    { publicId },
    { $set: { status } },
    { new: true, lean: true }
  );
}

// ---------------------------------------------------------------------------
// Aggregations
// ---------------------------------------------------------------------------

/**
 * Computes the outstanding balance for a merchant.
 *
 * FORMULA (spec §10):
 *   outstanding = SUM(purchase.amount) - SUM(settlement.amount)
 *
 * This is the AUTHORITATIVE balance source — never store a balance field
 * on the Merchant document itself.
 *
 * @param {mongoose.Types.ObjectId} merchantId - Internal ObjectId of the merchant.
 * @returns {Promise<number>} Outstanding balance (always ≥ 0 after settlements).
 */
async function aggregateOutstandingBalance(merchantId) {
  const result = await MerchantTransaction.aggregate([
    { $match: { merchantId } },
    {
      $group: {
        _id: '$type',
        total: { $sum: '$amount' },
      },
    },
  ]);

  let purchases = 0;
  let settlements = 0;

  for (const row of result) {
    if (row._id === MERCHANT_TRANSACTION_TYPES.PURCHASE) purchases = row.total;
    if (row._id === MERCHANT_TRANSACTION_TYPES.SETTLEMENT) settlements = row.total;
  }

  return purchases - settlements;
}

/**
 * Computes the detailed balances for a merchant.
 * Returns an object with totalPurchases, totalSettlements, and outstandingBalance.
 *
 * @param {mongoose.Types.ObjectId} merchantId
 * @returns {Promise<{ totalPurchases: number, totalSettlements: number, outstandingBalance: number }>}
 */
async function aggregateBalances(merchantId) {
  const result = await MerchantTransaction.aggregate([
    { $match: { merchantId } },
    {
      $group: {
        _id: '$type',
        total: { $sum: '$amount' },
      },
    },
  ]);

  let purchases = 0;
  let settlements = 0;

  for (const row of result) {
    if (row._id === MERCHANT_TRANSACTION_TYPES.PURCHASE) purchases = row.total;
    if (row._id === MERCHANT_TRANSACTION_TYPES.SETTLEMENT) settlements = row.total;
  }

  return {
    totalPurchases: purchases,
    totalSettlements: settlements,
    outstandingBalance: purchases - settlements,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  findByPublicId,
  findAllPaginated,
  createOne,
  updateByPublicId,
  setStatus,
  aggregateOutstandingBalance,
  aggregateBalances,
};
