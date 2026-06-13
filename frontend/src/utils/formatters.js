/**
 * formatters.js — Financial display utilities
 *
 * CRITICAL: All amounts are integers (YER, no decimals).
 * NEVER use floating-point arithmetic on financial values.
 * These functions are display-only — they never mutate amounts.
 */

/**
 * Formats an integer YER amount for display.
 * @param {number|null|undefined} amount - Integer YER amount
 * @param {object} [opts]
 * @param {boolean} [opts.showCurrency=true]
 * @param {boolean} [opts.showSign=false]
 * @returns {string}
 */
export function formatYER(amount, opts = {}) {
  const { showCurrency = true, showSign = false } = opts;
  if (amount == null || Number.isNaN(amount)) return '—';

  const abs = Math.abs(Math.trunc(amount)); // Never use floating point
  const formatted = new Intl.NumberFormat('ar-EG', {
    useGrouping: true,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(abs);

  const sign = showSign ? (amount < 0 ? '− ' : '+ ') : '';
  const currency = showCurrency ? ' ريال' : '';
  return `${sign}${formatted}${currency}`;
}

/**
 * Formats a date string into a short Arabic display format.
 * @param {string|Date} date
 * @returns {string}
 */
export function formatDate(date) {
  if (!date) return '—';
  const d = new Date(date);
  return d.toLocaleDateString('ar-SA', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Formats a date into relative time ("منذ ساعتين")
 * @param {string|Date} date
 * @returns {string}
 */
export function formatRelative(date) {
  if (!date) return '—';
  const d = new Date(date);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1)   return 'الآن';
  if (diffMins < 60)  return `منذ ${diffMins} دقيقة`;
  if (diffHours < 24) return `منذ ${diffHours} ساعة`;
  if (diffDays < 30)  return `منذ ${diffDays} يوم`;
  return formatDate(date);
}

/**
 * Parses a user-entered string into an integer amount.
 * Strips commas, spaces. Returns null if not a valid positive integer.
 * @param {string} raw
 * @returns {number|null}
 */
export function parseAmount(raw) {
  const cleaned = String(raw).replace(/[\s,،]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return null;
  return n;
}
