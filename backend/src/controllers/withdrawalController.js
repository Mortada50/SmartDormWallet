/**
 * @file withdrawalController.js
 * @description HTTP handlers for withdrawal request endpoints.
 *
 * ENDPOINTS:
 *   POST   /api/v1/withdrawals              — submit withdrawal request (resident)
 *   GET    /api/v1/withdrawals/my           — get own requests (resident)
 *   GET    /api/v1/withdrawals/pending      — list pending requests (admin/deputy)
 *   PATCH  /api/v1/withdrawals/:id/approve  — approve withdrawal (admin/deputy)
 *   PATCH  /api/v1/withdrawals/:id/reject   — reject withdrawal (admin/deputy)
 *
 * @module controllers/withdrawalController
 */

'use strict';

const { z } = require('zod');
const withdrawalService  = require('../services/withdrawalService');
const userRepository     = require('../repositories/userRepository');
const ledgerService      = require('../services/ledgerService');
const { asyncHandler }   = require('../middleware/errorMiddleware');

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const submitWithdrawalSchema = z.object({
  amount: z
    .coerce
    .number()
    .int('المبلغ يجب أن يكون عدداً صحيحاً')
    .positive('المبلغ يجب أن يكون أكبر من صفر')
    .max(10_000_000, 'المبلغ يتجاوز الحد المسموح به'),
});

const rejectWithdrawalSchema = z.object({
  reason: z.string().trim().min(5, 'سبب الرفض يجب أن يكون 5 أحرف على الأقل').max(500),
});

const approveWithdrawalSchema = z.object({
  adminNote: z.string().trim().max(500).optional(),
});

// ---------------------------------------------------------------------------
// Helper — validation middleware
// ---------------------------------------------------------------------------

function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const msg = result.error.errors.map(e => e.message).join(', ');
      return res.status(400).json({ success: false, message: msg, errors: result.error.errors });
    }
    req.validatedBody = result.data;
    return next();
  };
}

// ---------------------------------------------------------------------------
// Helper — resolve authenticated user ObjectId from publicId
// ---------------------------------------------------------------------------

async function resolveActor(req) {
  const user = await userRepository.findByPublicId(req.user.publicId, null);
  if (!user) throw Object.assign(new Error('المستخدم غير موجود'), { statusCode: 404 });
  return user;
}

// ---------------------------------------------------------------------------
// POST /api/v1/withdrawals
// Resident submits a new withdrawal request
// ---------------------------------------------------------------------------

const submitWithdrawal = asyncHandler(async (req, res) => {
  const { amount } = req.validatedBody;
  const actor = await resolveActor(req);

  const result = await withdrawalService.submitWithdrawalRequest({ amount, actor });

  return res.status(201).json({
    success: true,
    message: 'تم إرسال طلب السحب — سيتم مراجعته من قبل المشرف',
    data: { withdrawal: result },
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/withdrawals/my
// Resident gets their own withdrawal history
// ---------------------------------------------------------------------------

const getMyWithdrawals = asyncHandler(async (req, res) => {
  const actor = await resolveActor(req);
  const { page, limit, status } = req.query;

  const result = await withdrawalService.getMyWithdrawals(actor._id, { page, limit, status });

  return res.status(200).json({ success: true, data: result });
});

// ---------------------------------------------------------------------------
// GET /api/v1/withdrawals/pending
// Admin/deputy lists pending withdrawal requests
// ---------------------------------------------------------------------------

const getPendingWithdrawals = asyncHandler(async (req, res) => {
  const { page, limit, status, dateFrom, dateTo } = req.query;

  const result = await withdrawalService.getPendingWithdrawals({ page, limit, status, dateFrom, dateTo });

  return res.status(200).json({ success: true, data: result });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/withdrawals/:withdrawalPublicId/approve
// Admin/deputy approves a pending withdrawal
// ---------------------------------------------------------------------------

const approveWithdrawal = asyncHandler(async (req, res) => {
  const { withdrawalPublicId } = req.params;
  const { adminNote } = req.validatedBody ?? {};
  const file = req.file; // From uploadSingle middleware
  const actor = await resolveActor(req);

  const result = await withdrawalService.approveWithdrawal(withdrawalPublicId, actor, adminNote, file);

  return res.status(200).json({
    success: true,
    message: 'تمت الموافقة على طلب السحب وتم خصم المبلغ من محفظة المستخدم',
    data: { withdrawal: result },
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/withdrawals/:withdrawalPublicId/reject
// Admin/deputy rejects a pending withdrawal
// ---------------------------------------------------------------------------

const rejectWithdrawal = asyncHandler(async (req, res) => {
  const { withdrawalPublicId } = req.params;
  const { reason } = req.validatedBody;
  const actor = await resolveActor(req);

  const result = await withdrawalService.rejectWithdrawal(withdrawalPublicId, reason, actor);

  return res.status(200).json({
    success: true,
    message: 'تم رفض طلب السحب',
    data: { withdrawal: result },
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/withdrawals/fee-preview
// Returns fee calculation for a given amount (resident can check before submitting)
// ---------------------------------------------------------------------------

const getFeePreview = asyncHandler(async (req, res) => {
  const actor = await resolveActor(req);

  const rawAmount = parseInt(req.query.amount, 10);
  if (!rawAmount || rawAmount <= 0) {
    return res.status(400).json({ success: false, message: 'المبلغ غير صحيح' });
  }

  const { Setting } = require('../models');
  const settings = await Setting.findOne().lean();
  if (!settings) return res.status(500).json({ success: false, message: 'إعدادات النظام غير موجودة' });

  const balanceResult = await ledgerService.calculateBalance(actor._id, actor.publicId);
  const details = ledgerService.computeWithdrawalDetails({
    withdrawalAmount: rawAmount,
    currentBalance:   balanceResult.balance,
    feeType:          settings.withdrawalFeeType,
    feeValue:         settings.withdrawalFeeValue,
  });

  return res.status(200).json({
    success: true,
    data: {
      amount:         rawAmount,
      feeType:        settings.withdrawalFeeType,
      feeValue:       settings.withdrawalFeeValue,
      feeAmount:      details.feeAmount,
      netAmount:      details.netAmount,
      totalRequired:  details.totalRequired,
      isSufficient:   details.isSufficient,
      currentBalance: balanceResult.balance,
      minAmount:      settings.minWithdrawalAmount,
      maxAmount:      settings.maxWithdrawalAmount,
    },
  });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  submitWithdrawalSchema,
  rejectWithdrawalSchema,
  approveWithdrawalSchema,
  validateBody,
  submitWithdrawal,
  getMyWithdrawals,
  getPendingWithdrawals,
  approveWithdrawal,
  rejectWithdrawal,
  getFeePreview,
};
