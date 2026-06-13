/**
 * @file integerMath.js
 * @description Safe integer arithmetic utilities for YER monetary calculations.
 *
 * ██████████████████████████████████████████████████████████████████████████
 * ██  FLOATING POINT IS FORBIDDEN FOR MONEY CALCULATIONS                  ██
 * ██████████████████████████████████████████████████████████████████████████
 *
 * WHY THIS FILE EXISTS:
 *   JavaScript's IEEE 754 double-precision floats cannot represent all
 *   decimal values exactly. For example:
 *     0.1 + 0.2 === 0.30000000000000004  (NOT 0.3)
 *
 *   In a financial system, this causes silent data corruption.
 *   YER amounts are ALWAYS whole integers — no decimals ever exist.
 *   This library enforces that invariant and provides the ONLY permitted
 *   arithmetic functions for monetary values.
 *
 * ROUNDING POLICIES (spec §5):
 *   - Expense shares:   Math.floor (base) + distribute remainder (spec §5)
 *   - Withdrawal fees:  Math.ceil  (always round UP, spec §5)
 *   - All other:        No rounding needed — inputs are validated as integers
 *
 * NOTE ON big.js / decimal.js:
 *   The spec suggests using big.js for complex operations. Since YER is
 *   integer-only, big.js is NOT needed for balance arithmetic (sum of integers
 *   is always an integer in safe integer range). We use big.js ONLY for
 *   PERCENTAGE fee calculation to avoid float multiplication errors:
 *     e.g. 3001 * 2.5 / 100 = 75.025 (float) → Math.ceil → 76 (correct)
 *   but:
 *     e.g. 9999 * 7 / 100 = 699.93 (float) — safe with integer ops below
 *
 * @module utils/integerMath
 */

'use strict';

const Big = require('big.js');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Big.js: no exponential notation, 0 decimal places for monetary display
Big.DP = 0;
Big.RM = 3; // Round UP (ceiling mode) — overridden per operation below

// Maximum safe integer for YER amounts (Node.js Number.MAX_SAFE_INTEGER)
const MAX_SAFE_YER = Number.MAX_SAFE_INTEGER; // 9,007,199,254,740,991

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Asserts that a value is a safe integer (no decimals, within JS safe range).
 * Throws a TypeError with a descriptive Arabic message if the assertion fails.
 *
 * @param {*} value - The value to check.
 * @param {string} [fieldName='المبلغ'] - Field name for the error message.
 * @throws {TypeError}
 */
function assertInteger(value, fieldName = 'المبلغ') {
  if (!Number.isInteger(value)) {
    throw new TypeError(
      `[integerMath] ${fieldName} يجب أن يكون عدداً صحيحاً بدون كسور — القيمة المُستلمة: ${value}`
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `[integerMath] ${fieldName} تجاوز الحد الأقصى الآمن لـ JavaScript (${MAX_SAFE_YER})`
    );
  }
}

/**
 * Asserts that a value is a positive integer (> 0).
 *
 * @param {*} value
 * @param {string} [fieldName='المبلغ']
 */
function assertPositiveInteger(value, fieldName = 'المبلغ') {
  assertInteger(value, fieldName);
  if (value <= 0) {
    throw new RangeError(
      `[integerMath] ${fieldName} يجب أن يكون أكبر من صفر — القيمة المُستلمة: ${value}`
    );
  }
}

/**
 * Asserts that a value is a non-negative integer (>= 0).
 *
 * @param {*} value
 * @param {string} [fieldName='المبلغ']
 */
function assertNonNegativeInteger(value, fieldName = 'المبلغ') {
  assertInteger(value, fieldName);
  if (value < 0) {
    throw new RangeError(
      `[integerMath] ${fieldName} يجب أن يكون صفراً أو أكبر — القيمة المُستلمة: ${value}`
    );
  }
}

// ---------------------------------------------------------------------------
// Safe addition / subtraction
// ---------------------------------------------------------------------------

/**
 * Safely adds two integer YER amounts.
 * Both inputs must be integers. Result is guaranteed to be an integer.
 *
 * @param {number} a
 * @param {number} b
 * @returns {number} a + b
 */
function add(a, b) {
  assertInteger(a, 'المُضاف الأول');
  assertInteger(b, 'المُضاف الثاني');
  const result = a + b;
  assertInteger(result, 'ناتج الجمع');
  return result;
}

/**
 * Safely subtracts two integer YER amounts.
 *
 * @param {number} a
 * @param {number} b
 * @returns {number} a - b (can be negative)
 */
function subtract(a, b) {
  assertInteger(a, 'المطروح منه');
  assertInteger(b, 'المطروح');
  const result = a - b;
  assertInteger(result, 'ناتج الطرح');
  return result;
}

// ---------------------------------------------------------------------------
// Withdrawal fee calculation (spec §5)
// ---------------------------------------------------------------------------

/**
 * Calculates the withdrawal fee based on fee type and value.
 *
 * ROUNDING RULE (spec §5):
 *   Fee is ALWAYS rounded UP (Math.ceil) — never round down on fee calculations.
 *   "Always round UP to avoid fractional YER."
 *
 * Uses big.js for PERCENTAGE calculation to avoid float multiplication errors:
 *   e.g. 3001 YER at 2.5% → 3001 * 2.5 / 100 in floats = 75.025
 *   big.js gives exact result: 75.025 → ceil → 76
 *
 * @param {number} amount        - Withdrawal amount in YER (positive integer).
 * @param {'FIXED'|'PERCENTAGE'} feeType  - Fee calculation method.
 * @param {number} feeValue      - Fixed YER amount OR percentage integer (0–100).
 * @returns {number} Fee amount in YER (non-negative integer, always Math.ceil'd).
 *
 * @example
 *   calculateFee(5000, 'FIXED', 100)        // → 100
 *   calculateFee(5000, 'PERCENTAGE', 3)     // → 150  (5000 * 3% = 150)
 *   calculateFee(3001, 'PERCENTAGE', 5)     // → 151  (3001 * 5% = 150.05 → ceil → 151)
 *   calculateFee(5000, 'FIXED', 0)          // → 0    (no fee)
 */
function calculateWithdrawalFee(amount, feeType, feeValue) {
  assertPositiveInteger(amount, 'مبلغ السحب');
  assertNonNegativeInteger(feeValue, 'قيمة الرسوم');

  if (feeValue === 0) return 0;

  if (feeType === 'FIXED') {
    return feeValue; // Already an integer — no rounding needed
  }

  if (feeType === 'PERCENTAGE') {
    if (feeValue > 100) {
      throw new RangeError(
        `[integerMath] نسبة الرسوم يجب أن تكون بين 0 و 100 — القيمة: ${feeValue}`
      );
    }

    // Use big.js for exact decimal arithmetic to avoid float multiplication errors.
    // Strategy:
    //   1. Compute exact fee as a Big decimal: amount * feeValue / 100
    //   2. Convert to a string with enough decimal places
    //   3. Apply Math.ceil on the resulting JS number
    //
    // This is safe because:
    //   - amount is a safe integer (max ~9×10^15)
    //   - feeValue is an integer 1–100
    //   - big.js uses arbitrary precision — no floating point rounding during mult/div
    //   - Math.ceil on the big.js result string gives the exact ceiling
    //
    // Example: 3001 * 5 / 100 = 150.05 (exact in big.js) → ceil → 151
    //          9999 * 7 / 100 = 699.93 (exact in big.js) → ceil → 700
    const bigAmount = new Big(amount);
    const exactFee = bigAmount.times(feeValue).div(100);

    // Convert to number with full precision then apply ceil
    // Big.toFixed(20) gives enough decimal places for any integer input
    const exactAsFloat = parseFloat(exactFee.toFixed(20));
    return Math.ceil(exactAsFloat);
  }

  throw new Error(`[integerMath] نوع الرسوم غير معروف: ${feeType}`);
}

// ---------------------------------------------------------------------------
// Shared expense share division (spec §5)
// ---------------------------------------------------------------------------

/**
 * Divides a total expense amount among N users with the spec §5 rounding policy:
 *
 *   baseShare = Math.floor(totalAmount / numUsers)
 *   remainder = totalAmount % numUsers
 *   First `remainder` users get (baseShare + 1)
 *   Remaining users get baseShare
 *   GUARANTEE: SUM(all shares) === totalAmount  (no YER lost or created)
 *
 * @param {number} totalAmount  - Total expense amount (positive integer YER).
 * @param {number} numUsers     - Number of users to split among (positive integer).
 * @returns {number[]} Array of share amounts in YER (length === numUsers).
 *                     Shares may differ by at most 1 YER between users.
 *
 * @example
 *   splitExpense(100, 3)  // → [34, 33, 33]  (100/3 = 33 rem 1)
 *   splitExpense(101, 3)  // → [34, 34, 33]  (101/3 = 33 rem 2)
 *   splitExpense(300, 3)  // → [100, 100, 100]
 *   splitExpense(1, 3)    // → [1, 0, 0]  ← spec allows 0-share users
 */
function splitExpense(totalAmount, numUsers) {
  assertPositiveInteger(totalAmount, 'إجمالي المصروف');
  assertPositiveInteger(numUsers, 'عدد المستخدمين');

  const baseShare = Math.floor(totalAmount / numUsers);
  const remainder = totalAmount % numUsers; // Number of users who get +1

  const shares = Array.from({ length: numUsers }, (_, i) =>
    i < remainder ? baseShare + 1 : baseShare
  );

  // Integrity assertion — must always hold
  const sharesSum = shares.reduce((acc, s) => acc + s, 0);
  if (sharesSum !== totalAmount) {
    throw new Error(
      `[integerMath] خطأ في تقسيم المصروف: مجموع الحصص (${sharesSum}) ≠ إجمالي المبلغ (${totalAmount})`
    );
  }

  return shares;
}

// ---------------------------------------------------------------------------
// Balance and debt calculation
// ---------------------------------------------------------------------------

/**
 * Calculates user balance from aggregated credit/debit totals.
 *
 * FORMULA (spec §5):
 *   balance = totalCredits - totalDebits
 *   debt    = MAX(0, -balance)  i.e. how much below zero the balance is
 *
 * @param {number} totalCredits  - Sum of all creditAmount values (non-negative integer).
 * @param {number} totalDebits   - Sum of all debitAmount values (non-negative integer).
 * @returns {{ balance: number, debt: number }}
 *   balance: can be negative (indicates debt)
 *   debt:    always non-negative (0 if no debt)
 */
function computeBalanceAndDebt(totalCredits, totalDebits) {
  assertNonNegativeInteger(totalCredits, 'إجمالي الإضافات');
  assertNonNegativeInteger(totalDebits, 'إجمالي الخصومات');

  const balance = subtract(totalCredits, totalDebits);
  const debt = Math.max(0, -balance);

  return { balance, debt };
}

/**
 * Calculates the debt settlement amount when a user deposits.
 *
 * DEBT SETTLEMENT SEQUENCE (spec §5):
 *   1. DEPOSIT transaction created for amount D
 *   2. New effective balance = previous_balance + D
 *   3. If new_balance > 0 AND existing_debt > 0:
 *      settlement_amount = MIN(existing_debt, new_balance_magnitude)
 *
 * @param {number} depositAmount    - The deposit amount (positive integer).
 * @param {number} currentBalance   - Balance BEFORE the deposit (can be negative).
 * @param {number} currentDebt      - Current outstanding debt (non-negative integer).
 * @returns {number} Settlement amount (0 if no settlement needed).
 *
 * @example
 *   // User has balance: -500 (debt: 500), deposits 300
 *   // New balance after deposit: -500 + 300 = -200 (still in debt)
 *   // No settlement — still negative
 *   computeDebtSettlement(300, -500, 500) // → 0
 *
 *   // User has balance: -500 (debt: 500), deposits 800
 *   // New balance after deposit: -500 + 800 = 300
 *   // Settlement: MIN(500, 300) = 300 (partial settlement)
 *   computeDebtSettlement(800, -500, 500) // → 300
 *
 *   // User has balance: -200 (debt: 200), deposits 1000
 *   // New balance after deposit: -200 + 1000 = 800
 *   // Settlement: MIN(200, 800) = 200 (full settlement)
 *   computeDebtSettlement(1000, -200, 200) // → 200
 */
function computeDebtSettlement(depositAmount, currentBalance, currentDebt) {
  assertPositiveInteger(depositAmount, 'مبلغ الإيداع');
  assertInteger(currentBalance, 'الرصيد الحالي');
  assertNonNegativeInteger(currentDebt, 'الدين الحالي');

  if (currentDebt === 0) return 0;

  const newBalance = currentBalance + depositAmount;
  if (newBalance <= 0) return 0; // Still in debt — no settlement

  // Settle the smaller of: total debt OR available surplus
  return Math.min(currentDebt, newBalance);
}

/**
 * Determines whether a new charge would cause the user to exceed their
 * maximum allowed debt (settings.maxDebtPerUser).
 *
 * @param {number} currentBalance   - Current balance (can be negative).
 * @param {number} chargeAmount     - Amount of the new charge (positive integer).
 * @param {number} maxDebtPerUser   - Max allowed debt (0 = unlimited).
 * @returns {{ wouldExceed: boolean, projectedDebt: number }}
 */
function checkDebtLimit(currentBalance, chargeAmount, maxDebtPerUser) {
  assertInteger(currentBalance, 'الرصيد الحالي');
  assertPositiveInteger(chargeAmount, 'مبلغ الرسوم');
  assertNonNegativeInteger(maxDebtPerUser, 'الحد الأقصى للدين');

  const projectedBalance = currentBalance - chargeAmount;
  const projectedDebt = Math.max(0, -projectedBalance);

  if (maxDebtPerUser === 0) {
    // 0 = unlimited debt allowed
    return { wouldExceed: false, projectedDebt };
  }

  return {
    wouldExceed: projectedDebt > maxDebtPerUser,
    projectedDebt,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Validation
  assertInteger,
  assertPositiveInteger,
  assertNonNegativeInteger,

  // Arithmetic
  add,
  subtract,

  // Financial calculations
  calculateWithdrawalFee,
  splitExpense,
  computeBalanceAndDebt,
  computeDebtSettlement,
  checkDebtLimit,

  // Constants
  MAX_SAFE_YER,
};
