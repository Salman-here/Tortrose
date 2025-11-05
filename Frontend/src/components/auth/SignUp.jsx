import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { toast } from 'react-toastify';
import axios from 'axios';
import { useAuth } from '../../contexts/AuthContext';

const GlassSignUpPage = () => {
  const [step, setStep] = useState(1); // 1: Form, 2: OTP Verification
  const [form, setForm] = useState({
    username: '',
    email: '',
    password: ''
  });
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const navigate = useNavigate();
  const { setCurrentUser } = useAuth();

  const handleChange = (e) => {
    const { id, value } = e.target;
    setForm(prev => ({
      ...prev,
      [id]: value
    }));
  };

  const handleSendOTP = async (e) => {
    e.preventDefault();
    setLoading(true);
    
    try {
      const res = await axios.post(`${import.meta.env.VITE_API_URL}api/auth/send-otp`, form);
      toast.success(res.data.msg);
      setStep(2); // Move to OTP verification step
    } catch (error) {
      console.error(error);
      toast.error(error.response?.data?.msg || 'Failed to send OTP. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOTP = async (e) => {
    e.preventDefault();
    setLoading(true);
    
    try {
      const res = await axios.post(`${import.meta.env.VITE_API_URL}api/auth/verify-otp`, {
        email: form.email,
        otp: otp
      });
      
      console.log('=== SIGNUP RESPONSE ===');
      console.log('Response data:', res.data);
      console.log('Token:', res.data.token);
      console.log('User:', res.data.user);
      
      // Store token and user data (same as login)
      localStorage.setItem("jwtToken", res.data.token);
      localStorage.setItem("currentUser", JSON.stringify(res.data.user));
      setCurrentUser(res.data.user);
      
      console.log('Stored in localStorage:');
      console.log('jwtToken:', localStorage.getItem('jwtToken'));
      console.log('currentUser:', localStorage.getItem('currentUser'));
      
      toast.success(res.data.msg);
      
      // Navigate to home page
      navigate('/');
      location.reload();
    } catch (error) {
      console.error(error);
      toast.error(error.response?.data?.msg || 'Invalid OTP. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleResendOTP = async () => {
    setLoading(true);
    try {
      const res = await axios.post(`${import.meta.env.VITE_API_URL}api/auth/send-otp`, form);
      toast.success('OTP resent successfully!');
    } catch (error) {
      toast.error('Failed to resend OTP. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-sky-50 to-blue-100 p-4">
      <Link to="/">
        <button className="absolute top-3 left-3 bg-white text-green-800 px-3 py-2 font-bold rounded cursor-pointer hover:bg-gray-100 transition-colors z-50">
          Home
        </button>
      </Link>
      <div className="w-full max-w-md bg-white/30 backdrop-blur-lg rounded-2xl shadow-xl overflow-hidden border border-white/50">
        <div className="p-8">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold bg-gradient-to-r from-sky-400 to-blue-500 bg-clip-text text-transparent tracking-wide mb-2">genZ Winners</h1>
            <h2 className="text-2xl font-semibold text-gray-800 mb-2">
              {step === 1 ? 'Create Account' : 'Verify Email'}
            </h2>
            <p className="text-gray-600">
              {step === 1 ? 'Join our community today' : 'Enter the OTP sent to your email'}
            </p>
          </div>
          
          {step === 1 ? (
            // Step 1: Registration Form
            <form onSubmit={handleSendOTP}>
              <div className="space-y-4">
                <div>
                  <label htmlFor="username" className="block text-sm font-medium text-gray-700 mb-1">Username</label>
                  <input
                    id="username"
                    type="text"
                    value={form.username}
                    onChange={handleChange}
                    className="w-full px-4 py-3 bg-white/50 border border-gray-200/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-300/50 text-gray-700 placeholder-gray-400 transition duration-300"
                    placeholder="johndoe"
                    required
                    disabled={loading}
                  />
                </div>
                
                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">Email Address</label>
                  <input
                    id="email"
                    type="email"
                    value={form.email}
                    onChange={handleChange}
                    className="w-full px-4 py-3 bg-white/50 border border-gray-200/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-300/50 text-gray-700 placeholder-gray-400 transition duration-300"
                    placeholder="john@example.com"
                    required
                    disabled={loading}
                  />
                </div>
                
                <div>
                  <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                  <div className="relative">
                    <input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      value={form.password}
                      onChange={handleChange}
                      className="w-full px-4 py-3 bg-white/50 border border-gray-200/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-300/50 text-gray-700 placeholder-gray-400 transition duration-300"
                      placeholder="••••••••"
                      required
                      disabled={loading}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-500 hover:text-gray-700 transition-colors"
                    >
                      {showPassword ? (
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                        </svg>
                      ) : (
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
              </div>
              
              <button
                type="submit"
                disabled={loading}
                className="w-full mt-8 py-3 px-4 bg-sky-500/80 hover:bg-sky-600/80 text-white font-semibold rounded-lg transition duration-300 transform hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-sky-300/50 shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Sending OTP...' : 'Send OTP'}
              </button>
            </form>
          ) : (
            // Step 2: OTP Verification
            <form onSubmit={handleVerifyOTP}>
              <div className="space-y-4">
                <div className="text-center mb-6">
                  <p className="text-sm text-gray-600">
                    We've sent a 6-digit code to
                  </p>
                  <p className="font-semibold text-gray-800">{form.email}</p>
                </div>
                
                <div>
                  <label htmlFor="otp" className="block text-sm font-medium text-gray-700 mb-1 text-center">Enter OTP</label>
                  <input
                    id="otp"
                    type="text"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className="w-full px-4 py-3 bg-white/50 border border-gray-200/50 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-300/50 text-gray-700 text-center text-2xl font-bold tracking-widest placeholder-gray-400 transition duration-300"
                    placeholder="000000"
                    maxLength={6}
                    required
                    disabled={loading}
                  />
                </div>
                
                <div className="text-center text-sm text-gray-600">
                  Didn't receive the code?{' '}
                  <button
                    type="button"
                    onClick={handleResendOTP}
                    disabled={loading}
                    className="font-medium text-sky-600 hover:text-sky-700 underline transition duration-300 disabled:opacity-50"
                  >
                    Resend OTP
                  </button>
                </div>
              </div>
              
              <button
                type="submit"
                disabled={loading || otp.length !== 6}
                className="w-full mt-8 py-3 px-4 bg-sky-500/80 hover:bg-sky-600/80 text-white font-semibold rounded-lg transition duration-300 transform hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-sky-300/50 shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Verifying...' : 'Verify & Sign Up'}
              </button>
              
              <button
                type="button"
                onClick={() => {
                  setStep(1);
                  setOtp('');
                }}
                className="w-full mt-4 py-2 px-4 text-gray-600 hover:text-gray-800 font-medium transition duration-300"
              >
                ← Back to form
              </button>
            </form>
          )}
          
          {step === 1 && (
            <>
              <div className="mt-6">
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-gray-300/30"></div>
                  </div>
                  <div className="relative flex justify-center text-sm">
                    <span className="px-2 bg-transparent text-gray-600">Or continue with</span>
                  </div>
                </div>
                
                <div className="mt-6">
                  <button
                    onClick={() => window.location.href = `${import.meta.env.VITE_API_URL}api/auth/google`}
                    type="button"
                    className="w-full flex items-center justify-center gap-3 py-3 px-4 bg-white/50 hover:bg-white/70 text-gray-700 font-medium rounded-lg transition duration-300 border border-gray-200/50"
                  >
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
              
              <div className="mt-8 text-center text-sm text-gray-600">
                Already have an account?{' '}
                <button 
                  onClick={() => navigate("/login")}
                  className="font-medium text-sky-600 hover:text-sky-700 underline transition duration-300"
                >
                  Log in
                </button>
              </div>
            </>
          )}
        </div>
        
        <div className="py-4 px-8 bg-white/20 border-t border-gray-200/30 text-center">
          <p className="text-xs text-gray-500">By signing up, you agree to our Terms and Privacy Policy</p>
        </div>
      </div>
    </div>
  );
};

export default GlassSignUpPage;
