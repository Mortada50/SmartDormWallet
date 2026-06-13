/**
 * authStore.js — Zustand store for authentication state
 *
 * State:
 *   user         - Current user object (publicId, fullName, role, etc.)
 *   isAuthenticated
 *   isLoading    - Initial hydration in progress
 *
 * Actions:
 *   login(credentials)  - POST /auth/login, set token, hydrate user
 *   logout()            - POST /auth/logout, clear state
 *   hydrate()           - Load user from stored token on app mount
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import api, { setStoredToken, getStoredToken, setAuthFailureCallback } from '../api/axiosInstance';

const useAuthStore = create(
  persist(
    (set) => ({
      user: null,
      isAuthenticated: false,
      isLoading: true,

      // ── Login ──────────────────────────────────────────────────────────
      login: async (credentials) => {
        const { data } = await api.post('/auth/login', credentials);
        const { accessToken, user } = data.data;

        setStoredToken(accessToken);
        set({ user, isAuthenticated: true, isLoading: false });
        return user;
      },

      // ── Logout ─────────────────────────────────────────────────────────
      logout: async () => {
        try {
          await api.post('/auth/logout');
        } catch {
          // Still clear local state even if server call fails
        }
        setStoredToken(null);
        set({ user: null, isAuthenticated: false, isLoading: false });
      },

      // ── Hydrate from stored token ──────────────────────────────────────
      hydrate: async () => {
        const token = getStoredToken();
        if (!token) {
          set({ isLoading: false });
          return;
        }
        try {
          const { data } = await api.get('/auth/me');
          set({ user: data.data.user, isAuthenticated: true, isLoading: false });
        } catch {
          setStoredToken(null);
          set({ user: null, isAuthenticated: false, isLoading: false });
        }
      },

      // ── Update User State ──────────────────────────────────────────────
      updateUser: (updates) => {
        set((state) => ({
          user: state.user ? { ...state.user, ...updates } : null,
        }));
      },

      // ── Internal: clear auth (called on refresh failure) ───────────────
      _clearAuth: () => {
        setStoredToken(null);
        set({ user: null, isAuthenticated: false, isLoading: false });
      },
    }),
    {
      name: 'sdw-auth',
      partialize: (state) => ({ user: state.user, isAuthenticated: state.isAuthenticated }),
    }
  )
);

// Register auth failure callback with axios (after store is created)
setAuthFailureCallback(() => {
  useAuthStore.getState()._clearAuth();
  window.location.href = '/login';
});

export default useAuthStore;
