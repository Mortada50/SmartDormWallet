/**
 * @file notificationRepository.js
 * @description MongoDB query layer for the notifications collection.
 *
 * @module repositories/notificationRepository
 */

'use strict';

const mongoose = require('mongoose');
const { Notification, NOTIFICATION_TYPES } = require('../models');
const { randomUUID } = require('crypto');

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Finds notifications for a user with cursor-based pagination.
 * Excludes archived notifications by default.
 *
 * @param {mongoose.Types.ObjectId} userId
 * @param {object}                  [filters={}]
 * @param {string}                  [filters.cursor]
 * @param {number}                  [filters.limit=20]
 * @param {boolean}                 [filters.unreadOnly=false]
 * @returns {Promise<{ notifications: object[], nextCursor: string|null, hasMore: boolean, unreadCount: number }>}
 */
async function findPaginatedForUser(userId, filters = {}) {
  const { cursor, limit: rawLimit = 20, unreadOnly = false } = filters;
  const limit = Math.min(Math.max(1, parseInt(rawLimit, 10) || 20), 50);

  const query = { userId };
  query.$or = [{ archivedAt: null }, { archivedAt: { $exists: false } }];
  if (unreadOnly) query.isRead = false;

  if (cursor) {
    const cursorDoc = await Notification
      .findOne({ publicId: cursor, userId })
      .select('_id createdAt')
      .lean();
    if (cursorDoc) {
      query.$and = [
        { $or: [{ archivedAt: null }, { archivedAt: { $exists: false } }] },
        { $or: [
          { createdAt: { $lt: cursorDoc.createdAt } },
          { createdAt: cursorDoc.createdAt, _id: { $lt: cursorDoc._id } },
        ]},
      ];
      delete query.$or;
    }
  }

  const [notifications, unreadCount] = await Promise.all([
    Notification
      .find(query, { _id: 0 })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean(),
    Notification.countDocuments({ userId, isRead: false, $or: [{ archivedAt: null }, { archivedAt: { $exists: false } }] }),
  ]);

  const hasMore = notifications.length > limit;
  const page = hasMore ? notifications.slice(0, limit) : notifications;

  return {
    notifications: page,
    nextCursor: hasMore ? page[page.length - 1].publicId : null,
    hasMore,
    unreadCount,
  };
}

/**
 * Returns the count of unread notifications for a user.
 * Used by the top navigation badge.
 *
 * @param {mongoose.Types.ObjectId} userId
 * @returns {Promise<number>}
 */
async function countUnread(userId) {
  return Notification.countDocuments({ userId, isRead: false, archivedAt: null });
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Creates a notification for a single user.
 *
 * @param {object}                 notifData
 * @param {mongoose.ClientSession} [session]
 * @returns {Promise<object>}
 */
async function createOne(notifData, session) {
  const opts = session ? { session } : {};
  const [doc] = await Notification.create([{
    publicId: randomUUID(),
    ...notifData,
  }], opts);
  return doc.toObject();
}

/**
 * Creates notifications for multiple users atomically.
 * Used when an expense or purchase affects N users.
 *
 * @param {object[]}               notifDataArray
 * @param {mongoose.ClientSession} [session]
 * @returns {Promise<object[]>}
 */
async function createMany(notifDataArray, session) {
  if (!Array.isArray(notifDataArray) || notifDataArray.length === 0) return [];
  const opts = session ? { session } : {};
  const docs = await Notification.create(
    notifDataArray.map(n => ({ publicId: randomUUID(), ...n })),
    opts
  );
  return docs.map(d => d.toObject());
}

/**
 * Marks a single notification as read.
 *
 * @param {string}                  publicId
 * @param {mongoose.Types.ObjectId} userId   - Ownership check.
 * @returns {Promise<boolean>} True if updated.
 */
async function markOneRead(publicId, userId) {
  const result = await Notification.updateOne(
    { publicId, userId, isRead: false },
    { $set: { isRead: true, readAt: new Date() } }
  );
  return result.modifiedCount > 0;
}

/**
 * Marks all unread notifications as read for a user.
 *
 * @param {mongoose.Types.ObjectId} userId
 * @returns {Promise<number>} Count of updated documents.
 */
async function markAllRead(userId) {
  const result = await Notification.updateMany(
    { userId, isRead: false, archivedAt: null },
    { $set: { isRead: true, readAt: new Date() } }
  );
  return result.modifiedCount;
}

/**
 * Archives notifications older than 30 days.
 * Called by the monthly cron job.
 *
 * @returns {Promise<number>} Count of archived documents.
 */
async function archiveOld() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const result = await Notification.updateMany(
    { createdAt: { $lt: thirtyDaysAgo }, archivedAt: null },
    { $set: { archivedAt: new Date() } }
  );
  return result.modifiedCount;
}

module.exports = {
  findPaginatedForUser,
  countUnread,
  createOne,
  createMany,
  markOneRead,
  markAllRead,
  archiveOld,
};
