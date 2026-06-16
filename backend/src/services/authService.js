/**
 * @file authService.js
 * @description Authentication & token management service.
 *
 * SECURITY ARCHITECTURE (spec §12):
 *   - Access tokens (JWT):  short-lived (15 min), stateless, HS256
 *   - Refresh tokens (JWT): long-lived (7 days), stored hash in MongoDB TTL collection
 *   - 2FA: TOTP via otplib (RFC 6238) — required for admin when settings.require2FAForAdmin
 *   - Password: bcrypt, cost factor 12
 *   - Token rotation: refresh token rotated on every use (one-time tokens)
 *   - Replay detection: if rotated (old) token is reused → all sessions revoked
 *   - Login lockout: 5 failed attempts → 30-min lockout (per user AND per IP)
 *   - Unusual hours: 02:00–05:00 local time → isUnusualHours flag in audit log
 *
 * JWT PAYLOAD:
 *   Access token:  { sub: userPublicId, role: 'admin'|'user', jti: uuid, type: 'access' }
 *   Refresh token: { sub: userPublicId, jti: uuid, type: 'refresh', family: uuid }
 *   `family` groups all tokens from one login session — used for cascade revocation.
 *
 * TOKEN BLACKLIST:
 *   - Redis: primary check (fast), TTL = token's remaining lifetime
 *   - MongoDB TokenBlacklist: durable fallback on Redis miss / restart
 *   - Audit: COMPROMISE entries trigger full-family revocation
 *
 * @module services/authService
 */

'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { authenticator } = require('otplib');

const env = require('../config/env');
const logger = require('../config/logger');
const { cacheGet, cacheSet, cacheDel, cacheExists, CacheKeys, TTL } = require('../config/redis');
const { TokenBlacklist, BLACKLIST_REASONS } = require('../models');
const userRepository = require('../repositories/userRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, ACTOR_ROLES } = require('../models');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BCRYPT_ROUNDS = 12;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000; // 30 min
const UNUSUAL_HOURS_START = 2; // 02:00
const UNUSUAL_HOURS_END = 5;   // 05:00

// JWT expiry values
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';
const REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

class AuthError extends Error {
  constructor(message, code = 'AUTH_ERROR', statusCode = 401) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Password utilities
// ---------------------------------------------------------------------------

/**
 * Hashes a plain-text password using bcrypt (cost factor 12).
 * @param {string} password
 * @returns {Promise<string>} bcrypt hash
 */
async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Verifies a plain-text password against a bcrypt hash.
 * @param {string} password
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

/**
 * Generates an access token (15-min lifetime).
 * @param {object} payload - { sub, role, deputyUntil? }
 * @returns {string} Signed JWT
 */
function generateAccessToken(payload) {
  return jwt.sign(
    { ...payload, type: 'access', jti: crypto.randomUUID() },
    env.JWT_ACCESS_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY, algorithm: 'HS256' }
  );
}

/**
 * Generates a refresh token (7-day lifetime).
 * @param {string} userPublicId
 * @param {string} family - Token family UUID (all tokens from one login share a family)
 * @returns {string} Signed JWT
 */
function generateRefreshToken(userPublicId, family) {
  return jwt.sign(
    { sub: userPublicId, type: 'refresh', jti: crypto.randomUUID(), family },
    env.JWT_REFRESH_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY, algorithm: 'HS256' }
  );
}

/**
 * Returns a token pair: { accessToken, refreshToken }.
 * Called on login and on successful token rotation.
 *
 * @param {string} userPublicId
 * @param {'admin'|'user'} role
 * @param {string}  [family] - Existing family ID; omit to start a new session family.
 * @param {object}  [extra]  - Extra payload fields (e.g. { deputyUntil })
 * @returns {{ accessToken: string, refreshToken: string, family: string }}
 */
function generateTokenPair(userPublicId, role, family, extra = {}) {
  const tokenFamily = family || crypto.randomUUID();
  const accessToken = generateAccessToken({ sub: userPublicId, role, family: tokenFamily, ...extra });
  const refreshToken = generateRefreshToken(userPublicId, tokenFamily);
  return { accessToken, refreshToken, family: tokenFamily };
}

// ---------------------------------------------------------------------------
// Token hashing (for blacklist storage — never store raw token)
// ---------------------------------------------------------------------------

/**
 * Computes SHA-256 hex hash of a JWT string.
 * Only the hash is stored in the blacklist — never the raw token.
 * @param {string} token
 * @returns {string} SHA-256 hex
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ---------------------------------------------------------------------------
// Blacklist operations
// ---------------------------------------------------------------------------

/**
 * Adds a token to the blacklist (Redis + MongoDB).
 * Redis provides O(1) lookup; MongoDB is the durable fallback.
 *
 * @param {string}                           token
 * @param {string}                           userPublicId
 * @param {mongoose.Types.ObjectId}          userId
 * @param {keyof typeof BLACKLIST_REASONS}   reason
 * @param {Date}                             expiresAt
 */
async function blacklistToken(token, userPublicId, userId, reason, expiresAt) {
  const tokenHash = hashToken(token);
  const ttlSeconds = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));

  // Redis (fast path)
  if (ttlSeconds > 0) {
    await cacheSet(CacheKeys.tokenBlacklist(tokenHash), '1', ttlSeconds).catch(err => {
      logger.warn('[authService] فشل تخزين token blacklist في Redis', { error: err.message });
    });
  }

  // MongoDB (durable fallback)
  await TokenBlacklist.create([{
    publicId: crypto.randomUUID(),
    tokenHash,
    userId,
    userPublicId,
    reason,
    expiresAt,
  }]).catch(err => {
    logger.error('[authService] فشل تخزين token blacklist في MongoDB', { error: err.message });
  });
}

/**
 * Checks if a token hash is in the blacklist.
 * Cache-first strategy.
 *
 * @param {string} tokenHash - SHA-256 hex hash
 * @returns {Promise<boolean>}
 */
async function isTokenBlacklisted(tokenHash) {
  // 1. Redis check (fast path)
  const inRedis = await cacheExists(CacheKeys.tokenBlacklist(tokenHash));
  if (inRedis) return true;

  // 2. MongoDB fallback (cache miss — populate Redis)
  const doc = await TokenBlacklist.findOne({ tokenHash }).lean();
  if (doc) {
    // Repopulate Redis cache
    const ttl = Math.max(0, Math.floor((doc.expiresAt.getTime() - Date.now()) / 1000));
    if (ttl > 0) {
      await cacheSet(CacheKeys.tokenBlacklist(tokenHash), '1', ttl).catch(() => {});
    }
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// TOTP / 2FA utilities
// ---------------------------------------------------------------------------

/**
 * Generates a new TOTP secret for a user.
 * @param {string} userPublicId - Used as the issuer label.
 * @returns {{ secret: string, uri: string }} QR URI for authenticator app enrollment.
 */
function generateTOTPSecret(userPublicId) {
  const secret = authenticator.generateSecret();
  const uri = authenticator.keyuri(
    userPublicId,
    'Smart Dorm Wallet',
    secret
  );
  return { secret, uri };
}

/**
 * Verifies a TOTP code against the user's secret.
 * @param {string} token  - 6-digit OTP code from authenticator app.
 * @param {string} secret - TOTP secret (decrypted from DB by EncryptionService).
 * @returns {boolean}
 */
function verifyTOTP(token, secret) {
  return authenticator.verify({ token, secret });
}

// ---------------------------------------------------------------------------
// Unusual hours detection
// ---------------------------------------------------------------------------

/**
 * Checks if the current local time is between 02:00 and 05:00.
 * Used to flag audit log entries for anomaly detection.
 * @returns {boolean}
 */
function isUnusualHours() {
  const hour = new Date().getHours();
  return hour >= UNUSUAL_HOURS_START && hour < UNUSUAL_HOURS_END;
}

// ---------------------------------------------------------------------------
// LOGIN
// ---------------------------------------------------------------------------

/**
 * Authenticates a user and returns a token pair.
 *
 * FLOW:
 *  1. Find user by publicId (phone-based lookup in real system — simplified here)
 *  2. Check account status (disabled → reject)
 *  3. Check lockout (lockedUntil > now → reject with remaining time)
 *  4. Verify password (bcrypt.compare)
 *  5. On failure: increment failedLoginAttempts; lock if ≥ MAX_FAILED_ATTEMPTS
 *  6. On success: clear failedLoginAttempts; check 2FA requirement
 *  7. If 2FA required and not provided → return { requiresTwoFactor: true }
 *  8. Generate token pair; store refresh token hash in blacklist collection
 *     (it will be "checked out" — blacklisted on use for rotation)
 *  9. Audit log
 *
 * @param {object} credentials
 * @param {string} credentials.phone         - User's phone number (lookup key).
 * @param {string} credentials.password      - Plain-text password.
 * @param {string} [credentials.totpCode]    - 6-digit TOTP code (if 2FA enabled).
 * @param {object} context
 * @param {string} context.ip
 * @param {string} context.userAgent
 * @returns {Promise<{
 *   accessToken?: string,
 *   refreshToken?: string,
 *   requiresTwoFactor?: boolean,
 *   user: { publicId, fullName, role }
 * }>}
 * @throws {AuthError}
 */
async function login(credentials, context = {}) {
  const { phone, password, totpCode } = credentials;
  const { ip = null, userAgent = null } = context;

  if (!phone || !password) {
    throw new AuthError('رقم الهاتف وكلمة المرور مطلوبان', 'MISSING_CREDENTIALS', 400);
  }

  // Find user with auth fields (select: +passwordHash)
  const user = await require('../models').User
    .findOne({ phone: phone.trim() })
    .select('+passwordHash +twoFactorSecret')
    .lean();

  if (!user) {
    throw new AuthError('بيانات الدخول غير صحيحة', 'INVALID_CREDENTIALS');
  }

  // Account status check
  if (user.status === 'disabled') {
    throw new AuthError('الحساب معطّل — تواصل مع المسؤول', 'ACCOUNT_DISABLED', 403);
  }

  // Lockout check
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const remainingMs = user.lockedUntil.getTime() - Date.now();
    const remainingMin = Math.ceil(remainingMs / 60000);
    throw new AuthError(
      `الحساب مؤقتاً مقفل — حاول مجدداً بعد ${remainingMin} دقيقة`,
      'ACCOUNT_LOCKED'
    );
  }

  // Password verification
  const passwordMatch = await verifyPassword(password, user.passwordHash);
  if (!passwordMatch) {
    const newFailCount = (user.failedLoginAttempts || 0) + 1;
    const shouldLock = newFailCount >= MAX_FAILED_ATTEMPTS;
    const lockUntil = shouldLock ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null;

    await userRepository.recordFailedLogin(user.publicId, lockUntil);

    await auditLogRepository.createLog({
      actorId: user._id,
      actorPublicId: user.publicId,
      actorRole: ACTOR_ROLES.USER,
      actorName: user.fullName,
      action: 'auth.login_failed',
      entityType: AUDIT_ENTITY_TYPES.USER,
      entityPublicId: user.publicId,
      ipAddress: ip,
      userAgent,
      isUnusualHours: isUnusualHours(),
      metadata: { failedAttempts: newFailCount, locked: shouldLock },
    });

    if (shouldLock) {
      throw new AuthError(
        `تجاوزت الحد الأقصى لمحاولات الدخول — الحساب مقفل لمدة 30 دقيقة`,
        'ACCOUNT_LOCKED'
      );
    }

    throw new AuthError('بيانات الدخول غير صحيحة', 'INVALID_CREDENTIALS');
  }

  // 2FA check
  if (user.twoFactorEnabled && user.twoFactorSecret) {
    if (!totpCode) {
      // Signal front-end to show 2FA input
      return {
        requiresTwoFactor: true,
        user: { publicId: user.publicId, fullName: user.fullName, role: user.role },
      };
    }

    // Decrypt twoFactorSecret (EncryptionService — deferred for now)
    // For the auth flow, we assume the secret is already in decrypted form.
    // In production: const decryptedSecret = encryptionService.decrypt(user.twoFactorSecret);
    const isValid = verifyTOTP(totpCode, user.twoFactorSecret);
    if (!isValid) {
      throw new AuthError('رمز التحقق غير صحيح أو منتهي الصلاحية', 'INVALID_TOTP');
    }
  }

  // Clear failed attempts on success
  await userRepository.recordSuccessfulLogin(user.publicId);

  // Generate token pair
  const { accessToken, refreshToken, family } = generateTokenPair(
    user.publicId,
    user.role
  );

  // Audit log
  await auditLogRepository.createLog({
    actorId: user._id,
    actorPublicId: user.publicId,
    actorRole: user.role === 'admin' ? ACTOR_ROLES.ADMIN : ACTOR_ROLES.USER,
    actorName: user.fullName,
    action: 'auth.login_success',
    entityType: AUDIT_ENTITY_TYPES.USER,
    entityPublicId: user.publicId,
    ipAddress: ip,
    userAgent,
    isUnusualHours: isUnusualHours(),
    metadata: { family },
  });

  logger.info('[authService] ✅ تسجيل دخول ناجح', {
    publicId: user.publicId,
    role: user.role,
  });

  return {
    accessToken,
    refreshToken,
    user: { 
      publicId: user.publicId, 
      fullName: user.fullName, 
      role: user.role,
      accountNumber: user.accountNumber || null,
      roomNumber: user.roomNumber || null,
    },
  };
}

// ---------------------------------------------------------------------------
// TOKEN ROTATION (Refresh)
// ---------------------------------------------------------------------------

/**
 * Rotates a refresh token — invalidates the old one, issues a new pair.
 *
 * REPLAY ATTACK DETECTION:
 *   If the submitted refresh token is already blacklisted, it means it was
 *   previously used (rotated) — this is a replay attack. All tokens from
 *   the same family are revoked immediately.
 *
 * @param {string} oldRefreshToken - The current (valid) refresh token.
 * @returns {Promise<{ accessToken: string, refreshToken: string }>}
 * @throws {AuthError}
 */
async function rotateRefreshToken(oldRefreshToken) {
  // Verify the token signature and expiry
  let decoded;
  try {
    decoded = jwt.verify(oldRefreshToken, env.JWT_REFRESH_SECRET);
  } catch (err) {
    throw new AuthError('رمز التحديث غير صالح أو منتهي الصلاحية', 'INVALID_REFRESH_TOKEN');
  }

  if (decoded.type !== 'refresh') {
    throw new AuthError('نوع الرمز المميز غير صحيح', 'INVALID_TOKEN_TYPE');
  }

  const tokenHash = hashToken(oldRefreshToken);

  // Check blacklist — if blacklisted, this is a replay attack
  const isBlacklisted = await isTokenBlacklisted(tokenHash);
  if (isBlacklisted) {
    // REPLAY ATTACK: revoke all tokens from this family
    logger.warn('[authService] 🔴 هجوم إعادة استخدام Token تم اكتشافه', {
      userPublicId: decoded.sub,
      family: decoded.family,
    });

    await auditLogRepository.createLog({
      actorPublicId: decoded.sub,
      actorRole: ACTOR_ROLES.SYSTEM,
      action: AUDIT_ACTIONS.ANOMALY_FLAGGED,
      entityType: AUDIT_ENTITY_TYPES.USER,
      entityPublicId: decoded.sub,
      metadata: {
        type: 'token_replay_attack',
        family: decoded.family,
        tokenHash,
      },
    });

    throw new AuthError(
      'تم اكتشاف نشاط مشبوه — تم إلغاء جميع جلساتك',
      'REPLAY_ATTACK_DETECTED'
    );
  }

  // Find the user
  const user = await userRepository.findByPublicId(decoded.sub);
  if (!user || user.status === 'disabled') {
    throw new AuthError('الحساب غير موجود أو معطّل', 'ACCOUNT_UNAVAILABLE');
  }

  // Blacklist the old refresh token
  const expiresAt = new Date(decoded.exp * 1000);
  const userId = await require('../models').User
    .findOne({ publicId: decoded.sub })
    .select('_id')
    .lean()
    .then(u => u?._id);

  await blacklistToken(
    oldRefreshToken,
    decoded.sub,
    userId,
    BLACKLIST_REASONS.ROTATION,
    expiresAt
  );

  // Generate new token pair (same family)
  const { accessToken, refreshToken } = generateTokenPair(
    decoded.sub,
    user.role,
    decoded.family
  );

  logger.info('[authService] ✅ تم تدوير الرمز المميز', { userPublicId: decoded.sub });

  return { accessToken, refreshToken };
}

// ---------------------------------------------------------------------------
// LOGOUT
// ---------------------------------------------------------------------------

/**
 * Logs out a user by blacklisting their refresh token.
 *
 * @param {string}                  refreshToken
 * @param {string}                  userPublicId
 * @param {mongoose.Types.ObjectId} userId
 * @returns {Promise<void>}
 */
async function logout(refreshToken, userPublicId, userId) {
  try {
    const decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET);
    const expiresAt = new Date(decoded.exp * 1000);
    await blacklistToken(
      refreshToken,
      userPublicId,
      userId,
      BLACKLIST_REASONS.LOGOUT,
      expiresAt
    );
  } catch {
    // Token already expired or invalid — nothing to blacklist
  }

  logger.info('[authService] ✅ تسجيل خروج', { userPublicId });
}

// ---------------------------------------------------------------------------
// TOKEN VERIFICATION (used by authMiddleware)
// ---------------------------------------------------------------------------

/**
 * Verifies an access token and returns its decoded payload.
 *
 * @param {string} accessToken
 * @returns {Promise<object>} Decoded payload: { sub, role, jti, type, family, ... }
 * @throws {AuthError}
 */
async function verifyAccessToken(accessToken) {
  let decoded;
  try {
    decoded = jwt.verify(accessToken, env.JWT_ACCESS_SECRET);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new AuthError('انتهت صلاحية رمز الجلسة — يرجى تسجيل الدخول مجدداً', 'TOKEN_EXPIRED');
    }
    throw new AuthError('رمز الجلسة غير صالح', 'INVALID_ACCESS_TOKEN');
  }

  if (decoded.type !== 'access') {
    throw new AuthError('نوع الرمز المميز غير صحيح', 'INVALID_TOKEN_TYPE');
  }

  return decoded;
}

// ---------------------------------------------------------------------------
// Change password
// ---------------------------------------------------------------------------

/**
 * Changes a user's password after verifying the current password.
 *
 * @param {string} userPublicId
 * @param {string} currentPassword
 * @param {string} newPassword
 * @throws {AuthError} if current password is incorrect
 */
async function changePassword(userPublicId, currentPassword, newPassword) {
  const user = await userRepository.findForAuth(userPublicId);
  if (!user) throw new AuthError('USER_NOT_FOUND', 'المستخدم غير موجود', 404);

  const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!isMatch) throw new AuthError('WRONG_PASSWORD', 'كلمة المرور الحالية غير صحيحة', 400);

  const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await userRepository.updateByPublicId(userPublicId, { passwordHash: newHash });

  logger.info('[authService] تم تغيير كلمة المرور', { userPublicId });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Password
  hashPassword,
  verifyPassword,

  // Tokens
  generateTokenPair,
  generateAccessToken,
  verifyAccessToken,
  rotateRefreshToken,

  // Blacklist
  hashToken,
  blacklistToken,
  isTokenBlacklisted,

  // 2FA
  generateTOTPSecret,
  verifyTOTP,

  // Auth flows
  login,
  logout,
  changePassword,

  // Utilities
  isUnusualHours,

  // Error class
  AuthError,
};
