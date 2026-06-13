/**
 * @file merchantController.js
 * @description HTTP handlers for merchant management and merchant transaction endpoints.
 *
 * ENDPOINTS:
 *   POST   /api/v1/merchants                            — create merchant (admin)
 *   GET    /api/v1/merchants                            — list merchants (admin)
 *   GET    /api/v1/merchants/active                     — active merchant list (dropdown)
 *   GET    /api/v1/merchants/:merchantPublicId          — get single merchant + balance
 *   PATCH  /api/v1/merchants/:merchantPublicId          — update merchant (admin)
 *   PATCH  /api/v1/merchants/:merchantPublicId/disable  — disable merchant (admin)
 *   POST   /api/v1/merchants/:merchantPublicId/purchase — record purchase (admin/deputy)
 *   POST   /api/v1/merchants/:merchantPublicId/settle   — record settlement (admin)
 *   GET    /api/v1/merchants/:merchantPublicId/transactions — merchant ledger
 *
 * @module controllers/merchantController
 */

'use strict';

const merchantService = require('../services/merchantService');
const { asyncHandler, requireFields } = require('../middleware/errorMiddleware');
const { resolveUserId } = require('../middleware/authMiddleware');

// ---------------------------------------------------------------------------
// POST /api/v1/merchants
// ---------------------------------------------------------------------------

const createMerchant = asyncHandler(async (req, res) => {
  requireFields(req, ['name']);
  const { name, phone, notes } = req.body;

  const actorId = await resolveUserId(req);

  const merchant = await merchantService.createMerchant(
    {
      name: name.trim(),
      phone: phone?.trim() || null,
      notes: notes?.trim() || null,
    },
    {
      id: actorId,
      publicId: req.user.publicId,
      role: req.user.effectiveRole || req.user.role,
      name: req.user.fullName || 'مسؤول',
    }
  );

  return res.status(201).json({
    success: true,
    data: { merchant },
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/merchants  (admin list)
// ---------------------------------------------------------------------------

const getMerchants = asyncHandler(async (req, res) => {
  const { page, limit, status, search } = req.query;

  const result = await merchantService.getMerchants({
    page: parseInt(page) || 1,
    limit: parseInt(limit) || 20,
    status: status || undefined,
    search: search || undefined,
  });

  return res.status(200).json({ success: true, data: result });
});

// ---------------------------------------------------------------------------
// GET /api/v1/merchants/active  (dropdown list — minimal fields)
// ---------------------------------------------------------------------------

const getActiveMerchants = asyncHandler(async (req, res) => {
  const { MerchantTransaction } = require('../models');
  const merchants = await require('../repositories/merchantRepository').findActiveList();

  return res.status(200).json({
    success: true,
    data: { merchants },
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/merchants/:merchantPublicId
// ---------------------------------------------------------------------------

const getMerchant = asyncHandler(async (req, res) => {
  const { merchantPublicId } = req.params;
  const merchant = await merchantService.getMerchantById(merchantPublicId);
  const balanceInfo = await merchantService.getMerchantBalance(merchantPublicId);

  return res.status(200).json({
    success: true,
    data: {
      merchant: {
        ...merchant,
        outstandingBalance: balanceInfo.outstandingBalance,
        totalPurchases: balanceInfo.totalPurchases,
        totalSettlements: balanceInfo.totalSettlements,
      },
    },
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/merchants/:merchantPublicId
// ---------------------------------------------------------------------------

const updateMerchant = asyncHandler(async (req, res) => {
  const { merchantPublicId } = req.params;
  const { name, phone, notes } = req.body;

  const existing = await merchantService.getMerchantById(merchantPublicId);

  const updated = await require('../repositories/merchantRepository').updateByPublicId(
    merchantPublicId,
    {
      name: name !== undefined ? name.trim() : existing.name,
      phone: phone !== undefined ? phone?.trim() || null : existing.phone,
      notes: notes !== undefined ? notes?.trim() || null : existing.notes,
    }
  );

  return res.status(200).json({
    success: true,
    data: { merchant: updated },
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/merchants/:merchantPublicId/disable
// ---------------------------------------------------------------------------

const disableMerchant = asyncHandler(async (req, res) => {
  const { merchantPublicId } = req.params;
  const actorId = await resolveUserId(req);

  await merchantService.disableMerchant(merchantPublicId, {
    id: actorId,
    publicId: req.user.publicId,
    role: req.user.effectiveRole || req.user.role,
    name: req.user.fullName || 'مسؤول',
  });

  return res.status(200).json({
    success: true,
    data: { message: 'تم تعطيل التاجر بنجاح' },
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/merchants/:merchantPublicId/purchase
// ---------------------------------------------------------------------------

const recordPurchase = asyncHandler(async (req, res) => {
  requireFields(req, ['totalAmount', 'userPublicIds']);

  const { merchantPublicId } = req.params;
  const {
    totalAmount,
    userPublicIds,
    description,
    invoiceReference,
    receiptImagePublicId,
  } = req.body;

  if (!Number.isInteger(totalAmount) || totalAmount <= 0) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_AMOUNT',
      message: 'مبلغ الشراء يجب أن يكون عدداً صحيحاً موجباً',
    });
  }

  if (!Array.isArray(userPublicIds) || userPublicIds.length === 0) {
    return res.status(400).json({
      success: false,
      code: 'MISSING_USERS',
      message: 'يجب اختيار مستخدم واحد على الأقل',
    });
  }

  const actorId = await resolveUserId(req);

  const { merchantTransaction, userResults } = await merchantService.recordPurchase({
    merchantPublicId,
    totalAmount,
    userPublicIds,
    description: description?.trim() || null,
    invoiceReference: invoiceReference?.trim() || null,
    receiptImagePublicId: receiptImagePublicId || null,
    performedBy: actorId,
    performedByPublicId: req.user.publicId,
    performedByRole: req.user.effectiveRole || req.user.role,
    performedByName: req.user.fullName || 'مسؤول',
  });

  return res.status(201).json({
    success: true,
    data: {
      merchantTransaction: merchantTransaction,
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
// POST /api/v1/merchants/:merchantPublicId/settle
// ---------------------------------------------------------------------------

const recordSettlement = asyncHandler(async (req, res) => {
  requireFields(req, ['amount']);

  const { merchantPublicId } = req.params;
  const { amount, settlementNotes, receiptImagePublicId } = req.body;

  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_AMOUNT',
      message: 'مبلغ التسوية يجب أن يكون عدداً صحيحاً موجباً',
    });
  }

  const actorId = await resolveUserId(req);

  const { merchantTransaction } = await merchantService.recordSettlement({
    merchantPublicId,
    amount,
    settlementNotes: settlementNotes?.trim() || null,
    receiptImagePublicId: receiptImagePublicId || null,
    performedBy: actorId,
    performedByPublicId: req.user.publicId,
    performedByRole: req.user.effectiveRole || req.user.role,
    performedByName: req.user.fullName || 'مسؤول',
  });

  return res.status(201).json({
    success: true,
    data: {
      merchantTransaction: merchantTransaction,
      message: 'تم تسجيل التسوية بنجاح',
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/merchants/:merchantPublicId/transactions
// ---------------------------------------------------------------------------

const getMerchantTransactions = asyncHandler(async (req, res) => {
  const { merchantPublicId } = req.params;
  const { cursor, limit, type } = req.query;

  // Verify merchant exists
  await merchantService.getMerchantById(merchantPublicId);

  const merchant = await require('../repositories/merchantRepository')
    .findByPublicId(merchantPublicId);

  const result = await require('../repositories/merchantTransactionRepository')
    .findPaginatedForMerchant(merchant._id || merchant.id, {
      cursor: cursor || undefined,
      limit: parseInt(limit) || 20,
      type: type || undefined,
    });

  return res.status(200).json({ success: true, data: result });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createMerchant,
  getMerchants,
  getActiveMerchants,
  getMerchant,
  updateMerchant,
  disableMerchant,
  recordPurchase,
  recordSettlement,
  getMerchantTransactions,
};
