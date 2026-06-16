'use strict';

const { db } = require('../config');
const ledgerService = require('../services/ledgerService');
const userRepository = require('../repositories/userRepository');
const notificationRepository = require('../repositories/notificationRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const { asyncHandler } = require('../middleware/errorMiddleware');
const { User } = require('../models');
const { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, ACTOR_ROLES } = require('../models');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// GET /api/v1/transfers/lookup?accountNumber=XXXXXX
// ---------------------------------------------------------------------------

const lookup = asyncHandler(async (req, res) => {
  const { accountNumber } = req.query;

  if (!accountNumber || !/^[0-9]{6}$/.test(accountNumber)) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_ACCOUNT_NUMBER',
      message: 'رقم الحساب يجب أن يكون 6 أرقام',
    });
  }

  const recipient = await userRepository.findByAccountNumber(accountNumber);
  if (!recipient) {
    return res.status(404).json({
      success: false,
      code: 'ACCOUNT_NOT_FOUND',
      message: 'لم يتم العثور على حساب بهذا الرقم',
    });
  }

  // Prevent looking up own account
  if (recipient.publicId === req.user.publicId) {
    return res.status(422).json({
      success: false,
      code: 'SELF_TRANSFER',
      message: 'لا يمكنك التحويل لحسابك الشخصي',
    });
  }

  return res.status(200).json({
    success: true,
    data: {
      fullName: recipient.fullName,
      accountNumber: recipient.accountNumber,
      roomNumber: recipient.roomNumber || null,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/transfers/generate-account-number
// Generates account number for the current user (one-time, cannot be undone)
// ---------------------------------------------------------------------------

const generateAccountNumber = asyncHandler(async (req, res) => {
  // Check if user already has an account number
  const currentUser = await User.findOne(
    { publicId: req.user.publicId },
    { accountNumber: 1, _id: 0 }
  ).lean();

  if (currentUser?.accountNumber) {
    return res.status(409).json({
      success: false,
      code: 'ACCOUNT_NUMBER_EXISTS',
      message: 'لديك رقم حساب بالفعل، لا يمكن إنشاء رقم آخر',
      data: { accountNumber: currentUser.accountNumber },
    });
  }

  // Generate unique 6-digit account number
  let accountNumber;
  let attempts = 0;
  do {
    accountNumber = String(Math.floor(100000 + Math.random() * 900000));
    const existing = await User.findOne({ accountNumber }, { _id: 1 }).lean();
    if (!existing) break;
    attempts++;
  } while (attempts < 10);

  if (attempts >= 10) {
    return res.status(500).json({
      success: false,
      code: 'ACCOUNT_NUMBER_GENERATION_FAILED',
      message: 'فشل توليد رقم الحساب، يرجى المحاولة مرة أخرى',
    });
  }

  const updated = await User.findOneAndUpdate(
    { publicId: req.user.publicId, accountNumber: null },
    { $set: { accountNumber } },
    { new: true, lean: true, projection: { accountNumber: 1, _id: 0 } }
  );

  if (!updated) {
    return res.status(409).json({
      success: false,
      code: 'ACCOUNT_NUMBER_EXISTS',
      message: 'لديك رقم حساب بالفعل',
    });
  }

  logger.info('[transferController] تم توليد رقم حساب جديد', {
    publicId: req.user.publicId,
    accountNumber,
  });

  return res.status(201).json({
    success: true,
    data: { accountNumber },
    message: 'تم إنشاء رقم حسابك بنجاح',
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/transfers
// ---------------------------------------------------------------------------

const createTransfer = asyncHandler(async (req, res) => {
  const { accountNumber, amount, note } = req.body;

  // Validate inputs
  if (!accountNumber || !/^[0-9]{6}$/.test(accountNumber)) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_ACCOUNT_NUMBER',
      message: 'رقم الحساب يجب أن يكون 6 أرقام',
    });
  }

  const parsedAmount = parseInt(amount, 10);
  if (!parsedAmount || parsedAmount < 1 || !Number.isInteger(parsedAmount)) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_AMOUNT',
      message: 'المبلغ يجب أن يكون عدداً صحيحاً موجباً',
    });
  }

  // Prevent self-transfer
  const senderFull = await User.findOne(
    { publicId: req.user.publicId },
    { publicId: 1, fullName: 1, accountNumber: 1, status: 1 }
  ).lean();

  if (!senderFull?.accountNumber) {
    return res.status(422).json({
      success: false,
      code: 'NO_ACCOUNT_NUMBER',
      message: 'يجب إنشاء رقم حساب أولاً قبل التحويل',
    });
  }

  if (senderFull.accountNumber === accountNumber) {
    return res.status(422).json({
      success: false,
      code: 'SELF_TRANSFER',
      message: 'لا يمكنك التحويل لحسابك الشخصي',
    });
  }

  // Find recipient with _id for ledger
  const recipient = await userRepository.findByAccountNumberWithId(accountNumber);
  if (!recipient) {
    return res.status(404).json({
      success: false,
      code: 'ACCOUNT_NOT_FOUND',
      message: 'لم يتم العثور على حساب بهذا الرقم',
    });
  }

  // Run atomic transfer in a transaction session
  const session = await db.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      result = await ledgerService.processTransfer({
        sender: senderFull,
        recipient,
        amount: parsedAmount,
        note: note?.trim() || null,
        session,
      });
    });
  } finally {
    session.endSession();
  }

  // Fire-and-forget notifications
  Promise.allSettled([
    notificationRepository.createOne({
      userId: recipient._id,
      userPublicId: recipient.publicId,
      type: 'TRANSFER_IN',
      message: `استلمت تحويلاً بمبلغ ${parsedAmount} ر.ي من ${senderFull.fullName}`,
      relatedEntityPublicId: result.transferRef,
    }),
    notificationRepository.createOne({
      userId: senderFull._id,
      userPublicId: senderFull.publicId,
      type: 'TRANSFER_OUT',
      message: `تم تحويل مبلغ ${parsedAmount} ر.ي إلى ${recipient.fullName}`,
      relatedEntityPublicId: result.transferRef,
    }),
    auditLogRepository.createLog({
      actorId: senderFull._id,
      actorPublicId: senderFull.publicId,
      actorRole: req.user.role,
      actorName: senderFull.fullName,
      action: 'TRANSFER_CREATED',
      entityType: 'transfer',
      entityPublicId: result.transferRef,
      metadata: {
        toAccountNumber: accountNumber,
        recipientName: recipient.fullName,
        amount: parsedAmount,
      },
    }),
  ]).then(results => {
    results.forEach(r => {
      if (r.status === 'rejected') {
        logger.error('[transferController] Error in background task', r.reason);
      }
    });
  });

  return res.status(201).json({
    success: true,
    data: {
      transferRef: result.transferRef,
      amount: parsedAmount,
      recipientName: recipient.fullName,
      recipientAccountNumber: accountNumber,
    },
    message: `تم تحويل ${parsedAmount} ر.ي بنجاح إلى ${recipient.fullName}`,
  });
});

module.exports = { lookup, generateAccountNumber, createTransfer };
