/**
 * @file authMiddleware.js
 * @description Express middleware for JWT verification, RBAC, and deputy session management.
 *
 * MIDDLEWARE CHAIN:
 *   authenticate        → verifies access token, attaches req.user
 *   requireRole(roles)  → RBAC guard, checks req.user.role
 *   requireAdmin        → shorthand for requireRole(['admin','deputy'])
 *   requireUserSelf     → ensures user can only access their own resources
 *   deputyGuard         → validates deputy session hasn't expired
 *   optionalAuth        → soft authentication (doesn't reject unauthenticated)
 *
 * req.user SHAPE (after authenticate):
 *   {
 *     publicId: string,       — from JWT sub
 *     role: 'admin'|'user',   — from JWT role
 *     family: string,         — token family (for revocation)
 *     jti: string,            — unique token ID
 *     isDeputy: boolean,      — true when role=admin and deputy session active
 *     deputyUntil: Date|null, — deputy session expiry
 *     _userId: ObjectId       — lazily fetched on first use
 *   }
 *
 * DEPUTY LOGIC (spec §3):
 *   - A user with role='user' can be an active deputy.
 *   - Deputy sessions are time-limited and stored in DeputyAssignment collection.
 *   - Deputies can ONLY approve/reject deposits and withdrawals.
 *   - All deputy actions are logged with actorRole='deputy' in audit log.
 *
 * @module middleware/authMiddleware
 */

'use strict';

const mongoose = require('mongoose');
const authService = require('../services/authService');
const userRepository = require('../repositories/userRepository');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Token extraction helper
// ---------------------------------------------------------------------------

/**
 * Extracts Bearer token from Authorization header.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function extractBearerToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
}

// ---------------------------------------------------------------------------
// authenticate — primary JWT verification middleware
// ---------------------------------------------------------------------------

/**
 * Verifies the JWT access token and attaches req.user.
 * Rejects with 401 if token is missing, invalid, or expired.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function authenticate(req, res, next) {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      return res.status(401).json({
        success: false,
        code: 'TOKEN_MISSING',
        message: 'رمز المصادقة مطلوب — أرسل Authorization: Bearer <token>',
      });
    }

    // Verify signature and expiry
    const decoded = await authService.verifyAccessToken(token);

    // Check deputy status from DB (lightweight query with lean)
    let isDeputy = false;
    let deputyUntil = null;

    if (decoded.role === 'admin' || decoded.isDeputy) {
      // Check active deputy assignment
      const { DeputyAssignment } = require('../models');
      const assignment = await DeputyAssignment
        .findOne({
          userPublicId: decoded.sub,
          isActive: true,
          expiresAt: { $gt: new Date() },
        })
        .select('expiresAt')
        .lean();

      if (assignment) {
        isDeputy = true;
        deputyUntil = assignment.expiresAt;
      }
    }

    req.user = {
      publicId: decoded.sub,
      role: decoded.role,
      family: decoded.family,
      jti: decoded.jti,
      isDeputy,
      deputyUntil,
      _userId: null, // Lazy-loaded on first use
    };

    next();
  } catch (err) {
    if (err.name === 'AuthError') {
      return res.status(err.statusCode || 401).json({
        success: false,
        code: err.code || 'AUTH_ERROR',
        message: err.message,
      });
    }
    logger.error('[authMiddleware] خطأ غير متوقع في المصادقة', { error: err.message });
    return res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      message: 'خطأ داخلي في التحقق من الهوية',
    });
  }
}

// ---------------------------------------------------------------------------
// optionalAuth — soft authentication (doesn't reject)
// ---------------------------------------------------------------------------

/**
 * Like authenticate but does NOT reject unauthenticated requests.
 * If token is present and valid: attaches req.user.
 * If token is missing or invalid: sets req.user = null and calls next().
 */
async function optionalAuth(req, res, next) {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      req.user = null;
      return next();
    }
    const decoded = await authService.verifyAccessToken(token);
    req.user = {
      publicId: decoded.sub,
      role: decoded.role,
      family: decoded.family,
      jti: decoded.jti,
      isDeputy: false,
      deputyUntil: null,
      _userId: null,
    };
  } catch {
    req.user = null;
  }
  next();
}

// ---------------------------------------------------------------------------
// requireRole — RBAC guard
// ---------------------------------------------------------------------------

/**
 * Returns middleware that restricts access to users with the specified role(s).
 *
 * DEPUTY HANDLING:
 *   - Deputy users have role='resident' in the token but isDeputy=true.
 *   - Use requireRole(['admin', 'deputy']) to allow both admin and deputy.
 *   - Use requireRole(['admin']) to block deputy access (settings, user management).
 *
 * @param {('admin'|'resident'|'deputy')[]} roles - Allowed roles.
 * @returns {import('express').RequestHandler}
 */
function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        code: 'UNAUTHENTICATED',
        message: 'يجب تسجيل الدخول أولاً',
      });
    }

    const effectiveRole = req.user.isDeputy ? 'deputy' : req.user.role;

    if (!roles.includes(effectiveRole)) {
      return res.status(403).json({
        success: false,
        code: 'INSUFFICIENT_PERMISSIONS',
        message: `هذا الإجراء يتطلب صلاحية: ${roles.join(' أو ')}`,
      });
    }

    // Attach effective role to req.user for downstream use
    req.user.effectiveRole = effectiveRole;
    next();
  };
}

// Convenience shorthands
const requireAdmin = requireRole(['admin']);
const requireAdminOrDeputy = requireRole(['admin', 'deputy']);
const requireUser = requireRole(['resident']);
const requireAnyRole = requireRole(['admin', 'deputy', 'resident']);

// ---------------------------------------------------------------------------
// requireUserSelf — ownership guard
// ---------------------------------------------------------------------------

/**
 * Ensures the authenticated user is accessing their own resource.
 * Admins and deputies bypass this check.
 *
 * Usage: GET /api/v1/users/:userPublicId/balance
 *   → User can only access their own balance.
 *   → Admin can access anyone's balance.
 *
 * Reads the target publicId from req.params[paramName] (default: 'userPublicId').
 *
 * @param {string} [paramName='userPublicId']
 * @returns {import('express').RequestHandler}
 */
function requireUserSelf(paramName = 'userPublicId') {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'غير مصادق' });
    }

    // Admins and deputies can access any user's data
    if (['admin', 'deputy'].includes(req.user.effectiveRole || req.user.role)) {
      return next();
    }

    const targetPublicId = req.params[paramName];
    if (req.user.publicId !== targetPublicId) {
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN',
        message: 'يمكنك فقط الوصول إلى بياناتك الخاصة',
      });
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// deputyGuard — deputy-specific permission check
// ---------------------------------------------------------------------------

/**
 * Validates that the deputy has not exceeded their time window.
 * Must be used AFTER authenticate.
 *
 * Also enforces deputy operation whitelist:
 *   - APPROVE_DEPOSIT, REJECT_DEPOSIT
 *   - APPROVE_WITHDRAWAL, REJECT_WITHDRAWAL
 *
 * For routes that deputies can NOT access (settings, user management),
 * use requireAdmin (which excludes deputy role) instead.
 */
function deputyGuard(req, res, next) {
  if (!req.user || !req.user.isDeputy) return next();

  // Check deputy session hasn't expired
  if (req.user.deputyUntil && req.user.deputyUntil < new Date()) {
    return res.status(403).json({
      success: false,
      code: 'DEPUTY_SESSION_EXPIRED',
      message: 'انتهت صلاحية جلسة النيابة — تواصل مع المسؤول',
    });
  }

  next();
}

// ---------------------------------------------------------------------------
// Lazy userId loader helper (for services that need ObjectId)
// ---------------------------------------------------------------------------

/**
 * Resolves req.user._userId (ObjectId) from the publicId.
 * Result is cached on req.user._userId to avoid repeated DB queries.
 *
 * @param {import('express').Request} req
 * @returns {Promise<mongoose.Types.ObjectId>}
 */
async function resolveUserId(req) {
  if (req.user._userId) return req.user._userId;

  const user = await require('../models').User
    .findOne({ publicId: req.user.publicId })
    .select('_id')
    .lean();

  if (!user) throw new Error('المستخدم غير موجود');
  req.user._userId = user._id;
  return user._id;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  authenticate,
  optionalAuth,
  requireRole,
  requireAdmin,
  requireAdminOrDeputy,
  requireUser,
  requireAnyRole,
  requireUserSelf,
  deputyGuard,
  resolveUserId,
};
