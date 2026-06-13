/**
 * depositApi.js — Deposit request API calls
 */
import api from './axiosInstance';

export const depositApi = {
  /**
   * Submit a deposit request with an attached receipt image.
   * Uses multipart/form-data — amount and referenceNumber are FormData fields.
   * @param {FormData} formData
   */
  submit: (formData) =>
    api.post('/deposits', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),

  getMyRequests: (params = {}) => api.get('/deposits/mine', { params }),

  getReceiptUrl: (depositPublicId) =>
    api.get(`/deposits/${depositPublicId}/receipt`),
};
