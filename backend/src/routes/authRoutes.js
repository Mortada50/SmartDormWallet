/**
 * @file authRoutes.js
 * @description Express router for authentication endpoints.
 *
 * BASE: /api/v1/auth
 *
 * PUBLIC (no token required):
 *   POST /login
 *   POST /refresh
 *
 * PROTECTED:
 *   POST /logout              → any authenticated user
 *   GET  /me                  → any authenticated user
 *   POST /2fa/setup           → any authenticated user
 *   POST /2fa/verify          → any authenticated user
 *   POST /2fa/disable         → any authenticated user
 *
 * @module routes/authRoutes
 */

'use strict';

const router = require('express').Router();

const { authenticate, requireAnyRole } = require('../middleware/authMiddleware');
const { loginRateLimit } = require('../middleware/rateLimitMiddleware');
const {
  login,
  refresh,
  logout,
  me,
  setup2FA,
  verify2FA,
  disable2FA,
  updateProfile,
  changePassword,
} = require('../controllers/authController');

// Public
router.post('/login', loginRateLimit, login);
router.post('/refresh', refresh);

// Protected
router.post('/logout', authenticate, requireAnyRole, logout);
router.get('/me', authenticate, requireAnyRole, me);
router.patch('/me', authenticate, requireAnyRole, updateProfile);
router.post('/change-password', authenticate, requireAnyRole, changePassword);
router.post('/2fa/setup', authenticate, requireAnyRole, setup2FA);
router.post('/2fa/verify', authenticate, requireAnyRole, verify2FA);
router.post('/2fa/disable', authenticate, requireAnyRole, disable2FA);

module.exports = router;
