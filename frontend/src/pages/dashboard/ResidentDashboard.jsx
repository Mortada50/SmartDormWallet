/**
 * ResidentDashboard.jsx — Student wallet dashboard
 *
 * Sections:
 *   1. Balance Card     — Current balance + debt with dynamic color
 *   2. Debt Progress Bar — Color-coded: green → yellow → orange → red
 *   3. Quick Stats Row  — Monthly credit/debit summary
 *   4. Recent Transactions Table — Last 5 operations with icons & colors
 *   5. Quick Actions    — Deposit request, View statement shortcuts
 */

import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Wallet, TrendingDown, ArrowDownLeft, ArrowUpRight,
  ShoppingBag, Users, RefreshCw, FileText, RotateCcw,
  Bell, LogOut, ChevronLeft, AlertTriangle,
  PlusCircle, Download, Settings,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { formatDistanceToNow } from 'date-fns';
import { ar } from 'date-fns/locale';
import { walletApi } from '../../api/walletApi';
import { notificationApi } from '../../api/notificationApi';
import { QUERY_KEYS } from '../../api/queryKeys';
import { formatYER } from '../../utils/formatters';
import useAuthStore from '../../store/authStore';


// ── Transaction type metadata ──────────────────────────────────────────────

const TX_META = {
  DEPOSIT: {
    label: 'إيداع',
    Icon: ArrowDownLeft,
    colorClass: 'text-financial-green-400',
    bgClass: 'bg-financial-green-500/10',
    badge: 'badge-green',
    sign: '+',
  },
  WITHDRAWAL: {
    label: 'سحب',
    Icon: ArrowUpRight,
    colorClass: 'text-financial-red-400',
    bgClass: 'bg-financial-red-500/10',
    badge: 'badge-red',
    sign: '−',
  },
  WITHDRAWAL_FEE: {
    label: 'رسوم سحب',
    Icon: ArrowUpRight,
    colorClass: 'text-financial-red-400',
    bgClass: 'bg-financial-red-500/10',
    badge: 'badge-red',
    sign: '−',
  },
  SHARED_EXPENSE: {
    label: 'مصروف مشترك',
    Icon: Users,
    colorClass: 'text-financial-blue-400',
    bgClass: 'bg-financial-blue-500/10',
    badge: 'badge-blue',
    sign: '−',
  },
  MERCHANT_PURCHASE: {
    label: 'مشتريات',
    Icon: ShoppingBag,
    colorClass: 'text-purple-400',
    bgClass: 'bg-purple-500/10',
    badge: 'bg-purple-500/15 text-purple-400 border border-purple-500/25',
    sign: '−',
  },
  DEBT_SETTLEMENT: {
    label: 'تسوية دين',
    Icon: RotateCcw,
    colorClass: 'text-orange-400',
    bgClass: 'bg-orange-500/10',
    badge: 'bg-orange-500/15 text-orange-400 border border-orange-500/25',
    sign: '−',
  },
  ADJUSTMENT: {
    label: 'تعديل',
    Icon: RefreshCw,
    colorClass: 'text-slate-400',
    bgClass: 'bg-white/5',
    badge: 'badge-neutral',
    sign: '±',
  },
  REFUND: {
    label: 'استرداد',
    Icon: ArrowDownLeft,
    colorClass: 'text-financial-green-400',
    bgClass: 'bg-financial-green-500/10',
    badge: 'badge-green',
    sign: '+',
  },
};

// ── Debt bar color ─────────────────────────────────────────────────────────

function getDebtBarConfig(pct) {
  if (pct <= 0) return { color: 'bg-financial-green-500', label: 'لا توجد ديون', textColor: 'text-financial-green-400' };
  if (pct < 50) return { color: 'bg-financial-green-500', label: 'وضع جيد', textColor: 'text-financial-green-400' };
  if (pct < 70) return { color: 'bg-yellow-500', label: 'تحذير — يقترب من الحد', textColor: 'text-yellow-400' };
  if (pct < 90) return { color: 'bg-orange-500', label: 'خطر — تجاوز 70% من الحد', textColor: 'text-orange-400' };
  return { color: 'bg-financial-red-500', label: 'حرج — قارب الحد الأقصى', textColor: 'text-financial-red-400' };
}

// ── Skeleton loaders ───────────────────────────────────────────────────────

function BalanceSkeleton() {
  return (
    <div className="card-glass p-6 animate-pulse">
      <div className="skeleton h-5 w-1/3 mb-4 rounded-lg" />
      <div className="skeleton h-12 w-2/3 mb-2 rounded-xl" />
      <div className="skeleton h-4 w-1/4 rounded-lg" />
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-3 animate-pulse">
          <div className="skeleton w-10 h-10 rounded-xl flex-shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-4 w-1/3 rounded-lg" />
            <div className="skeleton h-3 w-1/2 rounded-lg" />
          </div>
          <div className="skeleton h-5 w-24 rounded-lg" />
        </div>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Main Component
// ══════════════════════════════════════════════════════════════════════════════

export default function ResidentDashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, logout } = useAuthStore();

  // ── React Query data fetching ─────────────────────────────────────────────────────

  const {
    data: balanceData,
    isLoading: balanceLoading,
    isError: balanceError,
    isFetching: balanceFetching,
  } = useQuery({
    queryKey: QUERY_KEYS.balance(),
    queryFn: () => walletApi.getBalance().then(r => r.data.data),
    staleTime: 30_000,
  });

  const {
    data: txData,
    isLoading: txLoading,
  } = useQuery({
    queryKey: QUERY_KEYS.transactions({ limit: 5 }),
    queryFn: () => walletApi.getTransactions({ limit: 5 }).then(r => r.data.data),
    staleTime: 30_000,
  });

  const { data: notifData } = useQuery({
    queryKey: QUERY_KEYS.notifications(),
    queryFn: () => notificationApi.getMyNotifications().then(r => r.data.data),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const unreadCount = notifData?.unreadCount ?? 0;


  const isLoading   = balanceLoading || txLoading;
  const hasError    = balanceError;
  const transactions = txData?.transactions ?? [];
  const debtLimit   = balanceData?.maxDebtLimit ?? 0;
  const isRefreshing = balanceFetching;

  const refetchAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.balance() });
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.transactions({ limit: 5 }) });
  }, [queryClient]);

  // ── Derived values ───────────────────────────────────────────────────────

  const balance = balanceData?.balance ?? 0;
  const debt    = balanceData?.debt    ?? 0;
  const debtPct = debtLimit > 0 ? Math.min(100, Math.round((debt / debtLimit) * 100)) : (debt > 0 ? 100 : 0);
  const debtBar = getDebtBarConfig(debtPct);

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  // ── Statement download ─────────────────────────────────────────────────────

  const downloadStatement = async () => {
    const today = new Date();
    const firstDay = '2020-01-01'; // Get all history
    const lastDay  = today.toISOString().slice(0, 10);

    const loading = toast.loading('جاري إعداد كشف الحساب...');
    try {
      const res = await walletApi.downloadStatement(firstDay, lastDay);
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `statement-${firstDay}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('تم تحميل كشف الحساب ✓', { id: loading });
    } catch {
      toast.error('فشل تحميل كشف الحساب', { id: loading });
    }
  };

  // ───────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-dvh bg-surface-dark">

      {/* ── Top Navigation Bar ────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 glass-bg border-b border-white/8">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div
              className="w-8 h-8 rounded-xl flex items-center justify-center"
              style={{ background: 'linear-gradient(135deg, #1B3A6B, #2563eb)' }}
            >
              <Wallet className="w-4 h-4 text-accent-400" />
            </div>
            <span className="font-bold text-white text-sm">المحفظة الذكية</span>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={refetchAll}
              disabled={isRefreshing}
              className="btn-ghost w-9 h-9 p-0"
              aria-label="تحديث"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              className="btn-ghost w-9 h-9 p-0 relative"
              aria-label="الإشعارات"
              onClick={() => navigate('/notifications')}
            >
              <Bell className="w-4 h-4" />
              {unreadCount > 0 && (
                <span
                  className="absolute -top-1 -right-1 min-w-[16px] h-4 px-0.5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center leading-none ring-2 ring-surface-dark animate-pulse"
                >
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>
            <button
              className="btn-ghost w-9 h-9 p-0"
              aria-label="الإعدادات"
              onClick={() => navigate('/profile')}
            >
              <Settings className="w-4 h-4" />
            </button>
            <button
              onClick={handleLogout}
              className="btn-ghost w-9 h-9 p-0 text-financial-red-400 hover:text-financial-red-300 hover:bg-financial-red-500/10"
              aria-label="تسجيل الخروج"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* ── Main content ─────────────────────────────────────────────── */}
      <main className="max-w-2xl mx-auto px-4 py-6 space-y-5">

        {/* Greeting */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <p className="text-slate-400 text-sm">مرحباً،</p>
          <h1 className="text-xl font-bold text-white">
            {user?.fullName || 'الطالب'}
          </h1>
          {user?.roomNumber && (
            <p className="text-slate-500 text-xs mt-0.5">غرفة {user.roomNumber}</p>
          )}
        </motion.div>

        {/* ── Balance Card ──────────────────────────────────────────── */}
        <AnimatePresence mode="wait">
          {isLoading ? (
            <BalanceSkeleton key="skel" />
          ) : hasError ? (
            <motion.div
              key="error"
              className="card-glass p-6 flex flex-col items-center gap-3 text-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              <AlertTriangle className="w-8 h-8 text-financial-red-400" />
              <p className="text-slate-400 text-sm">تعذر تحميل البيانات</p>
              <button onClick={refetchAll} className="btn-secondary text-sm py-2 px-4">
                إعادة المحاولة
              </button>
            </motion.div>
          ) : (
            <motion.div
              key="balance"
              className="relative overflow-hidden rounded-2xl"
              style={{ background: 'linear-gradient(135deg, #1B3A6B 0%, #1e4480 60%, #15307a 100%)' }}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            >
              {/* Card shine overlay */}
              <div className="absolute inset-0 bg-gradient-to-br from-white/8 via-transparent to-transparent pointer-events-none" />
              <div className="absolute top-0 left-0 w-full h-px bg-white/15" />

              <div className="relative p-6">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <p className="text-blue-300/80 text-xs font-medium mb-1">الرصيد الحالي</p>
                    <motion.p
                      className={`balance-amount text-4xl sm:text-5xl font-black tracking-tight ${
                        balance < 0 ? 'text-financial-red-400' : 'text-white'
                      }`}
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: 0.15, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                    >
                      {formatYER(balance)}
                    </motion.p>
                  </div>
                  <div
                    className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
                    style={{ background: 'rgba(255,255,255,0.1)' }}
                  >
                    <Wallet className="w-6 h-6 text-white" />
                  </div>
                </div>

                {/* Debt row */}
                {debt > 0 && (
                  <motion.div
                    className="flex items-center gap-2 mb-4"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.3 }}
                  >
                    <span className="badge bg-financial-red-500/20 text-financial-red-300 border border-financial-red-500/30">
                      <TrendingDown className="w-3 h-3" />
                      دين مستحق: {formatYER(debt)}
                    </span>
                  </motion.div>
                )}

                {/* Debt Progress Bar */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-blue-300/70 text-xs">حد الدين الأقصى</span>
                    <span className={`text-xs font-semibold ${debtBar.textColor}`}>
                      {debtLimit > 0 ? `${debtPct}% — ${debtBar.label}` : (debt > 0 ? 'لا يوجد حد محدد' : 'لا توجد ديون')}
                    </span>
                  </div>
                  <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                    <motion.div
                      className={`h-full rounded-full ${debtBar.color} transition-colors duration-700`}
                      initial={{ width: 0 }}
                      animate={{ width: `${debtPct}%` }}
                      transition={{ delay: 0.4, duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
                    />
                  </div>
                  {debtLimit > 0 && (
                    <div className="flex justify-between mt-1">
                      <span className="text-blue-300/50 text-xs">0</span>
                      <span className="text-blue-300/50 text-xs">{formatYER(debtLimit)}</span>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Quick Actions ─────────────────────────────────────────── */}
        {!isLoading && !hasError && (
          <motion.div
            className="grid grid-cols-4 gap-3"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25, duration: 0.4 }}
          >
            <button
              onClick={() => navigate('/deposits/new')}
              className="card-glass-hover p-4 flex flex-col items-center gap-2 text-center group"
            >
              <div className="w-10 h-10 rounded-xl bg-financial-green-500/15 flex items-center justify-center group-hover:bg-financial-green-500/25 transition-colors">
                <PlusCircle className="w-5 h-5 text-financial-green-400" />
              </div>
              <span className="text-sm font-medium text-white">إيداع</span>
            </button>

            <button
              onClick={() => navigate('/expenses')}
              className="card-glass-hover p-4 flex flex-col items-center gap-2 text-center group"
            >
              <div className="w-10 h-10 rounded-xl bg-purple-500/15 flex items-center justify-center group-hover:bg-purple-500/25 transition-colors">
                <Users className="w-5 h-5 text-purple-400" />
              </div>
              <span className="text-sm font-medium text-white">مصاريف</span>
            </button>

            <button
              onClick={() => navigate('/withdrawals/new')}
              className="card-glass-hover p-4 flex flex-col items-center gap-2 text-center group"
            >
              <div className="w-10 h-10 rounded-xl bg-orange-500/15 flex items-center justify-center group-hover:bg-orange-500/25 transition-colors">
                <ArrowUpRight className="w-5 h-5 text-orange-400" />
              </div>
              <span className="text-sm font-medium text-white">سحب</span>
            </button>

            <button
              onClick={downloadStatement}
              className="card-glass-hover p-4 flex flex-col items-center gap-2 text-center group"
            >
              <div className="w-10 h-10 rounded-xl bg-financial-blue-500/15 flex items-center justify-center group-hover:bg-financial-blue-500/25 transition-colors">
                <Download className="w-5 h-5 text-financial-blue-400" />
              </div>
              <span className="text-sm font-medium text-white">كشف</span>
            </button>
          </motion.div>
        )}

        {/* ── Recent Transactions ───────────────────────────────────── */}
        <motion.div
          className="card-glass"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.45 }}
        >
          <div className="flex items-center justify-between px-5 pt-5 pb-3">
            <h2 className="section-heading">آخر العمليات</h2>
            <button
              onClick={() => navigate('/transactions')}
              className="btn-ghost text-xs text-accent-400 hover:text-accent-300 py-1.5 px-3"
            >
              عرض الكل
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="divider my-0" />

          {isLoading ? (
            <div className="px-4 py-4">
              <TableSkeleton />
            </div>
          ) : transactions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
              <Wallet className="w-10 h-10 text-slate-600 mb-3" />
              <p className="text-slate-500 text-sm font-medium">لا توجد عمليات حتى الآن</p>
              <p className="text-slate-600 text-xs mt-1">ستظهر معاملاتك هنا فور اعتمادها</p>
            </div>
          ) : (
            <ul className="divide-y divide-white/5">
              {transactions.map((tx, index) => {
                const meta = TX_META[tx.type] || TX_META.ADJUSTMENT;
                const { Icon } = meta;
                const isCredit = tx.creditAmount > 0;
                const displayAmount = isCredit ? tx.creditAmount : tx.debitAmount;

                return (
                  <motion.li
                    key={tx.publicId}
                    className="table-row-hover"
                    initial={{ opacity: 0, x: 12 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.35 + index * 0.05, duration: 0.35 }}
                  >
                    <button
                      className="w-full flex items-center gap-3 px-5 py-4 text-right"
                      onClick={() => navigate(`/transactions/${tx.publicId}`)}
                    >
                      {/* Icon */}
                      <div className={`w-10 h-10 rounded-xl ${meta.bgClass} flex items-center justify-center flex-shrink-0`}>
                        <Icon className={`w-4.5 h-4.5 ${meta.colorClass}`} />
                      </div>

                      {/* Labels */}
                      <div className="flex-1 min-w-0 text-right">
                        <p className="text-white text-sm font-medium truncate">
                          {meta.label}
                        </p>
                        <p className="text-slate-500 text-xs truncate mt-0.5">
                          {tx.description || meta.label}
                        </p>
                        <p className="text-slate-600 text-xs mt-0.5">
                          {formatDistanceToNow(new Date(tx.createdAt), { addSuffix: true, locale: ar })}
                        </p>
                      </div>

                      {/* Amount */}
                      <div className="text-left flex-shrink-0">
                        <p className={`balance-amount text-sm font-bold ${isCredit ? 'text-financial-green-400' : 'text-financial-red-400'}`}>
                          {isCredit ? '+' : '−'} {formatYER(displayAmount)}
                        </p>
                        <span className={`badge text-xs mt-1 inline-flex ${meta.badge}`}>
                          {tx.currency || 'YER'}
                        </span>
                      </div>
                    </button>
                  </motion.li>
                );
              })}
            </ul>
          )}

          {/* View all footer */}
          {!isLoading && transactions.length > 0 && (
            <div className="p-3 border-t border-white/5">
              <button
                onClick={() => navigate('/transactions')}
                className="btn-ghost w-full text-sm text-slate-400"
              >
                <FileText className="w-4 h-4" />
                عرض كافة العمليات
              </button>
            </div>
          )}
        </motion.div>

        {/* Bottom safe area */}
        <div className="pb-safe h-4" />
      </main>
    </div>
  );
}
