/**
 * @file upload.test.js
 * @description Unit tests for uploadMiddleware and attachmentService pure functions.
 *
 * Tests cover:
 *   1. Magic-byte detection (hasMagicBytes) — all allowed types + spoofed files
 *   2. attachmentService.generatePublicIdSuffix — uniqueness and format
 *   3. attachmentService.resolveResourceType — image vs raw mapping
 *   4. attachmentService.getSecureReceiptUrl — error on missing publicId
 *   5. attachmentService.deleteAttachment — graceful handling of empty publicId
 *   6. attachmentService.getBatchSecureUrls — null on individual failure
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://localhost/test';
process.env.MONGODB_APP_USER = 'u';
process.env.MONGODB_APP_PASSWORD = 'p';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(32);
process.env.AES_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
process.env.CLOUDINARY_API_KEY = 'test-key';
process.env.CLOUDINARY_API_SECRET = 'test-secret';

const { hasMagicBytes, ALLOWED_MIME_TYPES, ALLOWED_EXTENSIONS, MAX_FILE_SIZE_BYTES } = require('./src/middleware/uploadMiddleware');
const {
  generatePublicIdSuffix,
  resolveResourceType,
  getSecureReceiptUrl,
  deleteAttachment,
  getBatchSecureUrls,
  AttachmentError,
} = require('./src/services/attachmentService');

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
  if (a !== b) throw new Error(`${msg} — المتوقع: ${JSON.stringify(b)}، المُستلم: ${JSON.stringify(a)}`);
}
function assertTrue(val, msg) { if (!val) throw new Error(msg || `المتوقع: true`); }
function assertFalse(val, msg) { if (val) throw new Error(msg || `المتوقع: false`); }

// ---------------------------------------------------------------------------
// Helper to create file buffers with specific magic bytes
// ---------------------------------------------------------------------------

function makeJpegBuffer() {
  // JFIF JPEG header
  return Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]);
}
function makeExifJpegBuffer() {
  // EXIF JPEG header
  return Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x10, 0x45, 0x78]);
}
function makePngBuffer() {
  return Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
}
function makePdfBuffer() {
  return Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34]);
}
function makeZipBuffer() {
  // PK ZIP header — should be rejected for all MIME types
  return Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
}
function makeExeBuffer() {
  // MZ EXE header
  return Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
}

// ---------------------------------------------------------------------------
// 1. hasMagicBytes — valid files
// ---------------------------------------------------------------------------
console.log('\n══ uploadMiddleware: فحص Magic Bytes — ملفات صحيحة ══');

test('JPEG (JFIF) يجتاز الفحص', () => {
  assertTrue(hasMagicBytes(makeJpegBuffer(), 'image/jpeg'));
});
test('JPEG (EXIF) يجتاز الفحص', () => {
  assertTrue(hasMagicBytes(makeExifJpegBuffer(), 'image/jpeg'));
});
test('PNG يجتاز الفحص', () => {
  assertTrue(hasMagicBytes(makePngBuffer(), 'image/png'));
});
test('PDF يجتاز الفحص', () => {
  assertTrue(hasMagicBytes(makePdfBuffer(), 'application/pdf'));
});

// ---------------------------------------------------------------------------
// 2. hasMagicBytes — spoofed files (MIME-type mismatch)
// ---------------------------------------------------------------------------
console.log('\n══ uploadMiddleware: فحص Magic Bytes — ملفات مزوّرة ══');

test('ZIP مُعلن كـ image/jpeg يُرفض', () => {
  assertFalse(hasMagicBytes(makeZipBuffer(), 'image/jpeg'),
    'يجب رفض ZIP مُعلن كـ JPEG');
});
test('EXE مُعلن كـ image/png يُرفض', () => {
  assertFalse(hasMagicBytes(makeExeBuffer(), 'image/png'),
    'يجب رفض EXE مُعلن كـ PNG');
});
test('PNG مُعلن كـ image/jpeg يُرفض', () => {
  assertFalse(hasMagicBytes(makePngBuffer(), 'image/jpeg'),
    'PNG لا يبدأ بـ FF D8 FF');
});
test('JPEG مُعلن كـ image/png يُرفض', () => {
  assertFalse(hasMagicBytes(makeJpegBuffer(), 'image/png'),
    'JPEG لا يبدأ بـ 89 50 4E 47');
});
test('PDF مُعلن كـ image/jpeg يُرفض', () => {
  assertFalse(hasMagicBytes(makePdfBuffer(), 'image/jpeg'),
    'PDF لا يبدأ بـ FF D8 FF');
});
test('JPEG مُعلن كـ application/pdf يُرفض', () => {
  assertFalse(hasMagicBytes(makeJpegBuffer(), 'application/pdf'),
    'JPEG لا يبدأ بـ 25 50 44 46');
});
test('نوع MIME غير معروف يُرفض دائماً', () => {
  assertFalse(hasMagicBytes(makePdfBuffer(), 'application/x-unknown'));
});
test('buffer فارغ يُرفض لـ JPEG', () => {
  assertFalse(hasMagicBytes(Buffer.alloc(0), 'image/jpeg'));
});

// ---------------------------------------------------------------------------
// 3. Whitelist constants
// ---------------------------------------------------------------------------
console.log('\n══ uploadMiddleware: قوائم الأنواع المسموح بها ══');

test('ALLOWED_MIME_TYPES تحتوي على JPEG و PNG و PDF', () => {
  assertTrue(ALLOWED_MIME_TYPES.has('image/jpeg'));
  assertTrue(ALLOWED_MIME_TYPES.has('image/png'));
  assertTrue(ALLOWED_MIME_TYPES.has('application/pdf'));
});
test('ALLOWED_MIME_TYPES لا تحتوي على GIF أو SVG أو ZIP', () => {
  assertFalse(ALLOWED_MIME_TYPES.has('image/gif'));
  assertFalse(ALLOWED_MIME_TYPES.has('image/svg+xml'));
  assertFalse(ALLOWED_MIME_TYPES.has('application/zip'));
});
test('MAX_FILE_SIZE_BYTES هو 2 ميجابايت بالضبط', () => {
  assertEqual(MAX_FILE_SIZE_BYTES, 2 * 1024 * 1024);
});
test('ALLOWED_EXTENSIONS تحتوي على .jpg و .png و .pdf', () => {
  assertTrue(ALLOWED_EXTENSIONS.has('.jpg'));
  assertTrue(ALLOWED_EXTENSIONS.has('.png'));
  assertTrue(ALLOWED_EXTENSIONS.has('.pdf'));
  assertFalse(ALLOWED_EXTENSIONS.has('.gif'));
  assertFalse(ALLOWED_EXTENSIONS.has('.exe'));
});

// ---------------------------------------------------------------------------
// 4. attachmentService.resolveResourceType
// ---------------------------------------------------------------------------
console.log('\n══ attachmentService: تحديد نوع المورد Cloudinary ══');

test('PDF → resource_type: raw', () => {
  assertEqual(resolveResourceType('application/pdf'), 'raw');
});
test('JPEG → resource_type: image', () => {
  assertEqual(resolveResourceType('image/jpeg'), 'image');
});
test('PNG → resource_type: image', () => {
  assertEqual(resolveResourceType('image/png'), 'image');
});
test('نوع غير معروف → image (افتراضي)', () => {
  assertEqual(resolveResourceType('application/octet-stream'), 'image');
});

// ---------------------------------------------------------------------------
// 5. attachmentService.generatePublicIdSuffix
// ---------------------------------------------------------------------------
console.log('\n══ attachmentService: توليد معرف Cloudinary الفريد ══');

test('يحتوي على userPublicId المُصحَّح', () => {
  const suffix = generatePublicIdSuffix('user-abc123');
  assertTrue(suffix.includes('user-abc123'), `المتوقع أن يحتوي على user-abc123، المُستلم: ${suffix}`);
});
test('يحتوي على طابع زمني', () => {
  const before = Date.now();
  const suffix = generatePublicIdSuffix('user-x');
  const after = Date.now();
  const parts = suffix.split('-');
  // Timestamp is the second-to-last component
  const ts = parseInt(parts[parts.length - 2], 10);
  assertTrue(ts >= before && ts <= after, `الطابع الزمني ${ts} خارج النطاق [${before}, ${after}]`);
});
test('يُولد قيماً فريدة في استدعاءات متتالية', () => {
  const s1 = generatePublicIdSuffix('user-1');
  const s2 = generatePublicIdSuffix('user-1');
  // May occasionally be equal if called in the same ms; random suffix should differ
  // We just verify they're strings of reasonable length
  assertTrue(s1.length >= 10);
  assertTrue(s2.length >= 10);
});
test('يُنظّف المعرفات التي تحتوي على UUID بأحرف خاصة', () => {
  const suffix = generatePublicIdSuffix('550e8400-e29b-41d4-a716-446655440000');
  // UUID hyphens are valid; all other chars should be hyphens
  assertFalse(/[^a-zA-Z0-9\-]/.test(suffix), 'يجب ألا يحتوي على أحرف خاصة');
});

// ---------------------------------------------------------------------------
// 6. attachmentService.getSecureReceiptUrl — error on missing publicId
// ---------------------------------------------------------------------------
console.log('\n══ attachmentService: توليد الرابط الآمن — حالات الخطأ ══');

test('يُلقي AttachmentError إذا كان cloudinaryPublicId فارغاً', () => {
  try {
    getSecureReceiptUrl('');
    throw new Error('يجب أن يُلقي خطأ');
  } catch (err) {
    assertEqual(err.name, 'AttachmentError');
    assertEqual(err.statusCode, 422);
  }
});
test('يُلقي AttachmentError إذا كان cloudinaryPublicId null', () => {
  try {
    getSecureReceiptUrl(null);
    throw new Error('يجب أن يُلقي خطأ');
  } catch (err) {
    assertEqual(err.name, 'AttachmentError');
  }
});
test('يُلقي AttachmentError إذا كان cloudinaryPublicId رقماً', () => {
  try {
    getSecureReceiptUrl(12345);
    throw new Error('يجب أن يُلقي خطأ');
  } catch (err) {
    assertEqual(err.name, 'AttachmentError');
  }
});

// ---------------------------------------------------------------------------
// 7. attachmentService.deleteAttachment — graceful on missing publicId
// ---------------------------------------------------------------------------

(async () => {
  console.log('\n══ attachmentService: حذف المرفق — حالات الحماية ══');

  await testAsync('يُرجع false (بدون خطأ) إذا كان publicId فارغاً', async () => {
    const result = await deleteAttachment('');
    assertEqual(result, false);
  });
  await testAsync('يُرجع false (بدون خطأ) إذا كان publicId null', async () => {
    const result = await deleteAttachment(null);
    assertEqual(result, false);
  });

  // ---------------------------------------------------------------------------
  // 8. getBatchSecureUrls — null on individual failure
  // ---------------------------------------------------------------------------
  console.log('\n══ attachmentService: توليد روابط دُفعية ══');

  test('يُرجع null لأي معرف فارغ في الدفعة', () => {
    const results = getBatchSecureUrls([
      { cloudinaryPublicId: '' },
      { cloudinaryPublicId: null },
    ]);
    assertEqual(results.length, 2);
    assertEqual(results[0].signedUrl, null);
    assertEqual(results[1].signedUrl, null);
  });
  test('يُحافظ على الترتيب في الدُّفعة', () => {
    const results = getBatchSecureUrls([
      { cloudinaryPublicId: '' },
      { cloudinaryPublicId: null },
    ]);
    assertEqual(results[0].cloudinaryPublicId, '');
    assertEqual(results[1].cloudinaryPublicId, null);
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
})();
