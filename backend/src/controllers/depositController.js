/**
 * @file depositController.js
 * @description HTTP handlers for deposit request endpoints.
 *
 * ENDPOINTS:
 *   POST   /api/v1/deposits                             — submit deposit request (resident)
 *   GET    /api/v1/deposits/mine                        — get own requests (resident)
 *   GET    /api/v1/deposits/pending                     — list pending requests (admin/deputy)
 *   PATCH  /api/v1/deposits/:depositPublicId/approve    — approve deposit (admin/deputy)
 *   PATCH  /api/v1/deposits/:depositPublicId/reject     — reject deposit (admin/deputy)
 *   GET    /api/v1/deposits/:depositPublicId/receipt    — get signed receipt URL
 *
 * @module controllers/depositController
 */

'use strict';

const { z } = require('zod');
const depositService = require('../services/depositService');
const attachmentService = require('../services/attachmentService');
const userRepository = require('../repositories/userRepository');
const { DepositRequest } = require('../models');
const { asyncHandler } = require('../middleware/errorMiddleware');

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const submitDepositSchema = z.object({
  amount: z.coerce.number().int('المبلغ يجب أن يكون عدداً صحيحاً').positive('المبلغ يجب أن يكون أكبر من صفر').max(10_000_000),
  referenceNumber: z.string().max(100).optional(),
});

const approveDepositSchema = z.object({
  adminNote: z.string().max(500).optional(),
});

const rejectDepositSchema = z.object({
  reason: z.string().min(5, 'سبب الرفض يجب أن يكون 5 حروف على الأقل').max(500, 'سبب الرفض لا يتجاوز 500 حرف'),
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
// POST /api/v1/deposits
// ---------------------------------------------------------------------------

const submitDeposit = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      code: 'MISSING_FILE',
      message: 'يجب إرفاق صورة الإيصال البنكي',
    });
  }

  const { amount, referenceNumber } = req.body;
  const expiryHours = 72; // From settings conceptually, hardcoded fallback

  // Pass null as second arg to avoid SAFE_PROJECTION excluding _id
  const actor = await userRepository.findByPublicId(req.user.publicId, null);
  if (!actor) {
    return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
  }

  const result = await depositService.submitDepositRequest(
    { amount, referenceNumber, expiryHours },
    req.file,
    actor
  );

  return res.status(201).json({
    success: true,
    data: result,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/deposits/mine
// ---------------------------------------------------------------------------

const getMyDeposits = asyncHandler(async (req, res) => {
  const actor = await userRepository.findByPublicId(req.user.publicId, null);
  if (!actor) {
    return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
  }

  const result = await depositService.getMyRequests(actor._id, req.query);

  return res.status(200).json({
    success: true,
    data: result,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/deposits/pending (admin/deputy)
// ---------------------------------------------------------------------------

const getPendingDeposits = asyncHandler(async (req, res) => {
  const result = await depositService.getPendingRequests(req.query);

  return res.status(200).json({
    success: true,
    data: result,
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/deposits/:depositPublicId/approve (admin/deputy)
// ---------------------------------------------------------------------------

const approveDeposit = asyncHandler(async (req, res) => {
  const { depositPublicId } = req.params;
  const { adminNote } = req.body;

  const depositRequest = await depositService.approveDeposit(depositPublicId, req.user, adminNote);

  return res.status(200).json({
    success: true,
    data: depositRequest,
    message: 'تم اعتماد طلب الإيداع بنجاح',
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/deposits/:depositPublicId/reject (admin/deputy)
// ---------------------------------------------------------------------------

const rejectDeposit = asyncHandler(async (req, res) => {
  const { depositPublicId } = req.params;
  const { reason } = req.body;

  const depositRequest = await depositService.rejectDeposit(depositPublicId, req.user, reason);

  return res.status(200).json({
    success: true,
    data: depositRequest,
    message: 'تم رفض طلب الإيداع',
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/deposits/:depositPublicId/receipt
// ---------------------------------------------------------------------------

const getReceiptUrl = asyncHandler(async (req, res) => {
  const { depositPublicId } = req.params;

  const deposit = await DepositRequest.findOne({ publicId: depositPublicId }).lean();
  if (!deposit) {
    return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
  }

  // Check authorization: user themselves, or admin/deputy
  const isAdmin = req.user.role === 'admin' || req.user.role === 'deputy';
  const isOwner = req.user.publicId === deposit.userPublicId;

  if (!isAdmin && !isOwner) {
    return res.status(403).json({ success: false, message: 'غير مصرح لك بعرض هذا المرفق' });
  }

  if (!deposit.receiptImagePublicId) {
    return res.status(404).json({ success: false, message: 'لا يوجد مرفق لهذا الطلب' });
  }

  const signedUrl = await attachmentService.getSecureReceiptUrl(deposit.receiptImagePublicId);

  return res.status(200).json({
    success: true,
    data: {
      signedUrl,
      expiresInSeconds: 900,
    },
  });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  submitDepositSchema,
  approveDepositSchema,
  rejectDepositSchema,
  validateBody,
  submitDeposit,
  getMyDeposits,
  getPendingDeposits,
  approveDeposit,
  rejectDeposit,
  getReceiptUrl,
};
