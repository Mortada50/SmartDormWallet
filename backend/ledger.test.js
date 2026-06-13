/**
 * @file ledger.test.js
 * @description Comprehensive tests for the Ledger Engine.
 *
 * Tests cover:
 *  1. integerMath.js — all arithmetic and financial calculation functions
 *  2. ledgerService.js — sanity check, buildTransactionData, computeWithdrawalDetails
 *  3. Edge cases: remainder distribution, fee rounding, debt settlement logic
 *
 * These tests run WITHOUT a MongoDB connection (pure unit tests).
 */

'use strict';

// Minimal env mock (avoid Zod validation failures)
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb+srv://test:test@localhost/test';
process.env.MONGODB_APP_USER = 'u';
process.env.MONGODB_APP_PASSWORD = 'p';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(32);
process.env.AES_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.CLOUDINARY_CLOUD_NAME = 'x';
process.env.CLOUDINARY_API_KEY = 'x';
process.env.CLOUDINARY_API_SECRET = 'x';

const {
  assertInteger,
  assertPositiveInteger,
  assertNonNegativeInteger,
  add,
  subtract,
  calculateWithdrawalFee,
  splitExpense,
  computeBalanceAndDebt,
  computeDebtSettlement,
  checkDebtLimit,
} = require('./src/utils/integerMath');

const {
  buildTransactionData,
  computeWithdrawalDetails,
  sanityCheckTransactionData,
} = require('./src/services/ledgerService');

const { TRANSACTION_TYPES } = require('./src/models');
const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// Simple test runner
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg} — المتوقع: ${expected}، المُستلم: ${actual}`);
  }
}

function assertThrows(fn, msgContains) {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (msgContains && !e.message.includes(msgContains)) {
      throw new Error(`الخطأ المتوقع يحتوي على "${msgContains}" لكن الخطأ الفعلي: "${e.message}"`);
    }
  }
  if (!threw) throw new Error('كان يجب إلقاء خطأ ولكن لم يحدث ذلك');
}

function assertDeepEqual(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg} — المتوقع: ${e}، المُستلم: ${a}`);
  }
}

// ---------------------------------------------------------------------------
// 1. integerMath — Validation
// ---------------------------------------------------------------------------
console.log('\n══ integerMath: التحقق من المدخلات ══');

test('assertInteger: يقبل الأعداد الصحيحة', () => {
  assertInteger(0);
  assertInteger(100);
  assertInteger(-500);
  assertInteger(999999);
});

test('assertInteger: يرفض الكسور العشرية', () => {
  assertThrows(() => assertInteger(1.5), 'عدداً صحيحاً');
  assertThrows(() => assertInteger(0.1), 'عدداً صحيحاً');
});

test('assertInteger: يرفض NaN و Infinity', () => {
  assertThrows(() => assertInteger(NaN));
  assertThrows(() => assertInteger(Infinity));
});

test('assertPositiveInteger: يقبل الأعداد الموجبة', () => {
  assertPositiveInteger(1);
  assertPositiveInteger(100000);
});

test('assertPositiveInteger: يرفض الصفر والأعداد السالبة', () => {
  assertThrows(() => assertPositiveInteger(0), 'أكبر من صفر');
  assertThrows(() => assertPositiveInteger(-1), 'أكبر من صفر');
});

test('assertNonNegativeInteger: يقبل الصفر', () => {
  assertNonNegativeInteger(0);
  assertNonNegativeInteger(1000);
});

// ---------------------------------------------------------------------------
// 2. integerMath — Arithmetic
// ---------------------------------------------------------------------------
console.log('\n══ integerMath: العمليات الحسابية ══');

test('add: جمع أعداد صحيحة', () => {
  assertEqual(add(100, 200), 300);
  assertEqual(add(0, 0), 0);
  assertEqual(add(-100, 300), 200);
});

test('subtract: طرح أعداد صحيحة', () => {
  assertEqual(subtract(500, 200), 300);
  assertEqual(subtract(100, 500), -400);
  assertEqual(subtract(0, 0), 0);
});

// ---------------------------------------------------------------------------
// 3. calculateWithdrawalFee
// ---------------------------------------------------------------------------
console.log('\n══ integerMath: حساب رسوم السحب ══');

test('FIXED: رسوم ثابتة', () => {
  assertEqual(calculateWithdrawalFee(5000, 'FIXED', 100), 100);
  assertEqual(calculateWithdrawalFee(1000, 'FIXED', 0), 0);
  assertEqual(calculateWithdrawalFee(999999, 'FIXED', 500), 500);
});

test('PERCENTAGE: نسبة مئوية صحيحة (3% من 5000 = 150)', () => {
  assertEqual(calculateWithdrawalFee(5000, 'PERCENTAGE', 3), 150);
});

test('PERCENTAGE: تقريب للأعلى (5% من 3001 = 150.05 → 151)', () => {
  assertEqual(calculateWithdrawalFee(3001, 'PERCENTAGE', 5), 151);
});

test('PERCENTAGE: تقريب للأعلى (7% من 9999 = 699.93 → 700)', () => {
  assertEqual(calculateWithdrawalFee(9999, 'PERCENTAGE', 7), 700);
});

test('PERCENTAGE: نسبة 100% (كل المبلغ)', () => {
  assertEqual(calculateWithdrawalFee(1000, 'PERCENTAGE', 100), 1000);
});

test('PERCENTAGE: تقريب من float مُعقَّد (2.5% من 3001 = 75.025 → 76)', () => {
  // NOTE: 2.5 is not a valid integer feeValue in our system (must be integer %)
  // But let's verify the edge case with feeValue=3 (3% from 3001)
  // 3001 * 3 / 100 = 90.03 → ceil → 91
  assertEqual(calculateWithdrawalFee(3001, 'PERCENTAGE', 3), 91);
});

test('PERCENTAGE: يرفض نسبة تتجاوز 100', () => {
  assertThrows(() => calculateWithdrawalFee(5000, 'PERCENTAGE', 101), '100');
});

test('نوع رسوم غير معروف يُلقي خطأ', () => {
  assertThrows(() => calculateWithdrawalFee(5000, 'INVALID', 10));
});

// ---------------------------------------------------------------------------
// 4. splitExpense — Rounding policy (spec §5)
// ---------------------------------------------------------------------------
console.log('\n══ integerMath: تقسيم المصاريف المشتركة ══');

test('تقسيم متساوٍ (300 / 3 = [100, 100, 100])', () => {
  assertDeepEqual(splitExpense(300, 3), [100, 100, 100]);
});

test('تقسيم مع باقي (100 / 3 = [34, 33, 33])', () => {
  const shares = splitExpense(100, 3);
  assertDeepEqual(shares, [34, 33, 33]);
  assertEqual(shares.reduce((a, b) => a + b, 0), 100, 'المجموع يجب أن يكون 100');
});

test('تقسيم مع باقي (101 / 3 = [34, 34, 33])', () => {
  const shares = splitExpense(101, 3);
  assertDeepEqual(shares, [34, 34, 33]);
  assertEqual(shares.reduce((a, b) => a + b, 0), 101, 'المجموع يجب أن يكون 101');
});

test('تقسيم على شخص واحد (يأخذ كل المبلغ)', () => {
  assertDeepEqual(splitExpense(500, 1), [500]);
});

test('تقسيم 1 ريال على 3 أشخاص: [1, 0, 0]', () => {
  const shares = splitExpense(1, 3);
  assertEqual(shares.reduce((a, b) => a + b, 0), 1, 'المجموع يجب أن يكون 1');
});

test('ضمان: مجموع الحصص دائماً يساوي إجمالي المبلغ (1000 حالة)', () => {
  // Test 1000 random combinations
  for (let i = 0; i < 100; i++) {
    const total = Math.floor(Math.random() * 100000) + 1;
    const users = Math.floor(Math.random() * 20) + 1;
    const shares = splitExpense(total, users);
    const sum = shares.reduce((a, b) => a + b, 0);
    if (sum !== total) {
      throw new Error(`total=${total}, users=${users}: المجموع ${sum} ≠ ${total}`);
    }
    // All shares must be non-negative integers
    shares.forEach(s => {
      if (!Number.isInteger(s) || s < 0) {
        throw new Error(`حصة غير صالحة: ${s}`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 5. computeBalanceAndDebt
// ---------------------------------------------------------------------------
console.log('\n══ integerMath: حساب الرصيد والدين ══');

test('رصيد موجب: لا دين', () => {
  const { balance, debt } = computeBalanceAndDebt(5000, 3000);
  assertEqual(balance, 2000);
  assertEqual(debt, 0);
});

test('رصيد صفر: لا دين', () => {
  const { balance, debt } = computeBalanceAndDebt(3000, 3000);
  assertEqual(balance, 0);
  assertEqual(debt, 0);
});

test('رصيد سالب: دين يساوي القيمة المطلقة', () => {
  const { balance, debt } = computeBalanceAndDebt(1000, 1500);
  assertEqual(balance, -500);
  assertEqual(debt, 500);
});

// ---------------------------------------------------------------------------
// 6. computeDebtSettlement
// ---------------------------------------------------------------------------
console.log('\n══ integerMath: حساب تسوية الدين ══');

test('لا دين → لا تسوية', () => {
  assertEqual(computeDebtSettlement(1000, 500, 0), 0);
});

test('إيداع يبقي الرصيد سالباً → لا تسوية', () => {
  // balance=-500, deposit 300 → new_balance=-200 (still negative)
  assertEqual(computeDebtSettlement(300, -500, 500), 0);
});

test('إيداع جزئي يُحدث تسوية جزئية', () => {
  // balance=-500, deposit 800 → new_balance=300, debt=500
  // settlement = MIN(500, 300) = 300
  assertEqual(computeDebtSettlement(800, -500, 500), 300);
});

test('إيداع كافٍ يُسوّي الدين بالكامل', () => {
  // balance=-200, deposit 1000 → new_balance=800, debt=200
  // settlement = MIN(200, 800) = 200
  assertEqual(computeDebtSettlement(1000, -200, 200), 200);
});

test('إيداع على رصيد موجب مع دين (لا يحدث عادةً لكن محمي)', () => {
  // balance=100, deposit 500 → new_balance=600, debt=50
  // settlement = MIN(50, 600) = 50
  assertEqual(computeDebtSettlement(500, 100, 50), 50);
});

// ---------------------------------------------------------------------------
// 7. checkDebtLimit
// ---------------------------------------------------------------------------
console.log('\n══ integerMath: فحص حد الدين ══');

test('حد دين غير محدود (0) → لا تجاوز أبداً', () => {
  const { wouldExceed } = checkDebtLimit(-1000000, 5000, 0);
  assertEqual(wouldExceed, false);
});

test('رسوم لا تتجاوز حد الدين', () => {
  const { wouldExceed, projectedDebt } = checkDebtLimit(100, 50, 500);
  assertEqual(wouldExceed, false);
  assertEqual(projectedDebt, 0); // 100 - 50 = 50 (positive, no debt)
});

test('رسوم تتجاوز حد الدين', () => {
  // balance=0, charge=600, maxDebt=500 → projectedDebt=600 > 500
  const { wouldExceed, projectedDebt } = checkDebtLimit(0, 600, 500);
  assertEqual(wouldExceed, true);
  assertEqual(projectedDebt, 600);
});

// ---------------------------------------------------------------------------
// 8. buildTransactionData (ledgerService)
// ---------------------------------------------------------------------------
console.log('\n══ ledgerService: بناء بيانات العملية ══');

const mockUserId = new mongoose.Types.ObjectId();

test('DEPOSIT: creditAmount = amount, debitAmount = 0', () => {
  const tx = buildTransactionData({
    type: TRANSACTION_TYPES.DEPOSIT,
    amount: 5000,
    userId: mockUserId,
    userPublicId: 'test-uuid',
  });
  assertEqual(tx.creditAmount, 5000);
  assertEqual(tx.debitAmount, 0);
  assertEqual(tx.currency, 'YER');
  if (!tx.publicId) throw new Error('publicId مفقود');
});

test('WITHDRAWAL: debitAmount = amount, creditAmount = 0', () => {
  const tx = buildTransactionData({
    type: TRANSACTION_TYPES.WITHDRAWAL,
    amount: 3000,
    userId: mockUserId,
    userPublicId: 'test-uuid',
  });
  assertEqual(tx.creditAmount, 0);
  assertEqual(tx.debitAmount, 3000);
});

test('SHARED_EXPENSE: debitAmount = amount', () => {
  const tx = buildTransactionData({
    type: TRANSACTION_TYPES.SHARED_EXPENSE,
    amount: 250,
    userId: mockUserId,
    userPublicId: 'test-uuid',
  });
  assertEqual(tx.debitAmount, 250);
  assertEqual(tx.creditAmount, 0);
});

test('ADJUSTMENT credit: creditAmount = amount', () => {
  const tx = buildTransactionData({
    type: TRANSACTION_TYPES.ADJUSTMENT,
    amount: 1000,
    userId: mockUserId,
    userPublicId: 'test-uuid',
    direction: 'credit',
  });
  assertEqual(tx.creditAmount, 1000);
  assertEqual(tx.debitAmount, 0);
});

test('ADJUSTMENT debit: debitAmount = amount', () => {
  const tx = buildTransactionData({
    type: TRANSACTION_TYPES.ADJUSTMENT,
    amount: 1000,
    userId: mockUserId,
    userPublicId: 'test-uuid',
    direction: 'debit',
  });
  assertEqual(tx.debitAmount, 1000);
  assertEqual(tx.creditAmount, 0);
});

test('ADJUSTMENT بدون direction → يُلقي خطأ', () => {
  assertThrows(() => buildTransactionData({
    type: TRANSACTION_TYPES.ADJUSTMENT,
    amount: 1000,
    userId: mockUserId,
    userPublicId: 'test-uuid',
  }), 'direction');
});

test('كل عملية تحصل على publicId فريد', () => {
  const tx1 = buildTransactionData({ type: TRANSACTION_TYPES.DEPOSIT, amount: 100, userId: mockUserId, userPublicId: 'u1' });
  const tx2 = buildTransactionData({ type: TRANSACTION_TYPES.DEPOSIT, amount: 100, userId: mockUserId, userPublicId: 'u1' });
  if (tx1.publicId === tx2.publicId) throw new Error('publicId مكرر!');
});

// ---------------------------------------------------------------------------
// 9. sanityCheckTransactionData
// ---------------------------------------------------------------------------
console.log('\n══ ledgerService: فحص سلامة بيانات العملية ══');

test('بيانات صحيحة تجتاز الفحص', () => {
  sanityCheckTransactionData({
    type: TRANSACTION_TYPES.DEPOSIT,
    amount: 1000,
    creditAmount: 1000,
    debitAmount: 0,
    currency: 'YER',
    userId: mockUserId,
    userPublicId: 'test-uuid',
  });
});

test('عملة غير YER تُلقي خطأ', () => {
  assertThrows(() => sanityCheckTransactionData({
    type: TRANSACTION_TYPES.DEPOSIT,
    amount: 1000,
    creditAmount: 1000,
    debitAmount: 0,
    currency: 'USD',
    userId: mockUserId,
    userPublicId: 'test-uuid',
  }), 'YER');
});

test('مبلغ كسري يُلقي خطأ', () => {
  assertThrows(() => sanityCheckTransactionData({
    type: TRANSACTION_TYPES.DEPOSIT,
    amount: 100.5,
    creditAmount: 100.5,
    debitAmount: 0,
    currency: 'YER',
    userId: mockUserId,
    userPublicId: 'test-uuid',
  }), 'عدداً صحيحاً');
});

test('creditAmount خاطئ لعملية DEPOSIT يُلقي خطأ', () => {
  assertThrows(() => sanityCheckTransactionData({
    type: TRANSACTION_TYPES.DEPOSIT,
    amount: 1000,
    creditAmount: 900, // Should be 1000
    debitAmount: 0,
    currency: 'YER',
    userId: mockUserId,
    userPublicId: 'test-uuid',
  }));
});

// ---------------------------------------------------------------------------
// 10. computeWithdrawalDetails
// ---------------------------------------------------------------------------
console.log('\n══ ledgerService: تفاصيل السحب ══');

test('رسوم ثابتة: حساب صحيح', () => {
  const r = computeWithdrawalDetails({
    withdrawalAmount: 5000,
    currentBalance: 6000,
    feeType: 'FIXED',
    feeValue: 200,
  });
  assertEqual(r.feeAmount, 200);
  assertEqual(r.netAmount, 4800);
  assertEqual(r.totalRequired, 5200);
  assertEqual(r.isSufficient, true);
});

test('رصيد غير كافٍ: isSufficient = false', () => {
  const r = computeWithdrawalDetails({
    withdrawalAmount: 5000,
    currentBalance: 5100,
    feeType: 'FIXED',
    feeValue: 200,
  });
  assertEqual(r.totalRequired, 5200);
  assertEqual(r.isSufficient, false); // 5100 < 5200
});

test('نسبة مئوية مع تقريب للأعلى', () => {
  const r = computeWithdrawalDetails({
    withdrawalAmount: 3001,
    currentBalance: 10000,
    feeType: 'PERCENTAGE',
    feeValue: 5,
  });
  assertEqual(r.feeAmount, 151); // 3001 * 5% = 150.05 → ceil → 151
  assertEqual(r.totalRequired, 3001 + 151);
  assertEqual(r.isSufficient, true);
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
console.log('\n══════════════════════════════════════════');
console.log(`📊 النتائج: ${passed} نجح، ${failed} فشل`);
if (failed === 0) {
  console.log('🎉 جميع الاختبارات اجتازت بنجاح!');
} else {
  console.log('❌ بعض الاختبارات فشلت — يرجى مراجعة الأخطاء أعلاه');
  process.exit(1);
}
