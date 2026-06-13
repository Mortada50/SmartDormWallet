/**
 * AdminDashboard.jsx — Admin system overview and controls
 *
 * Displays:
 *  - System Treasury Total (إجمالي الخزينة)
 *  - Outstanding Debts (الديون القائمة)
 *  - Pending Deposit count
 *  - Open Disputes count
 *
 * Actions:
 *  - Maintenance mode toggle
 *  - Generate Monthly PDF report
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  Landmark, TrendingDown, Clock, AlertTriangle,
  Download, Settings, Power, Loader2, ArrowLeft,
  Users, RefreshCw, Activity, ShieldAlert
} from 'lucide-react';
import toast from 'react-hot-toast';

import { adminApi } from '../../api/adminApi';
import { QUERY_KEYS } from '../../api/queryKeys';
import { formatYER } from '../../utils/formatters';
import useAuthStore from '../../store/authStore';

// ── Skeleton Loader ────────────────────────────────────────────────────────

function StatsSkeleton() {

  return (
    <div className="grid grid-cols-2 gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="card-glass p-4 animate-pulse">
          <div className="skeleton w-8 h-8 rounded-lg mb-3" />
          <div className="skeleton w-20 h-4 rounded mb-2" />
          <div className="skeleton w-24 h-6 rounded" />
        </div>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Main Component
// ══════════════════════════════════════════════════════════════════════════════

export default function AdminDashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuthStore();
  
  const [isDownloading, setIsDownloading] = useState(false);

  // ── Queries ────────────────────────────────────────────────────────────────

  const { data: statsData, isLoading: isStatsLoading, refetch: refetchStats } = useQuery({
    queryKey: QUERY_KEYS.adminStats(),
    queryFn: () => adminApi.getDashboardStats().then(r => r.data.data),
    staleTime: 60_000,
  });

  const { data: settingsData, isLoading: isSettingsLoading } = useQuery({
    queryKey: QUERY_KEYS.adminSettings(),
    queryFn: () => adminApi.getSettings().then(r => r.data.data),
    staleTime: 60_000,
  });

  // ── Mutations ──────────────────────────────────────────────────────────────

  const toggleMaintenance = useMutation({
    mutationFn: (currentStatus) => adminApi.updateSettings({ maintenanceMode: !currentStatus }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminSettings() });
      toast.success('تم تغيير حالة وضع الصيانة بنجاح');
    },
    onError: () => toast.error('فشل في تحديث إعدادات النظام'),
  });

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleDownloadReport = async () => {
    setIsDownloading(true);
    const loadingId = toast.loading('جاري توليد التقرير المالي...');
    try {
      const res = await adminApi.downloadMonthlyReport();
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      
      // Auto-name file with current month
      const monthStr = new Date().toISOString().slice(0, 7);
      a.download = `smart-dorm-report-${monthStr}.pdf`;
      
      a.click();
      URL.revokeObjectURL(url);
      toast.success('تم تحميل التقرير ✓', { id: loadingId });
    } catch {
      toast.error('تعذر توليد التقرير', { id: loadingId });
    } finally {
      setIsDownloading(false);
    }
  };

  // ── Render Helpers ─────────────────────────────────────────────────────────

  const stats = statsData || {
    totalSystemBalance: 0,
    totalOutstandingDebt: 0,
    pendingDepositCount: 0,
    openDisputeCount: 0,
    activeResidentCount: 0,
  };

  const isMaintenance = settingsData?.maintenanceMode ?? false;
  const isSettingsReady = !isSettingsLoading && settingsData;

  // ───────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-dvh bg-surface-dark">
      
      {/* ── Header ── */}
      <header className="sticky top-0 z-40 glass-bg border-b border-white/10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-purple-500/20 flex items-center justify-center">
              <ShieldAlert className="w-4 h-4 text-purple-400" />
            </div>
            <div>
              <h1 className="text-white font-bold text-sm">لوحة الإدارة</h1>
              <p className="text-slate-400 text-xs text-right">{user?.fullName}</p>
            </div>
          </div>
          <button
            onClick={() => refetchStats()}
            className="btn-ghost w-9 h-9 p-0"
            aria-label="تحديث"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-6">

        {/* ── Warning Bar if Maintenance is ON ── */}
        {isMaintenance && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl p-3 bg-red-500/10 border border-red-500/30 flex items-center gap-3"
          >
            <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0" />
            <p className="text-red-300 text-sm font-medium">
              تنبيه: النظام حالياً في وضع الصيانة، المستخدمون لا يمكنهم الدخول!
            </p>
          </motion.div>
        )}

        {/* ── Stats Grid ── */}
        <section>
          <h2 className="section-heading mb-3 flex items-center gap-2">
            <Activity className="w-5 h-5 text-slate-400" />
            نظرة عامة
          </h2>
          
          {isStatsLoading ? (
            <StatsSkeleton />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:gap-4">
              
              {/* Treasury */}
              <motion.div className="card-glass p-4 relative overflow-hidden" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
                <div className="absolute -right-4 -top-4 w-16 h-16 bg-blue-500/10 rounded-full blur-xl" />
                <Landmark className="w-6 h-6 text-blue-400 mb-2 relative z-10" />
                <p className="text-slate-400 text-xs mb-1">إجمالي الخزينة</p>
                <p className="text-white font-bold text-lg tabular">{formatYER(stats.totalSystemBalance)}</p>
              </motion.div>

              {/* Debt */}
              <motion.div className="card-glass p-4 relative overflow-hidden" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
                <div className="absolute -right-4 -top-4 w-16 h-16 bg-red-500/10 rounded-full blur-xl" />
                <TrendingDown className="w-6 h-6 text-red-400 mb-2 relative z-10" />
                <p className="text-slate-400 text-xs mb-1">ديون متأخرة</p>
                <p className="text-white font-bold text-lg tabular">{formatYER(stats.totalOutstandingDebt)}</p>
              </motion.div>

              {/* Pending Deposits */}
              <motion.button 
                onClick={() => navigate('/admin/deposits')}
                className="card-glass-hover p-4 text-right relative overflow-hidden group" 
                initial={{ opacity: 0, y: 10 }} 
                animate={{ opacity: 1, y: 0 }} 
                transition={{ delay: 0.1 }}
              >
                <div className="flex justify-between items-start mb-2">
                  <Clock className="w-6 h-6 text-yellow-400" />
                  <ArrowLeft className="w-4 h-4 text-slate-500 group-hover:text-white transition-colors" />
                </div>
                <p className="text-slate-400 text-xs mb-1">إيداعات معلقة</p>
                <p className="text-white font-bold text-lg tabular">
                  {stats.pendingDepositCount}
                  {stats.pendingDepositCount > 0 && (
                    <span className="relative flex h-2 w-2 inline-flex mr-2 -top-3">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-yellow-500"></span>
                    </span>
                  )}
                </p>
              </motion.button>

              {/* Open Disputes */}
              <motion.button 
                onClick={() => navigate('/admin/disputes')}
                className="card-glass-hover p-4 text-right relative overflow-hidden group" 
                initial={{ opacity: 0, y: 10 }} 
                animate={{ opacity: 1, y: 0 }} 
                transition={{ delay: 0.15 }}
              >
                <div className="flex justify-between items-start mb-2">
                  <AlertTriangle className="w-6 h-6 text-orange-400" />
                  <ArrowLeft className="w-4 h-4 text-slate-500 group-hover:text-white transition-colors" />
                </div>
                <p className="text-slate-400 text-xs mb-1">نزاعات نشطة</p>
                <p className="text-white font-bold text-lg tabular">
                  {stats.openDisputeCount}
                </p>
              </motion.button>
              
            </div>
          )}
        </section>

        {/* ── System Controls ── */}
        <section>
          <h2 className="section-heading mb-3 flex items-center gap-2">
            <Settings className="w-5 h-5 text-slate-400" />
            تحكم النظام
          </h2>
          
          <div className="card-glass p-1 divide-y divide-white/5">
            
            {/* Generate Report */}
            <div className="p-4 flex items-center justify-between">
              <div>
                <p className="text-white font-medium text-sm">التقرير المالي الشهري</p>
                <p className="text-slate-500 text-xs mt-0.5">توليد تقرير PDF شامل لحركة الخزينة والديون</p>
              </div>
              <button 
                onClick={handleDownloadReport}
                disabled={isDownloading}
                className="btn-secondary h-10 px-4 text-xs font-semibold"
              >
                {isDownloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                تحميل
              </button>
            </div>

            {/* Maintenance Mode */}
            {isSettingsReady && (
              <div className="p-4 flex items-center justify-between">
                <div>
                  <p className="text-white font-medium text-sm">وضع الصيانة</p>
                  <p className="text-slate-500 text-xs mt-0.5">منع دخول الطلاب للنظام مؤقتاً لإجراء تحديثات</p>
                </div>
                
                <button
                  onClick={() => toggleMaintenance.mutate(isMaintenance)}
                  disabled={toggleMaintenance.isPending}
                  className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-yellow-500/50 ${
                    isMaintenance ? 'bg-red-500' : 'bg-slate-600'
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                      isMaintenance ? '-translate-x-6' : '-translate-x-1'
                    }`}
                  />
                </button>
              </div>
            )}
            
          </div>
        </section>

        <div className="pb-safe" />
      </main>
    </div>
  );
}
