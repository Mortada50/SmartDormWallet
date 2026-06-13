/**
 * TwoFactorAuth.jsx — OTP verification screen for sensitive operations
 *
 * Features:
 *   • 6-digit individual input boxes (auto-advance, backspace, paste support)
 *   • Auto-submit on last digit filled
 *   • Resend OTP with 60-second cooldown timer
 *   • Shake animation on wrong code
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldCheck, RefreshCw, ArrowRight, Loader2, AlertCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../api/axiosInstance';

const OTP_LENGTH = 6;
const RESEND_COOLDOWN = 60; // seconds

export default function TwoFactorAuth() {
  const navigate = useNavigate();
  const location = useLocation();

  const { phone, pendingAction, redirectTo = '/dashboard' } = location.state || {};

  const [otp, setOtp] = useState(Array(OTP_LENGTH).fill(''));
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [error, setError] = useState('');
  const [resendTimer, setResendTimer] = useState(RESEND_COOLDOWN);
  const [shake, setShake] = useState(false);

  const inputRefs = useRef([]);

  // Countdown timer
  useEffect(() => {
    if (resendTimer <= 0) return;
    const id = setInterval(() => setResendTimer(t => Math.max(0, t - 1)), 1000);
    return () => clearInterval(id);
  }, [resendTimer]);

  // Focus first input on mount
  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  // ── OTP input handlers ─────────────────────────────────────────────────

  const handleChange = useCallback((index, value) => {
    // Only allow digits
    if (value && !/^\d$/.test(value)) return;

    setOtp(prev => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
    setError('');

    if (value && index < OTP_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  }, []);

  const handleKeyDown = useCallback((index, e) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      setOtp(prev => {
        const next = [...prev];
        if (next[index]) {
          next[index] = '';
        } else if (index > 0) {
          next[index - 1] = '';
          inputRefs.current[index - 1]?.focus();
        }
        return next;
      });
    } else if (e.key === 'ArrowRight' && index > 0) {
      inputRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowLeft' && index < OTP_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  }, []);

  const handlePaste = useCallback((e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH);
    if (!pasted) return;

    const newOtp = Array(OTP_LENGTH).fill('');
    pasted.split('').forEach((digit, i) => { newOtp[i] = digit; });
    setOtp(newOtp);
    setError('');
    const nextFocusIndex = Math.min(pasted.length, OTP_LENGTH - 1);
    inputRefs.current[nextFocusIndex]?.focus();
  }, []);

  // Auto-submit when all digits filled
  useEffect(() => {
    if (otp.every(d => d !== '')) {
      handleVerify(otp.join(''));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otp]);

  // ── Verify ─────────────────────────────────────────────────────────────

  const handleVerify = async (code) => {
    if (code.length !== OTP_LENGTH || isVerifying) return;

    setIsVerifying(true);
    try {
      await api.post('/auth/verify-otp', { phone, code, action: pendingAction });
      toast.success('تم التحقق بنجاح ✓');
      navigate(redirectTo, { replace: true });
    } catch (err) {
      const msg = err.response?.data?.message || 'الرمز غير صحيح أو منتهي الصلاحية';
      setError(msg);
      setShake(true);
      setTimeout(() => setShake(false), 600);
      // Reset OTP
      setOtp(Array(OTP_LENGTH).fill(''));
      inputRefs.current[0]?.focus();
    } finally {
      setIsVerifying(false);
    }
  };

  // ── Resend ─────────────────────────────────────────────────────────────

  const handleResend = async () => {
    if (resendTimer > 0 || isResending) return;
    setIsResending(true);
    try {
      await api.post('/auth/resend-otp', { phone, action: pendingAction });
      toast.success('تم إرسال رمز جديد');
      setResendTimer(RESEND_COOLDOWN);
      setOtp(Array(OTP_LENGTH).fill(''));
      setError('');
      inputRefs.current[0]?.focus();
    } catch {
      toast.error('فشل إرسال الرمز — يرجى المحاولة لاحقاً');
    } finally {
      setIsResending(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="min-h-dvh bg-surface-dark flex items-center justify-center p-4 relative overflow-hidden">

      {/* Background */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-br from-primary-700/15 via-transparent to-accent-500/8" />
        <motion.div
          className="absolute top-[-5%] right-[-5%] w-[40vw] h-[40vw] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(27,58,107,0.35) 0%, transparent 70%)' }}
          animate={{ scale: [1, 1.04, 1] }}
          transition={{ duration: 7, repeat: Infinity }}
        />
      </div>

      <motion.div
        className="relative w-full max-w-sm"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="card-glass p-8 text-center">

          {/* Back button */}
          <button
            onClick={() => navigate(-1)}
            className="btn-ghost absolute top-4 right-4 text-sm"
          >
            <ArrowRight className="w-4 h-4" />
            رجوع
          </button>

          {/* Icon */}
          <motion.div
            className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-5 mx-auto"
            style={{ background: 'linear-gradient(135deg, rgba(200,150,12,0.25), rgba(200,150,12,0.1))', border: '1px solid rgba(200,150,12,0.3)' }}
            animate={{ boxShadow: ['0 0 0 0px rgba(200,150,12,0)', '0 0 0 8px rgba(200,150,12,0.08)', '0 0 0 0px rgba(200,150,12,0)'] }}
            transition={{ duration: 3, repeat: Infinity }}
          >
            <ShieldCheck className="w-8 h-8 text-accent-400" />
          </motion.div>

          <h1 className="text-xl font-bold text-white mb-1">التحقق الثنائي</h1>
          <p className="text-slate-400 text-sm">
            أدخل الرمز المرسل إلى{' '}
            <span className="text-white font-medium" dir="ltr">{phone || '...'}</span>
          </p>

          {/* OTP inputs */}
          <motion.div
            className="flex items-center justify-center gap-3 my-8"
            dir="ltr"
            animate={shake ? { x: [-8, 8, -8, 8, -4, 4, 0] } : {}}
            transition={{ duration: 0.5 }}
          >
            {otp.map((digit, index) => (
              <input
                key={index}
                ref={el => (inputRefs.current[index] = el)}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={e => handleChange(index, e.target.value)}
                onKeyDown={e => handleKeyDown(index, e)}
                onPaste={handlePaste}
                disabled={isVerifying}
                className={`otp-input ${error ? '!border-financial-red-500/70' : ''}`}
                aria-label={`الرقم ${index + 1}`}
              />
            ))}
          </motion.div>

          {/* Error message */}
          <AnimatePresence>
            {error && (
              <motion.div
                className="flex items-center justify-center gap-2 text-financial-red-400 text-sm mb-4 font-medium"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
              >
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {error}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Verify button */}
          <button
            onClick={() => handleVerify(otp.join(''))}
            disabled={otp.some(d => d === '') || isVerifying}
            className="btn-primary w-full h-12"
          >
            {isVerifying ? (
              <><Loader2 className="w-5 h-5 animate-spin" /> جاري التحقق...</>
            ) : (
              'تأكيد الرمز'
            )}
          </button>

          {/* Resend */}
          <div className="mt-5">
            {resendTimer > 0 ? (
              <p className="text-slate-500 text-sm">
                إعادة الإرسال بعد{' '}
                <motion.span
                  key={resendTimer}
                  className="text-accent-400 font-bold tabular"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                >
                  {resendTimer}
                </motion.span>
                {' '}ثانية
              </p>
            ) : (
              <button
                onClick={handleResend}
                disabled={isResending}
                className="btn-ghost text-sm text-accent-400 hover:text-accent-300"
              >
                {isResending
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> جاري الإرسال...</>
                  : <><RefreshCw className="w-4 h-4" /> إعادة إرسال الرمز</>
                }
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
