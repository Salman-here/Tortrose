import React, { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Lock, Loader2, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';

const ResetPassword = () => {
  const { token } = useParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const handleReset = async (e) => {
    e.preventDefault();
    if (!password || !confirmPassword) { toast.error('Please fill in all fields'); return; }
    if (password !== confirmPassword) { toast.error('Passwords do not match'); return; }
    setLoading(true);
    try {
      const res = await axios.post(`${import.meta.env.VITE_API_URL}api/password/reset/${token}`, { password });
      toast.success(res.data.msg || 'Password reset successful');
      setTimeout(() => navigate('/login'), 2000);
    } catch (err) { toast.error(err.response?.data?.msg || 'Reset failed'); }
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
            <ShieldCheck className="w-10 h-10" style={{ color: 'hsl(var(--primary))' }} />
          </div>
        </div>

        <h2 className="text-2xl font-extrabold text-center tracking-tight mb-2" style={{ color: 'hsl(var(--foreground))' }}>
          Reset Password
        </h2>
        <p className="text-sm text-center mb-6" style={{ color: 'hsl(var(--muted-foreground))' }}>
          Create a new secure password
        </p>

        <form onSubmit={handleReset} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>New Password</label>
            <div className="relative flex items-center">
              <input type={showPassword ? "text" : "password"} placeholder="New Password" className="glass-input pr-10" value={password} onChange={(e) => setPassword(e.target.value)} />
              <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
                {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Confirm Password</label>
            <div className="relative flex items-center">
              <input type={showConfirm ? "text" : "password"} placeholder="Confirm Password" className="glass-input pr-10" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
              <button type="button" onClick={() => setShowConfirm(!showConfirm)} className="absolute right-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
                {showConfirm ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
              </button>
            </div>
          </div>

          <motion.button
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.97 }}
            disabled={loading}
            type="submit"
            className="w-full py-3 rounded-xl font-semibold text-white flex items-center justify-center gap-2 disabled:opacity-60"
            style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}
          >
            {loading ? <><Loader2 className="w-5 h-5 animate-spin" /> Resetting...</> : 'Reset Password'}
          </motion.button>
        </form>

        <p className="text-sm text-center mt-6" style={{ color: 'hsl(var(--muted-foreground))' }}>
          <Link to="/login" className="font-medium" style={{ color: 'hsl(var(--primary))' }}>Back to Login</Link>
        </p>
      </motion.div>
    </div>
  );
};

export default ResetPassword;
