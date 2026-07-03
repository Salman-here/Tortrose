import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Crown, Check, Zap, Shield, Bot, Clock, AlertTriangle,
    CreditCard, ArrowRight, Sparkles, X, Lock, Store, Package,
    Users, Award, Star, MessageCircle, Gem, Bell, Palette, Megaphone
} from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';
import { useSearchParams } from 'react-router-dom';
import { getAuthToken } from "../../utils/cookieHelper";

const SellerSubscription = () => {
    const [subscription, setSubscription] = useState(null);
    const [loading, setLoading] = useState(true);
    const [checkoutLoading, setCheckoutLoading] = useState(null); // 'starter' | 'elite' | null
    const [cancelLoading, setCancelLoading] = useState(false);
    const [upgradeLoading, setUpgradeLoading] = useState(false);
    const [downgradeLoading, setDowngradeLoading] = useState(false);
    const [cancelDowngradeLoading, setCancelDowngradeLoading] = useState(false);
    const [showCancelConfirm, setShowCancelConfirm] = useState(false);
    const [showUpgradeConfirm, setShowUpgradeConfirm] = useState(false);
    const [showDowngradeConfirm, setShowDowngradeConfirm] = useState(false);
    const [eliteMetaAds, setEliteMetaAds] = useState(false);
    const [searchParams] = useSearchParams();

    useEffect(() => {
        fetchSubscription();
        if (searchParams.get('success') === 'true') {
            toast.success('Subscription activated! Your store is now live.');
        }
        if (searchParams.get('cancelled') === 'true') {
            toast.info('Checkout was cancelled. You can subscribe anytime.');
        }
    }, []);

    const fetchSubscription = async () => {
        try {
            const token = getAuthToken();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/subscription/status`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            setSubscription(res.data.subscription);
            setEliteMetaAds(Boolean(res.data.subscription?.metaAdsIncluded));
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    const handleSubscribe = async (plan = 'starter') => {
        setCheckoutLoading(plan);
        try {
            const token = getAuthToken();
            const payload = { plan };
            if (plan === 'elite') payload.includeMetaAds = eliteMetaAds;
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
        try {
            const token = getAuthToken();
            const res = await axios.post(`${import.meta.env.VITE_API_URL}api/subscription/upgrade-to-elite`, { includeMetaAds: eliteMetaAds }, {
                headers: { Authorization: `Bearer ${token}` }
            });
            toast.success(res.data.msg || 'Upgraded to Rozare Elite!');
            setShowUpgradeConfirm(false);
            fetchSubscription();
        } catch (err) {
            toast.error(err.response?.data?.msg || 'Failed to upgrade');
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

    const getStatusBadge = () => {
        if (!subscription) return null;
        // Stripe "cancel at period end" — status is still active but cancelledAt is set.
        // Surface that explicitly so the seller knows the plan is winding down.
        if (subscription.cancelledAt && ['active', 'free_period'].includes(subscription.status)) {
            const endDate = subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
            const daysLeft = endDate ? Math.max(0, Math.ceil((endDate - new Date()) / 86400000)) : null;
            return (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold"
                    style={{ background: 'rgba(239,68,68,0.12)', color: 'hsl(0, 72%, 55%)' }}>
                    <X size={12} /> Cancelled
                    {daysLeft !== null && <span className="opacity-80">· {daysLeft} day{daysLeft !== 1 ? 's' : ''} remaining</span>}
                </span>
            );
        }
        const map = {
            trial: { label: 'Free Trial', color: 'hsl(220, 70%, 55%)', bg: 'rgba(99,102,241,0.12)', icon: <Clock size={12} /> },
            free_period: { label: subscription?.plan === 'elite' ? '45-Day Free' : '30-Day Free', color: 'hsl(150, 60%, 45%)', bg: 'rgba(16,185,129,0.12)', icon: <Sparkles size={12} /> },
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

    const isBlocked = subscription?.status === 'blocked';
    const isTrial = subscription?.status === 'trial';
    const isPastDue = subscription?.status === 'past_due';
    const isSubscribed = ['active', 'free_period'].includes(subscription?.status);
    const isElite = subscription?.plan === 'elite';
    const showSubscribeButton = !isSubscribed && !isPastDue;
    const bonusExpiredPermanently = subscription?.bonusFeaturesExpiredPermanently && !isElite;
    const hasGracePeriod = isBlocked && subscription?.bonusGraceDeadline && subscription?.bonusGraceDaysRemaining > 0 && !bonusExpiredPermanently;
    const bonusAboutToExpire = isSubscribed && subscription?.plan === 'starter' && subscription?.bonusFeaturesActive && subscription?.bonusExpiryDate && (() => {
        const daysLeft = Math.ceil((new Date(subscription.bonusExpiryDate) - new Date()) / (1000 * 60 * 60 * 24));
        return daysLeft <= 7 && daysLeft > 0;
    })();
    const bonusDaysUntilExpiry = subscription?.bonusExpiryDate ? Math.max(0, Math.ceil((new Date(subscription.bonusExpiryDate) - new Date()) / (1000 * 60 * 60 * 24))) : 0;
    const bonusMonthsRemaining = subscription?.bonusExpiryDate ? Math.max(0, Math.ceil(bonusDaysUntilExpiry / 30)) : 6;
    const isStarterSubscribed = isSubscribed && !isElite;
    const metaAdsAddonCents = Number(subscription?.metaAdsAddonCents || 0);
    const metaAdsAddonPrice = `$${(metaAdsAddonCents / 100).toFixed(2)}`;
    const eliteMonthlyPrice = 1299 + (eliteMetaAds && metaAdsAddonCents > 0 ? metaAdsAddonCents : 0);
    const eliteMonthlyPriceLabel = `$${(eliteMonthlyPrice / 100).toFixed(2)}`;
    const canChooseMetaAds = metaAdsAddonCents > 0;
    const toggleMetaAds = () => {
        if (!canChooseMetaAds) {
            toast.info('Meta ads add-on price is not configured yet.');
            return;
        }
        setEliteMetaAds((value) => !value);
    };

    const starterFeatures = [
        'Store & products visible to all customers',
        'Unlimited product listings',
        'Secure payment processing',
        'Custom subdomain for your store',
        '100 AI messages/day',
        'Order management & customer insights',
        'Manage your store, orders & products from WhatsApp by chatting with AI',
        'Get WhatsApp notifications when you receive a new order',
        'Rozare WhatsApp order confirmation automation',
        '10 professional store themes',
        'Featured product highlighting (6 products)',
    ];

    const bonusFeatures = [
        'Smart description generator with AI',
        'Advanced analytics & growth insights',
        'Smart tag AI generator for products',
        'Priority support & early access to new features',
        'Coupon & discount management system',
        'Bulk discount & promotional tools',
    ];

    const eliteOnlyFeatures = [
        'Rozare will run TikTok ads for your store and featured products',
        'Customizable store themes with your own colors and layouts',
    ];

    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 sm:p-6 max-w-4xl mx-auto">

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
            {subscription?.cancelledAt && ['active', 'free_period'].includes(subscription?.status) && (() => {
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
                                <h3 className="text-sm font-bold" style={{ color: 'hsl(0, 72%, 55%)' }}>Subscription Cancelled</h3>
                                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    Your plan will remain active for{' '}
                                    <strong style={{ color: 'hsl(var(--foreground))' }}>
                                        {daysLeft !== null ? `${daysLeft} more day${daysLeft !== 1 ? 's' : ''}` : 'the remainder of this period'}
                                    </strong>
                                    {endDate && <> and end on <strong style={{ color: 'hsl(var(--foreground))' }}>{endDate.toLocaleDateString()}</strong></>}.
                                    After that your store will be blocked until you re-subscribe.
                                </p>
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
                                        ? `Free until ${new Date(subscription.freePeriodEndDate).toLocaleDateString()}, then ${isElite ? '$12.99' : '$5.99'}/mo`
                                        : `${isElite ? '$12.99' : '$5.99'}/month • Cancel anytime`
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

                {/* AI Limit Info */}
                <div className="flex items-center gap-3 p-3 rounded-xl" style={{ background: 'rgba(99,102,241,0.06)' }}>
                    <Bot size={16} style={{ color: 'hsl(220, 70%, 55%)' }} />
                    <div className="flex-1">
                        <p className="text-xs font-semibold" style={{ color: 'hsl(var(--foreground))' }}>AI Messages</p>
                        <p className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            {subscription?.aiMessageLimit || 25} messages/day
                            {isSubscribed && <span style={{ color: 'hsl(150, 60%, 45%)' }}> (4x boost!)</span>}
                        </p>
                    </div>
                </div>

                {/* Trial Feature List */}
                {isTrial && (
                    <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--glass-border)' }}>
                        <p className="text-xs font-semibold mb-3" style={{ color: 'hsl(var(--foreground))' }}>
                            Starter features and eligible Elite tools are available in your 15-day free trial
                        </p>

                        <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'hsl(150, 60%, 45%)' }}>Features from Starter</p>
                        <div className="space-y-1.5 mb-3">
                            {starterFeatures.map((f, i) => (
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
                            {starterFeatures.map((f, i) => (
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
                                '100 AI messages/day',
                                'Order management & customer insights',
                                'Manage your store, orders & products from WhatsApp by chatting with AI',
                                'Get WhatsApp notifications when you receive a new order',
                                'Rozare WhatsApp order confirmation automation',
                                '10 professional store themes',
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
                                '250 AI messages/day',
                                'Order management & customer insights',
                                'Manage your store, orders & products from WhatsApp by chatting with AI',
                                'Get WhatsApp notifications when you receive a new order',
                                'Rozare WhatsApp order confirmation automation',
                                '10 professional store themes',
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
                            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold mb-3"
                                style={{ background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 45%)' }}>
                                <Sparkles size={12} /> 30 DAYS FREE
                            </div>
                            <h3 className="text-xl font-bold" style={{ color: 'hsl(var(--foreground))' }}>
                                Rozare Starter
                            </h3>
                            <p className="text-lg font-bold mt-1" style={{ color: 'hsl(var(--foreground))' }}>
                                <span style={{ color: 'hsl(var(--muted-foreground))', textDecoration: 'line-through', fontSize: '0.9rem' }}>$5.99/mo</span>
                                {' '}$0<span className="text-sm font-normal" style={{ color: 'hsl(var(--muted-foreground))' }}>/first 30 days</span>
                            </p>
                            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Then $5.99/month • Cancel anytime
                            </p>
                        </div>

                        <div className="space-y-2 mb-5">
                            <p className="text-xs font-bold mb-2" style={{ color: 'hsl(var(--foreground))' }}>Core Features</p>
                            {[
                                { icon: <Store size={13} />, text: 'Store & products visible to all customers' },
                                { icon: <Package size={13} />, text: 'Unlimited product listings' },
                                { icon: <CreditCard size={13} />, text: 'Secure payment processing' },
                                { icon: <Shield size={13} />, text: 'Custom subdomain for your store' },
                                { icon: <Bot size={13} />, text: '100 AI messages/day' },
                                { icon: <Users size={13} />, text: 'Order management & insights' },
                                { icon: <MessageCircle size={13} />, text: 'Manage store, orders & products from WhatsApp via AI' },
                                { icon: <Bell size={13} />, text: 'WhatsApp notifications for new orders' },
                                { icon: <MessageCircle size={13} />, text: 'WhatsApp order confirmation' },
                                { icon: <Palette size={13} />, text: '10 professional store themes' },
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
                                    Subscribe — 30 Days Free
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
                            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold mb-3"
                                style={{ background: 'rgba(139, 92, 246, 0.12)', color: 'hsl(270, 60%, 55%)' }}>
                                <Gem size={12} /> 45 DAYS FREE
                            </div>
                            <h3 className="text-xl font-bold" style={{ color: 'hsl(var(--foreground))' }}>
                                Rozare Elite
                            </h3>
                            <p className="text-lg font-bold mt-1" style={{ color: 'hsl(var(--foreground))' }}>
                                <span style={{ color: 'hsl(var(--muted-foreground))', textDecoration: 'line-through', fontSize: '0.9rem' }}>$12.99/mo</span>
                                {' '}$0<span className="text-sm font-normal" style={{ color: 'hsl(var(--muted-foreground))' }}>/first 45 days</span>
                            </p>
                            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Then $12.99/month • Cancel anytime
                            </p>
                        </div>

                        <div className="space-y-2 mb-5">
                            <p className="text-xs font-bold mb-2" style={{ color: 'hsl(var(--foreground))' }}>Core Features</p>
                            {[
                                { icon: <Store size={13} />, text: 'Store & products visible to all customers' },
                                { icon: <Package size={13} />, text: 'Unlimited product listings' },
                                { icon: <CreditCard size={13} />, text: 'Secure payment processing' },
                                { icon: <Shield size={13} />, text: 'Custom subdomain for your store' },
                                { icon: <Bot size={13} />, text: '250 AI messages/day' },
                                { icon: <Users size={13} />, text: 'Order management & insights' },
                                { icon: <MessageCircle size={13} />, text: 'Manage store, orders & products from WhatsApp via AI' },
                                { icon: <Bell size={13} />, text: 'WhatsApp notifications for new orders' },
                                { icon: <MessageCircle size={13} />, text: 'WhatsApp order confirmation' },
                                { icon: <Palette size={13} />, text: '10 professional store themes' },
                                { icon: <Sparkles size={13} />, text: 'Featured product highlighting (12 products)' },
                                { icon: <Megaphone size={13} />, text: 'Rozare runs TikTok ads for your store & featured products' },
                            ].map((f, i) => (
                                <div key={i} className="flex items-center gap-2.5">
                                    <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 45%)' }}>
                                        {f.icon}
                                    </div>
                                    <span className="text-[11px]" style={{ color: 'hsl(var(--foreground))' }}>{f.text}</span>
                                </div>
                            ))}

                            <div className="border-t my-2" style={{ borderColor: 'rgba(0,0,0,0.06)' }} />
                            {bonusFeatures.map((f, i) => (
                                <div key={`elite-bonus-${i}`} className="flex items-center gap-2.5">
                                    <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ background: 'rgba(139, 92, 246, 0.12)', color: 'hsl(270, 60%, 55%)' }}>
                                        <Check size={11} />
                                    </div>
                                    <span className="text-[11px]" style={{ color: 'hsl(var(--foreground))' }}>{f}</span>
                                </div>
                            ))}
                            {eliteOnlyFeatures.map((f, i) => (
                                <div key={`elite-only-card-${i}`} className="flex items-center gap-2.5">
                                    <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ background: 'rgba(139, 92, 246, 0.12)', color: 'hsl(270, 60%, 55%)' }}>
                                        {f.toLowerCase().includes('tiktok') ? <Megaphone size={11} /> : <Palette size={11} />}
                                    </div>
                                    <span className="text-[11px]" style={{ color: 'hsl(var(--foreground))' }}>{f}</span>
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
                                        {canChooseMetaAds
                                            ? `Adds ${metaAdsAddonPrice}/month to the Elite plan.`
                                            : 'Meta add-on price is pending in server config.'}
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
                                    Subscribe Elite — 45 Days Free
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
                        { step: '2', title: 'Subscribe', desc: 'Choose Rozare Starter ($5.99/mo) or Rozare Elite ($12.99/mo)', active: false, done: isSubscribed || isPastDue },
                        { step: '3', title: 'Free Period', desc: isElite ? '45 days of full access at no cost' : '30 days of full access at no cost to grow your business', active: subscription?.status === 'free_period', done: subscription?.status === 'active' || (isSubscribed && subscription?.hasUsedFreePeriod && subscription?.status !== 'free_period') },
                        { step: '4', title: 'Monthly Billing', desc: isElite ? '$12.99/month. Cancel anytime.' : '$5.99/month after free period. Cancel anytime.', active: subscription?.status === 'active', done: false },
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
                                    Your billing will change from $5.99/month to $12.99/month. The price difference will be prorated for the current period.
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
                                    Your Elite plan will remain active until the current period ends. After that, you'll be switched to Starter ($5.99/month).
                                </p>
                            </div>

                            <div className="mb-4 p-3.5 rounded-xl" style={{ background: 'rgba(249, 115, 22, 0.06)', border: '1px solid rgba(249, 115, 22, 0.15)' }}>
                                <p className="text-xs font-bold mb-2" style={{ color: 'hsl(30, 85%, 45%)' }}>What changes with Starter:</p>
                                <div className="space-y-1.5">
                                    {[
                                        { text: 'Billing drops to $5.99/month', good: true },
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
