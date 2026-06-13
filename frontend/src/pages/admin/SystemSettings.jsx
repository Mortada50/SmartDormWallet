/**
 * SystemSettings.jsx — Advanced financial system settings
 *
 * Allows admin to configure:
 *  - Withdrawal fee (type + value)
 *  - Debt limits (maxDebtPerUser, allowDebt)
 *  - Deposit request expiry hours
 *  - Maintenance mode toggle
 *  - Low balance threshold
 */

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  Settings, Save, Loader2, RefreshCw, ArrowLeft,
  Percent, DollarSign, Clock, Shield, AlertTriangle,
  Power, Info, TrendingDown, Landmark, CheckCircle
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';

import { adminApi } from '../../api/adminApi';
import { QUERY_KEYS } from '../../api/queryKeys';
import { formatYER } from '../../utils/formatters';

// ── Setting Row Component ──────────────────────────────────────────────────

function SettingSection({ title, icon: Icon, color = 'text-accent-400', children }) {
  return (
    <section className="card-glass overflow-hidden">
      <div className={`flex items-center gap-3 p-4 border-b border-white/10 bg-white/3`}>
        <div className={`w-9 h-9 rounded-xl bg-white/5 flex items-center justify-center`}>
          <Icon className={`w-4.5 h-4.5 ${color}`} />
        </div>
        <h2 className="text-white font-bold text-sm">{title}</h2>
      </div>
      <div className="p-4 space-y-4">{children}</div>
    </section>
  );
}

function SettingRow({ label, hint, children }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <p className="text-white text-sm font-medium">{label}</p>
        {hint && <p className="text-slate-500 text-xs mt-0.5">{hint}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ value, onChange, disabled }) {
  return (
    <button
      onClick={() => onChange(!value)}
      disabled={disabled}
      className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-accent-500/40 disabled:opacity-50 ${value ? 'bg-accent-500' : 'bg-slate-600'}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${value ? '-translate-x-6' : '-translate-x-1'}`} />
    </button>
  );
}

function IntInput({ value, onChange, min = 0, max, placeholder, suffix }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        className="input-field w-32 text-center py-2"
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        min={min}
        max={max}
        placeholder={placeholder}
      />
      {suffix && <span className="text-slate-400 text-sm">{suffix}</span>}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Main Component
// ══════════════════════════════════════════════════════════════════════════════

export default function SystemSettings() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Form state mirrors backend settings shape
  const [form, setForm] = useState(null);
  const [isDirty, setIsDirty] = useState(false);

  const { data: settings, isLoading, refetch } = useQuery({
    queryKey: QUERY_KEYS.adminSettings(),
    queryFn: () => adminApi.getSettings().then(r => r.data.data),
    staleTime: 60_000,
  });

  // Initialize form when settings load
  useEffect(() => {
    if (settings && !form) {
      setForm({
        withdrawalFeeType:          settings.withdrawalFeeType ?? 'FIXED',
        withdrawalFeeValue:         settings.withdrawalFeeValue ?? 0,
        allowDebt:                  settings.allowDebt ?? false,
        maxDebtPerUser:             settings.maxDebtPerUser ?? 0,
        depositRequestExpiryHours:  settings.depositRequestExpiryHours ?? 48,
        lowBalanceThreshold:        settings.lowBalanceThreshold ?? 0,
        maintenanceMode:            settings.maintenanceMode ?? false,
      });
    }
  }, [settings, form]);

  const patch = (key, value) => {
    setForm(prev => ({ ...prev, [key]: value }));
    setIsDirty(true);
  };

  const saveMutation = useMutation({
    mutationFn: (data) => adminApi.updateSettings(data),
    onSuccess: () => {
      toast.success('تم حفظ الإعدادات بنجاح ✓');
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminSettings() });
      setIsDirty(false);
    },
    onError: (err) => toast.error(err.response?.data?.message || 'فشل حفظ الإعدادات'),
  });

  const handleSave = () => {
    if (!form) return;
    // Map form to backend expected shape
    saveMutation.mutate({
      withdrawalFeeType:            form.withdrawalFeeType,
      withdrawalFeeValue:           Number(form.withdrawalFeeValue),
      allowDebt:                    form.allowDebt,
      maxDebtPerUser:               Number(form.maxDebtPerUser),
      depositRequestExpiryHours:    Number(form.depositRequestExpiryHours),
      lowBalanceThreshold:          Number(form.lowBalanceThreshold),
      maintenanceMode:              form.maintenanceMode,
    });
  };

  if (isLoading || !form) {
    return (
      <div className="min-h-dvh bg-surface-dark flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-accent-400 animate-spin" />
      </div>
    );
  }

  const feePreview = form.withdrawalFeeType === 'FIXED'
    ? `${formatYER(form.withdrawalFeeValue)} ثابتة`
    : `${form.withdrawalFeeValue}% من المبلغ`;

  return (
    <div className="min-h-dvh bg-surface-dark">
      {/* Header */}
      <header className="sticky top-0 z-30 glass-bg border-b border-white/10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/admin/dashboard')} className="btn-ghost w-9 h-9 p-0">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-white font-bold text-base">إعدادات النظام</h1>
              <p className="text-slate-400 text-xs">الإعدادات المالية والتشغيلية</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => { setForm(null); refetch(); setIsDirty(false); }} className="btn-ghost w-9 h-9 p-0" title="إعادة تحميل">
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={handleSave}
              disabled={!isDirty || saveMutation.isPending}
              className="btn-primary h-9 px-5 text-xs disabled:opacity-40"
            >
              {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              حفظ
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-4">

        {/* Dirty Banner */}
        {isDirty && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3"
          >
            <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
            <p className="text-amber-300 text-sm">لديك تعديلات غير محفوظة — اضغط «حفظ» لتطبيقها.</p>
          </motion.div>
        )}

        {/* ── Maintenance Mode ── */}
        <SettingSection title="حالة النظام" icon={Power} color="text-red-400">
          <SettingRow
            label="وضع الصيانة"
            hint="عند التفعيل، يُمنع الطلاب من الدخول للنظام مؤقتاً"
          >
            <Toggle value={form.maintenanceMode} onChange={v => patch('maintenanceMode', v)} />
          </SettingRow>
          {form.maintenanceMode && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-xs"
            >
              <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
              <span className="text-red-300">النظام في وضع الصيانة حالياً! الطلاب لا يمكنهم تسجيل الدخول.</span>
            </motion.div>
          )}
        </SettingSection>

        {/* ── Withdrawal Fee ── */}
        <SettingSection title="رسوم السحب" icon={Percent} color="text-blue-400">
          <SettingRow label="نوع الرسوم">
            <div className="flex gap-2">
              {['FIXED', 'PERCENTAGE'].map(type => (
                <button
                  key={type}
                  onClick={() => patch('withdrawalFeeType', type)}
                  className={`px-4 py-2 rounded-xl text-xs font-semibold border transition-all ${
                    form.withdrawalFeeType === type
                      ? 'bg-blue-500/20 border-blue-500/50 text-blue-300'
                      : 'border-white/10 text-slate-400 hover:bg-white/5'
                  }`}
                >
                  {type === 'FIXED' ? 'ثابتة (ريال)' : 'نسبة مئوية (%)'}
                </button>
              ))}
            </div>
          </SettingRow>

          <SettingRow
            label={form.withdrawalFeeType === 'FIXED' ? 'قيمة الرسوم (ريال)' : 'نسبة الرسوم (%)'}
            hint={`معاينة: ${feePreview}`}
          >
            <IntInput
              value={form.withdrawalFeeValue}
              onChange={v => patch('withdrawalFeeValue', v)}
              min={0}
              max={form.withdrawalFeeType === 'PERCENTAGE' ? 100 : 1_000_000}
              suffix={form.withdrawalFeeType === 'PERCENTAGE' ? '%' : 'ر.ي'}
            />
          </SettingRow>
        </SettingSection>

        {/* ── Debt Settings ── */}
        <SettingSection title="إعدادات الدين" icon={TrendingDown} color="text-red-400">
          <SettingRow label="السماح بالدين" hint="تمكين عجز الرصيد الناجم عن المصروفات المشتركة">
            <Toggle value={form.allowDebt} onChange={v => patch('allowDebt', v)} />
          </SettingRow>

          {form.allowDebt && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
              <SettingRow
                label="الحد الأقصى للدين (ريال)"
                hint="أقصى دين مسموح به لكل طالب"
              >
                <IntInput
                  value={form.maxDebtPerUser}
                  onChange={v => patch('maxDebtPerUser', v)}
                  min={0}
                  suffix="ر.ي"
                  placeholder="0"
                />
              </SettingRow>
            </motion.div>
          )}
        </SettingSection>

        {/* ── Deposit Expiry ── */}
        <SettingSection title="طلبات الإيداع" icon={Clock} color="text-yellow-400">
          <SettingRow
            label="مدة انتهاء صلاحية الطلب"
            hint="بعد هذه المدة، يُلغى الطلب تلقائياً إذا لم تتم مراجعته"
          >
            <IntInput
              value={form.depositRequestExpiryHours}
              onChange={v => patch('depositRequestExpiryHours', v)}
              min={1}
              max={720}
              suffix="ساعة"
            />
          </SettingRow>
        </SettingSection>

        {/* ── Balance Threshold ── */}
        <SettingSection title="تنبيهات الرصيد" icon={Landmark} color="text-purple-400">
          <SettingRow
            label="حد الرصيد المنخفض (ريال)"
            hint="يصل الطالب إشعاراً عند انخفاض رصيده عن هذا الحد"
          >
            <IntInput
              value={form.lowBalanceThreshold}
              onChange={v => patch('lowBalanceThreshold', v)}
              min={0}
              suffix="ر.ي"
            />
          </SettingRow>
        </SettingSection>

        {/* Current saved values preview */}
        <section className="card-glass p-4">
          <p className="text-slate-400 text-xs font-semibold uppercase tracking-wide mb-3 flex items-center gap-1.5">
            <Info className="w-3.5 h-3.5" /> الإعدادات الحالية المحفوظة
          </p>
          <div className="grid grid-cols-2 gap-2 text-xs">
            {[
              ['رسوم السحب', settings?.withdrawalFeeValue != null ? `${settings.withdrawalFeeValue} (${settings.withdrawalFeeType === 'FIXED' ? 'ثابتة' : 'نسبة'})` : '—'],
              ['الحد الأقصى للدين', settings?.maxDebtPerUser != null ? formatYER(settings.maxDebtPerUser) : '—'],
              ['انتهاء طلب الإيداع', settings?.depositRequestExpiryHours ? `${settings.depositRequestExpiryHours} ساعة` : '—'],
              ['حد الرصيد المنخفض', settings?.lowBalanceThreshold != null ? formatYER(settings.lowBalanceThreshold) : '—'],
            ].map(([k, v]) => (
              <div key={k} className="bg-white/5 rounded-lg p-2.5">
                <p className="text-slate-500 mb-0.5">{k}</p>
                <p className="text-white font-semibold">{v}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="pb-safe" />
      </main>
    </div>
  );
}
