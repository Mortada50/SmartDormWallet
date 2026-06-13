/**
 * walletApi.js — Wallet & balance API calls
 */
import api from './axiosInstance';

export const walletApi = {
  getBalance: () => api.get('/wallet/balance'),
  getTransactions: (params = {}) => api.get('/wallet/transactions', { params }),
  getTransaction: (publicId) => api.get(`/transactions/${publicId}`),
  getDebt: () => api.get('/wallet/debt'),
  /** Download statement as PDF blob */
  downloadStatement: (startDate, endDate) =>
    api.get('/wallet/statement', {
      params: { startDate, endDate },
      responseType: 'blob',
    }),
  // Admin only
  getUserTransactions: (userPublicId, params = {}) => 
    api.get(`/users/${userPublicId}/transactions`, { params }),
};
