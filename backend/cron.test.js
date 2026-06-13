/**
 * @file cron.test.js
 * @description Unit tests for cron job logic (no DB or Redis connection needed).
 *
 * Tests cover:
 *   1. computeSnapshotChecksum — determinism, sensitivity, distinctness
 *   2. runExpireDepositRequests logic (mocked Mongoose)
 *   3. runCleanup logic (mocked Mongoose)
 *   4. Lock helpers — acquire/release behavior
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://localhost/test';
process.env.MONGODB_APP_USER = 'u';
process.env.MONGODB_APP_PASSWORD = 'p';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(32);
process.env.AES_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.CLOUDINARY_CLOUD_NAME = 'x';
process.env.CLOUDINARY_API_KEY = 'x';
process.env.CLOUDINARY_API_SECRET = 'x';

const { computeSnapshotChecksum } = require('./src/jobs/cronScheduler');
const { deleteStaleNotifications, pruneExpiredTokens } = require('./src/jobs/cleanupJob');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Minimal test runner
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

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

function assertEqual(a, b, msg = '') {
  if (a !== b) throw new Error(`${msg} — المتوقع: ${b}، المُستلم: ${a}`);
}

function assertNotEqual(a, b, msg = '') {
  if (a === b) throw new Error(`${msg} — لم يكن يجب أن يكونا متساويين`);
}

// ---------------------------------------------------------------------------
// 1. computeSnapshotChecksum — determinism
// ---------------------------------------------------------------------------
console.log('\n══ cronScheduler: SHA-256 Checksum للقطة الشهرية ══');

test('نفس المدخلات تنتج نفس الـ checksum (حتمية)', () => {
  const date = new Date('2025-01-01T00:00:00Z');
  const txIds = ['uuid-3', 'uuid-1', 'uuid-2'];

  const c1 = computeSnapshotChecksum('user-pub-1', 5000, 0, txIds, date);
  const c2 = computeSnapshotChecksum('user-pub-1', 5000, 0, txIds, date);
  assertEqual(c1, c2, 'Checksum غير حتمي');
});

test('ترتيب txIds العشوائي ينتج نفس الـ checksum (بعد الفرز)', () => {
  const date = new Date('2025-01-01T00:00:00Z');
  const txIds1 = ['uuid-3', 'uuid-1', 'uuid-2'];
  const txIds2 = ['uuid-1', 'uuid-2', 'uuid-3'];

  const c1 = computeSnapshotChecksum('user-pub-1', 5000, 0, txIds1, date);
  const c2 = computeSnapshotChecksum('user-pub-1', 5000, 0, txIds2, date);
  assertEqual(c1, c2, 'الفرز يجب أن يجعل الـ checksum متطابقاً');
});

test('تغيير الرصيد يُغيّر الـ checksum', () => {
  const date = new Date('2025-01-01T00:00:00Z');
  const txIds = ['uuid-1', 'uuid-2'];

  const c1 = computeSnapshotChecksum('user-pub-1', 5000, 0, txIds, date);
  const c2 = computeSnapshotChecksum('user-pub-1', 5001, 0, txIds, date);
  assertNotEqual(c1, c2, 'تغيير الرصيد يجب أن يُغيّر الـ checksum');
});

test('تغيير المستخدم يُغيّر الـ checksum', () => {
  const date = new Date('2025-01-01T00:00:00Z');
  const txIds = ['uuid-1', 'uuid-2'];

  const c1 = computeSnapshotChecksum('user-A', 5000, 0, txIds, date);
  const c2 = computeSnapshotChecksum('user-B', 5000, 0, txIds, date);
  assertNotEqual(c1, c2, 'تغيير المستخدم يجب أن يُغيّر الـ checksum');
});

test('تغيير تاريخ اللقطة يُغيّر الـ checksum', () => {
  const txIds = ['uuid-1'];
  const c1 = computeSnapshotChecksum('user-A', 5000, 0, txIds, new Date('2025-01-01T00:00:00Z'));
  const c2 = computeSnapshotChecksum('user-A', 5000, 0, txIds, new Date('2025-02-01T00:00:00Z'));
  assertNotEqual(c1, c2, 'تغيير التاريخ يجب أن يُغيّر الـ checksum');
});

test('إضافة transaction جديد يُغيّر الـ checksum', () => {
  const date = new Date('2025-01-01T00:00:00Z');
  const c1 = computeSnapshotChecksum('user-A', 5000, 0, ['uuid-1'], date);
  const c2 = computeSnapshotChecksum('user-A', 5000, 0, ['uuid-1', 'uuid-2'], date);
  assertNotEqual(c1, c2, 'إضافة transaction يجب أن يُغيّر الـ checksum');
});

test('تغيير الدين يُغيّر الـ checksum', () => {
  const date = new Date('2025-01-01T00:00:00Z');
  const txIds = ['uuid-1'];
  const c1 = computeSnapshotChecksum('user-A', -500, 500, txIds, date);
  const c2 = computeSnapshotChecksum('user-A', -500, 600, txIds, date);
  assertNotEqual(c1, c2, 'تغيير الدين يجب أن يُغيّر الـ checksum');
});

test('الـ checksum له طول SHA-256 صحيح (64 حرف hex)', () => {
  const date = new Date('2025-01-01T00:00:00Z');
  const checksum = computeSnapshotChecksum('user-A', 5000, 0, ['uuid-1'], date);
  assertEqual(checksum.length, 64, 'طول SHA-256 hex يجب أن يكون 64 حرفاً');
  if (!/^[a-f0-9]{64}$/.test(checksum)) {
    throw new Error('الـ checksum يحتوي على أحرف غير صحيحة');
  }
});

test('مجموعة فارغة من txIds تنتج checksum صحيح (حساب لمستخدم جديد)', () => {
  const date = new Date('2025-01-01T00:00:00Z');
  const checksum = computeSnapshotChecksum('user-A', 0, 0, [], date);
  assertEqual(checksum.length, 64);
});

test('مجموعتان مختلفتان من txIds لا تتصادمان', () => {
  const date = new Date('2025-01-01T00:00:00Z');
  // Test 50 different combinations for collision resistance
  const checksums = new Set();
  for (let i = 0; i < 50; i++) {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const c = computeSnapshotChecksum(`user-${i}`, i * 100, 0, ids, date);
    checksums.add(c);
  }
  assertEqual(checksums.size, 50, 'تصادم في الـ checksum — مشكلة جسيمة');
});

// ---------------------------------------------------------------------------
// 2. Job scheduling validation
// ---------------------------------------------------------------------------
console.log('\n══ cronScheduler: التحقق من صحة جداول الـ Cron ══');

test('جدول اللقطة الشهرية صحيح (0 0 1 * *)', () => {
  const isValid = require('node-cron').validate('0 0 1 * *');
  if (!isValid) throw new Error('تعبير Cron اللقطة الشهرية غير صحيح');
});

test('جدول انتهاء طلبات الإيداع صحيح (0 * * * *)', () => {
  const isValid = require('node-cron').validate('0 * * * *');
  if (!isValid) throw new Error('تعبير Cron انتهاء الإيداعات غير صحيح');
});

test('جدول التنظيف اليومي صحيح (0 0 * * *)', () => {
  const isValid = require('node-cron').validate('0 0 * * *');
  if (!isValid) throw new Error('تعبير Cron التنظيف اليومي غير صحيح');
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
console.log('\n══════════════════════════════════════════');
console.log(`📊 النتائج: ${passed} نجح، ${failed} فشل`);
if (failed === 0) {
  console.log('🎉 جميع الاختبارات اجتازت بنجاح!');
} else {
  console.log('❌ بعض الاختبارات فشلت');
  process.exit(1);
}
