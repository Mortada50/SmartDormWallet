/**
 * @file Notification.js
 * @description Mongoose model for in-app notification records.
 *
 * DELIVERY MECHANISM (spec §11):
 *   Notifications are stored here, then pushed to clients via:
 *   - Server-Sent Events (SSE) for real-time delivery
 *   - Polling fallback every 30 seconds
 *   Delivery is handled by NotificationService; this model is storage only.
 *
 * UNREAD COUNT:
 *   GET /api/v1/notifications returns unread count via
 *   Notification.countDocuments({ userId, isRead: false })
 *   The compound index { userId, isRead, createdAt } makes this O(log n).
 *
 * AUTO-ARCHIVE (spec §11):
 *   Notifications older than 30 days are auto-archived by a monthly cron job.
 *   Archived notifications have archivedAt set; they are excluded from the
 *   default query but remain queryable.
 *
 * LEAN HINT:
 *   Notification.find({ userId, isRead: false }).asLean() for unread badge count.
 *   Always lean for notification list queries.
 *
 * SPEC REFERENCE: §11 (In-App Notification System)
 *
 * @module models/Notification
 */

'use strict';

const mongoose = require('mongoose');
const { createBaseSchema } = require('./_baseSchema');

// ---------------------------------------------------------------------------
// Notification type constants
// ---------------------------------------------------------------------------

const NOTIFICATION_TYPES = Object.freeze({
  DEPOSIT_APPROVED: 'deposit_approved',
  DEPOSIT_REJECTED: 'deposit_rejected',
  WITHDRAWAL_APPROVED: 'withdrawal_approved',
  WITHDRAWAL_REJECTED: 'withdrawal_rejected',
  SHARED_EXPENSE_ADDED: 'shared_expense_added',
  MERCHANT_PURCHASE_ADDED: 'merchant_purchase_added',
  LOW_BALANCE: 'low_balance',
  DEBT_APPROACHING_LIMIT: 'debt_approaching_limit',
  PENDING_REQUEST_EXPIRING: 'pending_request_expiring',
  EXPENSE_DISPUTED: 'expense_disputed',
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const notificationSchema = createBaseSchema(
  {
    // ── Target user ───────────────────────────────────────────────────────────
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'معرف المستخدم المستلم مطلوب'],
      index: true,
    },

    userPublicId: {
      type: String,
      required: [true, 'المعرف العام للمستخدم مطلوب'],
    },

    // ── Notification content ───────────────────────────────────────────────────
    type: {
      type: String,
      enum: {
        values: Object.values(NOTIFICATION_TYPES),
        message: 'نوع الإشعار غير معروف',
      },
      required: [true, 'نوع الإشعار مطلوب'],
    },

    /**
     * The Arabic notification message (pre-formatted by NotificationService).
     * Examples from spec §11:
     *   'تمت الموافقة على إيداعك بمبلغ 5,000 ريال'
     *   'تم رفض طلب إيداعك. السبب: الإيصال غير واضح'
     */
    message: {
      type: String,
      required: [true, 'نص الإشعار مطلوب'],
      trim: true,
      minlength: [1, 'نص الإشعار لا يمكن أن يكون فارغاً'],
      maxlength: [500, 'نص الإشعار لا يتجاوز 500 حرف'],
    },

    // ── Read state ────────────────────────────────────────────────────────────
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },

    readAt: {
      type: Date,
    },

    // ── Related entity (for drill-down navigation) ─────────────────────────────
    relatedEntityId: {
      type: mongoose.Schema.Types.ObjectId,
    },

    relatedEntityPublicId: {
      type: String,
    },

    relatedEntityType: {
      type: String,
      enum: [
        'depositRequest', 'withdrawalRequest', 'expense',
        'merchantTransaction', 'user', null,
      ],
    },

    // ── Archive ────────────────────────────────────────────────────────────────
    /**
     * Set by the monthly archive cron job for notifications older than 30 days.
     * Archived notifications are excluded from the default query filter
     * { archivedAt: null } in NotificationRepository.
     */
    archivedAt: {
      type: Date,
    },
  },
  {
    // Notifications never need updatedAt except for isRead toggle,
    // but we keep it for debugging convenience.
    timestamps: true,
  }
);

// ---------------------------------------------------------------------------
// Indexes (documentation — created by createCollections.js)
// { userId: 1, isRead: 1, createdAt: -1 }
// { publicId: 1 }  unique
// { createdAt: 1 }  — archive cron query
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const Notification = mongoose.model('Notification', notificationSchema);

module.exports = Notification;
module.exports.NOTIFICATION_TYPES = NOTIFICATION_TYPES;
