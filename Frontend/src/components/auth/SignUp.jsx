import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { toast } from 'react-toastify';
import axios from 'axios';
import { useAuth } from '../../contexts/AuthContext';
import { Sparkles, Eye, EyeOff } from 'lucide-react';
import GlassBackground from '../common/GlassBackground';

const GlassSignUpPage = () => {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({ username: '', email: '', password: '' });
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const navigate = useNavigate();
  const { setCurrentUser } = useAuth();

  const handleChange = (e) => {
    const { id, value } = e.target;
    setForm(prev => ({ ...prev, [id]: value }));
  };

  const handleSendOTP = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await axios.post(`${import.meta.env.VITE_API_URL}api/auth/send-otp`, form, { timeout: 30000 });
      toast.success(res.data.msg);
      setStep(2);
    } catch (error) {
      if (error.code === 'ECONNABORTED') toast.error('Request timeout.');
      else toast.error(error.response?.data?.msg || 'Failed to send OTP.');
    } finally { setLoading(false); }
  };

  const handleVerifyOTP = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await axios.post(`${import.meta.env.VITE_API_URL}api/auth/verify-otp`, { email: form.email, otp });
      localStorage.setItem("jwtToken", res.data.token);
      localStorage.setItem("currentUser", JSON.stringify(res.data.user));
      setCurrentUser(res.data.user);
      toast.success(res.data.msg);
      navigate('/');
      location.reload();
    } catch (error) {
      toast.error(error.response?.data?.msg || 'Invalid OTP.');
    } finally { setLoading(false); }
  };

  const handleResendOTP = async () => {
    setLoading(true);
    try {
      await axios.post(`${import.meta.env.VITE_API_URL}api/auth/send-otp`, form);
      toast.success('OTP resent!');
    } catch { toast.error('Failed to resend OTP.'); }
    finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative">
      <GlassBackground />
      <Link to="/">
        <button className="absolute top-3 left-3 glass-button px-4 py-2 font-semibold rounded-xl cursor-pointer z-50 text-sm"
          style={{ color: 'hsl(var(--primary))' }}>← Home</button>
      </Link>
      <div className="w-full max-w-md glass-panel-strong overflow-hidden relative z-10">
        <div className="p-8">
          <div className="text-center mb-8">
            <img src="/tortrose-logo.svg" alt="Tortrose" className="h-12 mx-auto mb-4" />
            <div className="tag-pill mx-auto w-fit mb-4"><Sparkles size={12} /> {step === 1 ? 'Create Account' : 'Verify Email'}</div>
            <h2 className="text-2xl font-extrabold tracking-tight mb-2" style={{ color: 'hsl(var(--foreground))' }}>
              {step === 1 ? 'Sign Up' : 'Enter OTP'}
            </h2>
            <p style={{ color: 'hsl(var(--muted-foreground))' }}>
              {step === 1 ? 'Join our community today' : 'Check your email for the code'}
            </p>
          </div>

          {step === 1 ? (
            <form onSubmit={handleSendOTP}>
              <div className="space-y-4">
                <div>
                  <label htmlFor="username" className="block text-sm font-medium mb-1">Username</label>
                  <input id="username" type="text" value={form.username} onChange={handleChange}
                    className="glass-input" placeholder="johndoe" required disabled={loading} />
                </div>
                <div>
                  <label htmlFor="email" className="block text-sm font-medium mb-1">Email Address</label>
                  <input id="email" type="email" value={form.email} onChange={handleChange}
                    className="glass-input" placeholder="john@example.com" required disabled={loading} />
                </div>
                <div>
                  <label htmlFor="password" className="block text-sm font-medium mb-1">Password</label>
                  <div className="relative flex items-center">
                    <input id="password" type={showPassword ? 'text' : 'password'} value={form.password} onChange={handleChange}
                      className="glass-input pr-10" placeholder="••••••••" required disabled={loading} />
                    <button type="button" onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 flex items-center justify-center transition-colors cursor-pointer" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>
              </div>
              <button type="submit" disabled={loading}
                className="w-full mt-8 py-3 px-4 rounded-xl font-semibold glow-soft hover:-translate-y-0.5 transition-all disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }}>
                {loading ? 'Sending OTP...' : 'Send OTP'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleVerifyOTP}>
              <div className="space-y-4">
                <div className="text-center mb-6">
                  <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>We've sent a code to</p>
                  <p className="font-semibold">{form.email}</p>
                </div>
                <div>
                  <label htmlFor="otp" className="block text-sm font-medium mb-1 text-center">Enter OTP</label>
                  <input id="otp" type="text" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className="glass-input text-center text-2xl font-bold tracking-widest" placeholder="000000" maxLength={6} required disabled={loading} />
                </div>
                <div className="text-center text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  Didn't receive the code?{' '}
                  <button type="button" onClick={handleResendOTP} disabled={loading}
                    className="font-medium underline disabled:opacity-50" style={{ color: 'hsl(var(--primary))' }}>Resend OTP</button>
                </div>
              </div>
              <button type="submit" disabled={loading || otp.length !== 6}
                className="w-full mt-8 py-3 px-4 rounded-xl font-semibold glow-soft hover:-translate-y-0.5 transition-all disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }}>
                {loading ? 'Verifying...' : 'Verify & Sign Up'}
              </button>
              <button type="button" onClick={() => { setStep(1); setOtp(''); }}
                className="w-full mt-4 py-2 px-4 font-medium transition" style={{ color: 'hsl(var(--muted-foreground))' }}>← Back to form</button>
            </form>
          )}

          {step === 1 && (
            <>
              <div className="mt-6">
                <div className="relative">
                  <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-white/15" /></div>
                  <div className="relative flex justify-center text-sm"><span className="px-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Or continue with</span></div>
                </div>
                <div className="mt-6">
                  <button onClick={() => window.location.href = `${import.meta.env.VITE_API_URL}api/auth/google`}
                    type="button" className="w-full flex items-center justify-center gap-3 py-3 px-4 glass-button rounded-xl font-medium text-sm">
                    <svg className="w-5 h-5" viewBox="0 0 24 24">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                    Sign up with Google
                  </button>
                </div>
              </div>
              <div className="mt-8 text-center text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                Already have an account?{' '}
                <button onClick={() => navigate("/login")} className="font-medium underline" style={{ color: 'hsl(var(--primary))' }}>Log in</button>
              </div>
            </>
          )}
        </div>
        <div className="py-4 px-8 border-t border-white/15 text-center">
          <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>By signing up, you agree to our Terms and Privacy Policy</p>
        </div>
      </div>
    </div>
  );
};

export default GlassSignUpPage;
