import { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { Globe, ExternalLink, Eye, ShoppingBag, DollarSign, TrendingUp, Users, CheckCircle, Lock, AlertTriangle, Loader2, Copy, BarChart3, ArrowUpRight, Info, Edit3, Save, X, Shield, CreditCard, Clock } from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify';
import { Link, useSearchParams } from 'react-router-dom';
import { useCurrency } from '../../contexts/CurrencyContext';
import Loader from '../common/Loader';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { getAuthToken } from "../../utils/cookieHelper";
import {
    resolveSubdomainOwnershipTerms,
    subdomainOwnershipResponseIsValid,
} from '../../utils/subdomainOwnership';
import { subdomainAnalyticsResponseIsValid } from '../../utils/subdomainAnalyticsSafety';

const SellerSubdomainManagement = () => {
    const { formatPrice, currency } = useCurrency();
    const [loading, setLoading] = useState(true);
    const [data, setData] = useState(null);
    const [editing, setEditing] = useState(false);
    const [newSlug, setNewSlug] = useState('');
    const [slugChecking, setSlugChecking] = useState(false);
    const [slugAvailable, setSlugAvailable] = useState(null);
    const [slugMessage, setSlugMessage] = useState('');
    const [saving, setSaving] = useState(false);
    const [ownership, setOwnership] = useState(null);
    const [purchaseLoading, setPurchaseLoading] = useState(false);
    const [loadError, setLoadError] = useState('');
    const dataRequestRef = useRef({ id: 0, controller: null });
    const availabilityRequestRef = useRef(0);
    const [searchParams] = useSearchParams();
    const ownershipTerms = resolveSubdomainOwnershipTerms(ownership);
    const ownershipPrice = ownershipTerms;
    const ownershipYears = ownershipTerms?.years || null;

    const fetchData = useCallback(async () => {
        dataRequestRef.current.controller?.abort();
        const controller = new AbortController();
        const requestId = dataRequestRef.current.id + 1;
        dataRequestRef.current = { id: requestId, controller };
        try {
            setLoading(true);
            setData(null);
            setOwnership(null);
            setLoadError('');
            const token = getAuthToken();
            const [analyticsRes, ownershipRes] = await Promise.all([
                axios.get(`${import.meta.env.VITE_API_URL}api/subdomain/analytics/seller?currency=${encodeURIComponent(currency)}`, {
                    headers: { Authorization: `Bearer ${token}` },
                    signal: controller.signal,
                }),
                axios.get(`${import.meta.env.VITE_API_URL}api/subscription/subdomain/ownership`, {
                    headers: { Authorization: `Bearer ${token}` },
                    signal: controller.signal,
                }),
            ]);
            if (dataRequestRef.current.id !== requestId) return;
            if (!subdomainAnalyticsResponseIsValid(analyticsRes.data, currency)) {
                throw new Error('Subdomain analytics returned invalid or inconsistent money data.');
            }
            if (!subdomainOwnershipResponseIsValid(ownershipRes.data)) {
                throw new Error('Subdomain ownership details returned an invalid or inconsistent state.');
            }
            setData(analyticsRes.data);
            setNewSlug(analyticsRes.data.subdomain?.slug || '');
            setOwnership(ownershipRes.data);
        } catch (error) {
            if (controller.signal.aborted || error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError') return;
            if (dataRequestRef.current.id !== requestId) return;
            setData(null);
            setOwnership(null);
            setLoadError(error.response?.data?.msg || error.message || 'Failed to load subdomain data.');
        } finally {
            if (dataRequestRef.current.id === requestId) setLoading(false);
        }
    }, [currency]);

    useEffect(() => {
        fetchData();
        if (searchParams.get('purchase') === 'success') {
            toast.success('Subdomain purchased successfully! Your subdomain is now protected.');
        }
        if (searchParams.get('purchase') === 'cancelled') {
            toast.info('Subdomain purchase was cancelled.');
        }
        return () => dataRequestRef.current.controller?.abort();
    }, [fetchData, searchParams]);

    const sanitize = (val) => val.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');

    const checkAvailability = useCallback(async (slug, requestId) => {
        if (!slug || slug.length < 3) { setSlugAvailable(null); setSlugMessage(''); return; }
        try {
            setSlugChecking(true);
            const token = getAuthToken();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/check-subdomain/${encodeURIComponent(slug)}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (availabilityRequestRef.current !== requestId) return;
            if (typeof res.data?.available !== 'boolean') throw new Error('Availability response is invalid.');
            setSlugAvailable(res.data.available);
            setSlugMessage(typeof res.data?.msg === 'string' ? res.data.msg : (res.data.available ? 'Available' : 'Unavailable'));
        } catch {
            if (availabilityRequestRef.current !== requestId) return;
            setSlugAvailable(null);
            setSlugMessage('Could not check availability');
        } finally {
            if (availabilityRequestRef.current === requestId) setSlugChecking(false);
        }
    }, []);

    useEffect(() => {
        const requestId = availabilityRequestRef.current + 1;
        availabilityRequestRef.current = requestId;
        if (!editing || !newSlug || newSlug === data?.subdomain?.slug) {
            setSlugChecking(false);
            return undefined;
        }
        const timer = setTimeout(() => checkAvailability(newSlug, requestId), 500);
        return () => clearTimeout(timer);
    }, [newSlug, editing, data?.subdomain?.slug, checkAvailability]);

    const handleSaveSlug = async () => {
        if (!newSlug || newSlug.length < 3) { toast.error('Subdomain must be at least 3 characters'); return; }
        if (subdomain?.blocked) {
            toast.error('Your store is blocked. Reactivate your subscription before changing your subdomain.');
            return;
        }
        const confirmed = window.confirm(`Heads up: once you change your subdomain, you won't be able to change it again for 30 days. Continue?`);
        if (!confirmed) return;
        try {
            setSaving(true);
            const token = getAuthToken();
            await axios.put(`${import.meta.env.VITE_API_URL}api/stores/update`, { storeSlug: newSlug, confirmSubdomainChange: true }, {
                headers: { Authorization: `Bearer ${token}` }
            });
            toast.success('Subdomain updated!');
            setEditing(false);
            fetchData();
        } catch (error) {
            const cd = error.response?.data?.cooldown;
            if (error.response?.status === 423 && cd) {
                toast.error(`You can change your ${cd.label} again in ${cd.daysRemaining} day(s).`);
            } else {
                toast.error(error.response?.data?.msg || 'Failed to update subdomain');
            }
        } finally { setSaving(false); }
    };

    const handlePurchaseSubdomain = async () => {
        if (!ownershipPrice || !ownershipYears) {
            toast.error('The authoritative ownership price is unavailable. Refresh before opening Checkout.');
            return;
        }
        setPurchaseLoading(true);
        try {
            const token = getAuthToken();
            const res = await axios.post(`${import.meta.env.VITE_API_URL}api/subscription/subdomain/purchase`, {}, {
                headers: { Authorization: `Bearer ${token}` }
            });
            window.location.href = res.data.url;
        } catch (err) {
            toast.error(err.response?.data?.msg || 'Failed to create purchase checkout');
            setPurchaseLoading(false);
        }
    };

    const copyToClipboard = (text) => {
        navigator.clipboard.writeText(text);
        toast.success('Copied to clipboard!');
    };

    if (loading) return <div className="flex justify-center items-center h-64"><Loader /></div>;
    if (!data || !ownership) return (
        <div className="p-6 text-center glass-panel" style={{ color: 'hsl(var(--muted-foreground))' }}>
            <AlertTriangle size={28} className="mx-auto mb-3" style={{ color: 'hsl(0, 72%, 55%)' }} />
            <p>{loadError || 'No subdomain data is available. Create a store first.'}</p>
            <button type="button" onClick={fetchData} className="mt-4 px-4 py-2 rounded-xl glass-button text-sm font-semibold">Retry</button>
        </div>
    );

    const { subdomain, analytics } = data;
    const isActive = subdomain.isActive;
    const blocked = subdomain.blocked;
    const daysUntilRemoval = subdomain.daysUntilRemoval;
    const isOwned = ownership?.ownership?.isOwned;
    const isPurchased = ownership?.ownership?.isPurchased || subdomain.isPurchased;

    const stats = [
        { label: 'Total Views', value: analytics.totalViews, icon: <Eye size={18} />, color: 'hsl(220, 70%, 55%)' },
        { label: 'Total Orders', value: analytics.totalOrders, icon: <ShoppingBag size={18} />, color: 'hsl(150, 60%, 45%)' },
        { label: 'Recognized Revenue', value: formatPrice(analytics.totalRevenue, { sourceCurrency: analytics.currency }), icon: <DollarSign size={18} />, color: 'hsl(200, 80%, 50%)' },
        { label: 'Conversion', value: `${analytics.conversionRate}%`, icon: <TrendingUp size={18} />, color: 'hsl(280, 60%, 55%)' },
    ];

    return (
        <div className="p-4 md:p-6 max-w-5xl mx-auto">
            {/* Header */}
            <div className="mb-6">
                <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                    <Globe size={28} />
                    Subdomain Management
                </h1>
                <p className="text-sm mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    Manage your custom subdomain, monitor traffic and performance
                </p>
            </div>

            {/* Status Card */}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass-panel p-6 mb-6">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                        {subdomain.logo ? (
                            <img src={subdomain.logo} alt="" className="w-14 h-14 rounded-2xl object-cover" style={{ border: '2px solid var(--glass-border-strong)' }} />
                        ) : (
                            <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }}>
                                <Globe size={24} />
                            </div>
                        )}
                        <div>
                            <h2 className="text-lg font-bold" style={{ color: 'hsl(var(--foreground))' }}>{subdomain.storeName}</h2>
                            <div className="flex items-center gap-2 mt-1">
                                <span className="text-sm font-mono" style={{ color: 'hsl(var(--primary))' }}>{subdomain.url}</span>
                                <button onClick={() => copyToClipboard(`https://${subdomain.url}`)} className="p-1 rounded-lg hover:bg-white/10 transition-all">
                                    <Copy size={14} style={{ color: 'hsl(var(--muted-foreground))' }} />
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        {blocked ? (
                            <span className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold" style={{ background: 'rgba(239,68,68,0.12)', color: 'hsl(0, 72%, 50%)', border: '1px solid rgba(239,68,68,0.3)' }}>
                                <Lock size={16} /> Blocked{daysUntilRemoval !== null && daysUntilRemoval !== undefined ? ` — releases in ${daysUntilRemoval}d` : ''}
                            </span>
                        ) : isActive ? (
                            <span className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold" style={{ background: 'rgba(34,197,94,0.12)', color: 'hsl(150, 60%, 40%)', border: '1px solid rgba(34,197,94,0.25)' }}>
                                <CheckCircle size={16} /> Active & Live
                            </span>
                        ) : (
                            <span className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold" style={{ background: 'rgba(234,179,8,0.12)', color: 'hsl(45, 80%, 40%)', border: '1px solid rgba(234,179,8,0.25)' }}>
                                <Lock size={16} /> Inactive
                            </span>
                        )}
                        {isActive && !blocked && (
                            <a href={`https://${subdomain.url}`} target="_blank" rel="noreferrer"
                                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all"
                                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))' }}>
                                Visit Store <ExternalLink size={14} />
                            </a>
                        )}
                    </div>
                </div>

                {blocked && (
                    <div className="mt-4 rounded-xl p-4" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)' }}>
                        <div className="flex items-start gap-3">
                            <AlertTriangle size={18} className="shrink-0 mt-0.5" style={{ color: 'hsl(0, 72%, 55%)' }} />
                            <div>
                                <p className="text-sm font-semibold" style={{ color: 'hsl(0, 72%, 50%)' }}>
                                    Your store is blocked — subscription inactive
                                </p>
                                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    {isPurchased
                                        ? 'Your subdomain is purchased and protected. Reactivate your subscription to make your store visible again.'
                                        : daysUntilRemoval !== null && daysUntilRemoval !== undefined
                                            ? <>Your subdomain <strong className="font-mono">{subdomain.url}</strong> will be released in <strong>{daysUntilRemoval} day(s)</strong> and may be claimed by another seller.</>
                                            : 'Reactivate your subscription to keep your subdomain.'}
                                </p>
                                <Link to="/seller-dashboard/subscription"
                                    className="inline-flex items-center gap-1.5 mt-3 px-4 py-2 rounded-lg text-xs font-semibold text-white"
                                    style={{ background: 'linear-gradient(135deg, hsl(0, 72%, 55%), hsl(15, 80%, 55%))' }}>
                                    Reactivate Subscription <ArrowUpRight size={12} />
                                </Link>
                            </div>
                        </div>
                    </div>
                )}

                {!isActive && !blocked && (
                    <div className="mt-4 rounded-xl p-4" style={{ background: 'rgba(234,179,8,0.07)', border: '1px solid rgba(234,179,8,0.2)' }}>
                        <div className="flex items-start gap-3">
                            <AlertTriangle size={18} className="shrink-0 mt-0.5" style={{ color: 'hsl(45, 80%, 45%)' }} />
                            <div>
                                <p className="text-sm font-semibold" style={{ color: 'hsl(45, 70%, 38%)' }}>
                                    Your subdomain is currently unavailable
                                </p>
                                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    Your store is not publicly available right now. Subdomains are live for active stores; verification only adds a verified badge and trust signal.
                                </p>
                                <Link to="/seller-dashboard/store-settings"
                                    className="inline-flex items-center gap-1.5 mt-3 px-4 py-2 rounded-lg text-xs font-semibold text-white"
                                    style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))' }}>
                                    Go to Store Settings <ArrowUpRight size={12} />
                                </Link>
                            </div>
                        </div>
                    </div>
                )}
            </motion.div>

            {/* Subdomain Ownership / Purchase Card */}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.03 }} className="glass-panel p-6 mb-6">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-bold flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                        <Shield size={18} /> Subdomain Ownership
                    </h3>
                    {isOwned && (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold"
                            style={{ background: 'rgba(34, 197, 94, 0.12)', color: 'hsl(150, 60%, 40%)', border: '1px solid rgba(34, 197, 94, 0.2)' }}>
                            <Shield size={13} /> Owned
                        </span>
                    )}
                </div>

                {isOwned ? (
                    <div className="space-y-3">
                        <div className="glass-inner rounded-xl p-4">
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
                                        {subdomain.url}
                                    </p>
                                    <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        Purchased on {new Date(ownership.ownership.purchasedAt).toLocaleDateString()}
                                    </p>
                                </div>
                                <div className="text-right">
                                    <p className="text-xs font-semibold" style={{ color: 'hsl(150, 60%, 45%)' }}>
                                        {ownership.ownership.daysRemaining} days remaining
                                    </p>
                                    <p className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        Expires {new Date(ownership.ownership.expiresAt).toLocaleDateString()}
                                    </p>
                                </div>
                            </div>
                        </div>
                        <div className="flex items-start gap-2 p-3 rounded-xl" style={{ background: 'rgba(34, 197, 94, 0.06)' }}>
                            <CheckCircle size={14} className="shrink-0 mt-0.5" style={{ color: 'hsl(150, 60%, 45%)' }} />
                            <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Your subdomain is protected. Even if your account is blocked, no one else can claim this subdomain for the duration of your ownership.
                            </p>
                        </div>
                        {ownership.ownership.daysRemaining < 90 && (
                            <motion.button
                                whileHover={{ scale: 1.02 }}
                                whileTap={{ scale: 0.98 }}
                                onClick={handlePurchaseSubdomain}
                                disabled={purchaseLoading || !ownershipPrice || !ownershipYears}
                                className="w-full py-3 rounded-xl font-bold text-sm text-white flex items-center justify-center gap-2 disabled:opacity-60"
                                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))' }}
                            >
                                {purchaseLoading ? (
                                    <Loader2 size={16} className="animate-spin" />
                                ) : (
                                    <><CreditCard size={15} /> Renew Ownership — {ownershipPrice?.priceLabel || 'Price unavailable'}</>
                                )}
                            </motion.button>
                        )}
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div className="glass-inner rounded-xl p-4">
                            <div className="flex items-start gap-3">
                                <div className="p-2 rounded-xl shrink-0" style={{ background: 'rgba(99, 102, 241, 0.12)' }}>
                                    <Globe size={18} style={{ color: 'hsl(220, 70%, 55%)' }} />
                                </div>
                                <div>
                                    <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
                                        Secure your subdomain for 3 years
                                    </p>
                                    <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        Purchase your subdomain <strong>{subdomain.url}</strong> for a one-time payment of <strong>{ownershipPrice?.priceLabel || 'a price shown after refresh'}</strong>.
                                        Your subdomain will be protected for {ownershipYears || 'the stated number of'} years, even if your account is blocked.
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="space-y-2">
                            {[
                                { icon: <Shield size={13} />, text: 'Protected even if your account is blocked' },
                                { icon: <Clock size={13} />, text: ownershipYears ? `${ownershipYears}-year ownership — renewable after expiry` : 'Ownership duration unavailable — refresh required' },
                                { icon: <Globe size={13} />, text: 'No one else can claim your subdomain' },
                                { icon: <CreditCard size={13} />, text: ownershipPrice ? `One-time payment of ${ownershipPrice.priceLabel} (separate from subscription)` : 'Ownership price unavailable — refresh required' },
                            ].map((f, i) => (
                                <div key={i} className="flex items-center gap-2.5">
                                    <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ background: 'rgba(99, 102, 241, 0.12)', color: 'hsl(220, 70%, 55%)' }}>
                                        {f.icon}
                                    </div>
                                    <span className="text-xs" style={{ color: 'hsl(var(--foreground))' }}>{f.text}</span>
                                </div>
                            ))}
                        </div>

                        <div className="flex items-start gap-2 p-3 rounded-xl" style={{ background: 'rgba(234, 179, 8, 0.07)', border: '1px solid rgba(234, 179, 8, 0.15)' }}>
                            <AlertTriangle size={13} className="shrink-0 mt-0.5" style={{ color: 'hsl(45, 80%, 45%)' }} />
                            <p className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Without purchasing, if your account is blocked and remains blocked for 7 days, your subdomain will be released and anyone can claim it.
                            </p>
                        </div>

                        <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={handlePurchaseSubdomain}
                            disabled={purchaseLoading || !ownershipPrice || !ownershipYears}
                            className="w-full py-3.5 rounded-xl font-bold text-sm text-white flex items-center justify-center gap-2 disabled:opacity-60"
                            style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))' }}
                        >
                            {purchaseLoading ? (
                                <Loader2 size={16} className="animate-spin" />
                            ) : (
                                <><CreditCard size={16} /> Buy Subdomain — {ownershipPrice?.priceLabel || 'Price unavailable'} (One-time)</>
                            )}
                        </motion.button>
                    </div>
                )}
            </motion.div>

            {/* Edit Subdomain */}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="glass-panel p-6 mb-6">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-bold flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                        <Edit3 size={18} /> Change Subdomain
                    </h3>
                    {!editing && (
                        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }} onClick={() => setEditing(true)}
                            className="px-4 py-2 rounded-xl text-sm font-semibold glass-button" style={{ color: 'hsl(var(--foreground))' }}>
                            Edit
                        </motion.button>
                    )}
                </div>

                {editing ? (
                    <div>
                        <div className="flex items-center gap-0 rounded-xl overflow-hidden mb-2" style={{ border: '1.5px solid var(--glass-border)', background: 'var(--glass-bg)' }}>
                            <span className="px-3 py-3 text-sm font-medium select-none" style={{ background: 'var(--glass-inner)', color: 'hsl(var(--muted-foreground))', borderRight: '1px solid var(--glass-border)', whiteSpace: 'nowrap' }}>
                                https://
                            </span>
                            <input type="text" value={newSlug} onChange={(e) => { setNewSlug(sanitize(e.target.value)); setSlugAvailable(null); setSlugMessage(''); }}
                                className="flex-1 px-3 py-3 bg-transparent text-sm outline-none font-mono" style={{ color: 'hsl(var(--foreground))' }}
                                placeholder="your-store" maxLength={50} />
                            <span className="px-3 py-3 text-sm font-medium select-none" style={{ color: 'hsl(var(--muted-foreground))' }}>.rozare.com</span>
                            <span className="px-3">
                                {slugChecking ? <Loader2 size={16} className="animate-spin" style={{ color: 'hsl(var(--muted-foreground))' }} />
                                    : slugAvailable === true ? <CheckCircle size={16} style={{ color: 'hsl(150, 60%, 45%)' }} />
                                    : slugAvailable === false ? <X size={16} style={{ color: 'hsl(0, 72%, 55%)' }} /> : null}
                            </span>
                        </div>
                        {slugMessage && <p className="text-xs mb-3" style={{ color: slugAvailable ? 'hsl(150, 60%, 45%)' : 'hsl(0, 72%, 55%)' }}>{slugMessage}</p>}
                        <div className="flex gap-2 mt-3">
                            <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }} onClick={handleSaveSlug}
                                disabled={saving || slugAvailable === false || !newSlug || newSlug.length < 3}
                                className="px-4 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50 flex items-center gap-2"
                                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))' }}>
                                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
                            </motion.button>
                            <motion.button whileHover={{ scale: 1.02 }} onClick={() => { setEditing(false); setNewSlug(subdomain.slug); setSlugAvailable(null); setSlugMessage(''); }}
                                className="px-4 py-2 rounded-xl text-sm font-semibold glass-button" style={{ color: 'hsl(var(--foreground))' }}>
                                Cancel
                            </motion.button>
                        </div>
                    </div>
                ) : (
                    <div className="glass-inner rounded-xl p-4 flex items-center gap-3">
                        <Globe size={16} style={{ color: 'hsl(var(--primary))' }} />
                        <span className="text-sm font-mono font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{subdomain.url}</span>
                        <button onClick={() => copyToClipboard(`https://${subdomain.url}`)} className="p-1.5 rounded-lg hover:bg-white/10">
                            <Copy size={14} style={{ color: 'hsl(var(--muted-foreground))' }} />
                        </button>
                    </div>
                )}
            </motion.div>

            {/* Stats Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                {stats.map((stat, i) => (
                    <motion.div key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 + i * 0.05 }}
                        whileHover={{ y: -3 }} className="glass-card p-5">
                        <div className="glass-inner inline-flex p-2.5 rounded-xl mb-3" style={{ color: stat.color }}>{stat.icon}</div>
                        <p className="text-xs font-medium mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{stat.label}</p>
                        <p className="text-2xl font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>{stat.value}</p>
                    </motion.div>
                ))}
            </div>

            {/* Traffic Chart */}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className="glass-panel p-6 mb-6">
                <h3 className="text-lg font-bold mb-4 flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                    <BarChart3 size={18} /> Monthly Traffic
                </h3>
                {analytics.monthlyTraffic && analytics.monthlyTraffic.length > 0 ? (
                    <ResponsiveContainer width="100%" height={250}>
                        <AreaChart data={analytics.monthlyTraffic}>
                            <defs>
                                <linearGradient id="trafficGrad" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="hsl(220, 70%, 55%)" stopOpacity={0.3} />
                                    <stop offset="95%" stopColor="hsl(220, 70%, 55%)" stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <XAxis dataKey="month" tick={{ fontSize: 12, fill: 'hsl(220, 10%, 50%)' }} axisLine={false} tickLine={false} />
                            <YAxis tick={{ fontSize: 12, fill: 'hsl(220, 10%, 50%)' }} axisLine={false} tickLine={false} />
                            <Tooltip contentStyle={{ background: 'rgba(255,255,255,0.9)', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 12 }} />
                            <Area type="monotone" dataKey="views" stroke="hsl(220, 70%, 55%)" fill="url(#trafficGrad)" strokeWidth={2.5} />
                        </AreaChart>
                    </ResponsiveContainer>
                ) : (
                    <div className="text-center py-12">
                        <BarChart3 size={32} style={{ color: 'hsl(var(--muted-foreground))' }} className="mx-auto mb-2 opacity-40" />
                        <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>No traffic data yet</p>
                    </div>
                )}
            </motion.div>

            {/* Quick Info */}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }} className="glass-panel p-6">
                <h3 className="text-lg font-bold mb-4 flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                    <Info size={18} /> About Subdomains
                </h3>
                <div className="space-y-3">
                    {[
                        { q: 'What is a subdomain?', a: 'A custom URL like yourstore.rozare.com that customers can use to access your store directly.' },
                        { q: 'When does it become active?', a: 'Your subdomain is live while your store is active. Verification is separate and adds a verified badge, not subdomain activation.' },
                        { q: 'Can I change it later?', a: 'Yes, after the 30-day change cooldown. The old URL stops working immediately when a change is saved.' },
                        { q: 'What happens if my account is blocked?', a: isOwned
                            ? 'Your subdomain is protected for 3 years from purchase. No one else can claim it even if your account is blocked.'
                            : 'Without purchasing your subdomain, it will be removed after 7 days of your account being blocked. Purchase it to protect it for 3 years.' },
                        { q: 'What does buying a subdomain mean?', a: ownershipPrice && ownershipYears
                            ? `For a one-time ${ownershipPrice.priceLabel} payment, you own your subdomain for ${ownershipYears} years. Even if your account is blocked, no one else can claim it. After ${ownershipYears} years, you can renew the ownership.`
                            : 'Refresh to load the authoritative one-time price and ownership duration before opening Checkout.' },
                    ].map((item, i) => (
                        <div key={i} className="glass-inner rounded-xl p-4">
                            <p className="text-sm font-semibold mb-1" style={{ color: 'hsl(var(--foreground))' }}>{item.q}</p>
                            <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{item.a}</p>
                        </div>
                    ))}
                </div>
            </motion.div>
        </div>
    );
};

export default SellerSubdomainManagement;
