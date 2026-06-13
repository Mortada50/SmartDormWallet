/**
 * WithdrawalRequestForm.jsx — Documented withdrawal request
 *
 * Flow:
 *   1. User enters amount (integer ≥ minWithdrawalAmount)
 *   2. System auto-fetches fee preview on debounce
 *   3. Displays net amount and total required
 *   4. On submit → POST /api/v1/withdrawals
 *   5. On success → invalidate wallet.balance + wallet.transactions → navigate back
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight, Loader2, Banknote, AlertCircle, Info, CheckCircle2
} from 'lucide-react';
import toast from 'react-hot-toast';

import { withdrawalApi } from '../../api/withdrawalApi';
import { QUERY_KEYS } from '../../api/queryKeys';
import { parseAmount, formatYER } from '../../utils/formatters';
import useAuthStore from '../../store/authStore';

// ── Sub-components ─────────────────────────────────────────────────────────

function LoadingOverlay({ message }) {
  return (
    <motion.div
      className="absolute inset-0 z-50 flex flex-col items-center justify-center rounded-2xl"
      style={{ background: 'rgba(15,22,41,0.92)', backdropFilter: 'blur(8px)' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <Loader2 className="w-10 h-10 text-financial-red-400 animate-spin mb-4" />
      <p className="text-white font-bold text-base mb-1">{message}</p>
      <p className="text-slate-400 text-sm">يرجى الانتظار — لا تغلق الصفحة</p>
    </motion.div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function WithdrawalRequestForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuthStore();

  // State
  const [amountStr, setAmountStr] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Parse amount strictly
  const parsedAmount = parseAmount(amountStr);
  const isAmountValid = parsedAmount > 0;

  // ── Debounced Fee Preview ────────────────────────────────────────────────
  useEffect(() => {
    if (!isAmountValid) {
      setPreview(null);
      return;
    }

    const timer = setTimeout(async () => {
      setPreviewLoading(true);
      try {
        const res = await withdrawalApi.getFeePreview(parsedAmount);
        setPreview(res.data.data);
      } catch (err) {
        setPreview(null);
        // Only show toast for actual API errors, ignore if amount is just below min temporarily
        if (err.response?.status !== 400) {
          toast.error(err.response?.data?.message || 'فشل حساب الرسوم');
        }
      } finally {
        setPreviewLoading(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [amountStr, parsedAmount, isAmountValid]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    if (!isAmountValid) {
      toast.error('الرجاء إدخال مبلغ صحيح للسحب');
      return;
    }

    if (preview && !preview.isSufficient) {
      toast.error('الرصيد الحالي لا يكفي لتغطية مبلغ السحب والرسوم');
      return;
    }

    setIsSubmitting(true);
    const loadingToast = toast.loading('جاري تقديم الطلب...');

    try {
      await withdrawalApi.submit({ amount: parsedAmount });
      
      toast.success('تم تقديم طلب السحب بنجاح!', { id: loadingToast });

      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.balance() });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.transactions() });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.myWithdrawals() });

      // Return to dashboard
      navigate('/dashboard', { replace: true });
    } catch (err) {
      toast.error(err.response?.data?.message || 'حدث خطأ أثناء تقديم الطلب', { id: loadingToast });
      setIsSubmitting(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-dvh bg-surface-dark pb-20">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-surface-dark/80 backdrop-blur-xl border-b border-white/5 px-4 h-16 flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="btn-ghost w-10 h-10 p-0 text-slate-400 hover:text-white">
          <ArrowRight className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-white font-bold text-lg">طلب سحب جديد</h1>
          <p className="text-slate-400 text-xs">سحب رصيد إلى حسابك البنكي</p>
        </div>
      </header>

      <main className="p-4 max-w-md mx-auto">
        <div className="card-glass p-5 relative overflow-hidden">
          <AnimatePresence>
            {isSubmitting && (
              <LoadingOverlay message="جاري تقديم طلب السحب..." />
            )}
          </AnimatePresence>

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Amount Input */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-300 ml-1">
                المبلغ المطلوب سحبه
              </label>
              <div className="relative">
                <div className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400">
                  <Banknote className="w-5 h-5" />
                </div>
                <input
                  type="number"
                  inputMode="numeric"
                  placeholder="0"
                  value={amountStr}
                  onChange={(e) => setAmountStr(e.target.value)}
                  className="input-primary pl-16 pr-12 text-2xl font-bold h-16 bg-blue-500/10"
                  disabled={isSubmitting}
                  autoFocus
                />
                <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 font-bold">
                  YER
                </div>
              </div>

              {/* Fee Preview Box */}
              <AnimatePresence>
                {previewLoading && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="text-xs text-slate-400 flex items-center gap-2 mt-2">
                    <Loader2 className="w-3 h-3 animate-spin" /> جاري حساب
                    الرسوم...
                  </motion.div>
                )}
                {preview && !previewLoading && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className={`mt-4 p-4 rounded-xl border ${
                      preview.isSufficient
                        ? "bg-blue-500/10 border-blue-500/20"
                        : "bg-red-500/10 border-red-500/20"
                    }`}>
                    <div className="flex justify-between text-sm mb-2">
                      <span className="text-slate-400">المبلغ المطلوب:</span>
                      <span className="text-white font-medium">
                        {formatYER(preview.amount)}{" "}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm mb-2">
                      <span className="text-slate-400">
                        الرسوم (
                        {preview.feeType === "PERCENTAGE"
                          ? `${preview.feeValue}%`
                          : "ثابتة"}
                        ):
                      </span>
                      <span className="text-financial-red-400 font-medium">
                        {formatYER(preview.feeAmount)}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm font-bold border-t border-white/10 pt-2 mt-2">
                      <span className="text-white">
                        إجمالي الخصم من الرصيد:
                      </span>
                      <span className="text-white">
                        {formatYER(preview.totalRequired)}{" "}
                      </span>
                    </div>

                    {!preview.isSufficient && (
                      <div className="flex items-start gap-2 mt-3 text-red-400 bg-red-500/10 p-2 rounded-lg text-xs">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        <p>
                          عفواً، رصيدك الحالي (
                          {formatYER(preview.currentBalance)} ريال) لا يكفي
                          لإتمام هذه العملية.
                        </p>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Bank Info Alert */}
            <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-4 flex items-start gap-3">
              <Info className="w-5 h-5 text-yellow-400 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="text-yellow-200 font-bold mb-1">معلومات هامة:</p>
                <p className="text-yellow-400/80 leading-relaxed text-xs">
                  سيتم تحويل المبلغ إلى حسابك المصرفي (الكريمي) المسجل لدينا.
                  يرجى التأكد من أن حسابك نشط قبل تقديم الطلب.
                </p>
              </div>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={
                !isAmountValid ||
                isSubmitting ||
                (preview && !preview.isSufficient)
              }
              className="btn-primary w-full h-14 text-base relative overflow-hidden"
              style={{
                background:
                  !isAmountValid || (preview && !preview.isSufficient)
                    ? "var(--color-surface-light)"
                    : "linear-gradient(135deg, #f43f5e, #e11d48)",
              }}>
              {isSubmitting ? (
                <Loader2 className="w-6 h-6 animate-spin mx-auto" />
              ) : (
                <div className="flex items-center justify-center gap-2">
                  <CheckCircle2 className="w-5 h-5" />
                  <span>تأكيد طلب السحب</span>
                </div>
              )}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
