import api from './axiosInstance';

export const withdrawalApi = {
  submit: (data) => api.post('/withdrawals', data),
  getMyRequests: (params = {}) => api.get('/withdrawals/mine', { params }),
  getFeePreview: (amount) => api.get('/withdrawals/fee-preview', { params: { amount } }),
};
