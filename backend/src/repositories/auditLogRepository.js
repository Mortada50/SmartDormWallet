/**
 * @file auditLogRepository.js
 * @description Append-only repository for the audit log collection.
 *
 * IMMUTABILITY CONTRACT:
 *   This repository exposes ONLY a createLog() method.
 *   No update or delete methods exist — by design.
 *   The pre-update hook on AuditLog model is a second line of defence.
 *
 * @module repositories/auditLogRepository
 */

'use strict';

const mongoose = require('mongoose');
const { AuditLog } = require('../models');
const logger = require('../config/logger');

/**
 * Creates an audit log entry. The ONLY write operation permitted on this collection.
 *
 * @param {object}                 logData
 * @param {mongoose.ClientSession} [session] - Include in atomic operations.
 * @returns {Promise<void>} Fire-and-forget for non-critical paths.
 */
async function createLog(logData, session) {
  try {
    const opts = session ? { session } : {};
    await AuditLog.create([{
      publicId: require('crypto').randomUUID(),
      ...logData,
    }], opts);
  } catch (err) {
    // Audit log failure must NEVER crash a financial operation.
    // Log the error and continue.
    logger.error('[auditLog] ❌ فشل تسجيل حدث التدقيق', {
      action: logData.action,
      error: err.message,
    });
  }
}

/**
 * Finds audit logs with filtering and offset pagination (admin view).
 *
 * @param {object} [filters={}]
 * @param {string} [filters.actorPublicId]
 * @param {string} [filters.entityType]
 * @param {string} [filters.action]
 * @param {Date}   [filters.dateFrom]
 * @param {Date}   [filters.dateTo]
 * @param {number} [filters.page=1]
 * @param {number} [filters.limit=20]
 * @returns {Promise<{ logs: object[], total: number, page: number, totalPages: number }>}
 */
async function findPaginated(filters = {}) {
  const {
    actorPublicId, entityType, action,
    dateFrom, dateTo,
    page: rawPage = 1, limit: rawLimit = 20,
  } = filters;

  const page = Math.max(1, parseInt(rawPage, 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(rawLimit, 10) || 20), 100);
  const skip = (page - 1) * limit;

  const query = {};
  if (actorPublicId) query.actorPublicId = actorPublicId;
  if (entityType) query.entityType = entityType;
  if (action) query.action = action;
  if (dateFrom instanceof Date || dateTo instanceof Date) {
    query.createdAt = {};
    if (dateFrom instanceof Date) query.createdAt.$gte = dateFrom;
    if (dateTo instanceof Date) query.createdAt.$lte = dateTo;
  }

  const [logs, total] = await Promise.all([
    AuditLog.find(query, { _id: 0 }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(query),
  ]);

  return { logs, total, page, totalPages: Math.ceil(total / limit) };
}

module.exports = { createLog, findPaginated };
