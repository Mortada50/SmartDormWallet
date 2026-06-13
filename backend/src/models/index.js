/**
 * @file index.js
 * @description Models barrel file — single import point for all Mongoose models.
 *
 * Import pattern:
 *   const { User, Transaction, DepositRequest } = require('../models');
 *
 * Also re-exports all constants from model files so callers don't need
 * to import from individual model files:
 *   const { TRANSACTION_TYPES, DEPOSIT_STATUS, AUDIT_ACTIONS } = require('../models');
 *
 * ⚠️  IMPORTANT: Import this file AFTER calling db.connect() in server.js.
 *     Mongoose models are registered against the active connection.
 *
 * @module models
 */

'use strict';

// ── Models ───────────────────────────────────────────────────────────────────
const User = require('./User');
const Transaction = require('./Transaction');
const DepositRequest = require('./DepositRequest');
const WithdrawalRequest = require('./WithdrawalRequest');
const Expense = require('./Expense');
const Merchant = require('./Merchant');
const MerchantTransaction = require('./MerchantTransaction');
const AuditLog = require('./AuditLog');
const Notification = require('./Notification');
const Setting = require('./Setting');
const TokenBlacklist = require('./TokenBlacklist');
const DeputyAssignment = require('./DeputyAssignment');
const BalanceSnapshot = require('./BalanceSnapshot');

// ── Constants re-exports ──────────────────────────────────────────────────────
const { TRANSACTION_TYPES, CREDIT_TYPES, DEBIT_TYPES, REFERENCE_TYPES, SUPPORTED_CURRENCIES } = require('./Transaction');
const { DEPOSIT_STATUS } = require('./DepositRequest');
const { WITHDRAWAL_STATUS, FEE_TYPES } = require('./WithdrawalRequest');
const { DISPUTE_STATUS } = require('./Expense');
const { MERCHANT_STATUS } = require('./Merchant');
const { MERCHANT_TRANSACTION_TYPES } = require('./MerchantTransaction');
const { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, ACTOR_ROLES } = require('./AuditLog');
const { NOTIFICATION_TYPES } = require('./Notification');
const { BLACKLIST_REASONS } = require('./TokenBlacklist');

module.exports = {
  // ── Models ─────────────────────────────────────────────────────────────────
  User,
  Transaction,
  DepositRequest,
  WithdrawalRequest,
  Expense,
  Merchant,
  MerchantTransaction,
  AuditLog,
  Notification,
  Setting,
  TokenBlacklist,
  DeputyAssignment,
  BalanceSnapshot,

  // ── Transaction constants ───────────────────────────────────────────────────
  TRANSACTION_TYPES,
  CREDIT_TYPES,
  DEBIT_TYPES,
  REFERENCE_TYPES,
  SUPPORTED_CURRENCIES,

  // ── Status & type enums ─────────────────────────────────────────────────────
  DEPOSIT_STATUS,
  WITHDRAWAL_STATUS,
  FEE_TYPES,
  DISPUTE_STATUS,
  MERCHANT_STATUS,
  MERCHANT_TRANSACTION_TYPES,

  // ── Audit log constants ─────────────────────────────────────────────────────
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  ACTOR_ROLES,

  // ── Notification constants ──────────────────────────────────────────────────
  NOTIFICATION_TYPES,

  // ── Security constants ──────────────────────────────────────────────────────
  BLACKLIST_REASONS,
};
