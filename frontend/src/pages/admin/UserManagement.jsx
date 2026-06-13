import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Users, 
  Search, 
  UserPlus, 
  ShieldCheck, 
  Ban, 
  Activity,
  Loader2,
  X,
  KeyRound,
  Eye,
  EyeOff,
  AlertTriangle,
  CheckCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../api/axiosInstance';

// Helper to format currency
const formatYER = (amount) => {
  if (amount === undefined || amount === null) return '0 ر.ي';
  return new Intl.NumberFormat('ar-YE').format(amount) + ' ر.ي';
};

// ── Reset Password Modal ──────────────────────────────────────────────────────
function ResetPasswordModal({ user, onClose }) {
  const [newPin, setNewPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const mutation = useMutation({
    mutationFn: async (pin) => {
      const res = await api.patch(`/admin/users/${user.publicId}/reset-password`, { newPin: pin });
      return res.data;
    },
    onSuccess: (data) => {
      toast.success(data.message || 'تم إعادة تعيين كلمة المرور بنجاح');
      onClose();
    },
    onError: (err) => {
      toast.error(err.response?.data?.message || 'فشل إعادة تعيين كلمة المرور');
    },
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (newPin.length !== 6 || !/^[0-9]{6}$/.test(newPin)) {
      toast.error('يجب أن تتكون كلمة المرور من 6 أرقام بالضبط');
      return;
    }
    if (!confirmed) {
      toast.error('يرجى تأكيد العملية أولاً');
      return;
    }
    mutation.mutate(newPin);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md">
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 20 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className="w-full max-w-md"
      >
        <div className="bg-surface-dark border border-white/10 rounded-2xl overflow-hidden shadow-2xl">
          {/* Header */}
          <div className="relative p-6 border-b border-white/10 bg-gradient-to-r from-amber-500/10 to-orange-500/10">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
                <KeyRound className="w-6 h-6 text-amber-400" />
              </div>
              <div>
                <h3 className="font-bold text-white text-lg">إعادة تعيين كلمة المرور</h3>
                <p className="text-slate-400 text-sm mt-0.5">{user.fullName}</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="absolute top-4 left-4 p-2 rounded-xl hover:bg-white/10 text-slate-400 hover:text-white transition-all"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Body */}
          <form onSubmit={handleSubmit} className="p-6 space-y-5">
            {/* Warning */}
            <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="text-amber-300 font-medium mb-1">تحذير</p>
                <p className="text-amber-400/80">
                  سيتم إعادة تعيين كلمة مرور الطالب <span className="font-bold text-amber-300">{user.fullName}</span> فوراً.
                  أبلغه بكلمة المرور الجديدة بعد حفظها.
                </p>
              </div>
            </div>

            {/* User info */}
            <div className="grid grid-cols-2 gap-3 p-4 rounded-xl bg-white/5 border border-white/10 text-sm">
              <div>
                <p className="text-slate-500 text-xs mb-1">الطالب</p>
                <p className="text-white font-medium">{user.fullName}</p>
              </div>
              <div>
                <p className="text-slate-500 text-xs mb-1">رقم الهاتف</p>
                <p className="text-white font-mono">{user.phone}</p>
              </div>
              {user.roomNumber && (
                <div>
                  <p className="text-slate-500 text-xs mb-1">الغرفة</p>
                  <p className="text-white">{user.roomNumber}</p>
                </div>
              )}
            </div>

            {/* New PIN input */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                كلمة المرور الجديدة <span className="text-red-400">*</span>
              </label>
              <div className="relative">
                <input
                  type={showPin ? 'text' : 'password'}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  required
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="w-full bg-white/5 border border-white/10 focus:border-accent-500/50 focus:ring-2 focus:ring-accent-500/20 rounded-xl px-4 py-3 text-white text-center text-2xl font-mono tracking-[0.5em] outline-none transition-all"
                  placeholder="● ● ● ● ● ●"
                  dir="ltr"
                />
                <button
                  type="button"
                  onClick={() => setShowPin(!showPin)}
                  className="absolute left-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-white transition-colors"
                >
                  {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {/* PIN strength indicator */}
              <div className="flex gap-1 mt-2">
                {[1,2,3,4,5,6].map((i) => (
                  <div
                    key={i}
                    className={`h-1 flex-1 rounded-full transition-all duration-300 ${
                      newPin.length >= i ? 'bg-accent-500' : 'bg-white/10'
                    }`}
                  />
                ))}
              </div>
              <p className="text-xs text-slate-500 mt-1.5">6 أرقام فقط — {newPin.length}/6</p>
            </div>

            {/* Confirmation checkbox */}
            <label className="flex items-start gap-3 cursor-pointer group">
              <div
                className={`mt-0.5 w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-all ${
                  confirmed
                    ? 'bg-accent-500 border-accent-500'
                    : 'border-white/20 group-hover:border-accent-500/50'
                }`}
                onClick={() => setConfirmed(!confirmed)}
              >
                {confirmed && <CheckCircle className="w-3.5 h-3.5 text-white" />}
              </div>
              <input type="checkbox" className="sr-only" checked={confirmed} onChange={() => setConfirmed(!confirmed)} />
              <span className="text-sm text-slate-300 leading-relaxed">
                أؤكد أنني أرغب في إعادة تعيين كلمة مرور هذا الطالب وسأقوم بإبلاغه بكلمة المرور الجديدة
              </span>
            </label>

            {/* Actions */}
            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="btn-secondary flex-1"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={mutation.isPending || newPin.length !== 6 || !confirmed}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-all shadow-lg shadow-amber-500/20"
              >
                {mutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <KeyRound className="w-4 h-4" />
                    إعادة التعيين
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      </motion.div>
    </div>
  );
}

// ── Add User Modal Component ──────────────────────────────────────────────────
function AddUserModal({ onClose }) {
  const queryClient = useQueryClient();
  const [formData, setFormData] = useState({
    fullName: '',
    phone: '',
    roomNumber: '',
    role: 'resident',
    initialPin: ''
  });

  const mutation = useMutation({
    mutationFn: async (data) => {
      const res = await api.post('/admin/users', data);
      return res.data;
    },
    onSuccess: () => {
      toast.success('تم إضافة المستخدم بنجاح');
      queryClient.invalidateQueries(['admin-users']);
      onClose();
    },
    onError: (err) => {
      toast.error(err.response?.data?.message || 'فشل إضافة المستخدم');
    }
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    mutation.mutate(formData);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-surface-dark border border-white/10 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl"
      >
        <div className="p-4 border-b border-white/10 flex justify-between items-center bg-white/5">
          <h3 className="font-bold text-white flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-accent-400" />
            طالب جديد
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-white/10 rounded-lg text-slate-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">الاسم الرباعي <span className="text-red-400">*</span></label>
            <input 
              required minLength={3}
              type="text" 
              className="input-field" 
              placeholder="مثال: أحمد محمد علي" 
              value={formData.fullName}
              onChange={e => setFormData({...formData, fullName: e.target.value})}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">رقم الهاتف <span className="text-red-400">*</span></label>
            <input 
              required
              type="tel" 
              className="input-field dir-ltr text-right" 
              placeholder="770000000" 
              value={formData.phone}
              onChange={e => setFormData({...formData, phone: e.target.value})}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">رقم الغرفة</label>
              <input 
                type="text" 
                className="input-field" 
                placeholder="A-101" 
                value={formData.roomNumber}
                onChange={e => setFormData({...formData, roomNumber: e.target.value})}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">كلمة المرور المؤقتة <span className="text-red-400">*</span></label>
              <input 
                required minLength={6} maxLength={6} pattern="[0-9]{6}"
                type="text" 
                className="input-field dir-ltr text-center tracking-widest font-mono" 
                placeholder="123456" 
                value={formData.initialPin}
                onChange={e => setFormData({...formData, initialPin: e.target.value.replace(/\D/g, '')})}
              />
              <p className="text-[10px] text-slate-500 mt-1">6 أرقام فقط</p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">صلاحية المستخدم</label>
            <select 
              className="input-field"
              value={formData.role}
              onChange={e => setFormData({...formData, role: e.target.value})}
            >
              <option value="resident">طالب (Resident)</option>
              <option value="deputy">نائب مسؤول (Deputy)</option>
              <option value="admin">مسؤول (Admin)</option>
            </select>
          </div>

          <div className="pt-4 flex gap-3">
            <button type="submit" disabled={mutation.isPending} className="btn-primary flex-1 flex justify-center items-center gap-2">
              {mutation.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : 'حفظ البيانات'}
            </button>
            <button type="button" onClick={onClose} className="btn-secondary flex-1">
              إلغاء
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function UserManagement() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [resetPasswordUser, setResetPasswordUser] = useState(null);
  const [page, setPage] = useState(1);

  // ── Fetch Users ──
  const { data: usersData, isLoading } = useQuery({
    queryKey: ['admin-users', page, searchTerm],
    queryFn: async () => {
      const res = await api.get('/admin/users', {
        params: { page, limit: 20, search: searchTerm }
      });
      return res.data.data;
    },
    keepPreviousData: true,
  });

  // ── Toggle Status Mutation ──
  const toggleStatusMutation = useMutation({
    mutationFn: async ({ publicId, newStatus }) => {
      const res = await api.patch(`/admin/users/${publicId}/status`, { status: newStatus });
      return res.data;
    },
    onSuccess: () => {
      toast.success('تم تغيير حالة المستخدم بنجاح');
      queryClient.invalidateQueries(['admin-users']);
    },
    onError: (err) => {
      toast.error(err.response?.data?.message || 'حدث خطأ أثناء تغيير الحالة');
    }
  });

  // ── Handle Toggle ──
  const handleToggleStatus = (user) => {
    const newStatus = user.status === 'active' ? 'suspended' : 'active';
    if (window.confirm(`هل أنت متأكد من ${newStatus === 'active' ? 'تفعيل' : 'إيقاف'} حساب ${user.fullName}؟`)) {
      toggleStatusMutation.mutate({ publicId: user.publicId, newStatus });
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* ── Header ── */}
      <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Users className="w-6 h-6 text-accent-400" />
            إدارة المستخدمين
          </h2>
          <p className="text-slate-400 text-sm mt-1">عرض وتعديل حسابات الطلاب</p>
        </div>
        
        <button 
          onClick={() => setIsModalOpen(true)}
          className="btn-primary w-full md:w-auto flex items-center justify-center gap-2"
        >
          <UserPlus className="w-5 h-5" />
          إضافة طالب
        </button>
      </div>

      {/* ── Search & Filters ── */}
      <div className="card-glass p-3 flex items-center gap-3">
        <Search className="w-5 h-5 text-slate-500" />
        <input 
          type="text" 
          placeholder="ابحث بالاسم أو رقم الهاتف..." 
          className="bg-transparent border-none outline-none text-white w-full placeholder:text-slate-500"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      {/* ── Users List ── */}
      <div className="card-glass overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center p-12">
            <Loader2 className="w-8 h-8 text-accent-500 animate-spin" />
          </div>
        ) : usersData?.docs?.length === 0 ? (
          <div className="text-center p-12 text-slate-400">
            <p>لا يوجد مستخدمين لعرضهم</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-right text-slate-300">
              <thead className="text-xs text-slate-400 uppercase bg-white/5 border-b border-white/10">
                <tr>
                  <th className="px-6 py-4 font-medium">الاسم</th>
                  <th className="px-6 py-4 font-medium">الهاتف</th>
                  <th className="px-6 py-4 font-medium">الغرفة</th>
                  <th className="px-6 py-4 font-medium">الدور</th>
                  <th className="px-6 py-4 font-medium">الحالة</th>
                  <th className="px-6 py-4 font-medium text-left">إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {usersData?.docs?.map((user) => (
                  <tr key={user.publicId} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                    <td className="px-6 py-4 font-medium text-white">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-accent-500/20 flex items-center justify-center text-accent-400 font-bold">
                          {user.fullName.charAt(0)}
                        </div>
                        {user.fullName}
                      </div>
                    </td>
                    <td className="px-6 py-4 font-mono text-slate-400">{user.phone}</td>
                    <td className="px-6 py-4">{user.roomNumber || '-'}</td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 rounded-md text-[10px] font-bold ${
                        user.role === 'admin' ? 'bg-purple-500/20 text-purple-400' :
                        user.role === 'deputy' ? 'bg-blue-500/20 text-blue-400' :
                        'bg-slate-500/20 text-slate-400'
                      }`}>
                        {user.role === 'admin' ? 'مدير' : user.role === 'deputy' ? 'نائب' : 'طالب'}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      {user.status === 'active' ? (
                        <span className="flex items-center gap-1 text-green-400">
                          <ShieldCheck className="w-4 h-4" /> نشط
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-red-400">
                          <Ban className="w-4 h-4" /> موقوف
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-left">
                      <div className="flex items-center justify-end gap-1">
                        {/* View Transactions */}
                        <button 
                          onClick={() => navigate(`/admin/users/${user.publicId}/transactions`)}
                          className="p-2 rounded-lg hover:bg-accent-500/20 text-accent-400 transition-colors"
                          title="عرض السجل المالي"
                        >
                          <Activity className="w-4 h-4" />
                        </button>

                        {/* Reset Password */}
                        <button
                          onClick={() => setResetPasswordUser(user)}
                          className="p-2 rounded-lg hover:bg-amber-500/20 text-amber-400 transition-colors"
                          title="إعادة تعيين كلمة المرور"
                        >
                          <KeyRound className="w-4 h-4" />
                        </button>

                        {/* Toggle Status */}
                        <button 
                          onClick={() => handleToggleStatus(user)}
                          className={`p-2 rounded-lg transition-colors ${
                            user.status === 'active' ? 'hover:bg-red-500/20 text-red-400' : 'hover:bg-green-500/20 text-green-400'
                          }`}
                          title={user.status === 'active' ? 'إيقاف الحساب' : 'تفعيل الحساب'}
                        >
                          {user.status === 'active' ? <Ban className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        
        {/* Pagination Controls */}
        {usersData?.totalPages > 1 && (
          <div className="p-4 border-t border-white/10 flex justify-between items-center">
            <button 
              disabled={page === 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              className="btn-ghost text-sm disabled:opacity-50"
            >
              السابق
            </button>
            <span className="text-sm text-slate-400">
              صفحة {page} من {usersData.totalPages}
            </span>
            <button 
              disabled={page === usersData.totalPages}
              onClick={() => setPage(p => p + 1)}
              className="btn-ghost text-sm disabled:opacity-50"
            >
              التالي
            </button>
          </div>
        )}
      </div>

      {/* ── Modals ── */}
      <AnimatePresence>
        {isModalOpen && <AddUserModal onClose={() => setIsModalOpen(false)} />}
        {resetPasswordUser && (
          <ResetPasswordModal
            user={resetPasswordUser}
            onClose={() => setResetPasswordUser(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
