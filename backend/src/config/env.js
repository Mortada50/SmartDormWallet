/**
 * @file env.js
 * @description Environment variable validation and parsing.
 *              Validated and parsed once at startup; all modules import from here.
 *              Server WILL NOT start if any required variable fails validation.
 *
 * Variables are validated with Zod. Sensitive defaults are intentionally omitted
 * so that a misconfigured deployment fails loudly instead of silently.
 */

'use strict';

const { z } = require('zod');

// ---------------------------------------------------------------------------
// Helper coercions
// ---------------------------------------------------------------------------

/** Coerce a string to a positive integer (base 10). */
const positiveInt = z
  .string()
  .trim()
  .regex(/^\d+$/, 'يجب أن يكون عدداً صحيحاً موجباً')
  .transform(Number)
  .pipe(z.number().int().positive());

/** Coerce a string "true"/"false" to boolean. */
const booleanString = z
  .enum(['true', 'false'], {
    errorMap: () => ({ message: 'يجب أن تكون القيمة "true" أو "false"' }),
  })
  .transform((v) => v === 'true');

// ---------------------------------------------------------------------------
// Schema definition
// ---------------------------------------------------------------------------

const envSchema = z.object({
  // ── Node ──────────────────────────────────────────────────────────────────
  NODE_ENV: z
    .enum(['development', 'production', 'test'], {
      errorMap: () => ({
        message: 'NODE_ENV يجب أن يكون development أو production أو test',
      }),
    })
    .default('development'),

  PORT: positiveInt.default('5000'),

  // ── MongoDB ───────────────────────────────────────────────────────────────
  MONGODB_URI: z
    .string()
    .trim()
    .min(1, 'رابط قاعدة البيانات MONGODB_URI مطلوب')
    .url('MONGODB_URI يجب أن يكون رابطاً صحيحاً'),

  /** Application-level DB user — must NOT have drop/delete collection rights. */
  MONGODB_APP_USER: z.string().trim().min(1, 'MONGODB_APP_USER مطلوب'),

  MONGODB_APP_PASSWORD: z
    .string()
    .trim()
    .min(1, 'MONGODB_APP_PASSWORD مطلوب'),

  // ── JWT ───────────────────────────────────────────────────────────────────
  /**
   * HS256 secret (minimum 256 bits / 32 bytes).
   * For RS256 production setup, replace with RSA_PRIVATE_KEY / RSA_PUBLIC_KEY.
   */
  JWT_ACCESS_SECRET: z
    .string()
    .trim()
    .min(32, 'JWT_ACCESS_SECRET يجب أن يكون 32 حرفاً على الأقل'),

  JWT_ACCESS_EXPIRES_IN: z.string().trim().default('15m'),

  JWT_REFRESH_SECRET: z
    .string()
    .trim()
    .min(32, 'JWT_REFRESH_SECRET يجب أن يكون 32 حرفاً على الأقل'),

  JWT_REFRESH_EXPIRES_IN: z.string().trim().default('7d'),

  // ── Encryption (AES-256-GCM) ──────────────────────────────────────────────
  /**
   * Must be exactly 64 hex characters (= 32 raw bytes = 256 bits).
   * Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   */
  AES_ENCRYPTION_KEY: z
    .string()
    .trim()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      'AES_ENCRYPTION_KEY يجب أن يكون 64 حرفاً هيكساديسيمالاً (256 بت)'
    ),

  // ── Cloudinary ────────────────────────────────────────────────────────────
  CLOUDINARY_CLOUD_NAME: z
    .string()
    .trim()
    .min(1, 'CLOUDINARY_CLOUD_NAME مطلوب'),

  CLOUDINARY_API_KEY: z.string().trim().min(1, 'CLOUDINARY_API_KEY مطلوب'),

  CLOUDINARY_API_SECRET: z
    .string()
    .trim()
    .min(1, 'CLOUDINARY_API_SECRET مطلوب'),

  // ── Redis ─────────────────────────────────────────────────────────────────
  /**
   * Redis URL for BullMQ queues + token blacklist + caching.
   * Falls back to an in-process strategy when absent (non-production only).
   */
  REDIS_URL: z
    .string()
    .trim()
    .url('REDIS_URL يجب أن يكون رابطاً صحيحاً')
    .optional(),

  // ── Auto-backup ───────────────────────────────────────────────────────────
  /**
   * 64-hex-char key used for system-generated (auto) backups.
   * Admin-initiated backups use a user-supplied password instead.
   */
  AUTO_BACKUP_ENCRYPTION_KEY: z
    .string()
    .trim()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      'AUTO_BACKUP_ENCRYPTION_KEY يجب أن يكون 64 حرفاً هيكساديسيمالاً (256 بت)'
    )
    .optional(),

  // ── TOTP (2FA) ────────────────────────────────────────────────────────────
  TOTP_ISSUER: z.string().trim().default('SmartDormWallet'),

  // ── Application ───────────────────────────────────────────────────────────
  /** Public-facing base URL used in receipts, PDF footers, etc. */
  APP_BASE_URL: z
    .string()
    .trim()
    .url('APP_BASE_URL يجب أن يكون رابطاً صحيحاً')
    .default('http://localhost:5000'),

  /** CORS: comma-separated list of allowed origins, e.g. http://localhost:3000 */
  CORS_ORIGINS: z.string().trim().default('http://localhost:3000'),

  // ── Email (optional) ──────────────────────────────────────────────────────
  SMTP_HOST: z.string().trim().optional(),
  SMTP_PORT: positiveInt.optional(),
  SMTP_USER: z.string().trim().optional(),
  SMTP_PASS: z.string().trim().optional(),
  EMAIL_FROM: z.string().trim().email().optional(),

  // ── Logging ───────────────────────────────────────────────────────────────
  LOG_LEVEL: z
    .enum(['error', 'warn', 'info', 'http', 'debug'])
    .default('info'),
});

// ---------------------------------------------------------------------------
// Parse & validate
// ---------------------------------------------------------------------------

const _parsed = envSchema.safeParse(process.env);

if (!_parsed.success) {
  // Format Zod errors into a readable Arabic + English table and crash hard.
  const issues = _parsed.error.issues
    .map((i) => `  • [${i.path.join('.')}] ${i.message}`)
    .join('\n');

  console.error(
    '\n🔴 [env] فشل التحقق من متغيرات البيئة — يرجى مراجعة ملف .env:\n' +
    issues +
    '\n'
  );
  process.exit(1);
}

/**
 * Validated, typed environment configuration.
 * Import this object everywhere instead of reading process.env directly.
 *
 * @type {z.infer<typeof envSchema>}
 */
const env = Object.freeze(_parsed.data);

module.exports = env;
