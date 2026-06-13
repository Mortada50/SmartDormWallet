/**
 * @file pdfService.js
 * @description Financial PDF Report Generation Engine — Milestone 6.
 *
 * ██████████████████████████████████████████████████████████████████████████
 * ██  ARCHITECTURE                                                         ██
 * ██████████████████████████████████████████████████████████████████████████
 *
 * ENGINE: PDFKit v0.15+ (complex-script shaping via fontkit/HarfBuzz)
 * FONT:   Amiri Regular — a professional Arabic calligraphy-style OpenType font
 *         that PDFKit uses with full Arabic ligature and contextual form support.
 * RTL:    PDFKit handles Arabic character shaping automatically with Amiri.
 *         arabic-reshaper is used as a pre-processing fallback for edge cases.
 * STREAMING: All functions return a PDFKit Document (which IS a Readable Stream).
 *            Controllers pipe it directly to res → zero RAM buffering of PDFs.
 *
 * DOCUMENT INTEGRITY (spec §12 / §16):
 *   Every PDF page footer contains:
 *     • SHA-256 checksum derived from the financial data (NOT the PDF binary)
 *     • Generation timestamp (UTC)
 *     • Requestor's name and role
 *   This allows the recipient to verify the report's authenticity by
 *   recomputing the checksum from the same source data.
 *
 * REPORTS:
 *   1. generateUserStatement(userPublicId, startDate, endDate)
 *      → كشف حساب الطالب (Resident Account Statement)
 *   2. generateMerchantReport(merchantPublicId, startDate, endDate)
 *      → تقرير التاجر (Merchant Sales & Settlement Report)
 *   3. generateMonthlyDormReport(month)
 *      → التقرير الشهري الشامل (Monthly Dorm Financial Report)
 *   4. generateDebtReport()
 *      → كشف الديون (Outstanding Debt Ledger)
 *
 * USAGE IN CONTROLLER:
 *   const stream = await pdfService.generateUserStatement(publicId, from, to, actor);
 *   res.setHeader('Content-Type', 'application/pdf');
 *   res.setHeader('Content-Disposition', 'attachment; filename="statement.pdf"');
 *   stream.pipe(res);
 *
 * @module services/pdfService
 */

'use strict';

const path   = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const reshaper    = require('arabic-reshaper');

const { User, Transaction, MerchantTransaction, Merchant } = require('../models');
const { TRANSACTION_TYPES, CREDIT_TYPES, DEBIT_TYPES }     = require('../models');
const ledgerService      = require('./ledgerService');
const userRepository     = require('../repositories/userRepository');
const merchantRepository = require('../repositories/merchantRepository');
const logger             = require('../config/logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FONT_PATH = path.join(__dirname, '../assets/fonts/Amiri-Regular.ttf');
const FONT_NAME = 'Amiri';

/** A4 page dimensions in points (72 DPI) */
const PAGE = Object.freeze({
  width: 595.28,
  height: 841.89,
  margin: 45,
  contentWidth: 595.28 - 90,  // width - 2*margin
  footerY: 841.89 - 45,       // bottom margin
});

/** Brand color palette */
const COLOR = Object.freeze({
  primary:    '#1B3A6B',  // Dark navy blue
  accent:     '#C8960C',  // Gold
  success:    '#1B6B3A',  // Dark green (credit)
  danger:     '#8B1A1A',  // Dark red (debit/debt)
  warning:    '#7B4F00',  // Brown-orange (near-limit)
  headerBg:   '#1B3A6B',
  rowAlt:     '#F4F7FB',  // Alternating row bg
  border:     '#D0D8E8',
  text:       '#1A1A2E',
  muted:      '#5A6475',
  white:      '#FFFFFF',
  lightGold:  '#FFF8E7',
});

/** Arabic-to-English label map for transaction types */
const TX_TYPE_LABELS = Object.freeze({
  [TRANSACTION_TYPES.DEPOSIT]:          'إيداع',
  [TRANSACTION_TYPES.WITHDRAWAL]:       'سحب',
  [TRANSACTION_TYPES.WITHDRAWAL_FEE]:   'رسوم سحب',
  [TRANSACTION_TYPES.SHARED_EXPENSE]:   'مصروف مشترك',
  [TRANSACTION_TYPES.MERCHANT_PURCHASE]:'شراء من تاجر',
  [TRANSACTION_TYPES.DEBT_SETTLEMENT]:  'تسوية دين',
  [TRANSACTION_TYPES.ADJUSTMENT]:       'تعديل يدوي',
  [TRANSACTION_TYPES.REFUND]:           'استرداد',
});

// ---------------------------------------------------------------------------
// Font check
// ---------------------------------------------------------------------------

let _fontVerified = false;
function assertFont() {
  if (_fontVerified) return;
  const fs = require('fs');
  if (!fs.existsSync(FONT_PATH)) {
    logger.warn(
      '[pdfService] ⚠️  خط Amiri غير موجود — قم بتشغيل: node scripts/downloadFonts.js',
      { expectedPath: FONT_PATH }
    );
  } else {
    _fontVerified = true;
  }
}

// ---------------------------------------------------------------------------
// Arabic text helper
// ---------------------------------------------------------------------------

/**
 * Prepares Arabic text for PDFKit rendering.
 * PDFKit 0.15+ handles Arabic shaping via fontkit/HarfBuzz automatically
 * when an Arabic OpenType font is registered. arabic-reshaper is used as
 * a pre-processing safety layer for mixed or edge-case strings.
 *
 * @param {string} text
 * @returns {string}
 */
function ar(text) {
  if (!text || typeof text !== 'string') return text || '';
  try {
    const tokens = text.match(/([ \t]+|[\(\)\[\]\{\}\<\>]|[^\s\(\)\[\]\{\}\<\>]+)/g) || [];
    let reversed = tokens.reverse();
    reversed = reversed.map(t => ({'(':')', ')':'(', '[':']', ']':'[', '{':'}','}':'{','<':'>','>':'<'}[t] || t));
    return reversed.join('');
  } catch (e) {
    return text;
  }
}

/**
 * Formats an integer amount in YER with Arabic numeral separators.
 * @param {number} amount - Integer amount in YER.
 * @returns {string}      - e.g. "12,500 ريال"
 */
function formatAmount(amount) {
  if (amount == null || isNaN(amount)) return '—';
  const abs = Math.abs(amount);
  return `${abs.toLocaleString('en-US')} ريال`;
}

/**
 * Formats a JS Date as a human-readable Arabic date string.
 * @param {Date|string} date
 * @returns {string}
 */
function formatDate(date) {
  if (!date) return '—';
  const d = date instanceof Date ? date : new Date(date);
  const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Formats a JS Date as compact dd/mm/yyyy for table cells.
 * @param {Date|string} date
 * @returns {string}
 */
function formatShortDate(date) {
  if (!date) return '—';
  const d = date instanceof Date ? date : new Date(date);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// ---------------------------------------------------------------------------
// SHA-256 Checksum generator
// ---------------------------------------------------------------------------

/**
 * Computes a SHA-256 checksum from a financial data payload.
 * The checksum is derived from CONTENT (not the PDF binary) so it is
 * reproducible by re-running the same query with the same parameters.
 *
 * @param {object} payload - Structured financial data to hash.
 * @returns {string} 64-char hex SHA-256 digest.
 */
function computeChecksum(payload) {
  const normalized = JSON.stringify(payload, Object.keys(payload).sort());
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// PDFDocument factory
// ---------------------------------------------------------------------------

/**
 * Creates a configured PDFKit document with Amiri font registered.
 *
 * @param {object} [options={}]
 * @param {string} [options.reportTitle]  - Arabic report title for the header.
 * @param {string} [options.requestorName]
 * @param {string} [options.requestorRole]
 * @returns {PDFDocument}
 */
function createDoc(options = {}) {
  assertFont();

  const doc = new PDFDocument({
    size: 'A4',
    margins: {
      top: PAGE.margin,
      bottom: PAGE.margin + 30, // Extra space for footer
      left: PAGE.margin,
      right: PAGE.margin,
    },
    info: {
      Title: options.reportTitle || 'تقرير مالي — Smart Dorm Wallet',
      Author: 'Smart Dorm Wallet System',
      Creator: 'pdfService v1.0',
      Producer: 'PDFKit',
      CreationDate: new Date(),
    },
    autoFirstPage: true,
    bufferPages: true, // Needed for adding page numbers retroactively
  });

  // Register Arabic font (PDFKit 0.15+ + fontkit does the shaping)
  const fs = require('fs');
  if (fs.existsSync(FONT_PATH)) {
    doc.registerFont(FONT_NAME, FONT_PATH);
  } else {
    // Fallback: Helvetica (no Arabic shaping — prints squares for Arabic chars)
    // This should never happen in production if setup is correct
    logger.warn('[pdfService] استخدام خط افتراضي بدون دعم عربي');
  }

  return doc;
}

// ---------------------------------------------------------------------------
// Layout components
// ---------------------------------------------------------------------------

/**
 * Draws the document header with system branding and report title.
 *
 * @param {PDFDocument} doc
 * @param {object}      info
 * @param {string}      info.title      - Main Arabic report title.
 * @param {string}      info.subtitle   - Subtitle / date range.
 * @param {string}      [info.entityName] - User or merchant name.
 */
function drawHeader(doc, info) {
  const { margin } = PAGE;
  const headerH = 80;
  const y = margin - 10;

  // Background rectangle
  doc.rect(0, 0, PAGE.width, headerH + y).fill(COLOR.headerBg);

  // System name (right side)
  doc.fillColor(COLOR.white)
     .font(FONT_NAME).fontSize(18)
     .text(ar('نظام المحفظة الذكية للسكن'), margin, y + 8, {
       width: PAGE.contentWidth,
       align: 'right',
     });

  // Report title
  doc.fillColor(COLOR.accent)
     .font(FONT_NAME).fontSize(14)
     .text(ar(info.title), margin, y + 34, {
       width: PAGE.contentWidth,
       align: 'right',
     });

  // Subtitle (date range / entity)
  if (info.subtitle) {
    doc.fillColor('#CBD5E8')
       .font(FONT_NAME).fontSize(9)
       .text(ar(info.subtitle), margin, y + 57, {
         width: PAGE.contentWidth,
         align: 'right',
       });
  }

  // Gold accent bar under header
  doc.rect(0, headerH + y, PAGE.width, 3).fill(COLOR.accent);

  doc.moveDown(0.5);
  doc.y = headerH + y + 15;
}

/**
 * Draws a section divider line with Arabic heading.
 *
 * @param {PDFDocument} doc
 * @param {string}      title
 */
function drawSectionTitle(doc, title) {
  const x = PAGE.margin;
  const y = doc.y + 10;
  const w = PAGE.contentWidth;

  doc.rect(x, y, w, 22).fill(COLOR.rowAlt);
  doc.rect(x, y, 4, 22).fill(COLOR.accent);

  doc.fillColor(COLOR.primary)
     .font(FONT_NAME).fontSize(11)
     .text(ar(title), x + 8, y + 5, { width: w - 16, align: 'right',  });

  doc.y = y + 28;
}

/**
 * Draws a key-value info block (e.g. user name, date range, etc.)
 *
 * @param {PDFDocument} doc
 * @param {Array<{label: string, value: string}>} fields
 * @param {number} [columns=2] - Fields per row
 */
function drawInfoGrid(doc, fields, columns = 2) {
  const cellW = PAGE.contentWidth / columns;
  const cellH = 22;
  const startX = PAGE.margin;
  let x = startX;
  let y = doc.y + 4;

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const col = i % columns;
    if (col === 0 && i > 0) {
      y += cellH;
    }
    x = startX + (columns - 1 - col) * cellW; // RTL order

    // Label
    doc.fillColor(COLOR.muted).font(FONT_NAME).fontSize(8)
       .text(ar(field.label), x, y, { width: cellW - 8, align: 'right',  });
    // Value
    doc.fillColor(COLOR.text).font(FONT_NAME).fontSize(10)
       .text(ar(String(field.value || '—')), x, y + 10, { width: cellW - 8, align: 'right',  });
  }

  doc.y = y + cellH + 8;
}

/**
 * Draws a summary box (balance card).
 *
 * @param {PDFDocument} doc
 * @param {Array<{label, value, color?}>} items
 */
function drawSummaryCards(doc, items) {
  const cardW = PAGE.contentWidth / items.length;
  const cardH = 50;
  const y = doc.y + 4;
  const startX = PAGE.margin;

  items.forEach((item, i) => {
    // RTL order: first item is rightmost
    const x = startX + (items.length - 1 - i) * cardW;
    const cardColor = item.color || COLOR.primary;

    doc.rect(x + 2, y, cardW - 4, cardH).fill(COLOR.lightGold).stroke(COLOR.border);
    doc.rect(x + 2, y, cardW - 4, 4).fill(cardColor);

    doc.fillColor(COLOR.muted).font(FONT_NAME).fontSize(8)
       .text(ar(item.label), x + 4, y + 10, { width: cardW - 12, align: 'center' });
    doc.fillColor(cardColor).font(FONT_NAME).fontSize(12)
       .text(ar(formatAmount(item.value)), x + 4, y + 24, { width: cardW - 12, align: 'center' });
  });

  doc.y = y + cardH + 12;
}

// ---------------------------------------------------------------------------
// Table renderer
// ---------------------------------------------------------------------------

/**
 * Column definition for drawTable().
 * @typedef {object} TableColumn
 * @property {string}  header  - Arabic column header.
 * @property {string}  key     - Key in row data object (or 'index' for row number).
 * @property {number}  width   - Column width in points.
 * @property {'left'|'right'|'center'} [align='right']
 * @property {string}  [color] - Override text color for this column.
 * @property {Function} [format] - (value, row) => string
 */

/**
 * Draws a full table with header, alternating rows, and automatic page breaks.
 *
 * @param {PDFDocument}    doc
 * @param {TableColumn[]}  columns    - Column definitions (RTL order: leftmost = last in array)
 * @param {object[]}       rows       - Array of data row objects.
 * @param {object}         [opts={}]
 * @param {number}         [opts.rowHeight=20]
 * @param {number}         [opts.headerHeight=24]
 * @param {boolean}        [opts.showIndex=false]
 */
function drawTable(doc, columns, rows, opts = {}) {
  const { rowHeight = 20, headerHeight = 24, showIndex = false } = opts;
  const startX = PAGE.margin;
  let y = doc.y + 4;

  // ── Draw header ──────────────────────────────────────────────────────────
  const totalW = columns.reduce((s, c) => s + c.width, 0);

  doc.rect(startX, y, totalW, headerHeight).fill(COLOR.primary);

  let colX = startX;
  columns.forEach(col => {
    doc.fillColor(COLOR.white).font(FONT_NAME).fontSize(9)
       .text(ar(col.header), colX, y + 7, {
         width: col.width,
         align: col.align || 'right',
         
       });
    colX += col.width;
  });

  y += headerHeight;

  // ── Draw rows ────────────────────────────────────────────────────────────
  rows.forEach((row, rowIdx) => {
    // Page break check
    if (y + rowHeight > PAGE.height - PAGE.margin - 50) {
      doc.addPage();
      y = PAGE.margin;
      // Redraw header on new page
      doc.rect(startX, y, totalW, headerHeight).fill(COLOR.primary);
      colX = startX;
      columns.forEach(col => {
        doc.fillColor(COLOR.white).font(FONT_NAME).fontSize(9)
           .text(ar(col.header), colX, y + 7, {
             width: col.width,
             align: col.align || 'right',
             
           });
        colX += col.width;
      });
      y += headerHeight;
    }

    // Row background (alternating)
    const rowBg = rowIdx % 2 === 0 ? COLOR.white : COLOR.rowAlt;
    doc.rect(startX, y, totalW, rowHeight).fill(rowBg);

    // Row border bottom
    doc.moveTo(startX, y + rowHeight)
       .lineTo(startX + totalW, y + rowHeight)
       .strokeColor(COLOR.border).lineWidth(0.3).stroke();

    // Cell content
    colX = startX;
    columns.forEach(col => {
      let value;
      if (col.key === 'index') {
        value = String(rowIdx + 1);
      } else {
        value = row[col.key];
        if (col.format) value = col.format(value, row);
        else value = value != null ? String(value) : '—';
      }

      const textColor = col.color
        ? (typeof col.color === 'function' ? col.color(row[col.key], row) : col.color)
        : COLOR.text;

      doc.fillColor(textColor).font(FONT_NAME).fontSize(8)
         .text(ar(String(value)), colX + 2, y + 5, {
           width: col.width - 4,
           align: col.align || 'right',
           
           lineBreak: false,
           ellipsis: true,
         });

      colX += col.width;
    });

    y += rowHeight;
  });

  // Table bottom border
  doc.moveTo(startX, y)
     .lineTo(startX + totalW, y)
     .strokeColor(COLOR.primary).lineWidth(0.7).stroke();

  doc.y = y + 8;
}

// ---------------------------------------------------------------------------
// Footer renderer (with SHA-256 checksum)
// ---------------------------------------------------------------------------

/**
 * Adds footer with checksum, timestamp, and page number to all pages.
 * Called AFTER doc.end() using buffered pages feature.
 *
 * @param {PDFDocument} doc
 * @param {object}      meta
 * @param {string}      meta.checksum      - SHA-256 hex digest.
 * @param {string}      meta.requestorName - Who generated this report.
 * @param {string}      meta.requestorRole - Their role.
 * @param {string}      meta.reportType    - Arabic report type name.
 */
function addFooters(doc, meta) {
  const pages = doc.bufferedPageRange();
  const generatedAt = new Date().toISOString();

  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(pages.start + i);

    const y = PAGE.height - PAGE.margin - 10;

    // Separator line
    doc.moveTo(PAGE.margin, y - 18)
       .lineTo(PAGE.width - PAGE.margin, y - 18)
       .strokeColor(COLOR.border).lineWidth(0.5).stroke();

    // Left side: page number
    doc.fillColor(COLOR.muted).font(FONT_NAME).fontSize(7)
       .text(
         `الصفحة ${i + 1} من ${pages.count}`,
         PAGE.margin, y - 12,
         { width: 120, align: 'left',  }
       );

    // Center: generation timestamp
    doc.fillColor(COLOR.muted).font(FONT_NAME).fontSize(7)
       .text(
         `صدر في: ${generatedAt}`,
         PAGE.margin + 120, y - 12,
         { width: PAGE.contentWidth - 240, align: 'center',  }
       );

    // Right: requestor
    doc.fillColor(COLOR.muted).font(FONT_NAME).fontSize(7)
       .text(
         ar(`أصدره: ${meta.requestorName} (${meta.requestorRole})`),
         PAGE.width - PAGE.margin - 120, y - 12,
         { width: 120, align: 'right',  }
       );

    // Checksum line
    doc.fillColor('#A0A0A0').font(FONT_NAME).fontSize(6)
       .text(
         `SHA-256: ${meta.checksum}`,
         PAGE.margin, y,
         { width: PAGE.contentWidth, align: 'center', lineBreak: false }
       );
  }
}

// ---------------------------------------------------------------------------
// 1. generateUserStatement
// ---------------------------------------------------------------------------

/**
 * Generates a Resident Account Statement (كشف حساب الطالب) as a PDF stream.
 *
 * @param {string} userPublicId    - Target user's publicId.
 * @param {Date}   startDate       - Statement period start (inclusive).
 * @param {Date}   endDate         - Statement period end (inclusive).
 * @param {object} [actor={}]      - Who requested this report (for footer).
 * @param {string} [actor.name='النظام']
 * @param {string} [actor.role='system']
 * @returns {PDFDocument} Readable stream — pipe to HTTP response.
 */
async function generateUserStatement(userPublicId, startDate, endDate, actor = {}) {
  const actorName = actor.name || 'النظام';
  const actorRole = actor.role || 'system';

  // ── Fetch data ─────────────────────────────────────────────────────────
  const userDoc = await User
    .findOne({ publicId: userPublicId })
    .select('_id publicId fullName phone role roomNumber status')
    .lean();

  if (!userDoc) throw Object.assign(new Error('المستخدم غير موجود'), { statusCode: 404 });

  const start = startDate instanceof Date ? startDate : new Date(startDate);
  let end   = endDate   instanceof Date ? endDate   : new Date(endDate);
  
  // Always set end to end of day in UTC so transactions on that day are included
  end = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), 23, 59, 59, 999));
  // Ensure start is at beginning of day UTC
  const startFixed = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), 0, 0, 0, 0));

  // Opening balance = all transactions BEFORE startDate
  const openingAgg = await require('../repositories/transactionRepository')
    .aggregateBalanceTotals(userDoc._id, { sinceDate: null });

  // For opening balance we need txns before start
  const openingTxns = await Transaction.aggregate([
    { $match: { userId: userDoc._id, createdAt: { $lt: startFixed } } },
    { $group: {
      _id: null,
      totalCredits: { $sum: '$creditAmount' },
      totalDebits:  { $sum: '$debitAmount' },
    }},
  ]);
  const openingBalance = openingTxns.length
    ? openingTxns[0].totalCredits - openingTxns[0].totalDebits
    : 0;

  // Transactions in range (for table)
  const periodTxns = await Transaction.find({
    userId: userDoc._id,
    createdAt: { $gte: startFixed, $lte: end },
  }).sort({ createdAt: 1 }).lean();

  // Closing balance = opening + period movements
  const periodCredits = periodTxns.reduce((s, t) => s + t.creditAmount, 0);
  const periodDebits  = periodTxns.reduce((s, t) => s + t.debitAmount,  0);
  const closingBalance = openingBalance + periodCredits - periodDebits;
  const closingDebt    = Math.max(0, -closingBalance);

  // ── Build checksum payload ─────────────────────────────────────────────
  const checksumPayload = {
    reportType: 'user_statement',
    userPublicId,
    startDate: start.toISOString(),
    endDate:   end.toISOString(),
    openingBalance,
    closingBalance,
    txCount: periodTxns.length,
    txPublicIds: periodTxns.map(t => t.publicId).sort(),
  };
  const checksum = computeChecksum(checksumPayload);

  // ── Build PDF ──────────────────────────────────────────────────────────
  const doc = createDoc({ reportTitle: 'كشف حساب الطالب', requestorName: actorName });

  drawHeader(doc, {
    title:    'كشف حساب الطالب',
    subtitle: `الفترة من ${formatDate(start)} إلى ${formatDate(end)}`,
  });

  // User info section
  drawSectionTitle(doc, 'بيانات الطالب');
  drawInfoGrid(doc, [
    { label: 'الاسم الكامل',   value: userDoc.fullName },
    { label: 'رقم الهاتف',     value: userDoc.phone || '—' },
    { label: 'رقم الغرفة',     value: userDoc.roomNumber || '—' },
    { label: 'رقم المعرف',     value: userDoc.publicId },
    { label: 'الحالة',          value: userDoc.status === 'active' ? 'نشط' : 'معطّل' },
    { label: 'تاريخ التقرير',  value: formatDate(new Date()) },
  ]);

  // Balance summary
  drawSectionTitle(doc, 'ملخص الحساب');
  drawSummaryCards(doc, [
    {
      label: 'الرصيد الافتتاحي',
      value: openingBalance,
      color: openingBalance >= 0 ? COLOR.success : COLOR.danger,
    },
    {
      label: 'إجمالي الإيداعات',
      value: periodCredits,
      color: COLOR.success,
    },
    {
      label: 'إجمالي الخصومات',
      value: periodDebits,
      color: COLOR.danger,
    },
    {
      label: closingBalance >= 0 ? 'الرصيد الختامي' : 'الدين المستحق',
      value: closingBalance >= 0 ? closingBalance : closingDebt,
      color: closingBalance >= 0 ? COLOR.success : COLOR.danger,
    },
  ]);

  // Transactions table
  drawSectionTitle(doc, `تفاصيل العمليات المالية (${periodTxns.length} عملية)`);

  if (periodTxns.length === 0) {
    doc.fillColor(COLOR.muted).font(FONT_NAME).fontSize(10)
       .text(ar('لا توجد عمليات في هذه الفترة'), PAGE.margin, doc.y + 8, {
         width: PAGE.contentWidth,
         align: 'center',
       });
    doc.moveDown();
  } else {
    drawTable(doc, [
      { header: '#',            key: 'index',       width: 28, align: 'center' },
      { header: 'التاريخ',     key: 'createdAt',   width: 72,
        format: v => formatShortDate(v) },
      { header: 'نوع العملية', key: 'type',        width: 90,
        format: v => TX_TYPE_LABELS[v] || v },
      { header: 'الوصف',       key: 'description', width: 135, align: 'right' },
      { header: 'إيداع (+)',   key: 'creditAmount', width: 70,
        align: 'center',
        format: v => v > 0 ? `${v.toLocaleString('en-US')}` : '—',
        color: (v) => v > 0 ? COLOR.success : COLOR.muted },
      { header: 'خصم (−)',     key: 'debitAmount',  width: 70,
        align: 'center',
        format: v => v > 0 ? `${v.toLocaleString('en-US')}` : '—',
        color: (v) => v > 0 ? COLOR.danger : COLOR.muted },
      { header: 'عملة',        key: 'currency',     width: 36, align: 'center' },
    ], periodTxns, { rowHeight: 18 });
  }

  // Finalize
  addFooters(doc, {
    checksum,
    requestorName: actorName,
    requestorRole: actorRole,
    reportType: 'كشف حساب الطالب',
  });

  logger.info('[pdfService] ✅ تم توليد كشف حساب الطالب', {
    userPublicId,
    txCount: periodTxns.length,
    checksum: checksum.slice(0, 16) + '...',
  });

  doc.end();
  return doc; // Stream — pipe to response
}

// ---------------------------------------------------------------------------
// 2. generateMerchantReport
// ---------------------------------------------------------------------------

/**
 * Generates a Merchant Sales & Settlement Report.
 *
 * @param {string} merchantPublicId
 * @param {Date}   startDate
 * @param {Date}   endDate
 * @param {object} [actor={}]
 * @returns {PDFDocument}
 */
async function generateMerchantReport(merchantPublicId, startDate, endDate, actor = {}) {
  const actorName = actor.name || 'النظام';
  const actorRole = actor.role || 'system';

  const merchant = await merchantRepository.findByPublicId(merchantPublicId);
  if (!merchant) throw Object.assign(new Error('التاجر غير موجود'), { statusCode: 404 });

  const start = startDate instanceof Date ? startDate : new Date(startDate);
  let end   = endDate   instanceof Date ? endDate   : new Date(endDate);
  
  if (end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0) {
    end.setUTCHours(23, 59, 59, 999);
  }

  // Merchant transactions in date range
  const merchantTxns = await MerchantTransaction.find({
    merchantId: merchant._id,
    createdAt: { $gte: start, $lte: end },
  }).sort({ createdAt: 1 }).lean();

  const purchases    = merchantTxns.filter(t => t.type === 'purchase');
  const settlements  = merchantTxns.filter(t => t.type === 'settlement');
  const totalPurchases   = purchases.reduce((s, t) => s + t.amount, 0);
  const totalSettlements = settlements.reduce((s, t) => s + t.amount, 0);
  const outstanding = Math.max(0, totalPurchases - totalSettlements);

  const checksumPayload = {
    reportType: 'merchant_report',
    merchantPublicId,
    startDate: start.toISOString(),
    endDate:   end.toISOString(),
    totalPurchases,
    totalSettlements,
    outstanding,
    txIds: merchantTxns.map(t => t.publicId).sort(),
  };
  const checksum = computeChecksum(checksumPayload);

  const doc = createDoc({ reportTitle: 'تقرير التاجر' });

  drawHeader(doc, {
    title:    'تقرير مبيعات وتسويات التاجر',
    subtitle: `الفترة من ${formatDate(start)} إلى ${formatDate(end)}`,
  });

  drawSectionTitle(doc, 'بيانات التاجر');
  drawInfoGrid(doc, [
    { label: 'اسم التاجر',   value: merchant.name },
    { label: 'رقم الهاتف',   value: merchant.phone || '—' },
    { label: 'معرّف النظام', value: merchant.publicId },
    { label: 'الحالة',       value: merchant.status === 'active' ? 'نشط' : 'معطّل' },
    { label: 'تاريخ التقرير', value: formatDate(new Date()) },
    { label: 'الفترة',        value: `${formatShortDate(start)} → ${formatShortDate(end)}` },
  ]);

  drawSectionTitle(doc, 'ملخص مالي');
  drawSummaryCards(doc, [
    { label: 'إجمالي المبيعات',  value: totalPurchases,   color: COLOR.primary },
    { label: 'إجمالي التسويات', value: totalSettlements,  color: COLOR.success },
    { label: 'المستحق للتاجر',  value: outstanding,        color: COLOR.danger  },
    { label: 'عدد الفواتير',    value: purchases.length,   color: COLOR.muted   },
  ]);

  // Purchases table
  if (purchases.length > 0) {
    drawSectionTitle(doc, `المشتريات (${purchases.length} فاتورة)`);
    drawTable(doc, [
      { header: '#',              key: 'index',            width: 28, align: 'center' },
      { header: 'التاريخ',       key: 'createdAt',        width: 72, format: v => formatShortDate(v) },
      { header: 'رقم الفاتورة',  key: 'invoiceReference', width: 100 },
      { header: 'الوصف',         key: 'description',      width: 140 },
      { header: 'المبلغ (ريال)', key: 'amount',           width: 80,
        align: 'center', format: v => v?.toLocaleString('en-US') || '—',
        color: () => COLOR.danger },
      { header: 'عدد المستفيدين', key: 'userShares',      width: 85,
        align: 'center', format: v => Array.isArray(v) ? String(v.length) : '—' },
    ], purchases, { rowHeight: 18 });
  }

  // Settlements table
  if (settlements.length > 0) {
    drawSectionTitle(doc, `التسويات (${settlements.length})`);
    drawTable(doc, [
      { header: '#',              key: 'index',            width: 28, align: 'center' },
      { header: 'التاريخ',       key: 'createdAt',        width: 80, format: v => formatShortDate(v) },
      { header: 'الملاحظات',     key: 'settlementNotes',  width: 200 },
      { header: 'المبلغ (ريال)', key: 'amount',           width: 90,
        align: 'center', format: v => v?.toLocaleString('en-US') || '—',
        color: () => COLOR.success },
      { header: 'مرفق',          key: 'receiptImagePublicId', width: 107,
        format: v => v ? 'نعم ✓' : 'لا' },
    ], settlements, { rowHeight: 18 });
  }

  addFooters(doc, { checksum, requestorName: actorName, requestorRole: actorRole, reportType: 'تقرير التاجر' });

  logger.info('[pdfService] ✅ تم توليد تقرير التاجر', {
    merchantPublicId,
    purchases: purchases.length,
    settlements: settlements.length,
    checksum: checksum.slice(0, 16) + '...',
  });

  doc.end();
  return doc;
}

// ---------------------------------------------------------------------------
// 3. generateMonthlyDormReport
// ---------------------------------------------------------------------------

/**
 * Generates the Monthly Dorm Financial Report (admin-only).
 *
 * @param {Date}   month    - Any date within the target month; automatically
 *                            scoped to the full calendar month.
 * @param {object} [actor={}]
 * @returns {PDFDocument}
 */
async function generateMonthlyDormReport(month, actor = {}) {
  const actorName = actor.name || 'المسؤول';
  const actorRole = actor.role || 'admin';

  const d = month instanceof Date ? month : new Date(month);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end   = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999));

  const monthLabel = start.toLocaleDateString('ar-SA', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  // Aggregate all transactions in the month by type
  const monthAgg = await Transaction.aggregate([
    { $match: { createdAt: { $gte: start, $lte: end } } },
    {
      $group: {
        _id: '$type',
        totalAmount: { $sum: '$amount' },
        count:        { $sum: 1 },
      },
    },
  ]);

  const byType = {};
  monthAgg.forEach(r => { byType[r._id] = r; });

  const totalDeposits    = byType[TRANSACTION_TYPES.DEPOSIT]?.totalAmount           || 0;
  const totalWithdrawals = byType[TRANSACTION_TYPES.WITHDRAWAL]?.totalAmount         || 0;
  const totalFees        = byType[TRANSACTION_TYPES.WITHDRAWAL_FEE]?.totalAmount     || 0;
  const totalExpenses    = byType[TRANSACTION_TYPES.SHARED_EXPENSE]?.totalAmount     || 0;
  const totalPurchases   = byType[TRANSACTION_TYPES.MERCHANT_PURCHASE]?.totalAmount  || 0;
  const totalRefunds     = byType[TRANSACTION_TYPES.REFUND]?.totalAmount             || 0;
  const totalAdjustments = byType[TRANSACTION_TYPES.ADJUSTMENT]?.totalAmount         || 0;

  // Active users count
  const activeUserCount = await User.countDocuments({ status: 'active' });

  // Total outstanding debt across all users (sample up to 1000 users)
  const activeUsers = await User.find({ status: 'active' }).select('_id publicId').limit(1000).lean();
  let totalDebt = 0;
  let usersInDebt = 0;

  // Batch balance calculations (process in chunks of 20)
  for (let i = 0; i < activeUsers.length; i += 20) {
    const chunk = activeUsers.slice(i, i + 20);
    const balances = await Promise.all(
      chunk.map(u => ledgerService.calculateBalance(u._id, u.publicId, { bypassCache: true }))
    );
    balances.forEach(b => {
      if (b.debt > 0) {
        totalDebt += b.debt;
        usersInDebt++;
      }
    });
  }

  // Merchant stats for the month
  const merchantStats = await MerchantTransaction.aggregate([
    { $match: { createdAt: { $gte: start, $lte: end } } },
    {
      $group: {
        _id: '$type',
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
  ]);
  const merchantPurchases   = merchantStats.find(s => s._id === 'purchase')?.total    || 0;
  const merchantSettlements = merchantStats.find(s => s._id === 'settlement')?.total  || 0;

  // Checksum
  const checksumPayload = {
    reportType: 'monthly_dorm',
    month: start.toISOString(),
    totalDeposits, totalWithdrawals, totalFees, totalExpenses,
    totalPurchases, totalRefunds, totalAdjustments,
    totalDebt, usersInDebt, activeUserCount,
  };
  const checksum = computeChecksum(checksumPayload);

  // ── Build PDF ──────────────────────────────────────────────────────────
  const doc = createDoc({ reportTitle: 'التقرير المالي الشهري' });

  drawHeader(doc, {
    title:    'التقرير المالي الشهري الشامل للسكن',
    subtitle: `شهر: ${monthLabel}`,
  });

  // Main summary cards
  drawSectionTitle(doc, 'الملخص المالي الشهري');
  drawSummaryCards(doc, [
    { label: 'إجمالي الإيداعات', value: totalDeposits,    color: COLOR.success  },
    { label: 'إجمالي السحوبات',  value: totalWithdrawals, color: COLOR.danger   },
    { label: 'المصاريف المشتركة', value: totalExpenses,   color: COLOR.primary  },
    { label: 'الديون القائمة',   value: totalDebt,         color: totalDebt > 0 ? COLOR.danger : COLOR.success },
  ]);

  // Detailed breakdown table
  drawSectionTitle(doc, 'تفصيل حركة الصندوق');
  const breakdown = [
    { type: 'إيداعات الطلاب',      amount: totalDeposits,    count: byType[TRANSACTION_TYPES.DEPOSIT]?.count || 0,    direction: 'دائن (+)' },
    { type: 'سحوبات الطلاب',       amount: totalWithdrawals,  count: byType[TRANSACTION_TYPES.WITHDRAWAL]?.count || 0, direction: 'مدين (−)' },
    { type: 'رسوم السحب',           amount: totalFees,         count: byType[TRANSACTION_TYPES.WITHDRAWAL_FEE]?.count || 0, direction: 'مدين (−)' },
    { type: 'مصاريف مشتركة',       amount: totalExpenses,     count: byType[TRANSACTION_TYPES.SHARED_EXPENSE]?.count || 0, direction: 'مدين (−)' },
    { type: 'مشتريات من التجار',   amount: totalPurchases,    count: byType[TRANSACTION_TYPES.MERCHANT_PURCHASE]?.count || 0, direction: 'مدين (−)' },
    { type: 'استردادات',            amount: totalRefunds,      count: byType[TRANSACTION_TYPES.REFUND]?.count || 0,    direction: 'دائن (+)' },
    { type: 'تعديلات يدوية',       amount: totalAdjustments,  count: byType[TRANSACTION_TYPES.ADJUSTMENT]?.count || 0, direction: 'متغير' },
  ];

  drawTable(doc, [
    { header: 'نوع العملية',   key: 'type',      width: 160 },
    { header: 'اتجاه',         key: 'direction', width: 70, align: 'center' },
    { header: 'عدد العمليات',  key: 'count',     width: 80, align: 'center' },
    { header: 'المبلغ الكلي (ريال)', key: 'amount', width: 195,
      align: 'center', format: v => v.toLocaleString('en-US') },
  ], breakdown, { rowHeight: 20 });

  // Debt section
  drawSectionTitle(doc, 'تقرير الديون');
  drawInfoGrid(doc, [
    { label: 'إجمالي الطلاب النشطين', value: activeUserCount },
    { label: 'طلاب عليهم دين',          value: usersInDebt },
    { label: 'نسبة الطلاب المدينين',    value: `${activeUserCount ? Math.round(usersInDebt/activeUserCount*100) : 0}%` },
    { label: 'إجمالي الديون القائمة',   value: formatAmount(totalDebt) },
  ], 2);

  // Merchant section
  drawSectionTitle(doc, 'حركة التجار');
  drawSummaryCards(doc, [
    { label: 'إجمالي مشتريات التجار', value: merchantPurchases,   color: COLOR.primary },
    { label: 'التسويات مع التجار',    value: merchantSettlements, color: COLOR.success },
    { label: 'المستحق للتجار',        value: Math.max(0, merchantPurchases - merchantSettlements), color: COLOR.danger },
  ]);

  addFooters(doc, { checksum, requestorName: actorName, requestorRole: actorRole, reportType: 'التقرير الشهري' });

  logger.info('[pdfService] ✅ تم توليد التقرير الشهري', {
    month: monthLabel,
    activeUserCount,
    checksum: checksum.slice(0, 16) + '...',
  });

  doc.end();
  return doc;
}

// ---------------------------------------------------------------------------
// 4. generateDebtReport
// ---------------------------------------------------------------------------

/**
 * Generates the Outstanding Debt Ledger Report (كشف الديون).
 * Lists all users with outstanding debt, sorted by debt amount descending.
 * Color-coded by proximity to debt limit.
 *
 * @param {object} [actor={}]
 * @returns {PDFDocument}
 */
async function generateDebtReport(actor = {}) {
  const actorName = actor.name || 'المسؤول';
  const actorRole = actor.role || 'admin';

  // Get debt limit from settings (with fallback)
  let debtLimit = 0;
  try {
    const settings = await require('./settingService').getSettings();
    debtLimit = settings.maxDebtLimit || 0;
  } catch { /* use 0 (unlimited) */ }

  // Fetch all active users
  const activeUsers = await User
    .find({ status: 'active' })
    .select('_id publicId fullName phone roomNumber')
    .lean();

  // Calculate balance for each user in batches
  const debtors = [];
  for (let i = 0; i < activeUsers.length; i += 20) {
    const chunk = activeUsers.slice(i, i + 20);
    const balances = await Promise.all(
      chunk.map(u => ledgerService.calculateBalance(u._id, u.publicId, { bypassCache: true })
        .then(b => ({ user: u, ...b }))
        .catch(() => ({ user: chunk[i], balance: 0, debt: 0 }))
      )
    );
    balances.forEach(b => {
      if (b.debt > 0) {
        debtors.push({
          publicId:   b.user.publicId,
          name:       b.user.fullName,
          phone:      b.user.phone || '—',
          room:       b.user.roomNumber || '—',
          balance:    b.balance,
          debt:       b.debt,
          pct:        debtLimit > 0 ? Math.round(b.debt / debtLimit * 100) : null,
        });
      }
    });
  }

  // Sort by debt descending
  debtors.sort((a, b) => b.debt - a.debt);

  const totalDebt     = debtors.reduce((s, d) => s + d.debt, 0);
  const criticalCount = debtors.filter(d => debtLimit > 0 && d.debt >= debtLimit * 0.9).length;
  const warningCount  = debtors.filter(d => debtLimit > 0 && d.debt >= debtLimit * 0.7 && d.debt < debtLimit * 0.9).length;

  const checksumPayload = {
    reportType: 'debt_report',
    generatedAt: new Date().toISOString().slice(0, 16), // minute precision
    debtorCount: debtors.length,
    totalDebt,
    debtLimit,
    entries: debtors.map(d => ({ p: d.publicId, debt: d.debt })),
  };
  const checksum = computeChecksum(checksumPayload);

  // ── Build PDF ──────────────────────────────────────────────────────────
  const doc = createDoc({ reportTitle: 'كشف الديون' });

  drawHeader(doc, {
    title:    'كشف الديون المستحقة',
    subtitle: `صدر في: ${formatDate(new Date())} — يحتوي على ${debtors.length} طالب مدين`,
  });

  // Summary
  drawSectionTitle(doc, 'ملخص الديون');
  drawSummaryCards(doc, [
    { label: 'عدد المدينين',          value: debtors.length,  color: COLOR.danger   },
    { label: 'إجمالي الديون (ريال)',  value: totalDebt,       color: COLOR.danger   },
    { label: 'في المنطقة الحرجة (≥90%)', value: criticalCount, color: COLOR.danger   },
    { label: 'في المنطقة التحذيرية (≥70%)', value: warningCount, color: COLOR.warning },
  ]);

  if (debtLimit > 0) {
    drawInfoGrid(doc, [
      { label: 'حد الدين المحدد في النظام', value: formatAmount(debtLimit) },
    ], 1);
  }

  // Debt table
  drawSectionTitle(doc, 'قائمة المدينين (مرتبة تنازلياً حسب الدين)');

  if (debtors.length === 0) {
    doc.fillColor(COLOR.success).font(FONT_NAME).fontSize(12)
       .text(ar('🎉 لا توجد ديون مستحقة — خزينة السكن في وضع سليم'), PAGE.margin, doc.y + 10, {
         width: PAGE.contentWidth, align: 'center',
       });
    doc.moveDown();
  } else {
    const cols = [
      { header: '#',            key: 'index',    width: 28, align: 'center' },
      { header: 'الاسم',       key: 'name',     width: 105 },
      { header: 'رقم الهاتف', key: 'phone',     width: 75, align: 'center' },
      { header: 'رقم الغرفة', key: 'room',      width: 55, align: 'center' },
      { header: 'الرصيد (ريال)', key: 'balance', width: 80,
        align: 'center',
        format: v => v.toLocaleString('en-US'),
        color: () => COLOR.danger },
      { header: 'الدين (ريال)', key: 'debt',    width: 80,
        align: 'center',
        format: v => v.toLocaleString('en-US'),
        color: () => COLOR.danger },
    ];

    // Add debt % column only if debt limit is set
    if (debtLimit > 0) {
      cols.push({
        header: 'نسبة الدين',
        key: 'pct',
        width: 82,
        align: 'center',
        format: v => v != null ? `${v}%` : '—',
        color: (v) => {
          if (v == null) return COLOR.muted;
          if (v >= 90) return COLOR.danger;
          if (v >= 70) return COLOR.warning;
          return COLOR.text;
        },
      });
    }

    drawTable(doc, cols, debtors, { rowHeight: 20 });
  }

  addFooters(doc, { checksum, requestorName: actorName, requestorRole: actorRole, reportType: 'كشف الديون' });

  logger.info('[pdfService] ✅ تم توليد تقرير الديون', {
    debtorCount: debtors.length,
    totalDebt,
    checksum: checksum.slice(0, 16) + '...',
  });

  doc.end();
  return doc;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  generateUserStatement,
  generateMerchantReport,
  generateMonthlyDormReport,
  generateDebtReport,
  // Utilities (for testing / reuse)
  computeChecksum,
  formatAmount,
  formatDate,
  formatShortDate,
  ar,
};
