/**
 * adminApi.js — API endpoints for admin dashboard and system control
 */
import api from './axiosInstance';

export const adminApi = {
  // Dashboard & Reports
  getDashboardStats: () => api.get('/admin/dashboard'),
  
  downloadMonthlyReport: () =>
    api.get('/admin/reports/monthly', { responseType: 'blob' }),

  // System Settings
  getSettings: () => api.get('/admin/settings'),
  updateSettings: (data) => api.patch('/admin/settings', data),

  // Pending Deposits Review
  getPendingDeposits: (params = {}) => api.get('/deposits/pending', { params }),
  approveDeposit: (depositPublicId) =>
    api.patch(`/deposits/${depositPublicId}/approve`),
  rejectDeposit: (depositPublicId, rejectionReason) =>
    api.patch(`/deposits/${depositPublicId}/reject`, { reason: rejectionReason }),

  // Withdrawals
  getPendingWithdrawals: (params = {}) => api.get('/withdrawals/pending', { params }),
  approveWithdrawal:     (id, formData) => api.patch(`/withdrawals/${id}/approve`, formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
  rejectWithdrawal:      (id, reason) => api.patch(`/withdrawals/${id}/reject`, { reason }),

  // User Management
  getUsers: (params = {}) => api.get('/admin/users', { params }),

  // Disputes
  getDisputes: () => api.get('/admin/disputes'),
  resolveDispute: (expensePublicId, resolutionData) =>
    api.patch(`/admin/disputes/${expensePublicId}/resolve`, resolutionData),

  // Shared Expenses (admin)
  getExpenses: (params = {}) => api.get('/expenses', { params }),
  createExpense: (data) => api.post('/expenses', data),
};
