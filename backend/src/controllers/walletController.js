/**
 * @file walletController.js
 * @description HTTP handlers for ledger/balance endpoints.
 *
 * ENDPOINTS:
 *   GET  /api/v1/wallet/balance                          — current user balance
 *   GET  /api/v1/wallet/transactions                     — paginated tx history
 *   GET  /api/v1/wallet/transactions/:txPublicId         — single transaction
 *   GET  /api/v1/wallet/debt                             — debt detail
 *   GET  /api/v1/wallet/statement                        — PDF statement (streaming)
 *   GET  /api/v1/users/:userPublicId/balance             — any user's balance (admin)
 *   GET  /api/v1/users/:userPublicId/statement           — admin-generated statement
 *   POST /api/v1/admin/adjustments                       — create adjustment (admin only)
 *   GET  /api/v1/admin/ledger/integrity/:userPublicId    — integrity check (admin)
 *
 * @module controllers/walletController
 */

'use strict';

const { z } = require('zod');
const mongoose = require('mongoose');
const ledgerService = require('../services/ledgerService');
const settingService = require('../services/settingService');
const pdfService    = require('../services/pdfService');
const transactionRepository = require('../repositories/transactionRepository');
const userRepository = require('../repositories/userRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const { asyncHandler, requireFields } = require('../middleware/errorMiddleware');
const { resolveUserId } = require('../middleware/authMiddleware');
const { TRANSACTION_TYPES, AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, ACTOR_ROLES } = require('../models');
const { db } = require('../config');

// ---------------------------------------------------------------------------
// GET /api/v1/wallet/balance  (own balance)
// ---------------------------------------------------------------------------

const getMyBalance = asyncHandler(async (req, res) => {
  const userId = await resolveUserId(req);

  const state = await ledgerService.calculateBalance(
    userId,
    req.user.publicId
  );

  const settings = await settingService.getSettings();

  return res.status(200).json({
    success: true,
    data: {
      balance: state.balance,
      debt: state.debt,
      currency: 'YER',
      transactionCount: state.transactionCount,
      maxDebtLimit: settings.maxDebtPerUser,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/wallet/transactions  (own tx history)
// ---------------------------------------------------------------------------

const getMyTransactions = asyncHandler(async (req, res) => {
  const userId = await resolveUserId(req);
  const { cursor, limit, type, dateFrom, dateTo, amountMin, amountMax, search } = req.query;

  const result = await transactionRepository.findPaginatedForUser(userId, {
    cursor: cursor || undefined,
    limit: parseInt(limit) || 20,
    types: type ? type.split(',') : undefined,
    dateFrom: dateFrom ? new Date(dateFrom) : undefined,
    dateTo: dateTo ? new Date(dateTo) : undefined,
    amountMin: amountMin ? parseInt(amountMin) : undefined,
    amountMax: amountMax ? parseInt(amountMax) : undefined,
    search: search || undefined,
  });

  return res.status(200).json({ success: true, data: result });
});

// ---------------------------------------------------------------------------
// GET /api/v1/wallet/transactions/:txPublicId
// ---------------------------------------------------------------------------

const getTransaction = asyncHandler(async (req, res) => {
  const { txPublicId } = req.params;

  const tx = await transactionRepository.findByPublicId(txPublicId);
  if (!tx) {
    return res.status(404).json({
      success: false,
      code: 'NOT_FOUND',
      message: 'العملية المالية غير موجودة',
    });
  }

  // Users can only see their own transactions
  const effectiveRole = req.user.effectiveRole || req.user.role;
  if (effectiveRole === 'user' && tx.userPublicId !== req.user.publicId) {
    return res.status(403).json({
      success: false,
      code: 'FORBIDDEN',
      message: 'لا يمكنك الاطلاع على هذه العملية',
    });
  }

  return res.status(200).json({ success: true, data: { transaction: tx } });
});

// ---------------------------------------------------------------------------
// GET /api/v1/wallet/debt  (own debt details)
// ---------------------------------------------------------------------------

const getMyDebt = asyncHandler(async (req, res) => {
  const userId = await resolveUserId(req);

  const state = await ledgerService.calculateBalance(userId, req.user.publicId, { bypassCache: false });

  if (state.debt === 0) {
    return res.status(200).json({
      success: true,
      data: {
        debt: 0,
        balance: state.balance,
        message: 'لا يوجد دين مستحق',
        debtTransactions: [],
      },
    });
  }

  const debtTransactions = await transactionRepository.findDebtContributingTransactions(userId);

  return res.status(200).json({
    success: true,
    data: {
      debt: state.debt,
      balance: state.balance,
      debtTransactions,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/users/:userPublicId/balance  (admin — any user's balance)
// ---------------------------------------------------------------------------

const getUserBalance = asyncHandler(async (req, res) => {
  const { userPublicId } = req.params;

  const user = await userRepository.findByPublicId(userPublicId);
  if (!user) {
    return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: 'المستخدم غير موجود' });
  }

  const userDoc = await require('../models').User
    .findOne({ publicId: userPublicId })
    .select('_id')
    .lean();

  const state = await ledgerService.calculateBalance(
    userDoc._id,
    userPublicId,
    { bypassCache: true }
  );

  return res.status(200).json({
    success: true,
    data: {
      userPublicId,
      userName: user.fullName,
      balance: state.balance,
      debt: state.debt,
      currency: 'YER',
      transactionCount: state.transactionCount,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/users/:userPublicId/transactions  (admin — any user's txns)
// ---------------------------------------------------------------------------

const getUserTransactions = asyncHandler(async (req, res) => {
  const { userPublicId } = req.params;

  const userDoc = await require('../models').User
    .findOne({ publicId: userPublicId })
    .select('_id')
    .lean();

  if (!userDoc) {
    return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
  }

  const { cursor, limit, type, dateFrom, dateTo } = req.query;

  const result = await transactionRepository.findPaginatedForUser(userDoc._id, {
    cursor: cursor || undefined,
    limit: parseInt(limit) || 20,
    types: type ? type.split(',') : undefined,
    dateFrom: dateFrom ? new Date(dateFrom) : undefined,
    dateTo: dateTo ? new Date(dateTo) : undefined,
  });

  return res.status(200).json({ success: true, data: result });
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/adjustments  (admin only — manual ledger correction)
// ---------------------------------------------------------------------------

const createAdjustment = asyncHandler(async (req, res) => {
  requireFields(req, ['userPublicId', 'amount', 'direction', 'adminNote']);

  const { userPublicId, amount, direction, adminNote } = req.body;

  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_AMOUNT',
      message: 'مبلغ التعديل يجب أن يكون عدداً صحيحاً موجباً',
    });
  }
  if (!['credit', 'debit'].includes(direction)) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_DIRECTION',
      message: 'اتجاه التعديل يجب أن يكون credit (إضافة) أو debit (خصم)',
    });
  }

  const targetUser = await require('../models').User
    .findOne({ publicId: userPublicId })
    .select('_id publicId fullName')
    .lean();

  if (!targetUser) {
    return res.status(404).json({ success: false, message: 'المستخدم المستهدف غير موجود' });
  }

  const actorId = await resolveUserId(req);

  const session = await db.startSession();
  let adjustmentTx;

  try {
    await session.withTransaction(async () => {
      const txData = ledgerService.buildTransactionData({
        type: TRANSACTION_TYPES.ADJUSTMENT,
        amount,
        direction,
        userId: targetUser._id,
        userPublicId: targetUser.publicId,
        performedBy: actorId,
        performedByPublicId: req.user.publicId,
        performedByRole: 'admin',
        description: `تعديل يدوي: ${direction === 'credit' ? 'إضافة' : 'خصم'} ${amount.toLocaleString('ar-YE')} ريال`,
        adminNote: adminNote.trim(),
        referenceType: 'adjustment',
        metadata: { reason: adminNote.trim(), direction },
      });

      adjustmentTx = await ledgerService.recordTransaction(txData, session);
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority', j: true },
    });
  } finally {
    await session.endSession();
  }

  // Audit log
  await auditLogRepository.createLog({
    actorId,
    actorPublicId: req.user.publicId,
    actorRole: 'admin',
    action: AUDIT_ACTIONS.ADJUSTMENT_CREATED,
    entityType: AUDIT_ENTITY_TYPES.TRANSACTION,
    entityPublicId: adjustmentTx.publicId,
    metadata: {
      targetUserPublicId: userPublicId,
      targetUserName: targetUser.fullName,
      amount,
      direction,
      adminNote: adminNote.trim(),
    },
  });

  return res.status(201).json({
    success: true,
    data: {
      transaction: adjustmentTx,
      message: `تم ${direction === 'credit' ? 'إضافة' : 'خصم'} ${amount.toLocaleString('ar-YE')} ريال من حساب ${targetUser.fullName}`,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/admin/ledger/integrity/:userPublicId  (admin only)
// ---------------------------------------------------------------------------

const checkIntegrity = asyncHandler(async (req, res) => {
  const { userPublicId } = req.params;

  const userDoc = await require('../models').User
    .findOne({ publicId: userPublicId })
    .select('_id publicId')
    .lean();

  if (!userDoc) {
    return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
  }

  const settings = await require('../services/settingService').getSettings();

  const result = await ledgerService.validateTransactionIntegrity(
    userDoc._id,
    userPublicId,
    { allowDebt: settings.allowDebt }
  );

  return res.status(200).json({
    success: true,
    data: result,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/wallet/statement  (stream PDF for own account)
// ---------------------------------------------------------------------------

/** Zod schema for statement query parameters */
const statementQuerySchema = z.object({
  startDate: z.string().refine(s => !isNaN(Date.parse(s)), {
    message: 'startDate يجب أن يكون تاريخاً صحيحاً (YYYY-MM-DD)',
  }),
  endDate: z.string().refine(s => !isNaN(Date.parse(s)), {
    message: 'endDate يجب أن يكون تاريخاً صحيحاً (YYYY-MM-DD)',
  }),
}).refine(data => new Date(data.startDate) <= new Date(data.endDate), {
  message: 'startDate يجب أن يكون قبل endDate',
  path: ['startDate'],
});

/**
 * GET /api/v1/wallet/statement?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *
 * Generates and streams a PDF account statement for the authenticated user.
 * The PDF is streamed directly to the response — no buffering in memory.
 *
 * Security: user can ONLY access their own statement. Admin uses /users/:id/statement.
 */
const getMyStatement = asyncHandler(async (req, res) => {
  // Validate query parameters with Zod
  const queryResult = statementQuerySchema.safeParse(req.query);
  if (!queryResult.success) {
    return res.status(400).json({
      success: false,
      code: 'VALIDATION_ERROR',
      message: 'معاملات الطلب غير صحيحة',
      errors: queryResult.error.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
    });
  }

  const { startDate, endDate } = queryResult.data;
  const userId = await resolveUserId(req);
  const actorName = req.user.fullName || req.user.publicId;
  const actorRole = req.user.role || 'resident';

  const pdfStream = await pdfService.generateUserStatement(
    req.user.publicId,
    new Date(startDate),
    new Date(endDate),
    { name: actorName, role: actorRole }
  );

  // Audit log (non-blocking)
  auditLogRepository.createLog({
    actorId:         userId,
    actorPublicId:   req.user.publicId,
    actorRole:       actorRole,
    actorName:       actorName,
    action:          AUDIT_ACTIONS.REPORT_GENERATED || 'REPORT_GENERATED',
    entityType:      AUDIT_ENTITY_TYPES.USER,
    entityPublicId:  req.user.publicId,
    metadata:        { reportType: 'user_statement', startDate, endDate },
  }).catch(err => require('../config/logger').warn('[walletController] فشل تسجيل الـ audit log لتقرير الكشف', { error: err.message }));

  const filename = `statement-${req.user.publicId}-${startDate}-${endDate}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('X-Report-Generated', new Date().toISOString());

  pdfStream.pipe(res);
});

/**
 * GET /api/v1/users/:userPublicId/statement?startDate=&endDate= (admin only)
 *
 * Admin-generated account statement for any user.
 */
const getUserStatement = asyncHandler(async (req, res) => {
  const queryResult = statementQuerySchema.safeParse(req.query);
  if (!queryResult.success) {
    return res.status(400).json({
      success: false,
      code: 'VALIDATION_ERROR',
      message: 'معاملات الطلب غير صحيحة',
      errors: queryResult.error.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
    });
  }

  const { startDate, endDate } = queryResult.data;
  const { userPublicId } = req.params;

  // Verify target user exists
  const targetUser = await userRepository.findByPublicId(userPublicId);
  if (!targetUser) {
    return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
  }

  const pdfStream = await pdfService.generateUserStatement(
    userPublicId,
    new Date(startDate),
    new Date(endDate),
    { name: req.user.fullName || req.user.publicId, role: req.user.role }
  );

  // Audit log (non-blocking)
  auditLogRepository.createLog({
    actorId:        req.user._id || null,
    actorPublicId:  req.user.publicId,
    actorRole:      req.user.role,
    actorName:      req.user.fullName || req.user.publicId,
    action:         AUDIT_ACTIONS.REPORT_GENERATED || 'REPORT_GENERATED',
    entityType:     AUDIT_ENTITY_TYPES.USER,
    entityPublicId: userPublicId,
    metadata:       { reportType: 'user_statement', startDate, endDate, generatedFor: userPublicId },
  }).catch(() => {});

  const filename = `statement-${userPublicId}-${startDate}-${endDate}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  pdfStream.pipe(res);
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getMyBalance,
  getMyTransactions,
  getTransaction,
  getMyDebt,
  getUserBalance,
  getUserTransactions,
  createAdjustment,
  checkIntegrity,
  getMyStatement,
  getUserStatement,
};
