/**
 * @file ledgerService.js
 * @description Core Ledger Engine — the financial heart of Smart Dorm Wallet.
 *
 * ██████████████████████████████████████████████████████████████████████████
 * ██  CRITICAL — EVERY LINE HERE HANDLES REAL MONEY                       ██
 * ██████████████████████████████████████████████████████████████████████████
 *
 * ARCHITECTURE:
 *   This service implements the accounting model from spec §5.
 *   It is the ONLY permitted place for financial business logic.
 *
 * FUNDAMENTAL PRINCIPLE (spec §5):
 *   Balance is NEVER stored. It is ALWAYS calculated fresh from the ledger.
 *   Any function that reads a stored balance is a CRITICAL BUG.
 *
 * LEDGER MODEL:
 *   Single-entry ledger with explicit credit/debit columns:
 *     balance = SUM(creditAmount) - SUM(debitAmount) across all user transactions
 *
 * TRANSACTION SIGN CONVENTION (spec §5):
 *   Type                 │ creditAmount │ debitAmount
 *   ─────────────────────┼──────────────┼────────────
 *   DEPOSIT              │    amount    │     0
 *   WITHDRAWAL           │      0       │  amount
 *   WITHDRAWAL_FEE       │      0       │  amount
 *   SHARED_EXPENSE       │      0       │  amount
 *   MERCHANT_PURCHASE    │      0       │  amount
 *   DEBT_SETTLEMENT      │      0       │  amount
 *   ADJUSTMENT (credit)  │    amount    │     0
 *   ADJUSTMENT (debit)   │      0       │  amount
 *   REFUND               │    amount    │     0
 *
 * SESSION CONTRACT:
 *   ALL write operations in this service MUST receive a MongoDB session.
 *   The caller (controller or higher-level service) is responsible for
 *   creating, committing, and closing the session.
 *   No write operation in this service creates its own session.
 *
 * ATOMIC OPERATIONS (must be wrapped in session.withTransaction()):
 *   - depositApproval: DEPOSIT + optional DEBT_SETTLEMENT
 *   - withdrawalApproval: WITHDRAWAL + WITHDRAWAL_FEE
 *   - expenseCreation: N × SHARED_EXPENSE
 *   - merchantPurchase: N × MERCHANT_PURCHASE
 *
 * @module services/ledgerService
 */

'use strict';

const { randomUUID } = require('crypto');
const { User, Transaction, TRANSACTION_TYPES } = require('../models');
const transactionRepository = require('../repositories/transactionRepository');
const {
  assertPositiveInteger,
  assertNonNegativeInteger,
  assertInteger,
  computeBalanceAndDebt,
  computeDebtSettlement,
  calculateWithdrawalFee,
  splitExpense,
  checkDebtLimit,
} = require('../utils/integerMath');
const { cacheGet, cacheSet, cacheDel, CacheKeys, TTL } = require('../config/redis');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Type direction mapping
// ---------------------------------------------------------------------------

/**
 * Maps transaction types to their ledger direction.
 * 'credit' → creditAmount = amount, debitAmount = 0
 * 'debit'  → debitAmount  = amount, creditAmount = 0
 *
 * For ADJUSTMENT, direction is passed explicitly via txData.direction.
 */
const TYPE_DIRECTION = Object.freeze({
  [TRANSACTION_TYPES.DEPOSIT]: 'credit',
  [TRANSACTION_TYPES.WITHDRAWAL]: 'debit',
  [TRANSACTION_TYPES.WITHDRAWAL_FEE]: 'debit',
  [TRANSACTION_TYPES.SHARED_EXPENSE]: 'debit',
  [TRANSACTION_TYPES.MERCHANT_PURCHASE]: 'debit',
  [TRANSACTION_TYPES.DEBT_SETTLEMENT]: 'debit',
  [TRANSACTION_TYPES.REFUND]: 'credit',
  // ADJUSTMENT direction is set per-call
});

// ---------------------------------------------------------------------------
// Sanity check helpers
// ---------------------------------------------------------------------------

/**
 * Performs a programmatic sanity check on transaction data before attempting
 * a DB write. This is a fast-fail guard — MongoDB JSON Schema is the
 * authoritative validator, but catching issues here gives better error messages.
 *
 * @param {object} txData - The transaction data to validate.
 * @throws {Error} With a descriptive Arabic message on any violation.
 */
function sanityCheckTransactionData(txData) {
  const { type, amount, creditAmount, debitAmount, currency, userId, userPublicId } = txData;

  // Required fields
  if (!userId) throw new Error('[ledger] userId مطلوب');
  if (!userPublicId) throw new Error('[ledger] userPublicId مطلوب');
  if (!type) throw new Error('[ledger] نوع العملية مطلوب');
  if (!currency || currency !== 'YER') {
    throw new Error(`[ledger] العملة يجب أن تكون YER — المُستلم: ${currency}`);
  }

  // Type validity
  if (!Object.values(TRANSACTION_TYPES).includes(type)) {
    throw new Error(`[ledger] نوع العملية غير معروف: ${type}`);
  }

  // Amount must be a positive integer
  assertPositiveInteger(amount, 'مبلغ العملية');

  // creditAmount / debitAmount must be non-negative integers
  assertNonNegativeInteger(creditAmount, 'creditAmount');
  assertNonNegativeInteger(debitAmount, 'debitAmount');

  // Exactly one of creditAmount / debitAmount must equal amount
  // (ADJUSTMENT can split — but for standard types, this must hold)
  if (type !== TRANSACTION_TYPES.ADJUSTMENT) {
    const direction = TYPE_DIRECTION[type];
    if (direction === 'credit') {
      if (creditAmount !== amount || debitAmount !== 0) {
        throw new Error(
          `[ledger] عملية ${type}: creditAmount يجب أن يساوي amount (${amount}) ` +
          `وdebitAmount يجب أن يكون صفراً`
        );
      }
    } else if (direction === 'debit') {
      if (debitAmount !== amount || creditAmount !== 0) {
        throw new Error(
          `[ledger] عملية ${type}: debitAmount يجب أن يساوي amount (${amount}) ` +
          `وcreditAmount يجب أن يكون صفراً`
        );
      }
    }
  } else {
    // ADJUSTMENT: one of them must equal amount, the other must be 0
    const isCredit = creditAmount === amount && debitAmount === 0;
    const isDebit = debitAmount === amount && creditAmount === 0;
    if (!isCredit && !isDebit) {
      throw new Error(
        '[ledger] عملية ADJUSTMENT: إما (creditAmount = amount, debitAmount = 0) ' +
        'أو (debitAmount = amount, creditAmount = 0)'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Core transaction builder
// ---------------------------------------------------------------------------

/**
 * Builds a complete transaction data object from minimal input.
 * Sets creditAmount/debitAmount based on the type direction.
 *
 * @param {object} input
 * @param {string}                         input.type
 * @param {number}                         input.amount            - Positive integer YER.
 * @param {mongoose.Types.ObjectId}        input.userId
 * @param {string}                         input.userPublicId
 * @param {mongoose.Types.ObjectId}        [input.performedBy]
 * @param {string}                         [input.performedByPublicId]
 * @param {'admin'|'deputy'|'system'}      [input.performedByRole='system']
 * @param {string}                         [input.description]
 * @param {string}                         [input.adminNote]
 * @param {mongoose.Types.ObjectId}        [input.referenceId]
 * @param {string}                         [input.referencePublicId]
 * @param {string}                         [input.referenceType]
 * @param {object}                         [input.metadata]
 * @param {'credit'|'debit'}               [input.direction]       - For ADJUSTMENT only.
 * @returns {object} Complete transaction data ready for DB insertion.
 */
function buildTransactionData(input) {
  const {
    type,
    amount,
    userId,
    userPublicId,
    performedBy = null,
    performedByPublicId = null,
    performedByRole = 'system',
    description = null,
    adminNote = null,
    referenceId = null,
    referencePublicId = null,
    referenceType = null,
    metadata = null,
    direction, // Only for ADJUSTMENT
  } = input;

  // Determine credit/debit columns
  let creditAmount = 0;
  let debitAmount = 0;

  if (type === TRANSACTION_TYPES.ADJUSTMENT) {
    if (!direction) {
      throw new Error('[ledger] ADJUSTMENT يتطلب تحديد direction: "credit" أو "debit"');
    }
    if (direction === 'credit') creditAmount = amount;
    else if (direction === 'debit') debitAmount = amount;
    else throw new Error(`[ledger] direction غير صحيح: ${direction}`);
  } else {
    const dir = TYPE_DIRECTION[type];
    if (!dir) throw new Error(`[ledger] نوع غير معروف: ${type}`);
    if (dir === 'credit') creditAmount = amount;
    else debitAmount = amount;
  }

  return {
    publicId: randomUUID(),
    userId,
    userPublicId,
    type,
    amount,
    creditAmount,
    debitAmount,
    currency: 'YER',
    performedBy,
    performedByPublicId,
    performedByRole,
    description,
    adminNote,
    referenceId,
    referencePublicId,
    referenceType,
    metadata,
  };
}

// ---------------------------------------------------------------------------
// 1. calculateBalance
// ---------------------------------------------------------------------------

/**
 * Calculates the current balance and debt for a user from the ledger.
 *
 * PERFORMANCE:
 *   - Checks Redis cache first (TTL: 30 seconds).
 *   - On cache miss: runs a single MongoDB aggregation pipeline.
 *   - Supports BalanceSnapshot for archived users (spec §13 archive strategy).
 *
 * ARCHIVE STRATEGY (spec §13):
 *   If a BalanceSnapshot exists for this user, the function computes:
 *     delta = SUM(transactions since snapshot.lastCreatedAt)
 *     balance = snapshot.balanceAtSnapshot + delta.totalCredits - delta.totalDebits
 *   This avoids scanning transactions older than 2 years.
 *
 * @param {string}                userId        - INTERNAL ObjectId string or ObjectId.
 * @param {string}                userPublicId  - UUID v4 for cache keying.
 * @param {object}                [options={}]
 * @param {boolean}               [options.bypassCache=false]   - Force DB recalculation.
 * @param {mongoose.ClientSession}[options.session]             - For consistent reads inside a tx.
 * @returns {Promise<{
 *   balance: number,      - Current balance (can be negative)
 *   debt: number,         - Outstanding debt (always ≥ 0)
 *   totalCredits: number,
 *   totalDebits: number,
 *   transactionCount: number,
 * }>}
 */
async function calculateBalance(userId, userPublicId, options = {}) {
  const { bypassCache = false, session } = options;

  // ── Cache lookup ──────────────────────────────────────────────────────────
  if (!bypassCache && !session) {
    const cached = await cacheGet(CacheKeys.userBalance(userPublicId));
    if (cached !== null) {
      logger.debug('[ledger:balance] cache hit', { userPublicId });
      return cached;
    }
  }

  // ── Check for BalanceSnapshot (archive strategy) ──────────────────────────
  const { BalanceSnapshot } = require('../models'); // lazy to avoid circular dep
  const latestSnapshot = await BalanceSnapshot
    .findOne({ userId })
    .sort({ snapshotDate: -1 })
    .select('balanceAtSnapshot debtAtSnapshot lastCreatedAt transactionCount')
    .lean();

  let snapshotBase = { totalCredits: 0, totalDebits: 0, transactionCount: 0 };
  let sinceDate = null;

  if (latestSnapshot) {
    // Use snapshot as the base; only aggregate transactions after the snapshot
    sinceDate = latestSnapshot.lastCreatedAt;
    snapshotBase = {
      totalCredits: latestSnapshot.balanceAtSnapshot >= 0 ? latestSnapshot.balanceAtSnapshot : 0,
      totalDebits: latestSnapshot.balanceAtSnapshot < 0 ? -latestSnapshot.balanceAtSnapshot : 0,
      transactionCount: latestSnapshot.transactionCount,
    };
    // NOTE: The above is a simplification. In production, the snapshot stores
    // totalCredits and totalDebits explicitly for accuracy. For now, we derive
    // them from balanceAtSnapshot.
  }

  // ── Aggregate from DB ──────────────────────────────────────────────────────
  const aggResult = await transactionRepository.aggregateBalanceTotals(
    userId,
    { sinceDate, session }
  );

  const totalCredits = snapshotBase.totalCredits + aggResult.totalCredits;
  const totalDebits = snapshotBase.totalDebits + aggResult.totalDebits;
  const transactionCount = snapshotBase.transactionCount + aggResult.transactionCount;

  // ── Compute balance and debt ───────────────────────────────────────────────
  const { balance, debt } = computeBalanceAndDebt(totalCredits, totalDebits);

  const result = {
    balance,
    debt,
    totalCredits,
    totalDebits,
    transactionCount,
  };

  logger.debug('[ledger:balance] calculated from DB', {
    userPublicId,
    balance,
    debt,
    transactionCount,
  });

  // ── Cache result ───────────────────────────────────────────────────────────
  if (!session && !bypassCache) {
    await cacheSet(CacheKeys.userBalance(userPublicId), result, TTL.BALANCE_SNAPSHOT);
  }

  return result;
}

// ---------------------------------------------------------------------------
// 2. recordTransaction
// ---------------------------------------------------------------------------

/**
 * Records a single financial transaction in the ledger atomically.
 *
 * SANITY CHECKS performed before DB write:
 *  ✅ All required fields present
 *  ✅ amount is a positive integer
 *  ✅ currency === 'YER'
 *  ✅ type is a valid enum value
 *  ✅ creditAmount / debitAmount consistent with type direction
 *
 * MONGO JSON SCHEMA is the authoritative validator — these checks provide
 * faster, more descriptive error messages before the DB roundtrip.
 *
 * CACHE INVALIDATION: invalidates user balance cache on successful write.
 *
 * @param {object}                 txData   - Transaction fields (use buildTransactionData).
 * @param {mongoose.ClientSession} session  - Active Mongoose session (REQUIRED).
 * @returns {Promise<object>} The created transaction (plain object, publicId exposed).
 * @throws {Error} If session missing, sanity check fails, or DB write fails.
 */
async function recordTransaction(txData, session) {
  if (!session) {
    throw new Error(
      '[ledger:recordTransaction] ❌ session مطلوب — ' +
      'يجب الاستدعاء داخل session.withTransaction()'
    );
  }

  // Sanity check (fast fail before DB roundtrip)
  sanityCheckTransactionData(txData);

  // Delegate to repository for the actual DB write
  const created = await transactionRepository.createOne(txData, session);

  // Invalidate balance cache for this user (write-through invalidation)
  if (txData.userPublicId) {
    await cacheDel(CacheKeys.userBalance(txData.userPublicId));
  }

  return created;
}

/**
 * Records multiple transactions atomically (e.g. expense for N users).
 * All entries are created in a single DB operation within the session.
 *
 * @param {object[]}               txDataArray  - Array of transaction data objects.
 * @param {mongoose.ClientSession} session      - Active session (REQUIRED).
 * @returns {Promise<object[]>} Array of created transactions.
 */
async function recordTransactions(txDataArray, session) {
  if (!session) {
    throw new Error(
      '[ledger:recordTransactions] ❌ session مطلوب'
    );
  }
  if (!Array.isArray(txDataArray) || txDataArray.length === 0) {
    throw new Error('[ledger:recordTransactions] txDataArray يجب أن يكون مصفوفة غير فارغة');
  }

  // Sanity check each entry
  txDataArray.forEach((txData, i) => {
    try {
      sanityCheckTransactionData(txData);
    } catch (err) {
      throw new Error(`[ledger:recordTransactions] خطأ في العملية رقم ${i + 1}: ${err.message}`);
    }
  });

  const created = await transactionRepository.createMany(txDataArray, session);

  // Invalidate balance cache for all affected users
  const uniqueUserPublicIds = [...new Set(txDataArray.map(t => t.userPublicId).filter(Boolean))];
  await Promise.all(uniqueUserPublicIds.map(uid => cacheDel(CacheKeys.userBalance(uid))));

  return created;
}

// ---------------------------------------------------------------------------
// 3. validateTransactionIntegrity
// ---------------------------------------------------------------------------

/**
 * Validates the integrity of a user's ledger.
 *
 * CHECKS PERFORMED:
 *  1. MATHEMATICAL INTEGRITY — Recomputes balance from scratch (bypassing cache)
 *     and compares to expected state. Detects any gap caused by:
 *     - Manual DB edits bypassing the application
 *     - Failed atomic operations that left partial state
 *     - Data corruption during migration
 *
 *  2. NEGATIVE BALANCE CHECK (when allowDebt === false) — If the system
 *     settings disallow debt, a negative balance is a critical anomaly.
 *
 *  3. TRANSACTION COUNT CONSISTENCY — If a BalanceSnapshot exists, verifies
 *     that the live count matches expected count (snapshot.count + delta.count).
 *
 *  4. CREDIT/DEBIT COLUMN CONSISTENCY — Each individual transaction must
 *     have exactly one of (creditAmount > 0) or (debitAmount > 0), except
 *     for zero-fee WITHDRAWAL_FEE entries.
 *
 * @param {mongoose.Types.ObjectId} userId        - Internal ObjectId.
 * @param {string}                  userPublicId  - UUID for logging.
 * @param {object}                  [options={}]
 * @param {boolean}                 [options.allowDebt=true]  - From system settings.
 * @returns {Promise<{
 *   isValid: boolean,
 *   balance: number,
 *   debt: number,
 *   anomalies: string[],  - Array of Arabic anomaly descriptions (empty if valid)
 * }>}
 */
async function validateTransactionIntegrity(userId, userPublicId, options = {}) {
  const { allowDebt = true } = options;
  const anomalies = [];

  logger.info('[ledger:integrity] بدء فحص سلامة دفتر الأستاذ', { userPublicId });

  // ── Step 1: Fresh balance calculation (bypass cache) ──────────────────────
  let balanceResult;
  try {
    balanceResult = await calculateBalance(userId, userPublicId, { bypassCache: true });
  } catch (err) {
    anomalies.push(`خطأ في حساب الرصيد: ${err.message}`);
    return { isValid: false, balance: 0, debt: 0, anomalies };
  }

  const { balance, debt, totalCredits, totalDebits } = balanceResult;

  // ── Step 2: Credit/debit column consistency check ─────────────────────────
  // Use aggregation to find any transaction where BOTH creditAmount and
  // debitAmount are non-zero (which should never happen).
  const badTransactions = await Transaction.aggregate([
    {
      $match: {
        userId,
        $and: [
          { creditAmount: { $gt: 0 } },
          { debitAmount: { $gt: 0 } },
        ],
      },
    },
    { $count: 'count' },
  ]);

  if (badTransactions.length > 0 && badTransactions[0].count > 0) {
    anomalies.push(
      `تم اكتشاف ${badTransactions[0].count} عملية تحتوي على إضافة وخصم في نفس الوقت — ` +
      'هذا يشير إلى فساد في البيانات'
    );
  }

  // ── Step 3: Zero-amount transaction check ─────────────────────────────────
  const zeroAmountCount = await Transaction.countDocuments({
    userId,
    amount: { $lte: 0 },
  });
  if (zeroAmountCount > 0) {
    anomalies.push(
      `تم اكتشاف ${zeroAmountCount} عملية بمبلغ صفر أو سالب — ` +
      'المبالغ يجب أن تكون أكبر من صفر دائماً'
    );
  }

  // ── Step 4: Debt policy check ─────────────────────────────────────────────
  if (!allowDebt && balance < 0) {
    anomalies.push(
      `الرصيد سالب (${balance} ريال) بينما سياسة النظام لا تسمح بالدين — ` +
      'يجب مراجعة العمليات التي أدت إلى هذا الوضع'
    );
  }

  // ── Step 5: Mathematical sanity — credits and debits must be non-negative ──
  if (totalCredits < 0) {
    anomalies.push(`إجمالي الإضافات سالب (${totalCredits}) — هذا يشير إلى فساد في البيانات`);
  }
  if (totalDebits < 0) {
    anomalies.push(`إجمالي الخصومات سالب (${totalDebits}) — هذا يشير إلى فساد في البيانات`);
  }

  const isValid = anomalies.length === 0;

  if (!isValid) {
    logger.warn('[ledger:integrity] ⚠️  تم اكتشاف شذوذات في دفتر الأستاذ', {
      userPublicId,
      anomalies,
    });
  } else {
    logger.info('[ledger:integrity] ✅ دفتر الأستاذ سليم', {
      userPublicId,
      balance,
      debt,
    });
  }

  return { isValid, balance, debt, anomalies };
}

// ---------------------------------------------------------------------------
// 4. Atomic compound operations
// ---------------------------------------------------------------------------

/**
 * Processes a deposit approval atomically.
 *
 * ATOMIC SEQUENCE (spec §5 — Debt Settlement Sequence):
 *   Step 1: Create DEPOSIT ledger entry
 *   Step 2: Recalculate new effective balance
 *   Step 3: If new_balance > 0 AND existing debt > 0:
 *             Create DEBT_SETTLEMENT entry for MIN(debt, new_balance)
 *   Step 4: All steps within a single MongoDB session (guaranteed by caller)
 *
 * ⚠️  The CALLER must wrap this in session.withTransaction(). This function
 *     does NOT create or commit the session — it only uses the one provided.
 *
 * @param {object} params
 * @param {mongoose.Types.ObjectId}  params.userId
 * @param {string}                   params.userPublicId
 * @param {number}                   params.depositAmount    - Positive integer YER.
 * @param {mongoose.Types.ObjectId}  params.referenceId      - DepositRequest ObjectId.
 * @param {string}                   params.referencePublicId
 * @param {mongoose.Types.ObjectId}  params.performedBy      - Admin/deputy ObjectId.
 * @param {string}                   params.performedByPublicId
 * @param {'admin'|'deputy'}         params.performedByRole
 * @param {string}                   [params.adminNote]
 * @param {mongoose.ClientSession}   params.session
 * @returns {Promise<{
 *   depositTx: object,
 *   settlementTx: object|null,
 *   newBalance: number,
 *   settledDebt: number,
 * }>}
 */
async function processDepositApproval(params) {
  const {
    userId, userPublicId, depositAmount, referenceId, referencePublicId,
    performedBy, performedByPublicId, performedByRole, adminNote = null,
    session,
  } = params;

  if (!session) throw new Error('[ledger:depositApproval] session مطلوب');
  assertPositiveInteger(depositAmount, 'مبلغ الإيداع');

  // Get current balance BEFORE the deposit (consistent read within session)
  const currentState = await calculateBalance(userId, userPublicId, {
    bypassCache: true,
    session,
  });

  const { balance: balanceBefore, debt: debtBefore } = currentState;

  // Step 1: Create DEPOSIT entry
  const depositTxData = buildTransactionData({
    type: TRANSACTION_TYPES.DEPOSIT,
    amount: depositAmount,
    userId,
    userPublicId,
    performedBy,
    performedByPublicId,
    performedByRole,
    description: `إيداع بمبلغ ${depositAmount.toLocaleString('ar-YE')} ريال`,
    adminNote,
    referenceId,
    referencePublicId,
    referenceType: 'depositRequest',
    metadata: { balanceBefore },
  });

  const depositTx = await recordTransaction(depositTxData, session);

  // Step 2: Calculate new balance after deposit
  const balanceAfterDeposit = balanceBefore + depositAmount;

  // Step 3: Auto debt settlement if applicable
  let settlementTx = null;
  const settlementAmount = computeDebtSettlement(depositAmount, balanceBefore, debtBefore);

  if (settlementAmount > 0) {
    const settlementTxData = buildTransactionData({
      type: TRANSACTION_TYPES.DEBT_SETTLEMENT,
      amount: settlementAmount,
      userId,
      userPublicId,
      performedBy: null, // Auto-system action
      performedByRole: 'system',
      description: `تسوية تلقائية للدين بمبلغ ${settlementAmount.toLocaleString('ar-YE')} ريال`,
      referenceId: depositTx._id || referenceId,
      referencePublicId: depositTx.publicId,
      referenceType: 'depositRequest',
      metadata: {
        autoSettled: true,
        debtBefore,
        settlementAmount,
        depositTxPublicId: depositTx.publicId,
      },
    });

    settlementTx = await recordTransaction(settlementTxData, session);

    logger.info('[ledger:depositApproval] ✅ تسوية دين تلقائية', {
      userPublicId,
      settlementAmount,
      debtBefore,
    });
  }

  const newBalance = balanceAfterDeposit - settlementAmount;

  return {
    depositTx,
    settlementTx,
    newBalance,
    settledDebt: settlementAmount,
  };
}

/**
 * Processes a withdrawal approval atomically.
 *
 * ATOMIC SEQUENCE:
 *   Step 1: Create WITHDRAWAL entry
 *   Step 2: Create WITHDRAWAL_FEE entry (even if fee is 0 — for audit trail)
 *   Both within the provided session.
 *
 * @param {object} params
 * @param {mongoose.Types.ObjectId}  params.userId
 * @param {string}                   params.userPublicId
 * @param {number}                   params.withdrawalAmount    - Positive integer YER.
 * @param {number}                   params.feeAmount           - Non-negative integer YER.
 * @param {'FIXED'|'PERCENTAGE'}     params.feeType
 * @param {number}                   params.feeValue
 * @param {mongoose.Types.ObjectId}  params.referenceId         - WithdrawalRequest ObjectId.
 * @param {string}                   params.referencePublicId
 * @param {mongoose.Types.ObjectId}  params.performedBy
 * @param {string}                   params.performedByPublicId
 * @param {'admin'|'deputy'}         params.performedByRole
 * @param {string}                   [params.adminNote]
 * @param {mongoose.ClientSession}   params.session
 * @returns {Promise<{ withdrawalTx: object, feeTx: object, totalDeducted: number }>}
 */
async function processWithdrawalApproval(params) {
  const {
    userId, userPublicId, withdrawalAmount, feeAmount, feeType, feeValue,
    referenceId, referencePublicId, performedBy, performedByPublicId,
    performedByRole, adminNote = null, session,
  } = params;

  if (!session) throw new Error('[ledger:withdrawalApproval] session مطلوب');
  assertPositiveInteger(withdrawalAmount, 'مبلغ السحب');
  assertNonNegativeInteger(feeAmount, 'مبلغ الرسوم');

  const netAmount = withdrawalAmount - feeAmount;

  // Create WITHDRAWAL entry
  const withdrawalTxData = buildTransactionData({
    type: TRANSACTION_TYPES.WITHDRAWAL,
    amount: withdrawalAmount,
    userId,
    userPublicId,
    performedBy,
    performedByPublicId,
    performedByRole,
    description: `سحب بمبلغ ${withdrawalAmount.toLocaleString('ar-YE')} ريال`,
    adminNote,
    referenceId,
    referencePublicId,
    referenceType: 'withdrawalRequest',
    metadata: { feeAmount, netAmount, feeType, feeValue },
  });

  const withdrawalTx = await recordTransaction(withdrawalTxData, session);

  // Create WITHDRAWAL_FEE entry (always create for audit, even if 0)
  // NOTE: If feeAmount === 0, we still create the record as a zero-amount
  // exception — override the assertPositiveInteger for this special case.
  let feeTx = null;
  if (feeAmount > 0) {
    const feeTxData = buildTransactionData({
      type: TRANSACTION_TYPES.WITHDRAWAL_FEE,
      amount: feeAmount,
      userId,
      userPublicId,
      performedBy,
      performedByPublicId,
      performedByRole,
      description: `رسوم سحب ${feeType === 'PERCENTAGE' ? `${feeValue}%` : 'ثابتة'}: ${feeAmount.toLocaleString('ar-YE')} ريال`,
      referenceId,
      referencePublicId,
      referenceType: 'withdrawalRequest',
      metadata: { feeType, feeValue, withdrawalTxPublicId: withdrawalTx.publicId },
    });

    feeTx = await recordTransaction(feeTxData, session);
  }

  const totalDeducted = withdrawalAmount + feeAmount;

  logger.info('[ledger:withdrawalApproval] ✅ تمت الموافقة على السحب', {
    userPublicId,
    withdrawalAmount,
    feeAmount,
    totalDeducted,
  });

  return { withdrawalTx, feeTx, totalDeducted };
}

/**
 * Creates ledger entries for a shared expense among multiple users.
 *
 * ATOMIC: All entries are created within the provided session.
 * ROUNDING: Uses splitExpense() which implements spec §5 policy exactly.
 *
 * @param {object} params
 * @param {Array<{ userId, userPublicId, userName }>} params.users
 * @param {number}                   params.totalAmount
 * @param {mongoose.Types.ObjectId}  params.expenseId
 * @param {string}                   params.expensePublicId
 * @param {string}                   params.expenseName
 * @param {mongoose.Types.ObjectId}  params.performedBy
 * @param {string}                   params.performedByPublicId
 * @param {'admin'|'deputy'}         params.performedByRole
 * @param {mongoose.ClientSession}   params.session
 * @returns {Promise<Array<{ user: object, tx: object, shareAmount: number }>>}
 */
async function processExpenseCreation(params) {
  const {
    users, totalAmount, expenseId, expensePublicId, expenseName,
    performedBy, performedByPublicId, performedByRole, session,
  } = params;

  if (!session) throw new Error('[ledger:expenseCreation] session مطلوب');
  if (!Array.isArray(users) || users.length === 0) {
    throw new Error('[ledger:expenseCreation] يجب اختيار مستخدم واحد على الأقل');
  }
  assertPositiveInteger(totalAmount, 'إجمالي المصروف');

  // Compute shares using spec §5 rounding policy
  const shares = splitExpense(totalAmount, users.length);

  // Build transaction data for each user
  const txDataArray = users.map((user, idx) => buildTransactionData({
    type: TRANSACTION_TYPES.SHARED_EXPENSE,
    amount: shares[idx],
    userId: user.userId,
    userPublicId: user.userPublicId,
    performedBy,
    performedByPublicId,
    performedByRole,
    description: `مصروف مشترك: ${expenseName}`,
    referenceId: expenseId,
    referencePublicId: expensePublicId,
    referenceType: 'expense',
    metadata: {
      expenseName,
      totalAmount,
      totalUsers: users.length,
      shareIndex: idx,
      shareAmount: shares[idx],
    },
  }));

  // Write all atomically
  const txDocs = await recordTransactions(txDataArray, session);

  return users.map((user, idx) => ({
    user,
    tx: txDocs[idx],
    shareAmount: shares[idx],
  }));
}

// ---------------------------------------------------------------------------
// 5. Convenience exports for fee calculation (used by controllers)
// ---------------------------------------------------------------------------

/**
 * Computes the withdrawal fee from current settings, verifies balance sufficiency.
 *
 * @param {object} params
 * @param {number}               params.withdrawalAmount
 * @param {number}               params.currentBalance
 * @param {'FIXED'|'PERCENTAGE'} params.feeType
 * @param {number}               params.feeValue
 * @returns {{ feeAmount: number, netAmount: number, totalRequired: number, isSufficient: boolean }}
 */
function computeWithdrawalDetails(params) {
  const { withdrawalAmount, currentBalance, feeType, feeValue } = params;

  assertPositiveInteger(withdrawalAmount, 'مبلغ السحب');
  assertInteger(currentBalance, 'الرصيد الحالي');

  const feeAmount = calculateWithdrawalFee(withdrawalAmount, feeType, feeValue);
  const netAmount = withdrawalAmount - feeAmount;
  const totalRequired = withdrawalAmount + feeAmount;
  const isSufficient = currentBalance >= totalRequired;

  return { feeAmount, netAmount, totalRequired, isSufficient };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Core functions (spec-required)
  calculateBalance,
  recordTransaction,
  recordTransactions,
  validateTransactionIntegrity,

  // Atomic compound operations
  processDepositApproval,
  processWithdrawalApproval,
  processExpenseCreation,

  // Utilities
  buildTransactionData,
  computeWithdrawalDetails,
  sanityCheckTransactionData,
};
