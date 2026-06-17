/**
 * TransferForm.jsx — Peer-to-peer transfer wizard (3 steps)
 *
 * Step 1: Enter recipient account number → verify recipient
 * Step 2: Enter amount + optional note
 * Step 3: Confirm summary → execute transfer
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowRight, Search, User, Banknote, CheckCircle2,
  Loader2, AlertCircle, ArrowLeft, Send, ChevronRight,
  Trash2, BookmarkPlus, X
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { transferApi } from '../../api/transferApi';
import { walletApi } from '../../api/walletApi';
import { authApi } from '../../api/authApi';
import { QUERY_KEYS } from '../../api/queryKeys';
import { formatYER } from '../../utils/formatters';
import useAuthStore from '../../store/authStore';

// ── Step indicator ─────────────────────────────────────────────────────────

function StepDot({ num, active, done }) {
  return (
    <div className="flex items-center gap-1">
      <div
        className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300 ${
          done
            ? 'bg-financial-green-500 text-white'
            : active
            ? 'bg-accent-500 text-white scale-110'
            : 'bg-white/10 text-slate-500'
        }`}
      >
        {done ? <CheckCircle2 className="w-4 h-4" /> : num}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════

export default function TransferForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Preload Apple Pay sound on mount so it plays instantly after async call
  const audioRef = useRef(null);
  useEffect(() => {
    const audio = new Audio('/sounds/apple-pay.mp3');
    audio.preload = 'auto';
    audio.volume = 0.8;
    audioRef.current = audio;
  }, []);

  const [step, setStep] = useState(1); // 1 | 2 | 3
  const [accountNumber, setAccountNumber] = useState('');
  const [recipient, setRecipient] = useState(null); // { fullName, accountNumber, roomNumber }
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [fieldError, setFieldError] = useState('');

  const { data: balanceData } = useQuery({
    queryKey: QUERY_KEYS.balance(),
    queryFn: () => walletApi.getBalance().then(r => r.data.data),
  });
  const currentBalance = balanceData?.balance ?? 0;

  const { user, updateUser } = useAuthStore();
  const beneficiaries = user?.savedBeneficiaries || [];
  const [savingBeneficiary, setSavingBeneficiary] = useState(false);
  const [deletingBeneficiary, setDeletingBeneficiary] = useState(null);

  // ── Beneficiaries Actions ────────────────────────────────────────────────

  const handleSaveBeneficiary = async () => {
    setSavingBeneficiary(true);
    try {
      const { data } = await authApi.addBeneficiary({
        name: recipient.fullName,
        accountNumber: recipient.accountNumber
      });
      updateUser(data.data.user); // Update store with the new user object
      toast.success('تم حفظ المستفيد بنجاح');
    } catch (err) {
      toast.error(err?.response?.data?.message || 'فشل حفظ المستفيد');
    } finally {
      setSavingBeneficiary(false);
    }
  };

  const handleDeleteBeneficiary = async (accNum, e) => {
    e.stopPropagation();
    setDeletingBeneficiary(accNum);
    try {
      const { data } = await authApi.removeBeneficiary(accNum);
      updateUser(data.data.user); // Update store
      toast.success('تم حذف المستفيد');
    } catch (err) {
      toast.error('فشل حذف المستفيد');
    } finally {
      setDeletingBeneficiary(null);
    }
  };

  const isRecipientSaved = beneficiaries.some(b => b.accountNumber === recipient?.accountNumber);

  // ── Kuraimi-like success chime (Web Audio API) ─────────────────────────

  const playSuccessSound = useCallback(() => {
    try {
      if (audioRef.current) {
        audioRef.current.currentTime = 0;
        audioRef.current.play().catch(() => {});
      }
    } catch {
      // ignore
    }
  }, []);


  const handleLookup = async () => {
    setFieldError('');
    if (!/^[0-9]{6}$/.test(accountNumber)) {
      setFieldError('رقم الحساب يجب أن يكون 6 أرقام بالضبط');
      return;
    }
    setLookupLoading(true);
    try {
      const { data } = await transferApi.lookup(accountNumber);
      setRecipient(data.data);
      setStep(2);
    } catch (err) {
      const msg = err?.response?.data?.message;
      setFieldError(msg || 'رقم الحساب غير موجود');
    } finally {
      setLookupLoading(false);
    }
  };

  // ── Step 2 → 3: validate amount ───────────────────────────────────────

  const handleAmountNext = () => {
    setFieldError('');
    const parsed = parseInt(amount, 10);
    if (!parsed || parsed < 1) {
      setFieldError('أدخل مبلغاً صحيحاً (ريال واحد على الأقل)');
      return;
    }
    if (parsed > currentBalance) {
      setFieldError(`رصيدك (${formatYER(currentBalance)}) غير كافٍ لهذا التحويل`);
      return;
    }
    setStep(3);
  };

  // ── Step 3: Execute transfer ───────────────────────────────────────────

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await transferApi.createTransfer({
        accountNumber: recipient.accountNumber,
        amount: parseInt(amount, 10),
        note: note.trim() || undefined,
      });
      setSuccess(true);
      playSuccessSound();
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.balance() });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.transactions({ limit: 5 }) });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.notifications() });
      queryClient.invalidateQueries({ queryKey: ['notifications', 'unreadCount'] });
    } catch (err) {
      const msg = err?.response?.data?.message;
      toast.error(msg || 'فشل التحويل، يرجى المحاولة مرة أخرى');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Success screen ─────────────────────────────────────────────────────

  if (success) {
    return (
      <div className="min-h-dvh bg-surface-dark flex items-center justify-center p-4">
        <motion.div
          className="card-glass p-8 max-w-sm w-full text-center"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        >
          <motion.div
            className="w-20 h-20 rounded-full bg-financial-green-500/20 flex items-center justify-center mx-auto mb-5"
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.2, type: 'spring', stiffness: 200 }}
          >
            <CheckCircle2 className="w-10 h-10 text-financial-green-400" />
          </motion.div>
          <h2 className="text-xl font-black text-white mb-2">تم التحويل بنجاح!</h2>
          <p className="text-slate-400 text-sm mb-1">
            تم تحويل <span className="text-white font-bold">{formatYER(parseInt(amount, 10))}</span>
          </p>
          <p className="text-slate-500 text-sm mb-6">
            إلى <span className="text-white">{recipient?.fullName}</span>
          </p>
          {!isRecipientSaved && (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5 }}
              className="bg-accent-500/10 border border-accent-500/20 rounded-xl p-4 mb-6"
            >
              <p className="text-sm text-accent-300 font-medium mb-3">هل ترغب في حفظ الحساب لتسهيل التحويل مستقبلاً؟</p>
              <button
                onClick={handleSaveBeneficiary}
                disabled={savingBeneficiary}
                className="btn-secondary w-full py-2 flex items-center justify-center gap-2"
              >
                {savingBeneficiary ? <Loader2 className="w-4 h-4 animate-spin" /> : <BookmarkPlus className="w-4 h-4" />}
                حفظ {recipient?.fullName} كمستفيد
              </button>
            </motion.div>
          )}
          <button
            onClick={() => navigate('/dashboard')}
            className="btn-primary w-full"
          >
            العودة للرئيسية
          </button>
        </motion.div>
      </div>
    );
  }

  // ── Main wizard ────────────────────────────────────────────────────────

  return (
    <div className="min-h-dvh bg-surface-dark">
      {/* Header */}
      <header className="sticky top-0 z-40 glass-bg border-b border-white/8">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => (step > 1 ? setStep(s => s - 1) : navigate(-1))}
            className="btn-ghost w-9 h-9 p-0"
          >
            <ArrowRight className="w-4 h-4" />
          </button>
          <h1 className="font-bold text-white text-base">تحويل فوري</h1>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-6 space-y-5">
        {/* Step indicator */}
        <div className="flex items-center justify-center gap-3">
          <StepDot num={1} active={step === 1} done={step > 1} />
          <div className={`h-px w-10 transition-colors ${step > 1 ? 'bg-financial-green-500' : 'bg-white/10'}`} />
          <StepDot num={2} active={step === 2} done={step > 2} />
          <div className={`h-px w-10 transition-colors ${step > 2 ? 'bg-financial-green-500' : 'bg-white/10'}`} />
          <StepDot num={3} active={step === 3} done={false} />
        </div>

        <AnimatePresence mode="wait">

          {/* ── STEP 1: Account number ──────────────────────────────── */}
          {step === 1 && (
            <motion.div
              key="step1"
              className="space-y-4"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.3 }}
            >
              <div className="card-glass p-5">
                <p className="text-slate-400 text-xs mb-1">الخطوة 1 من 3</p>
                <h2 className="text-white font-bold text-lg mb-4">أدخل رقم حساب المستقبِل</h2>

                <div className="space-y-4">
                  <div>
                    <label className="form-label">رقم الحساب (6 أرقام)</label>
                    <div className="relative">
                      <input
                        id="acc-input"
                        type="tel"
                        inputMode="numeric"
                        maxLength={6}
                        value={accountNumber}
                        onChange={e => {
                          setAccountNumber(e.target.value.replace(/\D/g, ''));
                          setFieldError('');
                        }}
                        onKeyDown={e => e.key === 'Enter' && handleLookup()}
                        placeholder="مثال: 102345"
                        dir="ltr"
                        className={`input-field text-center text-xl tracking-widest font-mono ${fieldError ? 'input-field-error' : ''}`}
                      />
                    </div>
                    {fieldError && (
                      <p className="flex items-center gap-1.5 text-financial-red-400 text-xs mt-1.5">
                        <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                        {fieldError}
                      </p>
                    )}
                  </div>

                  <button
                    onClick={handleLookup}
                    disabled={lookupLoading || accountNumber.length !== 6}
                    className="btn-primary w-full"
                  >
                    {lookupLoading ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> جاري البحث...</>
                    ) : (
                      <><Search className="w-4 h-4" /> بحث عن الحساب</>
                    )}
                  </button>
                </div>
              </div>

              <p className="text-center text-slate-600 text-xs mt-4">
                يمكنك إيجاد رقم حساب الطالب في لوحة التحكم الخاصة به
              </p>

              {beneficiaries.length > 0 && (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="mt-8"
                >
                  <h3 className="text-slate-400 text-xs font-semibold mb-3 pr-1">المستفيدون المحفوظون</h3>
                  <div className="grid gap-2">
                    {beneficiaries.map(b => (
                      <div 
                        key={b.accountNumber}
                        onClick={() => {
                          setAccountNumber(b.accountNumber);
                          // Auto trigger lookup after setting state
                          setTimeout(() => {
                            const event = new KeyboardEvent('keydown', { key: 'Enter' });
                            document.getElementById('acc-input')?.dispatchEvent(event);
                          }, 50);
                        }}
                        className="card-glass-hover p-3 flex items-center justify-between cursor-pointer group"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-accent-500/20 flex items-center justify-center">
                            <User className="w-4 h-4 text-accent-400" />
                          </div>
                          <div className="text-right">
                            <p className="text-white text-sm font-semibold">{b.name}</p>
                            <p className="text-slate-500 text-xs font-mono tracking-wider">{b.accountNumber}</p>
                          </div>
                        </div>
                        <button
                          onClick={(e) => handleDeleteBeneficiary(b.accountNumber, e)}
                          disabled={deletingBeneficiary === b.accountNumber}
                          className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-financial-red-400 hover:bg-financial-red-500/10 rounded-lg transition-colors"
                          title="حذف المستفيد"
                        >
                          {deletingBeneficiary === b.accountNumber ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </motion.div>
          )}

          {/* ── STEP 2: Amount + note ─────────────────────────────────── */}
          {step === 2 && recipient && (
            <motion.div
              key="step2"
              className="space-y-4"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.3 }}
            >
              {/* Recipient card */}
              <div className="card-glass p-4 flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-accent-500/15 flex items-center justify-center flex-shrink-0">
                  <User className="w-5 h-5 text-accent-400" />
                </div>
                <div>
                  <p className="text-white font-semibold text-sm">{recipient.fullName}</p>
                  <p className="text-slate-500 text-xs">
                    رقم الحساب: <span className="font-mono text-slate-400">{recipient.accountNumber}</span>
                    {recipient.roomNumber && ` · غرفة ${recipient.roomNumber}`}
                  </p>
                </div>
                <CheckCircle2 className="w-4 h-4 text-financial-green-400 mr-auto flex-shrink-0" />
              </div>

              <div className="card-glass p-5">
                <p className="text-slate-400 text-xs mb-1">الخطوة 2 من 3</p>
                <h2 className="text-white font-bold text-lg mb-4">المبلغ والملاحظة</h2>

                <div className="space-y-4">
                  {/* Balance badge */}
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <Banknote className="w-3.5 h-3.5" />
                    رصيدك الحالي: <span className="text-financial-green-400 font-semibold">{formatYER(currentBalance)}</span>
                  </div>

                  <div>
                    <label className="form-label">المبلغ (ر.ي)</label>
                    <input
                      type="number"
                      inputMode="numeric"
                      min="1"
                      value={amount}
                      onChange={e => { setAmount(e.target.value); setFieldError(''); }}
                      placeholder="0"
                      dir="ltr"
                      className={`input-field text-center text-2xl font-bold font-mono ${fieldError ? 'input-field-error' : ''}`}
                    />
                    {fieldError && (
                      <p className="flex items-center gap-1.5 text-financial-red-400 text-xs mt-1.5">
                        <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                        {fieldError}
                      </p>
                    )}
                  </div>

                  {/* Quick amount buttons */}
                  <div className="grid grid-cols-4 gap-2">
                    {[500, 1000, 2000, 5000].map(q => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => { setAmount(String(q)); setFieldError(''); }}
                        className="btn-secondary text-xs py-1.5"
                      >
                        {q.toLocaleString()}
                      </button>
                    ))}
                  </div>

                  <div>
                    <label className="form-label">ملاحظة (اختياري)</label>
                    <input
                      type="text"
                      value={note}
                      onChange={e => setNote(e.target.value)}
                      placeholder="مثال: تقاسم فاتورة العشاء"
                      maxLength={100}
                      className="input-field"
                    />
                  </div>

                  <button
                    onClick={handleAmountNext}
                    disabled={!amount}
                    className="btn-primary w-full"
                  >
                    التالي
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </motion.div>
          )}

          {/* ── STEP 3: Confirm ──────────────────────────────────────── */}
          {step === 3 && recipient && (
            <motion.div
              key="step3"
              className="space-y-4"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.3 }}
            >
              <div className="card-glass p-5">
                <p className="text-slate-400 text-xs mb-1">الخطوة 3 من 3</p>
                <h2 className="text-white font-bold text-lg mb-5">تأكيد التحويل</h2>

                <div className="space-y-3 mb-6">
                  <div className="flex items-center justify-between py-3 border-b border-white/5">
                    <span className="text-slate-400 text-sm">المبلغ</span>
                    <span className="text-white font-bold text-lg">{formatYER(parseInt(amount, 10))}</span>
                  </div>
                  <div className="flex items-center justify-between py-3 border-b border-white/5">
                    <span className="text-slate-400 text-sm">المستقبِل</span>
                    <div className="text-left">
                      <p className="text-white font-semibold text-sm">{recipient.fullName}</p>
                      <p className="text-slate-500 text-xs font-mono">{recipient.accountNumber}</p>
                    </div>
                  </div>
                  {note && (
                    <div className="flex items-start justify-between py-3 border-b border-white/5">
                      <span className="text-slate-400 text-sm">ملاحظة</span>
                      <span className="text-slate-300 text-sm max-w-[60%] text-left">{note}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between py-3">
                    <span className="text-slate-400 text-sm">الرصيد بعد التحويل</span>
                    <span className={`font-bold text-sm ${currentBalance - parseInt(amount, 10) < 0 ? 'text-financial-red-400' : 'text-financial-green-400'}`}>
                      {formatYER(currentBalance - parseInt(amount, 10))}
                    </span>
                  </div>
                </div>

                <button
                  onClick={handleSubmit}
                  disabled={submitting}
                  className="btn-primary w-full"
                >
                  {submitting ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> جاري التحويل...</>
                  ) : (
                    <><Send className="w-4 h-4" /> تأكيد وإرسال التحويل</>
                  )}
                </button>

                <button
                  onClick={() => setStep(2)}
                  className="btn-ghost w-full mt-2 text-sm text-slate-400"
                >
                  <ArrowLeft className="w-4 h-4" />
                  تعديل المبلغ
                </button>
              </div>
            </motion.div>
          )}

        </AnimatePresence>
      </main>
    </div>
  );
}
