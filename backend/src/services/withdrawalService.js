/**
 * @file withdrawalService.js
 * @description Business logic for withdrawal request lifecycle:
 *   submit → pending → approved | rejected
 *
 * SECURITY NOTES:
 *   - Balance check + withdrawal creation are NOT atomic (no session needed at submit time).
 *   - Approval IS atomic: WITHDRAWAL + WITHDRAWAL_FEE in a single MongoDB session.
 *   - Optimistic-lock on status='pending' prevents double-approval.
 *   - Fee is computed from live settings at approval time (not submit time).
 *
 * @module services/withdrawalService
 */

'use strict';

const { db } = require('../config');
const { cacheDel, CacheKeys } = require('../config/redis');
const { randomUUID } = require('crypto');
const logger = require('../config/logger');

const {
  WithdrawalRequest,
  User,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  NOTIFICATION_TYPES,
} = require('../models');

const ledgerService          = require('./ledgerService');
const attachmentService      = require('./attachmentService');
const auditLogRepository     = require('../repositories/auditLogRepository');
const notificationRepository = require('../repositories/notificationRepository');
const userRepository         = require('../repositories/userRepository');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fetches the singleton settings document (lightweight).
 */
async function _getSettings() {
  const { Setting } = require('../models');
  const s = await Setting.findOne().lean();
  if (!s) throw new Error('إعدادات النظام غير موجودة');
  return s;
}

// ---------------------------------------------------------------------------
// 1. submitWithdrawalRequest
// ---------------------------------------------------------------------------

/**
 * Resident submits a withdrawal request.
 *
 * Guards:
 *  - At most ONE pending withdrawal per user.
 *  - Amount must be within [minWithdrawalAmount, maxWithdrawalAmount].
 *  - Balance must be sufficient for amount + fee (computed from settings).
 *
 * @param {object} params
 * @param {number} params.amount        - Positive integer YER.
 * @param {object} params.actor         - Authenticated user { _id, publicId, fullName, role }.
 * @returns {Promise<object>} Created WithdrawalRequest document.
 */
async function submitWithdrawalRequest({ amount, actor }) {
  const settings = await _getSettings();

  // Guard: one pending per user
  const existingPending = await WithdrawalRequest.findOne({
    userId: actor._id,
    status: 'pending',
  }).lean();

  if (existingPending) {
    const err = new Error('لديك طلب سحب معلق بالفعل — انتظر معالجة الطلب الحالي قبل تقديم طلب جديد');
    err.statusCode = 409;
    err.code = 'WITHDRAWAL_PENDING_EXISTS';
    throw err;
  }

  // Validate amount limits
  if (amount < settings.minWithdrawalAmount) {
    const err = new Error(`الحد الأدنى للسحب هو ${settings.minWithdrawalAmount.toLocaleString()} ريال`);
    err.statusCode = 400;
    err.code = 'WITHDRAWAL_BELOW_MIN';
    throw err;
  }
  if (amount > settings.maxWithdrawalAmount) {
    const err = new Error(`الحد الأقصى للسحب هو ${settings.maxWithdrawalAmount.toLocaleString()} ريال`);
    err.statusCode = 400;
    err.code = 'WITHDRAWAL_ABOVE_MAX';
    throw err;
  }

  // Compute fee and check balance sufficiency
  const { feeAmount, totalRequired, isSufficient } = ledgerService.computeWithdrawalDetails({
    withdrawalAmount: amount,
    currentBalance: 0, // Will be checked freshly below
    feeType:  settings.withdrawalFeeType,
    feeValue: settings.withdrawalFeeValue,
  });

  // Fresh balance check
  const balanceResult = await ledgerService.calculateBalance(actor._id, actor.publicId, { bypassCache: false });
  const { balance } = balanceResult;

  const { isSufficient: isActuallySufficient } = ledgerService.computeWithdrawalDetails({
    withdrawalAmount: amount,
    currentBalance: balance,
    feeType:  settings.withdrawalFeeType,
    feeValue: settings.withdrawalFeeValue,
  });

  if (!isActuallySufficient) {
    const err = new Error(
      `رصيدك الحالي (${balance.toLocaleString()} ريال) لا يكفي لتغطية مبلغ السحب والرسوم ` +
      `(${totalRequired.toLocaleString()} ريال)`
    );
    err.statusCode = 422;
    err.code = 'INSUFFICIENT_BALANCE';
    throw err;
  }

  // Create WithdrawalRequest
  const [doc] = await WithdrawalRequest.create([{
    publicId:      randomUUID(),
    userId:        actor._id,
    userPublicId:  actor.publicId,
    amount,
    status:        'pending',
  }]);

  logger.info('[withdrawalService] ✅ طلب سحب جديد', {
    userPublicId: actor.publicId,
    amount,
    feeAmount,
    totalRequired,
    balance,
  });

  return doc.toObject();
}

// ---------------------------------------------------------------------------
// 2. approveWithdrawal
// ---------------------------------------------------------------------------

/**
 * Admin/deputy approves a pending withdrawal request.
 * Atomically deducts WITHDRAWAL + WITHDRAWAL_FEE from the user's ledger.
 *
 * @param {string} withdrawalPublicId
 * @param {object} actor - Admin/deputy user object.
 * @param {string} [adminNote]
 * @param {object} [file] - Multer file object for the receipt.
 * @returns {Promise<object>} Updated WithdrawalRequest.
 */
async function approveWithdrawal(withdrawalPublicId, actor, adminNote, file) {
  if (!file) {
    const err = new Error('صورة إيصال التحويل مطلوبة للموافقة على السحب');
    err.statusCode = 400;
    throw err;
  }

  // Fetch withdrawal request
  const withdrawalRequest = await WithdrawalRequest.findOne({ publicId: withdrawalPublicId }).lean();
  if (!withdrawalRequest) {
    const err = new Error('طلب السحب غير موجود');
    err.statusCode = 404;
    throw err;
  }
  if (withdrawalRequest.status !== 'pending') {
    const err = new Error(`لا يمكن الموافقة على طلب بحالة: ${withdrawalRequest.status}`);
    err.statusCode = 422;
    err.code = 'WITHDRAWAL_NOT_PENDING';
    throw err;
  }

  // Fetch user
  const user = await User.findById(withdrawalRequest.userId, { _id: 1, publicId: 1 }).lean();
  if (!user) {
    const err = new Error('المستخدم غير موجود');
    err.statusCode = 404;
    throw err;
  }

  // Get settings for fee calculation
  const settings = await _getSettings();

  // Compute fee at approval time
  const { feeAmount, netAmount, totalRequired } = ledgerService.computeWithdrawalDetails({
    withdrawalAmount: withdrawalRequest.amount,
    currentBalance: 0, // We'll check balance inside transaction
    feeType:  settings.withdrawalFeeType,
    feeValue: settings.withdrawalFeeValue,
  });

  // ── Atomic MongoDB session ──────────────────────────────────────────────────
  const session = await db.startSession();
  let updatedWithdrawal;
  let receiptImagePublicId = null;

  try {
    await session.withTransaction(async () => {
      // Check balance sufficiency inside transaction (consistent read)
      const balanceResult = await ledgerService.calculateBalance(
        withdrawalRequest.userId,
        withdrawalRequest.userPublicId,
        { bypassCache: true, session }
      );

      if (balanceResult.balance < totalRequired) {
        const err = new Error(
          `رصيد المستخدم (${balanceResult.balance.toLocaleString()} ريال) لا يكفي ` +
          `لتغطية السحب والرسوم (${totalRequired.toLocaleString()} ريال)`
        );
        err.statusCode = 422;
        err.code = 'INSUFFICIENT_BALANCE';
        throw err;
      }

      // Upload receipt to Cloudinary
      const uploadResult = await attachmentService.uploadDepositReceipt(
        file.buffer,
        actor.publicId,
        file.mimetype
      );
      receiptImagePublicId = uploadResult.cloudinaryPublicId;

      // Create ledger entries atomically
      const { withdrawalTx, feeTx } = await ledgerService.processWithdrawalApproval({
        userId:               withdrawalRequest.userId,
        userPublicId:         withdrawalRequest.userPublicId,
        withdrawalAmount:     withdrawalRequest.amount,
        feeAmount,
        feeType:              settings.withdrawalFeeType,
        feeValue:             settings.withdrawalFeeValue,
        referenceId:          withdrawalRequest._id,
        referencePublicId:    withdrawalRequest.publicId,
        performedBy:          actor._id,
        performedByPublicId:  actor.publicId,
        performedByRole:      actor.role,
        adminNote:            adminNote ?? null,
        session,
      });

      // Optimistic lock update on status='pending'
      updatedWithdrawal = await WithdrawalRequest.findOneAndUpdate(
        { _id: withdrawalRequest._id, status: 'pending' },
        {
          status:                 'approved',
          approvedBy:             actor._id,
          approvedByPublicId:     actor.publicId,
          approvedAt:             new Date(),
          adminNote:              adminNote ?? null,
          feeType:                settings.withdrawalFeeType,
          feeValue:               settings.withdrawalFeeValue,
          feeAmount,
          netAmount,
          transactionId:          withdrawalTx._id,
          transactionPublicId:    withdrawalTx.publicId,
          feeTransactionId:       feeTx?._id ?? null,
          feeTransactionPublicId: feeTx?.publicId ?? null,
          receiptImagePublicId,
        },
        { session, new: true, lean: true }
      );

      if (!updatedWithdrawal) {
        const err = new Error('تم معالجة هذا الطلب بالفعل — تعارض بين طلبين متزامنين');
        err.statusCode = 409;
        throw err;
      }
    });
  } catch (error) {
    // Rollback Cloudinary image if DB transaction fails
    if (receiptImagePublicId) {
      attachmentService.deleteAttachment(receiptImagePublicId).catch(err => {
        logger.error('[withdrawalService] Failed to cleanup Cloudinary receipt on rollback', { error: err.message });
      });
    }
    throw error;
  } finally {
    await session.endSession();
  }

  // ── Post-commit (outside transaction) ─────────────────────────────────────
  cacheDel(CacheKeys.userBalance(user._id.toString())).catch(() => {});

  // Notify user
  notificationRepository.createOne({
    userId:      user._id,
    userPublicId: user.publicId,
    type:        NOTIFICATION_TYPES.WITHDRAWAL_APPROVED,
    message:     `تمت الموافقة على طلب سحب مبلغ ${withdrawalRequest.amount.toLocaleString()} ريال — صافي المبلغ المحول: ${netAmount.toLocaleString()} ريال`,
    metadata:    { withdrawalPublicId, amount: withdrawalRequest.amount, netAmount, feeAmount },
  }).catch(() => {});

  // Audit log
  auditLogRepository.createLog({
    actorId:        actor._id,
    actorPublicId:  actor.publicId,
    actorRole:      actor.role,
    actorName:      actor.fullName,
    action:         AUDIT_ACTIONS.WITHDRAWAL_APPROVED,
    entityType:     AUDIT_ENTITY_TYPES.WITHDRAWAL_REQUEST,
    entityId:       withdrawalRequest._id,
    entityPublicId: withdrawalPublicId,
    metadata:       { amount: withdrawalRequest.amount, netAmount, feeAmount, userPublicId: user.publicId, adminNote },
  }).catch(() => {});

  return updatedWithdrawal;
}

// ---------------------------------------------------------------------------
// 3. rejectWithdrawal
// ---------------------------------------------------------------------------

/**
 * Admin/deputy rejects a pending withdrawal request.
 *
 * @param {string} withdrawalPublicId
 * @param {string} reason - Required rejection reason.
 * @param {object} actor
 * @returns {Promise<object>} Updated WithdrawalRequest.
 */
async function rejectWithdrawal(withdrawalPublicId, reason, actor) {
  const withdrawalRequest = await WithdrawalRequest.findOne({ publicId: withdrawalPublicId }).lean();
  if (!withdrawalRequest) {
    const err = new Error('طلب السحب غير موجود');
    err.statusCode = 404;
    throw err;
  }
  if (withdrawalRequest.status !== 'pending') {
    const err = new Error(`لا يمكن رفض طلب بحالة: ${withdrawalRequest.status}`);
    err.statusCode = 422;
    err.code = 'WITHDRAWAL_NOT_PENDING';
    throw err;
  }

  // Optimistic lock on status='pending'
  const updatedWithdrawal = await WithdrawalRequest.findOneAndUpdate(
    { _id: withdrawalRequest._id, status: 'pending' },
    {
      status:             'rejected',
      adminNote:          reason,
      approvedBy:         actor._id,
      approvedByPublicId: actor.publicId,
      approvedAt:         new Date(),
    },
    { new: true, lean: true }
  );

  if (!updatedWithdrawal) {
    const err = new Error('تم معالجة هذا الطلب بالفعل');
    err.statusCode = 409;
    throw err;
  }

  // Fetch user for notification
  const user = await User.findById(withdrawalRequest.userId, { _id: 1, publicId: 1 }).lean();
  if (user) {
    notificationRepository.createOne({
      userId:      user._id,
      userPublicId: user.publicId,
      type:        NOTIFICATION_TYPES.WITHDRAWAL_REJECTED,
      message:     `تم رفض طلب سحب مبلغ ${withdrawalRequest.amount.toLocaleString()} ريال. السبب: ${reason}`,
      metadata:    { withdrawalPublicId, amount: withdrawalRequest.amount, reason },
    }).catch(() => {});
  }

  // Audit log
  auditLogRepository.createLog({
    actorId:        actor._id,
    actorPublicId:  actor.publicId,
    actorRole:      actor.role,
    actorName:      actor.fullName,
    action:         AUDIT_ACTIONS.WITHDRAWAL_REJECTED,
    entityType:     AUDIT_ENTITY_TYPES.WITHDRAWAL_REQUEST,
    entityId:       withdrawalRequest._id,
    entityPublicId: withdrawalPublicId,
    metadata:       { amount: withdrawalRequest.amount, reason, userPublicId: withdrawalRequest.userPublicId },
  }).catch(() => {});

  return updatedWithdrawal;
}

// ---------------------------------------------------------------------------
// 4. getMyWithdrawals
// ---------------------------------------------------------------------------

/**
 * Returns paginated withdrawal history for the authenticated user.
 *
 * @param {mongoose.Types.ObjectId} userId
 * @param {object} filters
 * @returns {Promise<{ requests: object[], total, page, totalPages }>}
 */
async function getMyWithdrawals(userId, filters = {}) {
  const page  = Math.max(1, parseInt(filters.page, 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(filters.limit, 10) || 20), 100);
  const skip  = (page - 1) * limit;

  const query = { userId };
  if (filters.status) query.status = filters.status;

  const [docs, total] = await Promise.all([
    WithdrawalRequest.find(query, { _id: 0, kuriaimiAccountNumber: 0, kuriaimiAccountHolder: 0 })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    WithdrawalRequest.countDocuments(query),
  ]);

  return { requests: docs, total, page, totalPages: Math.ceil(total / limit) };
}

// ---------------------------------------------------------------------------
// 5. getPendingWithdrawals
// ---------------------------------------------------------------------------

/**
 * Returns paginated pending withdrawal requests for admin.
 *
 * @param {object} filters
 * @returns {Promise<{ requests: object[], total, page, totalPages }>}
 */
async function getPendingWithdrawals(filters = {}) {
  const page   = Math.max(1, parseInt(filters.page, 10) || 1);
  const limit  = Math.min(Math.max(1, parseInt(filters.limit, 10) || 20), 100);
  const skip   = (page - 1) * limit;
  const status = filters.status ?? 'pending';

  const query = { status };
  if (filters.dateFrom || filters.dateTo) {
    query.createdAt = {};
    if (filters.dateFrom) query.createdAt.$gte = new Date(filters.dateFrom);
    if (filters.dateTo)   query.createdAt.$lte = new Date(filters.dateTo);
  }

  const [docs, total] = await Promise.all([
    WithdrawalRequest.find(query, { _id: 0, kuriaimiAccountNumber: 0, kuriaimiAccountHolder: 0 })
      .sort({ createdAt: 1 }) // Oldest first for admin queue
      .skip(skip)
      .limit(limit)
      .populate('userId', 'fullName phone roomNumber')
      .lean(),
    WithdrawalRequest.countDocuments(query),
  ]);

  const requests = docs.map(doc => {
    const withUser = { ...doc, user: doc.userId };
    delete withUser.userId;
    return withUser;
  });

  return { requests, total, page, totalPages: Math.ceil(total / limit) };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  submitWithdrawalRequest,
  approveWithdrawal,
  rejectWithdrawal,
  getMyWithdrawals,
  getPendingWithdrawals,
};
