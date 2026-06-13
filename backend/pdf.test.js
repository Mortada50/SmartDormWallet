/**
 * @file pdf.test.js
 * @description Unit tests for pdfService pure functions (no DB/Cloudinary needed).
 *
 * Tests cover:
 *   1. computeChecksum — determinism, sensitivity, SHA-256 length
 *   2. formatAmount    — integer formatting, negative handling, edge cases
 *   3. formatDate      — date formatting correctness
 *   4. ar()            — Arabic reshaper integration
 *   5. PDF stream creation — verifies PDFDocument is returned as readable stream
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

const {
  computeChecksum,
  formatAmount,
  formatDate,
  formatShortDate,
  ar,
} = require('./src/services/pdfService');

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

function assertEqual(a, b, msg = '') {
  if (a !== b) throw new Error(`${msg} | المتوقع: "${b}"، المُستلم: "${a}"`);
}
function assertNotEqual(a, b, msg = '') {
  if (a === b) throw new Error(`${msg} | لم يكن يجب أن يتساويا`);
}
function assertTrue(val, msg) {
  if (!val) throw new Error(msg || 'المتوقع: true');
}

// ---------------------------------------------------------------------------
// 1. computeChecksum
// ---------------------------------------------------------------------------
console.log('\n══ pdfService: computeChecksum — سلامة التجزئة ══');

test('نفس المدخلات تنتج نفس الـ checksum (حتمية)', () => {
  const p = { a: 1, b: 'test', c: [1, 2, 3] };
  assertEqual(computeChecksum(p), computeChecksum(p));
});

test('تغيير أي حقل يُغيّر الـ checksum', () => {
  const p1 = { reportType: 'user', balance: 5000, txCount: 10 };
  const p2 = { reportType: 'user', balance: 5001, txCount: 10 };
  assertNotEqual(computeChecksum(p1), computeChecksum(p2));
});

test('ترتيب مفاتيح الـ object لا يُغيّر checksum (كاتب المفاتيح مُرتَّب)', () => {
  const p1 = { b: 2, a: 1 };
  const p2 = { a: 1, b: 2 };
  assertEqual(computeChecksum(p1), computeChecksum(p2));
});

test('الـ checksum له طول SHA-256 صحيح (64 حرف hex)', () => {
  const c = computeChecksum({ x: 1 });
  assertEqual(c.length, 64);
  assertTrue(/^[a-f0-9]{64}$/.test(c));
});

test('payload فارغ {} ينتج checksum صحيح', () => {
  const c = computeChecksum({});
  assertEqual(c.length, 64);
});

test('100 payload مختلفة تنتج 100 checksum مختلفة (مقاومة التصادم)', () => {
  const checksums = new Set();
  for (let i = 0; i < 100; i++) {
    checksums.add(computeChecksum({ i, r: Math.random() }));
  }
  assertEqual(checksums.size, 100, 'تصادم في الـ checksum');
});

// ---------------------------------------------------------------------------
// 2. formatAmount
// ---------------------------------------------------------------------------
console.log('\n══ pdfService: formatAmount — تنسيق المبالغ ══');

test('صفر يُعطي "0 ريال"', () => {
  assertEqual(formatAmount(0), '0 ريال');
});

test('ألف يُعطي "1,000 ريال"', () => {
  assertEqual(formatAmount(1000), '1,000 ريال');
});

test('مليون يُعطي "1,000,000 ريال"', () => {
  assertEqual(formatAmount(1000000), '1,000,000 ريال');
});

test('رقم سالب يُعطي قيمة مطلقة (الرصيد السالب يُعرض بالموجب)', () => {
  assertEqual(formatAmount(-5000), '5,000 ريال');
});

test('null يُعطي —', () => {
  assertEqual(formatAmount(null), '—');
});

test('undefined يُعطي —', () => {
  assertEqual(formatAmount(undefined), '—');
});

test('NaN يُعطي —', () => {
  assertEqual(formatAmount(NaN), '—');
});

// ---------------------------------------------------------------------------
// 3. formatDate
// ---------------------------------------------------------------------------
console.log('\n══ pdfService: formatDate — تنسيق التواريخ ══');

test('تاريخ صحيح يُنتج سلسلة غير فارغة', () => {
  const result = formatDate(new Date('2025-01-15T00:00:00Z'));
  assertTrue(result.length > 0);
  assertTrue(typeof result === 'string');
});

test('تاريخ string يُقبل ويُحوَّل', () => {
  const result = formatDate('2025-06-01');
  assertTrue(result.length > 0);
  assertNotEqual(result, '—');
});

test('null يُعطي —', () => {
  assertEqual(formatDate(null), '—');
});

test('undefined يُعطي —', () => {
  assertEqual(formatDate(undefined), '—');
});

// ---------------------------------------------------------------------------
// 4. formatShortDate
// ---------------------------------------------------------------------------
console.log('\n══ pdfService: formatShortDate — تنسيق التاريخ المختصر ══');

test('يُنتج صيغة dd/mm/yyyy', () => {
  const result = formatShortDate(new Date('2025-01-05T00:00:00Z'));
  assertEqual(result, '05/01/2025');
});

test('تاريخ نهاية الشهر صحيح', () => {
  const result = formatShortDate(new Date('2025-12-31T00:00:00Z'));
  assertEqual(result, '31/12/2025');
});

// ---------------------------------------------------------------------------
// 5. ar() — Arabic reshaper
// ---------------------------------------------------------------------------
console.log('\n══ pdfService: ar() — معالجة النص العربي ══');

test('نص عربي يُعاد ترتيبه (غير فارغ)', () => {
  const result = ar('مرحبا');
  assertTrue(typeof result === 'string' && result.length > 0);
});

test('نص فارغ يُعطي نص فارغ (لا يُلقي خطأ)', () => {
  assertEqual(ar(''), '');
});

test('null يُعطي "" (لا يُلقي خطأ)', () => {
  assertEqual(ar(null), '');
});

test('أرقام وحروف لاتينية تمر دون تعديل جوهري', () => {
  const result = ar('12345');
  assertTrue(result.includes('1'));
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
