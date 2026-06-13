import React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { 
  LayoutDashboard, 
  Users, 
  Wallet, 
  Settings, 
  LogOut, 
  ShieldAlert,
  AlertTriangle,
  Receipt,
  Store,
  Banknote,
} from 'lucide-react';
import useAuthStore from '../../store/authStore';

export default function AdminLayout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const navLinks = [
    { name: 'الرئيسية',    path: '/admin/dashboard', icon: LayoutDashboard },
    { name: 'المستخدمون',  path: '/admin/users',     icon: Users },
    { name: 'الإيداعات',   path: '/admin/deposits',  icon: Wallet },
    { name: 'السحوبات',    path: '/admin/withdrawals', icon: Banknote },
    { name: 'النزاعات',    path: '/admin/disputes',  icon: AlertTriangle },
    { name: 'المصروفات',   path: '/admin/expenses',  icon: Receipt },
    { name: 'التجار',      path: '/admin/merchants', icon: Store },
    { name: 'الإعدادات',   path: '/admin/settings',  icon: Settings },
  ];

  return (
    <div className="min-h-dvh bg-surface-dark flex flex-col md:flex-row">
      
      {/* ── Desktop Sidebar (Hidden on Mobile) ── */}
      <aside className="hidden md:flex flex-col w-64 glass-bg border-l border-white/10 sticky top-0 h-screen">
        <div className="p-6 border-b border-white/10 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-500/20 flex items-center justify-center flex-shrink-0">
            <ShieldAlert className="w-5 h-5 text-purple-400" />
          </div>
          <div className="overflow-hidden">
            <h1 className="text-white font-bold text-base truncate">لوحة الإدارة</h1>
            <p className="text-slate-400 text-xs truncate">{user?.fullName}</p>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
          {navLinks.map((link) => {
            const Icon = link.icon;
            return (
              <NavLink
                key={link.path}
                to={link.path}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 text-sm font-medium ${
                    isActive 
                      ? 'bg-accent-500/20 text-accent-400 border border-accent-500/30' 
                      : 'text-slate-400 hover:bg-white/5 hover:text-white border border-transparent'
                  }`
                }
              >
                <Icon className="w-5 h-5 flex-shrink-0" />
                <span>{link.name}</span>
              </NavLink>
            );
          })}
        </nav>

        <div className="p-4 border-t border-white/10">
          <button 
            onClick={handleLogout}
            className="flex items-center gap-3 w-full px-4 py-3 text-red-400 hover:bg-red-500/10 rounded-xl transition-colors text-sm font-medium"
          >
            <LogOut className="w-5 h-5" />
            <span>تسجيل خروج</span>
          </button>
        </div>
      </aside>

      {/* ── Main Content Area ── */}
      <main className="flex-1 flex flex-col min-w-0 pb-20 md:pb-0">
        {/* Mobile Header (Hidden on Desktop) */}
        <header className="md:hidden sticky top-0 z-40 glass-bg border-b border-white/10">
          <div className="px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-purple-500/20 flex items-center justify-center">
                <ShieldAlert className="w-4 h-4 text-purple-400" />
              </div>
              <div>
                <h1 className="text-white font-bold text-sm">لوحة الإدارة</h1>
                <p className="text-slate-400 text-xs">{user?.fullName}</p>
              </div>
            </div>
            <button onClick={handleLogout} className="btn-ghost w-9 h-9 p-0 text-red-400" aria-label="تسجيل خروج">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-x-hidden">
          {/* React Router Outlet renders the active page here */}
          <Outlet />
        </div>
      </main>

      {/* ── Mobile Bottom Navigation (Hidden on Desktop) ── */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 glass-bg border-t border-white/10 pb-safe">
        <div className="flex justify-around items-center h-16">
          {/* Show only 5 most important links on mobile to avoid cramping */}
          {[navLinks[0], navLinks[1], navLinks[2], navLinks[5], navLinks[6]].map((link) => {
            const Icon = link.icon;
            return (
              <NavLink
                key={link.path}
                to={link.path}
                className={({ isActive }) =>
                  `flex flex-col items-center justify-center flex-1 h-full gap-1 transition-colors ${
                    isActive ? 'text-accent-400' : 'text-slate-500 hover:text-slate-300'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon className={`w-5 h-5 ${isActive ? 'animate-bounce-short' : ''}`} />
                    <span className="text-[10px] font-medium">{link.name}</span>
                  </>
                )}
              </NavLink>
            );
          })}
        </div>
      </nav>

    </div>
  );
}
