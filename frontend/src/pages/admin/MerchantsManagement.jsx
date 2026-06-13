/**
 * MerchantsManagement.jsx — Admin screen for managing merchants
 *
 * Tabs:
 *  1. قائمة التجار  — list, create, disable merchants
 *  2. تسجيل مشتريات — record a purchase split across users
 *  3. تسوية حساب    — record a cash settlement to a merchant
 */

import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Store, Plus, X, Loader2, RefreshCw, ArrowLeft,
  Users, Search, Check, ShoppingCart, Banknote,
  ToggleLeft, ToggleRight, Phone, FileText, AlertTriangle,
  Wallet, TrendingDown, TrendingUp
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';

import { merchantApi } from '../../api/merchantApi';
import { adminApi } from '../../api/adminApi';
import { QUERY_KEYS } from '../../api/queryKeys';
import { formatYER, parseAmount } from '../../utils/formatters';

// ═══════════════════════ CREATE MERCHANT MODAL ══════════════════════════════

function CreateMerchantModal({ onClose }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data) => merchantApi.createMerchant(data),
    onSuccess: () => {
      toast.success('تم إضافة التاجر بنجاح');
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.merchants() });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.message || 'فشل إضافة التاجر'),
  });

  const handleSubmit = () => {
    if (!name.trim()) return toast.error('اسم التاجر مطلوب');
    createMutation.mutate({ name: name.trim(), phone: phone.trim() || undefined, notes: notes.trim() || undefined });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-md bg-surface-dark border border-white/10 rounded-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between p-5 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center">
              <Store className="w-5 h-5 text-blue-400" />
            </div>
            <h2 className="text-white font-bold text-lg">إضافة تاجر جديد</h2>
          </div>
          <button onClick={onClose} className="btn-ghost w-8 h-8 p-0"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="form-label">اسم التاجر *</label>
            <input type="text" className="input-field" placeholder="مثال: سوبرماركت الأمل" value={name} onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <label className="form-label">رقم الهاتف (اختياري)</label>
            <input type="text" inputMode="tel" className="input-field" placeholder="777..." value={phone} onChange={e => setPhone(e.target.value)} />
          </div>
          <div>
            <label className="form-label">ملاحظات (اختياري)</label>
            <textarea className="input-field resize-none" rows={3} placeholder="أي معلومات إضافية..." value={notes} onChange={e => setNotes(e.target.value)} maxLength={1000} />
          </div>
        </div>

        <div className="p-5 border-t border-white/10 flex gap-3">
          <button onClick={onClose} className="btn-secondary flex-1">إلغاء</button>
          <button onClick={handleSubmit} disabled={createMutation.isPending || !name.trim()} className="btn-primary flex-1">
            {createMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            إضافة
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ═══════════════════════ RECORD PURCHASE MODAL ═══════════════════════════════

function RecordPurchaseModal({ merchant, onClose }) {
  const [amountRaw, setAmountRaw] = useState('');
  const [description, setDescription] = useState('');
  const [invoiceRef, setInvoiceRef] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [search, setSearch] = useState('');
  const queryClient = useQueryClient();

  const { data: usersData, isLoading: isUsersLoading } = useQuery({
    queryKey: QUERY_KEYS.adminUsers({ status: 'active' }),
    queryFn: () => adminApi.getUsers({ status: 'active', limit: 100 }).then(r => r.data.data),
    staleTime: 5 * 60_000,
  });

  const allUsers = usersData?.users || usersData?.docs || usersData || [];
  const filtered = useMemo(() => {
    if (!search.trim()) return allUsers;
    const q = search.toLowerCase();
    return allUsers.filter(u => u.fullName?.toLowerCase().includes(q) || u.roomNumber?.toLowerCase().includes(q));
  }, [allUsers, search]);

  const totalAmount = parseAmount(amountRaw);
  const sharePerUser = selectedIds.length > 0 && totalAmount ? Math.floor(totalAmount / selectedIds.length) : 0;

  const toggleUser = (id) => setSelectedIds(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);

  const purchaseMutation = useMutation({
    mutationFn: (data) => merchantApi.recordPurchase(merchant.publicId, data),
    onSuccess: () => {
      toast.success('تم تسجيل المشتريات بنجاح');
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.merchants() });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.merchant(merchant.publicId) });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.message || 'فشل تسجيل المشتريات'),
  });

  const handleSubmit = () => {
    if (!totalAmount) return toast.error('المبلغ غير صحيح');
    if (selectedIds.length === 0) return toast.error('يجب اختيار طالب واحد على الأقل');
    purchaseMutation.mutate({
      totalAmount,
      userPublicIds: selectedIds,
      description: description.trim() || undefined,
      invoiceReference: invoiceRef.trim() || undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/80 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-lg bg-surface-dark border border-white/10 rounded-2xl flex flex-col max-h-[95dvh] overflow-hidden"
      >
        <div className="flex items-center justify-between p-5 border-b border-white/10 flex-shrink-0">
          <div>
            <h2 className="text-white font-bold">تسجيل مشتريات</h2>
            <p className="text-slate-400 text-xs mt-0.5">{merchant.name}</p>
          </div>
          <button onClick={onClose} className="btn-ghost w-8 h-8 p-0"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="form-label">المبلغ الإجمالي *</label>
              <input type="text" inputMode="numeric" className="input-field" placeholder="0" value={amountRaw} onChange={e => setAmountRaw(e.target.value)} />
            </div>
            <div>
              <label className="form-label">رقم الفاتورة</label>
              <input type="text" className="input-field" placeholder="اختياري" value={invoiceRef} onChange={e => setInvoiceRef(e.target.value)} />
            </div>
            <div className="col-span-2">
              <label className="form-label">وصف</label>
              <input type="text" className="input-field" placeholder="مثال: مواد غذائية..." value={description} onChange={e => setDescription(e.target.value)} />
            </div>
          </div>

          {totalAmount && selectedIds.length > 0 && (
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-3 text-sm">
              <span className="text-slate-400">حصة كل طالب: </span>
              <strong className="text-blue-300">{formatYER(sharePerUser)}</strong>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="form-label mb-0">الطلاب *</label>
              {selectedIds.length > 0 && <span className="badge badge-blue">{selectedIds.length} مختار</span>}
            </div>
            <div className="relative mb-2">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input type="text" className="input-field pr-10 py-2" placeholder="بحث..." value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            {isUsersLoading ? (
              <div className="flex justify-center py-6"><Loader2 className="w-6 h-6 text-blue-400 animate-spin" /></div>
            ) : (
              <div className="border border-white/10 rounded-xl divide-y divide-white/5 max-h-44 overflow-y-auto">
                {filtered.map(user => {
                  const sel = selectedIds.includes(user.publicId);
                  return (
                    <button key={user.publicId} onClick={() => toggleUser(user.publicId)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 transition-colors text-right ${sel ? 'bg-blue-500/10' : 'hover:bg-white/5'}`}
                    >
                      <div className={`w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${sel ? 'bg-blue-500 border-blue-500' : 'border-white/20'}`}>
                        {sel && <Check className="w-3 h-3 text-white" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-sm font-medium truncate">{user.fullName}</p>
                        {user.roomNumber && <p className="text-slate-400 text-xs">غرفة {user.roomNumber}</p>}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="p-5 border-t border-white/10 flex gap-3 flex-shrink-0">
          <button onClick={onClose} className="btn-secondary flex-1">إلغاء</button>
          <button onClick={handleSubmit} disabled={purchaseMutation.isPending || !totalAmount || selectedIds.length === 0} className="btn-primary flex-1 bg-blue-600 hover:bg-blue-700 border-none">
            {purchaseMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShoppingCart className="w-4 h-4" />}
            تسجيل
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ═══════════════════════ RECORD SETTLEMENT MODAL ═════════════════════════════

function RecordSettlementModal({ merchant, onClose }) {
  const [amountRaw, setAmountRaw] = useState('');
  const [notes, setNotes] = useState('');
  const queryClient = useQueryClient();

  const settleMutation = useMutation({
    mutationFn: (data) => merchantApi.recordSettlement(merchant.publicId, data),
    onSuccess: () => {
      toast.success('تم تسجيل التسوية بنجاح');
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.merchants() });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.merchant(merchant.publicId) });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.message || 'فشل تسجيل التسوية'),
  });

  const amount = parseAmount(amountRaw);

  const handleSubmit = () => {
    if (!amount) return toast.error('المبلغ غير صحيح');
    settleMutation.mutate({ amount, settlementNotes: notes.trim() || undefined });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-md bg-surface-dark border border-white/10 rounded-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between p-5 border-b border-white/10">
          <div>
            <h2 className="text-white font-bold">تصفية حساب تاجر</h2>
            <p className="text-slate-400 text-xs mt-0.5">{merchant.name}</p>
          </div>
          <button onClick={onClose} className="btn-ghost w-8 h-8 p-0"><X className="w-5 h-5" /></button>
        </div>

        {merchant.outstandingBalance > 0 && (
          <div className="mx-5 mt-5 bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-sm">
            <span className="text-slate-400">الرصيد المستحق: </span>
            <strong className="text-red-300">{formatYER(merchant.outstandingBalance)}</strong>
          </div>
        )}

        <div className="p-5 space-y-4">
          <div>
            <label className="form-label">المبلغ المدفوع *</label>
            <input type="text" inputMode="numeric" className="input-field" placeholder="0" value={amountRaw} onChange={e => setAmountRaw(e.target.value)} autoFocus />
          </div>
          <div>
            <label className="form-label">ملاحظات</label>
            <input type="text" className="input-field" placeholder="اختياري" value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
        </div>

        <div className="p-5 border-t border-white/10 flex gap-3">
          <button onClick={onClose} className="btn-secondary flex-1">إلغاء</button>
          <button onClick={handleSubmit} disabled={settleMutation.isPending || !amount} className="btn-primary flex-1 bg-green-600 hover:bg-green-700 border-none">
            {settleMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Banknote className="w-4 h-4" />}
            تسجيل التسوية
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ═══════════════════════ MERCHANT CARD ═══════════════════════════════════════

function MerchantCard({ merchant, onPurchase, onSettle, onDisable }) {
  const isActive = merchant.status === 'active';

  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      className={`card-glass p-4 ${!isActive ? 'opacity-60' : ''}`}
    >
      <div className="flex items-start gap-3">
        <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${isActive ? 'bg-blue-500/15' : 'bg-slate-500/15'}`}>
          <Store className={`w-5 h-5 ${isActive ? 'text-blue-400' : 'text-slate-500'}`} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-white font-bold text-sm">{merchant.name}</p>
              {merchant.phone && (
                <p className="text-slate-400 text-xs mt-0.5 flex items-center gap-1">
                  <Phone className="w-3 h-3" /> {merchant.phone}
                </p>
              )}
            </div>
            <span className={`badge ${isActive ? 'badge-green' : 'badge-neutral'}`}>
              {isActive ? 'نشط' : 'معطّل'}
            </span>
          </div>

          {/* Balance Info */}
          {(merchant.outstandingBalance !== undefined) && (
            <div className="grid grid-cols-3 gap-2 mt-3 bg-white/5 rounded-xl p-3">
              <div className="text-center">
                <p className="text-slate-400 text-xs mb-0.5">مشتريات</p>
                <p className="text-white text-xs font-bold tabular">{formatYER(merchant.totalPurchases || 0)}</p>
              </div>
              <div className="text-center border-x border-white/10">
                <p className="text-slate-400 text-xs mb-0.5">مسدّد</p>
                <p className="text-green-400 text-xs font-bold tabular">{formatYER(merchant.totalSettlements || 0)}</p>
              </div>
              <div className="text-center">
                <p className="text-slate-400 text-xs mb-0.5">مستحق</p>
                <p className="text-red-400 text-xs font-bold tabular">{formatYER(merchant.outstandingBalance || 0)}</p>
              </div>
            </div>
          )}

          {/* Actions */}
          {isActive && (
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <button onClick={() => onPurchase(merchant)}
                className="btn-ghost py-1.5 px-3 text-xs text-blue-400 hover:bg-blue-500/10">
                <ShoppingCart className="w-3.5 h-3.5" /> مشتريات
              </button>
              <button onClick={() => onSettle(merchant)}
                className="btn-ghost py-1.5 px-3 text-xs text-green-400 hover:bg-green-500/10">
                <Banknote className="w-3.5 h-3.5" /> تسوية
              </button>
              <button onClick={() => onDisable(merchant.publicId)}
                className="btn-ghost py-1.5 px-3 text-xs text-red-400 hover:bg-red-500/10">
                <ToggleLeft className="w-3.5 h-3.5" /> تعطيل
              </button>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Main Component
// ══════════════════════════════════════════════════════════════════════════════

export default function MerchantsManagement() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [purchaseMerchant, setPurchaseMerchant] = useState(null);
  const [settleMerchant, setSettleMerchant] = useState(null);
  const [search, setSearch] = useState('');

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: QUERY_KEYS.merchants(),
    queryFn: () => merchantApi.getMerchants().then(r => r.data.data),
    staleTime: 30_000,
  });

  const merchants = data?.merchants || data || [];

  const filtered = useMemo(() => {
    if (!search.trim()) return merchants;
    const q = search.toLowerCase();
    return merchants.filter(m => m.name?.toLowerCase().includes(q) || m.phone?.includes(q));
  }, [merchants, search]);

  const disableMutation = useMutation({
    mutationFn: (id) => merchantApi.disableMerchant(id),
    onSuccess: () => {
      toast.success('تم تعطيل التاجر');
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.merchants() });
    },
    onError: (err) => toast.error(err.response?.data?.message || 'فشل التعطيل'),
  });

  const activeCount = merchants.filter(m => m.status === 'active').length;
  const totalOutstanding = merchants.reduce((s, m) => s + (m.outstandingBalance || 0), 0);

  return (
    <div className="min-h-dvh bg-surface-dark">
      {/* Header */}
      <header className="sticky top-0 z-30 glass-bg border-b border-white/10">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/admin/dashboard')} className="btn-ghost w-9 h-9 p-0">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-white font-bold text-base">إدارة التجار</h1>
              <p className="text-slate-400 text-xs">{activeCount} تاجر نشط</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => refetch()} disabled={isFetching} className="btn-ghost w-9 h-9 p-0">
              <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={() => setShowCreate(true)} className="btn-primary h-9 px-4 text-xs">
              <Plus className="w-4 h-4" /> تاجر جديد
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6 space-y-5">

        {/* Stats */}
        {merchants.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            <div className="card-glass p-4 relative overflow-hidden">
              <div className="absolute -right-3 -top-3 w-14 h-14 bg-blue-500/10 rounded-full blur-xl" />
              <Store className="w-5 h-5 text-blue-400 mb-1" />
              <p className="text-slate-400 text-xs">تجار نشطون</p>
              <p className="text-white font-bold text-xl">{activeCount}</p>
            </div>
            <div className="card-glass p-4 relative overflow-hidden">
              <div className="absolute -right-3 -top-3 w-14 h-14 bg-red-500/10 rounded-full blur-xl" />
              <TrendingDown className="w-5 h-5 text-red-400 mb-1" />
              <p className="text-slate-400 text-xs">إجمالي المستحق</p>
              <p className="text-red-400 font-bold text-xl tabular">{formatYER(totalOutstanding)}</p>
            </div>
          </div>
        )}

        {/* Search */}
        {merchants.length > 0 && (
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input type="text" className="input-field pr-10" placeholder="بحث بالاسم أو الهاتف..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        )}

        {/* List */}
        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
          </div>
        ) : merchants.length === 0 ? (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            className="card-glass p-16 text-center flex flex-col items-center"
          >
            <div className="w-20 h-20 rounded-full bg-blue-500/10 flex items-center justify-center mb-4">
              <Store className="w-10 h-10 text-blue-400/50" />
            </div>
            <h3 className="text-white font-bold text-xl mb-2">لا يوجد تجار مسجّلون</h3>
            <p className="text-slate-400 text-sm mb-6">أضف تجار الموارد الخدمية للسكن</p>
            <button onClick={() => setShowCreate(true)} className="btn-primary">
              <Plus className="w-4 h-4" /> إضافة تاجر
            </button>
          </motion.div>
        ) : (
          <div className="space-y-3">
            <AnimatePresence>
              {filtered.map(m => (
                <MerchantCard
                  key={m.publicId}
                  merchant={m}
                  onPurchase={setPurchaseMerchant}
                  onSettle={setSettleMerchant}
                  onDisable={(id) => {
                    if (confirm(`هل تريد تعطيل ${m.name}؟`)) disableMutation.mutate(id);
                  }}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </main>

      {/* Modals */}
      <AnimatePresence>
        {showCreate && <CreateMerchantModal onClose={() => setShowCreate(false)} />}
        {purchaseMerchant && (
          <RecordPurchaseModal merchant={purchaseMerchant} onClose={() => setPurchaseMerchant(null)} />
        )}
        {settleMerchant && (
          <RecordSettlementModal merchant={settleMerchant} onClose={() => setSettleMerchant(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}
