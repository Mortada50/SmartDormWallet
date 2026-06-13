import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useMutation } from '@tanstack/react-query';
import { ChevronRight, User, Phone, Key, Shield, AlertTriangle, Hash, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../api/axiosInstance';
import useAuthStore from '../../store/authStore';

export default function ResidentProfile() {
  const navigate = useNavigate();
  const { user, updateUser } = useAuthStore();
  
  const [activeTab, setActiveTab] = useState('info'); // 'info' | 'security'
  
  // Profile Form State
  const [formData, setFormData] = useState({
    fullName: user?.fullName || '',
    phone: user?.phone || '',
    roomNumber: user?.roomNumber || '',
  });

  // Password Form State
  const [pwdData, setPwdData] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });

  // ── Mutations ─────────────────────────────────────────────────────────────
  
  const updateProfileMutation = useMutation({
    mutationFn: async (data) => {
      const res = await api.patch('/auth/me', data);
      return res.data;
    },
    onSuccess: (data) => {
      updateUser(data.data.user);
      toast.success('تم تحديث الملف الشخصي بنجاح');
    },
    onError: (err) => {
      toast.error(err.response?.data?.message || 'حدث خطأ أثناء التحديث');
    }
  });

  const changePwdMutation = useMutation({
    mutationFn: async (data) => {
      const res = await api.post('/auth/change-password', data);
      return res.data;
    },
    onSuccess: () => {
      toast.success('تم تغيير كلمة المرور بنجاح');
      setPwdData({ currentPassword: '', newPassword: '', confirmPassword: '' });
    },
    onError: (err) => {
      toast.error(err.response?.data?.message || 'حدث خطأ أثناء تغيير كلمة المرور');
    }
  });

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleProfileSubmit = (e) => {
    e.preventDefault();
    const updates = {};
    if (formData.fullName !== user.fullName) updates.fullName = formData.fullName;
    if (formData.phone !== user.phone) updates.phone = formData.phone;
    if (formData.roomNumber !== user.roomNumber) updates.roomNumber = formData.roomNumber;
    
    if (Object.keys(updates).length === 0) {
      return toast('لم تقم بتغيير أي بيانات', { icon: 'ℹ️' });
    }
    
    updateProfileMutation.mutate(updates);
  };

  const handlePwdSubmit = (e) => {
    e.preventDefault();
    if (pwdData.newPassword !== pwdData.confirmPassword) {
      return toast.error('كلمات المرور الجديدة غير متطابقة');
    }
    if (pwdData.newPassword.length < 8) {
      return toast.error('كلمة المرور يجب أن تكون 8 أحرف على الأقل');
    }
    
    changePwdMutation.mutate({
      currentPassword: pwdData.currentPassword,
      newPassword: pwdData.newPassword,
    });
  };

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="min-h-dvh bg-surface-dark pb-safe">
      {/* Sticky Header */}
      <header className="sticky top-0 z-40 glass-bg border-b border-white/8">
        <div className="max-w-2xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/dashboard')}
              className="btn-ghost w-10 h-10 p-0 flex items-center justify-center rounded-full"
            >
              <ChevronRight className="w-6 h-6" />
            </button>
            <h1 className="text-xl font-bold text-white tracking-tight">إعدادات الحساب</h1>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        {/* Tabs */}
        <div className="flex gap-2 p-1 bg-surface-card rounded-xl">
          <button
            onClick={() => setActiveTab('info')}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-bold rounded-lg transition-all ${
              activeTab === 'info' ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white hover:bg-white/5'
            }`}
          >
            <User className="w-4 h-4" />
            البيانات الشخصية
          </button>
          <button
            onClick={() => setActiveTab('security')}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-bold rounded-lg transition-all ${
              activeTab === 'security' ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white hover:bg-white/5'
            }`}
          >
            <Shield className="w-4 h-4" />
            الأمان وكلمة المرور
          </button>
        </div>

        {/* Tab Content */}
        <div className="relative">
          {activeTab === 'info' && (
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              className="card-glass p-5 space-y-5"
            >
              <form onSubmit={handleProfileSubmit} className="space-y-4">
                <div>
                  <label className="form-label block text-sm font-medium text-slate-300 mb-1.5">الاسم الكامل</label>
                  <div className="relative">
                    <User className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" />
                    <input
                      type="text"
                      className="input-field w-full pl-3 pr-10 py-3 rounded-xl bg-white/5 border border-white/10 focus:border-brand-gold/70 text-white outline-none"
                      value={formData.fullName}
                      onChange={(e) => setFormData({ ...formData, fullName: e.target.value })}
                      required
                      minLength={2}
                    />
                  </div>
                </div>

                <div>
                  <label className="form-label block text-sm font-medium text-slate-300 mb-1.5">رقم الهاتف</label>
                  <div className="relative">
                    <Phone className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" />
                    <input
                      type="text"
                      dir="ltr"
                      className="input-field w-full pl-3 pr-10 py-3 rounded-xl bg-white/5 border border-white/10 focus:border-brand-gold/70 text-white outline-none text-left"
                      value={formData.phone}
                      onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                      required
                    />
                  </div>
                </div>

                <div>
                  <label className="form-label block text-sm font-medium text-slate-300 mb-1.5">رقم الغرفة (اختياري)</label>
                  <div className="relative">
                    <Hash className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" />
                    <input
                      type="text"
                      dir="ltr"
                      className="input-field w-full pl-3 pr-10 py-3 rounded-xl bg-white/5 border border-white/10 focus:border-brand-gold/70 text-white outline-none text-left"
                      value={formData.roomNumber}
                      onChange={(e) => setFormData({ ...formData, roomNumber: e.target.value })}
                    />
                  </div>
                </div>

                <div className="pt-2">
                  <button
                    type="submit"
                    disabled={updateProfileMutation.isPending}
                    className="btn-primary w-full flex items-center justify-center gap-2"
                  >
                    {updateProfileMutation.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : 'حفظ التعديلات'}
                  </button>
                </div>
              </form>
            </motion.div>
          )}

          {activeTab === 'security' && (
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              className="card-glass p-5 space-y-5"
            >
              {/* Account Status Info */}
              <div className="flex items-start gap-3 p-4 rounded-xl bg-white/5 border border-white/10">
                <AlertTriangle className="w-5 h-5 text-brand-gold shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-bold text-white mb-1">نصائح الأمان</p>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    استخدم كلمة مرور قوية تتكون من 8 أحرف على الأقل. لا تشارك كلمة المرور مع أي شخص.
                  </p>
                </div>
              </div>

              <form onSubmit={handlePwdSubmit} className="space-y-4">
                <div>
                  <label className="form-label block text-sm font-medium text-slate-300 mb-1.5">كلمة المرور الحالية</label>
                  <div className="relative">
                    <Key className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" />
                    <input
                      type="password"
                      dir="ltr"
                      className="input-field w-full pl-3 pr-10 py-3 rounded-xl bg-white/5 border border-white/10 focus:border-brand-gold/70 text-white outline-none text-left"
                      value={pwdData.currentPassword}
                      onChange={(e) => setPwdData({ ...pwdData, currentPassword: e.target.value })}
                      required
                    />
                  </div>
                </div>

                <div className="divider" />

                <div>
                  <label className="form-label block text-sm font-medium text-slate-300 mb-1.5">كلمة المرور الجديدة</label>
                  <div className="relative">
                    <Key className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" />
                    <input
                      type="password"
                      dir="ltr"
                      className="input-field w-full pl-3 pr-10 py-3 rounded-xl bg-white/5 border border-white/10 focus:border-brand-gold/70 text-white outline-none text-left"
                      value={pwdData.newPassword}
                      onChange={(e) => setPwdData({ ...pwdData, newPassword: e.target.value })}
                      required
                      minLength={8}
                    />
                  </div>
                </div>

                <div>
                  <label className="form-label block text-sm font-medium text-slate-300 mb-1.5">تأكيد كلمة المرور الجديدة</label>
                  <div className="relative">
                    <Key className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" />
                    <input
                      type="password"
                      dir="ltr"
                      className="input-field w-full pl-3 pr-10 py-3 rounded-xl bg-white/5 border border-white/10 focus:border-brand-gold/70 text-white outline-none text-left"
                      value={pwdData.confirmPassword}
                      onChange={(e) => setPwdData({ ...pwdData, confirmPassword: e.target.value })}
                      required
                      minLength={8}
                    />
                  </div>
                </div>

                <div className="pt-2">
                  <button
                    type="submit"
                    disabled={changePwdMutation.isPending}
                    className="btn-primary w-full flex items-center justify-center gap-2 bg-gradient-to-l from-financial-red-500 to-financial-red-600 border-none shadow-lg shadow-financial-red-500/20"
                  >
                    {changePwdMutation.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : 'تحديث كلمة المرور'}
                  </button>
                </div>
              </form>
            </motion.div>
          )}
        </div>
      </main>
    </div>
  );
}
