'use strict';

/**
 * @file depositService.js
 * @description Business logic for deposit request lifecycle:
 *   submit → pending → approved | rejected | expired.
 *
 * SECURITY NOTES:
 *   - Receipt upload happens BEFORE DB write; on DB failure the Cloudinary
 *     object is automatically deleted (rollback).
 *   - Approval is an atomic operation inside a MongoDB session.
 *   - Optimistic-lock pattern on status='pending' prevents double-approval.
 *
 * @module services/depositService
 */

const { db } = require('../config');
const { cacheDel, CacheKeys } = require('../config/redis');
const logger = require('../config/logger');

const {
  DepositRequest,
  User,
  TRANSACTION_TYPES,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  NOTIFICATION_TYPES,
  DEPOSIT_STATUS,
} = require('../models');

const ledgerService         = require('./ledgerService');
const attachmentService     = require('./attachmentService');
const auditLogRepository    = require('../repositories/auditLogRepository');
const notificationRepository = require('../repositories/notificationRepository');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fetches all admin users for broadcast notifications.
 * @returns {Promise<object[]>}
 */
async function _getAdmins() {
  return User.find({ role: 'admin', status: 'active' }, { _id: 1, publicId: 1, fullName: 1 }).lean();
}

// ---------------------------------------------------------------------------
// 1. submitDepositRequest
// ---------------------------------------------------------------------------

/**
 * Creates a new deposit request for the authenticated user.
 *
 * FLOW:
 *   1. Guard: no existing PENDING request for this user.
 *   2. Upload receipt to Cloudinary.
 *   3. Create DepositRequest document (with anomaly detection).
 *   4. On DB failure → delete the uploaded file (rollback).
 *   5. Notify all admins + write audit log.
 *
 * @param {object} data                 - Validated request body.
 * @param {number} data.amount          - Integer amount in YER.
 * @param {string} [data.referenceNumber] - Optional bank reference number.
 * @param {number} data.expiryHours     - Hours until the request expires.
 * @param {object} file                 - Multer file object (memoryStorage).
 * @param {Buffer} file.buffer          - File content.
 * @param {string} file.mimetype        - MIME type (image/jpeg, image/png, application/pdf).
 * @param {number} file.size            - File size in bytes.
 * @param {object} actor                - Authenticated user.
 * @param {import('mongoose').Types.ObjectId} actor._id
 * @param {string} actor.publicId
 * @param {string} actor.fullName
 * @param {string} actor.role
 * @returns {Promise<{ depositRequest: object, signedReceiptUrl: string|null }>}
 */
async function submitDepositRequest(data, file, actor) {
  const { amount, referenceNumber, expiryHours } = data;

  // ── Guard: only one pending request per user ──────────────────────────────
  const existingPending = await DepositRequest.findOne({
    userId: actor._id,
    status: DEPOSIT_STATUS.PENDING,
  }).lean();

  if (existingPending) {
    throw Object.assign(
      new Error('لديك طلب إيداع قيد الانتظار بالفعل — انتظر معالجته قبل تقديم طلب جديد'),
      { statusCode: 409 }
    );
  }

  // ── Upload receipt ────────────────────────────────────────────────────────
  let receiptImagePublicId = null;
  let signedReceiptUrl     = null;

  if (file && file.buffer) {
    const uploadResult = await attachmentService.uploadDepositReceipt(
      file.buffer,
      actor.publicId,
      file.mimetype
    );
    receiptImagePublicId = uploadResult.public_id ?? uploadResult.publicId ?? uploadResult.cloudinaryPublicId ?? uploadResult;
    // uploadDepositReceipt may return a string (publicId) or an object — handle both
    if (typeof receiptImagePublicId === 'object') {
      receiptImagePublicId = receiptImagePublicId.cloudinaryPublicId || JSON.stringify(receiptImagePublicId);
    }
  }

  // ── Anomaly detection on referenceNumber ─────────────────────────────────
  let isAnomalyFlagged = false;
  let anomalyReason    = null;

  if (referenceNumber) {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const duplicate = await DepositRequest.findOne({
      userId: actor._id,
      referenceNumber,
      createdAt: { $gte: cutoff },
    }).lean();

    if (duplicate) {
      isAnomalyFlagged = true;
      anomalyReason    = `رقم المرجع "${referenceNumber}" مُستخدم مرة أخرى خلال 24 ساعة`;
      logger.warn('[depositService] ⚠️ اكتشاف شذوذ: رقم مرجع مكرر', {
        userId: actor.publicId,
        referenceNumber,
      });
    }
  }

  // ── Create DepositRequest document ───────────────────────────────────────
  const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

  let depositRequest;
  try {
    const [doc] = await DepositRequest.create([{
      userId:              actor._id,
      userPublicId:        actor.publicId,
      amount,
      referenceNumber:     referenceNumber ?? null,
      receiptImagePublicId,
      expiresAt,
      status:              DEPOSIT_STATUS.PENDING,
      isAnomalyFlagged,
      anomalyReason,
    }]);
    depositRequest = doc.toObject();
  } catch (err) {
    // ROLLBACK: delete uploaded file from Cloudinary if DB write fails
    if (receiptImagePublicId) {
      try {
        await attachmentService.deleteAttachment(receiptImagePublicId);
      } catch (cleanupErr) {
        logger.error('[depositService] فشل في حذف الملف بعد فشل الإنشاء', {
          receiptImagePublicId,
          error: cleanupErr.message,
        });
      }
    }
    throw err;
  }

  // ── Generate signed URL for immediate display ─────────────────────────────
  if (receiptImagePublicId) {
    try {
      signedReceiptUrl = await attachmentService.getSecureReceiptUrl(receiptImagePublicId);
    } catch {
      signedReceiptUrl = null;
    }
  }

  // ── Post-create: notify admins ────────────────────────────────────────────
  try {
    const admins = await _getAdmins();
    await Promise.all(
      admins.map((admin) =>
        notificationRepository.createOne({
          userId:      admin._id,
          userPublicId: admin.publicId,
          type:        NOTIFICATION_TYPES.DEPOSIT_APPROVED, // closest valid type for admin alert
          message:     `قدّم ${actor.fullName} طلب إيداع بمبلغ ${amount.toLocaleString()} ريال — بانتظار المراجعة`,
          metadata:    {
            depositRequestPublicId: depositRequest.publicId,
            amount,
            userPublicId: actor.publicId,
            isAnomalyFlagged,
          },
        })
      )
    );
  } catch (notifErr) {
    logger.warn('[depositService] فشل إرسال إشعار الإيداع للمسؤولين', { error: notifErr.message });
  }

  // ── Audit log ─────────────────────────────────────────────────────────────
  // Note: DEPOSIT_REQUESTED is not in the AUDIT_ACTIONS enum, so we use
  // ANOMALY_FLAGGED when applicable, otherwise skip the audit for submission.
  if (isAnomalyFlagged) {
    auditLogRepository.createLog({
      actorId:        actor._id,
      actorPublicId:  actor.publicId,
      actorRole:      actor.role,
      actorName:      actor.fullName,
      action:         AUDIT_ACTIONS.ANOMALY_FLAGGED,
      entityType:     AUDIT_ENTITY_TYPES.DEPOSIT_REQUEST,
      entityId:       depositRequest._id,
      entityPublicId: depositRequest.publicId,
      metadata:       { amount, referenceNumber, anomalyReason },
    }).catch(() => {}); // fire-and-forget
  }

  return { depositRequest, signedReceiptUrl };
}

// ---------------------------------------------------------------------------
// 2. approveDeposit
// ---------------------------------------------------------------------------

/**
 * Admin/deputy approves a pending deposit request.
 *
 * This operation is ATOMIC — the DEPOSIT ledger entry and the status update
 * happen inside a single MongoDB transaction.
 *
 * @param {string} depositPublicId - Public ID of the deposit request.
 * @param {object} actor           - Authenticated admin/deputy.
 * @param {import('mongoose').Types.ObjectId} actor._id
 * @param {string} actor.publicId
 * @param {string} actor.fullName
 * @param {string} actor.role
 * @param {string} [adminNote]     - Optional note visible to the user.
 * @returns {Promise<object>} The updated DepositRequest (lean).
 */
async function approveDeposit(depositPublicId, actor, adminNote) {
  // ── Fetch deposit request ─────────────────────────────────────────────────
  const depositRequest = await DepositRequest.findOne({ publicId: depositPublicId }).lean();
  if (!depositRequest) {
    throw Object.assign(new Error('طلب الإيداع غير موجود'), { statusCode: 404 });
  }
  if (depositRequest.status !== DEPOSIT_STATUS.PENDING) {
    throw Object.assign(
      new Error(`لا يمكن اعتماد هذا الطلب — حالته الحالية: ${depositRequest.status}`),
      { statusCode: 422 }
    );
  }
  if (depositRequest.expiresAt < new Date()) {
    throw Object.assign(new Error('انتهت صلاحية طلب الإيداع'), { statusCode: 422 });
  }

  // ── Fetch user ────────────────────────────────────────────────────────────
  const user = await User.findById(depositRequest.userId).lean();
  if (!user) {
    throw Object.assign(new Error('المستخدم المرتبط بالطلب غير موجود'), { statusCode: 404 });
  }

  // ── Atomic transaction ────────────────────────────────────────────────────
  let updatedDeposit;
  const session = await db.startSession();

  try {
    await session.withTransaction(async () => {
      // a. Build ledger entry data
      const txData = ledgerService.buildTransactionData({
        type:               TRANSACTION_TYPES.DEPOSIT,
        amount:             depositRequest.amount,
        userId:             depositRequest.userId,
        userPublicId:       depositRequest.userPublicId,
        performedBy:        actor._id,
        performedByPublicId: actor.publicId,
        performedByRole:    actor.role,
        description:        'إيداع معتمد',
        adminNote:          adminNote ?? null,
        referenceId:        depositRequest._id,
        referencePublicId:  depositRequest.publicId,
        referenceType:      'depositRequest',
      });

      // b. Record ledger entry
      const txDoc = await ledgerService.recordTransaction(txData, session);

      // c. Update deposit request status (optimistic lock on status='pending')
      updatedDeposit = await DepositRequest.findOneAndUpdate(
        { _id: depositRequest._id, status: DEPOSIT_STATUS.PENDING },
        {
          status:              DEPOSIT_STATUS.APPROVED,
          approvedBy:          actor._id,
          approvedByPublicId:  actor.publicId,
          approvedAt:          new Date(),
          adminNote:           adminNote ?? null,
          transactionId:       txDoc._id,
          transactionPublicId: txDoc.publicId,
        },
        { session, new: true, lean: true }
      );

      if (!updatedDeposit) {
        throw Object.assign(
          new Error('فشل تحديث حالة الطلب — ربما تمت معالجته بالفعل'),
          { statusCode: 409 }
        );
      }
    });
  } finally {
    session.endSession();
  }

  // ── Post-commit (outside transaction) ────────────────────────────────────
  // Invalidate balance cache
  cacheDel(CacheKeys.userBalance(user._id.toString())).catch(() => {});

  // Notify user
  notificationRepository.createOne({
    userId:      user._id,
    userPublicId: user.publicId,
    type:        NOTIFICATION_TYPES.DEPOSIT_APPROVED,
    message:     `تمت الموافقة على إيداع مبلغ ${depositRequest.amount.toLocaleString()} ريال في محفظتك`,
    metadata:    {
      depositRequestPublicId: depositPublicId,
      amount:                 depositRequest.amount,
      approvedByPublicId:     actor.publicId,
    },
  }).catch(() => {});

  // Audit log
  auditLogRepository.createLog({
    actorId:        actor._id,
    actorPublicId:  actor.publicId,
    actorRole:      actor.role,
    actorName:      actor.fullName,
    action:         AUDIT_ACTIONS.DEPOSIT_APPROVED,
    entityType:     AUDIT_ENTITY_TYPES.DEPOSIT_REQUEST,
    entityId:       depositRequest._id,
    entityPublicId: depositPublicId,
    metadata:       {
      amount:      depositRequest.amount,
      userPublicId: depositRequest.userPublicId,
      adminNote,
    },
  }).catch(() => {});

  return updatedDeposit;
}

// ---------------------------------------------------------------------------
// 3. rejectDeposit
// ---------------------------------------------------------------------------

/**
 * Admin/deputy rejects a pending deposit request.
 *
 * Post-rejection: the receipt file is deleted from Cloudinary and the user
 * receives a rejection notification.
 *
 * @param {string} depositPublicId - Public ID of the deposit request.
 * @param {object} actor           - Authenticated admin/deputy.
 * @param {import('mongoose').Types.ObjectId} actor._id
 * @param {string} actor.publicId
 * @param {string} actor.fullName
 * @param {string} actor.role
 * @param {string} reason          - Arabic rejection reason (min 5 chars).
 * @returns {Promise<object>} The updated DepositRequest (lean).
 */
async function rejectDeposit(depositPublicId, actor, reason) {
  // ── Fetch deposit request ─────────────────────────────────────────────────
  const depositRequest = await DepositRequest.findOne({ publicId: depositPublicId }).lean();
  if (!depositRequest) {
    throw Object.assign(new Error('طلب الإيداع غير موجود'), { statusCode: 404 });
  }
  if (depositRequest.status !== DEPOSIT_STATUS.PENDING) {
    throw Object.assign(
      new Error(`لا يمكن رفض هذا الطلب — حالته الحالية: ${depositRequest.status}`),
      { statusCode: 422 }
    );
  }

  // ── Update status (optimistic lock) ──────────────────────────────────────
  const updatedDeposit = await DepositRequest.findOneAndUpdate(
    { _id: depositRequest._id, status: DEPOSIT_STATUS.PENDING },
    {
      status:     DEPOSIT_STATUS.REJECTED,
      adminNote:  reason,
      approvedBy: actor._id,
      approvedAt: new Date(),
    },
    { new: true, lean: true }
  );

  if (!updatedDeposit) {
    throw Object.assign(
      new Error('فشل تحديث الحالة — الطلب ربما تمت معالجته بالفعل'),
      { statusCode: 409 }
    );
  }

  // ── Post-update: cleanup & notifications (outside transaction) ────────────

  // Delete Cloudinary receipt file
  if (depositRequest.receiptImagePublicId) {
    attachmentService.deleteAttachment(depositRequest.receiptImagePublicId).catch((err) => {
      logger.warn('[depositService] فشل حذف الإيصال بعد الرفض', {
        receiptImagePublicId: depositRequest.receiptImagePublicId,
        error: err.message,
      });
    });
  }

  // Notify user
  const user = await User.findById(depositRequest.userId, { _id: 1, publicId: 1 }).lean();
  if (user) {
    notificationRepository.createOne({
      userId:      user._id,
      userPublicId: user.publicId,
      type:        NOTIFICATION_TYPES.DEPOSIT_REJECTED,
      message:     `تم رفض طلب إيداع مبلغ ${depositRequest.amount.toLocaleString()} ريال. السبب: ${reason}`,
      metadata:    {
        depositRequestPublicId: depositPublicId,
        amount:                 depositRequest.amount,
        reason,
      },
    }).catch(() => {});
  }

  // Audit log
  auditLogRepository.createLog({
    actorId:        actor._id,
    actorPublicId:  actor.publicId,
    actorRole:      actor.role,
    actorName:      actor.fullName,
    action:         AUDIT_ACTIONS.DEPOSIT_REJECTED,
    entityType:     AUDIT_ENTITY_TYPES.DEPOSIT_REQUEST,
    entityId:       depositRequest._id,
    entityPublicId: depositPublicId,
    metadata:       {
      amount:      depositRequest.amount,
      userPublicId: depositRequest.userPublicId,
      reason,
    },
  }).catch(() => {});

  return updatedDeposit;
}

// ---------------------------------------------------------------------------
// 4. getMyRequests
// ---------------------------------------------------------------------------

/**
 * Returns paginated deposit requests for the authenticated user.
 * Generates on-the-fly signed URLs for each request that has a receipt.
 *
 * @param {import('mongoose').Types.ObjectId} userId - User's ObjectId.
 * @param {object} [filters={}]
 * @param {number} [filters.page=1]
 * @param {number} [filters.limit=10]
 * @param {string} [filters.status]  - Filter by deposit status.
 * @returns {Promise<{ requests: object[], total: number, page: number, totalPages: number }>}
 */
async function getMyRequests(userId, filters = {}) {
  const page  = Math.max(1, parseInt(filters.page, 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(filters.limit, 10) || 10), 50);
  const skip  = (page - 1) * limit;

  const query = { userId };
  if (filters.status) query.status = filters.status;

  const [docs, total] = await Promise.all([
    DepositRequest.find(query, { _id: 0 })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    DepositRequest.countDocuments(query),
  ]);

  // Attach signed URLs
  const requests = await Promise.all(
    docs.map(async (doc) => {
      if (!doc.receiptImagePublicId) return doc;
      try {
        const signedUrl = await attachmentService.getSecureReceiptUrl(doc.receiptImagePublicId);
        return { ...doc, signedReceiptUrl: signedUrl };
      } catch {
        return { ...doc, signedReceiptUrl: null };
      }
    })
  );

  return { requests, total, page, totalPages: Math.ceil(total / limit) };
}

// ---------------------------------------------------------------------------
// 5. getPendingRequests
// ---------------------------------------------------------------------------

/**
 * Returns paginated deposit requests for the admin queue.
 * Defaults to status='pending' but can be overridden.
 *
 * @param {object} [filters={}]
 * @param {number} [filters.page=1]
 * @param {number} [filters.limit=20]
 * @param {string} [filters.status='pending']
 * @param {string} [filters.dateFrom]  - ISO date string.
 * @param {string} [filters.dateTo]    - ISO date string.
 * @returns {Promise<{ requests: object[], total: number, page: number, totalPages: number }>}
 */
async function getPendingRequests(filters = {}) {
  const page   = Math.max(1, parseInt(filters.page, 10) || 1);
  const limit  = Math.min(Math.max(1, parseInt(filters.limit, 10) || 20), 100);
  const skip   = (page - 1) * limit;
  const status = filters.status ?? DEPOSIT_STATUS.PENDING;

  const query = { status };

  if (filters.dateFrom || filters.dateTo) {
    query.createdAt = {};
    if (filters.dateFrom) query.createdAt.$gte = new Date(filters.dateFrom);
    if (filters.dateTo)   query.createdAt.$lte = new Date(filters.dateTo);
  }

  const [docs, total] = await Promise.all([
    DepositRequest.find(query, { _id: 0 })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('userId', 'fullName phone')
      .lean(),
    DepositRequest.countDocuments(query),
  ]);

  // Attach signed URLs
  const requests = await Promise.all(
    docs.map(async (doc) => {
      const docWithUser = { ...doc, user: doc.userId };
      delete docWithUser.userId;
      
      if (!doc.receiptImagePublicId) return docWithUser;
      try {
        const signedUrl = await attachmentService.getSecureReceiptUrl(doc.receiptImagePublicId);
        return { ...docWithUser, signedReceiptUrl: signedUrl };
      } catch {
        return { ...docWithUser, signedReceiptUrl: null };
      }
    })
  );

  return { requests, total, page, totalPages: Math.ceil(total / limit) };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  submitDepositRequest,
  approveDeposit,
  rejectDeposit,
  getMyRequests,
  getPendingRequests,
};
