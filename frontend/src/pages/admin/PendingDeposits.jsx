/**
 * PendingDeposits.jsx — Admin review of pending deposit requests
 *
 * Features:
 *  - List of all pending deposits
 *  - Receipt Previewer (Modal with secure Signed URL)
 *  - Approve action (Atomic ledger update in backend)
 *  - Reject action (Requires Arabic reason)
 *  - Cache invalidation on action success
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Clock, CheckCircle, XCircle, Search, ArrowRight,
  FileImage, ExternalLink, AlertTriangle, Loader2,
  Calendar, Hash, User, RefreshCw
} from 'lucide-react';
import toast from 'react-hot-toast';

import { adminApi } from '../../api/adminApi';
import { depositApi } from '../../api/depositApi';
import { QUERY_KEYS } from '../../api/queryKeys';
import { formatYER, formatRelative } from '../../utils/formatters';

// ── Receipt Preview Modal ──────────────────────────────────────────────────

function ReceiptPreviewModal({ deposit, onClose, onApprove, onReject }) {
  const [rejectReason, setRejectReason] = useState('');
  const [isRejecting, setIsRejecting] = useState(false);
  
  // Fetch secure URL
  const { data: urlData, isLoading: isUrlLoading, isError } = useQuery({
    queryKey: QUERY_KEYS.receiptUrl(deposit.publicId),
    queryFn: () => depositApi.getReceiptUrl(deposit.publicId).then(r => r.data.data),
    staleTime: 5 * 60_000, // 5 min
  });

  const secureUrl = urlData?.signedUrl;

  const handleReject = () => {
    if (rejectReason.trim().length < 5) {
      toast.error('يرجى كتابة سبب الرفض بوضوح (5 أحرف على الأقل)');
      return;
    }
    onReject(deposit.publicId, rejectReason.trim());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-2xl bg-surface-dark border border-white/10 rounded-2xl overflow-hidden flex flex-col max-h-[90dvh]"
      >
        {/* Header */}
        <div className="flex justify-between items-center p-4 border-b border-white/10">
          <h2 className="text-white font-bold text-lg">معاينة إيصال الإيداع</h2>
          <button onClick={onClose} className="btn-ghost w-8 h-8 p-0"><XCircle className="w-5 h-5" /></button>
        </div>

        {/* Content (Scrollable) */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          
          {/* Deposit Info */}
          <div className="grid grid-cols-2 gap-3 bg-white/5 p-4 rounded-xl text-sm">
            <div>
              <p className="text-slate-400 text-xs mb-1">الطالب</p>
              <p className="text-white font-medium">{deposit.user?.fullName}</p>
            </div>
            <div>
              <p className="text-slate-400 text-xs mb-1">المبلغ المطلوب</p>
              <p className="text-yellow-400 font-bold text-lg tabular">{formatYER(deposit.amount)}</p>
            </div>
            <div>
              <p className="text-slate-400 text-xs mb-1">تاريخ الرفع</p>
              <p className="text-white font-medium">{formatRelative(deposit.createdAt)}</p>
            </div>
            <div>
              <p className="text-slate-400 text-xs mb-1">رقم المرجع (الكريمي)</p>
              <p className="text-white font-medium tabular">{deposit.referenceNumber || 'غير متوفر'}</p>
            </div>
          </div>

          {/* Image Viewer */}
          <div className="relative bg-black/50 rounded-xl overflow-hidden min-h-[300px] flex items-center justify-center border border-white/5">
            {isUrlLoading ? (
              <Loader2 className="w-8 h-8 text-yellow-500 animate-spin" />
            ) : isError || !secureUrl ? (
              <div className="text-center text-red-400">
                <AlertTriangle className="w-8 h-8 mx-auto mb-2" />
                <p>تعذر تحميل الصورة الآمنة</p>
              </div>
            ) : (
              <img 
                src={secureUrl} 
                alt="إيصال" 
                className="max-w-full max-h-[50vh] object-contain"
                onError={(e) => { e.target.style.display = 'none'; }}
              />
            )}
          </div>

          {/* Reject Actions Toggle */}
          {isRejecting && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="space-y-2">
              <label className="form-label text-red-400 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" /> سبب الرفض
              </label>
              <input 
                type="text" 
                className="input-field border-red-500/50 focus:border-red-500" 
                placeholder="مثال: رقم الحوالة غير مطابق، أو الصورة غير واضحة" 
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                autoFocus
              />
            </motion.div>
          )}

        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-white/10 bg-white/5 flex gap-3">
          {isRejecting ? (
            <>
              <button onClick={() => setIsRejecting(false)} className="btn-secondary flex-1">إلغاء</button>
              <button onClick={handleReject} className="btn-primary bg-red-600 hover:bg-red-700 flex-1 text-white border-none shadow-none">تأكيد الرفض</button>
            </>
          ) : (
            <>
              <button onClick={() => setIsRejecting(true)} className="btn-secondary flex-1 text-red-400 hover:bg-red-500/10 hover:border-red-500/30">
                <XCircle className="w-4 h-4" /> رفض
              </button>
              <button onClick={() => onApprove(deposit.publicId)} className="btn-primary flex-1 bg-green-600 hover:bg-green-700 text-white border-none shadow-none">
                <CheckCircle className="w-4 h-4" /> اعتماد الإيداع
              </button>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Main Component
// ══════════════════════════════════════════════════════════════════════════════

export default function PendingDeposits() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedDeposit, setSelectedDeposit] = useState(null);

  // ── Queries ──
  const { data: depositsData, isLoading, refetch, isFetching } = useQuery({
    queryKey: QUERY_KEYS.pendingDeposits(),
    queryFn: () => adminApi.getPendingDeposits().then(r => r.data.data),
    staleTime: 0, // Always fetch latest for admin review
  });

  const deposits = depositsData?.requests || [];

  // ── Mutations ──
  const approveMutation = useMutation({
    mutationFn: (id) => adminApi.approveDeposit(id),
    onSuccess: () => {
      toast.success('تم اعتماد طلب الإيداع بنجاح');
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.pendingDeposits() });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminStats() });
      setSelectedDeposit(null);
    },
    onError: (err) => {
      toast.error(err.response?.data?.message || 'فشل اعتماد الطلب');
    }
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }) => adminApi.rejectDeposit(id, reason),
    onSuccess: () => {
      toast.success('تم رفض الطلب بنجاح');
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.pendingDeposits() });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminStats() });
      setSelectedDeposit(null);
    },
    onError: (err) => {
      toast.error(err.response?.data?.message || 'فشل رفض الطلب');
    }
  });

  // ── Handlers ──
  const handleApprove = (id) => {
    approveMutation.mutate(id);
  };

  const handleReject = (id, reason) => {
    rejectMutation.mutate({ id, reason });
  };

  // ───────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-dvh bg-surface-dark flex flex-col">
      
      {/* Header */}
      <header className="sticky top-0 z-30 glass-bg border-b border-white/10">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/admin/dashboard')} className="btn-ghost w-9 h-9 p-0">
              <ArrowRight className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-white font-bold text-base">مراجعة الإيداعات المعلقة</h1>
              <p className="text-slate-400 text-xs">{deposits.length} طلبات بانتظار المراجعة</p>
            </div>
          </div>
          <button onClick={() => refetch()} disabled={isFetching} className="btn-ghost w-9 h-9 p-0">
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-3xl w-full mx-auto px-4 py-6 space-y-4">
        
        {isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 text-yellow-500 animate-spin" /></div>
        ) : deposits.length === 0 ? (
          <div className="card-glass p-12 text-center flex flex-col items-center justify-center">
            <CheckCircle className="w-16 h-16 text-green-500/50 mb-4" />
            <h3 className="text-white font-bold text-lg mb-1">لا توجد طلبات معلقة!</h3>
            <p className="text-slate-400 text-sm">تمت مراجعة جميع طلبات الإيداع.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <AnimatePresence>
              {deposits.map(dep => (
                <motion.div 
                  key={dep.publicId}
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="card-glass p-4 flex flex-col sm:flex-row gap-4 sm:items-center justify-between"
                >
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-full bg-yellow-500/10 flex items-center justify-center flex-shrink-0">
                      <Clock className="w-5 h-5 text-yellow-500" />
                    </div>
                    <div>
                      <p className="text-white font-bold text-sm mb-0.5">{dep.user?.fullName}</p>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                        <span className="flex items-center gap-1"><Calendar className="w-3 h-3"/> {formatRelative(dep.createdAt)}</span>
                        {dep.referenceNumber && (
                          <span className="flex items-center gap-1 text-blue-300 bg-blue-500/10 px-1.5 rounded"><Hash className="w-3 h-3"/> {dep.referenceNumber}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between sm:justify-end gap-4 border-t border-white/5 pt-3 sm:border-0 sm:pt-0">
                    <div className="text-right">
                      <p className="text-slate-400 text-xs mb-0.5">المبلغ</p>
                      <p className="text-yellow-400 font-bold tabular">{formatYER(dep.amount)}</p>
                    </div>
                    
                    <button 
                      onClick={() => setSelectedDeposit(dep)}
                      className="btn-primary h-10 px-4 text-xs font-semibold gap-1.5"
                    >
                      <FileImage className="w-4 h-4" /> مراجعة الإيصال
                    </button>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}

      </main>

      {/* Modal */}
      <AnimatePresence>
        {selectedDeposit && (
          <ReceiptPreviewModal 
            deposit={selectedDeposit} 
            onClose={() => setSelectedDeposit(null)}
            onApprove={handleApprove}
            onReject={handleReject}
          />
        )}
      </AnimatePresence>
      
      {/* Loading Overlay for Actions */}
      <AnimatePresence>
        {(approveMutation.isPending || rejectMutation.isPending) && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm flex items-center justify-center"
          >
            <Loader2 className="w-10 h-10 text-yellow-500 animate-spin" />
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
