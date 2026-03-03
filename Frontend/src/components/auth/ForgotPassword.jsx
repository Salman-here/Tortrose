import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Mail, Loader2, KeyRound } from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';
import { Link } from 'react-router-dom';

const ForgotPassword = () => {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    if (!email.trim()) { toast.error('Please enter your email'); return; }
    setLoading(true);
    try {
      const res = await axios.post(`${import.meta.env.VITE_API_URL}api/password/forgot`, { email });
      toast.success(res.data.message || 'Password reset link sent!');
    } catch (err) { toast.error(err.response?.data?.msg || 'Something went wrong'); }
    finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="glass-panel p-8 w-full max-w-md"
      >
        <div className="flex justify-center mb-6">
          <div className="glass-inner p-4 rounded-2xl">
            <KeyRound className="w-10 h-10" style={{ color: 'hsl(var(--primary))' }} />
          </div>
        </div>

        <h2 className="text-2xl font-extrabold text-center tracking-tight mb-2" style={{ color: 'hsl(var(--foreground))' }}>
          Forgot Password
        </h2>
        <p className="text-sm text-center mb-6" style={{ color: 'hsl(var(--muted-foreground))' }}>
          Enter your email and we'll send you a reset link
        </p>

        <form onSubmit={handleForgotPassword} className="space-y-4">
          <div className="relative flex items-center">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter your email"
              className="glass-input pr-10"
            />
            <Mail className="w-5 h-5 absolute right-3" style={{ color: 'hsl(var(--muted-foreground))' }} />
          </div>

          <motion.button
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.97 }}
            disabled={loading}
            type="submit"
            className="w-full py-3 rounded-xl font-semibold text-white flex items-center justify-center gap-2 disabled:opacity-60"
            style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}
          >
            {loading ? <><Loader2 className="w-5 h-5 animate-spin" /> Sending...</> : 'Send Reset Link'}
          </motion.button>
        </form>

        <p className="text-sm text-center mt-6" style={{ color: 'hsl(var(--muted-foreground))' }}>
          Remember your password?{' '}
          <Link to="/login" className="font-medium" style={{ color: 'hsl(var(--primary))' }}>Login</Link>
        </p>
      </motion.div>
    </div>
  );
};

export default ForgotPassword;
