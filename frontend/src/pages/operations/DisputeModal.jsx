/**
 * DisputeModal.jsx — Financial dispute filing modal
 *
 * Triggered from SharedExpenses when user presses "رفع نزاع" on an expense.
 *
 * Behavior:
 *   • Shows expense details in a summary card
 *   • Text area with Arabic reason (min 10 chars)
 *   • On submit → POST /api/v1/expenses/:publicId/disputes
 *   • On success → optimistic update of expense status to 'disputed'
 *                  + invalidate expenses cache
 */

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  AlertTriangle, X, Loader2, Send,
  Users, Calendar, AlertCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useQueryClient } from '@tanstack/react-query';

import { expenseApi } from '../../api/expenseApi';
import { QUERY_KEYS } from '../../api/queryKeys';
import { formatYER, formatDate } from '../../utils/formatters';

// ── Constants ──────────────────────────────────────────────────────────────
const MIN_REASON_LEN = 10;
const MAX_REASON_LEN = 1000;

// ══════════════════════════════════════════════════════════════════════════════

export default function DisputeModal({ expense, onClose, onSuccess }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef(null);
  const overlayRef = useRef(null);

  // Focus textarea on open
  useEffect(() => {
    setTimeout(() => textareaRef.current?.focus(), 100);
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Prevent body scroll while modal is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const charCount = reason.length;
  const isValid = charCount >= MIN_REASON_LEN;

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!isValid) {
      setError(`يجب أن لا يقل سبب النزاع عن ${MIN_REASON_LEN} حروف`);
      return;
    }

    setIsSubmitting(true);
    setError('');
    try {
      await expenseApi.fileDispute(expense.publicId, reason.trim());

      // Invalidate expense caches for immediate UI update
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.myExpenses() }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.expense(expense.publicId) }),
      ]);

      toast.success('تم رفع النزاع — سيتم مراجعته من قِبل المسؤول ✓', { duration: 5000 });
      onSuccess?.();
      onClose();
    } catch (err) {
      const msg = err?.response?.data?.message;
      if (msg) setError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const shareAmount = expense?.userShares?.find(s => s.isCurrentUser)?.shareAmount
    ?? expense?.shareAmount;

  return (
    <AnimatePresence>
      {/* Backdrop */}
      <motion.div
        ref={overlayRef}
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
        style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)' }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
      >
        <motion.div
          className="w-full max-w-md card-glass rounded-2xl overflow-hidden"
          initial={{ y: 60, opacity: 0, scale: 0.97 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          exit={{ y: 60, opacity: 0, scale: 0.97 }}
          transition={{ type: 'spring', damping: 28, stiffness: 350 }}
        >
          {/* ── Header ── */}
          <div className="flex items-center justify-between p-5 border-b border-white/10">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-orange-500/15 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-orange-400" />
              </div>
              <div>
                <h2 className="text-white font-bold text-base">رفع نزاع مالي</h2>
                <p className="text-slate-400 text-xs">سيتم مراجعته من قِبل الإدارة</p>
              </div>
            </div>
            <button
              onClick={onClose}
              disabled={isSubmitting}
              className="btn-ghost w-8 h-8 p-0"
              aria-label="إغلاق"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* ── Expense summary card ── */}
          <div className="p-5 border-b border-white/5">
            <div className="rounded-xl p-4 space-y-2.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
              <div className="flex items-start justify-between gap-2">
                <p className="text-white font-semibold text-sm leading-snug flex-1">
                  {expense?.name || 'مصروف مشترك'}
                </p>
                <span className="badge badge-blue flex-shrink-0">مشترك</span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="flex items-center gap-1.5 text-slate-400">
                  <Users className="w-3.5 h-3.5 text-blue-400" />
                  <span>حصتك: <span className="text-white font-semibold tabular">{formatYER(shareAmount)}</span></span>
                </div>
                <div className="flex items-center gap-1.5 text-slate-400">
                  <Calendar className="w-3.5 h-3.5 text-purple-400" />
                  <span>{formatDate(expense?.createdAt)}</span>
                </div>
              </div>
              {expense?.description && (
                <p className="text-slate-500 text-xs border-t border-white/5 pt-2">
                  {expense.description}
                </p>
              )}
            </div>
          </div>

          {/* ── Dispute reason form ── */}
          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            <div>
              <label htmlFor="dispute-reason" className="form-label">
                سبب النزاع <span className="text-red-400">*</span>
              </label>
              <div className="relative">
                <textarea
                  ref={textareaRef}
                  id="dispute-reason"
                  rows={4}
                  maxLength={MAX_REASON_LEN}
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    setError('');
                  }}
                  disabled={isSubmitting}
                  placeholder="اكتب هنا سبب اعتراضك بوضوح وتفصيل... (مثال: لم أستلم المشتريات، المبلغ غير صحيح، إلخ)"
                  className={`w-full resize-none rounded-xl border px-4 py-3 text-sm text-white leading-relaxed transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-orange-500/30 ${
                    error
                      ? 'border-red-500/60 bg-red-500/5'
                      : 'border-white/15 bg-white/5 focus:border-orange-500/70 focus:bg-white/8'
                  }`}
                  style={{ fontFamily: 'Cairo, sans-serif' }}
                />
                {/* Character counter */}
                <div className="absolute bottom-2 left-3 text-xs text-slate-600 tabular">
                  {charCount}/{MAX_REASON_LEN}
                </div>
              </div>

              <AnimatePresence>
                {error && (
                  <motion.p
                    className="flex items-center gap-1.5 text-red-400 text-xs mt-1.5 font-medium"
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                  >
                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                    {error}
                  </motion.p>
                )}
              </AnimatePresence>

              {/* Progress bar for min chars */}
              {charCount < MIN_REASON_LEN && charCount > 0 && (
                <div className="mt-2">
                  <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                    <motion.div
                      className="h-full bg-orange-500 rounded-full"
                      animate={{ width: `${(charCount / MIN_REASON_LEN) * 100}%` }}
                      transition={{ duration: 0.15 }}
                    />
                  </div>
                  <p className="text-orange-400 text-xs mt-1">
                    أدخل {MIN_REASON_LEN - charCount} حرف إضافي على الأقل
                  </p>
                </div>
              )}
            </div>

            {/* Disclaimer */}
            <div className="flex items-start gap-2 rounded-xl p-3" style={{ background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.2)' }}>
              <AlertTriangle className="w-3.5 h-3.5 text-orange-400 flex-shrink-0 mt-0.5" />
              <p className="text-orange-300/80 text-xs">
                بمجرد رفع النزاع، سيتم إيقاف احتساب هذا المصروف مؤقتاً حتى يُبتّ فيه من قِبل الإدارة.
              </p>
            </div>

            {/* Actions */}
            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="btn-secondary flex-1 h-11 text-sm"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={!isValid || isSubmitting}
                className="btn-primary flex-1 h-11 text-sm"
                aria-busy={isSubmitting}
              >
                {isSubmitting ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> جاري الرفع...</>
                ) : (
                  <><Send className="w-4 h-4" /> رفع النزاع</>
                )}
              </button>
            </div>
          </form>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
