import React, { useState, useEffect } from 'react';
import { Download, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    // Check if app is already installed
    if (window.matchMedia('(display-mode: standalone)').matches) {
      return;
    }

    // Check if user dismissed prompt recently
    const dismissed = localStorage.getItem('pwa_prompt_dismissed');
    if (dismissed && Date.now() - parseInt(dismissed) < 7 * 24 * 60 * 60 * 1000) {
      return; // Hide for 7 days if dismissed
    }

    const handler = (e) => {
      // Prevent the mini-infobar from appearing on mobile
      e.preventDefault();
      // Stash the event so it can be triggered later.
      setDeferredPrompt(e);
      // Show the install UI
      setShowPrompt(true);
    };

    window.addEventListener('beforeinstallprompt', handler);

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
    };
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    
    // Show the install prompt
    deferredPrompt.prompt();
    
    // Wait for the user to respond to the prompt
    const { outcome } = await deferredPrompt.userChoice;
    
    // Optionally, send analytics event with outcome of user choice
    console.log(`User response to the install prompt: ${outcome}`);
    
    // We've used the prompt, and can't use it again, throw it away
    setDeferredPrompt(null);
    setShowPrompt(false);
  };

  const handleDismiss = () => {
    setShowPrompt(false);
    localStorage.setItem('pwa_prompt_dismissed', Date.now().toString());
  };

  return (
    <AnimatePresence>
      {showPrompt && (
        <motion.div
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          className="fixed bottom-4 left-4 right-4 md:left-auto md:right-8 md:bottom-8 md:w-96 bg-surface-dark border border-accent-500/20 rounded-2xl shadow-2xl p-4 z-[9999] flex items-start gap-4"
          dir="rtl"
        >
          <div className="w-12 h-12 bg-accent-500/20 rounded-xl flex items-center justify-center shrink-0">
            <Download className="w-6 h-6 text-accent-400" />
          </div>
          <div className="flex-1 pt-1">
            <h4 className="text-white font-bold mb-1 text-sm">تثبيت التطبيق</h4>
            <p className="text-slate-400 text-xs mb-3 leading-relaxed">
              قم بتثبيت المحفظة الذكية على جهازك للوصول السريع وتجربة استخدام أفضل.
            </p>
            <div className="flex gap-2">
              <button 
                onClick={handleInstall}
                className="flex-1 bg-accent-500 hover:bg-accent-400 text-white text-xs font-bold py-2 rounded-lg transition-colors"
              >
                تثبيت الآن
              </button>
              <button 
                onClick={handleDismiss}
                className="px-3 bg-white/5 hover:bg-white/10 text-slate-300 text-xs font-medium py-2 rounded-lg transition-colors"
              >
                لاحقاً
              </button>
            </div>
          </div>
          <button 
            onClick={handleDismiss}
            className="absolute top-2 left-2 p-1 text-slate-500 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
