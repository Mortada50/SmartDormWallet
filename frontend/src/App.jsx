/**
 * App.jsx — Root router and auth guard
 *
 * Route structure:
 *   /login              → Login page (public)
 *   /2fa                → TwoFactorAuth (public, needs phone state)
 *   /dashboard          → ResidentDashboard (resident only)
 *   /transactions       → Transaction history
 *   /admin/dashboard    → Admin panel (admin/deputy)
 *   /                   → Redirect by role
 */

import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import useAuthStore from './store/authStore';

// Lazy-loaded pages
import Login from './pages/auth/Login';
import TwoFactorAuth from './pages/auth/TwoFactorAuth';
import ResidentDashboard from './pages/dashboard/ResidentDashboard';
import DepositRequestForm from './pages/operations/DepositRequestForm';
import SharedExpenses from './pages/operations/SharedExpenses';
import TransactionsHistory from './pages/operations/TransactionsHistory';
import DepositsHistory from './pages/operations/DepositsHistory';
import WithdrawalsHistory from './pages/operations/WithdrawalsHistory';
import WithdrawalRequestForm from './pages/operations/WithdrawalRequestForm';
import NotificationCenter from './pages/operations/NotificationCenter';
import ResidentProfile from './pages/profile/ResidentProfile';
import TransferForm from './pages/operations/TransferForm';

// Admin Pages
import AdminLayout from './components/layout/AdminLayout';
import AdminDashboard from './pages/admin/AdminDashboard';
import PendingDeposits from './pages/admin/PendingDeposits';
import PendingWithdrawals from './pages/admin/PendingWithdrawals';
import UserManagement from './pages/admin/UserManagement';
import DisputesManagement from './pages/admin/DisputesManagement';
import SharedExpensesAdmin from './pages/admin/SharedExpensesAdmin';
import MerchantsManagement from './pages/admin/MerchantsManagement';
import SystemSettings from './pages/admin/SystemSettings';

// Components
import InstallPrompt from './components/InstallPrompt';

// ── React Query client ─────────────────────────────────────────────────────

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,         // 1 minute
      gcTime: 5 * 60_000,        // 5 minutes
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

// ── Auth Guards ────────────────────────────────────────────────────────────

function RequireAuth({ children, allowedRoles }) {
  const { user, isAuthenticated, isLoading } = useAuthStore();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-surface-dark">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-accent-500 animate-spin" />
          <p className="text-slate-400 text-sm font-medium">جاري التحقق من هويتك...</p>
        </div>
      </div>
    );
  }
  

  if (!isAuthenticated || !user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    // Wrong role — redirect to correct dashboard
    const target = user.role === 'resident' ? '/dashboard' : '/admin/dashboard';
    return <Navigate to={target} replace />;
  }

  return children;
}

function RedirectToDashboard() {
  const { user, isAuthenticated, isLoading } = useAuthStore();

  if (isLoading) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-surface-dark">
        <Loader2 className="w-8 h-8 text-accent-500 animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated || !user) return <Navigate to="/login" replace />;
  return <Navigate to={user.role === 'resident' ? '/dashboard' : '/admin/dashboard'} replace />;
}

// ── Toast configuration ────────────────────────────────────────────────────

const TOAST_CONFIG = {
  duration: 4000,
  position: 'top-center',
  style: {
    background: '#1a2440',
    color: '#e2e8f0',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '12px',
    fontFamily: 'Cairo, sans-serif',
    fontSize: '14px',
    fontWeight: '500',
    padding: '12px 16px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
    direction: 'rtl',
  },
  success: {
    iconTheme: { primary: '#22c55e', secondary: '#1a2440' },
  },
  error: {
    iconTheme: { primary: '#f43f5e', secondary: '#1a2440' },
  },
};

// ── Hydration wrapper ──────────────────────────────────────────────────────

function AppHydrator({ children }) {
  const { hydrate } = useAuthStore();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  return children;
}

// ── App ────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppHydrator>
          <Toaster toastOptions={TOAST_CONFIG} />
          <InstallPrompt />

          <Routes>
            {/* Public routes */}
            <Route path="/login" element={<Login />} />
            <Route path="/2fa"   element={<TwoFactorAuth />} />

            {/* Root redirect */}
            <Route path="/" element={<RedirectToDashboard />} />

            {/* Resident routes */}
            <Route
              path="/dashboard"
              element={
                <RequireAuth allowedRoles={['resident', 'admin', 'deputy']}>
                  <ResidentDashboard />
                </RequireAuth>
              }
            />

            {/* Operations */}
            <Route
              path="/deposits/new"
              element={
                <RequireAuth allowedRoles={['resident']}>
                  <DepositRequestForm />
                </RequireAuth>
              }
            />
            <Route
              path="/expenses"
              element={
                <RequireAuth allowedRoles={['resident', 'admin', 'deputy']}>
                  <SharedExpenses />
                </RequireAuth>
              }
            />
            <Route
              path="/profile"
              element={
                <RequireAuth allowedRoles={['resident', 'admin', 'deputy']}>
                  <ResidentProfile />
                </RequireAuth>
              }
            />

            {/* Placeholder routes — expand in subsequent milestones */}
            <Route
              path="/transactions"
              element={
                <RequireAuth allowedRoles={['resident', 'admin', 'deputy']}>
                  <TransactionsHistory />
                </RequireAuth>
              }
            />
            <Route
              path="/deposits/history"
              element={
                <RequireAuth allowedRoles={['resident']}>
                  <DepositsHistory />
                </RequireAuth>
              }
            />
            <Route
              path="/notifications"
              element={
                <RequireAuth allowedRoles={['resident', 'admin', 'deputy']}>
                  <NotificationCenter />
                </RequireAuth>
              }
            />
            <Route
              path="/withdrawals/new"
              element={
                <RequireAuth allowedRoles={['resident']}>
                  <WithdrawalRequestForm />
                </RequireAuth>
              }
            />
            <Route
              path="/transfers/new"
              element={
                <RequireAuth allowedRoles={['resident']}>
                  <TransferForm />
                </RequireAuth>
              }
            />
            <Route
              path="/withdrawals/history"
              element={
                <RequireAuth allowedRoles={['resident']}>
                  <WithdrawalsHistory />
                </RequireAuth>
              }
            />

            {/* Admin Routes wrapped in AdminLayout */}
            <Route
              path="/admin"
              element={
                <RequireAuth allowedRoles={['admin', 'deputy']}>
                  <AdminLayout />
                </RequireAuth>
              }
            >
              <Route path="dashboard" element={<AdminDashboard />} />
              <Route path="deposits" element={<PendingDeposits />} />
              <Route path="withdrawals" element={<PendingWithdrawals />} />
              <Route path="users" element={<UserManagement />} />
              <Route path="users/:userPublicId/transactions" element={<TransactionsHistory />} />
              <Route path="disputes" element={<DisputesManagement />} />
              <Route path="expenses" element={<SharedExpensesAdmin />} />
              <Route path="merchants" element={<MerchantsManagement />} />
              <Route path="settings" element={<SystemSettings />} />
            </Route>

            {/* 404 */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AppHydrator>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

// ── Placeholder for upcoming pages ────────────────────────────────────────

function PlaceholderPage({ title }) {
  const navigate = useNavigate();
  return (
    <div className="min-h-dvh bg-surface-dark flex flex-col items-center justify-center gap-4 p-4">
      <div className="card-glass p-8 max-w-sm w-full text-center">
        <p className="text-slate-400 text-sm mb-2">قريباً</p>
        <h2 className="text-white text-xl font-bold mb-4">{title}</h2>
        <p className="text-slate-500 text-sm mb-6">هذه الصفحة ستكون متاحة في المراحل القادمة</p>
        <button onClick={() => navigate(-1)} className="btn-secondary text-sm py-2 px-5">
          العودة
        </button>
      </div>
    </div>
  );
}
