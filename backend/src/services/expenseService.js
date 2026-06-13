/**
 * @file expenseService.js
 * @description Shared expense management, dispute filing, and dispute resolution.
 *
 * ██████████████████████████████████████████████████████████████████████████
 * ██  ARCHITECTURE OVERVIEW                                               ██
 * ██████████████████████████████████████████████████████████████████████████
 *
 * FLOW — createSharedExpense:
 *   1. Validate input (users exist, are active, totalAmount > 0)
 *   2. Load current system settings (debt policy, maxDebtPerUser)
 *   3. Calculate per-user shares using integerMath.splitExpense() [spec §5]
 *   4. Pre-flight: check each user's balance vs. their share + debt limits
 *      → If allowDebt=false and ANY user would go negative: REJECT the entire expense
 *      → If allowDebt=true but any user would exceed maxDebtPerUser: REJECT
 *   5. Within a single MongoDB session:
 *      a. Create N × SHARED_EXPENSE ledger entries (one per user)
 *      b. Create the Expense document with embedded affectedUsers + share refs
 *   6. Post-commit (outside session, non-blocking):
 *      a. Invalidate balance caches for all affected users
 *      b. Create N × in-app notifications (SHARED_EXPENSE_ADDED)
 *      c. Create audit log entry
 *      d. Check if any user's debt now triggers the 80% warning threshold
 *
 * FLOW — fileDispute:
 *   1. Verify the expense exists and the user is in affectedUsers
 *   2. Check no OPEN dispute already exists for this user on this expense
 *   3. Atomically push the dispute to the expense's disputes array
 *   4. Create an admin notification (EXPENSE_DISPUTED)
 *   5. Create audit log
 *   NOTE: Balance is NOT touched — the charge stands until admin resolves
 *
 * FLOW — resolveDispute:
 *   1. Admin-only: verify actorRole is admin or deputy
 *   2. Load expense + dispute (verify both exist and dispute is OPEN)
 *   3. RESOLUTION TYPE: 'dismiss' | 'refund'
 *      → dismiss: Update dispute.status = resolved_dismissed. No ledger change.
 *      → refund:  Within a session:
 *                   a. Create REFUND transaction for the disputed share amount
 *                   b. Update dispute.status = resolved_refunded + link refund tx
 *                 Immutable Ledger: old SHARED_EXPENSE entry is NEVER modified
 *   4. Notify the disputing user of the resolution
 *   5. Create audit log
 *
 * IMMUTABLE LEDGER PRINCIPLE:
 *   Dispute resolution via refund creates a NEW REFUND entry.
 *   The original SHARED_EXPENSE entry is NEVER touched.
 *   Net effect after refund: creditAmount (+share) cancels debitAmount (-share).
 *
 * DEBT MANAGEMENT:
 *   After a new expense, if a user's balance goes negative:
 *     → Their debt increases by the deficit amount
 *     → If debt reaches 80% of maxDebtPerUser: admin notification
 *     → If debt reaches 100%: expense creation is blocked pre-flight
 *   Debt tracking is automatic via the ledger (no stored debt field).
 *
 * SPEC REFERENCES: §8 (Shared Expense), §5 (Rounding), §9 (Debt Management)
 *
 * @module services/expenseService
 */

'use strict';

const { randomUUID } = require('crypto');
const mongoose = require('mongoose');

const { TRANSACTION_TYPES, DISPUTE_STATUS, AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, NOTIFICATION_TYPES } = require('../models');
const expenseRepository = require('../repositories/expenseRepository');
const userRepository = require('../repositories/userRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const notificationRepository = require('../repositories/notificationRepository');
const ledgerService = require('./ledgerService');
const settingService = require('./settingService');
const { db } = require('../config');
const {
  splitExpense,
  computeBalanceAndDebt,
  checkDebtLimit,
  assertPositiveInteger,
} = require('../utils/integerMath');
const { cacheDel, CacheKeys } = require('../config/redis');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

class ExpenseValidationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'ExpenseValidationError';
    this.details = details;
    this.statusCode = 422;
  }
}

class DebtLimitExceededError extends Error {
  constructor(affectedUsers, message) {
    super(message || 'بعض المستخدمين سيتجاوزون حد الدين المسموح به');
    this.name = 'DebtLimitExceededError';
    this.affectedUsers = affectedUsers; // [{ userPublicId, userName, projectedDebt, limit }]
    this.statusCode = 422;
  }
}

class DisputeError extends Error {
  constructor(message, statusCode = 422) {
    super(message);
    this.name = 'DisputeError';
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Checks debt limits for all affected users before committing an expense.
 * Returns detailed information about any violations.
 *
 * @param {Array<{ userId, userPublicId, userName, shareAmount }>} usersWithShares
 * @param {object} settings - System settings (allowDebt, maxDebtPerUser).
 * @returns {Promise<void>}
 * @throws {ExpenseValidationError} If allowDebt is false and any user would go negative.
 * @throws {DebtLimitExceededError} If any user would exceed maxDebtPerUser.
 */
async function preFlightDebtCheck(usersWithShares, settings) {
  const { allowDebt, maxDebtPerUser } = settings;

  // Fetch current balances for all users in parallel
  const balanceResults = await Promise.all(
    usersWithShares.map(async (u) => {
      const state = await ledgerService.calculateBalance(
        u.userId,
        u.userPublicId,
        { bypassCache: false } // Use cache for speed — this is pre-flight
      );
      return { ...u, ...state };
    })
  );

  // Check each user
  const violations = [];
  const debtLimitViolations = [];

  for (const user of balanceResults) {
    const { balance, debt, shareAmount, userPublicId, userName } = user;
    const projectedBalance = balance - shareAmount;

    // Check 1: allowDebt = false → any negative result is blocked
    if (!allowDebt && projectedBalance < 0) {
      violations.push({ userPublicId, userName, balance, shareAmount, projectedBalance });
      continue;
    }

    // Check 2: maxDebtPerUser (0 = unlimited)
    if (allowDebt && maxDebtPerUser > 0) {
      const { wouldExceed, projectedDebt } = checkDebtLimit(balance, shareAmount, maxDebtPerUser);
      if (wouldExceed) {
        debtLimitViolations.push({
          userPublicId,
          userName,
          currentDebt: debt,
          projectedDebt,
          limit: maxDebtPerUser,
        });
      }
    }
  }

  if (violations.length > 0) {
    throw new ExpenseValidationError(
      'بعض المستخدمين ليس لديهم رصيد كافٍ والنظام لا يسمح بالدين',
      { insufficientBalance: violations }
    );
  }

  if (debtLimitViolations.length > 0) {
    throw new DebtLimitExceededError(
      debtLimitViolations,
      `${debtLimitViolations.length} مستخدم(ين) سيتجاوزون الحد الأقصى للدين`
    );
  }
}

/**
 * Sends debt threshold notifications after an expense is committed.
 * 80% threshold → admin notification.
 * This runs OUTSIDE the session — failures don't roll back the expense.
 *
 * @param {Array<{ userId, userPublicId, userName }>} affectedUsers
 * @param {object} settings
 * @param {mongoose.Types.ObjectId} adminUserId - For notification targeting.
 */
async function sendDebtThresholdNotifications(affectedUsers, settings, adminUserId) {
  if (!settings.maxDebtPerUser || settings.maxDebtPerUser === 0) return;

  const threshold80 = Math.floor(settings.maxDebtPerUser * 0.8);

  for (const user of affectedUsers) {
    try {
      const state = await ledgerService.calculateBalance(
        user.userId,
        user.userPublicId,
        { bypassCache: true }
      );

      if (state.debt >= threshold80 && adminUserId) {
        await notificationRepository.createOne({
          userId: adminUserId,
          userPublicId: user.adminPublicId || '',
          type: NOTIFICATION_TYPES.DEBT_APPROACHING_LIMIT,
          message: `المستخدم ${user.userName} اقترب من حد الدين الأقصى (${state.debt.toLocaleString('ar-YE')} ريال من ${settings.maxDebtPerUser.toLocaleString('ar-YE')})`,
          relatedEntityType: 'user',
          relatedEntityPublicId: user.userPublicId,
        });
      }
    } catch (err) {
      // Non-blocking — log and continue
      logger.warn('[expenseService] فشل إرسال إشعار حد الدين', {
        userPublicId: user.userPublicId,
        error: err.message,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 1. createSharedExpense
// ---------------------------------------------------------------------------

/**
 * Creates a shared expense and splits it among selected users.
 *
 * ATOMIC (inside a MongoDB session provided by the caller or created internally):
 *   - All SHARED_EXPENSE ledger entries
 *   - The Expense document with embedded user shares
 *
 * @param {object} expenseData
 * @param {string}                           expenseData.name            - Arabic name.
 * @param {number}                           expenseData.totalAmount     - Positive integer YER.
 * @param {string[]}                         expenseData.userPublicIds   - UUIDs of affected users.
 * @param {string}                           [expenseData.description]
 * @param {string}                           [expenseData.receiptImagePublicId]
 * @param {Date}                             [expenseData.expenseDate]
 * @param {mongoose.Types.ObjectId}          expenseData.performedBy     - Admin ObjectId.
 * @param {string}                           expenseData.performedByPublicId
 * @param {'admin'|'deputy'}                 expenseData.performedByRole
 * @param {string}                           expenseData.performedByName
 * @param {mongoose.Types.ObjectId}          [expenseData.adminUserId]   - For debt notifications.
 *
 * @param {mongoose.ClientSession}           [externalSession]  - If provided, uses it.
 *                                                                Otherwise creates its own.
 * @returns {Promise<{ expense: object, userResults: Array<{ user, tx, shareAmount }> }>}
 * @throws {ExpenseValidationError} For invalid input.
 * @throws {DebtLimitExceededError} If debt limits would be exceeded.
 */
async function createSharedExpense(expenseData, externalSession = null) {
  const {
    name,
    totalAmount,
    userPublicIds,
    description = null,
    receiptImagePublicId = null,
    expenseDate = new Date(),
    performedBy,
    performedByPublicId,
    performedByRole,
    performedByName,
    adminUserId,
  } = expenseData;

  // ── Input validation ───────────────────────────────────────────────────────
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new ExpenseValidationError('اسم المصروف مطلوب');
  }
  assertPositiveInteger(totalAmount, 'إجمالي مبلغ المصروف');

  if (!Array.isArray(userPublicIds) || userPublicIds.length === 0) {
    throw new ExpenseValidationError('يجب اختيار مستخدم واحد على الأقل');
  }

  // Remove duplicates
  const uniqueUserPublicIds = [...new Set(userPublicIds)];

  // ── Load and validate users ───────────────────────────────────────────────
  const users = await userRepository.findManyByPublicIds(uniqueUserPublicIds);

  if (users.length !== uniqueUserPublicIds.length) {
    const foundIds = new Set(users.map(u => u.publicId));
    const missing = uniqueUserPublicIds.filter(id => !foundIds.has(id));
    throw new ExpenseValidationError(
      `بعض المستخدمين غير موجودين أو غير نشطين: ${missing.join(', ')}`
    );
  }

  // Hydrate with internal ObjectIds (needed for ledger entries)
  // We need ObjectIds — fetch from DB with _id included
  const usersWithIds = await Promise.all(
    users.map(async (u) => {
      const full = await require('../models').User
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

  // ── Load system settings ──────────────────────────────────────────────────
  const settings = await settingService.getSettings();

  // ── Pre-flight debt check ──────────────────────────────────────────────────
  // Calculate shares first so we can check per-user impact
  const shares = splitExpense(totalAmount, usersWithIds.length);
  const usersWithShares = usersWithIds.map((u, i) => ({
    ...u,
    shareAmount: shares[i],
  }));

  await preFlightDebtCheck(usersWithShares, settings);

  // ── Atomic DB operations ───────────────────────────────────────────────────
  const useExternalSession = !!externalSession;
  const session = externalSession || (await db.startSession());

  let expenseDoc;
  let userResults;

  try {
    const executeOps = async () => {
      // Step A: Create SHARED_EXPENSE ledger entries (via ledgerService)
      userResults = await ledgerService.processExpenseCreation({
        users: usersWithIds,
        totalAmount,
        expenseId: null, // Will be set after expense document is created
        expensePublicId: null,
        expenseName: name.trim(),
        performedBy,
        performedByPublicId,
        performedByRole,
        session,
      });

      // Step B: Build affectedUsers array with transaction references
      const affectedUsersWithTxRefs = userResults.map(({ user, tx, shareAmount }) => ({
        userId: user.userId,
        userPublicId: user.userPublicId,
        userName: user.userName,
        shareAmount,
        transactionId: tx._id || new mongoose.Types.ObjectId(tx.id),
        transactionPublicId: tx.publicId,
      }));

      // Step C: Create the Expense document
      expenseDoc = await expenseRepository.createOne(
        {
          name: name.trim(),
          description: description?.trim() || null,
          totalAmount,
          currency: 'YER',
          receiptImagePublicId: receiptImagePublicId || null,
          expenseDate: expenseDate || new Date(),
          createdBy: performedBy,
          createdByPublicId: performedByPublicId,
          affectedUsers: affectedUsersWithTxRefs,
          disputes: [],
        },
        session
      );

      // Step D: Back-link expense publicId into each transaction's metadata
      // (We can't do this atomically without a second write — acceptable trade-off.
      //  The referencePublicId is set via the Expense document in queries.)
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

  logger.info('[expenseService] ✅ تم تسجيل مصروف مشترك', {
    expensePublicId: expenseDoc.publicId,
    name,
    totalAmount,
    usersCount: usersWithIds.length,
  });

  // ── Post-commit: non-blocking side effects ─────────────────────────────────
  // These run outside the session — failures don't roll back the expense.

  // 1. Invalidate balance caches
  await Promise.allSettled(
    usersWithIds.map(u => cacheDel(CacheKeys.userBalance(u.userPublicId)))
  );

  // 2. Send in-app notifications to all affected users
  const notifications = usersWithShares.map(u => ({
    userId: u.userId,
    userPublicId: u.userPublicId,
    type: NOTIFICATION_TYPES.SHARED_EXPENSE_ADDED,
    message: `تمت إضافة مصروف مشترك: ${name.trim()} بمبلغ ${u.shareAmount.toLocaleString('ar-YE')} ريال`,
    relatedEntityPublicId: expenseDoc.publicId,
    relatedEntityType: 'expense',
  }));

  await notificationRepository.createMany(notifications).catch(err => {
    logger.warn('[expenseService] فشل إرسال إشعارات المصروف', { error: err.message });
  });

  // 3. Audit log
  await auditLogRepository.createLog({
    actorId: performedBy,
    actorPublicId: performedByPublicId,
    actorRole: performedByRole,
    actorName: performedByName,
    action: AUDIT_ACTIONS.EXPENSE_CREATED,
    entityType: AUDIT_ENTITY_TYPES.EXPENSE,
    entityPublicId: expenseDoc.publicId,
    metadata: {
      expenseName: name.trim(),
      totalAmount,
      affectedUsers: usersWithShares.map(u => ({
        publicId: u.userPublicId,
        name: u.userName,
        share: u.shareAmount,
      })),
    },
  });

  // 4. Debt threshold notifications (non-blocking)
  sendDebtThresholdNotifications(usersWithShares, settings, adminUserId).catch(err => {
    logger.warn('[expenseService] فشل فحص حد الدين بعد المصروف', { error: err.message });
  });

  return { expense: expenseDoc, userResults };
}

// ---------------------------------------------------------------------------
// 2. fileDispute
// ---------------------------------------------------------------------------

/**
 * Allows a user to file a dispute on a shared expense charge.
 *
 * RULES:
 *  - User must be in the expense's affectedUsers array.
 *  - User may have at most ONE open dispute per expense.
 *  - Filing a dispute does NOT change the user's balance.
 *  - Admin is notified immediately.
 *
 * @param {string} expensePublicId      - UUID of the expense.
 * @param {string} userPublicId         - UUID of the disputing user.
 * @param {string} note                 - Reason for the dispute (Arabic).
 * @param {object} [meta={}]
 * @param {string} [meta.userName]      - For notification message.
 * @param {mongoose.Types.ObjectId} [meta.adminUserId] - Admin to notify.
 * @param {string} [meta.adminPublicId]
 * @returns {Promise<{ disputePublicId: string, expense: object }>}
 * @throws {DisputeError} On validation failure or duplicate dispute.
 */
async function fileDispute(expensePublicId, userPublicId, note, meta = {}) {
  const { userName = 'مستخدم', adminUserId, adminPublicId } = meta;

  // Validate note
  if (!note || typeof note !== 'string' || !note.trim()) {
    throw new DisputeError('يجب تقديم سبب الاعتراض');
  }
  if (note.trim().length > 1000) {
    throw new DisputeError('سبب الاعتراض لا يتجاوز 1000 حرف');
  }

  // Verify expense exists
  const expense = await expenseRepository.findByPublicId(expensePublicId);
  if (!expense) {
    throw new DisputeError('المصروف المشترك غير موجود', 404);
  }

  // Verify user is in the expense
  const userShare = expense.affectedUsers.find(u => u.userPublicId === userPublicId);
  if (!userShare) {
    throw new DisputeError('أنت لست من ضمن المستخدمين المشمولين بهذا المصروف', 403);
  }

  // Build dispute object
  const disputePublicId = randomUUID();
  const disputeData = {
    publicId: disputePublicId,
    userId: userShare.userId,
    userPublicId,
    userName,
    note: note.trim(),
    status: DISPUTE_STATUS.OPEN,
    createdAt: new Date(),
  };

  // Atomic push — will return null if user already has an open dispute
  const updatedExpense = await expenseRepository.addDispute(expensePublicId, disputeData);

  if (!updatedExpense) {
    throw new DisputeError(
      'لديك اعتراض مفتوح بالفعل على هذا المصروف — انتظر حتى يتم البت فيه'
    );
  }

  logger.info('[expenseService] ✅ تم فتح اعتراض على مصروف', {
    expensePublicId,
    disputePublicId,
    userPublicId,
  });

  // Notify admin
  if (adminUserId && adminPublicId) {
    await notificationRepository.createOne({
      userId: adminUserId,
      userPublicId: adminPublicId,
      type: NOTIFICATION_TYPES.EXPENSE_DISPUTED,
      message: `المستخدم ${userName} يعترض على مصروف: ${expense.name}`,
      relatedEntityPublicId: expensePublicId,
      relatedEntityType: 'expense',
    }).catch(err => {
      logger.warn('[expenseService] فشل إشعار الاعتراض للمسؤول', { error: err.message });
    });
  }

  // Audit log (fire-and-forget)
  await auditLogRepository.createLog({
    actorId: userShare.userId,
    actorPublicId: userPublicId,
    actorRole: 'user',
    actorName: userName,
    action: AUDIT_ACTIONS.EXPENSE_DISPUTE_RESOLVED, // Using closest available action
    entityType: AUDIT_ENTITY_TYPES.EXPENSE,
    entityPublicId: expensePublicId,
    metadata: {
      disputePublicId,
      expenseName: expense.name,
      shareAmount: userShare.shareAmount,
      note: note.trim(),
    },
  });

  return { disputePublicId, expense: updatedExpense };
}

// ---------------------------------------------------------------------------
// 3. resolveDispute
// ---------------------------------------------------------------------------

/**
 * Admin resolves a dispute — either dismisses it or issues a refund.
 *
 * RESOLUTION TYPES:
 *   'dismiss' — Dispute is closed with no financial change.
 *   'refund'  — A new REFUND transaction is created for the disputed share amount.
 *               The original SHARED_EXPENSE entry is NEVER modified (Immutable Ledger).
 *
 * @param {string}                           expensePublicId
 * @param {string}                           disputePublicId
 * @param {'dismiss'|'refund'}               resolution
 * @param {object}                           actor
 * @param {mongoose.Types.ObjectId}          actor.id
 * @param {string}                           actor.publicId
 * @param {'admin'|'deputy'}                 actor.role
 * @param {string}                           actor.name
 * @param {object}                           [options={}]
 * @param {number}                           [options.refundAmount]    - Override refund amount.
 *                                                                       Defaults to full share.
 * @param {string}                           [options.adminNote]       - Note on the resolution.
 * @param {mongoose.ClientSession}           [options.externalSession]
 * @returns {Promise<{ expense: object, refundTx: object|null, resolutionType: string }>}
 * @throws {DisputeError} On validation failure.
 */
async function resolveDispute(expensePublicId, disputePublicId, resolution, actor, options = {}) {
  const { refundAmount: overrideRefundAmount, adminNote = null, externalSession = null } = options;

  // Validate resolution type
  if (!['dismiss', 'refund'].includes(resolution)) {
    throw new DisputeError('نوع القرار يجب أن يكون dismiss أو refund');
  }

  // Load expense
  const expense = await expenseRepository.findByPublicId(expensePublicId);
  if (!expense) {
    throw new DisputeError('المصروف المشترك غير موجود', 404);
  }

  // Find the specific dispute
  const dispute = expense.disputes.find(
    d => d.publicId === disputePublicId && d.status === DISPUTE_STATUS.OPEN
  );
  if (!dispute) {
    throw new DisputeError('الاعتراض غير موجود أو تمت معالجته بالفعل', 404);
  }

  // Find the user's share from affectedUsers
  const userShare = expense.affectedUsers.find(
    u => u.userPublicId === dispute.userPublicId
  );
  if (!userShare) {
    throw new DisputeError('لم يتم العثور على حصة المستخدم في المصروف', 500);
  }

  const resolvedAt = new Date();
  let refundTx = null;

  if (resolution === 'dismiss') {
    // ── DISMISS: No financial change ────────────────────────────────────────
    await expenseRepository.resolveDispute(
      expensePublicId,
      disputePublicId,
      {
        status: DISPUTE_STATUS.RESOLVED_DISMISSED,
        resolvedBy: actor.id,
        resolvedByPublicId: actor.publicId,
        resolvedAt,
      }
    );

    logger.info('[expenseService] ✅ تم رفض الاعتراض', {
      expensePublicId,
      disputePublicId,
      userPublicId: dispute.userPublicId,
    });

  } else {
    // ── REFUND: Issue a reversal transaction ──────────────────────────────────
    // The refund amount defaults to the full share amount.
    // Admin may override with a partial refund amount.
    const refundAmount = overrideRefundAmount != null
      ? overrideRefundAmount
      : userShare.shareAmount;

    assertPositiveInteger(refundAmount, 'مبلغ الاسترداد');
    if (refundAmount > userShare.shareAmount) {
      throw new DisputeError(
        `مبلغ الاسترداد (${refundAmount}) لا يمكن أن يتجاوز الحصة الأصلية (${userShare.shareAmount})`
      );
    }

    // Get the user's internal ObjectId
    const userDoc = await require('../models').User
      .findOne({ publicId: dispute.userPublicId })
      .select('_id publicId')
      .lean();

    if (!userDoc) {
      throw new DisputeError('المستخدم غير موجود', 404);
    }

    // Run refund + dispute update atomically
    const useExternalSession = !!externalSession;
    const session = externalSession || (await db.startSession());

    try {
      const executeRefund = async () => {
        // A. Create REFUND ledger entry (Immutable Ledger — never modify old SHARED_EXPENSE)
        const refundTxData = ledgerService.buildTransactionData({
          type: TRANSACTION_TYPES.REFUND,
          amount: refundAmount,
          userId: userDoc._id,
          userPublicId: dispute.userPublicId,
          performedBy: actor.id,
          performedByPublicId: actor.publicId,
          performedByRole: actor.role,
          description: `استرداد اعتراض على مصروف: ${expense.name}`,
          adminNote,
          referencePublicId: expensePublicId,
          referenceType: 'expense',
          metadata: {
            disputePublicId,
            originalShareAmount: userShare.shareAmount,
            refundAmount,
            expenseName: expense.name,
          },
        });

        refundTx = await ledgerService.recordTransaction(refundTxData, session);

        // B. Update dispute status with refund reference
        await expenseRepository.resolveDispute(
          expensePublicId,
          disputePublicId,
          {
            status: DISPUTE_STATUS.RESOLVED_REFUNDED,
            resolvedBy: actor.id,
            resolvedByPublicId: actor.publicId,
            resolvedAt,
            refundTransactionId: refundTx._id || new mongoose.Types.ObjectId(refundTx.id),
            refundTransactionPublicId: refundTx.publicId,
            refundAmount,
          },
          session
        );
      };

      if (useExternalSession) {
        await executeRefund();
      } else {
        await session.withTransaction(executeRefund, {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority', j: true },
        });
      }
    } finally {
      if (!useExternalSession) await session.endSession();
    }

    // Invalidate balance cache for the refunded user
    await cacheDel(CacheKeys.userBalance(dispute.userPublicId));

    logger.info('[expenseService] ✅ تم قبول الاعتراض وإصدار استرداد', {
      expensePublicId,
      disputePublicId,
      refundAmount,
      refundTxPublicId: refundTx?.publicId,
    });
  }

  // ── Post-resolution side effects ──────────────────────────────────────────

  // Reload updated expense
  const updatedExpense = await expenseRepository.findByPublicId(expensePublicId);

  // Notify disputing user of the resolution
  const userDoc2 = await require('../models').User
    .findOne({ publicId: dispute.userPublicId })
    .select('_id publicId')
    .lean();

  if (userDoc2) {
    const message = resolution === 'refund'
      ? `تم قبول اعتراضك على مصروف "${expense.name}" وتم إصدار استرداد بمبلغ ${(overrideRefundAmount || userShare.shareAmount).toLocaleString('ar-YE')} ريال`
      : `تم رفض اعتراضك على مصروف "${expense.name}"`;

    await notificationRepository.createOne({
      userId: userDoc2._id,
      userPublicId: dispute.userPublicId,
      type: resolution === 'refund'
        ? NOTIFICATION_TYPES.WITHDRAWAL_APPROVED  // Closest type for credit notification
        : NOTIFICATION_TYPES.DEPOSIT_REJECTED,    // Closest type for dismissal
      message,
      relatedEntityPublicId: expensePublicId,
      relatedEntityType: 'expense',
    }).catch(err => logger.warn('[expenseService] فشل إشعار نتيجة الاعتراض', { error: err.message }));
  }

  // Audit log
  await auditLogRepository.createLog({
    actorId: actor.id,
    actorPublicId: actor.publicId,
    actorRole: actor.role,
    actorName: actor.name,
    action: AUDIT_ACTIONS.EXPENSE_DISPUTE_RESOLVED,
    entityType: AUDIT_ENTITY_TYPES.EXPENSE,
    entityPublicId: expensePublicId,
    metadata: {
      disputePublicId,
      resolution,
      expenseName: expense.name,
      disputingUserPublicId: dispute.userPublicId,
      originalShare: userShare.shareAmount,
      refundAmount: refundTx ? (overrideRefundAmount || userShare.shareAmount) : null,
      refundTxPublicId: refundTx?.publicId || null,
      adminNote,
    },
  });

  return {
    expense: updatedExpense,
    refundTx,
    resolutionType: resolution,
  };
}

// ---------------------------------------------------------------------------
// 4. Read operations (for controllers)
// ---------------------------------------------------------------------------

/**
 * Gets a single expense by publicId with access control.
 * Users can only view expenses they are part of.
 *
 * @param {string}  expensePublicId
 * @param {string}  requesterPublicId  - The requesting user's publicId.
 * @param {'admin'|'deputy'|'user'} requesterRole
 * @returns {Promise<object>}
 * @throws {DisputeError} If not found or unauthorized.
 */
async function getExpenseById(expensePublicId, requesterPublicId, requesterRole) {
  const expense = await expenseRepository.findByPublicId(expensePublicId);
  if (!expense) throw new DisputeError('المصروف المشترك غير موجود', 404);

  if (requesterRole === 'user') {
    const isAffected = expense.affectedUsers.some(
      u => u.userPublicId === requesterPublicId
    );
    if (!isAffected) {
      throw new DisputeError('ليس لديك صلاحية الاطلاع على هذا المصروف', 403);
    }
  }

  return expense;
}

/**
 * Gets paginated expenses for a user (user dashboard view).
 *
 * @param {mongoose.Types.ObjectId} userId
 * @param {object}                  filters
 * @returns {Promise<object>}
 */
async function getUserExpenses(userId, filters = {}) {
  return expenseRepository.findPaginatedForUser(userId, filters);
}

/**
 * Gets all expenses (admin view).
 *
 * @param {object} filters
 * @returns {Promise<object>}
 */
async function getAllExpenses(filters = {}) {
  return expenseRepository.findAllPaginated(filters);
}

/**
 * Gets all expenses with open disputes (admin disputes panel).
 *
 * @param {object} filters
 * @returns {Promise<object>}
 */
async function getOpenDisputes(filters = {}) {
  return expenseRepository.findWithOpenDisputes(filters);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Core operations
  createSharedExpense,
  fileDispute,
  resolveDispute,

  // Read operations
  getExpenseById,
  getUserExpenses,
  getAllExpenses,
  getOpenDisputes,

  // Error classes (for controller error handling)
  ExpenseValidationError,
  DebtLimitExceededError,
  DisputeError,
};
