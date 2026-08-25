import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Store, ArrowLeft, Sparkles, CheckCircle, CheckCircle2, TrendingUp, Shield, BarChart3, Phone, MapPin, Globe, Instagram, Facebook, Twitter, Youtube, ArrowRight, MessageCircle, Edit3, Mail, Lock, User as UserIcon, AlertCircle, Loader2, Bot, Wand2, Mic, Zap, Tag, LineChart, Smartphone, Languages, CreditCard, Globe2, Megaphone, PackageSearch, Bell } from 'lucide-react';
import { toast } from 'react-toastify';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { useCurrency } from '../contexts/CurrencyContext';
import SEOHead from '../components/common/SEOHead';
import PhoneField, { isValidPhone } from '../components/common/PhoneField';
import LocationAutocomplete from '../components/common/LocationAutocomplete';
import { getAuthToken, setCrossDomainCookie } from "../utils/cookieHelper";
import {
  createTikTokEventId,
  getTikTokTrackingContext,
  trackSellerFormSubmitted,
  trackSellerPageView,
  trackSellerRegistrationCompleted
} from '../utils/tiktokPixel';

const SELLER_PRODUCT_CURRENCY_CODES = ['USD', 'PKR', 'EUR', 'GBP'];
const normalizeSellerProductCurrency = value => {
  const code = String(value || '').trim().toUpperCase();
  return SELLER_PRODUCT_CURRENCY_CODES.includes(code) ? code : 'USD';
};

export default function BecomeSeller() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { currentUser, setCurrentUser, fetchAndUpdateCurrentUser } = useAuth();
  const { currency: accountCurrency, currencies } = useCurrency();
  const [loading, setLoading] = useState(false);
  // Steps: 0=landing, 0.5=guest signup, 0.6=OTP verify, 1=seller info, 2=store setup, 3=WhatsApp verify
  const [formStep, setFormStep] = useState(0);
  const [formData, setFormData] = useState({ phoneNumber: '', address: '', city: '', state: '', stateCode: '', country: '', countryCode: '', businessName: '' });
  const productCurrencyTouchedRef = useRef(false);
  const [storeData, setStoreData] = useState({
    storeName: '',
    storeDescription: '',
    productCurrency: normalizeSellerProductCurrency(currentUser?.currency || accountCurrency),
    website: '',
    instagram: '',
    facebook: '',
    twitter: '',
    youtube: '',
    tiktok: '',
  });
  // Store name availability state
  const [storeSlugPreview, setStoreSlugPreview] = useState('');
  const [storeNameAvailable, setStoreNameAvailable] = useState(null); // null=unchecked, true=available, false=taken
  const [storeNameChecking, setStoreNameChecking] = useState(false);
  const [storeNameError, setStoreNameError] = useState('');
  const storeCheckRef = useRef(null);
  // Inline form error (replaces toast.error for validation)
  const [formError, setFormError] = useState('');
  // Guest signup state
  const [signupData, setSignupData] = useState({ username: '', email: '', password: '' });
  const [signupLoading, setSignupLoading] = useState(false);
  const [emailOtp, setEmailOtp] = useState('');
  const [emailOtpSent, setEmailOtpSent] = useState(false);
  const [emailVerifying, setEmailVerifying] = useState(false);
  const [emailOtpCountdown, setEmailOtpCountdown] = useState(0);
  const [emailResendCooldown, setEmailResendCooldown] = useState(0);
  const emailCountdownRef = useRef(null);
  const emailResendRef = useRef(null);
  // WhatsApp OTP state
  const [whatsappOtp, setWhatsappOtp] = useState('');
  const [whatsappVerified, setWhatsappVerified] = useState(false);
  const [whatsappSending, setWhatsappSending] = useState(false);
  const [whatsappVerifying, setWhatsappVerifying] = useState(false);
  const [whatsappError, setWhatsappError] = useState('');
  const [whatsappCodeSent, setWhatsappCodeSent] = useState(false);
  const [editingNumber, setEditingNumber] = useState(false);
  // Timers
  const [otpCountdown, setOtpCountdown] = useState(0);
  const [resendCooldown, setResendCooldown] = useState(0);
  const countdownRef = useRef(null);
  const resendRef = useRef(null);

  useEffect(() => {
    trackSellerPageView();
  }, []);

  // If user just came back from Google auth (redirected here), auto-advance to step 1
  useEffect(() => {
    if (searchParams.get('from') === 'google' && currentUser) {
      setFormStep(1);
    }
  }, [searchParams, currentUser]);

  // CurrencyContext refreshes the authoritative account preference after
  // login. Keep the visible default aligned until the seller deliberately
  // chooses a listing currency, then never overwrite that explicit choice.
  useEffect(() => {
    if (productCurrencyTouchedRef.current) return;
    const productCurrency = normalizeSellerProductCurrency(currentUser?.currency || accountCurrency);
    setStoreData(previous => (
      previous.productCurrency === productCurrency
        ? previous
        : { ...previous, productCurrency }
    ));
  }, [accountCurrency, currentUser?.currency]);

  const handleInputChange = (e) => { const { name, value } = e.target; setFormData(prev => ({ ...prev, [name]: value })); };
  const handleStoreChange = (e) => { const { name, value } = e.target; setStoreData(prev => ({ ...prev, [name]: value })); };
  const handleProductCurrencyChange = (e) => {
    productCurrencyTouchedRef.current = true;
    setStoreData(prev => ({
      ...prev,
      productCurrency: normalizeSellerProductCurrency(e.target.value),
    }));
  };
  const handleSignupChange = (e) => { const { name, value } = e.target; setSignupData(prev => ({ ...prev, [name]: value })); };

  // Generate slug from store name
  const generateSlug = (name) => {
    return name.toLowerCase().trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
  };

  // Debounced store name availability check
  const checkStoreNameAvailability = useCallback((slug) => {
    if (storeCheckRef.current) clearTimeout(storeCheckRef.current);
    if (!slug || slug.length < 3) {
      setStoreNameAvailable(null);
      setStoreNameError(slug && slug.length < 3 ? 'Store name must be at least 3 characters' : '');
      setStoreNameChecking(false);
      return;
    }
    setStoreNameChecking(true);
    setStoreNameError('');
    storeCheckRef.current = setTimeout(async () => {
      try {
        const token = getAuthToken();
        const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/check-subdomain/${slug}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        setStoreNameAvailable(res.data.available);
        if (!res.data.available) {
          setStoreNameError(res.data.msg || 'This name is already taken');
        }
      } catch (err) {
        setStoreNameAvailable(null);
        setStoreNameError('Could not check availability');
      } finally {
        setStoreNameChecking(false);
      }
    }, 500);
  }, []);

  // Handle store name change with slug preview and availability check
  const handleStoreNameChange = (e) => {
    const { value } = e.target;
    setStoreData(prev => ({ ...prev, storeName: value }));
    const slug = generateSlug(value);
    setStoreSlugPreview(slug);
    setStoreNameAvailable(null);
    checkStoreNameAvailability(slug);
  };

  // Email OTP countdown effects
  useEffect(() => {
    if (emailOtpCountdown > 0) {
      emailCountdownRef.current = setTimeout(() => setEmailOtpCountdown(emailOtpCountdown - 1), 1000);
      return () => clearTimeout(emailCountdownRef.current);
    }
  }, [emailOtpCountdown]);

  useEffect(() => {
    if (emailResendCooldown > 0) {
      emailResendRef.current = setTimeout(() => setEmailResendCooldown(emailResendCooldown - 1), 1000);
      return () => clearTimeout(emailResendRef.current);
    }
  }, [emailResendCooldown]);

  // WhatsApp countdown timer effect
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

  // Guest signup: send email OTP
  const handleGuestSignup = async (e) => {
    e.preventDefault();
    setFormError('');
    if (!signupData.username.trim() || signupData.username.trim().length < 2) { setFormError('Please enter a valid name'); return; }
    if (!signupData.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signupData.email)) { setFormError('Please enter a valid email'); return; }
    if (!signupData.password || signupData.password.length < 6) { setFormError('Password must be at least 6 characters'); return; }

    setSignupLoading(true);
    try {
      await axios.post(`${import.meta.env.VITE_API_URL}api/auth/send-otp`, {
        username: signupData.username.trim(),
        email: signupData.email.trim(),
        password: signupData.password
      });
      setEmailOtpSent(true);
      setEmailOtpCountdown(600); // 10 minutes
      setEmailResendCooldown(30);
      setFormStep(0.6); // Go to OTP verification step
      setFormError('');
    } catch (err) {
      const msg = err.response?.data?.msg || 'Failed to send OTP. Please try again.';
      setFormError(msg);
    } finally {
      setSignupLoading(false);
    }
  };

  // Guest signup: verify email OTP and create account
  const handleVerifyEmailOtp = async (e) => {
    e.preventDefault();
    setFormError('');
    if (emailOtp.length !== 6) { setFormError('Please enter the 6-digit code'); return; }
    setEmailVerifying(true);
    try {
      const res = await axios.post(`${import.meta.env.VITE_API_URL}api/auth/verify-otp`, {
        email: signupData.email.trim(),
        otp: emailOtp
      });
      // Account created, store token and user
      localStorage.setItem('jwtToken', res.data.token);
      setCrossDomainCookie('rozare_jwt_token', res.data.token, 30);
      localStorage.setItem('currentUser', JSON.stringify(res.data.user));
      setCurrentUser(res.data.user);
      setFormError('');
      setFormStep(1); // Proceed to seller info step
    } catch (err) {
      const msg = err.response?.data?.msg || 'Invalid or expired code. Please try again.';
      setFormError(msg);
    } finally {
      setEmailVerifying(false);
    }
  };

  // Resend email OTP
  const handleResendEmailOtp = async () => {
    setSignupLoading(true);
    try {
      await axios.post(`${import.meta.env.VITE_API_URL}api/auth/send-otp`, {
        username: signupData.username.trim(),
        email: signupData.email.trim(),
        password: signupData.password
      });
      setEmailOtpCountdown(600);
      setEmailResendCooldown(30);
      setFormError('');
    } catch (err) {
      setFormError(err.response?.data?.msg || 'Failed to resend code');
    } finally {
      setSignupLoading(false);
    }
  };

  // Continue with Google for guest users
  const handleGoogleSignup = () => {
    // Store a flag with timestamp so when user comes back after Google auth, we know to continue the seller flow
    // Expires after 10 minutes to avoid stale redirects
    localStorage.setItem('sellerSignupRedirect', JSON.stringify({ timestamp: Date.now() }));
    window.location.href = `${import.meta.env.VITE_API_URL}api/auth/google?state=seller`;
  };

  const handleSendWhatsAppOtp = async () => {
    if (!formData.phoneNumber || !isValidPhone(formData.phoneNumber)) {
      setWhatsappError('Please enter a valid phone number first');
      return;
    }
    setWhatsappSending(true);
    setWhatsappError('');
    try {
      await axios.post(`${import.meta.env.VITE_API_URL}api/seller-whatsapp/send-otp`, { whatsappNumber: formData.phoneNumber });
      setWhatsappCodeSent(true);
      setOtpCountdown(120);
      setResendCooldown(30);
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
      await axios.post(`${import.meta.env.VITE_API_URL}api/seller-whatsapp/verify-otp`, { whatsappNumber: formData.phoneNumber, otp: whatsappOtp });
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
    setFormError('');
    if (!formData.phoneNumber || !isValidPhone(formData.phoneNumber)) { setFormError('Please enter a valid phone number (select your country and enter the number)'); return; }
    if (!formData.address || formData.address.trim().length < 5) { setFormError('Please enter a valid address'); return; }
    if (!formData.country || !formData.countryCode) { setFormError('Please select your country from the list'); return; }
    if (!formData.city || formData.city.trim().length < 2) { setFormError('Please select your city from the list'); return; }
    trackSellerFormSubmitted('seller_details');
    setFormStep(2);
  };

  const handleStep2Next = () => {
    setFormError('');
    if (!storeData.storeName || storeData.storeName.trim().length < 3) {
      setFormError('Store name is required (at least 3 characters)'); return;
    }
    if (!storeData.storeDescription || storeData.storeDescription.trim().length < 10) {
      setFormError('Store description is required (at least 10 characters)'); return;
    }
    if (!SELLER_PRODUCT_CURRENCY_CODES.includes(storeData.productCurrency)) {
      setFormError('Choose USD, PKR, EUR, or GBP for your product prices.'); return;
    }
    if (storeNameAvailable === false) {
      setFormError('This store name is already taken. Please choose a different name.'); return;
    }
    if (storeNameChecking) {
      setFormError('Please wait — checking store name availability'); return;
    }
    // Go to WhatsApp verification step
    setFormStep(3);
  };

  const handleBecomeSeller = async () => {
    setFormError('');
    if (!whatsappVerified) { setFormError('Please verify your WhatsApp number first'); return; }
    setLoading(true);
    try {
      const token = getAuthToken();
      const socialLinks = {};
      if (storeData.website) socialLinks.website = storeData.website;
      if (storeData.instagram) socialLinks.instagram = storeData.instagram;
      if (storeData.facebook) socialLinks.facebook = storeData.facebook;
      if (storeData.twitter) socialLinks.twitter = storeData.twitter;
      if (storeData.youtube) socialLinks.youtube = storeData.youtube;
      if (storeData.tiktok) socialLinks.tiktok = storeData.tiktok;
      const tiktokEventId = createTikTokEventId('seller_registration');

      const res = await axios.post(`${import.meta.env.VITE_API_URL}api/user/become-seller`, {
        phoneNumber: formData.phoneNumber.trim(), address: formData.address.trim(),
        city: formData.city.trim(),
        state: formData.state.trim(),
        stateCode: formData.stateCode.trim(),
        country: formData.country.trim(),
        countryCode: formData.countryCode.trim(),
        businessName: formData.businessName.trim(),
        whatsappNumber: formData.phoneNumber.trim(),
        whatsappVerified: true,
        storeName: storeData.storeName?.trim() || '',
        storeDescription: storeData.storeDescription?.trim() || '',
        productCurrency: storeData.productCurrency,
        socialLinks: Object.keys(socialLinks).length > 0 ? socialLinks : undefined,
        tracking: {
          ...getTikTokTrackingContext(),
          tiktokCompleteRegistrationEventId: tiktokEventId,
        },
      }, { headers: { Authorization: `Bearer ${token}` } });
      if (res.data.token) {
        localStorage.setItem('jwtToken', res.data.token);
        setCrossDomainCookie('rozare_jwt_token', res.data.token, 30);
      }
      
      await trackSellerRegistrationCompleted({
        user: res.data.user || currentUser,
        storeName: storeData.storeName?.trim(),
        email: currentUser?.email || signupData.email,
        phone: formData.phoneNumber.trim(),
        eventId: tiktokEventId,
      }).catch(() => {});

      toast.success('Congratulations! You are now a seller!');
      if (res.data.user) setCurrentUser(res.data.user);
      await fetchAndUpdateCurrentUser();
      setTimeout(() => { window.location.href = '/seller-dashboard/store-overview'; }, 1500);
    } catch (error) { setFormError(error.response?.data?.message || 'Failed to create seller account'); }
    finally { setLoading(false); }
  };

  const isExistingSellerAccount = currentUser?.role === 'seller' || currentUser?.role === 'admin';

  // If guest (not logged in) tries to proceed past the landing page, show inline signup
  const handleGetStarted = () => {
    if (isExistingSellerAccount) {
      navigate(currentUser.role === 'admin' ? '/admin-dashboard' : '/seller-dashboard/store-overview');
      return;
    }
    if (!currentUser) {
      setFormStep(0.5); // Show guest signup form
    } else {
      setFormStep(1);
    }
  };

  const benefits = [
    { icon: <Bot size={28} />, title: 'Run Your Store with AI', description: 'Add products, set prices, and manage supported order workflows by chatting on the app or WhatsApp.', color: 'hsl(280, 70%, 60%)' },
    { icon: <TrendingUp size={28} />, title: 'Reach Global Buyers', description: 'Multi-currency checkout, mobile + web storefronts, and SEO baked in to help you scale fast.', color: 'hsl(220, 70%, 55%)' },
    { icon: <Shield size={28} />, title: 'Secure & Trusted', description: 'Stripe-powered payments, verified store badges, and a built-in trust system that protects buyers and sellers.', color: 'hsl(200, 80%, 50%)' },
  ];

  const aiSuperpowers = [
    { icon: <Wand2 size={20} />, title: 'AI Description Polish', desc: 'Turn rough notes into compelling product copy in one click.' },
    { icon: <Tag size={20} />, title: 'Smart Tag Generator', desc: 'Auto-generate SEO tags so your products get discovered.' },
    { icon: <MessageCircle size={20} />, title: 'WhatsApp Commerce', desc: 'Manage supported store tasks by chatting with AI on WhatsApp.' },
    { icon: <Mic size={20} />, title: 'Voice Assistant', desc: 'Talk to your AI co-pilot for supported store tasks.' },
    { icon: <LineChart size={20} />, title: 'Insights On Demand', desc: 'Ask "How are sales this week?" and get instant answers.' },
    { icon: <Megaphone size={20} />, title: 'Marketing Help', desc: 'AI drafts coupons, promotions, and customer broadcasts.' },
  ];

  const features = [
    'Full store dashboard with real-time analytics',
    'Unlimited product listings & inventory control',
    'AI product description & smart tagging',
    'WhatsApp store management with AI',
    'Voice-powered AI assistant',
    'Stripe-powered secure checkout',
    'Multi-currency support (USD, EUR, GBP, PKR)',
    'Custom store subdomain (yourstore.rozare.com)',
    'Order management & shipping tools',
    'Coupon & discount engine',
    'Push & WhatsApp notifications',
    'Mobile app support for sellers (iOS & Android)',
  ];

  return (
    <div className="min-h-screen py-12 px-4">
      <SEOHead
        title="Become a Seller for Free — Start Selling Online"
        description="Join Rozare as a seller for free. Create your online store, list products, manage orders, track sales analytics, and use a professional seller dashboard with powerful tools plus AI chat on the website and WhatsApp."
        canonical="/become-seller"
        keywords="become a seller, sell online, start selling online, open online store, online store free trial, rozare seller, sell products online, e-commerce seller, online business, start online business, vendor registration, seller signup, seller account, sell from home, side hustle, make money online, dropshipping, sell handmade products, sell crafts online, sell electronics online, sell fashion online, online shop owner"
        jsonLd={{
            '@context': 'https://schema.org',
            '@type': 'WebPage',
            name: 'Become a Seller on Rozare',
            description: 'Become a seller on Rozare for free, create your online store, and manage your business with a professional dashboard, AI chat, and WhatsApp workflows.',
            url: 'https://rozare.com/become-seller',
            potentialAction: {
                '@type': 'RegisterAction',
                name: 'Register as Seller',
                target: 'https://rozare.com/become-seller',
            },
        }}
      />
      <div className="max-w-4xl mx-auto">
        <button onClick={() => {
          if (formStep === 0.5 || formStep === 0) navigate(-1);
          else if (formStep === 0.6) setFormStep(0.5);
          else if (formStep === 1) setFormStep(0);
          else setFormStep(formStep - 1);
        }} className="flex items-center gap-2 mb-6 transition-colors text-sm font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>
          <ArrowLeft size={20} /> <span>Back</span>
        </button>

        {/* Header */}
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <div className="p-4 rounded-full shadow-lg" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', boxShadow: '0 0 30px -4px hsl(220, 70%, 55%, 0.4)' }}>
              <Store size={48} className="text-white" />
            </div>
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight mb-3" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            Become a Seller for Free
          </h1>
          <p className="text-lg max-w-2xl mx-auto mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
            Get a professional dashboard with powerful tools and <span className="font-semibold" style={{ color: 'hsl(280, 70%, 60%)' }}>manage your whole store by just chatting with AI</span> on the website or even on WhatsApp.
          </p>
          <p className="text-xl font-bold" style={{ color: 'hsl(150, 60%, 45%)' }}>
            <Sparkles size={18} className="inline mr-1" /> Start and grow your ecommerce business for free.
          </p>
        </motion.div>

        {formStep === 0 && (
          <>
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="grid md:grid-cols-3 gap-6 mb-8">
              {benefits.map((b, i) => (
                <motion.div key={i} whileHover={{ y: -4 }} className="glass-card p-6 text-center">
                  <div className="glass-inner w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4" style={{ color: b.color }}>{b.icon}</div>
                  <h3 className="text-xl font-bold mb-2" style={{ color: 'hsl(var(--foreground))' }}>{b.title}</h3>
                  <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>{b.description}</p>
                </motion.div>
              ))}
            </motion.div>

            {/* AI Superpowers — the headline differentiator */}
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}
              className="glass-panel p-8 mb-8 relative overflow-hidden">
              <div className="absolute -top-16 -right-16 w-64 h-64 rounded-full opacity-20 pointer-events-none"
                style={{ background: 'radial-gradient(circle, hsl(280, 70%, 60%), transparent 70%)' }} />
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 rounded-xl" style={{ background: 'linear-gradient(135deg, hsl(280, 70%, 60%), hsl(220, 70%, 55%))' }}>
                  <Bot size={22} className="text-white" />
                </div>
                <span className="text-xs font-bold uppercase tracking-widest px-2 py-1 rounded-full" style={{ background: 'hsl(280, 70%, 60%, 0.15)', color: 'hsl(280, 70%, 60%)' }}>AI Powered</span>
              </div>
              <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight mb-2" style={{ color: 'hsl(var(--foreground))' }}>
                Your AI Co-Pilot for Selling
              </h2>
              <p className="text-sm sm:text-base mb-6 max-w-2xl" style={{ color: 'hsl(var(--muted-foreground))' }}>
                Use the seller dashboard when you want hands-on control, or just <span className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>tell Rozare AI what you want</span> — in the app, by voice, or even on WhatsApp — and it gets done.
              </p>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {aiSuperpowers.map((s, i) => (
                  <motion.div key={i} whileHover={{ y: -3 }} className="glass-inner p-4 rounded-2xl">
                    <div className="flex items-center gap-2 mb-2" style={{ color: 'hsl(280, 70%, 60%)' }}>
                      {s.icon}
                      <h4 className="font-bold text-sm" style={{ color: 'hsl(var(--foreground))' }}>{s.title}</h4>
                    </div>
                    <p className="text-xs leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>{s.desc}</p>
                  </motion.div>
                ))}
              </div>
            </motion.div>

            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="glass-panel p-8 mb-8">
              <h2 className="text-2xl font-bold mb-6 flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                <Sparkles size={24} style={{ color: 'hsl(45, 93%, 47%)' }} /> What You'll Get
              </h2>
              <div className="grid sm:grid-cols-2 gap-4">
                {features.map((f, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <CheckCircle size={20} style={{ color: 'hsl(150, 60%, 45%)' }} className="shrink-0" />
                    <span className="text-sm" style={{ color: 'hsl(var(--foreground))' }}>{f}</span>
                  </div>
                ))}
              </div>
            </motion.div>

            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}
              className="rounded-2xl p-8 text-center text-white" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', boxShadow: '0 0 40px -8px hsl(220, 70%, 55%, 0.4)' }}>
              <h2 className="text-3xl font-bold mb-4">Ready to Start Selling?</h2>
              <p className="text-white/90 mb-2 max-w-2xl mx-auto text-lg">Click below to provide your details and activate your seller account!</p>
              <p className="font-semibold text-xl mb-6" style={{ color: 'hsl(45, 93%, 70%)' }}>
                <Sparkles size={18} className="inline mr-1" /> Start and grow your ecommerce business for free.
              </p>
              <motion.button onClick={handleGetStarted} whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                className="font-bold text-lg px-12 py-4 rounded-full shadow-lg hover:shadow-xl transition-all inline-flex items-center gap-3"
                style={{ background: 'white', color: 'hsl(220, 70%, 55%)' }}>
                <Store size={24} /> {isExistingSellerAccount ? 'Open Dashboard' : 'Get Started'}
              </motion.button>
            </motion.div>
          </>
        )}

        {/* Step 0.5: Guest Signup (Upwork-style inline registration) */}
        {formStep === 0.5 && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="glass-panel p-8 max-w-md mx-auto">
            <div className="text-center mb-6">
              <h2 className="text-2xl font-bold mb-2" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                Create Your Account
              </h2>
              <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                Sign up to get started as a seller on Rozare
              </p>
            </div>

            {/* Continue with Google */}
            <motion.button onClick={handleGoogleSignup} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
              className="w-full py-3 px-4 rounded-xl font-semibold flex items-center justify-center gap-3 mb-5 border transition-colors"
              style={{ background: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}>
              <svg width="20" height="20" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Continue with Google
            </motion.button>

            {/* Divider */}
            <div className="flex items-center gap-3 mb-5">
              <div className="flex-1 h-px" style={{ background: 'hsl(var(--border))' }}></div>
              <span className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>or sign up with email</span>
              <div className="flex-1 h-px" style={{ background: 'hsl(var(--border))' }}></div>
            </div>

            {/* Email/Password form */}
            <form onSubmit={handleGuestSignup} className="space-y-4">
              <div>
                <label className="flex text-xs font-semibold uppercase tracking-wider mb-2 items-center gap-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  <UserIcon size={14} style={{ color: 'hsl(var(--primary))' }} /> Full Name <span style={{ color: 'hsl(0, 72%, 55%)' }}>*</span>
                </label>
                <input type="text" name="username" value={signupData.username} onChange={handleSignupChange}
                  placeholder="Your full name" className="glass-input" required minLength={2} />
              </div>
              <div>
                <label className="flex text-xs font-semibold uppercase tracking-wider mb-2 items-center gap-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  <Mail size={14} style={{ color: 'hsl(var(--primary))' }} /> Email <span style={{ color: 'hsl(0, 72%, 55%)' }}>*</span>
                </label>
                <input type="email" name="email" value={signupData.email} onChange={handleSignupChange}
                  placeholder="you@example.com" className="glass-input" required />
              </div>
              <div>
                <label className="flex text-xs font-semibold uppercase tracking-wider mb-2 items-center gap-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  <Lock size={14} style={{ color: 'hsl(var(--primary))' }} /> Password <span style={{ color: 'hsl(0, 72%, 55%)' }}>*</span>
                </label>
                <input type="password" name="password" value={signupData.password} onChange={handleSignupChange}
                  placeholder="At least 6 characters" className="glass-input" required minLength={6} />
              </div>
              {formError && formStep === 0.5 && (
                <div className="p-3 rounded-lg text-sm font-medium" style={{ background: 'hsla(0, 72%, 55%, 0.08)', color: 'hsl(0, 72%, 55%)', border: '1px solid hsla(0, 72%, 55%, 0.15)' }}>{formError}</div>
              )}
              <motion.button type="submit" disabled={signupLoading} whileHover={{ scale: signupLoading ? 1 : 1.02 }} whileTap={{ scale: signupLoading ? 1 : 0.98 }}
                className="w-full py-3 px-6 rounded-xl font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}>
                {signupLoading ? <><div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Sending code...</> : <>Continue <ArrowRight size={18} /></>}
              </motion.button>
            </form>

            {/* Login link */}
            <p className="text-center mt-5 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
              Already have an account?{' '}
              <button onClick={() => navigate('/login?redirect=/become-seller')} className="font-semibold underline" style={{ color: 'hsl(var(--primary))' }}>
                Log in
              </button>
            </p>
          </motion.div>
        )}

        {/* Step 0.6: Email OTP Verification */}
        {formStep === 0.6 && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="glass-panel p-8 max-w-md mx-auto">
            <div className="text-center mb-6">
              <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-3"
                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', color: '#fff' }}>
                <Mail size={28} />
              </div>
              <h2 className="text-2xl font-bold mb-2" style={{ color: 'hsl(var(--foreground))' }}>Verify Your Email</h2>
              <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                We sent a 6-digit code to <strong style={{ color: 'hsl(var(--foreground))' }}>{signupData.email}</strong>
              </p>
            </div>

            <form onSubmit={handleVerifyEmailOtp} className="space-y-4">
              <div>
                <input type="text" value={emailOtp} onChange={(e) => setEmailOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="glass-input text-center text-2xl font-bold tracking-widest" placeholder="000000" maxLength={6} autoFocus />
              </div>

              {/* Countdown */}
              {emailOtpCountdown > 0 && (
                <div className="text-center">
                  <p className="text-xs" style={{ color: emailOtpCountdown <= 60 ? 'hsl(0, 72%, 55%)' : 'hsl(var(--muted-foreground))' }}>
                    Code expires in <span className="font-bold">{formatCountdown(emailOtpCountdown)}</span>
                  </p>
                </div>
              )}
              {emailOtpCountdown === 0 && emailOtpSent && (
                <div className="text-center">
                  <p className="text-xs font-medium" style={{ color: 'hsl(0, 72%, 55%)' }}>Code expired. Please request a new one.</p>
                </div>
              )}

              {formError && formStep === 0.6 && (
                <div className="p-3 rounded-lg text-sm font-medium" style={{ background: 'hsla(0, 72%, 55%, 0.08)', color: 'hsl(0, 72%, 55%)', border: '1px solid hsla(0, 72%, 55%, 0.15)' }}>{formError}</div>
              )}
              <motion.button type="submit" disabled={emailVerifying || emailOtp.length !== 6 || emailOtpCountdown === 0}
                whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                className="w-full py-3 px-6 rounded-xl font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}>
                {emailVerifying ? <><div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Verifying...</> : <>Verify & Continue <ArrowRight size={18} /></>}
              </motion.button>
            </form>

            {/* Resend */}
            <div className="text-center mt-4">
              {emailResendCooldown > 0 ? (
                <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  Resend available in <span className="font-bold">{emailResendCooldown}s</span>
                </p>
              ) : (
                <button type="button" onClick={handleResendEmailOtp} disabled={signupLoading}
                  className="text-xs font-medium underline disabled:opacity-50" style={{ color: 'hsl(var(--primary))' }}>
                  {signupLoading ? 'Sending...' : 'Resend Code'}
                </button>
              )}
            </div>

            {/* Back to edit email */}
            <div className="text-center mt-3">
              <button type="button" onClick={() => { setFormStep(0.5); setEmailOtp(''); setEmailOtpCountdown(0); }}
                className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>
                ← Change email address
              </button>
            </div>
          </motion.div>
        )}

        {/* Step 1: Seller Info */}
        {formStep === 1 && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="glass-panel p-8">
            <h2 className="text-3xl font-bold mb-2 text-center" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Seller Information</h2>
            <p className="text-center mb-6 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>Please provide your contact details</p>
            <form onSubmit={handleStep1Next} className="space-y-6">
              <div>
                <label className="flex text-xs font-semibold uppercase tracking-wider mb-2 items-center gap-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  <Phone size={14} style={{ color: 'hsl(var(--primary))' }} /> WhatsApp Number <span style={{ color: 'hsl(0, 72%, 55%)' }}>*</span>
                </label>
                <PhoneField
                  name="phoneNumber"
                  value={formData.phoneNumber}
                  onChange={(v) => { setFormData((prev) => ({ ...prev, phoneNumber: v || '' })); if (whatsappVerified) { setWhatsappVerified(false); setWhatsappCodeSent(false); setWhatsappOtp(''); } }}
                  profileCountry={formData.country}
                  required
                  placeholder="WhatsApp number"
                />
                <p className="text-[11px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>We'll send order notifications on this number. You'll verify it in the final step.</p>
              </div>
              <div>
                <label className="flex text-xs font-semibold uppercase tracking-wider mb-2 items-center gap-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  <Store size={14} style={{ color: 'hsl(var(--primary))' }} /> Business Name (Optional)
                </label>
                <input type="text" name="businessName" value={formData.businessName} onChange={handleInputChange} placeholder="Your business or brand name" className="glass-input" maxLength={100} />
              </div>
              <div>
                <label className="flex text-xs font-semibold uppercase tracking-wider mb-2 items-center gap-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  <MapPin size={14} style={{ color: 'hsl(var(--primary))' }} /> Address <span style={{ color: 'hsl(0, 72%, 55%)' }}>*</span>
                </label>
                <input type="text" name="address" value={formData.address} onChange={handleInputChange} placeholder="Street address" className="glass-input" required />
              </div>
              <div className="grid sm:grid-cols-2 gap-4">
                <LocationAutocomplete
                  type="country"
                  label="Country"
                  value={formData.country}
                  code={formData.countryCode}
                  placeholder="Select country"
                  required
                  onSelect={(option) => {
                    setFormData(prev => ({
                      ...prev,
                      country: option.name,
                      countryCode: option.isoCode,
                      state: '',
                      stateCode: '',
                      city: '',
                    }));
                    setFormError('');
                  }}
                  onClear={() => setFormData(prev => ({ ...prev, country: '', countryCode: '', state: '', stateCode: '', city: '' }))}
                />
                <LocationAutocomplete
                  type="state"
                  label="State/Province"
                  value={formData.state}
                  code={formData.stateCode}
                  countryCode={formData.countryCode}
                  countryName={formData.country}
                  placeholder="Select state"
                  disabled={!formData.country && !formData.countryCode}
                  onSelect={(option) => {
                    setFormData(prev => ({ ...prev, state: option.name, stateCode: option.isoCode, city: '' }));
                    setFormError('');
                  }}
                  onClear={() => setFormData(prev => ({ ...prev, state: '', stateCode: '', city: '' }))}
                />
              </div>
              <LocationAutocomplete
                type="city"
                label="City"
                value={formData.city}
                code={formData.stateCode}
                countryCode={formData.countryCode}
                countryName={formData.country}
                stateCode={formData.stateCode}
                stateName={formData.state}
                placeholder="Select city"
                disabled={!formData.country && !formData.countryCode}
                required
                onSelect={(option) => {
                  setFormData(prev => ({
                    ...prev,
                    city: option.name,
                    stateCode: prev.stateCode || option.stateCode || '',
                  }));
                  setFormError('');
                }}
                onClear={() => setFormData(prev => ({ ...prev, city: '' }))}
              />
              {formError && formStep === 1 && (
                <div className="p-3 rounded-lg text-sm font-medium" style={{ background: 'hsla(0, 72%, 55%, 0.08)', color: 'hsl(0, 72%, 55%)', border: '1px solid hsla(0, 72%, 55%, 0.15)' }}>{formError}</div>
              )}
              <button type="submit" className="w-full py-3 px-6 rounded-xl font-bold text-white flex items-center justify-center gap-2"
                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}>
                Next: Store Setup <ArrowRight size={18} />
              </button>
            </form>
          </motion.div>
        )}

        {/* Step 2: Store Setup (Required) */}
        {formStep === 2 && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="glass-panel p-8">
            <h2 className="text-3xl font-bold mb-2 text-center" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Set Up Your Store</h2>
            <p className="text-center mb-6 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>Choose your store name and tell customers about your brand</p>
            <div className="space-y-5">
              {/* Store Name - Required */}
              <div>
                <label className="flex text-xs font-semibold uppercase tracking-wider mb-2 items-center gap-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  <Store size={14} style={{ color: 'hsl(var(--primary))' }} /> Store / Brand Name <span style={{ color: 'hsl(0, 72%, 55%)' }}>*</span>
                </label>
                <input type="text" name="storeName" value={storeData.storeName} onChange={handleStoreNameChange}
                  placeholder="Your store or brand name" className="glass-input" maxLength={50} required />

                {/* Live Subdomain Preview */}
                {storeSlugPreview && (
                  <div className="mt-2.5 p-3 rounded-lg" style={{ background: 'hsla(220, 70%, 55%, 0.04)', border: '1px solid hsla(220, 70%, 55%, 0.12)' }}>
                    <p className="text-xs font-medium mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Your store URL will be:</p>
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-bold" style={{ color: 'hsl(var(--primary))' }}>{storeSlugPreview}</span>
                      <span className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>.rozare.com</span>
                      {storeNameChecking && (
                        <Loader2 size={14} className="animate-spin ml-2" style={{ color: 'hsl(var(--muted-foreground))' }} />
                      )}
                      {!storeNameChecking && storeNameAvailable === true && (
                        <CheckCircle size={14} className="ml-2" style={{ color: 'hsl(150, 60%, 40%)' }} />
                      )}
                      {!storeNameChecking && storeNameAvailable === false && (
                        <AlertCircle size={14} className="ml-2" style={{ color: 'hsl(0, 72%, 55%)' }} />
                      )}
                    </div>
                    {/* Availability message */}
                    {!storeNameChecking && storeNameAvailable === true && (
                      <p className="text-[11px] mt-1.5 font-medium" style={{ color: 'hsl(150, 60%, 40%)' }}>Available!</p>
                    )}
                    {!storeNameChecking && storeNameAvailable === false && (
                      <p className="text-[11px] mt-1.5 font-medium" style={{ color: 'hsl(0, 72%, 55%)' }}>{storeNameError}</p>
                    )}
                    {storeNameChecking && (
                      <p className="text-[11px] mt-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}>Checking availability...</p>
                    )}
                  </div>
                )}
                {storeNameError && !storeSlugPreview && (
                  <p className="text-[11px] mt-1.5" style={{ color: 'hsl(0, 72%, 55%)' }}>{storeNameError}</p>
                )}
              </div>

              {/* Store Description - Required */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  Store Description <span style={{ color: 'hsl(0, 72%, 55%)' }}>*</span>
                </label>
                <textarea name="storeDescription" value={storeData.storeDescription} onChange={handleStoreChange}
                  placeholder="Tell customers what you sell and what makes your store special..." className="glass-input"
                  maxLength={500} rows={3} style={{ resize: 'none' }} required />
                <p className="text-[11px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  {storeData.storeDescription.length}/500 characters (minimum 10)
                </p>
              </div>

              {/* Product listing currency - persisted as the store's native price currency */}
              <div>
                <label className="flex text-xs font-semibold uppercase tracking-wider mb-2 items-center gap-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  <CreditCard size={14} style={{ color: 'hsl(var(--primary))' }} /> Product Listing Currency <span style={{ color: 'hsl(0, 72%, 55%)' }}>*</span>
                </label>
                <select
                  name="productCurrency"
                  value={storeData.productCurrency}
                  onChange={handleProductCurrencyChange}
                  className="glass-input"
                  required
                >
                  {SELLER_PRODUCT_CURRENCY_CODES.map(code => (
                    <option key={code} value={code}>
                      {code} · {currencies?.[code]?.name || code}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] mt-1.5 leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  Enter and save all product prices in this currency. Buyers can still view and pay in another supported currency using the checkout conversion rate.
                </p>
              </div>

              {/* Website - Optional */}
              <div>
                <label className="flex text-xs font-semibold uppercase tracking-wider mb-2 items-center gap-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  <Globe size={14} style={{ color: 'hsl(var(--primary))' }} /> Website <span className="normal-case font-normal">(optional)</span>
                </label>
                <input type="text" name="website" value={storeData.website} onChange={handleStoreChange} placeholder="yourwebsite.com or full link" className="glass-input" />
              </div>

              {/* Social Links - Optional */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="flex text-xs font-medium mb-1.5 items-center gap-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}><Instagram size={13} /> Instagram</label>
                  <input type="text" name="instagram" value={storeData.instagram} onChange={handleStoreChange} className="glass-input text-sm" placeholder="@handle or full link" />
                </div>
                <div>
                  <label className="flex text-xs font-medium mb-1.5 items-center gap-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}><Facebook size={13} /> Facebook</label>
                  <input type="text" name="facebook" value={storeData.facebook} onChange={handleStoreChange} className="glass-input text-sm" placeholder="page name or full link" />
                </div>
                <div>
                  <label className="flex text-xs font-medium mb-1.5 items-center gap-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}><Twitter size={13} /> Twitter / X</label>
                  <input type="text" name="twitter" value={storeData.twitter} onChange={handleStoreChange} className="glass-input text-sm" placeholder="@handle or full link" />
                </div>
                <div>
                  <label className="flex text-xs font-medium mb-1.5 items-center gap-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}><Youtube size={13} /> YouTube</label>
                  <input type="text" name="youtube" value={storeData.youtube} onChange={handleStoreChange} className="glass-input text-sm" placeholder="@channel or full link" />
                </div>
                <div>
                  <label className="flex text-xs font-medium mb-1.5 items-center gap-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}>TikTok</label>
                  <input type="text" name="tiktok" value={storeData.tiktok} onChange={handleStoreChange} className="glass-input text-sm" placeholder="@handle or full link" />
                </div>
              </div>
            </div>
            <div className="mt-8 space-y-3">
              {formError && formStep === 2 && (
                <div className="p-3 rounded-lg text-sm font-medium" style={{ background: 'hsla(0, 72%, 55%, 0.08)', color: 'hsl(0, 72%, 55%)', border: '1px solid hsla(0, 72%, 55%, 0.15)' }}>{formError}</div>
              )}
              <motion.button onClick={() => handleStep2Next()} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                disabled={storeNameChecking || storeNameAvailable === false}
                className="w-full py-3 px-6 rounded-xl font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}>
                Next: Verify WhatsApp <ArrowRight size={18} />
              </motion.button>
            </div>
          </motion.div>
        )}

        {/* Step 3: WhatsApp Verification (MANDATORY) */}
        {formStep === 3 && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="glass-panel p-8 max-w-md mx-auto">
            <div className="text-center mb-4">
              <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-3"
                style={{ background: 'linear-gradient(135deg, hsl(150, 70%, 40%), hsl(170, 70%, 38%))', color: '#fff' }}>
                <MessageCircle size={28} />
              </div>
              <h2 className="text-2xl font-bold mb-1" style={{ color: 'hsl(var(--foreground))' }}>Verify WhatsApp</h2>
              <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                Verify your WhatsApp number to activate your seller account
              </p>
            </div>

            {/* Show number with edit */}
            <div className="p-4 rounded-xl mb-4" style={{ background: 'hsla(220, 70%, 55%, 0.06)', border: '1px solid hsla(220, 70%, 55%, 0.15)' }}>
              {editingNumber ? (
                <div className="space-y-2">
                  <label className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>Edit WhatsApp Number</label>
                  <PhoneField
                    value={formData.phoneNumber}
                    onChange={(v) => { setFormData(prev => ({ ...prev, phoneNumber: v || '' })); setWhatsappVerified(false); setWhatsappCodeSent(false); setWhatsappOtp(''); setOtpCountdown(0); }}
                    profileCountry={formData.country}
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
                    <p className="text-lg font-bold" style={{ color: 'hsl(var(--foreground))' }}>{formData.phoneNumber || '—'}</p>
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
                {formError && formStep === 3 && (
                  <div className="p-3 rounded-lg text-sm font-medium mb-3" style={{ background: 'hsla(0, 72%, 55%, 0.08)', color: 'hsl(0, 72%, 55%)', border: '1px solid hsla(0, 72%, 55%, 0.15)' }}>{formError}</div>
                )}
                <motion.button onClick={handleBecomeSeller} disabled={loading} whileHover={{ scale: loading ? 1 : 1.02 }} whileTap={{ scale: loading ? 1 : 0.98 }}
                  className="w-full py-3 px-6 rounded-xl font-bold text-white disabled:opacity-50 flex items-center justify-center gap-2"
                  style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}>
                  {loading ? <><div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Activating...</> : <><Store size={20} /> Activate Seller Account</>}
                </motion.button>
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
                  disabled={whatsappSending || !formData.phoneNumber || !isValidPhone(formData.phoneNumber)}
                  className="w-full py-3 rounded-xl text-sm font-bold text-white disabled:opacity-50 inline-flex items-center justify-center gap-2"
                  style={{ background: 'linear-gradient(135deg, hsl(150, 70%, 40%), hsl(170, 70%, 38%))' }}>
                  <MessageCircle size={16} /> {whatsappSending ? 'Sending...' : 'Send Verification Code'}
                </button>
                {whatsappError && <p className="text-xs text-center" style={{ color: 'hsl(0, 72%, 55%)' }}>{whatsappError}</p>}
              </div>
            )}
          </motion.div>
        )}
      </div>
    </div>
  );
}
