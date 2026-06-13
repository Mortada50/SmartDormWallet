/**
 * WithdrawalsHistory.jsx — Resident's historical withdrawal requests
 */

import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Clock, CheckCircle, XCircle, FileText, Loader2, Hash, Calendar, Banknote } from 'lucide-react';
import { withdrawalApi } from '../../api/withdrawalApi';
import { QUERY_KEYS } from '../../api/queryKeys';
import { formatYER, formatRelative } from '../../utils/formatters';

const STATUS_META = {
  PENDING:  { label: 'قيد المراجعة', Icon: Clock,       color: 'text-blue-400',   bg: 'bg-blue-500/10' },
  APPROVED: { label: 'مقبول ومحول',   Icon: CheckCircle, color: 'text-green-400',  bg: 'bg-green-500/10' },
  REJECTED: { label: 'مرفوض',        Icon: XCircle,     color: 'text-red-400',    bg: 'bg-red-500/10' },
};

export default function WithdrawalsHistory() {
  const navigate = useNavigate();

  const { data, isLoading, isError } = useQuery({
    queryKey: QUERY_KEYS.myWithdrawals(),
    queryFn: () => withdrawalApi.getMyRequests().then(r => r.data.data),
  });

  const withdrawals = data?.requests || [];

  return (
    <div className="min-h-dvh bg-surface-dark flex flex-col pb-6">
      <header className="sticky top-0 z-30 glass-bg border-b border-white/10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="btn-ghost w-9 h-9 p-0">
            <ArrowRight className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-white font-bold text-base">سجل السحوبات</h1>
            <p className="text-slate-400 text-xs">طلبات السحب السابقة وحالتها</p>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-2xl mx-auto w-full px-4 py-6">
        {isLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="w-8 h-8 text-slate-500 animate-spin" /></div>
        ) : isError ? (
          <p className="text-red-400 text-center py-10">تعذر تحميل السجل</p>
        ) : withdrawals.length === 0 ? (
          <div className="card-glass p-10 text-center">
            <Banknote className="w-12 h-12 text-slate-600 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">لم تقم بتقديم أي طلب سحب سابقاً</p>
          </div>
        ) : (
          <div className="space-y-3">
            {withdrawals.map(req => {
              const statusKey = req.status?.toUpperCase() || 'PENDING';
              const meta = STATUS_META[statusKey] || STATUS_META.PENDING;
              return (
                <div key={req.publicId} className="card-glass p-4 border border-white/5">
                  <div className="flex items-start justify-between mb-3 border-b border-white/5 pb-3">
                    <div className="flex items-center gap-2">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center ${meta.bg}`}>
                        <meta.Icon className={`w-4 h-4 ${meta.color}`} />
                      </div>
                      <div>
                        <p className={`font-bold text-sm ${meta.color}`}>{meta.label}</p>
                        <p className="text-slate-500 text-xs flex items-center gap-1 mt-0.5">
                          <Calendar className="w-3 h-3" /> {formatRelative(req.createdAt)}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-slate-400 text-xs mb-0.5">المبلغ المطلوب</p>
                      <p className="text-white font-bold text-base tabular">{formatYER(req.amount)}</p>
                    </div>
                  </div>

                  {statusKey === 'APPROVED' && req.netAmount != null && (
                    <div className="grid grid-cols-2 gap-2 text-xs mb-3">
                      <div className="bg-white/5 rounded-lg p-2 flex justify-between">
                        <span className="text-slate-400">الرسوم المخصومة:</span>
                        <span className="text-financial-red-400 font-medium">{formatYER(req.feeAmount)}</span>
                      </div>
                      <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-2 flex justify-between">
                        <span className="text-green-200">الصافي المحول لك:</span>
                        <span className="text-green-400 font-bold">{formatYER(req.netAmount)}</span>
                      </div>
                    </div>
                  )}

                  {statusKey === 'REJECTED' && req.adminNote && (
                    <div className="mt-2 bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-sm">
                      <p className="text-red-400 font-semibold mb-0.5 text-xs">سبب الرفض:</p>
                      <p className="text-red-300 text-sm">{req.adminNote}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
