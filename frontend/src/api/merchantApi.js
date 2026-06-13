/**
 * merchantApi.js — API endpoints for merchant management
 */
import api from './axiosInstance';

export const merchantApi = {
  // List all merchants (admin)
  getMerchants: (params = {}) => api.get('/merchants', { params }),

  // Get active merchants (dropdown)
  getActiveMerchants: () => api.get('/merchants/active'),

  // Get single merchant with balance
  getMerchant: (merchantPublicId) => api.get(`/merchants/${merchantPublicId}`),

  // Create merchant
  createMerchant: (data) => api.post('/merchants', data),

  // Update merchant info
  updateMerchant: (merchantPublicId, data) => api.patch(`/merchants/${merchantPublicId}`, data),

  // Disable merchant
  disableMerchant: (merchantPublicId) => api.patch(`/merchants/${merchantPublicId}/disable`),

  // Record a purchase (splits among users)
  recordPurchase: (merchantPublicId, data) => api.post(`/merchants/${merchantPublicId}/purchase`, data),

  // Record a settlement (cash payment to merchant)
  recordSettlement: (merchantPublicId, data) => api.post(`/merchants/${merchantPublicId}/settle`, data),

  // Merchant transaction history
  getMerchantTransactions: (merchantPublicId, params = {}) =>
    api.get(`/merchants/${merchantPublicId}/transactions`, { params }),
};
