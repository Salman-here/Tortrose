import React from "react";
import { motion } from "framer-motion";
import { LockKeyhole, ArrowLeft } from "lucide-react";

const Unauthorized = ({ onBack }) => {
  return (
    <div className="flex items-center justify-center min-h-screen p-4">
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="glass-panel p-8 max-w-md text-center"
      >
        <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 0.2, type: "spring", stiffness: 200 }} className="flex justify-center mb-6">
          <div className="glass-inner p-4 rounded-full" style={{ color: 'hsl(0, 72%, 55%)' }}>
            <LockKeyhole className="w-12 h-12" />
          </div>
        </motion.div>

        <h1 className="text-2xl font-extrabold tracking-tight mb-2" style={{ color: 'hsl(var(--foreground))' }}>Unauthorized Access</h1>
        <p className="text-sm mb-6" style={{ color: 'hsl(var(--muted-foreground))' }}>You don't have permission to view this page.</p>

        <motion.button
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.95 }}
          onClick={onBack}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-white mx-auto"
          style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}
        >
          <ArrowLeft className="w-5 h-5" /> Go Back
        </motion.button>
      </motion.div>
    </div>
  );
};

export default Unauthorized;
