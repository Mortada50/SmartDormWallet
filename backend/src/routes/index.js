/**
 * @file index.js
 * @description Central router — mounts all sub-routers under /api/v1.
 *
 * Registered routes:
 *   /api/v1/auth        → authRoutes
 *   /api/v1/wallet      → walletRoutes (user self-access)
 *   /api/v1/transactions → walletRoutes (single tx lookup)
 *   /api/v1/users       → walletRoutes (admin cross-user) + userRoutes
 *   /api/v1/admin       → walletRoutes (adjustments/integrity) + adminRoutes
 *   /api/v1/expenses    → expenseRoutes
 *   /api/v1/merchants   → merchantRoutes
 *
 * @module routes/index
 */

'use strict';

const router = require('express').Router();

const authRoutes     = require('./authRoutes');
const walletRoutes   = require('./walletRoutes');
const expenseRoutes  = require('./expenseRoutes');
const merchantRoutes = require('./merchantRoutes');
const depositRoutes  = require('./depositRoutes');
const adminRoutes    = require('./adminRoutes');
const notificationRoutes = require('./notificationRoutes');
const withdrawalRoutes = require('./withdrawalRoutes');

// API version prefix is already applied by app.js: app.use('/api/v1', router)
router.use('/auth',      authRoutes);
router.use('/',          walletRoutes);   // handles /wallet/*, /users/*, /admin/adjustments, etc.
router.use('/expenses',  expenseRoutes);
router.use('/merchants', merchantRoutes);
router.use('/deposits',  depositRoutes);
router.use('/withdrawals', withdrawalRoutes);
router.use('/notifications', notificationRoutes);
router.use('/admin',     adminRoutes);    // handles /admin/dashboard, /admin/users, /admin/settings, etc.

module.exports = router;
