/**
 * Login.jsx — Authentication page for Smart Dorm Wallet
 *
 * Design: Premium dark glassmorphism with animated background,
 *         RTL-first Arabic typography, Cairo font.
 *
 * Features:
 *   • Phone + PIN validation with inline Arabic error messages
 *   • Button disabled during submission (prevents double-submit)
 *   • Animated entrance with framer-motion
 *   • Error feedback via react-hot-toast (configured in axiosInstance)
 */

import { useState, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Smartphone, Lock, Eye, EyeOff, AlertCircle, Loader2, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import useAuthStore from '../../store/authStore';

// ── Validation helpers ─────────────────────────────────────────────────────

const PHONE_REGEX = /^[0-9+]{9,15}$/;

function validate(form) {
  const errors = {};
  if (!form.phone || !PHONE_REGEX.test(form.phone.replace(/\s/g, ''))) {
    errors.phone = 'رقم الهاتف غير صحيح (يجب أن يكون بين 9-15 رقماً)';
  }
  if (!form.pin || form.pin.length < 4) {
    errors.pin = 'كلمة المرور يجب أن تكون 4 أرقام على الأقل';
  }
  return errors;
}

// ── Animated background particles ─────────────────────────────────────────

const PARTICLES = Array.from({ length: 8 }, (_, i) => ({
  id: i,
  x: Math.random() * 100,
  y: Math.random() * 100,
  size: 4 + Math.random() * 8,
  delay: Math.random() * 4,
}));

// ══════════════════════════════════════════════════════════════════════════════

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuthStore();

  const [form, setForm] = useState({ phone: '', pin: '' });
  const [errors, setErrors] = useState({});
  const [showPin, setShowPin] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const from = location.state?.from?.pathname || '/dashboard';

  const handleChange = useCallback((e) => {
    const { name, value } = e.target;
    setForm(prev => ({ ...prev, [name]: value }));
    // Clear field error on change
    if (errors[name]) {
      setErrors(prev => ({ ...prev, [name]: '' }));
    }
  }, [errors]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const validationErrors = validate(form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setIsSubmitting(true);
    try {
      const user = await login({
        phone: form.phone.replace(/\s/g, ''),
        password: form.pin,
      });

      toast.success(`مرحباً ${user.fullName} 👋`, { duration: 3000 });

      // Role-based redirect
      const destination = user.role === 'resident' ? '/dashboard' : '/admin/dashboard';
      navigate(from !== '/dashboard' ? from : destination, { replace: true });
    } catch (error) {
      // Errors already handled by axiosInstance interceptor (toast shown)
      // Only handle 400/422 form-level errors here
      const status = error?.response?.status;
      if (status === 400 || status === 422) {
        setErrors({ pin: 'رقم الهاتف أو كلمة المرور غير صحيحة' });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-dvh bg-surface-dark flex items-center justify-center p-4 relative overflow-hidden">

      {/* ── Animated gradient background ──────────────────────────────── */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-br from-primary-700/20 via-transparent to-accent-500/10" />

        {/* Glowing orbs */}
        <motion.div
          className="absolute top-[-10%] right-[-10%] w-[50vw] h-[50vw] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(27,58,107,0.4) 0%, transparent 70%)' }}
          animate={{ scale: [1, 1.05, 1], opacity: [0.6, 0.8, 0.6] }}
          transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute bottom-[-15%] left-[-10%] w-[40vw] h-[40vw] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(200,150,12,0.12) 0%, transparent 70%)' }}
          animate={{ scale: [1, 1.08, 1] }}
          transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut', delay: 2 }}
        />

        {/* Floating particles */}
        {PARTICLES.map(p => (
          <motion.div
            key={p.id}
            className="absolute rounded-full bg-accent-500/20"
            style={{ left: `${p.x}%`, top: `${p.y}%`, width: p.size, height: p.size }}
            animate={{ y: [0, -20, 0], opacity: [0.3, 0.7, 0.3] }}
            transition={{ duration: 5 + p.delay, repeat: Infinity, ease: 'easeInOut', delay: p.delay }}
          />
        ))}
      </div>

      {/* ── Login card ────────────────────────────────────────────────── */}
      <motion.div
        className="relative w-full max-w-md"
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="card-glass p-8 sm:p-10">

          {/* Header */}
          <div className="text-center mb-8">
            {/* Logo mark */}
            <motion.div
              className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4"
              style={{ background: 'linear-gradient(135deg, #1B3A6B, #2563eb)' }}
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.15, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            >
              <ShieldCheck className="w-8 h-8 text-accent-400" />
            </motion.div>

            <motion.h1
              className="text-2xl font-black text-white tracking-tight"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
            >
              نظام المحفظة الذكية
            </motion.h1>
            <motion.p
              className="text-slate-400 text-sm mt-1 font-medium"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 }}
            >
              تسجيل الدخول إلى حسابك
            </motion.p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} noValidate className="space-y-5">

            {/* Phone field */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.35 }}
            >
              <label htmlFor="phone" className="form-label">
                رقم الهاتف
              </label>
              <div className="relative">
                <Smartphone className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-slate-500 pointer-events-none" />
                <input
                  id="phone"
                  name="phone"
                  type="tel"
                  inputMode="tel"
                  dir="ltr"
                  placeholder="770 000 000"
                  value={form.phone}
                  onChange={handleChange}
                  disabled={isSubmitting}
                  className={`${errors.phone ? 'input-field-error' : 'input-field'} pr-10 text-left placeholder:text-right`}
                  autoComplete="tel"
                />
              </div>
              <AnimatePresence>
                {errors.phone && (
                  <motion.p
                    className="flex items-center gap-1.5 text-financial-red-400 text-xs mt-1.5 font-medium"
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                  >
                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                    {errors.phone}
                  </motion.p>
                )}
              </AnimatePresence>
            </motion.div>

            {/* PIN / Password field */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.4 }}
            >
              <label htmlFor="pin" className="form-label">
                كلمة المرور (PIN)
              </label>
              <div className="relative">
                <Lock className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-slate-500 pointer-events-none" />
                <input
                  id="pin"
                  name="pin"
                  type={showPin ? 'text' : 'password'}
                  inputMode="numeric"
                  placeholder="••••••"
                  value={form.pin}
                  onChange={handleChange}
                  disabled={isSubmitting}
                  className={`${errors.pin ? 'input-field-error' : 'input-field'} pr-10 pl-10`}
                  autoComplete="current-password"
                  //maxLength={8}
                />
                <button
                  type="button"
                  onClick={() => setShowPin(v => !v)}
                  className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                  tabIndex={-1}
                  aria-label={showPin ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
                >
                  {showPin ? <EyeOff className="w-4.5 h-4.5" /> : <Eye className="w-4.5 h-4.5" />}
                </button>
              </div>
              <AnimatePresence>
                {errors.pin && (
                  <motion.p
                    className="flex items-center gap-1.5 text-financial-red-400 text-xs mt-1.5 font-medium"
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                  >
                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                    {errors.pin}
                  </motion.p>
                )}
              </AnimatePresence>
            </motion.div>

            {/* Submit */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.45 }}
              className="pt-2"
            >
              <button
                type="submit"
                disabled={isSubmitting}
                className="btn-primary w-full h-12 text-base"
                aria-busy={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    جاري التحقق...
                  </>
                ) : (
                  'دخول'
                )}
              </button>
            </motion.div>
          </form>

          {/* Footer note */}
          <motion.p
            className="text-center text-slate-600 text-xs mt-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
          >
            Smart Dorm Wallet — نظام آمن ومشفر
          </motion.p>
        </div>
      </motion.div>
    </div>
  );
}
