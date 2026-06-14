/**
 * @file expenseRepository.js
 * @description MongoDB query layer for the expenses collection.
 *
 * ARCHITECTURAL RULES:
 *  - Zero business logic here — queries only.
 *  - All read queries use .lean() for minimal memory allocation.
 *  - Write queries require a session (atomic operations).
 *  - Dispute mutations use atomic findOneAndUpdate to prevent race conditions.
 *
 * @module repositories/expenseRepository
 */

'use strict';

const mongoose = require('mongoose');
const { Expense, DISPUTE_STATUS } = require('../models');
const { randomUUID } = require('crypto');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Finds an expense by its publicId.
 *
 * @param {string}                 publicId
 * @param {mongoose.ClientSession} [session]
 * @returns {Promise<object|null>} Lean expense document or null.
 */
async function findByPublicId(publicId, session) {
  const q = Expense.findOne({ publicId }).lean();
  if (session) q.session(session);
  return q;
}

/**
 * Finds all expenses that affect a specific user (cursor-based paginated).
 * Uses the compound index { 'affectedUsers.userId': 1, createdAt: -1 }.
 *
 * @param {mongoose.Types.ObjectId} userId
 * @param {object}                  [filters={}]
 * @param {string}                  [filters.cursor]   - publicId of last seen item.
 * @param {number}                  [filters.limit=20]
 * @param {Date}                    [filters.dateFrom]
 * @param {Date}                    [filters.dateTo]
 * @returns {Promise<{ expenses: object[], nextCursor: string|null, hasMore: boolean }>}
 */
async function findPaginatedForUser(userId, filters = {}) {
  const { cursor, limit: rawLimit = 20, dateFrom, dateTo } = filters;
  const limit = Math.min(Math.max(1, parseInt(rawLimit, 10) || 20), 100);

  const query = { 'affectedUsers.userId': userId };

  if (cursor) {
    const cursorDoc = await Expense
      .findOne({ publicId: cursor })
      .select('_id createdAt')
      .lean();
    if (cursorDoc) {
      query.$or = [
        { createdAt: { $lt: cursorDoc.createdAt } },
        { createdAt: cursorDoc.createdAt, _id: { $lt: cursorDoc._id } },
      ];
    }
  }

  if (dateFrom instanceof Date || dateTo instanceof Date) {
    query.createdAt = {};
    if (dateFrom instanceof Date) query.createdAt.$gte = dateFrom;
    if (dateTo instanceof Date) query.createdAt.$lte = dateTo;
  }

  const expenses = await Expense
    .find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();

  const hasMore = expenses.length > limit;
  const page = hasMore ? expenses.slice(0, limit) : expenses;

  return {
    expenses: page,
    nextCursor: hasMore ? page[page.length - 1].publicId : null,
    hasMore,
  };
}

/**
 * Finds all expenses (admin view) with optional filters and offset pagination.
 *
 * @param {object} [filters={}]
 * @param {number} [filters.page=1]
 * @param {number} [filters.limit=20]
 * @param {Date}   [filters.dateFrom]
 * @param {Date}   [filters.dateTo]
 * @param {string} [filters.search] - Searches expense name.
 * @returns {Promise<{ expenses: object[], total: number, page: number, totalPages: number }>}
 */
async function findAllPaginated(filters = {}) {
  const { page: rawPage = 1, limit: rawLimit = 20, dateFrom, dateTo, search } = filters;
  const page = Math.max(1, parseInt(rawPage, 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(rawLimit, 10) || 20), 100);
  const skip = (page - 1) * limit;

  const query = {};
  if (dateFrom instanceof Date || dateTo instanceof Date) {
    query.createdAt = {};
    if (dateFrom instanceof Date) query.createdAt.$gte = dateFrom;
    if (dateTo instanceof Date) query.createdAt.$lte = dateTo;
  }
  if (search) {
    query.name = { $regex: search.trim(), $options: 'i' };
  }

  const [expenses, total] = await Promise.all([
    Expense.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Expense.countDocuments(query),
  ]);

  return { expenses, total, page, totalPages: Math.ceil(total / limit) };
}

/**
 * Finds all expenses with at least one OPEN dispute (admin disputes panel).
 *
 * @param {object} [filters={}]
 * @param {number} [filters.page=1]
 * @param {number} [filters.limit=20]
 * @returns {Promise<{ expenses: object[], total: number }>}
 */
async function findWithOpenDisputes(filters = {}) {
  const { page: rawPage = 1, limit: rawLimit = 20 } = filters;
  const page = Math.max(1, parseInt(rawPage, 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(rawLimit, 10) || 20), 100);
  const skip = (page - 1) * limit;

  const query = { 'disputes.status': DISPUTE_STATUS.OPEN };

  const [expenses, total] = await Promise.all([
    Expense.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Expense.countDocuments(query),
  ]);

  return { expenses, total, page, totalPages: Math.ceil(total / limit) };
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Creates a new expense document within a session.
 * Called by expenseService after ledger entries are created.
 *
 * @param {object}                 expenseData
 * @param {mongoose.ClientSession} session  - Required.
 * @returns {Promise<object>} The created expense (plain object).
 */
async function createOne(expenseData, session) {
  if (!session) {
    throw new Error('[expenseRepository] session مطلوب لإنشاء مصروف مشترك');
  }
  const [doc] = await Expense.create([expenseData], { session, ordered: true });
  logger.info('[expenseRepository] ✅ تم إنشاء مصروف مشترك', {
    publicId: doc.publicId,
    name: doc.name,
    totalAmount: doc.totalAmount,
    usersCount: doc.affectedUsers.length,
  });
  return doc.toObject();
}

/**
 * Atomically adds a dispute to an expense's disputes array.
 * Uses findOneAndUpdate to prevent concurrent dispute submissions.
 *
 * RACE CONDITION PROTECTION:
 *   - Filter checks that the user IS in affectedUsers (owns the charge)
 *   - Filter checks that no OPEN dispute already exists for this user
 *   - findOneAndUpdate is atomic — no TOCTOU window
 *
 * @param {string} expensePublicId
 * @param {object} disputeData      - The dispute sub-document to push.
 * @returns {Promise<object|null>}  Updated expense or null if preconditions fail.
 */
async function addDispute(expensePublicId, disputeData) {
  return Expense.findOneAndUpdate(
    {
      publicId: expensePublicId,
      // User must be in the expense
      'affectedUsers.userPublicId': disputeData.userPublicId,
      // No existing OPEN dispute for this user
      disputes: {
        $not: {
          $elemMatch: {
            userPublicId: disputeData.userPublicId,
            status: DISPUTE_STATUS.OPEN,
          },
        },
      },
    },
    {
      $push: { disputes: disputeData },
    },
    { new: true, lean: true }
  );
}

/**
 * Atomically resolves a specific dispute within an expense.
 * Updates the dispute sub-document using the positional $ operator.
 *
 * @param {string}                 expensePublicId
 * @param {string}                 disputePublicId
 * @param {object}                 updateFields - Fields to set on the dispute.
 * @param {mongoose.ClientSession} [session]
 * @returns {Promise<object|null>} Updated expense lean doc or null.
 */
async function resolveDispute(expensePublicId, disputePublicId, updateFields, session) {
  const opts = { new: true, lean: true };
  if (session) opts.session = session;

  return Expense.findOneAndUpdate(
    {
      publicId: expensePublicId,
      'disputes.publicId': disputePublicId,
      'disputes.status': DISPUTE_STATUS.OPEN,  // Can only resolve open disputes
    },
    {
      $set: Object.fromEntries(
        Object.entries(updateFields).map(([k, v]) => [`disputes.$.${k}`, v])
      ),
    },
    opts
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  findByPublicId,
  findPaginatedForUser,
  findAllPaginated,
  findWithOpenDisputes,
  createOne,
  addDispute,
  resolveDispute,
};
