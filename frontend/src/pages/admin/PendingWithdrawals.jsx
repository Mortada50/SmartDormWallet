/**
 * PendingWithdrawals.jsx — Admin review of pending withdrawal requests
 */

import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Clock, CheckCircle, XCircle, Search, ArrowRight,
  FileImage, AlertTriangle, Loader2, Calendar, User, 
  Banknote, Upload
} from 'lucide-react';
import toast from 'react-hot-toast';

import { adminApi } from '../../api/adminApi';
import { withdrawalApi } from '../../api/withdrawalApi';
import { QUERY_KEYS } from '../../api/queryKeys';
import { formatYER, formatRelative } from '../../utils/formatters';

// ── Approval & Receipt Upload Modal ───────────────────────────────────────

function ApprovalModal({ withdrawal, onClose, onApprove, onReject }) {
  const [rejectReason, setRejectReason] = useState('');
  const [isRejecting, setIsRejecting] = useState(false);
  const [file, setFile] = useState(null);
  const [adminNote, setAdminNote] = useState('');
  const fileInputRef = useRef(null);

  // Fetch fee preview dynamically
  const { data: previewData, isLoading: isPreviewLoading } = useQuery({
    queryKey: ['withdrawal-preview', withdrawal.amount],
    queryFn: () => withdrawalApi.getFeePreview(withdrawal.amount).then(r => r.data.data),
    staleTime: 0, // always fresh
  });

  const handleReject = () => {
    if (rejectReason.trim().length < 5) {
      toast.error('يرجى كتابة سبب الرفض بوضوح (5 أحرف على الأقل)');
      return;
    }
    onReject(withdrawal.publicId, rejectReason.trim());
  };

  const handleApprove = () => {
    if (!file) {
      toast.error('يرجى إرفاق صورة إيصال التحويل (سند الكريمي)');
      return;
    }
    onApprove(withdrawal.publicId, file, adminNote);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-xl bg-surface-dark border border-white/10 rounded-2xl overflow-hidden flex flex-col max-h-[90dvh]"
      >
        <div className="flex justify-between items-center p-4 border-b border-white/10">
          <h2 className="text-white font-bold text-lg">مراجعة طلب السحب</h2>
          <button onClick={onClose} className="btn-ghost w-8 h-8 p-0"><XCircle className="w-5 h-5" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          
          {/* Info */}
          <div className="grid grid-cols-2 gap-3 bg-white/5 p-4 rounded-xl text-sm">
            <div>
              <p className="text-slate-400 text-xs mb-1">الطالب</p>
              <p className="text-white font-medium">{withdrawal.user?.fullName}</p>
              <p className="text-slate-500 text-xs mt-0.5">غرفة {withdrawal.user?.roomNumber || '—'}</p>
            </div>
            <div>
              <p className="text-slate-400 text-xs mb-1">المبلغ المطلوب (من المحفظة)</p>
              <p className="text-white font-bold tabular">{formatYER(withdrawal.amount)}</p>
            </div>
            <div>
              <p className="text-slate-400 text-xs mb-1">تاريخ الطلب</p>
              <p className="text-white font-medium">{formatRelative(withdrawal.createdAt)}</p>
            </div>
          </div>

          {/* Fee Calculation Box */}
          {isPreviewLoading ? (
            <div className="flex items-center gap-2 text-slate-400 text-sm p-4 bg-white/5 rounded-xl">
              <Loader2 className="w-4 h-4 animate-spin" /> جاري حساب رسوم التحويل...
            </div>
          ) : previewData ? (
            <div className="bg-blue-500/10 border border-blue-500/20 p-4 rounded-xl space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-300">الرسوم ({previewData.feeType === 'PERCENTAGE' ? `${previewData.feeValue}%` : 'ثابتة'}):</span>
                <span className="text-financial-red-400 font-medium">{formatYER(previewData.feeAmount)}</span>
              </div>
              <div className="flex justify-between font-bold border-t border-white/10 pt-2 mt-1">
                <span className="text-blue-200">الصافي الذي يجب تحويله للطالب:</span>
                <span className="text-blue-400 text-lg tabular">{formatYER(previewData.netAmount)}</span>
              </div>
            </div>
          ) : null}

          {/* Action Tabs Toggle */}
          {!isRejecting && (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-slate-300 block mb-2 font-medium">
                  إيصال التحويل البنكي <span className="text-financial-red-400">*</span>
                </label>
                <div 
                  onClick={() => fileInputRef.current?.click()}
                  className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all duration-300 ${
                    file 
                      ? 'border-financial-green-500/50 bg-financial-green-500/10 shadow-[0_0_20px_rgba(34,197,94,0.1)]' 
                      : 'border-slate-600 hover:border-accent-500/50 hover:bg-accent-500/5 bg-white/5'
                  }`}
                >
                  <input 
                    type="file" 
                    ref={fileInputRef} 
                    className="hidden" 
                    accept="image/jpeg,image/png,image/webp"
                    onChange={e => setFile(e.target.files[0])}
                  />
                  {file ? (
                    <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="text-financial-green-400 flex flex-col items-center">
                      <div className="w-16 h-16 rounded-full bg-financial-green-500/20 flex items-center justify-center mb-3">
                        <FileImage className="w-8 h-8" />
                      </div>
                      <span className="font-bold text-lg">{file.name}</span>
                      <span className="text-xs text-financial-green-500/80 mt-1">انقر للتغيير</span>
                    </motion.div>
                  ) : (
                    <div className="text-slate-400 flex flex-col items-center">
                      <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
                        <Upload className="w-8 h-8 opacity-70" />
                      </div>
                      <span className="font-medium text-slate-300">اضغط لرفع صورة الإيصال</span>
                      <span className="text-xs text-slate-500 mt-1">JPG, PNG, WEBP (بحد أقصى 2MB)</span>
                    </div>
                  )}
                </div>
              </div>
              <div>
                <label className="text-sm text-slate-300 block mb-2 font-medium">ملاحظة للمستخدم (اختياري)</label>
                <input 
                  type="text" 
                  className="input-primary w-full bg-white/5 border-white/10 focus:border-accent-500/50 transition-colors" 
                  placeholder="ملاحظات إضافية تظهر للطالب..." 
                  value={adminNote}
                  onChange={e => setAdminNote(e.target.value)}
                />
              </div>
            </div>
          )}

          {isRejecting && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="space-y-2">
              <label className="text-red-400 flex items-center gap-2 font-medium">
                <AlertTriangle className="w-4 h-4" /> سبب الرفض
              </label>
              <textarea 
                className="input-primary border-red-500/50 focus:border-red-500 min-h-[100px] resize-none" 
                placeholder="وضح سبب الرفض للطالب..." 
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                autoFocus
              />
            </motion.div>
          )}

        </div>

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
              <button 
                onClick={handleApprove} 
                disabled={!file}
                className="btn-primary flex-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white border-none shadow-none"
              >
                <CheckCircle className="w-4 h-4" /> اعتماد التحويل
              </button>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────

export default function PendingWithdrawals() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedReq, setSelectedReq] = useState(null);

  // Queries
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: QUERY_KEYS.pendingWithdrawals(),
    queryFn: () => adminApi.getPendingWithdrawals().then(r => r.data.data),
    refetchInterval: 30000,
  });

  const withdrawals = data?.requests || [];

  // Mutations
  const approveMutation = useMutation({
    mutationFn: ({ id, formData }) => adminApi.approveWithdrawal(id, formData),
    onSuccess: () => {
      toast.success('تم اعتماد السحب ورفع الإيصال');
      setSelectedReq(null);
      queryClient.invalidateQueries(QUERY_KEYS.pendingWithdrawals());
      queryClient.invalidateQueries(QUERY_KEYS.adminStats());
    },
    onError: (err) => {
      toast.error(err.response?.data?.message || 'فشل الاعتماد');
    }
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }) => adminApi.rejectWithdrawal(id, reason),
    onSuccess: () => {
      toast.success('تم رفض طلب السحب');
      setSelectedReq(null);
      queryClient.invalidateQueries(QUERY_KEYS.pendingWithdrawals());
      queryClient.invalidateQueries(QUERY_KEYS.adminStats());
    },
    onError: (err) => {
      toast.error(err.response?.data?.message || 'فشل الرفض');
    }
  });

  // Action Handlers
  const handleApprove = (id, file, adminNote) => {
    const formData = new FormData();
    formData.append('receipt', file);
    if (adminNote) formData.append('adminNote', adminNote);
    
    const toastId = toast.loading('جاري رفع الإيصال واعتماد الطلب...');
    approveMutation.mutate({ id, formData }, {
      onSettled: () => toast.dismiss(toastId)
    });
  };

  const handleReject = (id, reason) => {
    rejectMutation.mutate({ id, reason });
  };

  return (
    <div className="min-h-dvh bg-surface-dark flex flex-col pb-20">
      {/* Header */}
      <header className="sticky top-0 z-30 glass-bg border-b border-white/10 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate('/admin')} className="btn-ghost w-10 h-10 p-0 text-slate-400 hover:text-white">
          <ArrowRight className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-white font-bold text-lg">طلبات السحب المعلقة</h1>
          <p className="text-slate-400 text-xs">طلبات تحويل الأرصدة إلى حسابات الطلاب</p>
        </div>
      </header>

      {/* List */}
      <main className="flex-1 max-w-3xl w-full mx-auto p-4">
        {isLoading ? (
          <div className="flex flex-col justify-center items-center py-20">
            <Loader2 className="w-10 h-10 text-slate-500 animate-spin mb-4" />
            <p className="text-slate-400 font-medium">جاري جلب الطلبات...</p>
          </div>
        ) : isError ? (
          <div className="card-glass p-8 text-center border-red-500/20 bg-red-500/5">
            <AlertTriangle className="w-12 h-12 text-red-400 mx-auto mb-3" />
            <p className="text-red-300 font-medium mb-4">فشل الاتصال بالخادم</p>
            <button onClick={() => refetch()} className="btn-secondary mx-auto">إعادة المحاولة</button>
          </div>
        ) : withdrawals.length === 0 ? (
          <div className="card-glass p-12 text-center border-white/5">
            <CheckCircle className="w-16 h-16 text-green-400/50 mx-auto mb-4" />
            <h2 className="text-white font-bold text-lg mb-2">طابور السحوبات فارغ!</h2>
            <p className="text-slate-400">لا توجد أي طلبات سحب معلقة في الوقت الحالي.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {withdrawals.map((req) => (
              <div key={req.publicId} className="card-glass p-4 border border-white/5 hover:border-white/10 transition-colors">
                <div className="flex justify-between items-start mb-4">
                  <div className="flex gap-3">
                    <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center text-blue-400">
                      <Banknote className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="text-white font-bold text-base flex items-center gap-2">
                        {req.user?.fullName}
                      </h3>
                      <p className="text-slate-400 text-xs flex items-center gap-1 mt-1">
                        <Calendar className="w-3.5 h-3.5" />
                        {formatRelative(req.createdAt)}
                      </p>
                    </div>
                  </div>
                  <div className="text-left">
                    <p className="text-slate-400 text-xs mb-1">المبلغ المطلوب</p>
                    <p className="text-white font-bold tabular text-lg">{formatYER(req.amount)}</p>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button 
                    onClick={() => setSelectedReq(req)}
                    className="flex-1 btn-primary bg-white/5 hover:bg-white/10 text-white border border-white/10 shadow-none text-sm h-10"
                  >
                    مراجعة الطلب وتحويل المبلغ
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Modal */}
      <AnimatePresence>
        {selectedReq && (
          <ApprovalModal
            withdrawal={selectedReq}
            onClose={() => setSelectedReq(null)}
            onApprove={handleApprove}
            onReject={handleReject}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
