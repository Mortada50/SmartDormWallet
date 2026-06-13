/**
 * @file authController.js
 * @description HTTP handlers for authentication endpoints.
 *
 * ENDPOINTS:
 *   POST /api/v1/auth/login          — login with phone + password (+ optional TOTP)
 *   POST /api/v1/auth/refresh        — rotate refresh token
 *   POST /api/v1/auth/logout         — blacklist refresh token
 *   GET  /api/v1/auth/me             — get current user profile
 *   POST /api/v1/auth/2fa/setup      — generate TOTP secret + QR URI (admin only)
 *   POST /api/v1/auth/2fa/verify     — activate 2FA after QR scan confirmation
 *   POST /api/v1/auth/2fa/disable    — disable 2FA (requires TOTP code)
 *
 * RESPONSE FORMAT (all endpoints):
 *   Success: { success: true, data: { ... } }
 *   Error:   { success: false, code: string, message: string }
 *
 * @module controllers/authController
 */

'use strict';

const authService = require('../services/authService');
const userRepository = require('../repositories/userRepository');
const { asyncHandler, requireFields } = require('../middleware/errorMiddleware');
const { resolveUserId } = require('../middleware/authMiddleware');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// POST /api/v1/auth/login
// ---------------------------------------------------------------------------

const login = asyncHandler(async (req, res) => {
  const { phone, password, totpCode } = req.body;

  if (!phone || !password) {
    return res.status(400).json({
      success: false,
      code: 'MISSING_FIELDS',
      message: 'رقم الهاتف وكلمة المرور مطلوبان',
    });
  }

  const result = await authService.login(
    { phone, password, totpCode },
    { ip: req.ip, userAgent: req.headers['user-agent'] }
  );

  // 2FA required — frontend shows TOTP input
  if (result.requiresTwoFactor) {
    return res.status(200).json({
      success: true,
      requiresTwoFactor: true,
      data: { user: result.user },
    });
  }

  // Set refresh token in httpOnly cookie for web clients
  res.cookie('refreshToken', result.refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/api/v1/auth/refresh',
  });

  return res.status(200).json({
    success: true,
    data: {
      accessToken: result.accessToken,
      // refreshToken also sent in body for mobile clients (no cookie support)
      refreshToken: result.refreshToken,
      user: result.user,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/refresh
// ---------------------------------------------------------------------------

const refresh = asyncHandler(async (req, res) => {
  // Accept from body (mobile) or httpOnly cookie (web)
  const refreshToken = req.body.refreshToken || req.cookies?.refreshToken;

  if (!refreshToken) {
    return res.status(400).json({
      success: false,
      code: 'MISSING_REFRESH_TOKEN',
      message: 'رمز التحديث مطلوب',
    });
  }

  const { accessToken, refreshToken: newRefreshToken } = await authService.rotateRefreshToken(refreshToken);

  // Update cookie
  res.cookie('refreshToken', newRefreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/api/v1/auth/refresh',
  });

  return res.status(200).json({
    success: true,
    data: { accessToken, refreshToken: newRefreshToken },
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/logout
// ---------------------------------------------------------------------------

const logout = asyncHandler(async (req, res) => {
  const refreshToken = req.body.refreshToken || req.cookies?.refreshToken;
  const userId = await resolveUserId(req);

  if (refreshToken) {
    await authService.logout(refreshToken, req.user.publicId, userId);
  }

  res.clearCookie('refreshToken', { path: '/api/v1/auth/refresh' });

  return res.status(200).json({
    success: true,
    data: { message: 'تم تسجيل الخروج بنجاح' },
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/auth/me
// ---------------------------------------------------------------------------

const me = asyncHandler(async (req, res) => {
  const user = await userRepository.findByPublicId(req.user.publicId);
  if (!user) {
    return res.status(404).json({
      success: false,
      code: 'USER_NOT_FOUND',
      message: 'المستخدم غير موجود',
    });
  }

  return res.status(200).json({
    success: true,
    data: {
      user: {
        ...user,
        isDeputy: req.user.isDeputy,
        deputyUntil: req.user.deputyUntil,
      },
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/2fa/setup
// ---------------------------------------------------------------------------

const setup2FA = asyncHandler(async (req, res) => {
  const user = await userRepository.findByPublicId(req.user.publicId);
  if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });

  if (user.twoFactorEnabled) {
    return res.status(409).json({
      success: false,
      code: 'TWO_FA_ALREADY_ENABLED',
      message: 'المصادقة الثنائية مفعّلة مسبقاً',
    });
  }

  const { secret, uri } = authService.generateTOTPSecret(req.user.publicId);

  // Store secret temporarily in session or return it for immediate verification
  // In production: encrypt with AES-256-GCM before storing (EncryptionService)
  // For now: return to frontend for QR scan, frontend confirms via /2fa/verify
  return res.status(200).json({
    success: true,
    data: {
      secret,  // Frontend must not display this raw — only use the URI
      qrUri: uri,
      message: 'امسح رمز QR بتطبيق المصادق، ثم أرسل الرمز المكون من 6 أرقام للتأكيد',
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/2fa/verify
// ---------------------------------------------------------------------------

const verify2FA = asyncHandler(async (req, res) => {
  requireFields(req, ['secret', 'totpCode']);
  const { secret, totpCode } = req.body;

  const isValid = authService.verifyTOTP(totpCode, secret);
  if (!isValid) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_TOTP',
      message: 'رمز التحقق غير صحيح — حاول مجدداً',
    });
  }

  // Activate 2FA — encrypt secret before storing (simplified here)
  await userRepository.updateByPublicId(req.user.publicId, {
    twoFactorEnabled: true,
    twoFactorSecret: secret, // Production: EncryptionService.encrypt(secret)
  });

  return res.status(200).json({
    success: true,
    data: { message: 'تم تفعيل المصادقة الثنائية بنجاح' },
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/2fa/disable
// ---------------------------------------------------------------------------

const disable2FA = asyncHandler(async (req, res) => {
  requireFields(req, ['totpCode']);
  const { totpCode } = req.body;

  // Fetch user with 2FA secret
  const userWithSecret = await require('../models').User
    .findOne({ publicId: req.user.publicId })
    .select('+twoFactorSecret twoFactorEnabled')
    .lean();

  if (!userWithSecret?.twoFactorEnabled) {
    return res.status(400).json({
      success: false,
      code: 'TWO_FA_NOT_ENABLED',
      message: 'المصادقة الثنائية غير مفعّلة',
    });
  }

  const isValid = authService.verifyTOTP(totpCode, userWithSecret.twoFactorSecret);
  if (!isValid) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_TOTP',
      message: 'رمز التحقق غير صحيح',
    });
  }

  await userRepository.updateByPublicId(req.user.publicId, {
    twoFactorEnabled: false,
    twoFactorSecret: null,
  });

  return res.status(200).json({
    success: true,
    data: { message: 'تم إيقاف المصادقة الثنائية' },
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/auth/me — Update own profile
// ---------------------------------------------------------------------------

const updateProfile = asyncHandler(async (req, res) => {
  const ALLOWED = ['fullName', 'phone', 'roomNumber'];
  const updates = {};
  for (const field of ALLOWED) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({
      success: false,
      code: 'NO_UPDATES',
      message: 'لم يتم تقديم أي بيانات للتحديث',
    });
  }

  // Validate fullName length
  if (updates.fullName !== undefined) {
    const name = updates.fullName.trim();
    if (name.length < 2 || name.length > 100) {
      return res.status(422).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'الاسم الكامل يجب أن يكون بين 2 و 100 حرف',
      });
    }
    updates.fullName = name;
  }

  const updated = await userRepository.updateByPublicId(req.user.publicId, updates);
  if (!updated) {
    return res.status(404).json({
      success: false,
      code: 'USER_NOT_FOUND',
      message: 'المستخدم غير موجود',
    });
  }

  logger.info('[authController] تم تحديث الملف الشخصي', { publicId: req.user.publicId });

  return res.status(200).json({
    success: true,
    data: { user: updated },
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/change-password
// ---------------------------------------------------------------------------

const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      success: false,
      code: 'MISSING_FIELDS',
      message: 'كلمة المرور الحالية والجديدة مطلوبتان',
    });
  }

  if (newPassword.length < 8) {
    return res.status(422).json({
      success: false,
      code: 'WEAK_PASSWORD',
      message: 'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل',
    });
  }

  if (currentPassword === newPassword) {
    return res.status(422).json({
      success: false,
      code: 'SAME_PASSWORD',
      message: 'كلمة المرور الجديدة يجب أن تكون مختلفة عن الحالية',
    });
  }

  await authService.changePassword(req.user.publicId, currentPassword, newPassword);

  logger.info('[authController] تم تغيير كلمة المرور', { publicId: req.user.publicId });

  return res.status(200).json({
    success: true,
    data: { message: 'تم تغيير كلمة المرور بنجاح' },
  });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { login, refresh, logout, me, setup2FA, verify2FA, disable2FA, updateProfile, changePassword };
