/**
 * @file expenseController.js
 * @description HTTP handlers for shared expense endpoints.
 *
 * ENDPOINTS:
 *   POST   /api/v1/expenses                             — create shared expense (admin/deputy)
 *   GET    /api/v1/expenses                             — list all expenses (admin/deputy)
 *   GET    /api/v1/expenses/my                          — user's own expense list
 *   GET    /api/v1/expenses/disputes                    — all open disputes (admin)
 *   GET    /api/v1/expenses/:expensePublicId            — get single expense
 *   POST   /api/v1/expenses/:expensePublicId/disputes   — file dispute (user)
 *   PATCH  /api/v1/expenses/:expensePublicId/disputes/:disputePublicId/resolve  — resolve (admin)
 *
 * VALIDATION: All write endpoints use Zod schema validation.
 *
 * @module controllers/expenseController
 */

'use strict';

const { z } = require('zod');
const expenseService = require('../services/expenseService');
const { asyncHandler, requireFields } = require('../middleware/errorMiddleware');
const { resolveUserId } = require('../middleware/authMiddleware');

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

/** Schema for creating a shared expense */
const createExpenseSchema = z.object({
  name: z.string().min(2, 'اسم المصروف يجب أن يكون حرفين على الأقل').max(200),
  totalAmount: z.number({
    required_error: 'المبلغ الإجمالي مطلوب',
    invalid_type_error: 'المبلغ يجب أن يكون رقماً',
  }).int('المبلغ يجب أن يكون عدداً صحيحاً (ريال يمني بدون كسور)').positive('المبلغ يجب أن يكون أكبر من صفر').max(100_000_000),
  userPublicIds: z.array(
    z.string().uuid('معرف المستخدم غير صحيح')
  ).min(1, 'يجب اختيار مستخدم واحد على الأقل').max(100, 'لا يمكن تجاوز 100 مستخدم'),
  description: z.string().max(500).optional(),
  receiptImagePublicId: z.string().optional().nullable(),
  expenseDate: z.string().refine(s => !isNaN(Date.parse(s)), {
    message: 'تاريخ المصروف غير صحيح',
  }).optional(),
});

/** Schema for filing a dispute */
const fileDisputeSchema = z.object({
  note: z.string()
    .min(10, 'سبب النزاع يجب أن يكون 10 حروف على الأقل')
    .max(1000, 'سبب النزاع لا يتجاوز 1000 حرف'),
});

/** Schema for resolving a dispute */
const resolveDisputeSchema = z.object({
  resolution: z.string()
    .min(5, 'قرار النزاع يجب أن يكون 5 حروف على الأقل')
    .max(1000),
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
// POST /api/v1/expenses
// ---------------------------------------------------------------------------

const createExpense = asyncHandler(async (req, res) => {
  const {
    name,
    totalAmount,
    userPublicIds,
    description,
    receiptImagePublicId,
    expenseDate,
  } = req.body;

  const performedById = await resolveUserId(req);

  const { expense, userResults } = await expenseService.createSharedExpense({
    name,
    totalAmount,
    userPublicIds,
    description: description || null,
    receiptImagePublicId: receiptImagePublicId || null,
    expenseDate: expenseDate ? new Date(expenseDate) : new Date(),
    performedBy: performedById,
    performedByPublicId: req.user.publicId,
    performedByRole: req.user.effectiveRole || req.user.role,
    performedByName: req.user.fullName || 'مسؤول',
  });

  return res.status(201).json({
    success: true,
    data: {
      expense,
      shares: userResults.map(({ user, shareAmount, tx }) => ({
        userPublicId: user.userPublicId,
        userName: user.userName,
        shareAmount,
        transactionPublicId: tx.publicId,
      })),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/expenses  (admin view — all expenses)
// ---------------------------------------------------------------------------

const getAllExpenses = asyncHandler(async (req, res) => {
  const { page, limit, dateFrom, dateTo, search } = req.query;

  const result = await expenseService.getAllExpenses({
    page: parseInt(page) || 1,
    limit: parseInt(limit) || 20,
    dateFrom: dateFrom ? new Date(dateFrom) : undefined,
    dateTo: dateTo ? new Date(dateTo) : undefined,
    search: search || undefined,
  });

  return res.status(200).json({ success: true, data: result });
});

// ---------------------------------------------------------------------------
// GET /api/v1/expenses/my  (user view — own expenses)
// ---------------------------------------------------------------------------

const getMyExpenses = asyncHandler(async (req, res) => {
  const { cursor, limit, dateFrom, dateTo } = req.query;
  const userId = await resolveUserId(req);

  const result = await expenseService.getUserExpenses(userId, {
    cursor: cursor || undefined,
    limit: parseInt(limit) || 20,
    dateFrom: dateFrom ? new Date(dateFrom) : undefined,
    dateTo: dateTo ? new Date(dateTo) : undefined,
  });

  return res.status(200).json({ success: true, data: result });
});

// ---------------------------------------------------------------------------
// GET /api/v1/expenses/disputes  (admin — open disputes panel)
// ---------------------------------------------------------------------------

const getOpenDisputes = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;

  const result = await expenseService.getOpenDisputes({
    page: parseInt(page) || 1,
    limit: parseInt(limit) || 20,
  });

  return res.status(200).json({ success: true, data: result });
});

// ---------------------------------------------------------------------------
// GET /api/v1/expenses/:expensePublicId
// ---------------------------------------------------------------------------

const getExpense = asyncHandler(async (req, res) => {
  const { expensePublicId } = req.params;

  const expense = await expenseService.getExpenseById(
    expensePublicId,
    req.user.publicId,
    req.user.effectiveRole || req.user.role
  );

  return res.status(200).json({ success: true, data: { expense } });
});

// ---------------------------------------------------------------------------
// POST /api/v1/expenses/:expensePublicId/disputes  (user)
// ---------------------------------------------------------------------------

const fileDispute = asyncHandler(async (req, res) => {
  const { expensePublicId } = req.params;
  // Support both 'note' and 'reason' field names for compatibility
  const note = req.body.note || req.body.reason;
  if (!note || !note.trim()) {
    return res.status(400).json({
      success: false,
      code: 'VALIDATION_ERROR',
      message: 'يجب تقديم سبب النزاع',
    });
  }
  if (note.trim().length < 10) {
    return res.status(400).json({
      success: false,
      code: 'VALIDATION_ERROR',
      message: 'سبب النزاع يجب أن يكون 10 حروف على الأقل',
    });
  }

  // Find admin user to notify
  const adminUser = await require('../models').User
    .findOne({ role: 'admin' })
    .select('_id publicId')
    .lean();

  const { disputePublicId, expense } = await expenseService.fileDispute(
    expensePublicId,
    req.user.publicId,
    note,
    {
      userName: req.user.fullName || 'مستخدم',
      adminUserId: adminUser?._id || null,
      adminPublicId: adminUser?.publicId || null,
    }
  );

  return res.status(201).json({
    success: true,
    data: {
      message: 'تم تقديم اعتراضك بنجاح — سيتم مراجعته من قِبل المسؤول',
      disputePublicId,
    },
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/expenses/:expensePublicId/disputes/:disputePublicId/resolve
// ---------------------------------------------------------------------------

const resolveDispute = asyncHandler(async (req, res) => {
  requireFields(req, ['resolution']);
  const { expensePublicId, disputePublicId } = req.params;
  const { resolution, refundAmount, adminNote } = req.body;

  if (!['dismiss', 'refund'].includes(resolution)) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_RESOLUTION',
      message: 'نوع القرار يجب أن يكون dismiss (رفض) أو refund (استرداد)',
    });
  }

  if (resolution === 'refund' && refundAmount !== undefined) {
    if (!Number.isInteger(refundAmount) || refundAmount <= 0) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_REFUND_AMOUNT',
        message: 'مبلغ الاسترداد يجب أن يكون عدداً صحيحاً موجباً',
      });
    }
  }

  const actorId = await resolveUserId(req);

  const result = await expenseService.resolveDispute(
    expensePublicId,
    disputePublicId,
    resolution,
    {
      id: actorId,
      publicId: req.user.publicId,
      role: req.user.effectiveRole || req.user.role,
      name: req.user.fullName || 'مسؤول',
    },
    {
      refundAmount: refundAmount !== undefined ? parseInt(refundAmount) : undefined,
      adminNote: adminNote || null,
    }
  );

  return res.status(200).json({
    success: true,
    data: {
      message: resolution === 'refund'
        ? 'تم قبول الاعتراض وإصدار الاسترداد بنجاح'
        : 'تم رفض الاعتراض',
      resolutionType: result.resolutionType,
      refundTxPublicId: result.refundTx?.publicId || null,
    },
  });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createExpenseSchema,
  fileDisputeSchema,
  resolveDisputeSchema,
  validateBody,
  createExpense,
  getAllExpenses,
  getMyExpenses,
  getOpenDisputes,
  getExpense,
  fileDispute,
  resolveDispute,
};
