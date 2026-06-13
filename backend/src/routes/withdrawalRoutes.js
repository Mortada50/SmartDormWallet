/**
 * @file withdrawalRoutes.js
 * @description Express router for withdrawal endpoints.
 *
 * BASE: /api/v1/withdrawals
 *
 * @module routes/withdrawalRoutes
 */

'use strict';

const router = require('express').Router();

const { authenticate, requireAnyRole, requireUser, requireAdminOrDeputy } = require('../middleware/authMiddleware');
const { financialRateLimit } = require('../middleware/rateLimitMiddleware');
const { uploadSingle } = require('../middleware/uploadMiddleware');

const {
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
} = require('../controllers/withdrawalController');

// ── Resident Routes ────────────────────────────────────────────────────────
router.post(
  '/',
  financialRateLimit,
  authenticate,
  requireUser,
  validateBody(submitWithdrawalSchema),
  submitWithdrawal
);

router.get(
  '/mine',
  authenticate,
  requireUser,
  getMyWithdrawals
);

router.get(
  '/fee-preview',
  authenticate,
  requireAnyRole,
  getFeePreview
);

// ── Admin/Deputy Routes ────────────────────────────────────────────────────
router.get(
  '/pending',
  authenticate,
  requireAdminOrDeputy,
  getPendingWithdrawals
);

router.patch(
  '/:withdrawalPublicId/approve',
  authenticate,
  requireAdminOrDeputy,
  ...uploadSingle('receipt'),
  validateBody(approveWithdrawalSchema),
  approveWithdrawal
);

router.patch(
  '/:withdrawalPublicId/reject',
  authenticate,
  requireAdminOrDeputy,
  validateBody(rejectWithdrawalSchema),
  rejectWithdrawal
);

module.exports = router;
