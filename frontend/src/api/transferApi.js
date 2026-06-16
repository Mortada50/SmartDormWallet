/**
 * transferApi.js — Peer-to-peer transfer API calls
 */
import api from './axiosInstance';

export const transferApi = {
  /** Look up a user by account number (returns name + room only) */
  lookup: (accountNumber) =>
    api.get('/transfers/lookup', { params: { accountNumber } }),

  /** Generate account number for current user (one-time) */
  generateAccountNumber: () =>
    api.post('/transfers/generate-account-number'),

  /** Execute a transfer */
  createTransfer: ({ accountNumber, amount, note }) =>
    api.post('/transfers', { accountNumber, amount, note }),
};
