/**
 * TransactionsHistory.jsx — Full ledger history with filtering and infinite pagination
 */

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  ArrowDownLeft, ArrowUpRight, ShoppingBag, Users,
  RefreshCw, RotateCcw, Filter, ChevronDown,
  ArrowRight, FileText, Loader2
} from 'lucide-react';

import { walletApi } from '../../api/walletApi';
import { QUERY_KEYS } from '../../api/queryKeys';
import { formatYER, formatRelative } from '../../utils/formatters';

// ── Transaction type metadata ──
const TX_META = {
  DEPOSIT:           { label: 'إيداع',          Icon: ArrowDownLeft, color: 'text-green-400',  bg: 'bg-green-500/10' },
  WITHDRAWAL:        { label: 'سحب',           Icon: ArrowUpRight,  color: 'text-red-400',    bg: 'bg-red-500/10' },
  WITHDRAWAL_FEE:    { label: 'رسوم سحب',      Icon: ArrowUpRight,  color: 'text-red-400',    bg: 'bg-red-500/10' },
  SHARED_EXPENSE:    { label: 'مصروف مشترك',   Icon: Users,         color: 'text-blue-400',   bg: 'bg-blue-500/10' },
  MERCHANT_PURCHASE: { label: 'مشتريات',        Icon: ShoppingBag,   color: 'text-purple-400', bg: 'bg-purple-500/10' },
  DEBT_SETTLEMENT:   { label: 'تسوية دين',     Icon: RotateCcw,     color: 'text-orange-400', bg: 'bg-orange-500/10' },
  ADJUSTMENT:        { label: 'تعديل',         Icon: RefreshCw,     color: 'text-slate-400',  bg: 'bg-white/5' },
  REFUND:            { label: 'استرداد',       Icon: ArrowDownLeft, color: 'text-green-400',  bg: 'bg-green-500/10' },
};

const TYPES = ['all', 'DEPOSIT', 'WITHDRAWAL', 'SHARED_EXPENSE', 'MERCHANT_PURCHASE'];

export default function TransactionsHistory() {
  const navigate = useNavigate();
  const { userPublicId } = useParams();
  const [filterType, setFilterType] = useState('all');

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
  } = useInfiniteQuery({
    queryKey: QUERY_KEYS.transactions({ type: filterType, userPublicId }),
    queryFn: ({ pageParam }) => {
      const params = {
        cursor: pageParam,
        limit: 20,
        ...(filterType !== 'all' && { type: filterType })
      };
      const req = userPublicId 
        ? walletApi.getUserTransactions(userPublicId, params)
        : walletApi.getTransactions(params);
        
      return req.then(r => r.data.data);
    },
    getNextPageParam: (lastPage) => lastPage?.pagination?.nextCursor || undefined,
  });

  const transactions = data?.pages.flatMap(p => p.transactions) || [];

  return (
    <div className="min-h-dvh bg-surface-dark flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-30 glass-bg border-b border-white/10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="btn-ghost w-9 h-9 p-0">
            <ArrowRight className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-white font-bold text-base">سجل العمليات</h1>
            <p className="text-slate-400 text-xs">كافة الحركات المالية على حسابك</p>
          </div>
        </div>

        {/* Filter Scrollable Row */}
        <div className="max-w-2xl mx-auto px-4 pb-3 flex gap-2 overflow-x-auto scrollbar-none mt-2">
          {TYPES.map(t => (
            <button
              key={t}
              onClick={() => setFilterType(t)}
              className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border ${
                filterType === t 
                  ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' 
                  : 'bg-white/5 text-slate-400 border-white/10 hover:bg-white/10'
              }`}
            >
              {t === 'all' ? 'الكل' : TX_META[t]?.label}
            </button>
          ))}
        </div>
      </header>

      {/* List */}
      <main className="flex-1 max-w-2xl mx-auto w-full px-4 py-4">
        {isLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="w-8 h-8 text-slate-500 animate-spin" /></div>
        ) : isError ? (
          <p className="text-red-400 text-center py-10">تعذر تحميل السجل</p>
        ) : transactions.length === 0 ? (
          <div className="text-center py-12">
            <FileText className="w-12 h-12 text-slate-600 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">لا توجد عمليات تطابق الفلتر</p>
          </div>
        ) : (
          <div className="card-glass overflow-hidden divide-y divide-white/5">
            {transactions.map(tx => {
              const meta = TX_META[tx.type] || TX_META.ADJUSTMENT;
              const isCredit = tx.creditAmount > 0;
              const displayAmount = isCredit ? tx.creditAmount : tx.debitAmount;

              return (
                <div key={tx.publicId} className="table-row-hover p-4 flex items-center gap-3 cursor-default">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${meta.bg}`}>
                    <meta.Icon className={`w-5 h-5 ${meta.color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium truncate">{meta.label}</p>
                    <p className="text-slate-500 text-xs truncate mt-0.5">{tx.description || '—'}</p>
                    <p className="text-slate-600 text-[11px] mt-1">
                      {formatRelative(tx.createdAt)}
                    </p>
                  </div>
                  <div className="text-left flex-shrink-0">
                    <p className={`font-bold tabular ${isCredit ? 'text-green-400' : 'text-white'}`}>
                      {isCredit ? '+' : '−'} {formatYER(displayAmount)}
                    </p>
                    <p className="text-slate-500 text-[10px] mt-1 text-left tabular font-mono opacity-50">#{tx.publicId.slice(-6)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Load More */}
        {hasNextPage && (
          <button
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
            className="w-full btn-secondary mt-4 h-11 text-sm text-slate-400"
          >
            {isFetchingNextPage ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : <><ChevronDown className="w-4 h-4"/> عرض المزيد</>}
          </button>
        )}
      </main>
    </div>
  );
}
