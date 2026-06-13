/**
 * @file merchantService.js
 * @description Merchant management and merchant financial operations.
 *
 * ██████████████████████████████████████████████████████████████████████████
 * ██  ARCHITECTURE OVERVIEW                                               ██
 * ██████████████████████████████████████████████████████████████████████████
 *
 * FLOW — recordPurchase:
 *   1. Validate input (merchant exists and is active, totalAmount > 0)
 *   2. Validate users (all exist and are active)
 *   3. Deduplicate invoiceReference if provided
 *   4. Split totalAmount across users using integerMath.splitExpense()
 *   5. Pre-flight debt check (same policy as expenseService)
 *   6. Within a single MongoDB session (atomic):
 *      a. Create N × MERCHANT_PURCHASE ledger entries via ledgerService
 *      b. Create MerchantTransaction doc (type='purchase') with userShares refs
 *   7. Post-commit (outside session, non-blocking):
 *      a. Invalidate balance caches for all affected users
 *      b. Create N × MERCHANT_PURCHASE_ADDED notifications
 *      c. Create audit log entry
 *
 * FLOW — recordSettlement:
 *   1. Validate input (merchant exists, amount > 0)
 *   2. SETTLEMENT GUARD: compute outstanding balance and assert amount ≤ balance
 *   3. Within a single MongoDB session (atomic):
 *      a. Create MerchantTransaction doc (type='settlement') — NO user ledger entries
 *   4. Post-commit: audit log
 *
 * OUTSTANDING BALANCE PRINCIPLE (spec §10):
 *   Merchant balance is NEVER stored on the Merchant document.
 *   It is ALWAYS computed fresh: SUM(purchases) - SUM(settlements).
 *
 * SETTLEMENT GUARD (spec §10):
 *   settlement.amount MUST be ≤ outstanding balance before write.
 *   Enforced in this service layer, NOT in the model.
 *
 * DUPLICATE INVOICE (spec §10):
 *   invoiceReference is optional. When provided, it must be unique per merchant.
 *   Application-level pre-check provides clear error messages.
 *   DB-level compound index { merchantId, invoiceReference } is the final guard.
 *
 * IMMUTABLE LEDGER:
 *   All financial write operations go through ledgerService.
 *   No direct Transaction inserts allowed from this service.
 *
 * SPEC REFERENCES: §10 (Merchant System), §5 (Rounding), §9 (Debt Management)
 *
 * @module services/merchantService
 */

'use strict';

const mongoose = require('mongoose');

const {
  TRANSACTION_TYPES,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  NOTIFICATION_TYPES,
  MERCHANT_TRANSACTION_TYPES,
  MERCHANT_STATUS,
} = require('../models');

const merchantRepository = require('../repositories/merchantRepository');
const merchantTransactionRepository = require('../repositories/merchantTransactionRepository');
const userRepository = require('../repositories/userRepository');
const ledgerService = require('./ledgerService');
const settingService = require('./settingService');
const auditLogRepository = require('../repositories/auditLogRepository');
const notificationRepository = require('../repositories/notificationRepository');
const { db } = require('../config');
const { splitExpense, assertPositiveInteger } = require('../utils/integerMath');
const { cacheDel, CacheKeys } = require('../config/redis');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * General merchant operation error (validation, guard failures, not-found, etc.).
 */
class MerchantError extends Error {
  /**
   * @param {string} message
   * @param {number} [statusCode=422]
   */
  constructor(message, statusCode = 422) {
    super(message);
    this.name = 'MerchantError';
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Performs a pre-flight debt check for all users affected by a merchant purchase.
 * Mirrors the same logic used in expenseService to ensure consistency.
 *
 * Throws if:
 *   - allowDebt=false and any user's projected balance < 0
 *   - maxDebtPerUser > 0 and any user would exceed it
 *
 * @param {Array<{ userId, userPublicId, userName, shareAmount }>} usersWithShares
 * @param {object} settings - System settings (allowDebt, maxDebtPerUser).
 * @returns {Promise<void>}
 * @throws {MerchantError} On debt policy violation.
 */
async function preFlightDebtCheck(usersWithShares, settings) {
  const { allowDebt, maxDebtPerUser } = settings;

  const balanceResults = await Promise.all(
    usersWithShares.map(async (u) => {
      const state = await ledgerService.calculateBalance(
        u.userId,
        u.userPublicId,
        { bypassCache: false } // use cache for speed — this is pre-flight
      );
      return { ...u, ...state };
    })
  );

  const balanceViolations = [];
  const debtLimitViolations = [];

  for (const user of balanceResults) {
    const { balance, shareAmount, userPublicId, userName } = user;
    const projectedBalance = balance - shareAmount;

    // Check 1: allowDebt = false → any negative projected balance is blocked
    if (!allowDebt && projectedBalance < 0) {
      balanceViolations.push({ userPublicId, userName, balance, shareAmount, projectedBalance });
      continue;
    }

    // Check 2: maxDebtPerUser limit (0 = unlimited)
    if (allowDebt && maxDebtPerUser > 0) {
      // projectedDebt = max(0, -projectedBalance)
      const projectedDebt = projectedBalance < 0 ? -projectedBalance : 0;
      if (projectedDebt > maxDebtPerUser) {
        debtLimitViolations.push({
          userPublicId,
          userName,
          projectedDebt,
          limit: maxDebtPerUser,
        });
      }
    }
  }

  if (balanceViolations.length > 0) {
    throw new MerchantError(
      'بعض المستخدمين ليس لديهم رصيد كافٍ والنظام لا يسمح بالدين'
    );
  }

  if (debtLimitViolations.length > 0) {
    throw new MerchantError(
      `${debtLimitViolations.length} مستخدم(ين) سيتجاوزون الحد الأقصى للدين عند إضافة هذا الشراء`
    );
  }
}

// ---------------------------------------------------------------------------
// 1. createMerchant
// ---------------------------------------------------------------------------

/**
 * Creates a new merchant profile.
 *
 * Runs within its own MongoDB session to ensure atomicity.
 * Writes an audit log entry after the session commits (fire-and-forget).
 *
 * @param {object}                  data
 * @param {string}                  data.name                 - Merchant display name.
 * @param {string}                  [data.phone]              - Optional phone number.
 * @param {string}                  [data.notes]              - Optional notes.
 * @param {mongoose.Types.ObjectId} data.createdBy            - Admin ObjectId.
 * @param {string}                  data.createdByPublicId    - Admin publicId.
 *
 * @param {object}                  actor
 * @param {mongoose.Types.ObjectId} actor.id                  - Actor ObjectId.
 * @param {string}                  actor.publicId
 * @param {'admin'|'deputy'}        actor.role
 * @param {string}                  actor.name
 *
 * @returns {Promise<object>} The created merchant (plain object).
 * @throws {MerchantError} On validation failure.
 */
async function createMerchant(data, actor) {
  if (!data.name || typeof data.name !== 'string' || !data.name.trim()) {
    throw new MerchantError('اسم التاجر مطلوب');
  }

  const session = await db.startSession();
  let merchant;

  try {
    await session.withTransaction(async () => {
      merchant = await merchantRepository.createOne(
        {
          name: data.name.trim(),
          phone: data.phone?.trim() || null,
          notes: data.notes?.trim() || null,
          status: MERCHANT_STATUS.ACTIVE,
          createdBy: actor.id,
          createdByPublicId: actor.publicId,
        },
        session
      );
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority', j: true },
    });
  } finally {
    await session.endSession();
  }

  logger.info('[merchantService] ✅ تم إنشاء تاجر', {
    merchantPublicId: merchant.publicId,
    name: merchant.name,
  });

  // Post-commit audit log (fire-and-forget)
  auditLogRepository.createLog({
    actorId: actor.id,
    actorPublicId: actor.publicId,
    actorRole: actor.role,
    actorName: actor.name,
    action: AUDIT_ACTIONS.MERCHANT_CREATED,
    entityType: AUDIT_ENTITY_TYPES.MERCHANT,
    entityPublicId: merchant.publicId,
    metadata: { merchantName: merchant.name },
  }).catch(err => {
    logger.warn('[merchantService] فشل تسجيل audit log لإنشاء تاجر', { error: err.message });
  });

  return merchant;
}

// ---------------------------------------------------------------------------
// 2. recordPurchase
// ---------------------------------------------------------------------------

/**
 * Records a merchant purchase, splits the cost among users, and creates
 * ledger entries for each affected user.
 *
 * ATOMIC (inside a MongoDB session, or uses provided externalSession):
 *   - N × MERCHANT_PURCHASE Transaction documents
 *   - 1 × MerchantTransaction document (type='purchase') with userShares
 *
 * POST-COMMIT (non-blocking, does NOT affect atomicity):
 *   - Cache invalidation for all affected users
 *   - N × MERCHANT_PURCHASE_ADDED notifications
 *   - Audit log entry
 *
 * @param {object}                  purchaseData
 * @param {string}                  purchaseData.merchantPublicId
 * @param {number}                  purchaseData.totalAmount          - Positive integer YER.
 * @param {string}                  [purchaseData.description]
 * @param {string}                  [purchaseData.invoiceReference]   - Optional; must be unique per merchant.
 * @param {string[]}                purchaseData.userPublicIds         - UUIDs of affected users.
 * @param {string}                  [purchaseData.receiptImagePublicId]
 * @param {mongoose.Types.ObjectId} purchaseData.performedBy
 * @param {string}                  purchaseData.performedByPublicId
 * @param {'admin'|'deputy'}        purchaseData.performedByRole
 * @param {string}                  purchaseData.performedByName
 *
 * @param {mongoose.ClientSession}  [externalSession] - Use caller's session if provided.
 * @returns {Promise<{ merchantTransaction: object, userResults: Array<{ user, tx, shareAmount }> }>}
 * @throws {MerchantError} On validation or guard failure.
 */
async function recordPurchase(purchaseData, externalSession = null) {
  const {
    merchantPublicId,
    totalAmount,
    description = null,
    invoiceReference = null,
    userPublicIds,
    receiptImagePublicId = null,
    performedBy,
    performedByPublicId,
    performedByRole,
    performedByName,
  } = purchaseData;

  // ── Input validation ───────────────────────────────────────────────────────
  assertPositiveInteger(totalAmount, 'إجمالي مبلغ الشراء');

  if (!Array.isArray(userPublicIds) || userPublicIds.length === 0) {
    throw new MerchantError('يجب اختيار مستخدم واحد على الأقل');
  }

  // ── Load and validate merchant ─────────────────────────────────────────────
  const merchant = await merchantRepository.findByPublicId(merchantPublicId);
  if (!merchant) {
    throw new MerchantError('التاجر غير موجود', 404);
  }
  if (merchant.status !== MERCHANT_STATUS.ACTIVE) {
    throw new MerchantError('لا يمكن إضافة شراء لتاجر غير نشط');
  }

  // ── Duplicate invoice check ────────────────────────────────────────────────
  if (invoiceReference) {
    const duplicate = await merchantTransactionRepository.findDuplicateInvoice(
      merchant._id,
      invoiceReference.trim()
    );
    if (duplicate) {
      throw new MerchantError(
        `رقم الفاتورة "${invoiceReference}" مسجل مسبقاً لهذا التاجر`
      );
    }
  }

  // ── Load and validate users ────────────────────────────────────────────────
  const uniqueUserPublicIds = [...new Set(userPublicIds)];
  const users = await userRepository.findManyByPublicIds(uniqueUserPublicIds);

  if (users.length !== uniqueUserPublicIds.length) {
    const foundIds = new Set(users.map(u => u.publicId));
    const missing = uniqueUserPublicIds.filter(id => !foundIds.has(id));
    throw new MerchantError(
      `بعض المستخدمين غير موجودين أو غير نشطين: ${missing.join(', ')}`
    );
  }

  // Hydrate with internal ObjectIds required for ledger entries
  const { User } = require('../models');
  const usersWithIds = await Promise.all(
    users.map(async (u) => {
      const full = await User
        .findOne({ publicId: u.publicId })
        .select('_id publicId fullName')
        .lean();
      return {
        userId: full._id,
        userPublicId: full.publicId,
        userName: full.fullName,
      };
    })
  );

  // ── Calculate per-user shares ──────────────────────────────────────────────
  const shares = splitExpense(totalAmount, usersWithIds.length);
  const usersWithShares = usersWithIds.map((u, i) => ({ ...u, shareAmount: shares[i] }));

  // ── System settings + pre-flight debt check ────────────────────────────────
  const settings = await settingService.getSettings();
  await preFlightDebtCheck(usersWithShares, settings);

  // ── Atomic DB operations ───────────────────────────────────────────────────
  const useExternalSession = !!externalSession;
  const session = externalSession || (await db.startSession());

  let merchantTxDoc;
  let userResults;

  try {
    const executeOps = async () => {
      // Step A: Create N × MERCHANT_PURCHASE ledger entries via ledgerService
      userResults = await Promise.all(
        usersWithShares.map(async (u) => {
          const txData = ledgerService.buildTransactionData({
            type: TRANSACTION_TYPES.MERCHANT_PURCHASE,
            amount: u.shareAmount,
            userId: u.userId,
            userPublicId: u.userPublicId,
            performedBy,
            performedByPublicId,
            performedByRole,
            description: description
              ? `شراء من ${merchant.name}: ${description}`
              : `شراء من ${merchant.name}`,
            referencePublicId: merchantPublicId,
            referenceType: 'merchantTransaction',
            metadata: {
              merchantName: merchant.name,
              merchantPublicId,
              totalAmount,
              totalUsers: usersWithShares.length,
              shareAmount: u.shareAmount,
              invoiceReference: invoiceReference || null,
            },
          });

          const tx = await ledgerService.recordTransaction(txData, session);
          return { user: u, tx, shareAmount: u.shareAmount };
        })
      );

      // Step B: Build userShares array with transaction references
      const userShares = userResults.map(({ user, tx, shareAmount }) => ({
        userId: user.userId,
        userPublicId: user.userPublicId,
        userName: user.userName,
        shareAmount,
        transactionId: tx._id || new mongoose.Types.ObjectId(tx.id),
        transactionPublicId: tx.publicId,
      }));

      // Step C: Create MerchantTransaction document (type='purchase')
      merchantTxDoc = await merchantTransactionRepository.createOne(
        {
          merchantId: merchant._id,
          merchantPublicId: merchant.publicId,
          merchantName: merchant.name,
          type: MERCHANT_TRANSACTION_TYPES.PURCHASE,
          amount: totalAmount,
          currency: 'YER',
          description: description?.trim() || null,
          invoiceReference: invoiceReference?.trim() || null,
          userShares,
          receiptImagePublicId: receiptImagePublicId || null,
          performedBy,
          performedByPublicId,
        },
        session
      );
    };

    if (useExternalSession) {
      await executeOps();
    } else {
      await session.withTransaction(executeOps, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority', j: true },
      });
    }
  } finally {
    if (!useExternalSession) {
      await session.endSession();
    }
  }

  logger.info('[merchantService] ✅ تم تسجيل شراء من تاجر', {
    merchantTransactionPublicId: merchantTxDoc.publicId,
    merchantPublicId,
    totalAmount,
    usersCount: usersWithIds.length,
  });

  // ── Post-commit side effects (non-blocking) ────────────────────────────────

  // 1. Invalidate balance caches for all affected users
  await Promise.allSettled(
    usersWithIds.map(u => cacheDel(CacheKeys.userBalance(u.userPublicId)))
  );

  // 2. Send in-app notifications to all affected users
  const notifications = usersWithShares.map(u => ({
    userId: u.userId,
    userPublicId: u.userPublicId,
    type: NOTIFICATION_TYPES.MERCHANT_PURCHASE_ADDED,
    message: `تم تسجيل شراء من ${merchant.name} بمبلغ ${u.shareAmount.toLocaleString('ar-YE')} ريال`,
    relatedEntityPublicId: merchantTxDoc.publicId,
    relatedEntityType: 'merchantTransaction',
  }));

  notificationRepository.createMany(notifications).catch(err => {
    logger.warn('[merchantService] فشل إرسال إشعارات الشراء', { error: err.message });
  });

  // 3. Audit log
  auditLogRepository.createLog({
    actorId: performedBy,
    actorPublicId: performedByPublicId,
    actorRole: performedByRole,
    actorName: performedByName,
    action: AUDIT_ACTIONS.MERCHANT_PURCHASE_RECORDED,
    entityType: AUDIT_ENTITY_TYPES.MERCHANT_TRANSACTION,
    entityPublicId: merchantTxDoc.publicId,
    metadata: {
      merchantPublicId,
      merchantName: merchant.name,
      totalAmount,
      invoiceReference: invoiceReference || null,
      affectedUsers: usersWithShares.map(u => ({
        publicId: u.userPublicId,
        name: u.userName,
        share: u.shareAmount,
      })),
    },
  }).catch(err => {
    logger.warn('[merchantService] فشل تسجيل audit log للشراء', { error: err.message });
  });

  return { merchantTransaction: merchantTxDoc, userResults };
}

// ---------------------------------------------------------------------------
// 3. recordSettlement
// ---------------------------------------------------------------------------

/**
 * Records a settlement payment to a merchant.
 *
 * SETTLEMENT GUARD: settlement amount MUST be ≤ outstanding balance.
 * NO user ledger entries are created — this is between the org and the merchant.
 *
 * ATOMIC (inside a MongoDB session, or uses provided externalSession):
 *   - 1 × MerchantTransaction document (type='settlement')
 *
 * @param {object}                  settlementData
 * @param {string}                  settlementData.merchantPublicId
 * @param {number}                  settlementData.amount              - Positive integer YER.
 * @param {string}                  [settlementData.settlementNotes]
 * @param {string}                  [settlementData.receiptImagePublicId]
 * @param {mongoose.Types.ObjectId} settlementData.performedBy
 * @param {string}                  settlementData.performedByPublicId
 * @param {'admin'|'deputy'}        settlementData.performedByRole
 * @param {string}                  settlementData.performedByName
 *
 * @param {mongoose.ClientSession}  [externalSession] - Use caller's session if provided.
 * @returns {Promise<{ merchantTransaction: object, outstandingBalance: number }>}
 * @throws {MerchantError} If settlement amount exceeds outstanding balance.
 */
async function recordSettlement(settlementData, externalSession = null) {
  const {
    merchantPublicId,
    amount,
    settlementNotes = null,
    receiptImagePublicId = null,
    performedBy,
    performedByPublicId,
    performedByRole,
    performedByName,
  } = settlementData;

  // ── Input validation ───────────────────────────────────────────────────────
  assertPositiveInteger(amount, 'مبلغ التسوية');

  // ── Load and validate merchant ─────────────────────────────────────────────
  const merchant = await merchantRepository.findByPublicId(merchantPublicId);
  if (!merchant) {
    throw new MerchantError('التاجر غير موجود', 404);
  }

  // ── SETTLEMENT GUARD: amount ≤ outstanding balance ────────────────────────
  const outstandingBalance = await merchantRepository.aggregateOutstandingBalance(merchant._id);

  if (amount > outstandingBalance) {
    throw new MerchantError(
      `مبلغ التسوية (${amount.toLocaleString('ar-YE')} ريال) يتجاوز الرصيد المستحق ` +
      `(${outstandingBalance.toLocaleString('ar-YE')} ريال)`
    );
  }

  // ── Atomic DB operation ────────────────────────────────────────────────────
  const useExternalSession = !!externalSession;
  const session = externalSession || (await db.startSession());

  let merchantTxDoc;

  try {
    const executeOps = async () => {
      merchantTxDoc = await merchantTransactionRepository.createOne(
        {
          merchantId: merchant._id,
          merchantPublicId: merchant.publicId,
          merchantName: merchant.name,
          type: MERCHANT_TRANSACTION_TYPES.SETTLEMENT,
          amount,
          currency: 'YER',
          settlementNotes: settlementNotes?.trim() || null,
          receiptImagePublicId: receiptImagePublicId || null,
          userShares: [], // settlements have no user shares
          performedBy,
          performedByPublicId,
        },
        session
      );
    };

    if (useExternalSession) {
      await executeOps();
    } else {
      await session.withTransaction(executeOps, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority', j: true },
      });
    }
  } finally {
    if (!useExternalSession) {
      await session.endSession();
    }
  }

  logger.info('[merchantService] ✅ تم تسجيل تسوية مع تاجر', {
    merchantTransactionPublicId: merchantTxDoc.publicId,
    merchantPublicId,
    amount,
    remainingBalance: outstandingBalance - amount,
  });

  // Post-commit audit log (fire-and-forget)
  auditLogRepository.createLog({
    actorId: performedBy,
    actorPublicId: performedByPublicId,
    actorRole: performedByRole,
    actorName: performedByName,
    action: AUDIT_ACTIONS.MERCHANT_SETTLEMENT_RECORDED,
    entityType: AUDIT_ENTITY_TYPES.MERCHANT_TRANSACTION,
    entityPublicId: merchantTxDoc.publicId,
    metadata: {
      merchantPublicId,
      merchantName: merchant.name,
      amount,
      outstandingBalanceBefore: outstandingBalance,
      outstandingBalanceAfter: outstandingBalance - amount,
    },
  }).catch(err => {
    logger.warn('[merchantService] فشل تسجيل audit log للتسوية', { error: err.message });
  });

  return { merchantTransaction: merchantTxDoc, outstandingBalance: outstandingBalance - amount };
}

// ---------------------------------------------------------------------------
// 4. getMerchantBalance
// ---------------------------------------------------------------------------

/**
 * Returns the outstanding balance owed to a merchant.
 *
 * ALWAYS computed from transactions — never read from a stored field.
 * Formula: SUM(purchase.amount) - SUM(settlement.amount)
 *
 * @param {string} merchantPublicId - Public UUID of the merchant.
 * @returns {Promise<{ merchantPublicId: string, outstandingBalance: number, merchant: object }>}
 * @throws {MerchantError} If merchant is not found.
 */
async function getMerchantBalance(merchantPublicId) {
  const merchant = await merchantRepository.findByPublicId(merchantPublicId);
  if (!merchant) {
    throw new MerchantError('التاجر غير موجود', 404);
  }

  const balances = await merchantRepository.aggregateBalances(merchant._id);

  return { merchantPublicId, ...balances, merchant };
}

// ---------------------------------------------------------------------------
// 5. disableMerchant
// ---------------------------------------------------------------------------

/**
 * Disables a merchant, preventing new purchases.
 *
 * @param {string}  merchantPublicId
 * @param {object}  actor
 * @param {mongoose.Types.ObjectId} actor.id
 * @param {string}  actor.publicId
 * @param {'admin'|'deputy'} actor.role
 * @param {string}  actor.name
 * @returns {Promise<object>} Updated merchant document.
 * @throws {MerchantError} If merchant not found or already disabled.
 */
async function disableMerchant(merchantPublicId, actor) {
  const merchant = await merchantRepository.findByPublicId(merchantPublicId);
  if (!merchant) {
    throw new MerchantError('التاجر غير موجود', 404);
  }
  if (merchant.status === MERCHANT_STATUS.DISABLED) {
    throw new MerchantError('التاجر معطل بالفعل');
  }

  const updated = await merchantRepository.setStatus(merchantPublicId, MERCHANT_STATUS.DISABLED);

  logger.info('[merchantService] ✅ تم تعطيل تاجر', { merchantPublicId });

  // Audit log (fire-and-forget)
  auditLogRepository.createLog({
    actorId: actor.id,
    actorPublicId: actor.publicId,
    actorRole: actor.role,
    actorName: actor.name,
    action: AUDIT_ACTIONS.MERCHANT_UPDATED,
    entityType: AUDIT_ENTITY_TYPES.MERCHANT,
    entityPublicId: merchantPublicId,
    metadata: { merchantName: merchant.name },
  }).catch(err => {
    logger.warn('[merchantService] فشل تسجيل audit log لتعطيل تاجر', { error: err.message });
  });

  return updated;
}

// ---------------------------------------------------------------------------
// 6. getMerchants / getMerchantById
// ---------------------------------------------------------------------------

/**
 * Returns a paginated list of merchants with optional filters.
 *
 * @param {object} [filters={}]
 * @param {number} [filters.page=1]
 * @param {number} [filters.limit=20]
 * @param {string} [filters.status]  - 'active' | 'disabled'
 * @param {string} [filters.search]  - Searches merchant name.
 * @returns {Promise<{ merchants: object[], total: number, page: number, totalPages: number }>}
 */
async function getMerchants(filters = {}) {
  const result = await merchantRepository.findAllPaginated(filters);
  
  // Attach outstanding balance to each merchant
  const merchantsWithBalance = await Promise.all(
    result.merchants.map(async (merchant) => {
      const balances = await merchantRepository.aggregateBalances(merchant._id);
      return { ...merchant, ...balances };
    })
  );
  
  return { ...result, merchants: merchantsWithBalance };
}

/**
 * Returns a single merchant by its publicId.
 *
 * @param {string} publicId
 * @returns {Promise<object>} Lean merchant document.
 * @throws {MerchantError} If merchant not found.
 */
async function getMerchantById(publicId) {
  const merchant = await merchantRepository.findByPublicId(publicId);
  if (!merchant) {
    throw new MerchantError('التاجر غير موجود', 404);
  }
  return merchant;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  MerchantError,
  createMerchant,
  recordPurchase,
  recordSettlement,
  getMerchantBalance,
  disableMerchant,
  getMerchants,
  getMerchantById,
};
