import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { User, Mail, Phone, MapPin, Store, MessageCircle, Edit3, CheckCircle2, AlertTriangle, Loader2, Shield, Clock } from 'lucide-react';
import axios from 'axios';
import { useAuth } from '../../contexts/AuthContext';
import PhoneField, { isValidPhone } from '../common/PhoneField';
import { getAuthToken, setCrossDomainCookie } from "../../utils/cookieHelper";

const API_URL = import.meta.env.VITE_API_URL;

export default function SellerProfile() {
  const { fetchAndUpdateCurrentUser } = useAuth();
  const [loading, setLoading] = useState(true);
  const [userData, setUserData] = useState(null);
  const [successMsg, setSuccessMsg] = useState('');
  const [loadError, setLoadError] = useState('');

  // WhatsApp change state
  const [showWhatsAppChange, setShowWhatsAppChange] = useState(false);
  const [newWhatsApp, setNewWhatsApp] = useState('');
  const [whatsAppOtp, setWhatsAppOtp] = useState('');
  const [whatsAppOtpSent, setWhatsAppOtpSent] = useState(false);
  const [whatsAppSending, setWhatsAppSending] = useState(false);
  const [whatsAppVerifying, setWhatsAppVerifying] = useState(false);
  const [whatsAppError, setWhatsAppError] = useState('');
  const [whatsAppCountdown, setWhatsAppCountdown] = useState(0);
  const whatsAppCountdownRef = useRef(null);

  // Email change state
  const [showEmailChange, setShowEmailChange] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [emailOtp, setEmailOtp] = useState('');
  const [emailOtpSent, setEmailOtpSent] = useState(false);
  const [emailSending, setEmailSending] = useState(false);
  const [emailVerifying, setEmailVerifying] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [emailCountdown, setEmailCountdown] = useState(0);
  const emailCountdownRef = useRef(null);

  const token = getAuthToken();
  const headers = { Authorization: `Bearer ${token}` };

  // Countdown effects
  useEffect(() => {
    if (whatsAppCountdown > 0) {
      whatsAppCountdownRef.current = setTimeout(() => setWhatsAppCountdown(whatsAppCountdown - 1), 1000);
      return () => clearTimeout(whatsAppCountdownRef.current);
    }
  }, [whatsAppCountdown]);

  useEffect(() => {
    if (emailCountdown > 0) {
      emailCountdownRef.current = setTimeout(() => setEmailCountdown(emailCountdown - 1), 1000);
      return () => clearTimeout(emailCountdownRef.current);
    }
  }, [emailCountdown]);

  // Fetch user data
  useEffect(() => {
    fetchProfile();
    // Profile bootstrap is mount-only; successful mutations explicitly refresh
    // the profile after they commit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchProfile = async () => {
    try {
      const res = await axios.get(`${API_URL}api/user/single`, { headers });
      setUserData(res.data.user);
      setLoadError('');
    } catch (err) {
      setLoadError('Failed to load profile. Please refresh the page.');
    } finally {
      setLoading(false);
    }
  };

  // Cooldown helpers
  const getWhatsAppCooldown = () => {
    if (!userData?.sellerInfo?.lastWhatsAppChange) return null;
    const daysSince = (Date.now() - new Date(userData.sellerInfo.lastWhatsAppChange).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < 30) return Math.ceil(30 - daysSince);
    return null;
  };

  const getEmailCooldown = () => {
    if (!userData?.sellerInfo?.lastEmailChange) return null;
    const daysSince = (Date.now() - new Date(userData.sellerInfo.lastEmailChange).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < 30) return Math.ceil(30 - daysSince);
    return null;
  };

  // WhatsApp change handlers
  const handleInitiateWhatsAppChange = async () => {
    if (!newWhatsApp || !isValidPhone(newWhatsApp)) {
      setWhatsAppError('Please enter a valid WhatsApp number');
      return;
    }
    setWhatsAppSending(true);
    setWhatsAppError('');
    setSuccessMsg('');
    try {
      await axios.post(`${API_URL}api/user/seller/change-whatsapp/initiate`, { newWhatsappNumber: newWhatsApp }, { headers });
      setWhatsAppOtpSent(true);
      setWhatsAppCountdown(120);
    } catch (err) {
      setWhatsAppError(err.response?.data?.msg || 'Failed to send code');
    } finally {
      setWhatsAppSending(false);
    }
  };

  const handleVerifyWhatsAppChange = async () => {
    if (whatsAppOtp.length !== 6) { setWhatsAppError('Enter the 6-digit code'); return; }
    setWhatsAppVerifying(true);
    setWhatsAppError('');
    try {
      await axios.post(`${API_URL}api/user/seller/change-whatsapp/verify`, { newWhatsappNumber: newWhatsApp, otp: whatsAppOtp }, { headers });
      setSuccessMsg('WhatsApp number updated successfully.');
      setShowWhatsAppChange(false);
      setWhatsAppOtpSent(false);
      setNewWhatsApp('');
      setWhatsAppOtp('');
      setWhatsAppCountdown(0);
      fetchProfile();
      fetchAndUpdateCurrentUser();
    } catch (err) {
      setWhatsAppError(err.response?.data?.msg || 'Verification failed');
    } finally {
      setWhatsAppVerifying(false);
    }
  };

  // Email change handlers
  const handleInitiateEmailChange = async () => {
    if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      setEmailError('Please enter a valid email address');
      return;
    }
    setEmailSending(true);
    setEmailError('');
    setSuccessMsg('');
    try {
      await axios.post(`${API_URL}api/user/seller/change-email/initiate`, { newEmail }, { headers });
      setEmailOtpSent(true);
      setEmailCountdown(600);
    } catch (err) {
      setEmailError(err.response?.data?.msg || 'Failed to send code');
    } finally {
      setEmailSending(false);
    }
  };

  const handleVerifyEmailChange = async () => {
    if (emailOtp.length !== 6) { setEmailError('Enter the 6-digit code'); return; }
    setEmailVerifying(true);
    setEmailError('');
    try {
      const res = await axios.post(`${API_URL}api/user/seller/change-email/verify`, { newEmail, otp: emailOtp }, { headers });
      setSuccessMsg('Email updated successfully.');
      if (res.data.token) {
        localStorage.setItem('jwtToken', res.data.token);
        setCrossDomainCookie('rozare_jwt_token', res.data.token, 30);
      }
      setShowEmailChange(false);
      setEmailOtpSent(false);
      setNewEmail('');
      setEmailOtp('');
      setEmailCountdown(0);
      fetchProfile();
      fetchAndUpdateCurrentUser();
    } catch (err) {
      setEmailError(err.response?.data?.msg || 'Verification failed');
    } finally {
      setEmailVerifying(false);
    }
  };

  const formatCountdown = (secs) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 size={32} className="animate-spin" style={{ color: 'hsl(var(--primary))' }} />
      </div>
    );
  }

  const whatsAppCooldownDays = getWhatsAppCooldown();
  const emailCooldownDays = getEmailCooldown();

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="min-h-screen p-4 sm:p-6 max-w-4xl mx-auto">
      {/* Page Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2.5 rounded-xl" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))' }}>
            <User size={22} className="text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold" style={{ color: 'hsl(var(--foreground))' }}>Seller Profile</h1>
            <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>View and manage your seller account information</p>
          </div>
        </div>
      </div>

      {/* Inline success message */}
      {successMsg && (
        <div className="p-3 rounded-xl mb-4 text-sm font-medium flex items-center gap-2" style={{ background: 'hsla(150, 60%, 40%, 0.08)', color: 'hsl(150, 60%, 40%)', border: '1px solid hsla(150, 60%, 40%, 0.2)' }}>
          <CheckCircle2 size={16} /> {successMsg}
        </div>
      )}

      {/* Load error */}
      {loadError && (
        <div className="p-3 rounded-xl mb-4 text-sm font-medium" style={{ background: 'hsla(0, 72%, 55%, 0.08)', color: 'hsl(0, 72%, 55%)', border: '1px solid hsla(0, 72%, 55%, 0.15)' }}>{loadError}</div>
      )}

      {/* Profile Info Section */}
      <div className="glass-panel-strong rounded-3xl p-6 mb-6">
        <h2 className="text-lg font-bold mb-4 flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
          <Shield size={18} style={{ color: 'hsl(var(--primary))' }} /> Account Information
        </h2>

        <div className="space-y-4">
          {/* Username */}
          <div className="flex items-start gap-3 p-3 rounded-xl" style={{ background: 'hsl(var(--card))' }}>
            <User size={18} className="mt-0.5 shrink-0" style={{ color: 'hsl(var(--primary))' }} />
            <div>
              <p className="text-xs font-medium uppercase tracking-wider" style={{ color: 'hsl(var(--muted-foreground))' }}>Name</p>
              <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{userData?.username || '—'}</p>
            </div>
          </div>

          {/* Email */}
          <div className="flex items-start justify-between p-3 rounded-xl" style={{ background: 'hsl(var(--card))' }}>
            <div className="flex items-start gap-3">
              <Mail size={18} className="mt-0.5 shrink-0" style={{ color: 'hsl(var(--primary))' }} />
              <div>
                <p className="text-xs font-medium uppercase tracking-wider" style={{ color: 'hsl(var(--muted-foreground))' }}>Email</p>
                <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{userData?.email || '—'}</p>
                {emailCooldownDays && (
                  <p className="text-[11px] mt-1 flex items-center gap-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    <Clock size={10} /> Can change in {emailCooldownDays} day{emailCooldownDays > 1 ? 's' : ''}
                  </p>
                )}
              </div>
            </div>
            {!showEmailChange && (
              <button onClick={() => { setShowEmailChange(true); setShowWhatsAppChange(false); }}
                disabled={emailCooldownDays !== null}
                className="px-3 py-1.5 rounded-lg text-xs font-bold inline-flex items-center gap-1.5 glass-inner disabled:opacity-40"
                style={{ color: 'hsl(var(--primary))' }}>
                <Edit3 size={12} /> Change
              </button>
            )}
          </div>

          {/* Email Change Form */}
          {showEmailChange && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="ml-6 p-4 rounded-xl border" style={{ borderColor: 'hsl(var(--border))', background: 'hsla(220, 70%, 55%, 0.03)' }}>
              {/* Warning */}
              <div className="flex items-start gap-2 p-3 rounded-lg mb-4" style={{ background: 'hsla(45, 93%, 47%, 0.08)', border: '1px solid hsla(45, 93%, 47%, 0.2)' }}>
                <AlertTriangle size={16} className="mt-0.5 shrink-0" style={{ color: 'hsl(45, 93%, 47%)' }} />
                <p className="text-xs" style={{ color: 'hsl(var(--foreground))' }}>
                  <strong>Warning:</strong> After changing your email, you won't be able to change it again for <strong>30 days</strong>.
                </p>
              </div>

              {!emailOtpSent ? (
                <div className="space-y-3">
                  <input type="email" value={newEmail} onChange={(e) => { setNewEmail(e.target.value); setEmailError(''); }}
                    placeholder="New email address" className="glass-input text-sm" />
                  {emailError && <p className="text-xs" style={{ color: 'hsl(0, 72%, 55%)' }}>{emailError}</p>}
                  <div className="flex gap-2">
                    <button onClick={handleInitiateEmailChange} disabled={emailSending}
                      className="px-4 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-50"
                      style={{ background: 'hsl(var(--primary))' }}>
                      {emailSending ? 'Sending...' : 'Send Verification Code'}
                    </button>
                    <button onClick={() => { setShowEmailChange(false); setNewEmail(''); setEmailError(''); }}
                      className="px-4 py-2 rounded-lg text-xs font-medium glass-inner" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Enter the 6-digit code sent to <strong>{newEmail}</strong></p>
                  <input type="text" value={emailOtp} onChange={(e) => { setEmailOtp(e.target.value.replace(/\D/g, '').slice(0, 6)); setEmailError(''); }}
                    placeholder="000000" className="glass-input text-center text-lg font-bold tracking-widest" maxLength={6} />
                  {emailCountdown > 0 && (
                    <p className="text-xs text-center" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      Code expires in <strong>{formatCountdown(emailCountdown)}</strong>
                    </p>
                  )}
                  {emailError && <p className="text-xs" style={{ color: 'hsl(0, 72%, 55%)' }}>{emailError}</p>}
                  <div className="flex gap-2">
                    <button onClick={handleVerifyEmailChange} disabled={emailVerifying || emailOtp.length !== 6}
                      className="px-4 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-50"
                      style={{ background: 'hsl(150, 60%, 40%)' }}>
                      {emailVerifying ? 'Verifying...' : 'Verify & Update'}
                    </button>
                    <button onClick={() => { setShowEmailChange(false); setEmailOtpSent(false); setNewEmail(''); setEmailOtp(''); setEmailError(''); setEmailCountdown(0); }}
                      className="px-4 py-2 rounded-lg text-xs font-medium glass-inner" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* WhatsApp Number */}
          <div className="flex items-start justify-between p-3 rounded-xl" style={{ background: 'hsl(var(--card))' }}>
            <div className="flex items-start gap-3">
              <MessageCircle size={18} className="mt-0.5 shrink-0" style={{ color: 'hsl(150, 60%, 40%)' }} />
              <div>
                <p className="text-xs font-medium uppercase tracking-wider" style={{ color: 'hsl(var(--muted-foreground))' }}>WhatsApp Number</p>
                <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{userData?.sellerInfo?.whatsappNumber || userData?.sellerInfo?.phoneNumber || '—'}</p>
                {userData?.sellerInfo?.whatsappVerified && (
                  <p className="text-[11px] mt-0.5 flex items-center gap-1" style={{ color: 'hsl(150, 60%, 40%)' }}>
                    <CheckCircle2 size={10} /> Verified
                  </p>
                )}
                {whatsAppCooldownDays && (
                  <p className="text-[11px] mt-1 flex items-center gap-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    <Clock size={10} /> Can change in {whatsAppCooldownDays} day{whatsAppCooldownDays > 1 ? 's' : ''}
                  </p>
                )}
              </div>
            </div>
            {!showWhatsAppChange && (
              <button onClick={() => { setShowWhatsAppChange(true); setShowEmailChange(false); }}
                disabled={whatsAppCooldownDays !== null}
                className="px-3 py-1.5 rounded-lg text-xs font-bold inline-flex items-center gap-1.5 glass-inner disabled:opacity-40"
                style={{ color: 'hsl(var(--primary))' }}>
                <Edit3 size={12} /> Change
              </button>
            )}
          </div>

          {/* WhatsApp Change Form */}
          {showWhatsAppChange && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="ml-6 p-4 rounded-xl border" style={{ borderColor: 'hsl(var(--border))', background: 'hsla(220, 70%, 55%, 0.03)' }}>
              {/* Warning */}
              <div className="flex items-start gap-2 p-3 rounded-lg mb-4" style={{ background: 'hsla(45, 93%, 47%, 0.08)', border: '1px solid hsla(45, 93%, 47%, 0.2)' }}>
                <AlertTriangle size={16} className="mt-0.5 shrink-0" style={{ color: 'hsl(45, 93%, 47%)' }} />
                <p className="text-xs" style={{ color: 'hsl(var(--foreground))' }}>
                  <strong>Warning:</strong> After changing your WhatsApp number, you won't be able to change it again for <strong>30 days</strong>. Order notifications will be sent to the new number.
                </p>
              </div>

              {!whatsAppOtpSent ? (
                <div className="space-y-3">
                  <PhoneField
                    value={newWhatsApp}
                    onChange={(v) => { setNewWhatsApp(v || ''); setWhatsAppError(''); }}
                    profileCountry={userData?.sellerInfo?.country}
                    placeholder="New WhatsApp number"
                  />
                  {whatsAppError && <p className="text-xs" style={{ color: 'hsl(0, 72%, 55%)' }}>{whatsAppError}</p>}
                  <div className="flex gap-2">
                    <button onClick={handleInitiateWhatsAppChange} disabled={whatsAppSending}
                      className="px-4 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-50"
                      style={{ background: 'hsl(150, 60%, 40%)' }}>
                      {whatsAppSending ? 'Sending...' : 'Send Verification Code'}
                    </button>
                    <button onClick={() => { setShowWhatsAppChange(false); setNewWhatsApp(''); setWhatsAppError(''); }}
                      className="px-4 py-2 rounded-lg text-xs font-medium glass-inner" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Enter the 6-digit code sent to <strong>{newWhatsApp}</strong> via WhatsApp</p>
                  <input type="text" value={whatsAppOtp} onChange={(e) => { setWhatsAppOtp(e.target.value.replace(/\D/g, '').slice(0, 6)); setWhatsAppError(''); }}
                    placeholder="000000" className="glass-input text-center text-lg font-bold tracking-widest" maxLength={6} />
                  {whatsAppCountdown > 0 && (
                    <p className="text-xs text-center" style={{ color: whatsAppCountdown <= 30 ? 'hsl(0, 72%, 55%)' : 'hsl(var(--muted-foreground))' }}>
                      Code expires in <strong>{formatCountdown(whatsAppCountdown)}</strong>
                    </p>
                  )}
                  {whatsAppError && <p className="text-xs" style={{ color: 'hsl(0, 72%, 55%)' }}>{whatsAppError}</p>}
                  <div className="flex gap-2">
                    <button onClick={handleVerifyWhatsAppChange} disabled={whatsAppVerifying || whatsAppOtp.length !== 6 || whatsAppCountdown === 0}
                      className="px-4 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-50"
                      style={{ background: 'hsl(150, 60%, 40%)' }}>
                      {whatsAppVerifying ? 'Verifying...' : 'Verify & Update'}
                    </button>
                    <button onClick={() => { setShowWhatsAppChange(false); setWhatsAppOtpSent(false); setNewWhatsApp(''); setWhatsAppOtp(''); setWhatsAppError(''); setWhatsAppCountdown(0); }}
                      className="px-4 py-2 rounded-lg text-xs font-medium glass-inner" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* Phone Number */}
          <div className="flex items-start gap-3 p-3 rounded-xl" style={{ background: 'hsl(var(--card))' }}>
            <Phone size={18} className="mt-0.5 shrink-0" style={{ color: 'hsl(var(--primary))' }} />
            <div>
              <p className="text-xs font-medium uppercase tracking-wider" style={{ color: 'hsl(var(--muted-foreground))' }}>Phone Number</p>
              <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{userData?.sellerInfo?.phoneNumber || '—'}</p>
            </div>
          </div>

          {/* Business Name */}
          {userData?.sellerInfo?.businessName && (
            <div className="flex items-start gap-3 p-3 rounded-xl" style={{ background: 'hsl(var(--card))' }}>
              <Store size={18} className="mt-0.5 shrink-0" style={{ color: 'hsl(var(--primary))' }} />
              <div>
                <p className="text-xs font-medium uppercase tracking-wider" style={{ color: 'hsl(var(--muted-foreground))' }}>Business Name</p>
                <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{userData.sellerInfo.businessName}</p>
              </div>
            </div>
          )}

          {/* Address */}
          <div className="flex items-start gap-3 p-3 rounded-xl" style={{ background: 'hsl(var(--card))' }}>
            <MapPin size={18} className="mt-0.5 shrink-0" style={{ color: 'hsl(var(--primary))' }} />
            <div>
              <p className="text-xs font-medium uppercase tracking-wider" style={{ color: 'hsl(var(--muted-foreground))' }}>Address</p>
              <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
                {[userData?.sellerInfo?.address, userData?.sellerInfo?.city, userData?.sellerInfo?.country].filter(Boolean).join(', ') || '—'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Account Status */}
      <div className="glass-panel-strong rounded-3xl p-6">
        <h2 className="text-lg font-bold mb-4 flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
          <CheckCircle2 size={18} style={{ color: 'hsl(150, 60%, 40%)' }} /> Account Status
        </h2>
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="p-3 rounded-xl" style={{ background: 'hsl(var(--card))' }}>
            <p className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>Role</p>
            <p className="text-sm font-bold capitalize" style={{ color: 'hsl(var(--foreground))' }}>{userData?.role || '—'}</p>
          </div>
          <div className="p-3 rounded-xl" style={{ background: 'hsl(var(--card))' }}>
            <p className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>Account Status</p>
            <p className="text-sm font-bold" style={{ color: userData?.status === 'blocked' ? 'hsl(0, 72%, 55%)' : 'hsl(150, 60%, 40%)' }}>
              {userData?.status === 'blocked' ? 'Blocked' : 'Active'}
            </p>
          </div>
          <div className="p-3 rounded-xl" style={{ background: 'hsl(var(--card))' }}>
            <p className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>WhatsApp Verified</p>
            <p className="text-sm font-bold" style={{ color: userData?.sellerInfo?.whatsappVerified ? 'hsl(150, 60%, 40%)' : 'hsl(0, 72%, 55%)' }}>
              {userData?.sellerInfo?.whatsappVerified ? 'Yes' : 'No'}
            </p>
          </div>
          <div className="p-3 rounded-xl" style={{ background: 'hsl(var(--card))' }}>
            <p className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>Member Since</p>
            <p className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>
              {userData?.createdAt ? new Date(userData.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '—'}
            </p>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
