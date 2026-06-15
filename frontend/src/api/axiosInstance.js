/**
 * axiosInstance.js — Centralized HTTP client for Smart Dorm Wallet API
 *
 * Features:
 *  • Auto-injects Authorization: Bearer <accessToken> on every request
 *  • Intercepts 401 → silently refreshes token via /auth/refresh
 *  • Queue-based retry: concurrent requests wait for one refresh to complete
 *  • On refresh failure → clears auth state and redirects to /login
 *  • Server Arabic error messages are forwarded to react-hot-toast
 */

import axios from 'axios';
import toast from 'react-hot-toast';

// ── Base instance ──────────────────────────────────────────────────────────

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api/v1',
  timeout: 20_000,
  withCredentials: true, // for httpOnly refresh-token cookie (optional)
  headers: {
    'Content-Type': 'application/json',
    'Accept-Language': 'ar',
  },
});

// ── Auth store bridge (avoids circular imports) ────────────────────────────
// axiosInstance does not import zustand store directly. Instead, it reads
// from localStorage and calls a callback set by the auth store.

const TOKEN_KEY = 'sdw_access_token';
let _onAuthFailure = null; // Set by auth store after hydration

export function setAuthFailureCallback(cb) {
  _onAuthFailure = cb;
}

export function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

// ── Refresh-token queue ────────────────────────────────────────────────────
// Prevents multiple concurrent 401 responses from each triggering a refresh.

let isRefreshing = false;
let refreshQueue = []; // Array of { resolve, reject }

function processQueue(error, token = null) {
  refreshQueue.forEach(({ resolve, reject }) =>
    error ? reject(error) : resolve(token)
  );
  refreshQueue = [];
}

// ── Request Interceptor — inject access token ──────────────────────────────

api.interceptors.request.use(
  (config) => {
    const token = getStoredToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// ── Response Interceptor — handle errors & token refresh ──────────────────

api.interceptors.response.use(
  // ✅ Pass through successful responses
  (response) => response,

  // ❌ Handle errors
  async (error) => {
    const originalRequest = error.config;

    // ── Extract Arabic server message for toast ────────────────────────────
    const serverMessage =
      error.response?.data?.message ||
      error.response?.data?.error ||
      null;

    // ── Handle 401 Unauthorized ────────────────────────────────────────────
    if (error.response?.status === 401 && !originalRequest._retry) {
      // Don't retry the refresh endpoint or the login endpoint
      if (originalRequest.url?.includes('/auth/refresh') || originalRequest.url?.includes('/auth/login')) {
        if (originalRequest.url?.includes('/auth/refresh')) {
          handleAuthFailure('انتهت صلاحية الجلسة. يرجى تسجيل الدخول مرة أخرى.');
        } else {
          // It's a login failure, just show the toast and reject without redirecting
          toast.error(serverMessage || 'بيانات الدخول غير صحيحة');
        }
        return Promise.reject(error);
      }

      if (isRefreshing) {
        // Queue this request while refresh is in progress
        return new Promise((resolve, reject) => {
          refreshQueue.push({ resolve, reject });
        })
          .then((newToken) => {
            originalRequest.headers.Authorization = `Bearer ${newToken}`;
            return api(originalRequest);
          })
          .catch((err) => Promise.reject(err));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const { data } = await axios.post(
          `${api.defaults.baseURL}/auth/refresh`,
          {},
          { withCredentials: true }
        );

        const newToken = data.data?.accessToken;
        if (!newToken) throw new Error('لم يتم إرجاع توكن جديد');

        setStoredToken(newToken);
        api.defaults.headers.common.Authorization = `Bearer ${newToken}`;
        originalRequest.headers.Authorization = `Bearer ${newToken}`;

        processQueue(null, newToken);
        return api(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError, null);
        handleAuthFailure('انتهت صلاحية جلستك. يرجى تسجيل الدخول مجدداً.');
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    // ── Handle other HTTP errors with Arabic toasts ────────────────────────
    if (error.response) {
      const status = error.response.status;

      if (status === 403) {
        toast.error('ليس لديك صلاحية للقيام بهذا الإجراء');
      } else if (status === 404) {
        // Only show if it's not a background fetch
        if (!originalRequest._silent) {
          toast.error(serverMessage || 'البيانات المطلوبة غير موجودة');
        }
      } else if (status === 409) {
        toast.error(serverMessage || 'تعارض في البيانات — يرجى المحاولة مرة أخرى');
      } else if (status === 422) {
        toast.error(serverMessage || 'بيانات غير صحيحة');
      } else if (status === 429) {
        toast.error('تم تجاوز حد الطلبات المسموح. يرجى الانتظار قليلاً.');
      } else if (status >= 500) {
        toast.error('حدث خطأ في الخادم — يرجى المحاولة لاحقاً');
      } else if (serverMessage) {
        toast.error(serverMessage);
      }
    } else if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
      toast.error('انتهت مهلة الاتصال — يرجى التحقق من الشبكة');
    } else if (!error.response) {
      toast.error('تعذر الاتصال بالخادم — يرجى التحقق من اتصالك بالإنترنت');
    }

    return Promise.reject(error);
  }
);

// ── Auth failure handler ───────────────────────────────────────────────────

function handleAuthFailure(message) {
  setStoredToken(null);
  toast.error(message, { id: 'auth-failure', duration: 4000 });
  if (_onAuthFailure) {
    _onAuthFailure();
  } else {
    // Fallback: hard redirect
    window.location.href = '/login';
  }
}

// ── Convenience helpers ───────────────────────────────────────────────────

/**
 * Mark a request as "silent" so 404 errors don't trigger a toast.
 * Usage: api.get('/endpoint', { _silent: true })
 */
export function silentGet(url, config = {}) {
  return api.get(url, { ...config, _silent: true });
}

export default api;
