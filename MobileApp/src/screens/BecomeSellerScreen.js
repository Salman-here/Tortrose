/**
 * BecomeSellerScreen
 *
 * Mirrors the website seller journey:
 * landing -> account/email verification (guests only) -> seller details ->
 * required store setup + name availability -> WhatsApp OTP -> activation.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Feedback from '../utils/feedback';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useTheme } from '../contexts/ThemeContext';
import { getStorefrontHost } from '../utils/storefrontUrl';
import { secureSet } from '../utils/secureStorage';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import AuthTopHeader from '../components/common/AuthTopHeader';
import GoogleSignInButton from '../components/common/GoogleSignInButton';
import LocationAutocomplete from '../components/common/LocationAutocomplete';
import KeyboardAwareFormScrollView from '../components/common/KeyboardAwareFormScrollView';
import PhoneNumberInput from '../components/common/PhoneNumberInput';
import { borderRadius, fontSize, fontWeight, spacing } from '../styles/theme';
import { isValidPhoneNumber as isValidPhone } from '../utils/phoneNumber';
import { resolveBuyerLocation } from '../utils/buyerLocation';
import useOtpCountdown from '../hooks/useOtpCountdown';

const SELLER_STEPS = [
  { key: 'details', label: 'Details' },
  { key: 'store', label: 'Store' },
  { key: 'whatsapp', label: 'Verify' },
];

const SELLER_PRODUCT_CURRENCY_CODES = ['USD', 'PKR', 'EUR', 'GBP'];
const normalizeSellerProductCurrency = value => {
  const code = String(value || '').trim().toUpperCase();
  return SELLER_PRODUCT_CURRENCY_CODES.includes(code) ? code : 'USD';
};

const generateSlug = (value) => String(value || '')
  .toLowerCase()
  .trim()
  .replace(/[^\w\s-]/g, '')
  .replace(/\s+/g, '-')
  .replace(/-+/g, '-');

export default function BecomeSellerScreen({ navigation }) {
  const { palette, isDark } = useTheme();
  const styles = buildStyles(palette);
  const {
    currentUser,
    signup,
    verifyOTP,
    googleSignIn,
    fetchAndUpdateCurrentUser,
  } = useAuth();
  const { currency: accountCurrency, currencies } = useCurrency();

  const [flowStep, setFlowStep] = useState('landing');
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [accountData, setAccountData] = useState({ username: '', email: '', password: '' });
  const [emailOtp, setEmailOtp] = useState('');
  const [emailSending, setEmailSending] = useState(false);
  const [emailVerifying, setEmailVerifying] = useState(false);

  const [formData, setFormData] = useState({
    phoneNumber: '',
    address: '',
    city: '',
    state: '',
    stateCode: '',
    country: '',
    countryCode: '',
    businessName: '',
  });
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
  const [storeNameAvailable, setStoreNameAvailable] = useState(null);
  const [storeNameChecking, setStoreNameChecking] = useState(false);
  const [storeNameError, setStoreNameError] = useState('');

  const [whatsappOtp, setWhatsappOtp] = useState('');
  const [whatsappCodeSent, setWhatsappCodeSent] = useState(false);
  const [whatsappVerified, setWhatsappVerified] = useState(false);
  const [whatsappSending, setWhatsappSending] = useState(false);
  const [whatsappVerifying, setWhatsappVerifying] = useState(false);
  const [whatsappError, setWhatsappError] = useState('');
  const [editingNumber, setEditingNumber] = useState(false);
  const emailOtpTimer = useOtpCountdown({ expirySeconds: 600, resendSeconds: 60 });
  const whatsappOtpTimer = useOtpCountdown({ expirySeconds: 120, resendSeconds: 30 });
  const otpCountdown = whatsappOtpTimer.expiryRemaining;
  const resendCooldown = whatsappOtpTimer.resendRemaining;

  useEffect(() => {
    if (currentUser?.role === 'seller') {
      navigation.replace('SellerDashboard');
    } else if (currentUser?.role === 'admin') {
      navigation.replace('MainTabs');
    }
  }, [currentUser, navigation]);

  // Account currency can arrive after the profile refresh. Track it as the
  // visible default only until the seller explicitly chooses the store's
  // native listing currency.
  useEffect(() => {
    if (productCurrencyTouchedRef.current) return;
    const productCurrency = normalizeSellerProductCurrency(currentUser?.currency || accountCurrency);
    setStoreData(previous => (
      previous.productCurrency === productCurrency
        ? previous
        : { ...previous, productCurrency }
    ));
  }, [accountCurrency, currentUser?.currency]);

  useEffect(() => {
    let active = true;
    const profileLocation = currentUser?.sellerInfo?.countryCode || currentUser?.sellerInfo?.country
      ? currentUser.sellerInfo
      : currentUser?.savedShippingInfo;
    Promise.resolve(profileLocation || resolveBuyerLocation())
      .then((location) => {
        const resolved = location || { country: 'Pakistan', countryCode: 'PK' };
        if (!active || (!resolved.countryCode && !resolved.country)) return;
        setFormData(previous => previous.countryCode || previous.country ? previous : {
          ...previous,
          country: resolved.country || '',
          countryCode: resolved.countryCode || '',
        });
      })
      .catch(() => {});
    return () => { active = false; };
  }, [currentUser]);

  const storeSlug = useMemo(() => generateSlug(storeData.storeName), [storeData.storeName]);

  useEffect(() => {
    if (flowStep !== 'store') return undefined;
    if (!storeSlug || storeSlug.length < 3) {
      setStoreNameAvailable(null);
      setStoreNameChecking(false);
      setStoreNameError(storeSlug ? 'Store name must be at least 3 characters' : '');
      return undefined;
    }

    setStoreNameChecking(true);
    setStoreNameAvailable(null);
    setStoreNameError('');
    const timer = setTimeout(async () => {
      try {
        const res = await api.get(`/api/stores/check-subdomain/${encodeURIComponent(storeSlug)}`);
        const available = Boolean(res.data?.available);
        setStoreNameAvailable(available);
        setStoreNameError(available ? '' : (res.data?.msg || 'This store name is already taken'));
      } catch {
        setStoreNameAvailable(null);
        setStoreNameError('Could not check store name. Try again.');
      } finally {
        setStoreNameChecking(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [flowStep, storeSlug]);

  const sellerStepIndex = SELLER_STEPS.findIndex(step => step.key === flowStep);
  const headerTitle = flowStep === 'landing' ? 'Become a Seller' : flowStep === 'account' || flowStep === 'emailOtp' ? 'Seller Account' : 'Seller Setup';
  const headerSubtitle = flowStep === 'landing'
    ? 'Build your store with Rozare AI'
    : flowStep === 'account'
      ? 'Create your Rozare account'
      : flowStep === 'emailOtp'
        ? 'Verify your email'
        : `${SELLER_STEPS[sellerStepIndex]?.label || 'Setup'} · Step ${sellerStepIndex + 1} of 3`;

  const handleHeaderBack = () => {
    setFormError('');
    setWhatsappError('');
    if (flowStep === 'landing') navigation.goBack();
    else if (flowStep === 'account') setFlowStep('landing');
    else if (flowStep === 'emailOtp') setFlowStep('account');
    else if (flowStep === 'details') setFlowStep('landing');
    else if (flowStep === 'store') setFlowStep('details');
    else if (flowStep === 'whatsapp') setFlowStep('store');
  };

  const handleGetStarted = () => {
    if (currentUser) setFlowStep('details');
    else setFlowStep('account');
    setFormError('');
  };

  const handleGuestSignup = async () => {
    if (flowStep === 'emailOtp' && !emailOtpTimer.canResend) return;
    setFormError('');
    if (accountData.username.trim().length < 2) {
      setFormError('Please enter a valid full name.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(accountData.email.trim())) {
      setFormError('Please enter a valid email address.');
      return;
    }
    if (accountData.password.length < 6) {
      setFormError('Password must be at least 6 characters.');
      return;
    }

    setEmailSending(true);
    const result = await signup({
      username: accountData.username.trim(),
      email: accountData.email.trim(),
      password: accountData.password,
    });
    setEmailSending(false);
    if (result?.success) {
      emailOtpTimer.start();
      setFlowStep('emailOtp');
    }
    else setFormError(result?.error || 'Failed to send the verification code.');
  };

  const handleVerifyEmail = async () => {
    if (!/^\d{6}$/.test(emailOtp)) {
      setFormError('Enter the 6-digit code sent to your email.');
      return;
    }
    if (emailOtpTimer.isExpired) {
      setFormError('This verification code has expired. Request a new one.');
      return;
    }
    setEmailVerifying(true);
    setFormError('');
    const result = await verifyOTP({ email: accountData.email.trim(), otp: emailOtp });
    setEmailVerifying(false);
    if (result?.success) setFlowStep('details');
    else setFormError(result?.error || 'Invalid or expired verification code.');
  };

  const handleGoogleSellerSignup = async () => {
    setEmailSending(true);
    setFormError('');
    const result = await googleSignIn();
    setEmailSending(false);
    if (result?.success) setFlowStep('details');
    else if (result?.error) setFormError(result.error);
  };

  const validateDetails = () => {
    if (!isValidPhone(formData.phoneNumber)) return 'Enter a valid phone number with 10 to 15 digits.';
    if (formData.address.trim().length < 5) return 'Enter a valid street address.';
    if (!formData.country || !formData.countryCode) return 'Select your country from the list.';
    if (formData.city.trim().length < 2) return 'Select your city from the list.';
    return '';
  };

  const handleDetailsNext = () => {
    const error = validateDetails();
    if (error) {
      setFormError(error);
      return;
    }
    setFormError('');
    setFlowStep('store');
  };

  const handleStoreNext = () => {
    setFormError('');
    if (storeData.storeName.trim().length < 3) {
      setFormError('Store name is required and must be at least 3 characters.');
      return;
    }
    if (storeData.storeDescription.trim().length < 10) {
      setFormError('Store description is required and must be at least 10 characters.');
      return;
    }
    if (!SELLER_PRODUCT_CURRENCY_CODES.includes(storeData.productCurrency)) {
      setFormError('Choose USD, PKR, EUR, or GBP for your product prices.');
      return;
    }
    if (storeNameChecking) {
      setFormError('Please wait while we check your store name.');
      return;
    }
    if (storeNameAvailable !== true) {
      setFormError(storeNameError || 'Choose an available store name before continuing.');
      return;
    }
    setFlowStep('whatsapp');
  };

  const resetWhatsAppVerification = () => {
    setWhatsappVerified(false);
    setWhatsappCodeSent(false);
    setWhatsappOtp('');
    whatsappOtpTimer.clear();
    setWhatsappError('');
  };

  const handleSendWhatsAppOtp = async () => {
    if (whatsappCodeSent && !whatsappOtpTimer.canResend) return;
    if (!isValidPhone(formData.phoneNumber)) {
      setWhatsappError('Enter a valid WhatsApp number first.');
      return;
    }
    setWhatsappSending(true);
    setWhatsappError('');
    try {
      await api.post('/api/seller-whatsapp/send-otp', { whatsappNumber: formData.phoneNumber.trim() });
      setWhatsappCodeSent(true);
      setWhatsappOtp('');
      whatsappOtpTimer.start();
      setEditingNumber(false);
    } catch (error) {
      const status = error.response?.status;
      if (status === 503) setWhatsappError('WhatsApp verification is temporarily unavailable. Please try again later.');
      else if (status === 429) setWhatsappError(error.response?.data?.msg || 'Too many attempts. Please try again later.');
      else if (status === 409) setWhatsappError(error.response?.data?.msg || 'This number is already linked to another seller.');
      else setWhatsappError(error.response?.data?.message || error.response?.data?.msg || 'Failed to send the verification code.');
    } finally {
      setWhatsappSending(false);
    }
  };

  const handleVerifyWhatsApp = async () => {
    if (!/^\d{6}$/.test(whatsappOtp) || otpCountdown <= 0) return;
    setWhatsappVerifying(true);
    setWhatsappError('');
    try {
      await api.post('/api/seller-whatsapp/verify-otp', {
        whatsappNumber: formData.phoneNumber.trim(),
        otp: whatsappOtp,
      });
      setWhatsappVerified(true);
      setWhatsappCodeSent(false);
      setWhatsappOtp('');
      whatsappOtpTimer.clear();
    } catch (error) {
      setWhatsappError(error.response?.data?.message || error.response?.data?.msg || 'Invalid code. Please try again.');
    } finally {
      setWhatsappVerifying(false);
    }
  };

  const handleBecomeSeller = async () => {
    if (!whatsappVerified) {
      setFormError('Verify your WhatsApp number before activating your seller account.');
      return;
    }

    setLoading(true);
    setFormError('');
    try {
      const socialLinks = {};
      ['website', 'instagram', 'facebook', 'twitter', 'youtube', 'tiktok'].forEach(key => {
        if (storeData[key]?.trim()) socialLinks[key] = storeData[key].trim();
      });
      const payload = {
        phoneNumber: formData.phoneNumber.trim(),
        whatsappNumber: formData.phoneNumber.trim(),
        whatsappVerified: true,
        address: formData.address.trim(),
        city: formData.city.trim(),
        state: formData.state.trim(),
        stateCode: formData.stateCode.trim(),
        country: formData.country.trim(),
        countryCode: formData.countryCode.trim(),
        businessName: formData.businessName.trim(),
        storeName: storeData.storeName.trim(),
        storeDescription: storeData.storeDescription.trim(),
        productCurrency: storeData.productCurrency,
        socialLinks: Object.keys(socialLinks).length ? socialLinks : undefined,
      };

      const res = await api.post('/api/user/become-seller', payload);
      if (res.data?.token) await secureSet('jwtToken', res.data.token);
      if (fetchAndUpdateCurrentUser) await fetchAndUpdateCurrentUser();
      Feedback.show({
        type: 'success',
        text1: 'Your store is ready',
        text2: 'Welcome to Rozare Seller.',
      });
      navigation.replace('SellerDashboard');
    } catch (error) {
      setFormError(error.response?.data?.message || error.response?.data?.msg || 'Failed to activate your seller account.');
    } finally {
      setLoading(false);
    }
  };

  const renderError = (message = formError) => message ? (
    <View style={styles.errorBanner}>
      <Ionicons name="alert-circle-outline" size={17} color={palette.colors.error} />
      <Text style={styles.errorText}>{message}</Text>
    </View>
  ) : null;

  const renderProgress = () => sellerStepIndex >= 0 ? (
    <View style={styles.progressRow}>
      {SELLER_STEPS.map((step, index) => {
        const active = index <= sellerStepIndex;
        return (
          <React.Fragment key={step.key}>
            <View style={styles.progressItem}>
              <View style={[styles.progressDot, active && styles.progressDotActive]}>
                {index < sellerStepIndex
                  ? <Ionicons name="checkmark" size={14} color="#fff" />
                  : <Text style={[styles.progressNumber, active && styles.progressNumberActive]}>{index + 1}</Text>}
              </View>
              <Text style={[styles.progressLabel, active && styles.progressLabelActive]}>{step.label}</Text>
            </View>
            {index < SELLER_STEPS.length - 1 && <View style={[styles.progressLine, index < sellerStepIndex && styles.progressLineActive]} />}
          </React.Fragment>
        );
      })}
    </View>
  ) : null;

  const renderInput = ({
    label,
    icon,
    value,
    onChangeText,
    placeholder,
    keyboardType,
    autoCapitalize,
    secureTextEntry,
    multiline,
    right,
  }) => (
    <View style={styles.inputGroup}>
      <View style={styles.inputLabelRow}>
        {!!icon && <Ionicons name={icon} size={15} color={palette.colors.primary} />}
        <Text style={styles.label}>{label}</Text>
      </View>
      <View style={[styles.inputWrap, multiline && styles.inputWrapMultiline]}>
        <TextInput
          style={[styles.input, multiline && styles.inputMultiline]}
          value={value}
          onChangeText={(text) => {
            onChangeText(text);
            setFormError('');
          }}
          placeholder={placeholder}
          placeholderTextColor={palette.colors.grayLight}
          keyboardType={keyboardType || 'default'}
          autoCapitalize={autoCapitalize || 'sentences'}
          secureTextEntry={secureTextEntry}
          multiline={multiline}
          textAlignVertical={multiline ? 'top' : 'center'}
        />
        {right}
      </View>
    </View>
  );

  const renderLanding = () => {
    const benefits = [
      { icon: 'sparkles-outline', title: 'Run your store with AI', desc: 'Manage supported tasks in the app or on WhatsApp.', color: palette.colors.secondary },
      { icon: 'trending-up-outline', title: 'Reach global buyers', desc: 'Mobile and web storefronts with multi-currency shopping.', color: palette.colors.info },
      { icon: 'shield-checkmark-outline', title: 'Sell with confidence', desc: 'Trusted-store signals, secure checkout and seller tools.', color: palette.colors.success },
    ];
    const features = [
      'Store dashboard and sales analytics',
      'Product listings and inventory control',
      'AI product descriptions and smart tags',
      'WhatsApp commerce and order alerts',
      'Coupons, checkout and shipping tools',
      'Custom Rozare store address',
    ];

    return (
      <>
        <GlassPanel variant="strong" style={styles.hero}>
          <View style={styles.heroGlow} pointerEvents="none">
            <LinearGradient colors={['rgba(20,184,166,0.42)', 'rgba(99,102,241,0.04)']} style={styles.glowFill} />
          </View>
          <LinearGradient colors={palette.gradients.cta} style={styles.heroIcon}>
            <Ionicons name="storefront-outline" size={34} color="#fff" />
          </LinearGradient>
          <View style={styles.trialPill}>
            <Ionicons name="gift-outline" size={13} color={palette.colors.warning} />
            <Text style={styles.trialPillText}>START WITH A 15-DAY FREE TRIAL</Text>
          </View>
          <Text style={styles.heroTitle}>Turn your idea into a store</Text>
          <Text style={styles.heroSubtitle}>Create your Rozare storefront, reach buyers and run supported seller workflows with AI.</Text>
          <TouchableOpacity style={styles.primaryButton} onPress={handleGetStarted} activeOpacity={0.85}>
            <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
            <Ionicons name="storefront-outline" size={19} color="#fff" />
            <Text style={styles.primaryButtonText}>{currentUser ? 'Start seller setup' : 'Create my seller account'}</Text>
            <Ionicons name="arrow-forward" size={18} color="#fff" />
          </TouchableOpacity>
          {!currentUser && (
            <TouchableOpacity style={styles.inlineLink} onPress={() => navigation.navigate('Login')} activeOpacity={0.7}>
              <Text style={styles.mutedText}>Already have an account?</Text>
              <Text style={styles.inlineLinkText}> Sign in</Text>
            </TouchableOpacity>
          )}
        </GlassPanel>

        <View style={styles.sectionHeading}>
          <View>
            <Text style={styles.sectionKicker}>SELL YOUR WAY</Text>
            <Text style={styles.sectionTitle}>Built for modern sellers</Text>
          </View>
          <Ionicons name="sparkles" size={20} color={palette.colors.primary} />
        </View>

        <View style={styles.benefitsGrid}>
          {benefits.map(benefit => (
            <GlassPanel key={benefit.title} variant="card" style={styles.benefitCard}>
              <View style={[styles.benefitIcon, { backgroundColor: `${benefit.color}14` }]}>
                <Ionicons name={benefit.icon} size={22} color={benefit.color} />
              </View>
              <Text style={styles.benefitTitle}>{benefit.title}</Text>
              <Text style={styles.benefitDesc}>{benefit.desc}</Text>
            </GlassPanel>
          ))}
        </View>

        <GlassPanel variant="card" style={styles.featuresCard}>
          <View style={styles.featuresHeading}>
            <Ionicons name="flash-outline" size={19} color={palette.colors.warning} />
            <Text style={styles.featuresTitle}>Everything you need to begin</Text>
          </View>
          {features.map(feature => (
            <View key={feature} style={styles.featureRow}>
              <Ionicons name="checkmark-circle" size={18} color={palette.colors.success} />
              <Text style={styles.featureText}>{feature}</Text>
            </View>
          ))}
        </GlassPanel>
      </>
    );
  };

  const renderAccount = () => (
    <GlassPanel variant="strong" style={styles.formCard}>
      <View style={styles.formIcon}>
        <Ionicons name="person-add-outline" size={28} color={palette.colors.primary} />
      </View>
      <Text style={styles.formTitle}>Create your Rozare account</Text>
      <Text style={styles.formSubtitle}>We’ll verify your email before continuing to seller setup.</Text>
      {renderError()}
      {renderInput({
        label: 'Full Name *',
        icon: 'person-outline',
        value: accountData.username,
        onChangeText: value => setAccountData(prev => ({ ...prev, username: value })),
        placeholder: 'Your full name',
        autoCapitalize: 'words',
      })}
      {renderInput({
        label: 'Email Address *',
        icon: 'mail-outline',
        value: accountData.email,
        onChangeText: value => setAccountData(prev => ({ ...prev, email: value })),
        placeholder: 'you@example.com',
        keyboardType: 'email-address',
        autoCapitalize: 'none',
      })}
      {renderInput({
        label: 'Password *',
        icon: 'lock-closed-outline',
        value: accountData.password,
        onChangeText: value => setAccountData(prev => ({ ...prev, password: value })),
        placeholder: 'At least 6 characters',
        secureTextEntry: !showPassword,
        right: (
          <TouchableOpacity style={styles.inputAction} onPress={() => setShowPassword(value => !value)}>
            <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={20} color={palette.colors.textSecondary} />
          </TouchableOpacity>
        ),
      })}
      <TouchableOpacity style={styles.primaryButton} onPress={handleGuestSignup} disabled={emailSending} activeOpacity={0.85}>
        <LinearGradient colors={palette.gradients.cta} style={StyleSheet.absoluteFill} />
        {emailSending
          ? <ActivityIndicator size="small" color="#fff" />
          : <><Text style={styles.primaryButtonText}>Send verification code</Text><Ionicons name="arrow-forward" size={18} color="#fff" /></>}
      </TouchableOpacity>
      <View style={styles.divider}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>or continue with</Text>
        <View style={styles.dividerLine} />
      </View>
      <GoogleSignInButton onPress={handleGoogleSellerSignup} loading={emailSending} label="Continue with Google" />
      <TouchableOpacity style={[styles.inlineLink, { marginTop: spacing.lg }]} onPress={() => navigation.navigate('Login')}>
        <Text style={styles.mutedText}>Already registered?</Text>
        <Text style={styles.inlineLinkText}> Sign in</Text>
      </TouchableOpacity>
    </GlassPanel>
  );

  const renderEmailOtp = () => (
    <GlassPanel variant="strong" style={styles.formCard}>
      <View style={styles.formIcon}>
        <Ionicons name="mail-unread-outline" size={28} color={palette.colors.primary} />
      </View>
      <Text style={styles.formTitle}>Verify your email</Text>
      <Text style={styles.formSubtitle}>Enter the 6-digit code sent to {accountData.email}.</Text>
      {renderError()}
      <TextInput
        style={styles.otpInput}
        value={emailOtp}
        onChangeText={value => {
          setEmailOtp(value.replace(/\D/g, '').slice(0, 6));
          setFormError('');
        }}
        placeholder="000000"
        placeholderTextColor={palette.colors.grayLight}
        keyboardType="number-pad"
        maxLength={6}
      />
      <Text style={[styles.countdownText, emailOtpTimer.expiryRemaining <= 60 && { color: palette.colors.error }]}>
        {emailOtpTimer.isExpired ? 'Code expired. Request a new one.' : `Code expires in ${emailOtpTimer.expiryLabel}`}
      </Text>
      <TouchableOpacity style={[styles.primaryButton, emailOtpTimer.isExpired && styles.disabledButton]} onPress={handleVerifyEmail} disabled={emailVerifying || emailOtpTimer.isExpired} activeOpacity={0.85}>
        <LinearGradient colors={palette.gradients.cta} style={StyleSheet.absoluteFill} />
        {emailVerifying
          ? <ActivityIndicator color="#fff" />
          : <><Ionicons name="checkmark-circle-outline" size={18} color="#fff" /><Text style={styles.primaryButtonText}>Verify and continue</Text></>}
      </TouchableOpacity>
      <TouchableOpacity style={styles.secondaryAction} onPress={handleGuestSignup} disabled={emailSending || !emailOtpTimer.canResend}>
        <Ionicons name="refresh-outline" size={16} color={palette.colors.primary} />
        <Text style={styles.secondaryActionText}>
          {emailSending ? 'Sending...' : emailOtpTimer.canResend ? 'Resend code' : `Resend available in ${emailOtpTimer.resendRemaining}s`}
        </Text>
      </TouchableOpacity>
    </GlassPanel>
  );

  const renderDetails = () => (
    <GlassPanel variant="strong" style={styles.formCard}>
      <Text style={styles.formTitle}>Tell us about your business</Text>
      <Text style={styles.formSubtitle}>These details establish your store and seller profile.</Text>
      {renderError()}
      <PhoneNumberInput
        label="WhatsApp / Phone Number"
        required
        value={formData.phoneNumber}
        onChangeText={(value) => {
          setFormData(prev => ({ ...prev, phoneNumber: value }));
          resetWhatsAppVerification();
        }}
        defaultCountryCode={formData.phoneNumber ? formData.countryCode : undefined}
        profileCountryCode={currentUser?.savedShippingInfo?.countryCode}
        profileCountry={currentUser?.savedShippingInfo?.country}
        helperText="We will send the seller verification code to this WhatsApp number."
        testID="become-seller-phone"
      />
      {renderInput({
        label: 'Business Name (Optional)',
        icon: 'briefcase-outline',
        value: formData.businessName,
        onChangeText: value => setFormData(prev => ({ ...prev, businessName: value })),
        placeholder: 'Your company or brand',
      })}
      {renderInput({
        label: 'Street Address *',
        icon: 'location-outline',
        value: formData.address,
        onChangeText: value => setFormData(prev => ({ ...prev, address: value })),
        placeholder: 'Street and building',
      })}
      <LocationAutocomplete
        type="country"
        label="Country"
        required
        value={formData.country}
        code={formData.countryCode}
        placeholder="Select country"
        onSelect={option => setFormData(prev => ({
          ...prev,
          country: option.name,
          countryCode: option.isoCode,
          state: '',
          stateCode: '',
          city: '',
        }))}
        onClear={() => setFormData(prev => ({ ...prev, country: '', countryCode: '', state: '', stateCode: '', city: '' }))}
      />
      <LocationAutocomplete
        type="state"
        label="State / Province"
        value={formData.state}
        code={formData.stateCode}
        countryCode={formData.countryCode}
        countryName={formData.country}
        placeholder="Select state"
        disabled={!formData.countryCode && !formData.country}
        onSelect={option => setFormData(prev => ({ ...prev, state: option.name, stateCode: option.isoCode, city: '' }))}
        onClear={() => setFormData(prev => ({ ...prev, state: '', stateCode: '', city: '' }))}
      />
      <LocationAutocomplete
        type="city"
        label="City"
        required
        value={formData.city}
        countryCode={formData.countryCode}
        countryName={formData.country}
        stateCode={formData.stateCode}
        stateName={formData.state}
        placeholder="Select city"
        disabled={!formData.countryCode && !formData.country}
        onSelect={option => setFormData(prev => ({
          ...prev,
          city: option.name,
          state: prev.state || option.stateName || '',
          stateCode: prev.stateCode || option.stateCode || '',
        }))}
        onClear={() => setFormData(prev => ({ ...prev, city: '' }))}
      />
      <TouchableOpacity style={styles.primaryButton} onPress={handleDetailsNext} activeOpacity={0.85}>
        <LinearGradient colors={palette.gradients.cta} style={StyleSheet.absoluteFill} />
        <Text style={styles.primaryButtonText}>Continue to store setup</Text>
        <Ionicons name="arrow-forward" size={18} color="#fff" />
      </TouchableOpacity>
    </GlassPanel>
  );

  const renderStore = () => {
    const socialInputs = [
      ['website', 'globe-outline', 'Website', 'https://yourstore.com'],
      ['instagram', 'logo-instagram', 'Instagram', '@yourstore'],
      ['facebook', 'logo-facebook', 'Facebook', 'facebook.com/yourstore'],
      ['twitter', 'logo-twitter', 'X / Twitter', '@yourstore'],
      ['youtube', 'logo-youtube', 'YouTube', 'youtube.com/@yourstore'],
      ['tiktok', 'logo-tiktok', 'TikTok', '@yourstore'],
    ];

    return (
      <GlassPanel variant="strong" style={styles.formCard}>
        <Text style={styles.formTitle}>Create your storefront</Text>
        <Text style={styles.formSubtitle}>Your store name and description are required, just like on the website.</Text>
        {renderError()}
        {renderInput({
          label: 'Store Name *',
          icon: 'storefront-outline',
          value: storeData.storeName,
          onChangeText: value => setStoreData(prev => ({ ...prev, storeName: value })),
          placeholder: 'My Awesome Store',
        })}
        {!!storeSlug && (
          <View style={styles.slugCard}>
            <Ionicons
              name={storeNameChecking ? 'hourglass-outline' : storeNameAvailable ? 'checkmark-circle' : 'link-outline'}
              size={15}
              color={storeNameAvailable ? palette.colors.success : palette.colors.primary}
            />
            <Text style={styles.slugText} numberOfLines={1}>{getStorefrontHost(storeSlug)}</Text>
            {storeNameChecking && <ActivityIndicator size="small" color={palette.colors.primary} />}
          </View>
        )}
        {!!storeNameError && <Text style={styles.inlineError}>{storeNameError}</Text>}
        {storeNameAvailable && (
          <View style={styles.availableRow}>
            <Ionicons name="checkmark-circle" size={15} color={palette.colors.success} />
            <Text style={styles.availableText}>This store name is available</Text>
          </View>
        )}
        {renderInput({
          label: 'Store Description *',
          icon: 'document-text-outline',
          value: storeData.storeDescription,
          onChangeText: value => setStoreData(prev => ({ ...prev, storeDescription: value })),
          placeholder: 'Describe what you sell and what makes your store special',
          multiline: true,
        })}
        <Text style={styles.groupLabel}>PRODUCT LISTING CURRENCY *</Text>
        <Text style={styles.currencyHelp}>
          Product prices are saved in this currency. Buyers can view and pay in another supported currency using checkout conversion.
        </Text>
        <View style={styles.currencyGrid}>
          {SELLER_PRODUCT_CURRENCY_CODES.map(code => {
            const active = storeData.productCurrency === code;
            return (
              <TouchableOpacity
                key={code}
                testID={`become-seller-product-currency-${code}`}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                onPress={() => {
                  productCurrencyTouchedRef.current = true;
                  setStoreData(previous => ({ ...previous, productCurrency: code }));
                  setFormError('');
                }}
                activeOpacity={0.8}
                style={[styles.currencyOption, active && styles.currencyOptionActive]}
              >
                <Text style={[styles.currencyCode, active && styles.currencyCodeActive]}>{code}</Text>
                <Text style={[styles.currencyName, active && styles.currencyNameActive]} numberOfLines={1}>
                  {currencies?.[code]?.name || code}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <Text style={styles.groupLabel}>SOCIAL LINKS · OPTIONAL</Text>
        {socialInputs.map(([key, icon, label, placeholder]) => renderInput({
          label,
          icon,
          value: storeData[key],
          onChangeText: value => setStoreData(prev => ({ ...prev, [key]: value })),
          placeholder,
          autoCapitalize: 'none',
        }))}
        <TouchableOpacity style={styles.primaryButton} onPress={handleStoreNext} activeOpacity={0.85}>
          <LinearGradient colors={palette.gradients.cta} style={StyleSheet.absoluteFill} />
          <Text style={styles.primaryButtonText}>Continue to verification</Text>
          <Ionicons name="arrow-forward" size={18} color="#fff" />
        </TouchableOpacity>
      </GlassPanel>
    );
  };

  const renderWhatsApp = () => (
    <GlassPanel variant="strong" style={styles.formCard}>
      <LinearGradient colors={['rgba(16,185,129,0.16)', 'rgba(14,165,233,0.03)']} style={StyleSheet.absoluteFill} pointerEvents="none" />
      <View style={[styles.formIcon, styles.whatsappIcon]}>
        <Ionicons name="logo-whatsapp" size={29} color="#fff" />
      </View>
      <Text style={styles.formTitle}>Verify WhatsApp</Text>
      <Text style={styles.formSubtitle}>Verify the number that will receive seller alerts and connect supported AI workflows.</Text>
      {renderError()}

      <View style={styles.phoneCard}>
        {editingNumber ? (
          <>
            <Text style={styles.phoneCardLabel}>Edit WhatsApp Number</Text>
            <PhoneNumberInput
              label=""
              value={formData.phoneNumber}
              onChangeText={(value) => {
                setFormData(prev => ({ ...prev, phoneNumber: value }));
                resetWhatsAppVerification();
              }}
              defaultCountryCode={formData.countryCode}
              profileCountryCode={currentUser?.savedShippingInfo?.countryCode}
              profileCountry={currentUser?.savedShippingInfo?.country}
              autoFocus
              testID="become-seller-edit-phone"
            />
            <TouchableOpacity style={styles.doneButton} onPress={() => setEditingNumber(false)}>
              <Text style={styles.doneButtonText}>Done</Text>
            </TouchableOpacity>
          </>
        ) : (
          <View style={styles.phoneRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.phoneCardLabel}>WhatsApp Number</Text>
              <Text style={styles.phoneNumber}>{formData.phoneNumber || '—'}</Text>
            </View>
            {!whatsappVerified && (
              <TouchableOpacity
                style={styles.editButton}
                onPress={() => {
                  setEditingNumber(true);
                  resetWhatsAppVerification();
                }}
              >
                <Ionicons name="pencil-outline" size={13} color={palette.colors.primary} />
                <Text style={styles.editButtonText}>Edit</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>

      {whatsappVerified ? (
        <>
          <View style={styles.verifiedCard}>
            <Ionicons name="checkmark-circle" size={34} color={palette.colors.success} />
            <Text style={styles.verifiedTitle}>WhatsApp verified</Text>
            <Text style={styles.verifiedText}>Your seller account is ready to activate.</Text>
          </View>
          <TouchableOpacity style={styles.primaryButton} onPress={handleBecomeSeller} disabled={loading} activeOpacity={0.85}>
            <LinearGradient colors={palette.gradients.cta} style={StyleSheet.absoluteFill} />
            {loading
              ? <ActivityIndicator color="#fff" />
              : <><Ionicons name="storefront-outline" size={19} color="#fff" /><Text style={styles.primaryButtonText}>Activate seller account</Text></>}
          </TouchableOpacity>
        </>
      ) : whatsappCodeSent ? (
        <>
          <Text style={styles.otpLabel}>Enter the 6-digit code sent on WhatsApp</Text>
          <TextInput
            style={styles.otpInput}
            value={whatsappOtp}
            onChangeText={value => {
              setWhatsappOtp(value.replace(/\D/g, '').slice(0, 6));
              setWhatsappError('');
            }}
            placeholder="000000"
            placeholderTextColor={palette.colors.grayLight}
            keyboardType="number-pad"
            maxLength={6}
          />
          <Text style={[styles.countdownText, otpCountdown <= 30 && { color: palette.colors.error }]}>
            {otpCountdown > 0 ? `Code expires in ${Math.floor(otpCountdown / 60)}:${String(otpCountdown % 60).padStart(2, '0')}` : 'Code expired. Request a new one.'}
          </Text>
          {renderError(whatsappError)}
          <TouchableOpacity
            style={[styles.verifyButton, (whatsappOtp.length !== 6 || otpCountdown <= 0) && styles.disabledButton]}
            onPress={handleVerifyWhatsApp}
            disabled={whatsappVerifying || whatsappOtp.length !== 6 || otpCountdown <= 0}
          >
            {whatsappVerifying
              ? <ActivityIndicator color="#fff" />
              : <><Ionicons name="checkmark-circle-outline" size={18} color="#fff" /><Text style={styles.verifyButtonText}>Verify code</Text></>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryAction} onPress={handleSendWhatsAppOtp} disabled={resendCooldown > 0 || whatsappSending}>
            <Ionicons name="refresh-outline" size={16} color={palette.colors.primary} />
            <Text style={styles.secondaryActionText}>
              {resendCooldown > 0 ? `Resend available in ${resendCooldown}s` : whatsappSending ? 'Sending…' : 'Resend code'}
            </Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          {renderError(whatsappError)}
          <TouchableOpacity style={styles.verifyButton} onPress={handleSendWhatsAppOtp} disabled={whatsappSending || editingNumber}>
            {whatsappSending
              ? <ActivityIndicator color="#fff" />
              : <><Ionicons name="logo-whatsapp" size={19} color="#fff" /><Text style={styles.verifyButtonText}>Send verification code</Text></>}
          </TouchableOpacity>
        </>
      )}
    </GlassPanel>
  );

  return (
    <GlassBackground>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <KeyboardAwareFormScrollView contentContainerStyle={styles.scrollContent} bottomOffset={32}>
          <AuthTopHeader
            title={headerTitle}
            subtitle={headerSubtitle}
            icon="storefront-outline"
            onBack={handleHeaderBack}
            rightIcon={sellerStepIndex >= 0 ? 'footsteps-outline' : 'gift-outline'}
            rightLabel={sellerStepIndex >= 0 ? `${sellerStepIndex + 1}/3` : '15 days'}
          />
          {renderProgress()}
          {flowStep === 'landing' && renderLanding()}
          {flowStep === 'account' && renderAccount()}
          {flowStep === 'emailOtp' && renderEmailOtp()}
          {flowStep === 'details' && renderDetails()}
          {flowStep === 'store' && renderStore()}
          {flowStep === 'whatsapp' && renderWhatsApp()}
      </KeyboardAwareFormScrollView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  container: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  progressRow: {
    maxWidth: 400,
    width: '100%',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
  },
  progressItem: { alignItems: 'center', width: 58 },
  progressDot: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  progressDotActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  progressNumber: { fontSize: fontSize.xs, color: p.colors.textSecondary, fontWeight: fontWeight.bold },
  progressNumberActive: { color: '#fff' },
  progressLabel: { marginTop: 4, fontSize: 9, color: p.colors.textSecondary, fontWeight: fontWeight.semibold },
  progressLabelActive: { color: p.colors.primary },
  progressLine: { flex: 1, height: 2, marginTop: 14, backgroundColor: p.glass.borderSubtle },
  progressLineActive: { backgroundColor: p.colors.primary },
  hero: {
    maxWidth: 440,
    width: '100%',
    alignSelf: 'center',
    alignItems: 'center',
    marginTop: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
    borderRadius: 28,
  },
  heroGlow: { position: 'absolute', width: 210, height: 210, borderRadius: 105, top: -105, right: -55, opacity: 0.55 },
  glowFill: { flex: 1, borderRadius: 999 },
  heroIcon: {
    width: 76,
    height: 76,
    borderRadius: 25,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.lg,
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 15,
    elevation: 5,
  },
  trialPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(245,158,11,0.11)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.22)',
    marginBottom: spacing.md,
  },
  trialPillText: { fontSize: 9, letterSpacing: 0.7, color: p.colors.warning, fontWeight: fontWeight.bold },
  heroTitle: { fontSize: fontSize.title, color: p.colors.text, fontWeight: fontWeight.extrabold, textAlign: 'center', letterSpacing: -0.6 },
  heroSubtitle: { maxWidth: 340, marginTop: spacing.sm, marginBottom: spacing.xl, fontSize: fontSize.md, lineHeight: 22, color: p.colors.textSecondary, textAlign: 'center' },
  primaryButton: {
    width: '100%',
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: borderRadius.xl,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    overflow: 'hidden',
    shadowColor: p.colors.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.32,
    shadowRadius: 15,
    elevation: 5,
  },
  primaryButtonText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold, flexShrink: 1 },
  inlineLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: spacing.md },
  mutedText: { fontSize: fontSize.sm, color: p.colors.textSecondary },
  inlineLinkText: { fontSize: fontSize.sm, color: p.colors.primary, fontWeight: fontWeight.bold },
  sectionHeading: {
    maxWidth: 440,
    width: '100%',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xl,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.xs,
  },
  sectionKicker: { fontSize: 9, letterSpacing: 1, color: p.colors.primary, fontWeight: fontWeight.bold, marginBottom: 3 },
  sectionTitle: { fontSize: fontSize.xl, color: p.colors.text, fontWeight: fontWeight.extrabold },
  benefitsGrid: { maxWidth: 440, width: '100%', alignSelf: 'center', flexDirection: 'row', gap: spacing.sm },
  benefitCard: { flex: 1, padding: spacing.md, alignItems: 'center', borderRadius: 20 },
  benefitIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.sm },
  benefitTitle: { fontSize: fontSize.sm, lineHeight: 17, color: p.colors.text, fontWeight: fontWeight.bold, textAlign: 'center' },
  benefitDesc: { marginTop: 4, fontSize: 10, lineHeight: 15, color: p.colors.textSecondary, textAlign: 'center' },
  featuresCard: { maxWidth: 440, width: '100%', alignSelf: 'center', marginTop: spacing.md, padding: spacing.lg, borderRadius: 22 },
  featuresHeading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  featuresTitle: { fontSize: fontSize.lg, color: p.colors.text, fontWeight: fontWeight.bold },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 6 },
  featureText: { flex: 1, fontSize: fontSize.sm, color: p.colors.textSecondary },
  formCard: {
    maxWidth: 440,
    width: '100%',
    alignSelf: 'center',
    marginTop: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
    borderRadius: 28,
  },
  formIcon: {
    width: 62,
    height: 62,
    borderRadius: 21,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
    backgroundColor: 'rgba(99,102,241,0.11)',
    borderWidth: 1,
    borderColor: 'rgba(99,102,241,0.18)',
  },
  whatsappIcon: { backgroundColor: p.colors.success, borderColor: p.colors.success },
  formTitle: { fontSize: fontSize.xxl, color: p.colors.text, fontWeight: fontWeight.extrabold, textAlign: 'center', letterSpacing: -0.4 },
  formSubtitle: { marginTop: spacing.xs, marginBottom: spacing.xl, fontSize: fontSize.sm, lineHeight: 20, color: p.colors.textSecondary, textAlign: 'center' },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: 14,
    marginBottom: spacing.md,
    backgroundColor: p.colors.errorSubtle,
    borderWidth: 1,
    borderColor: `${p.colors.error}33`,
  },
  errorText: { flex: 1, fontSize: fontSize.sm, lineHeight: 18, color: p.colors.error, fontWeight: fontWeight.medium },
  inputGroup: { marginBottom: spacing.md },
  inputLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 6 },
  label: { fontSize: fontSize.sm, color: p.colors.text, fontWeight: fontWeight.semibold },
  inputWrap: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: 16,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.border,
  },
  inputWrapMultiline: { minHeight: 104, alignItems: 'stretch' },
  input: { flex: 1, fontSize: fontSize.md, color: p.colors.text, paddingVertical: 0 },
  inputMultiline: { minHeight: 82, paddingVertical: spacing.md },
  inputAction: { padding: spacing.sm },
  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: spacing.xl },
  dividerLine: { flex: 1, height: 1, backgroundColor: p.glass.border },
  dividerText: { marginHorizontal: spacing.md, fontSize: fontSize.sm, color: p.colors.textSecondary },
  otpInput: {
    minHeight: 62,
    marginBottom: spacing.lg,
    borderRadius: 17,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.border,
    color: p.colors.text,
    fontSize: 25,
    fontWeight: fontWeight.extrabold,
    letterSpacing: 8,
    textAlign: 'center',
  },
  secondaryAction: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, minHeight: 42, marginTop: spacing.sm },
  secondaryActionText: { fontSize: fontSize.sm, color: p.colors.primary, fontWeight: fontWeight.semibold },
  slugCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginTop: -spacing.xs,
    marginBottom: spacing.xs,
    borderRadius: 12,
    backgroundColor: `${p.colors.primary}0D`,
  },
  slugText: { flex: 1, fontSize: fontSize.xs, color: p.colors.primary, fontWeight: fontWeight.medium },
  inlineError: { marginBottom: spacing.sm, fontSize: fontSize.xs, color: p.colors.error },
  availableRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: spacing.sm },
  availableText: { fontSize: fontSize.xs, color: p.colors.success, fontWeight: fontWeight.semibold },
  groupLabel: { marginTop: spacing.sm, marginBottom: spacing.md, fontSize: 9, letterSpacing: 1, color: p.colors.textSecondary, fontWeight: fontWeight.bold },
  currencyHelp: { marginTop: -spacing.sm, marginBottom: spacing.sm, fontSize: fontSize.xs, lineHeight: 17, color: p.colors.textSecondary },
  currencyGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  currencyOption: {
    width: '48%',
    minHeight: 58,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 14,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.border,
  },
  currencyOptionActive: { backgroundColor: `${p.colors.primary}18`, borderColor: p.colors.primary },
  currencyCode: { fontSize: fontSize.sm, color: p.colors.text, fontWeight: fontWeight.bold },
  currencyCodeActive: { color: p.colors.primary },
  currencyName: { marginTop: 2, fontSize: 10, color: p.colors.textSecondary },
  currencyNameActive: { color: p.colors.primary },
  phoneCard: {
    padding: spacing.md,
    marginBottom: spacing.lg,
    borderRadius: 16,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.border,
  },
  phoneRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  phoneCardLabel: { fontSize: fontSize.xs, color: p.colors.textSecondary, fontWeight: fontWeight.semibold },
  phoneNumber: { marginTop: 4, fontSize: fontSize.lg, color: p.colors.text, fontWeight: fontWeight.bold },
  editButton: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: 11, backgroundColor: `${p.colors.primary}12` },
  editButtonText: { fontSize: fontSize.xs, color: p.colors.primary, fontWeight: fontWeight.bold },
  phoneEditInput: { minHeight: 48, marginTop: spacing.sm, paddingHorizontal: spacing.md, borderRadius: 13, backgroundColor: p.glass.bgStrong, borderWidth: 1, borderColor: p.glass.border, color: p.colors.text, fontSize: fontSize.md },
  doneButton: { alignItems: 'center', paddingVertical: spacing.sm, marginTop: spacing.sm, borderRadius: 11, backgroundColor: `${p.colors.primary}12` },
  doneButtonText: { fontSize: fontSize.sm, color: p.colors.primary, fontWeight: fontWeight.bold },
  verifiedCard: { alignItems: 'center', padding: spacing.lg, marginBottom: spacing.lg, borderRadius: 16, backgroundColor: `${p.colors.success}12`, borderWidth: 1, borderColor: `${p.colors.success}30` },
  verifiedTitle: { marginTop: spacing.sm, fontSize: fontSize.md, color: p.colors.success, fontWeight: fontWeight.bold },
  verifiedText: { marginTop: 3, fontSize: fontSize.xs, color: p.colors.textSecondary, textAlign: 'center' },
  otpLabel: { marginBottom: spacing.sm, fontSize: fontSize.xs, color: p.colors.textSecondary, fontWeight: fontWeight.semibold, textAlign: 'center' },
  countdownText: { marginTop: -spacing.sm, marginBottom: spacing.md, fontSize: fontSize.xs, color: p.colors.textSecondary, textAlign: 'center' },
  verifyButton: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: 16,
    backgroundColor: p.colors.success,
  },
  verifyButtonText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold },
  disabledButton: { opacity: 0.45 },
});
