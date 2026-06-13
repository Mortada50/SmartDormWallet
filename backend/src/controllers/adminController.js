/**
 * @file adminController.js
 * @description HTTP handlers for admin dashboard, user management, and system settings.
 *
 * ENDPOINTS:
 *   GET    /api/v1/admin/dashboard                      — overview stats
 *   GET    /api/v1/admin/users                          — list users (paginated)
 *   POST   /api/v1/admin/users                          — create new user
 *   GET    /api/v1/admin/users/:publicId                — get user details with balance
 *   PATCH  /api/v1/admin/users/:publicId/status         — toggle user status
 *   PATCH  /api/v1/admin/users/:publicId/reset-password — reset user password (admin)
 *   GET    /api/v1/admin/settings                       — view system settings
 *   PATCH  /api/v1/admin/settings                       — update system settings
 *   GET    /api/v1/admin/reports/monthly                — stream monthly PDF report
 *   GET    /api/v1/admin/reports/debt                   — stream debt PDF report
 *   GET    /api/v1/admin/disputes                       — view disputed expenses
 *   PATCH  /api/v1/admin/disputes/:publicId/resolve     — resolve disputed expense
 *
 * @module controllers/adminController
 */

'use strict';

const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { User, DepositRequest, Expense, AuditLog, MerchantTransaction, Transaction } = require('../models');
const userRepository = require('../repositories/userRepository');
const settingService = require('../services/settingService');
const ledgerService = require('../services/ledgerService');
const pdfService = require('../services/pdfService');
const expenseService = require('../services/expenseService');
const { asyncHandler } = require('../middleware/errorMiddleware');
const auditLogRepository = require('../repositories/auditLogRepository');
const { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } = require('../models');

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const createUserSchema = z.object({
  fullName: z.string().min(3, 'الاسم يجب أن يكون 3 حروف على الأقل').max(100),
  phone: z.string().regex(/^[0-9+]{9,15}$/, 'رقم الهاتف غير صحيح'),
  roomNumber: z.string().max(20).optional(),
  role: z.enum(['resident', 'admin', 'deputy']).default('resident'),
  initialPin: z.string().min(6).max(6).regex(/^[0-9]{6}$/, 'الرمز يجب أن يكون 6 أرقام'),
});

const updateSettingsSchema = z.object({
  withdrawalFeeType: z.enum(['FIXED', 'PERCENTAGE']).optional(),
  withdrawalFeeValue: z.number().min(0).optional(),
  allowDebt: z.boolean().optional(),
  maxDebtPerUser: z.number().int().nonnegative().optional(),
  depositRequestExpiryHours: z.number().int().positive().optional(),
  lowBalanceThreshold: z.number().int().nonnegative().optional(),
  maintenanceMode: z.boolean().optional(),
}).refine(obj => Object.keys(obj).length > 0, { message: 'يجب توفير حقل واحد على الأقل' });

const toggleStatusSchema = z.object({
  status: z.enum(['active', 'suspended']),
});

const resetPasswordSchema = z.object({
  newPin: z
    .string()
    .length(6, 'يجب أن تكون 6 أرقام بالضبط')
    .regex(/^[0-9]{6}$/, 'يجب أن تتكون من أرقام فقط'),
});

const resolveDisputeSchema = z.object({
  disputePublicId: z.string(),
  resolutionType: z.enum(['dismiss', 'refund']),
  adminNote: z.string().min(5, 'قرار النزاع يجب أن يكون 5 حروف على الأقل').max(1000),
});

/** Inline Zod validation middleware factory */
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'بيانات الطلب غير صحيحة',
        errors: result.error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message,
        })),
      });
    }
    req.body = result.data;
    next();
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/dashboard
// ---------------------------------------------------------------------------

const getDashboard = asyncHandler(async (req, res) => {
  const [
    activeResidentCount,
    pendingDepositCount,
    openDisputeCount,
    recentLogs,
    merchantStats,
    ledgerStatsRaw
  ] = await Promise.all([
    User.countDocuments({ status: 'active', role: 'resident' }),
    DepositRequest.countDocuments({ status: 'pending' }),
    Expense.countDocuments({ 'disputes.status': 'open' }),
    AuditLog.find().sort({ createdAt: -1 }).limit(5).lean(),
    MerchantTransaction.aggregate([
      {
        $group: {
          _id: '$type',
          total: { $sum: '$amount' }
        }
      }
    ]),
    Transaction.aggregate([
      {
        $group: {
          _id: '$userId',
          balance: { $sum: { $subtract: ['$creditAmount', '$debitAmount'] } }
        }
      },
      {
        $group: {
          _id: null,
          totalSystemBalance: { $sum: '$balance' },
          totalOutstandingDebt: {
            $sum: { $cond: [{ $lt: ['$balance', 0] }, { $multiply: ['$balance', -1] }, 0] }
          }
        }
      }
    ]),
  ]);

  const merchantPurchases = merchantStats.find(s => s._id === 'purchase')?.total || 0;
  const merchantSettlements = merchantStats.find(s => s._id === 'settlement')?.total || 0;
  const pendingMerchantsBalance = Math.max(0, merchantPurchases - merchantSettlements);

  const ledgerStats = ledgerStatsRaw[0] || { totalSystemBalance: 0, totalOutstandingDebt: 0 };

  return res.status(200).json({
    success: true,
    data: {
      activeResidentCount,
      pendingDepositCount,
      openDisputeCount,
      pendingMerchantsBalance,
      totalSystemBalance: ledgerStats.totalSystemBalance,
      totalOutstandingDebt: ledgerStats.totalOutstandingDebt,
      recentLogs,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/admin/users
// ---------------------------------------------------------------------------

const listUsers = asyncHandler(async (req, res) => {
  const result = await userRepository.findAllPaginated(req.query);
  return res.status(200).json({
    success: true,
    data: {
      ...result,
      docs: result.users,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/admin/users/:userPublicId
// ---------------------------------------------------------------------------

const getUserDetail = asyncHandler(async (req, res) => {
  const { userPublicId } = req.params;

  const user = await userRepository.findByPublicId(userPublicId);
  if (!user) {
    return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
  }

  const state = await ledgerService.calculateBalance(user._id, userPublicId);

  return res.status(200).json({
    success: true,
    data: {
      user,
      financials: {
        balance: state.balance,
        debt: state.debt,
        transactionCount: state.transactionCount,
      },
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/users
// ---------------------------------------------------------------------------

const createUser = asyncHandler(async (req, res) => {
  const { fullName, phone, roomNumber, role, initialPin } = req.body;
  const { db } = require('../config');
  const session = await db.startSession();

  let newUser;
  try {
    const passwordHash = await bcrypt.hash(initialPin, 12);
    
    await session.withTransaction(async () => {
      newUser = await userRepository.createOne({
        fullName,
        phone,
        roomNumber,
        role,
        passwordHash,
      }, session);
    });
  } finally {
    session.endSession();
  }

  await auditLogRepository.createLog({
    actorId: req.user._id,
    actorPublicId: req.user.publicId,
    actorRole: req.user.role,
    actorName: req.user.fullName,
    action: AUDIT_ACTIONS.USER_CREATED || 'USER_CREATED',
    entityType: AUDIT_ENTITY_TYPES.USER,
    entityId: newUser._id,
    entityPublicId: newUser.publicId,
    metadata: { role, roomNumber },
  }).catch(() => {});

  return res.status(201).json({
    success: true,
    data: newUser,
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/admin/users/:userPublicId/status
// ---------------------------------------------------------------------------

const toggleUserStatus = asyncHandler(async (req, res) => {
  const { userPublicId } = req.params;
  const { status } = req.body;

  const updatedUser = await userRepository.updateByPublicId(userPublicId, { status });
  if (!updatedUser) {
    return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
  }

  await auditLogRepository.createLog({
    actorId: req.user._id,
    actorPublicId: req.user.publicId,
    actorRole: req.user.role,
    actorName: req.user.fullName,
    action: AUDIT_ACTIONS.USER_STATUS_CHANGED || 'USER_STATUS_CHANGED',
    entityType: AUDIT_ENTITY_TYPES.USER,
    entityId: updatedUser._id,
    entityPublicId: updatedUser.publicId,
    metadata: { newStatus: status },
  }).catch(() => {});

  return res.status(200).json({
    success: true,
    data: updatedUser,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/admin/settings
// ---------------------------------------------------------------------------

const getSettings = asyncHandler(async (req, res) => {
  const settings = await settingService.getSettings();
  return res.status(200).json({
    success: true,
    data: settings,
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/admin/settings
// ---------------------------------------------------------------------------

const updateSettings = asyncHandler(async (req, res) => {
  const updatedSettings = await settingService.updateSettings(req.body, req.user);
  return res.status(200).json({
    success: true,
    data: updatedSettings,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/admin/reports/monthly
// ---------------------------------------------------------------------------

const generateMonthlyReportPdf = asyncHandler(async (req, res) => {
  const { month } = req.query; // optional YYYY-MM
  const targetDate = month ? new Date(month) : new Date();

  if (isNaN(targetDate.getTime())) {
    return res.status(400).json({ success: false, message: 'تاريخ غير صحيح' });
  }

  const actor = { name: req.user.fullName || req.user.publicId, role: req.user.role };
  const pdfStream = await pdfService.generateMonthlyDormReport(targetDate, actor);

  await auditLogRepository.createLog({
    actorId: req.user._id,
    actorPublicId: req.user.publicId,
    actorRole: req.user.role,
    actorName: actor.name,
    action: AUDIT_ACTIONS.BACKUP_CREATED || 'REPORT_GENERATED',
    entityType: AUDIT_ENTITY_TYPES.SYSTEM,
    metadata: { reportType: 'monthly_dorm', month: targetDate.toISOString() },
  }).catch(() => {});

  const filename = `monthly-report-${targetDate.toISOString().slice(0, 7)}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');

  pdfStream.pipe(res);
});

// ---------------------------------------------------------------------------
// GET /api/v1/admin/reports/debt
// ---------------------------------------------------------------------------

const generateDebtReportPdf = asyncHandler(async (req, res) => {
  const actor = { name: req.user.fullName || req.user.publicId, role: req.user.role };
  const pdfStream = await pdfService.generateDebtReport(actor);

  await auditLogRepository.createLog({
    actorId: req.user._id,
    actorPublicId: req.user.publicId,
    actorRole: req.user.role,
    actorName: actor.name,
    action: AUDIT_ACTIONS.BACKUP_CREATED || 'REPORT_GENERATED',
    entityType: AUDIT_ENTITY_TYPES.SYSTEM,
    metadata: { reportType: 'debt_report' },
  }).catch(() => {});

  const filename = `debt-report-${new Date().toISOString().slice(0, 10)}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');

  pdfStream.pipe(res);
});

// ---------------------------------------------------------------------------
// GET /api/v1/admin/disputes
// ---------------------------------------------------------------------------

const getDisputedExpenses = asyncHandler(async (req, res) => {
  const disputes = await Expense.find({ 'disputes.status': 'open' })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  return res.status(200).json({
    success: true,
    data: disputes,
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/admin/disputes/:expensePublicId/resolve
// ---------------------------------------------------------------------------

const resolveDispute = asyncHandler(async (req, res) => {
  const { expensePublicId } = req.params;
  const { disputePublicId, resolutionType, adminNote } = req.body;

  const expense = await expenseService.resolveDispute(
    expensePublicId,
    disputePublicId,
    resolutionType,
    {
      id: req.user._id || req.user.id,
      publicId: req.user.publicId,
      role: req.user.effectiveRole || req.user.role,
      name: req.user.fullName || 'مسؤول',
    },
    { adminNote }
  );

  return res.status(200).json({
    success: true,
    data: expense,
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/admin/users/:userPublicId/reset-password
// Admin resets a user's password to a new 6-digit PIN
// ---------------------------------------------------------------------------

const resetUserPassword = asyncHandler(async (req, res) => {
  const { userPublicId } = req.params;
  const { newPin } = req.body;

  const user = await userRepository.findByPublicId(userPublicId);
  if (!user) {
    return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
  }

  const newHash = await bcrypt.hash(newPin, 12);
  await userRepository.updateByPublicId(userPublicId, { passwordHash: newHash });

  await auditLogRepository.createLog({
    actorId:         req.user._id,
    actorPublicId:   req.user.publicId,
    actorRole:       req.user.role,
    actorName:       req.user.fullName,
    action:          AUDIT_ACTIONS.USER_CREATED || 'PASSWORD_RESET',
    entityType:      AUDIT_ENTITY_TYPES.USER,
    entityId:        user._id,
    entityPublicId:  user.publicId,
    metadata:        { action: 'admin_password_reset', targetUser: user.fullName },
  }).catch(() => {});

  return res.status(200).json({
    success: true,
    message: `تم إعادة تعيين كلمة مرور ${user.fullName} بنجاح`,
  });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createUserSchema,
  updateSettingsSchema,
  toggleStatusSchema,
  resetPasswordSchema,
  resolveDisputeSchema,
  validateBody,
  getDashboard,
  listUsers,
  getUserDetail,
  createUser,
  toggleUserStatus,
  resetUserPassword,
  getSettings,
  updateSettings,
  generateMonthlyReportPdf,
  generateDebtReportPdf,
  getDisputedExpenses,
  resolveDispute,
};
