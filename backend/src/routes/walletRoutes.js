/**
 * @file walletRoutes.js
 * @description Express router for wallet/ledger endpoints.
 *
 * BASE: /api/v1/wallet  (user self-access)
 *       /api/v1/users/:userPublicId  (admin cross-user access)
 *       /api/v1/admin  (admin-only operations)
 *
 * @module routes/walletRoutes
 */

'use strict';

const router = require('express').Router();

const {
  authenticate,
  requireAdmin,
  requireAdminOrDeputy,
  requireAnyRole,
} = require('../middleware/authMiddleware');

const {
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
} = require('../controllers/walletController');

// ── User self-access wallet endpoints ─────────────────────────────────────────
router.get('/wallet/balance',         authenticate, requireAnyRole, getMyBalance);
router.get('/wallet/transactions',    authenticate, requireAnyRole, getMyTransactions);
router.get('/wallet/debt',            authenticate, requireAnyRole, getMyDebt);
router.get('/wallet/statement',       authenticate, requireAnyRole, getMyStatement);

// Single transaction (access-controlled in controller)
router.get('/transactions/:txPublicId', authenticate, requireAnyRole, getTransaction);

// ── Admin cross-user wallet endpoints ─────────────────────────────────────────
router.get('/users/:userPublicId/balance',      authenticate, requireAdminOrDeputy, getUserBalance);
router.get('/users/:userPublicId/transactions', authenticate, requireAdminOrDeputy, getUserTransactions);
router.get('/users/:userPublicId/statement',    authenticate, requireAdminOrDeputy, getUserStatement);

// ── Admin-only financial operations ──────────────────────────────────────────
router.post('/admin/adjustments',                        authenticate, requireAdmin, createAdjustment);
router.get('/admin/ledger/integrity/:userPublicId',      authenticate, requireAdmin, checkIntegrity);

module.exports = router;
