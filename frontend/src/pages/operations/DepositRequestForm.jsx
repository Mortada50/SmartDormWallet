/**
 * DepositRequestForm.jsx — Documented deposit request with Drag & Drop receipt upload
 *
 * Flow:
 *   1. User enters amount (integer ≥ 1) + optional reference number
 *   2. Attaches receipt image via Drag & Drop or file picker (max 2MB, JPEG/PNG/WEBP)
 *   3. On submit → POST /api/v1/deposits (multipart/form-data)
 *   4. On success → invalidate wallet.balance + wallet.transactions → navigate back
 *
 * Security:
 *   • Client-side file size guard before any network request
 *   • Button disabled during submission (no double-submit)
 *   • LoadingOverlay covers the form during cloud upload
 *   • Amount parsed as integer — no float math
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useQueryClient } from '@tanstack/react-query';
import {
  Upload, ImageIcon, X, AlertCircle, CheckCircle2,
  ArrowRight, Loader2, Banknote, Hash, Info,
} from 'lucide-react';
import toast from 'react-hot-toast';

import { depositApi } from '../../api/depositApi';
import { QUERY_KEYS } from '../../api/queryKeys';
import { parseAmount, formatYER } from '../../utils/formatters';

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_FILE_SIZE    = 2 * 1024 * 1024; // 2 MB
const ALLOWED_TYPES    = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_EXTS     = '.jpg, .jpeg, .png, .webp';

// ── Sub-components ─────────────────────────────────────────────────────────

/** Full-screen loading overlay during cloud upload */
function LoadingOverlay({ message }) {
  return (
    <motion.div
      className="absolute inset-0 z-50 flex flex-col items-center justify-center rounded-2xl"
      style={{ background: 'rgba(15,22,41,0.92)', backdropFilter: 'blur(8px)' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div className="relative w-16 h-16 mb-4">
        <div className="absolute inset-0 rounded-full border-4 border-white/10" />
        <div className="absolute inset-0 rounded-full border-4 border-t-yellow-500 animate-spin" />
        <div className="absolute inset-0 flex items-center justify-center">
          <Upload className="w-6 h-6 text-yellow-400" />
        </div>
      </div>
      <p className="text-white font-bold text-base mb-1">{message}</p>
      <p className="text-slate-400 text-sm">يرجى الانتظار — لا تغلق الصفحة</p>
    </motion.div>
  );
}

/** Drag & Drop receipt upload zone */
function ReceiptDropzone({ file, preview, onFile, onClear, error }) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef(null);

  const validate = (f) => {
    if (!ALLOWED_TYPES.includes(f.type)) {
      toast.error('نوع الملف غير مدعوم — استخدم JPEG أو PNG أو WEBP');
      return false;
    }
    if (f.size > MAX_FILE_SIZE) {
      toast.error(`حجم الملف (${(f.size / 1024 / 1024).toFixed(1)} MB) يتجاوز الحد الأقصى (2 MB)`);
      return false;
    }
    return true;
  };

  const handleFiles = useCallback((files) => {
    const f = files[0];
    if (!f) return;
    if (!validate(f)) return;
    onFile(f);
  }, [onFile]);

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  };

  return (
    <div className="space-y-3">
      {/* Drop zone */}
      <div
        onClick={() => !file && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`
          relative rounded-xl border-2 border-dashed transition-all duration-200 overflow-hidden
          ${file ? 'border-green-500/50 bg-green-500/5' : 'cursor-pointer'}
          ${isDragging ? 'border-yellow-500 bg-yellow-500/10 scale-[1.01]' : ''}
          ${!file && !isDragging ? 'border-white/20 hover:border-white/40 hover:bg-white/5' : ''}
          ${error ? 'border-red-500/60' : ''}
        `}
      >
        {/* Image preview */}
        {preview ? (
          <div className="relative">
            <img
              src={preview}
              alt="معاينة الإيصال"
              className="w-full max-h-56 object-contain rounded-xl bg-black/20"
            />
            {/* Remove button */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onClear(); }}
              className="absolute top-2 left-2 w-8 h-8 rounded-full bg-red-500/90 hover:bg-red-500 flex items-center justify-center shadow-lg transition-colors"
              aria-label="حذف الصورة"
            >
              <X className="w-4 h-4 text-white" />
            </button>
            {/* Success badge */}
            <div className="absolute bottom-2 right-2 flex items-center gap-1 bg-green-500/90 text-white text-xs px-2 py-1 rounded-full font-medium">
              <CheckCircle2 className="w-3.5 h-3.5" />
              {(file.size / 1024).toFixed(0)} KB
            </div>
          </div>
        ) : (
          /* Empty state */
          <div className={`flex flex-col items-center justify-center py-10 px-4 text-center transition-colors ${isDragging ? 'text-yellow-400' : 'text-slate-500'}`}>
            <motion.div
              animate={isDragging ? { y: [-4, 0, -4] } : { y: 0 }}
              transition={{ duration: 0.8, repeat: isDragging ? Infinity : 0 }}
            >
              <ImageIcon className="w-10 h-10 mb-3 mx-auto opacity-60" />
            </motion.div>
            <p className="font-semibold text-sm text-white">
              {isDragging ? 'أفلت الصورة هنا' : 'اسحب وأفلت صورة الإيصال'}
            </p>
            <p className="text-xs mt-1">أو <span className="text-yellow-400 underline">اضغط للاختيار</span></p>
            <p className="text-xs mt-2 text-slate-600">{ALLOWED_EXTS} — حجم أقصى: 2 MB</p>
          </div>
        )}
      </div>

      {/* Hidden file input */}
      <input
        ref={inputRef}
        type="file"
        accept={ALLOWED_TYPES.join(',')}
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
        onClick={(e) => { e.target.value = ''; }}
      />

      {error && (
        <p className="flex items-center gap-1.5 text-red-400 text-xs font-medium">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Main Component
// ══════════════════════════════════════════════════════════════════════════════

export default function DepositRequestForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [amount, setAmount]           = useState('');
  const [reference, setReference]     = useState('');
  const [file, setFile]               = useState(null);
  const [preview, setPreview]         = useState(null);
  const [errors, setErrors]           = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Clean up object URL on unmount
  useEffect(() => {
    return () => { if (preview) URL.revokeObjectURL(preview); };
  }, [preview]);

  const handleFile = useCallback((f) => {
    setFile(f);
    setPreview(URL.createObjectURL(f));
    setErrors(prev => ({ ...prev, file: '' }));
  }, []);

  const clearFile = useCallback(() => {
    if (preview) URL.revokeObjectURL(preview);
    setFile(null);
    setPreview(null);
  }, [preview]);

  // ── Validation ────────────────────────────────────────────────────────────
  function validateForm() {
    const errs = {};
    const parsedAmount = parseAmount(amount);
    if (!parsedAmount) {
      errs.amount = 'المبلغ يجب أن يكون عدداً صحيحاً موجباً (مثال: 5000)';
    } else if (parsedAmount < 100) {
      errs.amount = 'الحد الأدنى للإيداع هو 100 ريال';
    } else if (parsedAmount > 10_000_000) {
      errs.amount = 'المبلغ يتجاوز الحد المسموح به';
    }
    if (!file) {
      errs.file = 'يجب إرفاق صورة إيصال الحوالة البنكية';
    }
    return errs;
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = async (e) => {
    e.preventDefault();
    const errs = validateForm();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }

    setIsSubmitting(true);
    setErrors({});

    try {
      const parsedAmount = parseAmount(amount); // Safe integer
      const formData = new FormData();
      formData.append('amount', String(parsedAmount));
      formData.append('receipt', file);
      if (reference.trim()) {
        formData.append('referenceNumber', reference.trim());
      }

      await depositApi.submit(formData);

      // ── State Invalidation ─────────────────────────────────────────────
      // Refetch balance + recent transactions immediately (no F5 needed)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.balance() }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.transactions() }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.myDeposits() }),
      ]);

      toast.success('تم إرسال طلب الإيداع — سيتم مراجعته خلال 24 ساعة ✓', { duration: 5000 });
      navigate('/dashboard');
    } catch (err) {
      const msg = err?.response?.data?.message;
      if (msg?.includes('طلب إيداع')) {
        setErrors({ form: msg });
      }
      // Other errors handled by axiosInstance interceptor
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Live amount preview ────────────────────────────────────────────────────
  const parsedAmount = parseAmount(amount);
  const amountDisplay = parsedAmount ? formatYER(parsedAmount) : null;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-dvh bg-surface-dark">

      {/* Header */}
      <header className="sticky top-0 z-40 glass-bg border-b border-white/10">
        <div className="max-w-xl mx-auto px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="btn-ghost w-9 h-9 p-0"
            aria-label="العودة"
          >
            <ArrowRight className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-white font-bold text-base leading-tight">طلب إيداع رصيد</h1>
            <p className="text-slate-400 text-xs">إيداع عبر الكريمي أو التحويل البنكي</p>
          </div>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-4 py-6">
        <form onSubmit={handleSubmit} noValidate>
          <div className="relative card-glass p-6 space-y-6">

            {/* Loading overlay */}
            <AnimatePresence>
              {isSubmitting && <LoadingOverlay message="جاري رفع الطلب..." />}
            </AnimatePresence>

            {/* ── Form error banner ── */}
            <AnimatePresence>
              {errors.form && (
                <motion.div
                  className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-xl p-4"
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                >
                  <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                  <p className="text-red-300 text-sm">{errors.form}</p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* ── Bank Account Info ── */}
            <motion.div
              className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4 mb-2"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
            >
              <h3 className="text-blue-400 font-bold text-sm flex items-center gap-2 mb-3">
                <Info className="w-4 h-4" />
                بيانات الحساب للإيداع
              </h3>
              <div className="space-y-2">
                <div className="flex items-center justify-between bg-white/5 rounded-lg p-2.5">
                  <div>
                    <p className="text-slate-400 text-xs mb-0.5">اسم المستفيد</p>
                    <p className="text-white text-sm font-semibold">مرتضى عبدالله محمد عبدالله</p>
                  </div>
                </div>
                <div className="flex items-center justify-between bg-white/5 rounded-lg p-2.5">
                  <div>
                    <p className="text-slate-400 text-xs mb-0.5">رقم الحساب</p>
                    <p className="text-white text-sm font-mono font-bold tracking-wider">3202274117</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText('3202274117');
                      toast.success('تم نسخ رقم الحساب ✓', { duration: 2000 });
                    }}
                    className="bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex-shrink-0"
                  >
                    نسخ الرقم
                  </button>
                </div>
              </div>
            </motion.div>

            {/* ── Amount field ── */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
            >
              <label htmlFor="amount" className="form-label">
                مبلغ الإيداع <span className="text-red-400">*</span>
              </label>
              <div className="relative">
                <Banknote className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-slate-500 pointer-events-none" />
                <input
                  id="amount"
                  type="text"
                  inputMode="numeric"
                  placeholder="5,000"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setErrors(prev => ({ ...prev, amount: '' }));
                  }}
                  disabled={isSubmitting}
                  dir="ltr"
                  className={`${errors.amount ? 'input-field-error' : 'input-field'} pr-10 pl-16 text-left tabular`}
                />
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 text-sm font-medium pointer-events-none">
                  YER
                </span>
              </div>

              {/* Live formatted preview */}
              <AnimatePresence>
                {amountDisplay && !errors.amount && (
                  <motion.p
                    className="flex items-center gap-1.5 text-green-400 text-xs mt-1.5 font-medium"
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {amountDisplay}
                  </motion.p>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {errors.amount && (
                  <motion.p
                    className="flex items-center gap-1.5 text-red-400 text-xs mt-1.5 font-medium"
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                  >
                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                    {errors.amount}
                  </motion.p>
                )}
              </AnimatePresence>
            </motion.div>

            {/* ── Reference field ── */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
            >
              <label htmlFor="reference" className="form-label">
                رقم مرجع الحوالة (الكريمي)
                <span className="text-slate-500 font-normal mr-1">— اختياري</span>
              </label>
              <div className="relative">
                <Hash className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-slate-500 pointer-events-none" />
                <input
                  id="reference"
                  type="text"
                  inputMode="text"
                  placeholder="مثال: KR-20250101-00001"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  disabled={isSubmitting}
                  maxLength={100}
                  dir="ltr"
                  className="input-field pr-10 text-left"
                />
              </div>
              <p className="text-slate-600 text-xs mt-1">
                يساعد في تتبع العملية وتسريع الاعتماد
              </p>
            </motion.div>

            {/* ── Receipt upload ── */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
            >
              <label className="form-label">
                صورة إيصال الحوالة <span className="text-red-400">*</span>
              </label>
              <ReceiptDropzone
                file={file}
                preview={preview}
                onFile={handleFile}
                onClear={clearFile}
                error={errors.file}
              />
            </motion.div>

            {/* ── Info note ── */}
            <motion.div
              className="flex items-start gap-2 rounded-xl p-3"
              style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)' }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.2 }}
            >
              <Info className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-blue-300 space-y-0.5">
                <p className="font-semibold">ملاحظات مهمة</p>
                <p>• سيتم مراجعة طلبك من قبل المسؤول خلال 24 ساعة عمل</p>
                <p>• سيُضاف المبلغ إلى رصيدك تلقائياً بعد الاعتماد</p>
                <p>• تأكد من وضوح بيانات الإيصال في الصورة</p>
              </div>
            </motion.div>

            {/* ── Submit button ── */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.25 }}
            >
              <button
                type="submit"
                disabled={isSubmitting}
                className="btn-primary w-full h-12 text-base"
                aria-busy={isSubmitting}
              >
                {isSubmitting ? (
                  <><Loader2 className="w-5 h-5 animate-spin" /> جاري إرسال الطلب...</>
                ) : (
                  <><Upload className="w-5 h-5" /> إرسال طلب الإيداع</>
                )}
              </button>
            </motion.div>
          </div>
        </form>

        {/* My deposit history link */}
        <motion.div
          className="mt-4 text-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.35 }}
        >
          <button
            onClick={() => navigate('/deposits/history')}
            className="btn-ghost text-sm text-slate-400"
          >
            عرض سجل طلباتي السابقة
          </button>
        </motion.div>
      </main>
    </div>
  );
}
