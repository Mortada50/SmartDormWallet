/**
 * SharedExpenses.jsx — Student's shared expenses management page
 *
 * Features:
 *   • Paginated list of expenses the student participates in
 *   • Per-expense: name, student's share, total amount, who created it, status badge
 *   • Status-based color coding: active=blue, disputed=orange, settled=green
 *   • "رفع نزاع" button → opens DisputeModal
 *   • After dispute → expense status flips to 'disputed' immediately (optimistic update)
 *   • Filter tabs: الكل / نشط / نزاع / مسوّى
 *   • Infinite scroll / load-more pagination
 */

import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Users, AlertTriangle, CheckCircle2, Clock,
  ChevronLeft, ArrowRight, Loader2, RefreshCw,
  Calendar, User, AlertCircle, Receipt,
} from 'lucide-react';
import toast from 'react-hot-toast';

import useAuthStore from '../../store/authStore';
import { expenseApi } from '../../api/expenseApi';
import { QUERY_KEYS } from '../../api/queryKeys';
import { formatYER, formatDate, formatRelative } from '../../utils/formatters';
import DisputeModal from './DisputeModal';

// ── Status metadata ────────────────────────────────────────────────────────

const STATUS_META = {
  active: {
    label: 'نشط',
    Icon: Clock,
    badgeClass: 'badge-blue',
    rowBorder: 'border-blue-500/20',
    canDispute: true,
  },
  disputed: {
    label: 'نزاع',
    Icon: AlertTriangle,
    badgeClass: 'badge-gold',
    rowBorder: 'border-yellow-500/20',
    canDispute: false,
  },
  settled: {
    label: 'مسوّى',
    Icon: CheckCircle2,
    badgeClass: 'badge-green',
    rowBorder: 'border-green-500/20',
    canDispute: false,
  },
  resolved: {
    label: 'محسوم',
    Icon: CheckCircle2,
    badgeClass: 'badge-green',
    rowBorder: 'border-green-500/20',
    canDispute: false,
  },
};

/** Compute the display status from the expense document */
function computeExpenseStatus(expense) {
  // If expense has a status field, use it
  if (expense.status && expense.status !== 'active') return expense.status;
  // Otherwise derive from disputes array
  if (expense.disputes && expense.disputes.length > 0) {
    const hasOpen = expense.disputes.some(d => d.status === 'open');
    if (hasOpen) return 'disputed';
    const allResolved = expense.disputes.every(
      d => d.status === 'resolved_dismissed' || d.status === 'resolved_refunded'
    );
    if (allResolved) return 'settled';
  }
  return 'active';
}

const FILTER_TABS = [
  { key: 'all',      label: 'الكل' },
  { key: 'active',   label: 'نشطة' },
  { key: 'disputed', label: 'نزاعات' },
  { key: 'settled',  label: 'مسوّاة' },
];

// ── Skeleton loader ────────────────────────────────────────────────────────

function ExpenseSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="card-glass p-4 animate-pulse">
          <div className="flex items-start gap-3">
            <div className="skeleton w-10 h-10 rounded-xl flex-shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="skeleton h-4 w-3/5 rounded-lg" />
              <div className="skeleton h-3 w-2/5 rounded-lg" />
              <div className="skeleton h-3 w-1/4 rounded-lg" />
            </div>
            <div className="space-y-1.5">
              <div className="skeleton h-5 w-24 rounded-lg" />
              <div className="skeleton h-7 w-20 rounded-lg" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Expense card ──────────────────────────────────────────────────────────

function ExpenseCard({ expense, onDispute }) {
  const { user } = useAuthStore();
  const status = computeExpenseStatus(expense);
  const meta = STATUS_META[status] || STATUS_META.active;
  const { Icon } = meta;

  // Find current user's share
  const myShare = expense.shareAmount
    ?? expense.affectedUsers?.find(s => s.userPublicId === user?.publicId)?.shareAmount;

  return (
    <motion.div
      layout
      className={`card-glass border ${meta.rowBorder} overflow-hidden`}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.3 }}
    >
      <div className="p-4">
        {/* Top row: Icon + Name + Badge */}
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center flex-shrink-0">
            <Users className="w-5 h-5 text-blue-400" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-white font-semibold text-sm leading-snug truncate">
                {expense.name}
              </p>
              <span className={`badge ${meta.badgeClass} flex-shrink-0`}>
                <Icon className="w-3 h-3" />
                {meta.label}
              </span>
            </div>

            {expense.description && (
              <p className="text-slate-500 text-xs mt-0.5 line-clamp-1">
                {expense.description}
              </p>
            )}

            {/* Metadata row */}
            <div className="flex items-center gap-3 mt-1.5 flex-wrap text-xs text-slate-500">
              <span className="flex items-center gap-1">
                <User className="w-3 h-3" />
                {expense.performedByName || 'المسؤول'}
              </span>
              <span className="flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                {formatRelative(expense.createdAt)}
              </span>
              <span className="flex items-center gap-1">
                <Users className="w-3 h-3" />
                {expense.participantCount || expense.userShares?.length || '—'} مشارك
              </span>
            </div>
          </div>
        </div>

        {/* Divider */}
        <div className="my-3 border-t border-white/5" />

        {/* Amount row + actions */}
        <div className="flex items-center justify-between gap-3">
          {/* Amounts */}
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="text-slate-500 text-xs">حصتك:</span>
              <span className="text-white font-bold text-sm tabular">
                {myShare != null ? formatYER(myShare) : '—'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-slate-600 text-xs">الإجمالي:</span>
              <span className="text-slate-400 text-xs tabular">
                {expense.totalAmount != null ? formatYER(expense.totalAmount) : '—'}
              </span>
            </div>
          </div>

          {/* Dispute button (only if active) */}
          {meta.canDispute && (
            <button
              onClick={() => onDispute(expense)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all duration-200 flex-shrink-0"
              style={{ background: 'rgba(251,146,60,0.12)', color: '#fb923c', border: '1px solid rgba(251,146,60,0.25)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(251,146,60,0.22)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(251,146,60,0.12)'; }}
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              رفع نزاع
            </button>
          )}

          {/* Status label for non-active */}
          {!meta.canDispute && (
            <div className={`badge ${meta.badgeClass} py-1.5 px-3`}>
              <Icon className="w-3.5 h-3.5" />
              {meta.label}
            </div>
          )}
        </div>

        {/* Dispute note display if disputed */}
        {status === 'disputed' && expense.disputes?.length > 0 && (
          <div className="mt-3 rounded-xl p-3 text-xs" style={{ background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.2)' }}>
            <p className="text-orange-300 font-semibold mb-0.5">سبب النزاع:</p>
            <p className="text-orange-300/80">{expense.disputes[0].note || expense.disputes[0].reason}</p>
          </div>
        )}
        {/* Show resolution if settled/resolved */}
        {(status === 'settled' || status === 'resolved') && expense.disputes?.length > 0 && (
          <div className="mt-3 rounded-xl p-3 text-xs" style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)' }}>
            <p className="text-green-300 font-semibold mb-0.5">تم حسم النزاع</p>
            {expense.disputes[expense.disputes.length - 1].status === 'resolved_refunded' && (
              <p className="text-green-300/80">تم استرجاع المبلغ</p>
            )}
            {expense.disputes[expense.disputes.length - 1].status === 'resolved_dismissed' && (
              <p className="text-slate-400/80">تم رفض النزاع</p>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Main Component
// ══════════════════════════════════════════════════════════════════════════════

export default function SharedExpenses() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [activeFilter, setActiveFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [disputeTarget, setDisputeTarget] = useState(null);

  const filters = {
    page,
    limit: 10,
    ...(activeFilter !== 'all' && { status: activeFilter }),
  };

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: QUERY_KEYS.myExpenses(filters),
    queryFn: () => expenseApi.getMyExpenses(filters).then(r => r.data.data),
    keepPreviousData: true,
    staleTime: 30_000,
  });

  const expenses   = data?.expenses ?? [];
  const hasMore    = data?.hasMore ?? false;
  const nextCursor = data?.nextCursor ?? null;

  // ── Filter change → reset page ────────────────────────────────────────────
  const handleFilterChange = (key) => {
    setActiveFilter(key);
    setPage(1);
  };

  // ── Dispute modal handlers ────────────────────────────────────────────────
  const handleOpenDispute = useCallback((expense) => {
    setDisputeTarget(expense);
  }, []);

  const handleDisputeSuccess = useCallback(() => {
    // Invalidate and refetch
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.myExpenses() });
  }, [queryClient]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-dvh bg-surface-dark">

      {/* ── Header ── */}
      <header className="sticky top-0 z-40 glass-bg border-b border-white/10">
        <div className="max-w-2xl mx-auto px-4 py-3">
          <div className="flex items-center gap-3 mb-3">
            <button
              onClick={() => navigate(-1)}
              className="btn-ghost w-9 h-9 p-0"
              aria-label="العودة"
            >
              <ArrowRight className="w-5 h-5" />
            </button>
            <div className="flex-1">
              <h1 className="text-white font-bold text-base leading-tight">المصاريف المشتركة</h1>
              <p className="text-slate-400 text-xs">
                {isLoading ? '...' : (expenses.length > 0 ? `عرض ${expenses.length} مصروف` : 'لا توجد مصاريف')}
              </p>
            </div>
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="btn-ghost w-9 h-9 p-0"
              aria-label="تحديث"
            >
              <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* Filter Tabs */}
          <div className="flex gap-1 overflow-x-auto pb-0.5 scrollbar-none">
            {FILTER_TABS.map(tab => (
              <button
                key={tab.key}
                onClick={() => handleFilterChange(tab.key)}
                className={`flex-shrink-0 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 ${
                  activeFilter === tab.key
                    ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                    : 'text-slate-500 hover:text-white hover:bg-white/8'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* ── Content ── */}
      <main className="max-w-2xl mx-auto px-4 py-5 space-y-3">

        {isLoading ? (
          <ExpenseSkeleton />
        ) : isError ? (
          <div className="card-glass p-8 text-center">
            <AlertCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
            <p className="text-slate-400 text-sm mb-4">تعذر تحميل المصاريف</p>
            <button onClick={() => refetch()} className="btn-secondary text-sm py-2 px-4">
              إعادة المحاولة
            </button>
          </div>
        ) : expenses.length === 0 ? (
          <motion.div
            className="card-glass p-10 text-center"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <Receipt className="w-12 h-12 text-slate-600 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">
              {activeFilter === 'all'
                ? 'لا توجد مصاريف مشتركة بعد'
                : `لا توجد مصاريف بحالة "${FILTER_TABS.find(t => t.key === activeFilter)?.label}"`}
            </p>
            <p className="text-slate-600 text-sm mt-1">
              ستظهر هنا المصاريف التي يتم إدراجك فيها
            </p>
          </motion.div>
        ) : (
          <AnimatePresence mode="popLayout">
            {expenses.map(expense => (
              <ExpenseCard
                key={expense.publicId}
                expense={expense}
                onDispute={handleOpenDispute}
              />
            ))}
          </AnimatePresence>
        )}

        {/* ── Load more / Pagination ── */}
        {!isLoading && expenses.length > 0 && (
          <div className="flex items-center justify-between pt-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1 || isFetching}
              className="btn-ghost text-sm disabled:opacity-30"
            >
              <ChevronLeft className="w-4 h-4 rotate-180" />
              السابق
            </button>

            <span className="text-slate-500 text-xs tabular">
              الصفحة {page}
            </span>

            <button
              onClick={() => setPage(p => p + 1)}
              disabled={!hasMore || isFetching}
              className="btn-ghost text-sm disabled:opacity-30"
            >
              {isFetching
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : 'التالي'
              }
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="pb-safe h-4" />
      </main>

      {/* ── Dispute Modal ── */}
      <AnimatePresence>
        {disputeTarget && (
          <DisputeModal
            expense={disputeTarget}
            onClose={() => setDisputeTarget(null)}
            onSuccess={handleDisputeSuccess}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
