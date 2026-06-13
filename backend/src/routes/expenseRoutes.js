/**
 * @file expenseRoutes.js
 * @description Express router for shared expense and dispute endpoints.
 *
 * BASE: /api/v1/expenses
 *
 * RBAC:
 *   POST   /                              → admin | deputy
 *   GET    /                              → admin | deputy
 *   GET    /my                            → user (own)
 *   GET    /disputes                      → admin | deputy
 *   GET    /:id                           → admin | deputy | user (if in expense)
 *   POST   /:id/disputes                  → user
 *   PATCH  /:id/disputes/:did/resolve     → admin | deputy
 *
 * @module routes/expenseRoutes
 */

'use strict';

const router = require('express').Router();

const {
  authenticate,
  requireAdminOrDeputy,
  requireAnyRole,
  requireUser,
  deputyGuard,
} = require('../middleware/authMiddleware');

const {
  createExpense,
  getAllExpenses,
  getMyExpenses,
  getOpenDisputes,
  getExpense,
  fileDispute,
  resolveDispute,
} = require('../controllers/expenseController');

// ── Create expense (admin / deputy) ──────────────────────────────────────────
router.post('/',
  authenticate,
  requireAdminOrDeputy,
  deputyGuard,
  createExpense
);

// ── Admin list ────────────────────────────────────────────────────────────────
router.get('/',
  authenticate,
  requireAdminOrDeputy,
  getAllExpenses
);

// ── User's own expense list (must come before /:id) ───────────────────────────
router.get('/my',
  authenticate,
  requireAnyRole,
  getMyExpenses
);

// ── Admin disputes panel ──────────────────────────────────────────────────────
router.get('/disputes',
  authenticate,
  requireAdminOrDeputy,
  getOpenDisputes
);

// ── Single expense (access-controlled inside controller) ──────────────────────
router.get('/:expensePublicId',
  authenticate,
  requireAnyRole,
  getExpense
);

// ── File dispute (user only) ──────────────────────────────────────────────────
router.post('/:expensePublicId/disputes',
  authenticate,
  requireAnyRole,
  fileDispute
);

// ── Resolve dispute (admin / deputy) ─────────────────────────────────────────
router.patch('/:expensePublicId/disputes/:disputePublicId/resolve',
  authenticate,
  requireAdminOrDeputy,
  deputyGuard,
  resolveDispute
);

module.exports = router;
