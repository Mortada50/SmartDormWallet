/**
 * SharedExpensesAdmin.jsx — Admin screen for creating and managing shared expenses
 *
 * Features:
 *  - List all shared expenses with status
 *  - Create new expense: pick users, set amount, add description
 *  - Per-user share calculation shown in real-time
 */

import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Receipt, Plus, X, Loader2, RefreshCw, ArrowLeft,
  Users, Search, CheckSquare, Square, Calendar,
  AlertTriangle, ChevronDown, Divide, Check
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';

import { adminApi } from '../../api/adminApi';
import { QUERY_KEYS } from '../../api/queryKeys';
import { formatYER, formatDate, parseAmount } from '../../utils/formatters';

// ── Create Expense Modal ───────────────────────────────────────────────────

function CreateExpenseModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [amountRaw, setAmountRaw] = useState('');
  const [description, setDescription] = useState('');
  const [expenseDate, setExpenseDate] = useState(
    new Date().toISOString().slice(0, 10)
  );
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const queryClient = useQueryClient();

  // Fetch users for selection
  const { data: usersData, isLoading: isUsersLoading } = useQuery({
    queryKey: QUERY_KEYS.adminUsers({ role: 'resident', status: 'active' }),
    queryFn: () =>
      adminApi.getUsers({ role: 'resident', status: 'active', limit: 100 })
        .then(r => r.data.data),
    staleTime: 5 * 60_000,
  });

  const allUsers = usersData?.users || usersData || [];

  const filtered = useMemo(() => {
    if (!search.trim()) return allUsers;
    const q = search.toLowerCase();
    return allUsers.filter(u =>
      u.fullName?.toLowerCase().includes(q) ||
      u.roomNumber?.toLowerCase().includes(q) ||
      u.phone?.includes(q)
    );
  }, [allUsers, search]);

  const totalAmount = parseAmount(amountRaw);
  const sharePerUser = selectedIds.length > 0 && totalAmount
    ? Math.floor(totalAmount / selectedIds.length)
    : 0;
  const remainder = totalAmount && selectedIds.length > 0
    ? totalAmount - sharePerUser * selectedIds.length
    : 0;

  const toggleUser = (publicId) => {
    setSelectedIds(prev =>
      prev.includes(publicId) ? prev.filter(id => id !== publicId) : [...prev, publicId]
    );
  };

  const toggleAll = () => {
    if (selectedIds.length === filtered.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filtered.map(u => u.publicId));
    }
  };

  const createMutation = useMutation({
    mutationFn: (data) => adminApi.createExpense(data),
    onSuccess: () => {
      toast.success('تم إنشاء المصروف المشترك بنجاح');
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminExpenses() });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminStats() });
      onCreated?.();
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.message || 'فشل إنشاء المصروف'),
  });

  const handleSubmit = () => {
    if (!name.trim()) return toast.error('اسم المصروف مطلوب');
    if (!totalAmount) return toast.error('المبلغ الإجمالي غير صحيح');
    if (selectedIds.length === 0) return toast.error('يجب اختيار طالب واحد على الأقل');
    createMutation.mutate({
      name: name.trim(),
      totalAmount,
      userPublicIds: selectedIds,
      description: description.trim() || undefined,
      expenseDate,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/80 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-2xl bg-surface-dark border border-white/10 rounded-2xl flex flex-col max-h-[95dvh] overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-white/10 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-accent-500/20 flex items-center justify-center">
              <Receipt className="w-5 h-5 text-accent-400" />
            </div>
            <h2 className="text-white font-bold text-lg">مصروف مشترك جديد</h2>
          </div>
          <button onClick={onClose} className="btn-ghost w-8 h-8 p-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">

          {/* Basic Info */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="form-label">اسم المصروف *</label>
              <input
                type="text"
                className="input-field"
                placeholder="مثال: فاتورة الكهرباء - يونيو"
                value={name}
                onChange={e => setName(e.target.value)}
                maxLength={200}
              />
            </div>

            <div>
              <label className="form-label">المبلغ الإجمالي (ريال) *</label>
              <input
                type="text"
                inputMode="numeric"
                className="input-field"
                placeholder="0"
                value={amountRaw}
                onChange={e => setAmountRaw(e.target.value)}
              />
            </div>

            <div>
              <label className="form-label">تاريخ المصروف</label>
              <input
                type="date"
                className="input-field"
                value={expenseDate}
                onChange={e => setExpenseDate(e.target.value)}
              />
            </div>

            <div className="sm:col-span-2">
              <label className="form-label">ملاحظة (اختياري)</label>
              <input
                type="text"
                className="input-field"
                placeholder="وصف إضافي للمصروف..."
                value={description}
                onChange={e => setDescription(e.target.value)}
                maxLength={500}
              />
            </div>
          </div>

          {/* Share Preview */}
          {totalAmount && selectedIds.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: -5 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-accent-500/10 border border-accent-500/25 rounded-xl p-4 flex items-center gap-4"
            >
              <Divide className="w-5 h-5 text-accent-400 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-white font-semibold text-sm">
                  {formatYER(totalAmount)} ÷ {selectedIds.length} طالب
                </p>
                <p className="text-accent-300 text-xs mt-0.5">
                  حصة كل طالب: <strong className="text-white">{formatYER(sharePerUser)}</strong>
                  {remainder > 0 && <span className="text-slate-400"> (فارق {remainder} ريال على الطالب الأول)</span>}
                </p>
              </div>
            </motion.div>
          )}

          {/* User Selection */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="form-label mb-0">اختيار الطلاب المعنيين *</label>
              <div className="flex items-center gap-2">
                {selectedIds.length > 0 && (
                  <span className="badge badge-gold">{selectedIds.length} مختار</span>
                )}
                <button onClick={toggleAll} className="btn-ghost py-1 px-2 text-xs">
                  {selectedIds.length === filtered.length && filtered.length > 0 ? 'إلغاء الكل' : 'تحديد الكل'}
                </button>
              </div>
            </div>

            <div className="relative mb-2">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                className="input-field pr-10 py-2"
                placeholder="بحث بالاسم أو الغرفة..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>

            {isUsersLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="w-6 h-6 text-accent-400 animate-spin" />
              </div>
            ) : (
              <div className="border border-white/10 rounded-xl divide-y divide-white/5 max-h-52 overflow-y-auto">
                {filtered.length === 0 ? (
                  <p className="text-slate-400 text-sm text-center py-6">لا توجد نتائج</p>
                ) : (
                  filtered.map(user => {
                    const isSelected = selectedIds.includes(user.publicId);
                    return (
                      <button
                        key={user.publicId}
                        onClick={() => toggleUser(user.publicId)}
                        className={`w-full flex items-center gap-3 px-4 py-3 transition-colors text-right ${
                          isSelected ? 'bg-accent-500/10' : 'hover:bg-white/5'
                        }`}
                      >
                        <div className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 border transition-colors ${
                          isSelected ? 'bg-accent-500 border-accent-500' : 'border-white/20'
                        }`}>
                          {isSelected && <Check className="w-3 h-3 text-white" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-white text-sm font-medium truncate">{user.fullName}</p>
                          {user.roomNumber && (
                            <p className="text-slate-400 text-xs">غرفة {user.roomNumber}</p>
                          )}
                        </div>
                        {isSelected && totalAmount && (
                          <span className="text-accent-400 text-xs font-semibold tabular flex-shrink-0">
                            {formatYER(sharePerUser)}
                          </span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-white/10 flex gap-3 flex-shrink-0">
          <button onClick={onClose} className="btn-secondary flex-1">إلغاء</button>
          <button
            onClick={handleSubmit}
            disabled={createMutation.isPending || !name.trim() || !totalAmount || selectedIds.length === 0}
            className="btn-primary flex-1"
          >
            {createMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            إنشاء المصروف
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ── Expense Row ────────────────────────────────────────────────────────────

function ExpenseRow({ expense }) {
  const affectedCount = expense.affectedUsers?.length || 0;
  const hasDispute = expense.status === 'disputed' || (expense.disputes?.some(d => d.status === 'open'));

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="card-glass p-4 flex flex-col sm:flex-row sm:items-center gap-3"
    >
      <div className="flex items-start gap-3 flex-1 min-w-0">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
          hasDispute ? 'bg-orange-500/15' : 'bg-accent-500/15'
        }`}>
          <Receipt className={`w-5 h-5 ${hasDispute ? 'text-orange-400' : 'text-accent-400'}`} />
        </div>
        <div className="min-w-0">
          <p className="text-white font-bold text-sm truncate">{expense.name}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
            <span className="text-slate-400 text-xs flex items-center gap-1">
              <Calendar className="w-3 h-3" /> {formatDate(expense.expenseDate || expense.createdAt)}
            </span>
            <span className="text-slate-400 text-xs flex items-center gap-1">
              <Users className="w-3 h-3" /> {affectedCount} طالب
            </span>
            {hasDispute && <span className="badge badge-red">نزاع مفتوح</span>}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between sm:justify-end gap-4 border-t border-white/5 pt-3 sm:border-0 sm:pt-0">
        <div className="text-left">
          <p className="text-white font-bold tabular">{formatYER(expense.totalAmount)}</p>
          {affectedCount > 0 && (
            <p className="text-slate-400 text-xs">{formatYER(Math.floor(expense.totalAmount / affectedCount))} / طالب</p>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Main Component
// ══════════════════════════════════════════════════════════════════════════════

export default function SharedExpensesAdmin() {
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: QUERY_KEYS.adminExpenses(),
    queryFn: () => adminApi.getExpenses({ limit: 50 }).then(r => r.data.data),
    staleTime: 30_000,
  });

  const expenses = data?.expenses || data || [];
  const totalExpended = expenses.reduce((sum, e) => sum + (e.totalAmount || 0), 0);

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
              <h1 className="text-white font-bold text-base">المصروفات المشتركة</h1>
              <p className="text-slate-400 text-xs">{expenses.length} مصروف مسجّل</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => refetch()} disabled={isFetching} className="btn-ghost w-9 h-9 p-0">
              <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={() => setShowCreate(true)} className="btn-primary h-9 px-4 text-xs">
              <Plus className="w-4 h-4" /> مصروف جديد
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6 space-y-5">

        {/* Stats */}
        {expenses.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            <div className="card-glass p-4 relative overflow-hidden">
              <div className="absolute -right-3 -top-3 w-14 h-14 bg-accent-500/10 rounded-full blur-xl" />
              <p className="text-slate-400 text-xs mb-1">إجمالي المصروفات</p>
              <p className="text-white font-bold text-xl tabular">{formatYER(totalExpended)}</p>
            </div>
            <div className="card-glass p-4 relative overflow-hidden">
              <div className="absolute -right-3 -top-3 w-14 h-14 bg-orange-500/10 rounded-full blur-xl" />
              <p className="text-slate-400 text-xs mb-1">نزاعات مفتوحة</p>
              <p className="text-orange-400 font-bold text-xl tabular">
                {expenses.filter(e => e.status === 'disputed').length}
              </p>
            </div>
          </div>
        )}

        {/* List */}
        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-8 h-8 text-accent-400 animate-spin" />
          </div>
        ) : expenses.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="card-glass p-16 text-center flex flex-col items-center"
          >
            <div className="w-20 h-20 rounded-full bg-accent-500/10 flex items-center justify-center mb-4">
              <Receipt className="w-10 h-10 text-accent-400/50" />
            </div>
            <h3 className="text-white font-bold text-xl mb-2">لا توجد مصروفات مسجّلة</h3>
            <p className="text-slate-400 text-sm mb-6">ابدأ بإضافة أول مصروف مشترك للطلاب</p>
            <button onClick={() => setShowCreate(true)} className="btn-primary">
              <Plus className="w-4 h-4" /> إضافة مصروف
            </button>
          </motion.div>
        ) : (
          <div className="space-y-3">
            <AnimatePresence>
              {expenses.map(e => <ExpenseRow key={e.publicId} expense={e} />)}
            </AnimatePresence>
          </div>
        )}
      </main>

      {/* Create Modal */}
      <AnimatePresence>
        {showCreate && (
          <CreateExpenseModal onClose={() => setShowCreate(false)} />
        )}
      </AnimatePresence>
    </div>
  );
}
