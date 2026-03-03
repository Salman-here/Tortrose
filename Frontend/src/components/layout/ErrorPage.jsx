import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, RefreshCw, Home, Mail, X, ChevronDown, ChevronUp } from 'lucide-react';

const ErrorPage = ({ errorCode = 404, errorMessage = "Page not found", description = "" }) => {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <motion.div
        className="glass-panel p-6 md:p-8 w-full max-w-md"
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4 }}
      >
        <motion.div className="flex justify-center mb-6" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 200 }}>
          <div className="glass-inner p-4 rounded-full" style={{ color: 'hsl(0, 72%, 55%)' }}>
            <AlertTriangle className="h-16 w-16" />
          </div>
        </motion.div>

        <h1 className="text-7xl font-extrabold text-center mb-2" style={{ color: 'hsl(var(--foreground))' }}>{errorCode}</h1>
        <p className="text-xl text-center mb-2 font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{errorMessage}</p>
        <p className="text-sm text-center mb-8" style={{ color: 'hsl(var(--muted-foreground))' }}>{description}</p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center mb-6">
          <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} onClick={() => window.location.reload()}
            className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-white"
            style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}>
            <RefreshCw size={18} /> Try Again
          </motion.button>
          <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} onClick={() => window.location.href = '/'}
            className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl font-semibold glass-button">
            <Home size={18} /> Go Home
          </motion.button>
        </div>

        <div className="text-center mb-6">
          <button onClick={() => window.location.href = 'mailto:support@example.com'} className="text-sm font-medium flex items-center gap-1 mx-auto" style={{ color: 'hsl(var(--primary))' }}>
            <Mail size={16} /> Contact support
          </button>
        </div>

        <button onClick={() => setShowDetails(!showDetails)} className="w-full flex items-center justify-between p-3 glass-inner rounded-xl text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>
          Technical details {showDetails ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>

        <AnimatePresence>
          {showDetails && (
            <motion.div className="mt-3 glass-inner rounded-xl overflow-hidden" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
              <div className="p-4">
                <div className="flex justify-between items-center mb-3">
                  <h3 className="font-semibold text-sm" style={{ color: 'hsl(var(--foreground))' }}>Error Information</h3>
                  <button onClick={() => setShowDetails(false)} style={{ color: 'hsl(var(--muted-foreground))' }}><X size={16} /></button>
                </div>
                <div className="text-xs space-y-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  <p><span className="font-medium">Error Code:</span> {errorCode}</p>
                  <p><span className="font-medium">Message:</span> {errorMessage}</p>
                  <p><span className="font-medium">Timestamp:</span> {new Date().toLocaleString()}</p>
                  <p><span className="font-medium">Page URL:</span> {window.location.href}</p>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
};

export default ErrorPage;
