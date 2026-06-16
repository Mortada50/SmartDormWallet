/**
 * NotificationCenter.jsx — Centralized resident notifications viewer
 */

import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Bell, Check, ArrowRight, Loader2, Info,
  AlertTriangle, DollarSign, Users, X
} from 'lucide-react';

import { notificationApi } from '../../api/notificationApi';
import { QUERY_KEYS } from '../../api/queryKeys';
import { formatRelative } from '../../utils/formatters';

const TYPE_ICONS = {
  deposit_approved:        { Icon: DollarSign,    color: 'text-green-400',  bg: 'bg-green-500/20' },
  deposit_rejected:        { Icon: AlertTriangle, color: 'text-red-400',    bg: 'bg-red-500/20' },
  withdrawal_approved:     { Icon: DollarSign,    color: 'text-green-400',  bg: 'bg-green-500/20' },
  withdrawal_rejected:     { Icon: AlertTriangle, color: 'text-red-400',    bg: 'bg-red-500/20' },
  shared_expense_added:    { Icon: Users,         color: 'text-blue-400',   bg: 'bg-blue-500/20' },
  merchant_purchase_added: { Icon: DollarSign,    color: 'text-purple-400', bg: 'bg-purple-500/20' },
  low_balance:             { Icon: AlertTriangle, color: 'text-orange-400', bg: 'bg-orange-500/20' },
  debt_approaching_limit:  { Icon: AlertTriangle, color: 'text-red-500',    bg: 'bg-red-500/20' },
  pending_request_expiring:{ Icon: Bell,          color: 'text-yellow-400', bg: 'bg-yellow-500/20' },
  expense_disputed:        { Icon: AlertTriangle, color: 'text-orange-400', bg: 'bg-orange-500/20' },
  TRANSFER_IN:             { Icon: DollarSign,    color: 'text-financial-green-400', bg: 'bg-financial-green-500/20' },
  TRANSFER_OUT:            { Icon: ArrowRight,    color: 'text-blue-400',   bg: 'bg-blue-500/20' },
  DEFAULT:                 { Icon: Info,          color: 'text-slate-400',  bg: 'bg-slate-500/20' },
};

const TYPE_TITLE = {
  deposit_approved:        'تم قبول الإيداع',
  deposit_rejected:        'تم رفض الإيداع',
  withdrawal_approved:     'تم قبول السحب',
  withdrawal_rejected:     'تم رفض السحب',
  shared_expense_added:    'مصروف مشترك جديد',
  merchant_purchase_added: 'مشتريات جديدة',
  low_balance:             'تحذير: رصيد منخفض',
  debt_approaching_limit:  'تحذير: الدين يقترب من الحد',
  pending_request_expiring:'تحذير: طلب معلق وينتهي قريباً',
  expense_disputed:        'نزاع على مصروف',
  TRANSFER_IN:             'تحويل مالي وارد',
  TRANSFER_OUT:            'تحويل مالي صادر',
};

export default function NotificationCenter() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: QUERY_KEYS.notifications(),
    queryFn: () => notificationApi.getMyNotifications().then(r => r.data.data),
  });

  const markReadMutation = useMutation({
    mutationFn: (publicId) => notificationApi.markAsRead(publicId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.notifications() });
      queryClient.invalidateQueries({ queryKey: ['notifications', 'unreadCount'] });
    },
  });

  const notifications = data?.notifications || [];
  const unreadCount = data?.unreadCount || 0;

  const handleMarkAllRead = () => {
    if (unreadCount > 0) {
      markReadMutation.mutate(null);
    }
  };

  const handleNotificationClick = (notif) => {
    if (!notif.isRead) {
      markReadMutation.mutate(notif.publicId);
    }
    // Route based on type
    if (notif.type?.includes('deposit')) navigate('/deposits/history');
    else if (notif.type?.includes('expense') || notif.type?.includes('merchant')) navigate('/expenses');
    else if (notif.type?.includes('TRANSFER')) navigate('/dashboard');
  };

  return (
    <div className="min-h-dvh bg-surface-dark flex flex-col">
      <header className="sticky top-0 z-30 glass-bg border-b border-white/10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate(-1)} className="btn-ghost w-9 h-9 p-0">
              <ArrowRight className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-white font-bold text-base">الإشعارات</h1>
              <p className="text-slate-400 text-xs">
                {unreadCount > 0 ? `لديك ${unreadCount} إشعارات غير مقروءة` : 'لا توجد إشعارات جديدة'}
              </p>
            </div>
          </div>
          {unreadCount > 0 && (
            <button 
              onClick={handleMarkAllRead}
              disabled={markReadMutation.isPending}
              className="btn-ghost h-9 px-3 text-xs gap-1.5 text-slate-300 hover:text-white"
            >
              <Check className="w-4 h-4" /> تأشير كقراءة
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 max-w-2xl mx-auto w-full px-4 py-6">
        {isLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="w-8 h-8 text-slate-500 animate-spin" /></div>
        ) : isError ? (
          <p className="text-red-400 text-center py-10">تعذر تحميل الإشعارات</p>
        ) : notifications.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-4">
              <Bell className="w-8 h-8 text-slate-500" />
            </div>
            <p className="text-slate-300 font-medium text-lg mb-1">لا توجد إشعارات</p>
            <p className="text-slate-500 text-sm">أنت على اطلاع بكل جديد!</p>
          </div>
        ) : (
          <div className="space-y-2">
            <AnimatePresence>
              {notifications.map(notif => {
                const meta = TYPE_ICONS[notif.type] || TYPE_ICONS.DEFAULT;
                return (
                  <motion.button
                    key={notif.publicId}
                    layout
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    onClick={() => handleNotificationClick(notif)}
                    className={`w-full text-right p-4 rounded-xl border transition-all duration-200 flex items-start gap-3 ${
                      notif.isRead 
                        ? 'bg-transparent border-white/5 opacity-70 hover:opacity-100 hover:bg-white/5' 
                        : 'bg-white/5 border-white/10 hover:bg-white/10 shadow-lg'
                    }`}
                  >
                    <div className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center ${meta.bg}`}>
                      <meta.Icon className={`w-5 h-5 ${meta.color}`} />
                    </div>
                    <div className="flex-1 min-w-0 pt-0.5">
                      <div className="flex items-start justify-between mb-1">
                        <p className={`font-bold text-sm truncate ${notif.isRead ? 'text-slate-300' : 'text-white'}`}>
                          {TYPE_TITLE[notif.type] || 'إشعار'}
                        </p>
                        {!notif.isRead && <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 ml-1 mt-1" />}
                      </div>
                      <p className={`text-xs leading-relaxed mb-2 ${notif.isRead ? 'text-slate-500' : 'text-slate-300'}`}>
                        {notif.message}
                      </p>
                      <p className="text-[10px] text-slate-500 font-medium">
                        {formatRelative(notif.createdAt)}
                      </p>
                    </div>
                  </motion.button>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </main>
    </div>
  );
}
