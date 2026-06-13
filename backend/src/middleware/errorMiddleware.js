/**
 * @file errorMiddleware.js
 * @description Global error handler and request validation utilities.
 *
 * PRINCIPLES:
 *  - Never expose internal error details (stack traces, DB errors) to clients.
 *  - Log full error internally with Winston; send sanitized Arabic message to client.
 *  - All error responses follow the standard shape:
 *      { success: false, code: string, message: string, details?: object }
 *  - HTTP status codes are inferred from error class / known error types.
 *
 * @module middleware/errorMiddleware
 */

'use strict';

const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Standard error response builder
// ---------------------------------------------------------------------------

/**
 * Sends a standardised JSON error response.
 *
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} code     - Machine-readable error code (SCREAMING_SNAKE_CASE)
 * @param {string} message  - Human-readable Arabic message
 * @param {object} [details] - Optional structured details (e.g. validation errors)
 */
function sendError(res, status, code, message, details = undefined) {
  const body = { success: false, code, message };
  if (details) body.details = details;
  return res.status(status).json(body);
}

// ---------------------------------------------------------------------------
// 404 handler — must be registered AFTER all routes
// ---------------------------------------------------------------------------

/**
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
function notFoundHandler(req, res) {
  return sendError(res, 404, 'NOT_FOUND', `المسار غير موجود: ${req.method} ${req.path}`);
}

// ---------------------------------------------------------------------------
// Global error handler — must be registered LAST (4-argument form)
// ---------------------------------------------------------------------------

/**
 * Express global error handler.
 * Converts known error types to appropriate HTTP responses.
 *
 * Known error types:
 *   - AuthError               (authService)      → 401/403
 *   - ExpenseValidationError  (expenseService)   → 422
 *   - DebtLimitExceededError  (expenseService)   → 422
 *   - DisputeError            (expenseService)   → 404/422/403
 *   - MerchantError           (merchantService)  → 422/404
 *   - Mongoose ValidationError                   → 422
 *   - Mongoose CastError                         → 400
 *   - MongoServerError 11000 (duplicate key)     → 409
 *   - Generic Error                              → 500
 *
 * @param {Error}                        err
 * @param {import('express').Request}    req
 * @param {import('express').Response}   res
 * @param {import('express').NextFunction} next
 */
function globalErrorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  // Log full error internally
  const logLevel = err.statusCode && err.statusCode < 500 ? 'warn' : 'error';
  logger[logLevel]('[errorMiddleware] خطأ في الطلب', {
    name: err.name,
    message: err.message,
    code: err.code,
    statusCode: err.statusCode,
    path: req.path,
    method: req.method,
    stack: logLevel === 'error' ? err.stack : undefined,
  });

  // ── Known application error classes ───────────────────────────────────────

  // Auth errors (AuthError from authService)
  if (err.name === 'AuthError') {
    return sendError(res, err.statusCode || 401, err.code || 'AUTH_ERROR', err.message);
  }

  // Expense validation errors
  if (err.name === 'ExpenseValidationError') {
    return sendError(res, 422, 'EXPENSE_VALIDATION_ERROR', err.message, err.details);
  }

  if (err.name === 'DebtLimitExceededError') {
    return sendError(res, 422, 'DEBT_LIMIT_EXCEEDED', err.message, {
      affectedUsers: err.affectedUsers,
    });
  }

  if (err.name === 'DisputeError') {
    return sendError(res, err.statusCode || 422, 'DISPUTE_ERROR', err.message);
  }

  if (err.name === 'MerchantError') {
    return sendError(res, err.statusCode || 422, 'MERCHANT_ERROR', err.message);
  }

  // Upload / attachment errors (uploadMiddleware, attachmentService)
  if (err.name === 'UploadError') {
    return sendError(res, err.statusCode || 422, err.code || 'INVALID_FILE', err.message);
  }

  if (err.name === 'AttachmentError') {
    return sendError(res, err.statusCode || 502, err.code || 'ATTACHMENT_ERROR', err.message);
  }

  // ── Mongoose errors ───────────────────────────────────────────────────────

  if (err.name === 'ValidationError') {
    const details = Object.fromEntries(
      Object.entries(err.errors).map(([field, e]) => [field, e.message])
    );
    return sendError(res, 422, 'VALIDATION_ERROR', 'بيانات غير صحيحة', details);
  }

  if (err.name === 'CastError') {
    return sendError(res, 400, 'INVALID_ID', `معرّف غير صحيح: ${err.value}`);
  }

  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0] || 'unknown';
    return sendError(res, 409, 'DUPLICATE_KEY', `القيمة مُستخدمة مسبقاً للحقل: ${field}`);
  }

  // ── Generic / unexpected errors ───────────────────────────────────────────
  // Never expose internal details to client
  return sendError(
    res,
    err.statusCode || 500,
    'INTERNAL_SERVER_ERROR',
    'حدث خطأ داخلي — يرجى المحاولة مرة أخرى لاحقاً'
  );
}

// ---------------------------------------------------------------------------
// Async wrapper — eliminates try/catch boilerplate in every controller
// ---------------------------------------------------------------------------

/**
 * Wraps an async Express route handler to forward errors to globalErrorHandler.
 * Usage: router.get('/path', asyncHandler(async (req, res) => { ... }))
 *
 * @param {Function} fn - Async route handler
 * @returns {import('express').RequestHandler}
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ---------------------------------------------------------------------------
// Request validation helper
// ---------------------------------------------------------------------------

/**
 * Validates that required fields are present on req.body.
 * Throws a structured error if any are missing.
 *
 * @param {import('express').Request} req
 * @param {string[]} requiredFields
 * @throws {Error} With statusCode 400 and MISSING_FIELDS code
 */
function requireFields(req, requiredFields) {
  const missing = requiredFields.filter(f => {
    const val = req.body[f];
    return val === undefined || val === null || val === '';
  });

  if (missing.length > 0) {
    const err = new Error(`الحقول التالية مطلوبة: ${missing.join(', ')}`);
    err.statusCode = 400;
    err.code = 'MISSING_FIELDS';
    err.details = { missing };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  sendError,
  notFoundHandler,
  globalErrorHandler,
  asyncHandler,
  requireFields,
};
