/**
 * queryKeys.js — Centralized React Query cache key registry
 *
 * All keys are functions that return arrays, enabling precise cache invalidation.
 * After any financial mutation, invalidate the relevant keys to trigger refetch.
 *
 * Example:
 *   queryClient.invalidateQueries({ queryKey: QUERY_KEYS.balance() });
 */

export const QUERY_KEYS = {
  // Wallet
  balance:      ()                  => ['wallet', 'balance'],
  transactions: (filters = {})      => ['wallet', 'transactions', filters],
  transaction:  (publicId)          => ['wallet', 'transaction', publicId],
  debt:         ()                  => ['wallet', 'debt'],

  // Deposits
  myDeposits:   (filters = {})      => ['deposits', 'mine', filters],
  receiptUrl:   (depositPublicId)   => ['deposits', 'receipt', depositPublicId],
  myWithdrawals: (filters = {})      => ['withdrawals', 'mine', filters],

  // Expenses
  myExpenses:   (filters = {})      => ['expenses', 'mine', filters],
  expense:      (publicId)          => ['expenses', 'detail', publicId],

  // Admin
  adminStats:         ()               => ['admin', 'stats'],
  adminSettings:      ()               => ['admin', 'settings'],
  pendingDeposits:    (filters = {})   => ['admin', 'deposits', 'pending', filters],
  pendingWithdrawals: (filters = {})   => ['admin', 'withdrawals', 'pending', filters],
  adminUsers:         (filters = {})   => ['admin', 'users', filters],
  adminDisputes:      ()               => ['admin', 'disputes'],
  adminExpenses:      (filters = {})   => ['admin', 'expenses', filters],
  merchants:          (filters = {})   => ['merchants', 'list', filters],
  merchant:           (id)             => ['merchants', 'detail', id],
  merchantTxs:        (id, f = {})     => ['merchants', 'txs', id, f],

  // Notifications
  notifications:      (filters = {})   => ['notifications', filters],
};

