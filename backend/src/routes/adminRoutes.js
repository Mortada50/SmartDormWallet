/**
 * @file adminRoutes.js
 * @description Express router for admin-only endpoints.
 *
 * BASE: /api/v1/admin
 * Note: Some admin routes related to wallet are in walletRoutes.js under /admin prefix.
 *
 * @module routes/adminRoutes
 */

'use strict';

const router = require('express').Router();

const {
  authenticate,
  requireAdmin,
  requireAdminOrDeputy,
} = require('../middleware/authMiddleware');

const {
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
} = require('../controllers/adminController');

// ── Dashboard & Reports ─────────────────────────────────────────────────
router.get('/dashboard', authenticate, requireAdmin, getDashboard);
router.get('/reports/monthly', authenticate, requireAdmin, generateMonthlyReportPdf);
router.get('/reports/debt', authenticate, requireAdmin, generateDebtReportPdf);

// ── User Management ─────────────────────────────────────────────────────
router.get('/users', authenticate, requireAdmin, listUsers);
router.post('/users', authenticate, requireAdmin, validateBody(createUserSchema), createUser);
router.get('/users/:userPublicId', authenticate, requireAdmin, getUserDetail);
router.patch('/users/:userPublicId/status', authenticate, requireAdmin, validateBody(toggleStatusSchema), toggleUserStatus);
router.patch('/users/:userPublicId/reset-password', authenticate, requireAdmin, validateBody(resetPasswordSchema), resetUserPassword);

// ── System Settings ─────────────────────────────────────────────────────
router.get('/settings', authenticate, requireAdmin, getSettings);
router.patch('/settings', authenticate, requireAdmin, validateBody(updateSettingsSchema), updateSettings);

// ── Disputes (Admin/Deputy) ─────────────────────────────────────────────
router.get('/disputes', authenticate, requireAdminOrDeputy, getDisputedExpenses);
router.patch('/disputes/:expensePublicId/resolve', authenticate, requireAdminOrDeputy, validateBody(resolveDisputeSchema), resolveDispute);

module.exports = router;
