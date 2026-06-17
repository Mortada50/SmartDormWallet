/**
 * authApi.js — Authentication and User Profile API calls
 */
import api from './axiosInstance';

export const authApi = {
  /** Fetch current user profile */
  me: () => api.get('/auth/me'),

  /** Add a saved beneficiary */
  addBeneficiary: (beneficiaryData) =>
    api.post('/auth/beneficiaries', beneficiaryData),

  /** Remove a saved beneficiary by account number */
  removeBeneficiary: (accountNumber) =>
    api.delete(`/auth/beneficiaries/${accountNumber}`),
};
