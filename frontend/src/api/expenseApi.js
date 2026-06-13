/**
 * expenseApi.js — Shared expense API calls
 */
import api from './axiosInstance';

export const expenseApi = {
  getMyExpenses: (params = {}) =>
    api.get('/expenses/my', { params }),

  getExpense: (publicId) =>
    api.get(`/expenses/${publicId}`),

  /**
   * File a financial dispute for a shared expense.
   * @param {string} expensePublicId
   * @param {string} reason - Arabic reason text (min 10 chars)
   */
  fileDispute: (expensePublicId, reason) =>
    api.post(`/expenses/${expensePublicId}/disputes`, { reason }),
};
