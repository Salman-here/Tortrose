import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { toast } from 'react-toastify';
import { useAuth } from '../../contexts/AuthContext';
import { Sparkles, Eye, EyeOff } from 'lucide-react';
import GlassBackground from '../common/GlassBackground';

const GlassLoginPage = () => {
  const [form, setForm] = useState({ email: '', password: '', rememberMe: false });
  const [showPassword, setShowPassword] = useState(false);
  const navigate = useNavigate();
  const { login } = useAuth();

  const handleChange = (e) => {
    const { id, value, type, checked } = e.target;
    setForm(prev => ({ ...prev, [id]: type === 'checkbox' ? checked : value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await login({ email: form.email, password: form.password }, () => setForm({ email: '', password: '', rememberMe: false }));
    } catch (error) {
      console.error(error);
      toast.error(error.response?.data?.msg || 'Login failed. Please try again.');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative">
      <GlassBackground />
      <Link to="/">
        <button className="absolute top-3 left-3 glass-button px-4 py-2 font-semibold rounded-xl cursor-pointer z-50 text-sm"
          style={{ color: 'hsl(var(--primary))' }}>
          ← Home
        </button>
      </Link>
      <div className="w-full max-w-md glass-panel-strong overflow-hidden relative z-10">
        <div className="p-8">
          <div className="text-center mb-8">
            <img src="/tortrose-logo.svg" alt="Tortrose" className="h-12 mx-auto mb-4" />
            <div className="tag-pill mx-auto w-fit mb-4"><Sparkles size={12} /> Welcome Back</div>
            <h2 className="text-2xl font-extrabold tracking-tight mb-2" style={{ color: 'hsl(var(--foreground))' }}>Sign In</h2>
            <p style={{ color: 'hsl(var(--muted-foreground))' }}>Continue to your account</p>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="space-y-4">
              <div>
                <label htmlFor="email" className="block text-sm font-medium mb-1" style={{ color: 'hsl(var(--foreground))' }}>Email Address</label>
                <input id="email" type="email" value={form.email} onChange={handleChange}
                  className="glass-input" placeholder="john@example.com" required />
              </div>
              <div>
                <label htmlFor="password" className="block text-sm font-medium mb-1" style={{ color: 'hsl(var(--foreground))' }}>Password</label>
                <div className="relative">
                  <input id="password" type={showPassword ? 'text' : 'password'} value={form.password} onChange={handleChange}
                    className="glass-input" placeholder="•••••••" required />
                  <button type="button" onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between mt-4">
              <label className="flex items-center gap-2 text-sm">
                <input id="rememberMe" type="checkbox" checked={form.rememberMe} onChange={handleChange}
                  className="w-4 h-4 rounded accent-indigo-600" />
                Remember me
              </label>
              <Link to="/forgot-password" className="text-sm font-medium" style={{ color: 'hsl(var(--primary))' }}>Forgot password?</Link>
            </div>

            <button type="submit" className="w-full mt-8 py-3 px-4 rounded-xl font-semibold transition-all glow-soft hover:-translate-y-0.5"
              style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }}>
              Sign In
            </button>
          </form>

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
                Sign in with Google
              </button>
            </div>
          </div>

          <div className="mt-8 text-center text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
            Don't have an account?{' '}
            <button onClick={() => navigate("/signup")} className="font-medium underline" style={{ color: 'hsl(var(--primary))' }}>Sign up</button>
          </div>
        </div>
        <div className="py-4 px-8 border-t border-white/15 text-center">
          <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>By signing in, you agree to our Terms and Privacy Policy</p>
        </div>
      </div>
    </div>
  );
};

export default GlassLoginPage;
