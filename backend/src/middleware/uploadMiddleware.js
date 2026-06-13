/**
 * @file uploadMiddleware.js
 * @description Multer-based upload middleware with deep file validation.
 *
 * ██████████████████████████████████████████████████████████████████████████
 * ██  SECURITY MODEL                                                      ██
 * ██████████████████████████████████████████████████████████████████████████
 *
 * LAYER 1 — Size limit (DoS protection):
 *   multer({ limits: { fileSize: 2MB } }) rejects oversized payloads before
 *   reading the file body into memory. This is the first line of defence.
 *
 * LAYER 2 — MIME-Type whitelist (content-type header):
 *   multer's fileFilter checks req file's mimetype against an allowed set.
 *   This is spoofable by the client so it is NOT the primary safety check.
 *
 * LAYER 3 — Magic-byte validation (validateMagicBytes middleware):
 *   After multer buffers the file, this middleware reads the first 8 bytes
 *   and verifies them against known file signatures (magic numbers).
 *   This CANNOT be spoofed by renaming a file or lying in the Content-Type.
 *   A file claiming to be image/jpeg that starts with %PDF bytes will be REJECTED.
 *
 * MEMORY STORAGE POLICY:
 *   Files are stored in memory (Buffer) — NOT on disk.
 *   This means:
 *     - No temp files left on the server even on crash/rejection.
 *     - Buffer is attached to req.file.buffer for use by attachmentService.
 *     - Memory storage is safe for 2MB limit (default Node.js heap >> 2MB).
 *
 * ALLOWED TYPES:
 *   MIME type       | Magic bytes (hex)         | Extension
 *   ────────────────┼───────────────────────────┼──────────
 *   image/jpeg      | FF D8 FF                  | .jpg .jpeg
 *   image/png       | 89 50 4E 47 0D 0A 1A 0A  | .png
 *   application/pdf | 25 50 44 46               | .pdf
 *
 * SPEC REFERENCES: §7 (Attachment security), §12 (DoS protection)
 *
 * @module middleware/uploadMiddleware
 */

'use strict';

const multer = require('multer');
const path   = require('path');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB

/** Allowed MIME types — header-level check (Layer 2) */
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'application/pdf',
]);

/** Allowed file extensions — secondary check */
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.pdf']);

/**
 * Magic-byte signatures for allowed file types.
 * Key: MIME type string.
 * Value: Array of allowed byte sequences (as number arrays).
 *        A file passes if its header matches ANY entry in the array.
 *
 * References:
 *   JPEG: https://en.wikipedia.org/wiki/JPEG#Syntax_and_structure
 *   PNG:  https://en.wikipedia.org/wiki/PNG#File_format
 *   PDF:  https://en.wikipedia.org/wiki/PDF#File_structure
 */
const MAGIC_BYTES = {
  'image/jpeg': [
    [0xFF, 0xD8, 0xFF, 0xE0], // JFIF
    [0xFF, 0xD8, 0xFF, 0xE1], // EXIF
    [0xFF, 0xD8, 0xFF, 0xDB], // raw JPEG
    [0xFF, 0xD8, 0xFF, 0xEE], // Adobe JPEG
  ],
  'image/jpg': [
    [0xFF, 0xD8, 0xFF, 0xE0],
    [0xFF, 0xD8, 0xFF, 0xE1],
    [0xFF, 0xD8, 0xFF, 0xDB],
    [0xFF, 0xD8, 0xFF, 0xEE],
  ],
  'image/png': [
    [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], // PNG signature
  ],
  'application/pdf': [
    [0x25, 0x50, 0x44, 0x46], // %PDF
  ],
};

// ---------------------------------------------------------------------------
// Magic-byte validator
// ---------------------------------------------------------------------------

/**
 * Checks whether a file buffer's leading bytes match the expected magic bytes
 * for the given MIME type.
 *
 * @param {Buffer} buffer    - File content buffer.
 * @param {string} mimeType  - Declared MIME type (from Content-Type header).
 * @returns {boolean} True if the magic bytes match; false otherwise.
 */
function hasMagicBytes(buffer, mimeType) {
  const signatures = MAGIC_BYTES[mimeType];
  if (!signatures) return false;

  return signatures.some(sig =>
    sig.every((byte, i) => buffer[i] === byte)
  );
}

// ---------------------------------------------------------------------------
// Multer instance
// ---------------------------------------------------------------------------

/**
 * Multer instance configured with:
 *   - Memory storage (no temp files on disk)
 *   - 2 MB file size limit
 *   - MIME-type whitelist (Layer 2)
 *   - Extension whitelist (secondary check)
 */
const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1, // Only one file per request
    fields: 10, // Limit form fields
  },

  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();

    // Check MIME type
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new UploadError(
        `نوع الملف غير مسموح: ${file.mimetype} — المسموح به فقط: JPEG, PNG, PDF`
      ));
    }

    // Check extension
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return cb(new UploadError(
        `امتداد الملف غير مسموح: ${ext} — المسموح به فقط: .jpg, .jpeg, .png, .pdf`
      ));
    }

    cb(null, true);
  },
});

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

class UploadError extends Error {
  constructor(message) {
    super(message);
    this.name  = 'UploadError';
    this.statusCode = 422;
    this.code  = 'INVALID_FILE';
  }
}

// ---------------------------------------------------------------------------
// Magic-byte validation middleware (Layer 3 — post-multer)
// ---------------------------------------------------------------------------

/**
 * Express middleware that validates the actual file content using magic bytes.
 * MUST be placed AFTER the multer middleware in the chain.
 *
 * If no file was uploaded, this middleware is a no-op (passes through).
 * This allows optional file uploads on some routes.
 *
 * @param {import('express').Request}      req
 * @param {import('express').Response}     res
 * @param {import('express').NextFunction} next
 */
function validateMagicBytes(req, res, next) {
  if (!req.file) return next(); // No file uploaded — skip

  const { buffer, mimetype, originalname, size } = req.file;

  if (!buffer || buffer.length < 4) {
    return next(new UploadError('الملف المرفوع فارغ أو تالف'));
  }

  if (!hasMagicBytes(buffer, mimetype)) {
    logger.warn('[uploadMiddleware] ❌ محاولة رفع ملف بنوع مزوّر', {
      declaredMime: mimetype,
      filename: originalname,
      size,
      firstBytes: Array.from(buffer.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' '),
    });

    return next(new UploadError(
      `محتوى الملف لا يتطابق مع نوعه المُعلن (${mimetype}) — محاولة رفع ملف مشبوه مرفوضة`
    ));
  }

  // All checks passed — log for audit trail
  logger.debug('[uploadMiddleware] ✅ الملف اجتاز فحص Magic Bytes', {
    mimetype,
    size,
    originalname,
  });

  next();
}

// ---------------------------------------------------------------------------
// Multer error handler middleware
// ---------------------------------------------------------------------------

/**
 * Translates multer-specific errors into Arabic UploadError objects.
 * Must be placed AFTER the multer middleware in the chain.
 *
 * Usage:
 *   router.post('/upload',
 *     uploadSingle('receipt'),    // multer
 *     handleMulterErrors,         // translate multer errors
 *     validateMagicBytes,         // magic byte check
 *     controller
 *   );
 *
 * @param {Error}                        err
 * @param {import('express').Request}    req
 * @param {import('express').Response}   res
 * @param {import('express').NextFunction} next
 */
function handleMulterErrors(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new UploadError(
        `حجم الملف يتجاوز الحد المسموح (${MAX_FILE_SIZE_BYTES / 1024 / 1024} ميجابايت)`
      ));
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return next(new UploadError('يُسمح برفع ملف واحد فقط في كل طلب'));
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(new UploadError(`حقل الملف غير متوقع: ${err.field}`));
    }
    return next(new UploadError(`خطأ في رفع الملف: ${err.message}`));
  }

  if (err instanceof UploadError) {
    return next(err); // Already formatted — pass through
  }

  next(err); // Unknown error — let globalErrorHandler handle it
}

// ---------------------------------------------------------------------------
// Convenience middleware factories
// ---------------------------------------------------------------------------

/**
 * Creates a complete upload middleware chain for a single file field.
 * Returns an array of middleware functions ready for route registration.
 *
 * Usage:
 *   router.post('/deposit', ...uploadSingle('receipt'), controller);
 *
 * @param {string} fieldName - The multipart form field name for the file.
 * @returns {import('express').RequestHandler[]}
 */
function uploadSingle(fieldName) {
  return [
    upload.single(fieldName),
    handleMulterErrors,
    validateMagicBytes,
  ];
}

/**
 * Creates an upload middleware chain where the file is OPTIONAL.
 * If no file is provided, req.file is undefined and the chain continues.
 *
 * @param {string} fieldName
 * @returns {import('express').RequestHandler[]}
 */
function uploadOptional(fieldName) {
  return [
    upload.single(fieldName),
    handleMulterErrors,
    // validateMagicBytes already handles undefined req.file gracefully
    validateMagicBytes,
  ];
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Middleware chains
  uploadSingle,
  uploadOptional,

  // Individual middleware (for custom chains)
  upload,
  validateMagicBytes,
  handleMulterErrors,

  // Utilities (exported for unit testing)
  hasMagicBytes,
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,

  // Error class
  UploadError,
};
