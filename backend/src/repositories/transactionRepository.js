/**
 * @file transactionRepository.js
 * @description MongoDB query layer for the transactions collection.
 *
 * ARCHITECTURAL RULES:
 *  - This layer ONLY contains MongoDB queries — zero business logic.
 *  - All financial calculations happen in ledgerService.js (Service layer).
 *  - All read queries use .lean() to reduce memory by ~3–5×.
 *  - All write queries accept a Mongoose session for atomic operations.
 *  - Cursor-based pagination is used for transaction lists (spec §14).
 *  - Aggregation pipeline is used for balance calculation (single DB roundtrip).
 *
 * @module repositories/transactionRepository
 */

'use strict';

const mongoose = require('mongoose');
const { Transaction, TRANSACTION_TYPES } = require('../models');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Balance aggregation pipeline factory
// ---------------------------------------------------------------------------

/**
 * Builds the MongoDB aggregation pipeline for balance calculation.
 * Returns { totalCredits, totalDebits, transactionCount } in one roundtrip.
 *
 * Using $group with conditional $sum is significantly faster than fetching
 * all documents and summing in JavaScript.
 *
 * @param {object} matchFilter - MongoDB match filter (e.g. { userId, createdAt })
 * @returns {object[]} Aggregation pipeline stages
 */
function buildBalancePipeline(matchFilter) {
  return [
    { $match: matchFilter },
    {
      $group: {
        _id: null,
        totalCredits: { $sum: '$creditAmount' },
        totalDebits: { $sum: '$debitAmount' },
        transactionCount: { $sum: 1 },
        // Latest transaction for snapshot anchor
        lastTransactionId: { $last: '$_id' },
        lastTransactionPublicId: { $last: '$publicId' },
        lastCreatedAt: { $last: '$createdAt' },
      },
    },
    {
      $project: {
        _id: 0,
        totalCredits: 1,
        totalDebits: 1,
        transactionCount: 1,
        lastTransactionId: 1,
        lastTransactionPublicId: 1,
        lastCreatedAt: 1,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Aggregates all transactions for a user to compute balance totals.
 * Optionally restricted to transactions after a snapshot (for archive strategy).
 *
 * @param {mongoose.Types.ObjectId} userId        - Internal ObjectId of the user.
 * @param {object}                  [options={}]
 * @param {Date}                    [options.sinceDate]   - Only include txns after this date.
 * @param {mongoose.ClientSession}  [options.session]     - Optional session for consistent reads.
 * @returns {Promise<{
 *   totalCredits: number,
 *   totalDebits: number,
 *   transactionCount: number,
 *   lastTransactionId: mongoose.Types.ObjectId|null,
 *   lastTransactionPublicId: string|null,
 *   lastCreatedAt: Date|null
 * }>} Zero-initialized if no transactions found.
 */
async function aggregateBalanceTotals(userId, options = {}) {
  const matchFilter = { userId };
  if (options.sinceDate instanceof Date) {
    matchFilter.createdAt = { $gt: options.sinceDate };
  }

  const pipeline = buildBalancePipeline(matchFilter);
  const aggOptions = options.session ? { session: options.session } : {};

  const results = await Transaction.aggregate(pipeline, aggOptions);

  // If user has no transactions, return safe zero state
  if (!results.length) {
    return {
      totalCredits: 0,
      totalDebits: 0,
      transactionCount: 0,
      lastTransactionId: null,
      lastTransactionPublicId: null,
      lastCreatedAt: null,
    };
  }

  return results[0];
}

/**
 * Fetches a paginated list of transactions for a user (cursor-based pagination).
 * Cursor is the publicId of the last seen transaction.
 *
 * @param {mongoose.Types.ObjectId} userId    - Internal ObjectId of the user.
 * @param {object}                  filters
 * @param {string}                  [filters.cursor]      - publicId of last seen item.
 * @param {number}                  [filters.limit=20]    - Page size (max 100).
 * @param {string[]}                [filters.types]       - Filter by transaction type(s).
 * @param {Date}                    [filters.dateFrom]    - Start date filter.
 * @param {Date}                    [filters.dateTo]      - End date filter.
 * @param {number}                  [filters.amountMin]   - Min amount filter.
 * @param {number}                  [filters.amountMax]   - Max amount filter.
 * @param {string}                  [filters.search]      - Text search in description.
 * @returns {Promise<{ transactions: object[], nextCursor: string|null, hasMore: boolean }>}
 */
async function findPaginatedForUser(userId, filters = {}) {
  const {
    cursor,
    limit: rawLimit = 20,
    types,
    dateFrom,
    dateTo,
    amountMin,
    amountMax,
    search,
  } = filters;

  const limit = Math.min(Math.max(1, parseInt(rawLimit, 10) || 20), 100);

  // Build query filter
  const query = { userId };

  // Cursor-based: find transactions created before the cursor document
  if (cursor) {
    // Convert cursor publicId → ObjectId for the range condition
    const cursorDoc = await Transaction
      .findOne({ publicId: cursor, userId })
      .select('_id createdAt')
      .lean();

    if (cursorDoc) {
      query.$or = [
        { createdAt: { $lt: cursorDoc.createdAt } },
        {
          createdAt: cursorDoc.createdAt,
          _id: { $lt: cursorDoc._id },
        },
      ];
    }
  }

  // Type filter
  if (Array.isArray(types) && types.length > 0) {
    const validTypes = types.filter(t => Object.values(TRANSACTION_TYPES).includes(t));
    if (validTypes.length > 0) query.type = { $in: validTypes };
  }

  // Date range
  if (dateFrom instanceof Date || dateTo instanceof Date) {
    query.createdAt = {};
    if (dateFrom instanceof Date) query.createdAt.$gte = dateFrom;
    if (dateTo instanceof Date) query.createdAt.$lte = dateTo;
  }

  // Amount range
  if (amountMin != null || amountMax != null) {
    query.amount = {};
    if (amountMin != null) query.amount.$gte = amountMin;
    if (amountMax != null) query.amount.$lte = amountMax;
  }

  // Description search (case-insensitive)
  if (search && typeof search === 'string' && search.trim()) {
    query.description = { $regex: search.trim(), $options: 'i' };
  }

  // Fetch limit + 1 to determine hasMore
  const transactions = await Transaction
    .find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();

  const hasMore = transactions.length > limit;
  const page = hasMore ? transactions.slice(0, limit) : transactions;

  const nextCursor = hasMore ? page[page.length - 1].publicId : null;

  return { transactions: page, nextCursor, hasMore };
}

/**
 * Fetches all transactions that contributed to a user's current debt.
 * "Debt transactions" are debit-direction entries that caused or worsened
 * a negative balance. Used by the Debt Detail page (spec §16).
 *
 * Strategy: returns all DEBIT transactions sorted oldest-first, so the
 * frontend can reconstruct the running balance and highlight the point
 * where debt began.
 *
 * @param {mongoose.Types.ObjectId} userId
 * @returns {Promise<object[]>} Lean transaction array, oldest first.
 */
async function findDebtContributingTransactions(userId) {
  return Transaction
    .find({ userId, debitAmount: { $gt: 0 } })
    .sort({ createdAt: 1 })
    .select('publicId type amount debitAmount creditAmount description createdAt referencePublicId referenceType')
    .lean();
}

/**
 * Finds a single transaction by its publicId.
 *
 * @param {string} publicId
 * @param {mongoose.ClientSession} [session]
 * @returns {Promise<object|null>} Lean transaction or null.
 */
async function findByPublicId(publicId, session) {
  const q = Transaction.findOne({ publicId }).lean();
  if (session) q.session(session);
  return q;
}

/**
 * Finds all transactions linked to a specific reference document
 * (e.g. all ledger entries created for a deposit request).
 *
 * @param {mongoose.Types.ObjectId} referenceId
 * @returns {Promise<object[]>}
 */
async function findByReferenceId(referenceId) {
  return Transaction
    .find({ referenceId })
    .sort({ createdAt: 1 })
    .lean();
}

/**
 * Count of transactions for a user — used for snapshot integrity checks.
 *
 * @param {mongoose.Types.ObjectId} userId
 * @param {object}                  [matchExtra={}] - Additional match conditions.
 * @returns {Promise<number>}
 */
async function countForUser(userId, matchExtra = {}) {
  return Transaction.countDocuments({ userId, ...matchExtra });
}

/**
 * Gets a summary of transactions by type for a date range.
 * Used by the monthly financial report.
 *
 * @param {Date} dateFrom
 * @param {Date} dateTo
 * @returns {Promise<object[]>} Array of { _id: type, totalAmount, count }
 */
async function aggregateByTypeForPeriod(dateFrom, dateTo) {
  return Transaction.aggregate([
    {
      $match: {
        createdAt: { $gte: dateFrom, $lte: dateTo },
      },
    },
    {
      $group: {
        _id: '$type',
        totalAmount: { $sum: '$amount' },
        totalCredits: { $sum: '$creditAmount' },
        totalDebits: { $sum: '$debitAmount' },
        count: { $sum: 1 },
      },
    },
    { $sort: { totalAmount: -1 } },
  ]);
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Creates a single transaction document within a session.
 * This is the ONLY permitted way to write to the transactions collection.
 *
 * ⚠️  NEVER call this outside of a MongoDB session.
 *     All callers must obtain a session via db.startSession() first.
 *
 * @param {object}                 txData   - Transaction field values.
 * @param {mongoose.ClientSession} session  - Active Mongoose session (required).
 * @returns {Promise<object>} The created transaction (lean, publicId-only).
 * @throws {Error} If session is not provided.
 */
async function createOne(txData, session) {
  if (!session) {
    throw new Error(
      '[transactionRepository] ❌ session مطلوب لإنشاء عملية مالية — ' +
      'استخدم db.startSession() أولاً'
    );
  }

  const [doc] = await Transaction.create([txData], { session });

  logger.info('[transactionRepository] ✅ تم تسجيل عملية مالية', {
    publicId: doc.publicId,
    type: doc.type,
    amount: doc.amount,
    userId: doc.userPublicId,
  });

  return doc.toObject();
}

/**
 * Creates multiple transaction documents atomically within a session.
 * Used when a single business action produces multiple ledger entries
 * (e.g. expense creation for N users, or withdrawal + fee).
 *
 * @param {object[]}               txDataArray - Array of transaction field values.
 * @param {mongoose.ClientSession} session     - Active Mongoose session (required).
 * @returns {Promise<object[]>} Array of created transactions (lean).
 */
async function createMany(txDataArray, session) {
  if (!session) {
    throw new Error(
      '[transactionRepository] ❌ session مطلوب لإنشاء عمليات مالية متعددة'
    );
  }
  if (!Array.isArray(txDataArray) || txDataArray.length === 0) {
    throw new Error('[transactionRepository] txDataArray يجب أن يكون مصفوفة غير فارغة');
  }

  const docs = await Transaction.create(txDataArray, { session });

  logger.info('[transactionRepository] ✅ تم تسجيل عمليات مالية متعددة', {
    count: docs.length,
    types: docs.map(d => d.type),
  });

  return docs.map(d => d.toObject());
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Read
  aggregateBalanceTotals,
  findPaginatedForUser,
  findDebtContributingTransactions,
  findByPublicId,
  findByReferenceId,
  countForUser,
  aggregateByTypeForPeriod,

  // Write
  createOne,
  createMany,
};
