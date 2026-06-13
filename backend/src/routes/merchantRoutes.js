/**
 * @file merchantRoutes.js
 * @description Express router for merchant management and transaction endpoints.
 *
 * BASE: /api/v1/merchants
 *
 * RBAC:
 *   POST  /                              → admin
 *   GET   /                              → admin | deputy
 *   GET   /active                        → admin | deputy | user
 *   GET   /:id                           → admin | deputy
 *   PATCH /:id                           → admin
 *   PATCH /:id/disable                   → admin
 *   POST  /:id/purchase                  → admin | deputy
 *   POST  /:id/settle                    → admin
 *   GET   /:id/transactions              → admin | deputy
 *
 * @module routes/merchantRoutes
 */

'use strict';

const router = require('express').Router();

const {
  authenticate,
  requireAdmin,
  requireAdminOrDeputy,
  requireAnyRole,
  deputyGuard,
} = require('../middleware/authMiddleware');

const {
  createMerchant,
  getMerchants,
  getActiveMerchants,
  getMerchant,
  updateMerchant,
  disableMerchant,
  recordPurchase,
  recordSettlement,
  getMerchantTransactions,
} = require('../controllers/merchantController');

// ── Create merchant ───────────────────────────────────────────────────────────
router.post('/',
  authenticate,
  requireAdmin,
  createMerchant
);

// ── List merchants (admin) ────────────────────────────────────────────────────
router.get('/',
  authenticate,
  requireAdminOrDeputy,
  getMerchants
);

// ── Active merchants dropdown (all authenticated users can use) ───────────────
router.get('/active',
  authenticate,
  requireAnyRole,
  getActiveMerchants
);

// ── Single merchant ───────────────────────────────────────────────────────────
router.get('/:merchantPublicId',
  authenticate,
  requireAdminOrDeputy,
  getMerchant
);

// ── Update merchant info ──────────────────────────────────────────────────────
router.patch('/:merchantPublicId',
  authenticate,
  requireAdmin,
  updateMerchant
);

// ── Disable merchant ──────────────────────────────────────────────────────────
router.patch('/:merchantPublicId/disable',
  authenticate,
  requireAdmin,
  disableMerchant
);

// ── Record purchase (admin / deputy) ─────────────────────────────────────────
router.post('/:merchantPublicId/purchase',
  authenticate,
  requireAdminOrDeputy,
  deputyGuard,
  recordPurchase
);

// ── Record settlement (admin only) ───────────────────────────────────────────
router.post('/:merchantPublicId/settle',
  authenticate,
  requireAdmin,
  recordSettlement
);

// ── Merchant transaction history ──────────────────────────────────────────────
router.get('/:merchantPublicId/transactions',
  authenticate,
  requireAdminOrDeputy,
  getMerchantTransactions
);

module.exports = router;
