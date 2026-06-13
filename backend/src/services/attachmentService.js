/**
 * @file attachmentService.js
 * @description Secure financial attachment management via Cloudinary.
 *
 * ██████████████████████████████████████████████████████████████████████████
 * ██  SECURITY CONTRACT (spec §7)                                         ██
 * ██████████████████████████████████████████████████████████████████████████
 *
 * ❌ FORBIDDEN: Storing Cloudinary raw/permanent URLs in the database.
 * ✅ REQUIRED:  Store ONLY the Cloudinary `public_id` (e.g. "smart-dorm-wallet/deposit-receipts/user-abc123-1234567890")
 *               Generate a Signed URL on-demand with 15-minute TTL.
 *
 * WHY SIGNED URLS?
 *   1. A leaked DB does NOT expose receipt images (public_id alone is useless).
 *   2. Even a valid signed URL expires in 15 min — brute-force window is tiny.
 *   3. Cloudinary audit log records every URL generation event.
 *   4. Revocation: if a receipt URL is shared, it expires automatically.
 *
 * NAMING CONVENTION:
 *   public_id = "{folder}/{userPublicId}-{timestamp}-{randomSuffix}"
 *   Examples:
 *     "smart-dorm-wallet/deposit-receipts/user-abc123-1718800000000-f3d2"
 *     "smart-dorm-wallet/expense-receipts/user-xyz789-1718800001000-a1b2"
 *
 *   Benefits:
 *     - Globally unique (timestamp + random suffix)
 *     - User-traceable (contains userPublicId)
 *     - Time-sortable (timestamp component)
 *     - Folder-scoped (no cross-folder collisions)
 *
 * ERROR POLICY:
 *   - Upload failures: Error is caught, re-thrown as AttachmentError with Arabic message.
 *     No temp files are left on disk (memory storage only).
 *   - URL generation failures: Re-thrown as AttachmentError.
 *   - Delete failures: Logged as warning (non-fatal — file may already be deleted).
 *
 * RESOURCE TYPES:
 *   - JPEG / PNG → resource_type: 'image'
 *   - PDF        → resource_type: 'raw'
 *   Signed URL generation uses matching resource_type.
 *
 * SPEC REFERENCES: §7 (Attachment Security), §6 (Deposits), §8 (Withdrawals)
 *
 * @module services/attachmentService
 */

'use strict';

const crypto = require('crypto');
const { cloudinary, FOLDERS, generateSignedUrl, uploadFile, deleteFile } = require('../config/cloudinary');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

class AttachmentError extends Error {
  /**
   * @param {string} message  - Arabic error message.
   * @param {string} [code]   - Machine-readable error code.
   * @param {number} [statusCode=502]  - HTTP status (502 for upstream Cloudinary failure).
   */
  constructor(message, code = 'ATTACHMENT_ERROR', statusCode = 502) {
    super(message);
    this.name       = 'AttachmentError';
    this.code       = code;
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determines Cloudinary resource_type from a MIME type string.
 *
 * @param {string} mimeType
 * @returns {'image'|'raw'}
 */
function resolveResourceType(mimeType) {
  if (mimeType === 'application/pdf') return 'raw';
  return 'image';
}

/**
 * Generates a unique, user-traceable public_id for Cloudinary.
 *
 * Format: {userPublicId}-{unixTimestampMs}-{4hexChars}
 * The random suffix prevents collisions from rapid successive uploads.
 *
 * @param {string} userPublicId
 * @returns {string}
 */
function generatePublicIdSuffix(userPublicId) {
  const timestamp  = Date.now();
  const randomHex  = crypto.randomBytes(2).toString('hex'); // 4 hex chars
  // Sanitize userPublicId: replace non-alphanumeric with hyphens
  const safeUserId = userPublicId.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 36);
  return `${safeUserId}-${timestamp}-${randomHex}`;
}

// ---------------------------------------------------------------------------
// 1. uploadDepositReceipt
// ---------------------------------------------------------------------------

/**
 * Uploads a deposit receipt to the Cloudinary DEPOSIT_RECEIPTS folder.
 *
 * @param {Buffer}  fileBuffer     - Raw file data from multer memory storage.
 * @param {string}  userPublicId   - UUID of the uploading user.
 * @param {string}  mimeType       - MIME type (from req.file.mimetype).
 * @returns {Promise<{
 *   cloudinaryPublicId: string,   — Store THIS in DB (not the URL)
 *   resourceType: 'image'|'raw',  — Needed for future URL generation
 *   format: string,               — e.g. 'jpeg', 'png', 'pdf'
 *   bytes: number,
 * }>}
 * @throws {AttachmentError} On Cloudinary API failure or empty buffer.
 */
async function uploadDepositReceipt(fileBuffer, userPublicId, mimeType) {
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
    throw new AttachmentError(
      'الملف المرفوع فارغ أو غير صالح',
      'INVALID_BUFFER',
      422
    );
  }
  if (!userPublicId) {
    throw new AttachmentError('معرف المستخدم مطلوب لرفع الإيصال', 'MISSING_USER_ID', 422);
  }

  const resourceType = resolveResourceType(mimeType);
  const publicIdSuffix = generatePublicIdSuffix(userPublicId);

  try {
    const result = await uploadFile(fileBuffer, {
      folder: FOLDERS.DEPOSIT_RECEIPTS,
      public_id: publicIdSuffix,
      resource_type: resourceType,
      // Prevent Cloudinary from overwriting on filename collision
      unique_filename: false,
      overwrite: false,
      // Apply basic transformations for images (not PDFs)
      ...(resourceType === 'image' && {
        quality: 'auto:good',
        fetch_format: 'auto',
      }),
    });

    const cloudinaryPublicId = result.publicId;

    logger.info('[attachmentService] ✅ تم رفع إيصال الإيداع', {
      userPublicId,
      cloudinaryPublicId,
      bytes: result.bytes,
      format: result.format,
      resourceType,
    });

    return {
      cloudinaryPublicId,
      resourceType,
      format: result.format,
      bytes: result.bytes,
    };
  } catch (err) {
    if (err instanceof AttachmentError) throw err;

    logger.error('[attachmentService] ❌ فشل رفع إيصال الإيداع إلى Cloudinary', {
      userPublicId,
      error: err.message,
      errorCode: err.http_code,
    });

    throw new AttachmentError(
      `فشل رفع الإيصال إلى خدمة التخزين السحابي — ${err.message}`,
      'CLOUDINARY_UPLOAD_FAILED'
    );
  }
}

// ---------------------------------------------------------------------------
// 2. uploadWithdrawalReceipt
// ---------------------------------------------------------------------------

/**
 * Uploads a withdrawal receipt (admin-side proof of payment).
 *
 * @param {Buffer}  fileBuffer
 * @param {string}  adminPublicId
 * @param {string}  mimeType
 * @returns {Promise<{ cloudinaryPublicId, resourceType, format, bytes }>}
 */
async function uploadWithdrawalReceipt(fileBuffer, adminPublicId, mimeType) {
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
    throw new AttachmentError('الملف المرفوع فارغ أو غير صالح', 'INVALID_BUFFER', 422);
  }

  const resourceType = resolveResourceType(mimeType);
  const publicIdSuffix = generatePublicIdSuffix(adminPublicId);

  try {
    const result = await uploadFile(fileBuffer, {
      folder: FOLDERS.WITHDRAWAL_RECEIPTS,
      public_id: publicIdSuffix,
      resource_type: resourceType,
      unique_filename: false,
      overwrite: false,
      ...(resourceType === 'image' && {
        quality: 'auto:good',
        fetch_format: 'auto',
      }),
    });

    logger.info('[attachmentService] ✅ تم رفع إيصال السحب', {
      adminPublicId,
      cloudinaryPublicId: result.publicId,
      bytes: result.bytes,
    });

    return {
      cloudinaryPublicId: result.publicId,
      resourceType,
      format: result.format,
      bytes: result.bytes,
    };
  } catch (err) {
    if (err instanceof AttachmentError) throw err;
    logger.error('[attachmentService] ❌ فشل رفع إيصال السحب', {
      adminPublicId,
      error: err.message,
    });
    throw new AttachmentError(
      `فشل رفع إيصال السحب: ${err.message}`,
      'CLOUDINARY_UPLOAD_FAILED'
    );
  }
}

// ---------------------------------------------------------------------------
// 3. uploadExpenseReceipt
// ---------------------------------------------------------------------------

/**
 * Uploads a shared expense receipt.
 *
 * @param {Buffer}  fileBuffer
 * @param {string}  adminPublicId
 * @param {string}  mimeType
 * @returns {Promise<{ cloudinaryPublicId, resourceType, format, bytes }>}
 */
async function uploadExpenseReceipt(fileBuffer, adminPublicId, mimeType) {
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
    throw new AttachmentError('الملف المرفوع فارغ أو غير صالح', 'INVALID_BUFFER', 422);
  }

  const resourceType = resolveResourceType(mimeType);
  const publicIdSuffix = generatePublicIdSuffix(adminPublicId);

  try {
    const result = await uploadFile(fileBuffer, {
      folder: FOLDERS.EXPENSE_RECEIPTS,
      public_id: publicIdSuffix,
      resource_type: resourceType,
      unique_filename: false,
      overwrite: false,
      ...(resourceType === 'image' && {
        quality: 'auto:good',
        fetch_format: 'auto',
      }),
    });

    logger.info('[attachmentService] ✅ تم رفع إيصال المصروف', {
      adminPublicId,
      cloudinaryPublicId: result.publicId,
    });

    return {
      cloudinaryPublicId: result.publicId,
      resourceType,
      format: result.format,
      bytes: result.bytes,
    };
  } catch (err) {
    if (err instanceof AttachmentError) throw err;
    logger.error('[attachmentService] ❌ فشل رفع إيصال المصروف', { error: err.message });
    throw new AttachmentError(`فشل رفع إيصال المصروف: ${err.message}`, 'CLOUDINARY_UPLOAD_FAILED');
  }
}

// ---------------------------------------------------------------------------
// 4. uploadMerchantSettlementReceipt
// ---------------------------------------------------------------------------

/**
 * Uploads a merchant settlement receipt.
 *
 * @param {Buffer}  fileBuffer
 * @param {string}  adminPublicId
 * @param {string}  mimeType
 * @returns {Promise<{ cloudinaryPublicId, resourceType, format, bytes }>}
 */
async function uploadMerchantSettlementReceipt(fileBuffer, adminPublicId, mimeType) {
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
    throw new AttachmentError('الملف المرفوع فارغ أو غير صالح', 'INVALID_BUFFER', 422);
  }

  const resourceType = resolveResourceType(mimeType);
  const publicIdSuffix = generatePublicIdSuffix(adminPublicId);

  try {
    const result = await uploadFile(fileBuffer, {
      folder: FOLDERS.MERCHANT_SETTLEMENTS,
      public_id: publicIdSuffix,
      resource_type: resourceType,
      unique_filename: false,
      overwrite: false,
      ...(resourceType === 'image' && { quality: 'auto:good', fetch_format: 'auto' }),
    });

    logger.info('[attachmentService] ✅ تم رفع إيصال التسوية مع التاجر', {
      adminPublicId,
      cloudinaryPublicId: result.publicId,
    });

    return {
      cloudinaryPublicId: result.publicId,
      resourceType,
      format: result.format,
      bytes: result.bytes,
    };
  } catch (err) {
    if (err instanceof AttachmentError) throw err;
    logger.error('[attachmentService] ❌ فشل رفع إيصال التسوية', { error: err.message });
    throw new AttachmentError(`فشل رفع إيصال التسوية: ${err.message}`, 'CLOUDINARY_UPLOAD_FAILED');
  }
}

// ---------------------------------------------------------------------------
// 5. getSecureReceiptUrl  (SPEC §7 — 15-minute signed URL)
// ---------------------------------------------------------------------------

/**
 * Generates a time-limited signed URL for a Cloudinary resource.
 *
 * CRITICAL SECURITY RULE (spec §7):
 *   ❌ NEVER store this URL in the database — it expires in 15 minutes.
 *   ✅ Call this on every API request that needs to display a receipt.
 *   ✅ The URL is safe to return in API responses (it expires automatically).
 *
 * The caller MUST pass the resourceType stored alongside the public_id in DB.
 * PDF receipts use resource_type='raw'; images use resource_type='image'.
 *
 * @param {string}          cloudinaryPublicId  - The public_id stored in DB.
 * @param {'image'|'raw'}   [resourceType='image']
 * @returns {string} Signed URL valid for 15 minutes.
 * @throws {AttachmentError} If public_id is invalid or URL generation fails.
 */
function getSecureReceiptUrl(cloudinaryPublicId, resourceType = 'image') {
  if (!cloudinaryPublicId || typeof cloudinaryPublicId !== 'string') {
    throw new AttachmentError(
      'معرف المرفق مطلوب لإنشاء رابط الوصول الآمن',
      'MISSING_PUBLIC_ID',
      422
    );
  }

  try {
    const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60; // +15 minutes

    const signedUrl = cloudinary.url(cloudinaryPublicId, {
      sign_url:      true,
      expires_at:    expiresAt,
      resource_type: resourceType,
      type:          'upload',
      // Delivery transformations for images
      ...(resourceType === 'image' && {
        quality: 'auto',
        fetch_format: 'auto',
      }),
    });

    logger.debug('[attachmentService] ✅ تم توليد رابط إيصال آمن', {
      cloudinaryPublicId,
      expiresInSeconds: 900,
    });

    return signedUrl;
  } catch (err) {
    logger.error('[attachmentService] ❌ فشل توليد الرابط الآمن', {
      cloudinaryPublicId,
      error: err.message,
    });

    throw new AttachmentError(
      'فشل توليد رابط الوصول الآمن للإيصال',
      'SIGNED_URL_GENERATION_FAILED'
    );
  }
}

// ---------------------------------------------------------------------------
// 6. deleteAttachment
// ---------------------------------------------------------------------------

/**
 * Permanently deletes an attachment from Cloudinary.
 *
 * WHEN TO CALL:
 *   - Admin REJECTS a deposit request → delete the uploaded receipt
 *   - Admin REJECTS a withdrawal request → delete proof document
 *   - A request is cancelled before admin action
 *
 * FAILURE POLICY:
 *   If Cloudinary deletion fails (e.g. already deleted, network error):
 *     - Log a warning (not an error) — this is non-fatal.
 *     - Do NOT throw — the financial operation should not be blocked by
 *       a Cloudinary cleanup failure.
 *     - The orphaned file will eventually be cleaned up by Cloudinary's
 *       unused-asset management or a manual admin sweep.
 *
 * @param {string}          cloudinaryPublicId
 * @param {'image'|'raw'}   [resourceType='image']
 * @returns {Promise<boolean>} True if deleted, false if deletion failed.
 */
async function deleteAttachment(cloudinaryPublicId, resourceType = 'image') {
  if (!cloudinaryPublicId) {
    logger.warn('[attachmentService] deleteAttachment: معرف المرفق مفقود — تم التخطي');
    return false;
  }

  try {
    const result = await cloudinary.uploader.destroy(cloudinaryPublicId, {
      resource_type: resourceType,
      invalidate: true, // Also purge from CDN cache
    });

    if (result.result === 'ok' || result.result === 'not found') {
      logger.info('[attachmentService] ✅ تم حذف المرفق من Cloudinary', {
        cloudinaryPublicId,
        result: result.result,
      });
      return true;
    }

    logger.warn('[attachmentService] ⚠️ نتيجة حذف غير متوقعة من Cloudinary', {
      cloudinaryPublicId,
      result,
    });
    return false;
  } catch (err) {
    // Non-fatal — log and return false
    logger.warn('[attachmentService] ⚠️ فشل حذف المرفق من Cloudinary (غير حرج)', {
      cloudinaryPublicId,
      error: err.message,
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// 7. Batch URL generation (for admin lists)
// ---------------------------------------------------------------------------

/**
 * Generates signed URLs for multiple Cloudinary public_ids at once.
 * Used when rendering a list of receipts (e.g. admin deposit queue).
 *
 * Returns null for any entry that fails (instead of throwing).
 *
 * @param {Array<{ cloudinaryPublicId: string, resourceType?: string }>} attachments
 * @returns {Array<{ cloudinaryPublicId: string, signedUrl: string|null }>}
 */
function getBatchSecureUrls(attachments) {
  return attachments.map(({ cloudinaryPublicId, resourceType = 'image' }) => {
    try {
      const signedUrl = getSecureReceiptUrl(cloudinaryPublicId, resourceType);
      return { cloudinaryPublicId, signedUrl };
    } catch {
      return { cloudinaryPublicId, signedUrl: null };
    }
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Upload functions (one per receipt type)
  uploadDepositReceipt,
  uploadWithdrawalReceipt,
  uploadExpenseReceipt,
  uploadMerchantSettlementReceipt,

  // URL generation (always signed, always 15-min TTL)
  getSecureReceiptUrl,
  getBatchSecureUrls,

  // Deletion
  deleteAttachment,

  // Utilities (exported for unit testing)
  generatePublicIdSuffix,
  resolveResourceType,

  // Error class
  AttachmentError,
};
