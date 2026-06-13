/**
 * DisputesManagement.jsx — Admin screen for managing open expense disputes
 *
 * Displays all disputed shared expenses with their dispute details.
 * Admin can resolve each dispute with a resolution note.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  AlertTriangle, CheckCircle, Loader2, RefreshCw,
  MessageSquare, User, Calendar, ArrowLeft, X, ShieldCheck,
  Gavel, ChevronDown, ChevronUp, DollarSign
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';

import { adminApi } from '../../api/adminApi';
import { QUERY_KEYS } from '../../api/queryKeys';
import { formatYER, formatDate, formatRelative } from '../../utils/formatters';

// ── Resolve Modal ──────────────────────────────────────────────────────────

function ResolveModal({ dispute, onClose, onResolve, isLoading }) {
  const [resolutionType, setResolutionType] = useState('dismiss');
  const [adminNote, setAdminNote] = useState('');

  const handleSubmit = () => {
    if (adminNote.trim().length < 5) {
      toast.error('يرجى كتابة قرار واضح (5 أحرف على الأقل)');
      return;
    }
    
    const openDispute = dispute.disputes?.find(d => d.status?.toLowerCase() === 'open') || dispute.disputes?.[0];
    
    if (!openDispute) {
      toast.error('لم يتم العثور على أي نزاع مسجل لهذا المصروف');
      return;
    }

    onResolve(dispute.publicId, {
      disputePublicId: openDispute.publicId,
      resolutionType,
      adminNote: adminNote.trim()
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-lg bg-surface-dark border border-white/10 rounded-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-orange-500/20 flex items-center justify-center">
              <Gavel className="w-5 h-5 text-orange-400" />
            </div>
            <div>
              <h2 className="text-white font-bold">حل النزاع</h2>
              <p className="text-slate-400 text-xs mt-0.5 truncate max-w-[200px]">{dispute.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost w-8 h-8 p-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Dispute info */}
        <div className="p-5 space-y-4">
          <div className="bg-orange-500/10 border border-orange-500/20 rounded-xl p-4 space-y-2">
            <p className="text-orange-300 text-xs font-semibold uppercase tracking-wide">تفاصيل النزاع</p>
            {dispute.disputes?.filter(d => d.status === 'open').map((d, i) => (
              <div key={i} className="text-sm">
                <span className="text-slate-400">السبب: </span>
                <span className="text-white">{d.note}</span>
              </div>
            ))}
          </div>

          <div>
            <label className="form-label flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-accent-400" />
              نوع القرار
            </label>
            <div className="flex gap-3 mb-4">
              <label className="flex items-center gap-2 text-white text-sm cursor-pointer">
                <input type="radio" value="dismiss" checked={resolutionType === 'dismiss'} onChange={() => setResolutionType('dismiss')} className="accent-orange-500" />
                رفض النزاع (إبقاء المصروف)
              </label>
              <label className="flex items-center gap-2 text-white text-sm cursor-pointer">
                <input type="radio" value="refund" checked={resolutionType === 'refund'} onChange={() => setResolutionType('refund')} className="accent-orange-500" />
                قبول النزاع (استرجاع المبلغ)
              </label>
            </div>

            <label className="form-label flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-accent-400" />
              ملاحظة الإدارة
            </label>
            <textarea
              className="input-field min-h-[100px] resize-none"
              placeholder="أدخل سبب القرار بخصوص هذا النزاع..."
              value={adminNote}
              onChange={e => setAdminNote(e.target.value)}
              autoFocus
              maxLength={1000}
            />
            <p className="text-slate-500 text-xs mt-1 text-left">{adminNote.length}/1000</p>
          </div>
        </div>

        <div className="p-5 border-t border-white/10 flex gap-3">
          <button onClick={onClose} className="btn-secondary flex-1">إلغاء</button>
          <button
            onClick={handleSubmit}
            disabled={isLoading || adminNote.trim().length < 5}
            className="btn-primary flex-1 bg-orange-600 hover:bg-orange-700 border-none"
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Gavel className="w-4 h-4" />}
            تأكيد القرار
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ── Dispute Card ───────────────────────────────────────────────────────────

function DisputeCard({ dispute, onResolve }) {
  const [expanded, setExpanded] = useState(false);
  const openDisputes = dispute.disputes?.filter(d => d.status === 'open') || [];
  const affectedCount = dispute.affectedUsers?.length || 0;
  const sharePerUser = affectedCount > 0 ? Math.floor(dispute.totalAmount / affectedCount) : 0;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="card-glass overflow-hidden"
    >
      {/* Main row */}
      <div className="p-4 flex items-start gap-4">
        <div className="w-11 h-11 rounded-xl bg-orange-500/15 flex items-center justify-center flex-shrink-0">
          <AlertTriangle className="w-5 h-5 text-orange-400" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-white font-bold text-sm truncate">{dispute.name}</h3>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                <span className="text-slate-400 text-xs flex items-center gap-1">
                  <Calendar className="w-3 h-3" />
                  {formatDate(dispute.createdAt)}
                </span>
                <span className="text-slate-400 text-xs flex items-center gap-1">
                  <User className="w-3 h-3" />
                  {affectedCount} طالب
                </span>
                <span className="badge badge-red">{openDisputes.length} نزاع مفتوح</span>
              </div>
            </div>
            <div className="text-left flex-shrink-0">
              <p className="text-orange-400 font-bold text-base tabular">{formatYER(dispute.totalAmount)}</p>
              <p className="text-slate-500 text-xs">{formatYER(sharePerUser)} / طالب</p>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={() => setExpanded(!expanded)}
              className="btn-ghost py-1.5 px-3 text-xs"
            >
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              {expanded ? 'إخفاء التفاصيل' : 'عرض التفاصيل'}
            </button>
            <button
              onClick={() => onResolve(dispute)}
              className="btn-primary py-1.5 px-4 text-xs bg-orange-600 hover:bg-orange-700 border-none"
            >
              <Gavel className="w-3.5 h-3.5" />
              حل النزاع
            </button>
          </div>
        </div>
      </div>

      {/* Expanded details */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="border-t border-white/10 overflow-hidden"
          >
            <div className="p-4 space-y-3">
              {openDisputes.map((d, i) => (
                <div key={i} className="bg-white/5 rounded-xl p-3">
                  <p className="text-orange-300 text-xs font-semibold mb-1">
                    نزاع #{i + 1} — {formatRelative(d.createdAt)}
                  </p>
                  <p className="text-slate-300 text-sm">{d.note}</p>
                </div>
              ))}
              {dispute.description && (
                <div className="text-slate-400 text-xs">
                  <span className="text-slate-500">وصف المصروف: </span>
                  {dispute.description}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Main Component
// ══════════════════════════════════════════════════════════════════════════════

export default function DisputesManagement() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedDispute, setSelectedDispute] = useState(null);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: QUERY_KEYS.adminDisputes(),
    queryFn: () => adminApi.getDisputes().then(r => r.data.data),
    staleTime: 0,
  });

  const disputes = Array.isArray(data) ? data : [];

  const resolveMutation = useMutation({
    mutationFn: ({ id, data }) => adminApi.resolveDispute(id, data),
    onSuccess: () => {
      toast.success('تم حل النزاع بنجاح');
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminDisputes() });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminStats() });
      setSelectedDispute(null);
    },
    onError: (err) => toast.error(err.response?.data?.message || 'فشل في حل النزاع'),
  });

  const handleResolve = (expensePublicId, resolutionData) => {
    resolveMutation.mutate({ id: expensePublicId, data: resolutionData });
  };

  return (
    <div className="min-h-dvh bg-surface-dark">
      {/* Header */}
      <header className="sticky top-0 z-30 glass-bg border-b border-white/10">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/admin/dashboard')} className="btn-ghost w-9 h-9 p-0">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-white font-bold text-base">إدارة النزاعات</h1>
              <p className="text-slate-400 text-xs">
                {disputes.length > 0 ? `${disputes.length} نزاع مفتوح` : 'لا توجد نزاعات'}
              </p>
            </div>
          </div>
          <button onClick={() => refetch()} disabled={isFetching} className="btn-ghost w-9 h-9 p-0">
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        {/* Stats bar */}
        {disputes.length > 0 && (
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'نزاعات مفتوحة', value: disputes.length, color: 'text-orange-400' },
              { label: 'إجمالي المطعون فيه', value: formatYER(disputes.reduce((s, d) => s + d.totalAmount, 0)), color: 'text-red-400' },
              { label: 'مطالبون', value: disputes.reduce((s, d) => s + (d.disputes?.filter(x => x.status === 'open').length || 0), 0), color: 'text-yellow-400' },
            ].map((stat, i) => (
              <div key={i} className="card-glass p-3 text-center">
                <p className={`font-bold text-lg ${stat.color} tabular`}>{stat.value}</p>
                <p className="text-slate-400 text-xs mt-0.5">{stat.label}</p>
              </div>
            ))}
          </div>
        )}

        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-8 h-8 text-orange-400 animate-spin" />
          </div>
        ) : disputes.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="card-glass p-16 text-center flex flex-col items-center"
          >
            <div className="w-20 h-20 rounded-full bg-green-500/10 flex items-center justify-center mb-4">
              <ShieldCheck className="w-10 h-10 text-green-400" />
            </div>
            <h3 className="text-white font-bold text-xl mb-2">لا توجد نزاعات مفتوحة</h3>
            <p className="text-slate-400 text-sm">جميع المصروفات المشتركة مستقرة بدون اعتراضات</p>
          </motion.div>
        ) : (
          <div className="space-y-3">
            <AnimatePresence>
              {disputes.map(d => (
                <DisputeCard key={d.publicId} dispute={d} onResolve={setSelectedDispute} />
              ))}
            </AnimatePresence>
          </div>
        )}
      </main>

      {/* Resolve Modal */}
      <AnimatePresence>
        {selectedDispute && (
          <ResolveModal
            dispute={selectedDispute}
            onClose={() => setSelectedDispute(null)}
            onResolve={handleResolve}
            isLoading={resolveMutation.isPending}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
