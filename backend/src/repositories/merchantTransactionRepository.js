/**
 * @file merchantTransactionRepository.js
 * @description MongoDB query layer for the merchantTransactions collection.
 *
 * ARCHITECTURAL RULES:
 *  - Zero business logic here — queries only.
 *  - All read queries use .lean() for minimal memory allocation.
 *  - Write queries require a session (atomic operations).
 *  - Cursor-based pagination for merchant transaction lists (chronological feeds).
 *
 * DUPLICATE INVOICE PREVENTION (spec §10):
 *   The compound partial unique index { merchantId: 1, invoiceReference: 1 }
 *   on MerchantTransaction enforces uniqueness at the DB level.
 *   findDuplicateInvoice() provides an application-level pre-check for a
 *   better error message than a duplicate key exception.
 *
 * @module repositories/merchantTransactionRepository
 */

'use strict';

const mongoose = require('mongoose');
const { MerchantTransaction } = require('../models');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Finds paginated merchant transactions for a specific merchant (cursor-based).
 *
 * Uses the compound index { merchantId: 1, type: 1, createdAt: -1 }.
 * Sorted newest-first for the transaction feed.
 *
 * @param {mongoose.Types.ObjectId} merchantId
 * @param {object}                  [filters={}]
 * @param {string}                  [filters.cursor]  - publicId of last seen item.
 * @param {number}                  [filters.limit=20]
 * @param {string}                  [filters.type]    - 'purchase' | 'settlement'
 * @param {Date}                    [filters.dateFrom]
 * @param {Date}                    [filters.dateTo]
 * @returns {Promise<{
 *   transactions: object[],
 *   nextCursor: string|null,
 *   hasMore: boolean
 * }>}
 */
async function findPaginatedForMerchant(merchantId, filters = {}) {
  const { cursor, limit: rawLimit = 20, type, dateFrom, dateTo } = filters;
  const limit = Math.min(Math.max(1, parseInt(rawLimit, 10) || 20), 100);

  const query = { merchantId };

  if (type) query.type = type;

  if (dateFrom instanceof Date || dateTo instanceof Date) {
    query.createdAt = {};
    if (dateFrom instanceof Date) query.createdAt.$gte = dateFrom;
    if (dateTo instanceof Date) query.createdAt.$lte = dateTo;
  }

  if (cursor) {
    const cursorDoc = await MerchantTransaction
      .findOne({ publicId: cursor, merchantId })
      .select('_id createdAt')
      .lean();
    if (cursorDoc) {
      query.$or = [
        { createdAt: { $lt: cursorDoc.createdAt } },
        { createdAt: cursorDoc.createdAt, _id: { $lt: cursorDoc._id } },
      ];
    }
  }

  const transactions = await MerchantTransaction
    .find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();

  const hasMore = transactions.length > limit;
  const page = hasMore ? transactions.slice(0, limit) : transactions;

  return {
    transactions: page,
    nextCursor: hasMore ? page[page.length - 1].publicId : null,
    hasMore,
  };
}

/**
 * Finds a merchant transaction by its publicId.
 *
 * @param {string} publicId
 * @returns {Promise<object|null>} Lean transaction document or null.
 */
async function findByPublicId(publicId) {
  return MerchantTransaction.findOne({ publicId }).lean();
}

/**
 * Checks whether an invoiceReference already exists for a given merchant.
 * Used as a pre-flight guard before DB write to provide a clear error.
 *
 * NOTE: The compound partial unique index on { merchantId, invoiceReference }
 * is the authoritative duplicate guard. This check improves error messaging.
 *
 * @param {mongoose.Types.ObjectId} merchantId
 * @param {string}                  invoiceReference
 * @returns {Promise<object|null>} Existing doc if duplicate, null otherwise.
 */
async function findDuplicateInvoice(merchantId, invoiceReference) {
  if (!invoiceReference) return null;
  return MerchantTransaction
    .findOne({ merchantId, invoiceReference })
    .select('publicId invoiceReference createdAt')
    .lean();
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Creates a new merchant transaction document within a session.
 *
 * @param {object}                 data    - Transaction data to persist.
 * @param {mongoose.ClientSession} session - Required.
 * @returns {Promise<object>} The created transaction (plain object).
 */
async function createOne(data, session) {
  if (!session) {
    throw new Error('[merchantTransactionRepository] session مطلوب لإنشاء معاملة تاجر');
  }
  const [doc] = await MerchantTransaction.create([data], { session, ordered: true });
  logger.info('[merchantTransactionRepository] ✅ تم إنشاء معاملة تاجر', {
    publicId: doc.publicId,
    type: doc.type,
    amount: doc.amount,
    merchantPublicId: doc.merchantPublicId,
  });
  return doc.toObject();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  findPaginatedForMerchant,
  findByPublicId,
  findDuplicateInvoice,
  createOne,
};
