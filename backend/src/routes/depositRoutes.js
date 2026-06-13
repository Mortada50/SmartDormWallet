/**
 * @file depositRoutes.js
 * @description Express router for deposit requests endpoints.
 *
 * BASE: /api/v1/deposits
 *
 * @module routes/depositRoutes
 */

'use strict';

const router = require('express').Router();

const {
  authenticate,
  requireAdminOrDeputy,
  requireUser,
  requireAnyRole,
} = require('../middleware/authMiddleware');

const { financialRateLimit } = require('../middleware/rateLimitMiddleware');
const { uploadSingle } = require('../middleware/uploadMiddleware');

const {
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
} = require('../controllers/depositController');

// ── User Endpoints ────────────────────────────────────────────────────────
// Use uploadSingle('receipt') which returns an array of middlewares
router.post('/',
  ...uploadSingle('receipt'),
  financialRateLimit,
  authenticate,
  requireUser,
  validateBody(submitDepositSchema),
  submitDeposit
);

router.get('/mine',
  authenticate,
  requireUser,
  getMyDeposits
);

router.get('/:depositPublicId/receipt',
  authenticate,
  requireAnyRole,
  getReceiptUrl
);

// ── Admin/Deputy Endpoints ───────────────────────────────────────────────
router.get('/pending',
  authenticate,
  requireAdminOrDeputy,
  getPendingDeposits
);

router.patch('/:depositPublicId/approve',
  authenticate,
  requireAdminOrDeputy,
  validateBody(approveDepositSchema),
  approveDeposit
);

router.patch('/:depositPublicId/reject',
  authenticate,
  requireAdminOrDeputy,
  validateBody(rejectDepositSchema),
  rejectDeposit
);

module.exports = router;
