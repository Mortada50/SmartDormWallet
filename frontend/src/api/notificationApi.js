/**
 * notificationApi.js — Notification center API endpoints
 */
import api from './axiosInstance';

export const notificationApi = {
  getMyNotifications: (params = {}) => api.get('/notifications', { params }),
  markAsRead: (publicId = null) => api.patch('/notifications/read', { publicId }),
};
