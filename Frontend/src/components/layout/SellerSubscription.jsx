import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Crown, Check, Zap, Shield, Clock, AlertTriangle,
    CreditCard, ArrowRight, Sparkles, X, Lock, Store, Package,
    Users, Award, Star, MessageCircle, Gem, Bell, Palette, Megaphone, Tag
} from 'lucide-react';
import axios from 'axios';
import { loadStripe } from '@stripe/stripe-js';
import { toast } from 'react-toastify';
import { useSearchParams } from 'react-router-dom';
import { getAuthToken } from "../../utils/cookieHelper";
import { formatUsdCents, getSubscriptionPricing } from '../../utils/subscriptionPricing';
import {
    calendarMonthsRemaining,
    canRetryPlanChangeAfterStripeAction,
    getPlanChangeActionClientSecret,
    isPlanChangeActionRequired,
    isStripePublishableKey,
    subscriptionStatusConfirmsEntitlement,
} from '../../utils/subscriptionPlanChange';

const resolvePlanChangePaymentAction = async (error, token) => {
    const clientSecret = getPlanChangeActionClientSecret(error);
    if (!clientSecret) {
        throw new Error('Stripe returned an invalid payment-authentication reference. No plan features were changed.');
    }

    const configResponse = await axios.get(
        `${import.meta.env.VITE_API_URL}api/payment-methods/config`,
        { headers: { Authorization: `Bearer ${token}` } }
    );
    const publishableKey = configResponse.data?.config?.publishableKey
        || configResponse.data?.publishableKey;
    if (!isStripePublishableKey(publishableKey)) {
        throw new Error('Stripe payment authentication is temporarily unavailable. No plan features were changed.');
    }

    const stripe = await loadStripe(publishableKey);
    if (!stripe) {
        throw new Error('Stripe payment authentication could not be loaded. No plan features were changed.');
    }

    let result = await stripe.handleNextAction({ clientSecret });
    if (!result?.error && result?.paymentIntent?.status === 'requires_confirmation') {
        result = await stripe.confirmPayment({
            clientSecret,
            redirect: 'if_required',
            confirmParams: { return_url: window.location.href },
        });
    }
    if (!canRetryPlanChangeAfterStripeAction(result)) {
        throw new Error(
            result?.error?.message
            || 'Stripe did not confirm the plan-change payment. No plan features were changed.'
        );
    }
};

const SellerSubscription = () => {
    const [subscription, setSubscription] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const subscriptionRequestRef = useRef({ id: 0, controller: null });
    const [checkoutLoading, setCheckoutLoading] = useState(null); // 'starter' | 'elite' | null
    const [cancelLoading, setCancelLoading] = useState(false);
    const [resumeLoading, setResumeLoading] = useState(false);
    const [upgradeLoading, setUpgradeLoading] = useState(false);
    const [downgradeLoading, setDowngradeLoading] = useState(false);
    const [cancelDowngradeLoading, setCancelDowngradeLoading] = useState(false);
    const [showCancelConfirm, setShowCancelConfirm] = useState(false);
    const [showUpgradeConfirm, setShowUpgradeConfirm] = useState(false);
    const [showDowngradeConfirm, setShowDowngradeConfirm] = useState(false);
    const [eliteMetaAds, setEliteMetaAds] = useState(false);
    const [couponCode, setCouponCode] = useState('');
    const [founderCouponApplied, setFounderCouponApplied] = useState(false);
    const [checkoutReturnStatus, setCheckoutReturnStatus] = useState(null);
    const [searchParams] = useSearchParams();
    const returnedFromCheckout = searchParams.get('success') === 'true';
    const checkoutWasCancelled = searchParams.get('cancelled') === 'true';
    const requestedCouponParam = String(searchParams.get('coupon') || '').trim().toUpperCase();

    const fetchSubscription = useCallback(async () => {
        subscriptionRequestRef.current.controller?.abort();
        const controller = new AbortController();
        const requestId = subscriptionRequestRef.current.id + 1;
        subscriptionRequestRef.current = { id: requestId, controller };
        setLoading(true);
        setSubscription(null);
        setLoadError('');
        try {
            const token = getAuthToken();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/subscription/status`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: controller.signal,
            });
            const nextSubscription = res.data.subscription;
            if (subscriptionRequestRef.current.id !== requestId) return null;
            setSubscription(nextSubscription);
            setEliteMetaAds(Boolean(nextSubscription?.metaAdsIncluded));

            const requestedCoupon = requestedCouponParam;
            if (
                requestedCoupon
                && requestedCoupon === nextSubscription?.founderPromotion?.code
                && nextSubscription?.founderPromotion?.available
                && nextSubscription?.founderPromotion?.sellerEligible
            ) {
                setCouponCode(requestedCoupon);
                setFounderCouponApplied(true);
            }
            return nextSubscription;
        } catch (err) {
            if (controller.signal.aborted || err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return null;
            if (subscriptionRequestRef.current.id !== requestId) return null;
            console.error(err);
            setSubscription(null);
            setLoadError(err.response?.data?.msg || 'Live subscription status could not be loaded. Billing actions are disabled until you retry.');
            return null;
        } finally {
            if (subscriptionRequestRef.current.id === requestId) setLoading(false);
        }
    }, [requestedCouponParam]);

    const handleSubscribe = async (plan = 'starter') => {
        setCheckoutLoading(plan);
        try {
            const token = getAuthToken();
            const payload = { plan };
            if (plan === 'elite') payload.includeMetaAds = eliteMetaAds;
            if (founderCouponApplied) payload.couponCode = subscription?.founderPromotion?.code;
            const res = await axios.post(`${import.meta.env.VITE_API_URL}api/subscription/create-checkout`, payload, {
                headers: { Authorization: `Bearer ${token}` }
            });
            window.location.href = res.data.url;
        } catch (err) {
            toast.error(err.response?.data?.msg || 'Failed to create checkout');
            setCheckoutLoading(null);
        }
    };

    const handleCancel = async () => {
        setCancelLoading(true);
        try {
            const token = getAuthToken();
            await axios.post(`${import.meta.env.VITE_API_URL}api/subscription/cancel`, {}, {
                headers: { Authorization: `Bearer ${token}` }
            });
            toast.success('Subscription will be cancelled at the end of the current period.');
            setShowCancelConfirm(false);
            fetchSubscription();
        } catch (err) {
            toast.error(err.response?.data?.msg || 'Failed to cancel subscription');
        } finally {
            setCancelLoading(false);
        }
    };

    const handleUpgrade = async () => {
        setUpgradeLoading(true);
        let paymentActionStarted = false;
        try {
            const token = getAuthToken();
            const payload = { includeMetaAds: eliteMetaAds };
            const submitPlanChange = () => axios.post(
                `${import.meta.env.VITE_API_URL}api/subscription/upgrade-to-elite`,
                payload,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            let res;
            try {
                res = await submitPlanChange();
            } catch (error) {
                if (!isPlanChangeActionRequired(error)) throw error;
                paymentActionStarted = true;
                toast.info('Complete Stripe authentication to continue. No plan features are active yet.');
                await resolvePlanChangePaymentAction(error, token);
                // Identical endpoint and payload resume the server-owned
                // planChangeAttempt. Only this authoritative retry may grant
                // Elite or Meta Ads after Stripe confirms payment.
                res = await submitPlanChange();
            }
            toast.success(res.data.msg || 'Upgraded to Rozare Elite!');
            setShowUpgradeConfirm(false);
            await fetchSubscription();
        } catch (err) {
            if (paymentActionStarted) await fetchSubscription();
            toast.error(err.response?.data?.msg || err.message || 'Failed to update subscription');
        } finally {
            setUpgradeLoading(false);
        }
    };

    const handleDowngrade = async () => {
        setDowngradeLoading(true);
        try {
            const token = getAuthToken();
            const res = await axios.post(`${import.meta.env.VITE_API_URL}api/subscription/downgrade-to-starter`, {}, {
                headers: { Authorization: `Bearer ${token}` }
            });
            toast.success(res.data.msg || 'Downgrade scheduled.');
            setShowDowngradeConfirm(false);
            fetchSubscription();
        } catch (err) {
            toast.error(err.response?.data?.msg || 'Failed to downgrade');
        } finally {
            setDowngradeLoading(false);
        }
    };

    const handleCancelDowngrade = async () => {
        setCancelDowngradeLoading(true);
        try {
            const token = getAuthToken();
            const res = await axios.post(`${import.meta.env.VITE_API_URL}api/subscription/cancel-downgrade`, {}, {
                headers: { Authorization: `Bearer ${token}` }
            });
            toast.success(res.data.msg || 'Downgrade cancelled.');
            fetchSubscription();
        } catch (err) {
            toast.error(err.response?.data?.msg || 'Failed to cancel downgrade');
        } finally {
            setCancelDowngradeLoading(false);
        }
    };

    const recheckCheckoutReturn = useCallback(async () => {
        setCheckoutReturnStatus('verifying');
        const nextSubscription = await fetchSubscription();
        if (subscriptionStatusConfirmsEntitlement(nextSubscription)) {
            setCheckoutReturnStatus('confirmed');
            toast.success('Your authenticated subscription status is active.');
        } else {
            setCheckoutReturnStatus('pending');
        }
    }, [fetchSubscription]);

    useEffect(() => {
        let active = true;
        const verifyCheckoutReturn = async () => {
            if (returnedFromCheckout) {
                setCheckoutReturnStatus('verifying');
                toast.info('Stripe checkout returned. Rozare is verifying your subscription before enabling access.');
            } else if (checkoutWasCancelled) {
                toast.info('Checkout was cancelled. You can subscribe anytime.');
            }

            const nextSubscription = await fetchSubscription();
            if (!active || !returnedFromCheckout) return;
            if (subscriptionStatusConfirmsEntitlement(nextSubscription)) {
                setCheckoutReturnStatus('confirmed');
                toast.success('Your authenticated subscription status is active.');
            } else {
                setCheckoutReturnStatus('pending');
            }
        };
        verifyCheckoutReturn();
        return () => { active = false; };
    }, [checkoutWasCancelled, fetchSubscription, returnedFromCheckout]);

    useEffect(() => () => subscriptionRequestRef.current.controller?.abort(), []);

    const handleResume = async () => {
        setResumeLoading(true);
        try {
            const token = getAuthToken();
            const res = await axios.post(`${import.meta.env.VITE_API_URL}api/subscription/resume`, {}, {
                headers: { Authorization: `Bearer ${token}` }
            });
            toast.success(res.data.msg || 'Subscription resumed successfully.');
            await fetchSubscription();
        } catch (err) {
            toast.error(err.response?.data?.msg || 'Failed to resume subscription');
        } finally {
            setResumeLoading(false);
        }
    };

    const handleApplyFounderCoupon = () => {
        const promotion = subscription?.founderPromotion;
        const normalizedCode = String(couponCode || '').trim().toUpperCase();

        if (!promotion || normalizedCode !== promotion.code) {
            toast.error('Enter a valid subscription coupon.');
            return;
        }
        if (!promotion.sellerEligible) {
            toast.error(promotion.forfeited
                ? 'This account already used and forfeited its founder rate.'
                : 'This coupon can only be applied when starting a new subscription.');
            return;
        }
        if (!promotion.available) {
            toast.error('The FIRST100 founder offer has reached its limit.');
            return;
        }

        setCouponCode(normalizedCode);
        setFounderCouponApplied(true);
        toast.success('FIRST100 applied. Your founder price will lock after Checkout is completed.');
    };

    const getStatusBadge = () => {
        if (!subscription) return null;
        // Stripe "cancel at period end" — status is still active but cancelledAt is set.
        // Surface that explicitly so the seller knows the plan is winding down.
        if (subscription.cancelledAt && !subscription.pendingDowngrade && ['active', 'free_period'].includes(subscription.status)) {
            const endDate = subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
            const daysLeft = endDate ? Math.max(0, Math.ceil((endDate - new Date()) / 86400000)) : null;
            return (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold"
                    style={{ background: 'rgba(239,68,68,0.12)', color: 'hsl(0, 72%, 55%)' }}>
                    <X size={12} /> Ending
                    {daysLeft !== null && <span className="opacity-80">· {daysLeft} day{daysLeft !== 1 ? 's' : ''} remaining</span>}
                </span>
            );
        }
        const map = {
            trial: { label: 'Free Trial', color: 'hsl(220, 70%, 55%)', bg: 'rgba(99,102,241,0.12)', icon: <Clock size={12} /> },
            free_period: { label: 'Introductory Period', color: 'hsl(150, 60%, 45%)', bg: 'rgba(16,185,129,0.12)', icon: <Sparkles size={12} /> },
            active: { label: 'Active', color: 'hsl(150, 60%, 45%)', bg: 'rgba(16,185,129,0.12)', icon: <Check size={12} /> },
            past_due: { label: 'Past Due', color: 'hsl(30, 90%, 50%)', bg: 'rgba(249,115,22,0.12)', icon: <AlertTriangle size={12} /> },
            blocked: { label: 'Blocked', color: 'hsl(0, 72%, 55%)', bg: 'rgba(239,68,68,0.12)', icon: <Lock size={12} /> },
            cancelled: { label: 'Cancelled', color: 'hsl(0, 72%, 55%)', bg: 'rgba(239,68,68,0.12)', icon: <X size={12} /> },
        };
        const s = map[subscription.status] || map.trial;
        return (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold"
                style={{ background: s.bg, color: s.color }}>
                {s.icon} {s.label}
            </span>
        );
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'hsl(var(--primary))', borderTopColor: 'transparent' }} />
            </div>
        );
    }

    const pricing = getSubscriptionPricing(subscription);
    if (!subscription || !pricing) {
        return (
            <div className="glass-panel-strong p-6 max-w-xl mx-auto mt-8 text-center">
                <AlertTriangle size={28} className="mx-auto mb-3" style={{ color: 'hsl(38, 92%, 50%)' }} />
                <h2 className="text-lg font-bold" style={{ color: 'hsl(var(--foreground))' }}>Subscription pricing unavailable</h2>
                <p className="text-sm mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {loadError || 'Live plan prices could not be verified. Billing actions are disabled so an outdated price is never shown or charged.'}
                </p>
                <button
                    type="button"
                    onClick={() => {
                        setLoading(true);
                        fetchSubscription();
                    }}
                    className="mt-4 px-5 py-2.5 rounded-xl text-sm font-bold text-white"
                    style={{ background: 'hsl(var(--primary))' }}
                >
                    Retry
                </button>
            </div>
        );
    }

    const isBlocked = subscription?.status === 'blocked';
    const isTrial = subscription?.status === 'trial';
    const isPastDue = subscription?.status === 'past_due';
    const isSubscribed = ['active', 'free_period'].includes(subscription?.status);
    const isElite = subscription?.plan === 'elite';
    const bonusExpiredPermanently = subscription?.bonusFeaturesExpiredPermanently && !isElite;
    const hasGracePeriod = isBlocked && subscription?.bonusGraceDeadline && subscription?.bonusGraceDaysRemaining > 0 && !bonusExpiredPermanently;
    const bonusAboutToExpire = isSubscribed && subscription?.plan === 'starter' && subscription?.bonusFeaturesActive && subscription?.bonusExpiryDate && (() => {
        const daysLeft = Math.ceil((new Date(subscription.bonusExpiryDate) - new Date()) / (1000 * 60 * 60 * 24));
        return daysLeft <= 7 && daysLeft > 0;
    })();
    const bonusDaysUntilExpiry = subscription?.bonusExpiryDate ? Math.max(0, Math.ceil((new Date(subscription.bonusExpiryDate) - new Date()) / (1000 * 60 * 60 * 24))) : 0;
    const bonusMonthsRemaining = subscription?.bonusExpiryDate
        ? calendarMonthsRemaining(subscription.bonusExpiryDate)
        : 6;
    const isStarterSubscribed = isSubscribed && !isElite;
    const founderPromotion = subscription?.founderPromotion;
    const founderReservationMinutes = Number.isSafeInteger(founderPromotion?.checkoutReservationMinutes)
        && founderPromotion.checkoutReservationMinutes > 0
        ? founderPromotion.checkoutReservationMinutes
        : null;
    const founderRateActive = Boolean(subscription?.founderOffer?.active);
    const useFounderRate = founderRateActive || founderCouponApplied;
    const getsIntroductoryFreePeriod = !subscription?.hasUsedFreePeriod;
    const metaAdsAddonCents = pricing.metaAdsAddonCents;
    const metaAdsAddonPrice = formatUsdCents(metaAdsAddonCents);
    const starterFounderPriceLabel = formatUsdCents(pricing.starter.founderAmountCents);
    const eliteFounderPriceLabel = formatUsdCents(pricing.elite.founderAmountCents);
    const starterMonthlyPrice = useFounderRate
        ? pricing.starter.founderAmountCents
        : pricing.starter.standardAmountCents;
    const starterMonthlyPriceLabel = formatUsdCents(starterMonthlyPrice);
    const eliteBaseMonthlyPrice = useFounderRate
        ? pricing.elite.founderAmountCents
        : pricing.elite.standardAmountCents;
    const eliteMonthlyPrice = eliteBaseMonthlyPrice + (eliteMetaAds && metaAdsAddonCents > 0 ? metaAdsAddonCents : 0);
    const eliteMonthlyPriceLabel = formatUsdCents(eliteMonthlyPrice);
    const activeEliteBasePrice = founderRateActive
        ? pricing.elite.founderAmountCents
        : pricing.elite.standardAmountCents;
    const activeEliteMonthlyPrice = activeEliteBasePrice + (subscription?.metaAdsIncluded && metaAdsAddonCents > 0 ? metaAdsAddonCents : 0);
    const activeEliteMonthlyPriceLabel = formatUsdCents(activeEliteMonthlyPrice);
    const eliteMetaSelectionChanged = isElite && isSubscribed && Boolean(subscription?.metaAdsIncluded) !== eliteMetaAds;
    const toggleMetaAds = () => {
        setEliteMetaAds((value) => !value);
    };

    const catalogFeatureList = (key, fallback) => {
        const values = subscription?.catalog?.features?.[key];
        return Array.isArray(values) && values.length > 0 && values.every(value => typeof value === 'string' && value.trim())
            ? values.map(value => value.trim())
            : fallback;
    };
    const trialFeatures = catalogFeatureList('trial', [
        'Store & products visible to all customers',
        'Up to 15 product listings during the free trial',
        'Secure payment processing',
        'Custom subdomain for your store',
        'Order management & customer insights',
        'Unlimited seller AI chat',
        'Manage your store, orders & products from WhatsApp by chatting with AI',
        'Get WhatsApp notifications when you receive a new order',
        'Rozare WhatsApp order confirmation automation',
        'Featured product highlighting (6 products)',
    ]);
    const starterFeatures = catalogFeatureList('starter', [
        'Store & products visible to all customers',
        'Unlimited product listings',
        'Secure payment processing',
        'Custom subdomain for your store',
        'Order management & customer insights',
        'Unlimited seller AI chat',
        'Manage your store, orders & products from WhatsApp by chatting with AI',
        'Get WhatsApp notifications when you receive a new order',
        'Rozare WhatsApp order confirmation automation',
        'Featured product highlighting (6 products)',
    ]);

    const bonusFeatures = catalogFeatureList('bonus', [
        'Smart description generator with AI',
        'Advanced analytics & growth insights',
        'Smart tag AI generator for products',
        'Priority support & early access to new features',
        'Coupon & discount management system',
        'Bulk discount & promotional tools',
    ]);

    const eliteOnlyFeatures = catalogFeatureList('eliteOnly', [
        'Rozare will run TikTok ads for your store and featured products',
        'Customizable store themes with your own colors and layouts',
    ]);

    const eliteCardFeatures = [
        { icon: <Store size={13} />, text: 'Everything in Starter' },
        { icon: <Sparkles size={13} />, text: 'Featured product highlighting (12 products)' },
        ...bonusFeatures.map((text) => ({ icon: <Check size={11} />, text })),
        ...eliteOnlyFeatures.map((text) => ({
            icon: text.toLowerCase().includes('tiktok') ? <Megaphone size={11} /> : <Palette size={11} />,
            text,
        })),
    ];

    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 sm:p-6 max-w-4xl mx-auto">

            {checkoutReturnStatus && checkoutReturnStatus !== 'confirmed' && (
                <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mb-6 p-5 rounded-2xl border"
                    role="status"
                    style={{ background: 'rgba(14, 165, 233, 0.08)', borderColor: 'rgba(14, 165, 233, 0.24)' }}
                >
                    <div className="flex items-start gap-3">
                        <div className="p-2 rounded-xl" style={{ background: 'rgba(14, 165, 233, 0.14)' }}>
                            <Clock size={20} style={{ color: 'hsl(200, 80%, 50%)' }} />
                        </div>
                        <div>
                            <h3 className="text-sm font-bold" style={{ color: 'hsl(200, 80%, 45%)' }}>
                                {checkoutReturnStatus === 'verifying' ? 'Verifying subscription' : 'Subscription confirmation pending'}
                            </h3>
                            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Stripe checkout has returned, but Rozare has not yet confirmed an active entitlement. Your store access will update only after the authenticated subscription status confirms payment.
                            </p>
                            <button type="button" onClick={recheckCheckoutReturn} disabled={checkoutReturnStatus === 'verifying'} className="text-xs font-semibold mt-2 disabled:opacity-60" style={{ color: 'hsl(200, 80%, 45%)' }}>
                                Check status again
                            </button>
                        </div>
                    </div>
                </motion.div>
            )}

            {/* Blocked Banner */}
            {isBlocked && (
                <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mb-6 p-5 rounded-2xl border"
                    style={{ background: 'rgba(239, 68, 68, 0.08)', borderColor: 'rgba(239, 68, 68, 0.2)' }}
                >
                    <div className="flex items-start gap-3">
                        <div className="p-2 rounded-xl" style={{ background: 'rgba(239, 68, 68, 0.15)' }}>
                            <Lock size={20} style={{ color: 'hsl(0, 72%, 55%)' }} />
                        </div>
                        <div>
                            <h3 className="text-sm font-bold" style={{ color: 'hsl(0, 72%, 55%)' }}>Store Temporarily Blocked</h3>
                            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                {subscription?.blockedReason || 'Your trial has expired. Subscribe to reactivate your store, products, and subdomain.'}
                            </p>
                            <div className="flex flex-wrap gap-2 mt-3">
                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium" style={{ background: 'rgba(239,68,68,0.1)', color: 'hsl(0, 72%, 55%)' }}>
                                    <Store size={11} /> Store hidden
                                </span>
                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium" style={{ background: 'rgba(239,68,68,0.1)', color: 'hsl(0, 72%, 55%)' }}>
                                    <Package size={11} /> Products hidden
                                </span>
                            </div>
                        </div>
                    </div>
                </motion.div>
            )}

            {/* Past Due Banner */}
            {isPastDue && (
                <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mb-6 p-5 rounded-2xl border"
                    style={{ background: 'rgba(249, 115, 22, 0.08)', borderColor: 'rgba(249, 115, 22, 0.25)' }}
                >
                    <div className="flex items-start gap-3">
                        <div className="p-2 rounded-xl" style={{ background: 'rgba(249, 115, 22, 0.15)' }}>
                            <AlertTriangle size={20} style={{ color: 'hsl(25, 90%, 50%)' }} />
                        </div>
                        <div className="flex-1">
                            <h3 className="text-sm font-bold" style={{ color: 'hsl(25, 90%, 45%)' }}>Payment Failed — Update Payment Method</h3>
                            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Your last payment could not be processed. Update your payment method to avoid store suspension.
                            </p>
                            <p className="text-[11px] mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Stripe will retry the payment automatically. If it continues to fail, your store will be blocked.
                            </p>
                        </div>
                    </div>
                </motion.div>
            )}

            {/* 3-Day Grace Period Banner — bonus features at risk */}
            {hasGracePeriod && (
                <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mb-6 p-5 rounded-2xl border"
                    style={{ background: 'rgba(249, 115, 22, 0.08)', borderColor: 'rgba(249, 115, 22, 0.25)' }}
                >
                    <div className="flex items-start gap-3">
                        <div className="p-2 rounded-xl" style={{ background: 'rgba(249, 115, 22, 0.15)' }}>
                            <Clock size={20} style={{ color: 'hsl(25, 90%, 50%)' }} />
                        </div>
                        <div className="flex-1">
                            <h3 className="text-sm font-bold" style={{ color: 'hsl(25, 90%, 45%)' }}>
                                {subscription.bonusGraceDaysRemaining} Day{subscription.bonusGraceDaysRemaining !== 1 ? 's' : ''} Left to Keep Bonus Features!
                            </h3>
                            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Re-subscribe now to keep your bonus features for the remaining time. After {subscription.bonusGraceDaysRemaining} day{subscription.bonusGraceDaysRemaining !== 1 ? 's' : ''}, bonus features will be <strong>permanently removed</strong> from the Starter plan.
                            </p>
                            <div className="flex flex-wrap gap-2 mt-3">
                                <motion.button
                                    whileHover={{ scale: 1.02 }}
                                    whileTap={{ scale: 0.98 }}
                                    onClick={() => handleSubscribe('starter')}
                                    disabled={checkoutLoading === 'starter'}
                                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-white"
                                    style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(250, 60%, 55%))' }}
                                >
                                    {checkoutLoading === 'starter' ? (
                                        <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    ) : (
                                        <><CreditCard size={13} /> Re-subscribe Now</>
                                    )}
                                </motion.button>
                                <motion.button
                                    whileHover={{ scale: 1.02 }}
                                    whileTap={{ scale: 0.98 }}
                                    onClick={() => handleSubscribe('elite')}
                                    disabled={checkoutLoading === 'elite'}
                                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-white"
                                    style={{ background: 'linear-gradient(135deg, hsl(270, 60%, 55%), hsl(290, 50%, 50%))' }}
                                >
                                    {checkoutLoading === 'elite' ? (
                                        <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    ) : (
                                        <><Gem size={13} /> Upgrade to Elite</>
                                    )}
                                </motion.button>
                            </div>
                        </div>
                    </div>
                </motion.div>
            )}

            {/* Bonus Features About to Expire Banner (within 7 days) */}
            {bonusAboutToExpire && !isElite && (
                <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mb-6 p-5 rounded-2xl border"
                    style={{ background: 'rgba(249, 115, 22, 0.06)', borderColor: 'rgba(249, 115, 22, 0.2)' }}
                >
                    <div className="flex items-start gap-3">
                        <div className="p-2 rounded-xl" style={{ background: 'rgba(249, 115, 22, 0.12)' }}>
                            <AlertTriangle size={20} style={{ color: 'hsl(30, 90%, 50%)' }} />
                        </div>
                        <div>
                            <h3 className="text-sm font-bold" style={{ color: 'hsl(30, 85%, 45%)' }}>
                                Bonus Features Expiring in {bonusDaysUntilExpiry} Day{bonusDaysUntilExpiry !== 1 ? 's' : ''}
                            </h3>
                            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Your bonus features (analytics, smart tags, featured products, coupons, etc.) will expire on {new Date(subscription.bonusExpiryDate).toLocaleDateString()}. Upgrade to Rozare Elite to keep them permanently.
                            </p>
                            <button onClick={() => handleSubscribe('elite')} disabled={checkoutLoading === 'elite'}
                                className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-white"
                                style={{ background: 'linear-gradient(135deg, hsl(270, 60%, 55%), hsl(290, 50%, 50%))' }}>
                                {checkoutLoading === 'elite' ? (
                                    <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                ) : (
                                    <><Gem size={13} /> Upgrade to Elite — Keep Bonus Forever</>
                                )}
                            </button>
                        </div>
                    </div>
                </motion.div>
            )}

            {/* Bonus Features Expired Banner */}
            {bonusExpiredPermanently && isSubscribed && (
                <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mb-6 p-5 rounded-2xl border"
                    style={{ background: 'rgba(139, 92, 246, 0.06)', borderColor: 'rgba(139, 92, 246, 0.2)' }}
                >
                    <div className="flex items-start gap-3">
                        <div className="p-2 rounded-xl" style={{ background: 'rgba(139, 92, 246, 0.12)' }}>
                            <Award size={20} style={{ color: 'hsl(270, 60%, 55%)' }} />
                        </div>
                        <div>
                            <h3 className="text-sm font-bold" style={{ color: 'hsl(270, 60%, 55%)' }}>Bonus Features Expired</h3>
                        </div>
                    </div>
                </motion.div>
            )}

            {/* Cancellation banner — subscription scheduled to end at period end */}
            {subscription?.cancelledAt && !subscription?.pendingDowngrade && ['active', 'free_period'].includes(subscription?.status) && (() => {
                const endDate = subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
                const daysLeft = endDate ? Math.max(0, Math.ceil((endDate - new Date()) / 86400000)) : null;
                return (
                    <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="mb-6 p-5 rounded-2xl border"
                        style={{ background: 'rgba(239, 68, 68, 0.08)', borderColor: 'rgba(239, 68, 68, 0.2)' }}
                    >
                        <div className="flex items-start gap-3">
                            <div className="p-2 rounded-xl" style={{ background: 'rgba(239, 68, 68, 0.15)' }}>
                                <X size={20} style={{ color: 'hsl(0, 72%, 55%)' }} />
                            </div>
                            <div className="flex-1">
                                <h3 className="text-sm font-bold" style={{ color: 'hsl(0, 72%, 55%)' }}>Cancellation Scheduled</h3>
                                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    Your plan will remain active for{' '}
                                    <strong style={{ color: 'hsl(var(--foreground))' }}>
                                        {daysLeft !== null ? `${daysLeft} more day${daysLeft !== 1 ? 's' : ''}` : 'the remainder of this period'}
                                    </strong>
                                    {endDate && <> and end on <strong style={{ color: 'hsl(var(--foreground))' }}>{endDate.toLocaleDateString()}</strong></>}.
                                    After that your store will be blocked until you re-subscribe.
                                </p>
                                {founderRateActive && (
                                    <p className="text-xs font-semibold mt-2" style={{ color: 'hsl(0, 72%, 55%)' }}>
                                        Your FIRST100 rate will be permanently lost only if this subscription reaches its end date.
                                    </p>
                                )}
                                <button
                                    type="button"
                                    onClick={handleResume}
                                    disabled={resumeLoading}
                                    className="mt-3 px-4 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-60"
                                    style={{ background: 'hsl(220, 70%, 55%)' }}
                                >
                                    {resumeLoading ? 'Resuming...' : 'Keep Subscription'}
                                </button>
                            </div>
                        </div>
                    </motion.div>
                );
            })()}

            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-xl font-bold" style={{ color: 'hsl(var(--foreground))' }}>
                        Rozare Subscription Plans
                    </h1>
                    <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Manage your seller plan</p>
                </div>
                {getStatusBadge()}
            </div>

            {/* Current Plan Card — hidden once subscribed */}
            {!isSubscribed && (
            <div className="glass-panel-strong p-6 mb-6">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: isElite ? 'linear-gradient(135deg, hsl(270, 60%, 55%), hsl(290, 50%, 50%))' : isSubscribed ? 'linear-gradient(135deg, hsl(150, 60%, 45%), hsl(170, 50%, 40%))' : 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(250, 60%, 55%))' }}>
                            {isElite ? <Gem size={22} className="text-white" /> : <Crown size={22} className="text-white" />}
                        </div>
                         <div>
                            <h2 className="text-base font-bold" style={{ color: 'hsl(var(--foreground))' }}>
                                {isSubscribed ? (isElite ? 'Rozare Elite' : 'Rozare Starter') : isTrial ? 'Free Trial' : 'No Active Plan'}
                            </h2>
                            <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                {isSubscribed
                                    ? subscription?.status === 'free_period'
                                        ? `Free until ${new Date(subscription.freePeriodEndDate).toLocaleDateString()}, then ${isElite ? activeEliteMonthlyPriceLabel : starterMonthlyPriceLabel}/mo`
                                        : `${isElite ? activeEliteMonthlyPriceLabel : starterMonthlyPriceLabel}/month - Cancel anytime`
                                    : isTrial
                                        ? `${subscription?.trialDaysRemaining} day${subscription?.trialDaysRemaining !== 1 ? 's' : ''} remaining`
                                        : 'Subscribe to activate your store'
                                }
                            </p>
                            {isSubscribed && subscription?.bonusFeaturesActive && (
                                <p className="text-[11px] mt-1 flex items-center gap-1" style={{ color: bonusAboutToExpire ? 'hsl(30, 90%, 50%)' : 'hsl(270, 60%, 55%)' }}>
                                    <Award size={11} />
                                    {isElite
                                        ? 'Bonus features permanently included'
                                        : bonusAboutToExpire
                                            ? `Bonus features expire in ${bonusDaysUntilExpiry} day${bonusDaysUntilExpiry !== 1 ? 's' : ''}!`
                                            : subscription?.bonusExpiryDate
                                                ? `Bonus features active until ${new Date(subscription.bonusExpiryDate).toLocaleDateString()}`
                                                : 'Bonus features active'
                                    }
                                    {bonusAboutToExpire && (
                                        <span className="ml-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold"
                                            style={{ background: 'rgba(249, 115, 22, 0.15)', color: 'hsl(30, 90%, 50%)' }}>
                                            EXPIRING SOON
                                        </span>
                                    )}
                                </p>
                            )}
                        </div>
                    </div>
                    {isSubscribed && !subscription?.cancelledAt && (
                        <div className="flex items-center gap-2">
                            {!isElite && (
                                <button onClick={() => setShowUpgradeConfirm(true)}
                                    className="text-xs px-3 py-1.5 rounded-lg transition-colors font-semibold"
                                    style={{ color: 'hsl(270, 60%, 55%)', background: 'rgba(139, 92, 246, 0.08)' }}>
                                    Upgrade
                                </button>
                            )}
                            {isElite && (
                                <button onClick={() => setShowDowngradeConfirm(true)}
                                    className="text-xs px-3 py-1.5 rounded-lg transition-colors font-semibold"
                                    style={{ color: 'hsl(var(--muted-foreground))', background: 'rgba(0, 0, 0, 0.04)' }}>
                                    Downgrade
                                </button>
                            )}
                            <button onClick={() => setShowCancelConfirm(true)}
                                className="text-xs px-3 py-1.5 rounded-lg transition-colors"
                                style={{ color: 'hsl(0, 72%, 55%)', background: 'rgba(239, 68, 68, 0.08)' }}>
                                Cancel
                            </button>
                        </div>
                    )}
                    {/* Pending downgrade banner */}
                    {isSubscribed && subscription?.pendingDowngrade === 'starter' && (
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] font-semibold px-2 py-1 rounded-lg" style={{ background: 'rgba(249, 115, 22, 0.1)', color: 'hsl(30, 80%, 45%)' }}>
                                Switching to Starter
                            </span>
                            <button onClick={handleCancelDowngrade} disabled={cancelDowngradeLoading}
                                className="text-[10px] px-2 py-1 rounded-lg font-semibold"
                                style={{ color: 'hsl(270, 60%, 55%)', background: 'rgba(139, 92, 246, 0.08)' }}>
                                {cancelDowngradeLoading ? '...' : 'Keep Elite'}
                            </button>
                        </div>
                    )}
                </div>

                {/* Trial Feature List */}
                {isTrial && (
                    <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--glass-border)' }}>
                        <p className="text-xs font-semibold mb-3" style={{ color: 'hsl(var(--foreground))' }}>
                            Starter features and eligible Elite tools are available in your 15-day free trial
                        </p>

                        <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'hsl(150, 60%, 45%)' }}>Features from Starter</p>
                        <div className="space-y-1.5 mb-3">
                            {trialFeatures.map((f, i) => (
                                <div key={i} className="flex items-center gap-2">
                                    <Check size={12} style={{ color: 'hsl(150, 60%, 45%)' }} />
                                    <span className="text-[11px]" style={{ color: 'hsl(var(--foreground))' }}>{f}</span>
                                </div>
                            ))}
                        </div>

                        <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'hsl(270, 60%, 55%)' }}>Features from Elite</p>
                        <div className="space-y-1.5">
                            {bonusFeatures.map((f, i) => (
                                <div key={i} className="flex items-center gap-2">
                                    <Check size={12} style={{ color: 'hsl(270, 60%, 55%)' }} />
                                    <span className="text-[11px]" style={{ color: 'hsl(var(--foreground))' }}>{f}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Blocked — show what they lost */}
                {isBlocked && (
                    <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--glass-border)' }}>
                        <div className="p-3 rounded-xl mb-3" style={{ background: 'rgba(239, 68, 68, 0.06)', border: '1px solid rgba(239, 68, 68, 0.15)' }}>
                            <p className="text-xs font-semibold" style={{ color: 'hsl(0, 72%, 55%)' }}>
                                {subscription?.plan === 'free_trial' || subscription?.blockedReason?.includes('Trial')
                                    ? 'Your 15-day free trial has ended'
                                    : 'Your subscription has expired'}
                            </p>
                            <p className="text-[11px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Subscribe to get all these features back:
                            </p>
                        </div>

                        <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'hsl(150, 60%, 45%)' }}>Features from Starter</p>
                        <div className="space-y-1.5 mb-3">
                            {(subscription?.plan === 'free_trial' || subscription?.blockedReason?.includes('Trial') ? trialFeatures : starterFeatures).map((f, i) => (
                                <div key={i} className="flex items-center gap-2">
                                    <X size={12} style={{ color: 'hsl(0, 72%, 55%)' }} />
                                    <span className="text-[11px] line-through" style={{ color: 'hsl(var(--muted-foreground))' }}>{f}</span>
                                </div>
                            ))}
                        </div>

                        <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'hsl(270, 60%, 55%)' }}>Features from Elite</p>
                        <div className="space-y-1.5">
                            {bonusFeatures.map((f, i) => (
                                <div key={i} className="flex items-center gap-2">
                                    <X size={12} style={{ color: 'hsl(0, 72%, 55%)' }} />
                                    <span className="text-[11px] line-through" style={{ color: 'hsl(var(--muted-foreground))' }}>{f}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Active Starter subscriber — show current features and bonus status */}
                {isSubscribed && !isElite && (
                    <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--glass-border)' }}>
                        <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'hsl(150, 60%, 45%)' }}>Your Active Features</p>
                        <div className="space-y-1.5 mb-3">
                            {[
                                'Store & products visible to all customers',
                                'Unlimited product listings',
                                'Secure payment processing',
                                'Custom subdomain for your store',
                                'Order management & customer insights',
                                'Manage your store, orders & products from WhatsApp by chatting with AI',
                                'Get WhatsApp notifications when you receive a new order',
                                'Rozare WhatsApp order confirmation automation',
                            ].map((f, i) => (
                                <div key={i} className="flex items-center gap-2">
                                    <Check size={12} style={{ color: 'hsl(150, 60%, 45%)' }} />
                                    <span className="text-[11px]" style={{ color: 'hsl(var(--foreground))' }}>{f}</span>
                                </div>
                            ))}
                        </div>

                        {/* Bonus features: only show list if still active, otherwise just show expired text */}
                        {bonusExpiredPermanently ? (
                            <div className="p-3 rounded-xl" style={{ background: 'rgba(139, 92, 246, 0.06)', border: '1px solid rgba(139, 92, 246, 0.15)' }}>
                                <p className="text-xs font-semibold flex items-center gap-1.5" style={{ color: 'hsl(270, 60%, 55%)' }}>
                                    <Award size={13} /> Bonus Features Expired
                                </p>
                            </div>
                        ) : subscription?.bonusFeaturesActive && (
                            <>
                                <p className="text-[10px] font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5" style={{ color: 'hsl(270, 60%, 55%)' }}>
                                    Features from Elite
                                    {bonusDaysUntilExpiry <= 30 && (
                                        <span className="text-[9px] font-normal px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(249, 115, 22, 0.12)', color: 'hsl(30, 90%, 50%)' }}>
                                            {bonusDaysUntilExpiry} DAYS LEFT
                                        </span>
                                    )}
                                </p>
                                <div className="space-y-1.5">
                                    {bonusFeatures.map((f, i) => (
                                        <div key={i} className="flex items-center gap-2">
                                            <Check size={12} style={{ color: 'hsl(270, 60%, 55%)' }} />
                                            <span className="text-[11px]" style={{ color: 'hsl(var(--foreground))' }}>{f}</span>
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>
                )}

                {/* Active Elite subscriber — show all features */}
                {isSubscribed && isElite && (
                    <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--glass-border)' }}>
                        <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'hsl(150, 60%, 45%)' }}>Your Active Features</p>
                        <div className="space-y-1.5 mb-3">
                            {[
                                'Store & products visible to all customers',
                                'Unlimited product listings',
                                'Secure payment processing',
                                'Custom subdomain for your store',
                                'Order management & customer insights',
                                'Manage your store, orders & products from WhatsApp by chatting with AI',
                                'Get WhatsApp notifications when you receive a new order',
                                'Rozare WhatsApp order confirmation automation',
                                'Rozare-run TikTok ads for your store and featured products',
                            ].map((f, i) => (
                                <div key={i} className="flex items-center gap-2">
                                    <Check size={12} style={{ color: 'hsl(150, 60%, 45%)' }} />
                                    <span className="text-[11px]" style={{ color: 'hsl(var(--foreground))' }}>{f}</span>
                                </div>
                            ))}
                        </div>

                        <p className="text-[10px] font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5" style={{ color: 'hsl(270, 60%, 55%)' }}>
                            Features from Elite
                            <span className="text-[9px] font-normal px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(139, 92, 246, 0.12)', color: 'hsl(270, 60%, 55%)' }}>
                                PERMANENT
                            </span>
                        </p>
                        <div className="space-y-1.5">
                            {bonusFeatures.map((f, i) => (
                                <div key={i} className="flex items-center gap-2">
                                    <Check size={12} style={{ color: 'hsl(270, 60%, 55%)' }} />
                                    <span className="text-[11px]" style={{ color: 'hsl(var(--foreground))' }}>{f}</span>
                                </div>
                            ))}
                            {eliteOnlyFeatures.map((f, i) => (
                                <div key={`elite-only-${i}`} className="flex items-center gap-2">
                                    <Check size={12} style={{ color: 'hsl(270, 60%, 55%)' }} />
                                    <span className="text-[11px]" style={{ color: 'hsl(var(--foreground))' }}>{f}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
            )}

            {founderPromotion && (founderRateActive || founderPromotion.sellerEligible || founderPromotion.forfeited) && (
                <div
                    className="glass-panel-strong p-5 mb-6 border"
                    style={{
                        borderColor: founderRateActive || founderCouponApplied
                            ? 'rgba(16, 185, 129, 0.35)'
                            : 'rgba(59, 130, 246, 0.25)',
                    }}
                >
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                        <div className="flex items-start gap-3">
                            <div
                                className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                                style={{ background: 'rgba(59, 130, 246, 0.12)', color: 'hsl(220, 70%, 55%)' }}
                            >
                                <Tag size={18} />
                            </div>
                            <div>
                                <h3 className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>
                                    {founderRateActive ? 'FIRST100 founder rate locked' : 'First 100 Sellers offer'}
                                </h3>
                                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    {founderRateActive
                                        ? 'Your locked FIRST100 founder rate stays active across Starter and Elite plan changes while this subscription remains uninterrupted.'
                                        : `Use ${founderPromotion.code} for an extra ${founderPromotion.discountPercent}% off: Starter becomes ${starterFounderPriceLabel}/month and Elite becomes ${eliteFounderPriceLabel}/month.`}
                                </p>
                                {!founderRateActive && founderPromotion.available && (
                                    <p className="text-[11px] font-semibold mt-2" style={{ color: 'hsl(220, 70%, 55%)' }}>
                                        {founderPromotion.sellerHasReservation
                                            ? 'A founder spot is currently reserved for your account'
                                            : `${founderPromotion.remaining} of ${founderPromotion.maxRedemptions} founder spots remaining`}
                                    </p>
                                )}
                                {founderPromotion.forfeited && (
                                    <p className="text-[11px] font-semibold mt-2" style={{ color: 'hsl(0, 72%, 55%)' }}>
                                        This account previously used the offer. Founder pricing cannot be reclaimed after the subscription ends.
                                    </p>
                                )}
                            </div>
                        </div>

                        {!founderRateActive && founderPromotion.sellerEligible && founderPromotion.available && (
                            <div className="flex gap-2 w-full sm:w-auto">
                                <input
                                    value={couponCode}
                                    onChange={(event) => {
                                        setCouponCode(event.target.value.toUpperCase());
                                        setFounderCouponApplied(false);
                                    }}
                                    placeholder="Coupon code"
                                    aria-label="Subscription coupon code"
                                    className="min-w-0 sm:w-40 px-3 py-2.5 rounded-xl text-xs font-semibold outline-none glass-inner"
                                    style={{ color: 'hsl(var(--foreground))' }}
                                />
                                <button
                                    type="button"
                                    onClick={founderCouponApplied
                                        ? () => {
                                            setFounderCouponApplied(false);
                                            setCouponCode('');
                                        }
                                        : handleApplyFounderCoupon}
                                    className="px-4 py-2.5 rounded-xl text-xs font-bold text-white shrink-0"
                                    style={{
                                        background: founderCouponApplied
                                            ? 'hsl(150, 60%, 42%)'
                                            : 'hsl(220, 70%, 55%)',
                                    }}
                                >
                                    {founderCouponApplied ? 'Applied' : 'Apply'}
                                </button>
                            </div>
                        )}
                    </div>
                    {founderCouponApplied && !founderRateActive && (
                        <p className="text-[10px] mt-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            {founderReservationMinutes
                                ? `Your slot is reserved for ${founderReservationMinutes} minutes after you continue to Stripe and is permanently claimed when Checkout completes.`
                                : 'Your slot is reserved after you continue to Stripe and is permanently claimed when Checkout completes.'}
                        </p>
                    )}
                </div>
            )}

            {/* Pricing Cards — always visible */}
            <div className="grid md:grid-cols-2 gap-4 mb-6">
                    {/* Rozare Starter Card */}
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.1 }}
                        className="glass-panel-strong p-6 border-2"
                        style={{ borderColor: 'rgba(99, 102, 241, 0.3)' }}
                    >
                        <div className="text-center mb-5">
                            <div className="flex flex-wrap items-center justify-center gap-2 mb-3">
                                {getsIntroductoryFreePeriod && (
                                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold"
                                        style={{ background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 45%)' }}>
                                        <Sparkles size={12} /> {pricing.starter.freePeriodDays} DAYS FREE
                                    </span>
                                )}
                                <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold"
                                    style={{ background: 'rgba(59, 130, 246, 0.12)', color: 'hsl(220, 70%, 55%)' }}>
                                    {pricing.starter.advertisedDiscountPercent}% OFF
                                </span>
                            </div>
                            <h3 className="text-xl font-bold" style={{ color: 'hsl(var(--foreground))' }}>
                                Rozare Starter
                            </h3>
                            <p className="text-lg font-bold mt-1" style={{ color: 'hsl(var(--foreground))' }}>
                                <span style={{ color: 'hsl(var(--muted-foreground))', textDecoration: 'line-through', fontSize: '0.9rem' }}>
                                    {formatUsdCents(pricing.starter.listAmountCents)}
                                </span>{' '}
                                {useFounderRate && (
                                    <span style={{ color: 'hsl(var(--muted-foreground))', textDecoration: 'line-through', fontSize: '0.9rem' }}>
                                        {formatUsdCents(pricing.starter.standardAmountCents)}{' '}
                                    </span>
                                )}
                                {starterMonthlyPriceLabel}<span className="text-sm font-normal" style={{ color: 'hsl(var(--muted-foreground))' }}>/mo</span>
                            </p>
                            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                {getsIntroductoryFreePeriod ? `First ${pricing.starter.freePeriodDays} days free, then ` : ''}{starterMonthlyPriceLabel}/month - Cancel anytime
                            </p>
                            {useFounderRate && (
                                <p className="text-[11px] font-semibold mt-1" style={{ color: 'hsl(150, 60%, 42%)' }}>
                                    Includes the locked FIRST100 founder rate
                                </p>
                            )}
                        </div>

                        <div className="space-y-2 mb-5">
                            <p className="text-xs font-bold mb-2" style={{ color: 'hsl(var(--foreground))' }}>Core Features</p>
                            {[
                                { icon: <Store size={13} />, text: 'Store & products visible to all customers' },
                                { icon: <Package size={13} />, text: 'Unlimited product listings' },
                                { icon: <CreditCard size={13} />, text: 'Secure payment processing' },
                                { icon: <Shield size={13} />, text: 'Custom subdomain for your store' },
                                { icon: <Users size={13} />, text: 'Order management & insights' },
                                { icon: <MessageCircle size={13} />, text: 'Manage store, orders & products from WhatsApp via AI' },
                                { icon: <Bell size={13} />, text: 'WhatsApp notifications for new orders' },
                                { icon: <MessageCircle size={13} />, text: 'WhatsApp order confirmation' },
                                { icon: <Sparkles size={13} />, text: 'Featured product highlighting (6 products)' },
                            ].map((f, i) => (
                                <div key={i} className="flex items-center gap-2.5">
                                    <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 45%)' }}>
                                        {f.icon}
                                    </div>
                                    <span className="text-[11px]" style={{ color: 'hsl(var(--foreground))' }}>{f.text}</span>
                                </div>
                            ))}

                            <div className="border-t my-2" style={{ borderColor: 'rgba(0,0,0,0.06)' }} />
                            <p className="text-[10px] font-bold flex items-center gap-1" style={{ color: 'hsl(270, 60%, 55%)' }}>
                                <Award size={11} /> Features from Elite
                                <span className="text-[9px] font-normal px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(139, 92, 246, 0.12)', color: 'hsl(270, 60%, 55%)' }}>
                                    {isStarterSubscribed && subscription?.bonusFeaturesActive
                                        ? `${bonusMonthsRemaining} month${bonusMonthsRemaining !== 1 ? 's' : ''} remaining`
                                        : '6 months only'}
                                </span>
                            </p>
                            {bonusFeatures.map((f, i) => (
                                <div key={`bonus-${i}`} className="flex items-center gap-2.5">
                                    <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ background: 'rgba(139, 92, 246, 0.12)', color: 'hsl(270, 60%, 55%)' }}>
                                        <Check size={11} />
                                    </div>
                                    <span className="text-[11px]" style={{ color: 'hsl(var(--foreground))' }}>{f}</span>
                                </div>
                            ))}
                        </div>

                        {isStarterSubscribed ? (
                            <div className="space-y-2">
                                <div className="w-full py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2"
                                    style={{ background: 'rgba(16,185,129,0.12)', color: 'hsl(150, 60%, 45%)' }}>
                                    <Check size={15} /> Current Plan
                                </div>
                                {!subscription?.cancelledAt && (
                                    <motion.button
                                        whileHover={{ scale: 1.02 }}
                                        whileTap={{ scale: 0.98 }}
                                        onClick={() => setShowCancelConfirm(true)}
                                        className="w-full py-2.5 rounded-xl font-bold text-xs flex items-center justify-center gap-2"
                                        style={{ background: 'rgba(239, 68, 68, 0.08)', color: 'hsl(0, 72%, 55%)' }}
                                    >
                                        <X size={14} /> Cancel Subscription
                                    </motion.button>
                                )}
                            </div>
                        ) : (
                        <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => isElite ? setShowDowngradeConfirm(true) : handleSubscribe('starter')}
                            disabled={checkoutLoading === 'starter'}
                            className="w-full py-3 rounded-xl font-bold text-sm text-white flex items-center justify-center gap-2 transition-all disabled:opacity-60"
                            style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(250, 60%, 55%))' }}
                        >
                            {checkoutLoading === 'starter' ? (
                                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            ) : isElite ? (
                                <><ArrowRight size={15} style={{ transform: 'rotate(180deg)' }} /> Downgrade to Starter</>
                            ) : (
                                <>
                                    <CreditCard size={15} />
                                    {getsIntroductoryFreePeriod
                                        ? `Subscribe - ${pricing.starter.freePeriodDays} Days Free`
                                        : `Subscribe - ${starterMonthlyPriceLabel}/month`}
                                    <ArrowRight size={15} />
                                </>
                            )}
                        </motion.button>
                        )}
                    </motion.div>

                    {/* Rozare Elite Card */}
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.15 }}
                        className="glass-panel-strong p-6 border-2 relative overflow-hidden"
                        style={{ borderColor: 'rgba(139, 92, 246, 0.4)' }}
                    >
                        {/* Recommended badge */}
                        <div className="absolute top-0 right-0 px-3 py-1 text-[10px] font-bold text-white rounded-bl-xl"
                            style={{ background: 'linear-gradient(135deg, hsl(270, 60%, 55%), hsl(290, 50%, 50%))' }}>
                            RECOMMENDED
                        </div>

                        <div className="text-center mb-5">
                            <div className="flex flex-wrap items-center justify-center gap-2 mb-3">
                                {getsIntroductoryFreePeriod && (
                                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold"
                                        style={{ background: 'rgba(139, 92, 246, 0.12)', color: 'hsl(270, 60%, 55%)' }}>
                                        <Gem size={12} /> {pricing.elite.freePeriodDays} DAYS FREE
                                    </span>
                                )}
                                <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold"
                                    style={{ background: 'rgba(59, 130, 246, 0.12)', color: 'hsl(220, 70%, 55%)' }}>
                                    {pricing.elite.advertisedDiscountPercent}% OFF
                                </span>
                            </div>
                            <h3 className="text-xl font-bold" style={{ color: 'hsl(var(--foreground))' }}>
                                Rozare Elite
                            </h3>
                            <p className="text-lg font-bold mt-1" style={{ color: 'hsl(var(--foreground))' }}>
                                <span style={{ color: 'hsl(var(--muted-foreground))', textDecoration: 'line-through', fontSize: '0.9rem' }}>
                                    {formatUsdCents(pricing.elite.listAmountCents)}
                                </span>{' '}
                                {useFounderRate && (
                                    <span style={{ color: 'hsl(var(--muted-foreground))', textDecoration: 'line-through', fontSize: '0.9rem' }}>
                                        {formatUsdCents(pricing.elite.standardAmountCents)}{' '}
                                    </span>
                                )}
                                {eliteMonthlyPriceLabel}<span className="text-sm font-normal" style={{ color: 'hsl(var(--muted-foreground))' }}>/mo</span>
                            </p>
                            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                {getsIntroductoryFreePeriod ? `First ${pricing.elite.freePeriodDays} days free, then ` : ''}{eliteMonthlyPriceLabel}/month - Cancel anytime
                            </p>
                            {useFounderRate && (
                                <p className="text-[11px] font-semibold mt-1" style={{ color: 'hsl(150, 60%, 42%)' }}>
                                    Includes the locked FIRST100 founder rate; Meta ads remain {metaAdsAddonPrice}/month
                                </p>
                            )}
                        </div>

                        <div className="space-y-2 mb-5">
                            <p className="text-xs font-bold mb-2" style={{ color: 'hsl(var(--foreground))' }}>Elite Upgrades</p>
                            {eliteCardFeatures.map((f, i) => (
                                <div key={`elite-card-${i}`} className="flex items-center gap-2.5">
                                    <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 45%)' }}>
                                        {f.icon}
                                    </div>
                                    <span className="text-[11px]" style={{ color: 'hsl(var(--foreground))' }}>{f.text}</span>
                                </div>
                            ))}
                        </div>

                        <button
                            type="button"
                            onClick={toggleMetaAds}
                            className="w-full mb-4 p-3 rounded-xl text-left glass-inner"
                            style={{ border: eliteMetaAds ? '1px solid rgba(59,130,246,0.35)' : '1px solid var(--glass-border)' }}
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div>
                                    <p className="text-xs font-bold flex items-center gap-1.5" style={{ color: 'hsl(var(--foreground))' }}>
                                        <Megaphone size={13} /> Include Meta ads
                                    </p>
                                    <p className="text-[11px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        Adds {metaAdsAddonPrice}/month to the Elite plan.
                                    </p>
                                </div>
                                <span className="px-2 py-1 rounded-full text-[10px] font-bold"
                                    style={{
                                        color: eliteMetaAds ? 'hsl(220,70%,55%)' : 'hsl(var(--muted-foreground))',
                                        background: eliteMetaAds ? 'rgba(99,102,241,0.12)' : 'rgba(255,255,255,0.08)',
                                    }}>
                                    {eliteMetaAds ? 'Selected' : 'Optional'}
                                </span>
                            </div>
                        </button>

                        {isElite && isSubscribed ? (
                            <div className="space-y-2">
                                <div className="w-full py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2"
                                    style={{ background: 'rgba(139,92,246,0.12)', color: 'hsl(270, 60%, 55%)' }}>
                                    <Check size={15} /> Current Plan
                                </div>
                                {eliteMetaSelectionChanged && (
                                    <motion.button
                                        whileHover={{ scale: 1.02 }}
                                        whileTap={{ scale: 0.98 }}
                                        onClick={handleUpgrade}
                                        disabled={upgradeLoading}
                                        className="w-full py-2.5 rounded-xl font-bold text-xs text-white flex items-center justify-center gap-2 transition-all disabled:opacity-60"
                                        style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(250, 60%, 55%))' }}
                                    >
                                        {upgradeLoading ? (
                                            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                        ) : (
                                            <><Megaphone size={14} /> Apply Meta Ads Change</>
                                        )}
                                    </motion.button>
                                )}
                                {!subscription?.cancelledAt && (
                                    <motion.button
                                        whileHover={{ scale: 1.02 }}
                                        whileTap={{ scale: 0.98 }}
                                        onClick={() => setShowCancelConfirm(true)}
                                        className="w-full py-2.5 rounded-xl font-bold text-xs flex items-center justify-center gap-2"
                                        style={{ background: 'rgba(239, 68, 68, 0.08)', color: 'hsl(0, 72%, 55%)' }}
                                    >
                                        <X size={14} /> Cancel Subscription
                                    </motion.button>
                                )}
                            </div>
                        ) : (
                        <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={() => isStarterSubscribed ? setShowUpgradeConfirm(true) : handleSubscribe('elite')}
                            disabled={checkoutLoading === 'elite'}
                            className="w-full py-3 rounded-xl font-bold text-sm text-white flex items-center justify-center gap-2 transition-all disabled:opacity-60"
                            style={{ background: 'linear-gradient(135deg, hsl(270, 60%, 55%), hsl(290, 50%, 50%))' }}
                        >
                            {checkoutLoading === 'elite' ? (
                                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            ) : isStarterSubscribed ? (
                                <><Gem size={15} /> Upgrade to Elite <ArrowRight size={15} /></>
                            ) : (
                                <>
                                    <Gem size={15} />
                                    {getsIntroductoryFreePeriod
                                        ? `Subscribe Elite - ${pricing.elite.freePeriodDays} Days Free`
                                        : `Subscribe Elite - ${eliteMonthlyPriceLabel}/month`}
                                    <ArrowRight size={15} />
                                </>
                            )}
                        </motion.button>
                        )}
                    </motion.div>
            </div>

            {/* Timeline */}
            <div className="glass-panel-strong p-6">
                <h3 className="text-sm font-bold mb-4" style={{ color: 'hsl(var(--foreground))' }}>How it works</h3>
                <div className="space-y-4">
                    {[
                        { step: '1', title: 'Free Trial', desc: '15 days to set up your store, add products, and start selling', active: isTrial, done: !isTrial && (isSubscribed || isBlocked || isPastDue) },
                        { step: '2', title: 'Subscribe', desc: `Choose Rozare Starter (${starterMonthlyPriceLabel}/mo) or Rozare Elite (${eliteMonthlyPriceLabel}/mo with your current options)`, active: false, done: isSubscribed || isPastDue },
                        { step: '3', title: 'Free Period', desc: `${pricing[isElite ? 'elite' : 'starter'].freePeriodDays} days of full access at no cost${isElite ? '' : ' to grow your business'}`, active: subscription?.status === 'free_period', done: subscription?.status === 'active' || (isSubscribed && subscription?.hasUsedFreePeriod && subscription?.status !== 'free_period') },
                        { step: '4', title: 'Monthly Billing', desc: isElite ? `${activeEliteMonthlyPriceLabel}/month. Cancel anytime.` : `${starterMonthlyPriceLabel}/month after the free period. Cancel anytime.`, active: subscription?.status === 'active', done: false },
                        { step: '5', title: 'Bonus Features', desc: isElite ? 'Permanently included with your Elite plan.' : 'After 6 months, bonus features expire. Upgrade to Elite to keep them.', active: false, done: isElite && isSubscribed },
                    ].map((s, i) => {
                        const isDone = s.done;
                        return (
                        <div key={i} className="flex items-start gap-3">
                            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${s.active || isDone ? 'text-white' : ''}`}
                                style={{
                                    background: isDone
                                        ? 'linear-gradient(135deg, hsl(150, 60%, 45%), hsl(170, 50%, 40%))'
                                        : s.active
                                            ? 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(250, 60%, 55%))'
                                            : 'rgba(0,0,0,0.06)',
                                    color: s.active || isDone ? 'white' : 'hsl(var(--muted-foreground))',
                                }}>
                                {isDone ? <Check size={14} /> : s.step}
                            </div>
                            <div>
                                <p className="text-xs font-bold" style={{ color: s.active || isDone ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))' }}>{s.title}</p>
                                <p className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>{s.desc}</p>
                            </div>
                        </div>
                        );
                    })}
                </div>
            </div>

            {/* Subscription comparison note */}
            <p className="text-center text-[10px] mt-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                Secure checkout powered by Stripe. Cancel anytime with one click.
            </p>

            {/* Cancel Confirm Modal */}
            <AnimatePresence>
                {showCancelConfirm && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
                        onClick={() => setShowCancelConfirm(false)}
                    >
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.95, opacity: 0 }}
                            onClick={e => e.stopPropagation()}
                            className="glass-panel-strong p-6 max-w-md w-full"
                        >
                            <div className="text-center mb-4">
                                <div className="w-12 h-12 rounded-2xl mx-auto flex items-center justify-center mb-3" style={{ background: 'rgba(239, 68, 68, 0.12)' }}>
                                    <AlertTriangle size={22} style={{ color: 'hsl(0, 72%, 55%)' }} />
                                </div>
                                <h3 className="text-base font-bold" style={{ color: 'hsl(var(--foreground))' }}>Cancel Subscription?</h3>
                                <p className="text-xs mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    Your store and products will be hidden from customers after the current period ends. You can re-subscribe anytime.
                                </p>
                            </div>

                            {founderRateActive && (
                                <div className="mb-4 p-3.5 rounded-xl" style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
                                    <div className="flex items-start gap-2">
                                        <Tag size={14} className="shrink-0 mt-0.5" style={{ color: 'hsl(0, 72%, 55%)' }} />
                                        <div>
                                            <p className="text-xs font-bold" style={{ color: 'hsl(0, 72%, 55%)' }}>Founder Price Will Be Lost</p>
                                            <p className="text-[11px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                When this subscription ends, your FIRST100 rate is permanently forfeited and cannot be applied again. Switching between Starter and Elite without ending the subscription keeps it.
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Bonus features grace period warning */}
                            {subscription?.plan === 'starter' && subscription?.bonusFeaturesActive && !subscription?.bonusFeaturesExpiredPermanently && subscription?.bonusExpiryDate && new Date(subscription.bonusExpiryDate) > new Date() && (
                                <div className="mb-4 p-3.5 rounded-xl" style={{ background: 'rgba(249, 115, 22, 0.08)', border: '1px solid rgba(249, 115, 22, 0.2)' }}>
                                    <div className="flex items-start gap-2">
                                        <Clock size={14} className="shrink-0 mt-0.5" style={{ color: 'hsl(30, 90%, 50%)' }} />
                                        <div>
                                            <p className="text-xs font-bold" style={{ color: 'hsl(30, 85%, 45%)' }}>Bonus Features Warning</p>
                                            <p className="text-[11px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                Once your subscription period ends, you will have <strong>3 days</strong> to re-subscribe and keep your bonus features for the remaining {bonusDaysUntilExpiry} days. After 3 days, bonus features will be <strong>permanently removed</strong> from the Starter plan and you would need to upgrade to Elite to get them back.
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            )}

                            <div className="flex gap-3">
                                <button onClick={() => setShowCancelConfirm(false)}
                                    className="flex-1 py-2.5 rounded-xl text-xs font-semibold glass-inner"
                                    style={{ color: 'hsl(var(--foreground))' }}>
                                    Keep Plan
                                </button>
                                <button onClick={handleCancel} disabled={cancelLoading}
                                    className="flex-1 py-2.5 rounded-xl text-xs font-bold text-white disabled:opacity-60"
                                    style={{ background: 'hsl(0, 72%, 55%)' }}>
                                    {cancelLoading ? 'Cancelling...' : 'Cancel Plan'}
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Upgrade Confirm Modal */}
            <AnimatePresence>
                {showUpgradeConfirm && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
                        onClick={() => setShowUpgradeConfirm(false)}
                    >
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.95, opacity: 0 }}
                            onClick={e => e.stopPropagation()}
                            className="glass-panel-strong p-6 max-w-md w-full"
                        >
                            <div className="text-center mb-4">
                                <div className="w-12 h-12 rounded-2xl mx-auto flex items-center justify-center mb-3" style={{ background: 'rgba(139, 92, 246, 0.12)' }}>
                                    <Gem size={22} style={{ color: 'hsl(270, 60%, 55%)' }} />
                                </div>
                                <h3 className="text-base font-bold" style={{ color: 'hsl(var(--foreground))' }}>Upgrade to Rozare Elite?</h3>
                                <p className="text-xs mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    Your billing will change from {starterMonthlyPriceLabel}/month to {eliteMonthlyPriceLabel}/month. The price difference will be prorated for the current period.
                                </p>
                            </div>

                            <div className="mb-4 p-3.5 rounded-xl" style={{ background: 'rgba(139, 92, 246, 0.06)', border: '1px solid rgba(139, 92, 246, 0.15)' }}>
                                <p className="text-xs font-bold mb-2" style={{ color: 'hsl(270, 60%, 55%)' }}>What you get with Elite:</p>
                                <div className="space-y-1.5">
                                    {[
                                        'All Starter features included',
                                        'Bonus features permanently (no more 6-month timer)',
                                        'Advanced analytics & growth insights',
                                        'Smart tag AI generator for products',
                                        'Featured product highlighting',
                                        'Customizable store themes',
                                        'Coupon & discount management',
                                        'Rozare-run TikTok ads for featured products',
                                        eliteMetaAds ? 'Meta ads add-on selected' : `Optional Meta ads add-on (+${metaAdsAddonPrice}/month)`,
                                    ].map((f, i) => (
                                        <div key={i} className="flex items-center gap-2">
                                            <Check size={11} style={{ color: 'hsl(270, 60%, 55%)' }} />
                                            <span className="text-[11px]" style={{ color: 'hsl(var(--foreground))' }}>{f}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="flex gap-3">
                                <button onClick={() => setShowUpgradeConfirm(false)}
                                    className="flex-1 py-2.5 rounded-xl text-xs font-semibold glass-inner"
                                    style={{ color: 'hsl(var(--foreground))' }}>
                                    Keep Starter
                                </button>
                                <button onClick={handleUpgrade} disabled={upgradeLoading}
                                    className="flex-1 py-2.5 rounded-xl text-xs font-bold text-white disabled:opacity-60"
                                    style={{ background: 'linear-gradient(135deg, hsl(270, 60%, 55%), hsl(290, 50%, 50%))' }}>
                                    {upgradeLoading ? 'Upgrading...' : 'Upgrade to Elite'}
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Downgrade Confirm Modal */}
            <AnimatePresence>
                {showDowngradeConfirm && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
                        onClick={() => setShowDowngradeConfirm(false)}
                    >
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.95, opacity: 0 }}
                            onClick={e => e.stopPropagation()}
                            className="glass-panel-strong p-6 max-w-md w-full"
                        >
                            <div className="text-center mb-4">
                                <div className="w-12 h-12 rounded-2xl mx-auto flex items-center justify-center mb-3" style={{ background: 'rgba(249, 115, 22, 0.12)' }}>
                                    <AlertTriangle size={22} style={{ color: 'hsl(30, 90%, 50%)' }} />
                                </div>
                                <h3 className="text-base font-bold" style={{ color: 'hsl(var(--foreground))' }}>Downgrade to Starter?</h3>
                                <p className="text-xs mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    Your Elite plan will remain active until the current period ends. After that, you'll be switched to Starter ({starterMonthlyPriceLabel}/month).
                                </p>
                            </div>

                            <div className="mb-4 p-3.5 rounded-xl" style={{ background: 'rgba(249, 115, 22, 0.06)', border: '1px solid rgba(249, 115, 22, 0.15)' }}>
                                <p className="text-xs font-bold mb-2" style={{ color: 'hsl(30, 85%, 45%)' }}>What changes with Starter:</p>
                                <div className="space-y-1.5">
                                    {[
                                        { text: `Billing changes to ${starterMonthlyPriceLabel}/month`, good: true },
                                        { text: 'No free period (already used)', good: false },
                                        { text: 'Bonus features available for 6 months only (then expire)', good: false },
                                        { text: 'All core features remain (store, products, payments, AI)', good: true },
                                    ].map((f, i) => (
                                        <div key={i} className="flex items-center gap-2">
                                            {f.good ? <Check size={11} style={{ color: 'hsl(150, 60%, 45%)' }} /> : <AlertTriangle size={11} style={{ color: 'hsl(30, 90%, 50%)' }} />}
                                            <span className="text-[11px]" style={{ color: 'hsl(var(--foreground))' }}>{f.text}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <p className="text-[10px] mb-4 text-center" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                You can cancel this downgrade anytime before the period ends.
                            </p>

                            <div className="flex gap-3">
                                <button onClick={() => setShowDowngradeConfirm(false)}
                                    className="flex-1 py-2.5 rounded-xl text-xs font-semibold glass-inner"
                                    style={{ color: 'hsl(var(--foreground))' }}>
                                    Keep Elite
                                </button>
                                <button onClick={handleDowngrade} disabled={downgradeLoading}
                                    className="flex-1 py-2.5 rounded-xl text-xs font-bold text-white disabled:opacity-60"
                                    style={{ background: 'hsl(30, 80%, 50%)' }}>
                                    {downgradeLoading ? 'Processing...' : 'Downgrade'}
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
};

export default SellerSubscription;
