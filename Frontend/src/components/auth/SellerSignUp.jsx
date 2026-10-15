import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { toast } from 'react-toastify';
import axios from 'axios';
import { useAuth } from '../../contexts/AuthContext';
import { Sparkles, Eye, EyeOff, AlertCircle, CheckCircle2, Store, Phone, MapPin, ArrowLeft, ArrowRight, Globe, Instagram, Facebook, Twitter, Youtube, SkipForward, MessageCircle, Edit3 } from 'lucide-react';
import GlassBackground from '../common/GlassBackground';
import PhoneField, { isValidPhone } from '../common/PhoneField';
import LocationAutocomplete from '../common/LocationAutocomplete';
import { motion, AnimatePresence } from 'framer-motion';
import { setCrossDomainCookie } from '../../utils/cookieHelper';
import {
  createTikTokEventId,
  getTikTokTrackingContext,
  trackSellerFormSubmitted,
  trackSellerRegistrationCompleted
} from '../../utils/tiktokPixel';

const SellerSignUp = () => {
  const [step, setStep] = useState(1); // 1: account, 2: business info, 3: store setup, 4: WhatsApp verify, 5: email OTP
  const [form, setForm] = useState({ username: '', email: '', password: '' });
  const [sellerForm, setSellerForm] = useState({ phoneNumber: '', businessName: '', address: '', city: '', state: '', stateCode: '', country: '', countryCode: '' });
  const [storeForm, setStoreForm] = useState({ storeName: '', storeDescription: '', sellerType: 'store', website: '', instagram: '', facebook: '', twitter: '', youtube: '', tiktok: '' });
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // WhatsApp OTP state
  const [whatsappOtp, setWhatsappOtp] = useState('');
  const [whatsappVerified, setWhatsappVerified] = useState(false);
  const [whatsappSending, setWhatsappSending] = useState(false);
  const [whatsappVerifying, setWhatsappVerifying] = useState(false);
  const [whatsappError, setWhatsappError] = useState('');
  const [whatsappCodeSent, setWhatsappCodeSent] = useState(false);
  const [editingNumber, setEditingNumber] = useState(false);
  // Timers
  const [otpCountdown, setOtpCountdown] = useState(0); // 2min countdown
  const [resendCooldown, setResendCooldown] = useState(0); // 30s cooldown
  const countdownRef = useRef(null);
  const resendRef = useRef(null);

  const navigate = useNavigate();
  const { setCurrentUser } = useAuth();

  // Countdown timer effect
  useEffect(() => {
    if (otpCountdown > 0) {
      countdownRef.current = setTimeout(() => setOtpCountdown(otpCountdown - 1), 1000);
      return () => clearTimeout(countdownRef.current);
    }
  }, [otpCountdown]);

  useEffect(() => {
    if (resendCooldown > 0) {
      resendRef.current = setTimeout(() => setResendCooldown(resendCooldown - 1), 1000);
      return () => clearTimeout(resendRef.current);
    }
  }, [resendCooldown]);

  const formatCountdown = (secs) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const handleChange = (e) => {
    const { id, value } = e.target;
    setForm(prev => ({ ...prev, [id]: value }));
    if (error) setError('');
  };

  const handleSellerChange = (e) => {
    const { name, value } = e.target;
    setSellerForm(prev => ({ ...prev, [name]: value }));
    if (error) setError('');
  };

  const handleStoreChange = (e) => {
    const { name, value } = e.target;
    setStoreForm(prev => ({ ...prev, [name]: value }));
    if (error) setError('');
  };

  const handleSendWhatsAppOtp = async () => {
    if (!sellerForm.phoneNumber || !isValidPhone(sellerForm.phoneNumber)) {
      setWhatsappError('Please enter a valid phone number first');
      return;
    }
    setWhatsappSending(true);
    setWhatsappError('');
    try {
      await axios.post(`${import.meta.env.VITE_API_URL}api/seller-whatsapp/send-otp`, { whatsappNumber: sellerForm.phoneNumber });
      setWhatsappCodeSent(true);
      setOtpCountdown(120); // 2 minutes
      setResendCooldown(30); // 30s before resend allowed
      setEditingNumber(false);
    } catch (err) {
      const status = err.response?.status;
      if (status === 503) {
        setWhatsappError('WhatsApp verification is temporarily unavailable. Please try again later.');
      } else if (status === 429) {
        setWhatsappError(err.response?.data?.msg || 'Too many attempts. Please try again later.');
      } else if (status === 409) {
        setWhatsappError(err.response?.data?.msg || 'This number is already associated with an existing seller account.');
      } else {
        setWhatsappError(err.response?.data?.message || err.response?.data?.msg || 'Failed to send verification code');
      }
    } finally {
      setWhatsappSending(false);
    }
  };

  const handleVerifyWhatsApp = async () => {
    setWhatsappVerifying(true);
    setWhatsappError('');
    try {
      await axios.post(`${import.meta.env.VITE_API_URL}api/seller-whatsapp/verify-otp`, { whatsappNumber: sellerForm.phoneNumber, otp: whatsappOtp });
      setWhatsappVerified(true);
      setWhatsappCodeSent(false);
      setWhatsappOtp('');
      setOtpCountdown(0);
    } catch (err) {
      setWhatsappError(err.response?.data?.message || err.response?.data?.msg || 'Invalid code. Please try again.');
    } finally {
      setWhatsappVerifying(false);
    }
  };

  const handleStep1Next = (e) => {
    e.preventDefault();
    if (!form.username || !form.email || !form.password) { setError('Please fill in all fields'); return; }
    if (form.password.length < 6) { setError('Password must be at least 6 characters'); return; }
    setError(''); setStep(2);
  };

  const handleStep2Next = (e) => {
    e.preventDefault();
    if (!sellerForm.phoneNumber || !isValidPhone(sellerForm.phoneNumber)) { setError('Please enter a valid phone number (select your country and enter the number)'); return; }
    if (!sellerForm.address || sellerForm.address.trim().length < 5) { setError('Please enter a valid address'); return; }
    if (!sellerForm.country || !sellerForm.countryCode) { setError('Please select your country from the list'); return; }
    if (!sellerForm.city || sellerForm.city.trim().length < 2) { setError('Please select your city from the list'); return; }
    trackSellerFormSubmitted('seller_details');
    setError(''); setStep(3);
  };

  const handleStep3Next = async (skipStore = false) => {
    if (!skipStore && storeForm.storeName && storeForm.storeName.trim().length < 3) {
      setError('Store name must be at least 3 characters'); return;
    }
    setError('');
    // Go to WhatsApp verification step
    setStep(4);
  };

  const handleWhatsAppVerifiedNext = async () => {
    // After WhatsApp verified, send email OTP and go to step 5
    setLoading(true); setError(''); setSuccess('');
    try {
      const res = await axios.post(`${import.meta.env.VITE_API_URL}api/auth/seller/send-otp`, {
        ...form, ...sellerForm
      }, { timeout: 30000 });
      setSuccess(res.data.msg || 'OTP sent successfully!');
      setStep(5);
    } catch (error) {
      if (error.code === 'ECONNABORTED') setError('Request timed out. Please try again.');
      else setError(error.response?.data?.msg || 'Failed to send OTP. Please try again.');
    } finally { setLoading(false); }
  };

  const handleVerifyOTP = async (e) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const socialLinks = {};
      if (storeForm.website) socialLinks.website = storeForm.website;
      if (storeForm.instagram) socialLinks.instagram = storeForm.instagram;
      if (storeForm.facebook) socialLinks.facebook = storeForm.facebook;
      if (storeForm.twitter) socialLinks.twitter = storeForm.twitter;
      if (storeForm.youtube) socialLinks.youtube = storeForm.youtube;
      if (storeForm.tiktok) socialLinks.tiktok = storeForm.tiktok;
      const tiktokEventId = createTikTokEventId('seller_registration');

      const res = await axios.post(`${import.meta.env.VITE_API_URL}api/auth/seller/verify-otp`, {
        email: form.email, otp, ...sellerForm,
        whatsappNumber: sellerForm.phoneNumber,
        whatsappVerified: true,
        storeName: storeForm.storeName?.trim() || '',
        storeDescription: storeForm.storeDescription?.trim() || '',
        sellerType: storeForm.sellerType || 'store',
        socialLinks: Object.keys(socialLinks).length > 0 ? socialLinks : undefined,
        tracking: {
          ...getTikTokTrackingContext(),
          tiktokCompleteRegistrationEventId: tiktokEventId,
        },
      });
      localStorage.setItem("jwtToken", res.data.token);
      localStorage.setItem("currentUser", JSON.stringify(res.data.user));
      setCrossDomainCookie('rozare_jwt_token', res.data.token, 30);
      setCurrentUser(res.data.user);
      await trackSellerRegistrationCompleted({
        user: res.data.user,
        storeName: storeForm.storeName?.trim(),
        email: form.email,
        phone: sellerForm.phoneNumber,
        eventId: tiktokEventId,
      }).catch(() => {});
      toast.success('Seller account created successfully!');
      navigate('/seller-dashboard/store-overview');
      location.reload();
    } catch (error) {
      setError(error.response?.data?.msg || 'Invalid OTP. Please check and try again.');
    } finally { setLoading(false); }
  };

  const handleResendOTP = async () => {
    setLoading(true); setError(''); setSuccess('');
    try {
      await axios.post(`${import.meta.env.VITE_API_URL}api/auth/seller/send-otp`, { ...form, ...sellerForm });
      setSuccess('OTP resent successfully!');
    } catch { setError('Failed to resend OTP.'); }
    finally { setLoading(false); }
  };

  const alertVariants = { initial: { opacity: 0, y: -8, scale: 0.95 }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0, y: -8, scale: 0.95 } };
  const stepTitles = ['Create Account', 'Business Details', 'Store Setup', 'Verify WhatsApp', 'Verify Email'];
  const stepDescriptions = ['Set up your seller credentials', 'Tell us about your business', 'Set up your store (optional)', 'Verify your WhatsApp number', 'Check your email for the code'];

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative">
      <GlassBackground />
      <Link to="/"><button className="absolute top-3 left-3 glass-button px-4 py-2 font-semibold rounded-xl cursor-pointer z-50 text-sm" style={{ color: 'hsl(var(--primary))' }}>← Home</button></Link>
      <div className="w-full max-w-md glass-panel-strong overflow-hidden relative z-10">
        <div className="p-8">
          <div className="text-center mb-6">
            <img src="/rozare-logo.svg" alt="Rozare" className="h-12 mx-auto mb-4" />
            <div className="tag-pill mx-auto w-fit mb-4"><Store size={12} /> Seller Registration</div>
            <h2 className="text-2xl font-extrabold tracking-tight mb-2" style={{ color: 'hsl(var(--foreground))' }}>{stepTitles[step - 1]}</h2>
            <p style={{ color: 'hsl(var(--muted-foreground))' }}>{stepDescriptions[step - 1]}</p>
          </div>

          {/* Step indicators */}
          <div className="flex items-center justify-center gap-1 mb-6">
            {[1, 2, 3, 4, 5].map(s => (
              <div key={s} className="flex items-center gap-1">
                <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-all"
                  style={{ background: step >= s ? 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))' : 'hsl(var(--muted))', color: step >= s ? 'white' : 'hsl(var(--muted-foreground))' }}>
                  {step > s ? '✓' : s}
                </div>
                {s < 5 && <div className="w-4 h-0.5 rounded" style={{ background: step > s ? 'hsl(var(--primary))' : 'hsl(var(--muted))' }} />}
              </div>
            ))}
          </div>

          {/* Alerts */}
          <AnimatePresence mode="wait">
            {error && (
              <motion.div key="error" variants={alertVariants} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.25 }}
                className="mb-5 flex items-start gap-3 p-3.5 rounded-xl border" style={{ background: 'hsla(0, 70%, 50%, 0.08)', borderColor: 'hsla(0, 70%, 50%, 0.25)' }}>
                <AlertCircle size={18} className="shrink-0 mt-0.5" style={{ color: 'hsl(0, 70%, 55%)' }} />
                <p className="text-sm font-medium" style={{ color: 'hsl(0, 70%, 60%)' }}>{error}</p>
              </motion.div>
            )}
            {success && !error && (
              <motion.div key="success" variants={alertVariants} initial="initial" animate="animate" exit="exit" transition={{ duration: 0.25 }}
                className="mb-5 flex items-start gap-3 p-3.5 rounded-xl border" style={{ background: 'hsla(142, 70%, 45%, 0.08)', borderColor: 'hsla(142, 70%, 45%, 0.25)' }}>
                <CheckCircle2 size={18} className="shrink-0 mt-0.5" style={{ color: 'hsl(142, 70%, 45%)' }} />
                <p className="text-sm font-medium" style={{ color: 'hsl(142, 70%, 50%)' }}>{success}</p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Step 1: Account Info */}
          {step === 1 && (
            <form onSubmit={handleStep1Next}>
              <div className="space-y-4">
                <div>
                  <label htmlFor="username" className="block text-sm font-medium mb-1">Username</label>
                  <input id="username" type="text" value={form.username} onChange={handleChange} className="glass-input" placeholder="johndoe" required disabled={loading} />
                </div>
                <div>
                  <label htmlFor="email" className="block text-sm font-medium mb-1">Email Address</label>
                  <input id="email" type="email" value={form.email} onChange={handleChange} className="glass-input" placeholder="john@example.com" required disabled={loading} />
                </div>
                <div>
                  <label htmlFor="password" className="block text-sm font-medium mb-1">Password</label>
                  <div className="relative flex items-center">
                    <input id="password" type={showPassword ? 'text' : 'password'} value={form.password} onChange={handleChange} className="glass-input pr-10" placeholder="••••••••" required disabled={loading} />
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 flex items-center justify-center transition-colors cursor-pointer" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>
              </div>
              <button type="submit" className="w-full mt-8 py-3 px-4 rounded-xl font-semibold glow-soft hover:-translate-y-0.5 transition-all flex items-center justify-center gap-2"
                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }}>
                Next <ArrowRight size={18} />
              </button>
            </form>
          )}

          {/* Step 2: Business Info */}
          {step === 2 && (
            <form onSubmit={handleStep2Next}>
              <div className="space-y-4">
                <div>
                  <label className="flex text-sm font-medium mb-1 items-center gap-2"><Phone size={14} style={{ color: 'hsl(var(--primary))' }} /> WhatsApp Number <span style={{ color: 'hsl(0, 72%, 55%)' }}>*</span></label>
                  <PhoneField
                    name="phoneNumber"
                    value={sellerForm.phoneNumber}
                    onChange={(v) => { setSellerForm((prev) => ({ ...prev, phoneNumber: v || '' })); if (whatsappVerified) { setWhatsappVerified(false); setWhatsappCodeSent(false); setWhatsappOtp(''); } }}
                    profileCountry={sellerForm.country}
                    disabled={loading}
                    required
                    placeholder="WhatsApp number"
                  />
                  <p className="text-[11px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>We'll send order notifications on this number. You'll verify it in a later step.</p>
                </div>
                <div>
                  <label className="flex text-sm font-medium mb-1 items-center gap-2"><Store size={14} style={{ color: 'hsl(var(--primary))' }} /> Business Name (Optional)</label>
                  <input type="text" name="businessName" value={sellerForm.businessName} onChange={handleSellerChange} className="glass-input" placeholder="Your business or brand name" disabled={loading} maxLength={100} />
                </div>
                <div>
                  <label className="flex text-sm font-medium mb-1 items-center gap-2"><MapPin size={14} style={{ color: 'hsl(var(--primary))' }} /> Address <span style={{ color: 'hsl(0, 72%, 55%)' }}>*</span></label>
                  <input type="text" name="address" value={sellerForm.address} onChange={handleSellerChange} className="glass-input" placeholder="Street address" required disabled={loading} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <LocationAutocomplete
                    type="country"
                    label="Country"
                    value={sellerForm.country}
                    code={sellerForm.countryCode}
                    placeholder="Select country"
                    disabled={loading}
                    required
                    onSelect={(option) => {
                      setSellerForm(prev => ({
                        ...prev,
                        country: option.name,
                        countryCode: option.isoCode,
                        state: '',
                        stateCode: '',
                        city: '',
                      }));
                      if (error) setError('');
                    }}
                    onClear={() => setSellerForm(prev => ({ ...prev, country: '', countryCode: '', state: '', stateCode: '', city: '' }))}
                  />
                  <LocationAutocomplete
                    type="state"
                    label="State/Province"
                    value={sellerForm.state}
                    code={sellerForm.stateCode}
                    countryCode={sellerForm.countryCode}
                    countryName={sellerForm.country}
                    placeholder="Select state"
                    disabled={loading || (!sellerForm.country && !sellerForm.countryCode)}
                    onSelect={(option) => {
                      setSellerForm(prev => ({ ...prev, state: option.name, stateCode: option.isoCode, city: '' }));
                      if (error) setError('');
                    }}
                    onClear={() => setSellerForm(prev => ({ ...prev, state: '', stateCode: '', city: '' }))}
                  />
                </div>
                <LocationAutocomplete
                  type="city"
                  label="City"
                  value={sellerForm.city}
                  code={sellerForm.stateCode}
                  countryCode={sellerForm.countryCode}
                  countryName={sellerForm.country}
                  stateCode={sellerForm.stateCode}
                  stateName={sellerForm.state}
                  placeholder="Select city"
                  disabled={loading || (!sellerForm.country && !sellerForm.countryCode)}
                  required
                  onSelect={(option) => {
                    setSellerForm(prev => ({
                      ...prev,
                      city: option.name,
                      stateCode: prev.stateCode || option.stateCode || '',
                    }));
                    if (error) setError('');
                  }}
                  onClear={() => setSellerForm(prev => ({ ...prev, city: '' }))}
                />
              </div>
              <div className="flex gap-3 mt-8">
                <button type="button" onClick={() => { setStep(1); setError(''); }} className="flex-1 py-3 px-4 rounded-xl font-semibold glass-button flex items-center justify-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                  <ArrowLeft size={18} /> Back
                </button>
                <button type="submit" className="flex-1 py-3 px-4 rounded-xl font-semibold glow-soft hover:-translate-y-0.5 transition-all flex items-center justify-center gap-2"
                  style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }}>
                  Next <ArrowRight size={18} />
                </button>
              </div>
            </form>
          )}

          {/* Step 3: Store Setup */}
          {step === 3 && (
            <div>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-2">Are you registering a Store or a Brand?</label>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { value: 'store', label: 'Store', desc: 'Independent shop / reseller', Icon: Store },
                      { value: 'brand', label: 'Brand', desc: 'Own products / label', Icon: Sparkles },
                    ].map(opt => {
                      const active = storeForm.sellerType === opt.value;
                      const Icon = opt.Icon;
                      return (
                        <button key={opt.value} type="button" onClick={() => setStoreForm(prev => ({ ...prev, sellerType: opt.value }))}
                          className="p-3 rounded-xl text-left transition-all border"
                          style={{ background: active ? 'linear-gradient(135deg, hsl(220, 70%, 55%, 0.15), hsl(260, 60%, 60%, 0.15))' : 'hsla(0,0%,100%,0.04)', borderColor: active ? 'hsl(220, 70%, 55%)' : 'hsla(0,0%,100%,0.12)' }}>
                          <div className="flex items-center gap-2 font-bold text-sm" style={{ color: active ? 'hsl(220, 70%, 55%)' : 'hsl(var(--foreground))' }}>
                            <Icon size={14} /> {opt.label}
                          </div>
                          <p className="text-[11px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>{opt.desc}</p>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <label className="flex text-sm font-medium mb-1 items-center gap-2"><Store size={14} style={{ color: 'hsl(var(--primary))' }} /> {storeForm.sellerType === 'brand' ? 'Brand' : 'Store'} Name <span className="text-xs font-normal" style={{ color: 'hsl(var(--muted-foreground))' }}>(recommended)</span></label>
                  <input type="text" name="storeName" value={storeForm.storeName} onChange={handleStoreChange} className="glass-input" placeholder={storeForm.sellerType === 'brand' ? 'My Awesome Brand' : 'My Awesome Store'} disabled={loading} maxLength={50} />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Store Description <span className="text-xs font-normal" style={{ color: 'hsl(var(--muted-foreground))' }}>(optional)</span></label>
                  <textarea name="storeDescription" value={storeForm.storeDescription} onChange={handleStoreChange} className="glass-input" placeholder="Tell customers about your store..." disabled={loading} maxLength={500} rows={2} style={{ resize: 'none' }} />
                </div>
                <div>
                  <label className="flex text-sm font-medium mb-1 items-center gap-2"><Globe size={14} style={{ color: 'hsl(var(--primary))' }} /> Website <span className="text-xs font-normal" style={{ color: 'hsl(var(--muted-foreground))' }}>(optional)</span></label>
                  <input type="text" name="website" value={storeForm.website} onChange={handleStoreChange} className="glass-input" placeholder="yourwebsite.com or full link" disabled={loading} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="flex text-xs font-medium mb-1 items-center gap-1"><Instagram size={12} /> Instagram</label>
                    <input type="text" name="instagram" value={storeForm.instagram} onChange={handleStoreChange} className="glass-input text-sm" placeholder="@handle or full link" disabled={loading} />
                  </div>
                  <div>
                    <label className="flex text-xs font-medium mb-1 items-center gap-1"><Facebook size={12} /> Facebook</label>
                    <input type="text" name="facebook" value={storeForm.facebook} onChange={handleStoreChange} className="glass-input text-sm" placeholder="page name or full link" disabled={loading} />
                  </div>
                  <div>
                    <label className="flex text-xs font-medium mb-1 items-center gap-1"><Twitter size={12} /> Twitter / X</label>
                    <input type="text" name="twitter" value={storeForm.twitter} onChange={handleStoreChange} className="glass-input text-sm" placeholder="@handle or full link" disabled={loading} />
                  </div>
                  <div>
                    <label className="flex text-xs font-medium mb-1 items-center gap-1"><Youtube size={12} /> YouTube</label>
                    <input type="text" name="youtube" value={storeForm.youtube} onChange={handleStoreChange} className="glass-input text-sm" placeholder="@channel or full link" disabled={loading} />
                  </div>
                  <div>
                    <label className="flex text-xs font-medium mb-1 items-center gap-1">TikTok</label>
                    <input type="text" name="tiktok" value={storeForm.tiktok} onChange={handleStoreChange} className="glass-input text-sm" placeholder="@handle or full link" disabled={loading} />
                  </div>
                </div>
              </div>
              <div className="flex gap-3 mt-8">
                <button type="button" onClick={() => { setStep(2); setError(''); }} className="flex-1 py-3 px-4 rounded-xl font-semibold glass-button flex items-center justify-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                  <ArrowLeft size={18} /> Back
                </button>
                <button type="button" onClick={() => handleStep3Next(false)} disabled={loading}
                  className="flex-1 py-3 px-4 rounded-xl font-semibold glow-soft hover:-translate-y-0.5 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                  style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }}>
                  {loading ? 'Loading...' : <><span>Next</span> <ArrowRight size={18} /></>}
                </button>
              </div>
              <button type="button" onClick={() => handleStep3Next(true)} disabled={loading}
                className="w-full mt-3 py-2 px-4 text-sm font-medium transition flex items-center justify-center gap-2 rounded-xl glass-button"
                style={{ color: 'hsl(var(--muted-foreground))' }}>
                <SkipForward size={14} /> Skip — I'll set up my store later
              </button>
            </div>
          )}

          {/* Step 4: WhatsApp Verification (MANDATORY) */}
          {step === 4 && (
            <div>
              <div className="text-center mb-4">
                <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-3"
                  style={{ background: 'linear-gradient(135deg, hsl(150, 70%, 40%), hsl(170, 70%, 38%))', color: '#fff' }}>
                  <MessageCircle size={28} />
                </div>
                <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  Verify your WhatsApp number to complete registration
                </p>
              </div>

              {/* Show number with edit */}
              <div className="p-4 rounded-xl mb-4" style={{ background: 'hsla(220, 70%, 55%, 0.06)', border: '1px solid hsla(220, 70%, 55%, 0.15)' }}>
                {editingNumber ? (
                  <div className="space-y-2">
                    <label className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>Edit WhatsApp Number</label>
                    <PhoneField
                      value={sellerForm.phoneNumber}
                      onChange={(v) => { setSellerForm(prev => ({ ...prev, phoneNumber: v || '' })); setWhatsappVerified(false); setWhatsappCodeSent(false); setWhatsappOtp(''); setOtpCountdown(0); }}
                      profileCountry={sellerForm.country}
                      placeholder="WhatsApp number"
                    />
                    <button type="button" onClick={() => setEditingNumber(false)}
                      className="w-full py-2 rounded-lg text-xs font-medium glass-inner" style={{ color: 'hsl(var(--foreground))' }}>
                      Done
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>WhatsApp Number</p>
                      <p className="text-lg font-bold" style={{ color: 'hsl(var(--foreground))' }}>{sellerForm.phoneNumber || '—'}</p>
                    </div>
                    <button type="button" onClick={() => { setEditingNumber(true); setWhatsappCodeSent(false); setWhatsappOtp(''); setOtpCountdown(0); setWhatsappError(''); }}
                      className="px-3 py-1.5 rounded-lg text-xs font-bold inline-flex items-center gap-1.5 glass-inner"
                      style={{ color: 'hsl(var(--primary))' }}>
                      <Edit3 size={12} /> Edit
                    </button>
                  </div>
                )}
              </div>

              {whatsappVerified ? (
                /* Verified state */
                <div className="text-center">
                  <div className="p-4 rounded-xl mb-4" style={{ background: 'hsla(150, 70%, 40%, 0.08)', border: '1px solid hsla(150, 70%, 40%, 0.2)' }}>
                    <CheckCircle2 size={32} className="mx-auto mb-2" style={{ color: 'hsl(150, 70%, 40%)' }} />
                    <p className="text-sm font-bold" style={{ color: 'hsl(150, 70%, 40%)' }}>WhatsApp Verified!</p>
                  </div>
                  <button type="button" onClick={handleWhatsAppVerifiedNext} disabled={loading}
                    className="w-full py-3 px-4 rounded-xl font-semibold glow-soft hover:-translate-y-0.5 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                    style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }}>
                    {loading ? 'Sending Email OTP...' : <><span>Continue</span> <ArrowRight size={18} /></>}
                  </button>
                </div>
              ) : whatsappCodeSent ? (
                /* OTP entry state */
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium mb-1.5 text-center" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      Enter the 6-digit code sent to your WhatsApp
                    </label>
                    <input type="text" value={whatsappOtp} onChange={(e) => { setWhatsappOtp(e.target.value.replace(/\D/g, '').slice(0, 6)); setWhatsappError(''); }}
                      className="glass-input text-center text-2xl font-bold tracking-widest" placeholder="000000" maxLength={6} />
                  </div>

                  {/* Countdown timer */}
                  {otpCountdown > 0 && (
                    <div className="text-center">
                      <p className="text-xs" style={{ color: otpCountdown <= 30 ? 'hsl(0, 72%, 55%)' : 'hsl(var(--muted-foreground))' }}>
                        Code expires in <span className="font-bold">{formatCountdown(otpCountdown)}</span>
                      </p>
                    </div>
                  )}
                  {otpCountdown === 0 && whatsappCodeSent && (
                    <div className="text-center">
                      <p className="text-xs font-medium" style={{ color: 'hsl(0, 72%, 55%)' }}>Code expired. Please request a new one.</p>
                    </div>
                  )}

                  {whatsappError && <p className="text-xs text-center" style={{ color: 'hsl(0, 72%, 55%)' }}>{whatsappError}</p>}

                  <button type="button" onClick={handleVerifyWhatsApp} disabled={whatsappVerifying || whatsappOtp.length !== 6 || otpCountdown === 0}
                    className="w-full py-3 rounded-xl text-sm font-bold text-white disabled:opacity-50 inline-flex items-center justify-center gap-2"
                    style={{ background: 'hsl(150, 70%, 40%)' }}>
                    {whatsappVerifying ? 'Verifying...' : <><CheckCircle2 size={16} /> Verify Code</>}
                  </button>

                  {/* Resend */}
                  <div className="text-center">
                    {resendCooldown > 0 ? (
                      <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        Resend available in <span className="font-bold">{resendCooldown}s</span>
                      </p>
                    ) : (
                      <button type="button" onClick={handleSendWhatsAppOtp} disabled={whatsappSending}
                        className="text-xs font-medium underline disabled:opacity-50" style={{ color: 'hsl(var(--primary))' }}>
                        {whatsappSending ? 'Sending...' : 'Resend Code'}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                /* Initial state — send code button */
                <div className="space-y-3">
                  <button type="button" onClick={handleSendWhatsAppOtp}
                    disabled={whatsappSending || !sellerForm.phoneNumber || !isValidPhone(sellerForm.phoneNumber)}
                    className="w-full py-3 rounded-xl text-sm font-bold text-white disabled:opacity-50 inline-flex items-center justify-center gap-2"
                    style={{ background: 'linear-gradient(135deg, hsl(150, 70%, 40%), hsl(170, 70%, 38%))' }}>
                    <MessageCircle size={16} /> {whatsappSending ? 'Sending...' : 'Send Verification Code'}
                  </button>
                  {whatsappError && <p className="text-xs text-center" style={{ color: 'hsl(0, 72%, 55%)' }}>{whatsappError}</p>}
                </div>
              )}

              <button type="button" onClick={() => { setStep(3); setError(''); setWhatsappError(''); }}
                className="w-full mt-4 py-2 px-4 font-medium transition flex items-center justify-center gap-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                <ArrowLeft size={16} /> Back
              </button>
            </div>
          )}

          {/* Step 5: Email OTP */}
          {step === 5 && (
            <form onSubmit={handleVerifyOTP}>
              <div className="space-y-4">
                <div className="text-center mb-6">
                  <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>We've sent a code to</p>
                  <p className="font-semibold">{form.email}</p>
                </div>
                <div>
                  <label htmlFor="otp" className="block text-sm font-medium mb-1 text-center">Enter OTP</label>
                  <input id="otp" type="text" value={otp} onChange={(e) => { setOtp(e.target.value.replace(/\D/g, '').slice(0, 6)); if (error) setError(''); }}
                    className="glass-input text-center text-2xl font-bold tracking-widest" placeholder="000000" maxLength={6} required disabled={loading} />
                </div>
                <div className="text-center text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  Didn't receive the code?{' '}
                  <button type="button" onClick={handleResendOTP} disabled={loading} className="font-medium underline disabled:opacity-50" style={{ color: 'hsl(var(--primary))' }}>Resend OTP</button>
                </div>
              </div>
              <button type="submit" disabled={loading || otp.length !== 6}
                className="w-full mt-8 py-3 px-4 rounded-xl font-semibold glow-soft hover:-translate-y-0.5 transition-all disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }}>
                {loading ? 'Creating Account...' : 'Create Seller Account'}
              </button>
              <button type="button" onClick={() => { setStep(4); setOtp(''); setError(''); setSuccess(''); }}
                className="w-full mt-4 py-2 px-4 font-medium transition" style={{ color: 'hsl(var(--muted-foreground))' }}>← Back</button>
            </form>
          )}

          {step === 1 && (
            <>
              <div className="mt-6">
                <div className="relative">
                  <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-white/15" /></div>
                  <div className="relative flex justify-center text-sm"><span className="px-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Or</span></div>
                </div>
                <div className="mt-6 text-center text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  Already have an account?{' '}
                  <button onClick={() => navigate("/login")} className="font-medium underline" style={{ color: 'hsl(var(--primary))' }}>Log in</button>
                </div>
                <div className="mt-3 text-center text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  Want to sign up as a buyer?{' '}
                  <button onClick={() => navigate("/signup")} className="font-medium underline" style={{ color: 'hsl(var(--primary))' }}>Sign up here</button>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="py-4 px-8 border-t border-white/15 text-center">
          <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>By signing up, you agree to our <Link className="underline" to="/terms">Terms and Conditions</Link>. Read our <Link className="underline" to="/privacy">Privacy Policy</Link>.</p>
        </div>
      </div>
    </div>
  );
};

export default SellerSignUp;
