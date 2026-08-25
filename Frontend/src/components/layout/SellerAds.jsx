import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import axios from 'axios';
import { toast } from 'react-toastify';
import {
    AlertTriangle,
    Check,
    Clock,
    Crown,
    Loader2,
    Megaphone,
    RefreshCw,
    Send,
    Sparkles,
    Square,
    SquareCheck,
    StopCircle,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Loader from '../common/Loader';
import { useCurrency } from '../../contexts/CurrencyContext';
import { getAuthToken } from '../../utils/cookieHelper';
import {
    formatUsdCents,
    inspectSellerAdMutationResponse,
    inspectSellerAdsOverview,
    sellerAdsOverviewConfirmsRequest,
} from '../../utils/sellerAdsSafety';

const API = `${import.meta.env.VITE_API_URL}api/ads`;

const requestLabels = {
    start: 'Start ads',
    update: 'Change products',
    stop: 'Stop ads',
};

const statusStyles = {
    pending: { color: 'hsl(30,90%,50%)', bg: 'rgba(249,115,22,0.12)' },
    approved: { color: 'hsl(150,60%,40%)', bg: 'rgba(16,185,129,0.12)' },
    rejected: { color: 'hsl(0,72%,55%)', bg: 'rgba(239,68,68,0.12)' },
};

function productImage(product) {
    return product?.image || product?.images?.[0]?.url || '';
}

function StatusPill({ status, active }) {
    const style = statusStyles[status];
    return (
        <span
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold capitalize"
            style={{ color: style.color, background: style.bg }}
        >
            {active ? <Sparkles size={11} /> : status === 'pending' ? <Clock size={11} /> : <Check size={11} />}
            {active ? 'Active' : status}
        </span>
    );
}

function EliteDialog({ open, onClose, onSubscribe }) {
    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-50 bg-black/45 backdrop-blur-sm flex items-center justify-center p-4"
                    onClick={onClose}
                >
                    <motion.div
                        initial={{ scale: 0.96, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.96, opacity: 0 }}
                        onClick={(event) => event.stopPropagation()}
                        className="glass-panel-strong p-6 max-w-md w-full"
                    >
                        <div className="w-12 h-12 rounded-2xl mx-auto mb-4 flex items-center justify-center"
                            style={{ background: 'rgba(139,92,246,0.14)', color: 'hsl(270,60%,55%)' }}>
                            <Crown size={24} />
                        </div>
                        <h3 className="text-lg font-bold text-center" style={{ color: 'hsl(var(--foreground))' }}>Subscribe Elite to run ads</h3>
                        <p className="text-sm text-center mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            Rozare-run TikTok ads for your store and featured products are included in the Elite plan.
                        </p>
                        <div className="flex gap-3 mt-5">
                            <button
                                onClick={onClose}
                                className="flex-1 py-2.5 rounded-xl text-sm font-semibold glass-inner"
                                style={{ color: 'hsl(var(--foreground))' }}
                            >
                                Later
                            </button>
                            <button
                                onClick={onSubscribe}
                                className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white"
                                style={{ background: 'linear-gradient(135deg, hsl(270,60%,55%), hsl(290,50%,50%))' }}
                            >
                                Go to Subscription
                            </button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

const apiErrorMessage = (error, fallback) => {
    const message = error?.response?.data?.msg;
    return typeof message === 'string' && message.trim() ? message.trim() : fallback;
};

const isCanceledRequest = error => (
    axios.isCancel(error)
    || error?.name === 'AbortError'
    || error?.name === 'CanceledError'
    || error?.code === 'ERR_CANCELED'
);

const SellerAds = () => {
    const navigate = useNavigate();
    const { formatPrice } = useCurrency();
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [submitting, setSubmitting] = useState('');
    const [inspection, setInspection] = useState(null);
    const [selectedIds, setSelectedIds] = useState([]);
    const [includeMeta, setIncludeMeta] = useState(false);
    const [sellerNote, setSellerNote] = useState('');
    const [showEliteDialog, setShowEliteDialog] = useState(false);
    const overviewGenerationRef = useRef(0);
    const overviewAbortRef = useRef(null);
    const mutationGenerationRef = useRef(0);
    const mutationAbortRef = useRef(null);

    const clearVerifiedOverview = useCallback(() => {
        setInspection(null);
        setSelectedIds([]);
        setIncludeMeta(false);
    }, []);

    const fetchOverview = useCallback(async ({
        expectedRequest = null,
        notifyFailure = true,
        throwOnFailure = false,
    } = {}) => {
        const generation = overviewGenerationRef.current + 1;
        overviewGenerationRef.current = generation;
        overviewAbortRef.current?.abort();
        const controller = new AbortController();
        overviewAbortRef.current = controller;
        clearVerifiedOverview();
        setLoadError('');
        setLoading(true);
        try {
            const token = getAuthToken();
            const res = await axios.get(`${API}/seller/overview`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: controller.signal,
            });
            const nextInspection = inspectSellerAdsOverview(res.data);
            if (!nextInspection) {
                throw new Error('Seller ads overview failed validation.');
            }
            if (expectedRequest && !sellerAdsOverviewConfirmsRequest(nextInspection, expectedRequest)) {
                throw new Error('Seller ads request was not confirmed by the refreshed overview.');
            }
            if (
                controller.signal.aborted
                || generation !== overviewGenerationRef.current
            ) return null;

            setInspection(nextInspection);
            setSelectedIds(nextInspection.initialSelectedIds);
            setIncludeMeta(nextInspection.initialIncludeMeta);
            setLoadError('');
            return nextInspection;
        } catch (error) {
            if (
                controller.signal.aborted
                || generation !== overviewGenerationRef.current
                || isCanceledRequest(error)
            ) return null;

            clearVerifiedOverview();
            const message = error?.response
                ? apiErrorMessage(error, 'Failed to load ads.')
                : 'Ads information is unavailable because the server response could not be verified.';
            setLoadError(message);
            if (notifyFailure) toast.error(message);
            if (throwOnFailure) throw error;
            return null;
        } finally {
            if (generation === overviewGenerationRef.current) {
                if (overviewAbortRef.current === controller) overviewAbortRef.current = null;
                setLoading(false);
            }
        }
    }, [clearVerifiedOverview]);

    useEffect(() => {
        fetchOverview();
        return () => {
            overviewGenerationRef.current += 1;
            mutationGenerationRef.current += 1;
            overviewAbortRef.current?.abort();
            mutationAbortRef.current?.abort();
        };
    }, [fetchOverview]);

    const data = inspection?.overview ?? null;

    const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
    const activeSet = useMemo(
        () => new Set(inspection?.activeRequest?.productIds ?? []),
        [inspection]
    );
    const pendingSet = useMemo(() => {
        const ids = (inspection?.pendingRequests ?? []).flatMap((request) => request.productIds);
        return new Set(ids);
    }, [inspection]);

    const hasPending = (inspection?.pendingRequests.length ?? 0) > 0;
    const hasActive = inspection?.activeRequest?.active === true;
    const metaAddonPrice = data ? formatUsdCents(data.metaAdsAddonCents) : null;
    const metaAddonIncluded = inspection?.subscription.metaAdsIncluded === true;
    const canRequestMeta = metaAddonIncluded;
    const requestType = hasActive ? 'update' : 'start';

    const toggleProduct = (id) => {
        if (submitting || !inspection?.featuredProductMoney.has(id)) return;
        setSelectedIds((prev) => (
            prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
        ));
    };

    const toggleMeta = () => {
        if (!metaAddonIncluded && !includeMeta) {
            toast.info('Add Meta ads in the Subscription tab first.');
            navigate('/seller-dashboard/subscription');
            return;
        }
        setIncludeMeta((value) => !value);
    };

    const submitRequest = async (type = requestType) => {
        if (mutationAbortRef.current) return;
        if (!inspection || !data) {
            toast.error('Reload the verified ads overview before submitting a request.');
            return;
        }
        if (!data.isElite) {
            setShowEliteDialog(true);
            return;
        }
        if (!['start', 'update', 'stop'].includes(type) || (type !== 'stop' && type !== requestType)) {
            toast.error('The requested campaign change does not match the verified campaign state.');
            return;
        }
        if (type !== 'stop' && selectedIds.length === 0) {
            toast.error('Select at least one featured product.');
            return;
        }
        if (type !== 'stop' && selectedIds.some(id => !inspection.featuredProductMoney.has(id))) {
            toast.error('One or more selected products are no longer eligible for ads.');
            return;
        }
        const normalizedSellerNote = sellerNote.trim();
        if (normalizedSellerNote.length > 500) {
            toast.error('The admin note cannot exceed 500 characters.');
            return;
        }
        if (type !== 'stop' && includeMeta && !canRequestMeta) {
            toast.error('Add Meta ads to your Elite subscription before requesting Meta campaigns.');
            return;
        }

        const expected = {
            requestType: type,
            productIds: type === 'stop' ? [] : [...selectedIds],
            includeMeta: type === 'stop' ? false : includeMeta,
            sellerNote: normalizedSellerNote,
            sellerId: inspection.sellerId,
            storeId: inspection.storeId,
        };
        const generation = mutationGenerationRef.current + 1;
        mutationGenerationRef.current = generation;
        mutationAbortRef.current?.abort();
        overviewGenerationRef.current += 1;
        overviewAbortRef.current?.abort();
        const controller = new AbortController();
        mutationAbortRef.current = controller;
        clearVerifiedOverview();
        setLoadError('');
        setLoading(true);
        setSubmitting(type);
        try {
            const token = getAuthToken();
            const res = await axios.post(`${API}/seller/request`, {
                requestType: type,
                productIds: expected.productIds,
                includeMeta: expected.includeMeta,
                sellerNote: expected.sellerNote,
            }, {
                headers: { Authorization: `Bearer ${token}` },
                signal: controller.signal,
            });

            if (controller.signal.aborted || generation !== mutationGenerationRef.current) return;
            const mutation = inspectSellerAdMutationResponse(res.data, expected);
            if (!mutation) {
                throw new Error('Seller ads mutation response failed validation.');
            }
            const refreshed = await fetchOverview({
                expectedRequest: mutation.request,
                notifyFailure: false,
                throwOnFailure: true,
            });
            if (
                !refreshed
                || controller.signal.aborted
                || generation !== mutationGenerationRef.current
            ) return;

            setSellerNote('');
            toast.success(mutation.message);
        } catch (error) {
            if (
                controller.signal.aborted
                || generation !== mutationGenerationRef.current
                || isCanceledRequest(error)
            ) return;

            overviewGenerationRef.current += 1;
            overviewAbortRef.current?.abort();
            clearVerifiedOverview();
            setLoading(false);
            if (error.response?.data?.requiresElite) {
                setShowEliteDialog(true);
            }
            const message = error?.response
                ? apiErrorMessage(error, 'Failed to submit ads request.')
                : 'The ads request could not be verified. Reload the overview before trying again.';
            setLoadError(message);
            toast.error(message);
        } finally {
            if (generation === mutationGenerationRef.current) {
                if (mutationAbortRef.current === controller) mutationAbortRef.current = null;
                setSubmitting('');
            }
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <Loader size="default" text="Loading ads..." />
            </div>
        );
    }

    if (!inspection || !data) {
        return (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
                <div className="glass-panel-strong p-5 sm:p-6">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div className="flex items-start gap-3">
                            <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0"
                                style={{ background: 'rgba(239,68,68,0.12)', color: 'hsl(0,72%,55%)' }}>
                                <AlertTriangle size={22} />
                            </div>
                            <div>
                                <h1 className="text-xl font-bold" style={{ color: 'hsl(var(--foreground))' }}>Ads unavailable</h1>
                                <p className="text-sm mt-1 max-w-2xl" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    {loadError || 'The ads overview could not be verified. Reload it before managing campaigns.'}
                                </p>
                            </div>
                        </div>
                        <button
                            onClick={() => fetchOverview()}
                            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold glass-inner"
                            style={{ color: 'hsl(var(--foreground))' }}
                        >
                            <RefreshCw size={15} /> Retry
                        </button>
                    </div>
                </div>
                <EliteDialog
                    open={showEliteDialog}
                    onClose={() => setShowEliteDialog(false)}
                    onSubscribe={() => navigate('/seller-dashboard/subscription')}
                />
            </motion.div>
        );
    }

    const featuredProducts = data.featuredProducts;

    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
            <div className="glass-panel-strong p-5 sm:p-6">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                    <div className="flex items-start gap-3">
                        <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0"
                            style={{ background: 'linear-gradient(135deg, hsl(270, 60%, 55%), hsl(190, 80%, 45%))', color: 'white' }}>
                            <Megaphone size={22} />
                        </div>
                        <div>
                            <h1 className="text-xl font-bold" style={{ color: 'hsl(var(--foreground))' }}>Ads</h1>
                            <p className="text-sm mt-1 max-w-2xl" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Select featured products for Rozare-run TikTok ads. Meta ads require the Meta add-on on your Elite plan.
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={() => fetchOverview()}
                        disabled={Boolean(submitting)}
                        className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold glass-inner"
                        style={{ color: 'hsl(var(--foreground))' }}
                    >
                        <RefreshCw size={15} /> Refresh
                    </button>
                </div>
            </div>

            {!data.isElite && (
                <div className="glass-card p-4 border" style={{ borderColor: 'rgba(249,115,22,0.22)', background: 'rgba(249,115,22,0.07)' }}>
                    <div className="flex items-start gap-3">
                        <Crown size={18} className="shrink-0 mt-0.5" style={{ color: 'hsl(30,90%,45%)' }} />
                        <div>
                            <p className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>Elite required to submit ads</p>
                            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                You can configure products here, but only Rozare Elite sellers can send an ads request for approval.
                            </p>
                        </div>
                    </div>
                </div>
            )}

            <div className="grid lg:grid-cols-[1fr_320px] gap-5">
                <div className="glass-panel-strong p-4 sm:p-5">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                        <div>
                            <h2 className="text-base font-bold" style={{ color: 'hsl(var(--foreground))' }}>Featured Products</h2>
                            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Only featured products are eligible for ads.
                            </p>
                        </div>
                        <span className="text-xs font-semibold px-3 py-1 rounded-full"
                            style={{ color: 'hsl(220,70%,50%)', background: 'rgba(99,102,241,0.12)' }}>
                            {selectedIds.length} selected
                        </span>
                    </div>

                    {featuredProducts.length === 0 ? (
                        <div className="rounded-2xl p-6 text-center glass-inner">
                            <AlertTriangle size={24} className="mx-auto mb-2" style={{ color: 'hsl(30,90%,50%)' }} />
                            <p className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>No featured products yet</p>
                            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Mark products as featured from Product Management before requesting ads.
                            </p>
                        </div>
                    ) : (
                        <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
                            {featuredProducts.map((product) => {
                                const id = product._id;
                                const selected = selectedSet.has(id);
                                const active = activeSet.has(id);
                                const pending = pendingSet.has(id);
                                return (
                                    <button
                                        key={id}
                                        onClick={() => toggleProduct(id)}
                                        disabled={Boolean(submitting)}
                                        className="text-left rounded-2xl p-3 glass-card transition-all hover:scale-[1.01] min-w-0"
                                        style={{
                                            border: selected ? '1px solid rgba(16,185,129,0.45)' : '1px solid var(--glass-border)',
                                            background: selected ? 'rgba(16,185,129,0.08)' : undefined,
                                        }}
                                    >
                                        <div className="flex gap-3 min-w-0">
                                            <div className="w-16 h-16 rounded-xl overflow-hidden shrink-0 glass-inner">
                                                {productImage(product) ? (
                                                    <img src={productImage(product)} alt={product.name} className="w-full h-full object-cover" />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>No image</div>
                                                )}
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-start justify-between gap-2">
                                                    <p className="text-sm font-bold line-clamp-2" style={{ color: 'hsl(var(--foreground))' }}>{product.name}</p>
                                                    {selected ? <SquareCheck size={18} className="shrink-0" style={{ color: 'hsl(150,60%,40%)' }} /> : <Square size={18} className="shrink-0" style={{ color: 'hsl(var(--muted-foreground))' }} />}
                                                </div>
                                                <p className="text-[11px] mt-1 uppercase tracking-wide" style={{ color: 'hsl(var(--muted-foreground))' }}>{product.category}</p>
                                                <p className="text-xs font-bold mt-2" style={{ color: 'hsl(var(--foreground))' }}>
                                                    {formatPrice(inspection.featuredProductMoney.get(id).displayAmount, {
                                                        sourceCurrency: inspection.featuredProductMoney.get(id).currency,
                                                    })}
                                                </p>
                                                <div className="flex flex-wrap gap-1.5 mt-2">
                                                    {active && <StatusPill status="approved" active />}
                                                    {pending && <StatusPill status="pending" />}
                                                </div>
                                            </div>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div className="space-y-4">
                    <div className="glass-panel-strong p-4">
                        <h2 className="text-sm font-bold mb-3" style={{ color: 'hsl(var(--foreground))' }}>Campaign Channels</h2>
                        <div className="space-y-3">
                            <div className="rounded-xl p-3 glass-inner">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <p className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>TikTok ads</p>
                                        <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Included with Elite</p>
                                    </div>
                                    <span className="px-2.5 py-1 rounded-full text-[11px] font-bold" style={{ color: 'hsl(150,60%,40%)', background: 'rgba(16,185,129,0.12)' }}>On</span>
                                </div>
                            </div>
                            <button
                                onClick={toggleMeta}
                                disabled={Boolean(submitting)}
                                className="w-full rounded-xl p-3 glass-inner text-left"
                                style={{ border: includeMeta ? '1px solid rgba(59,130,246,0.35)' : '1px solid var(--glass-border)' }}
                            >
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <p className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>Include Meta ads</p>
                                        <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            {metaAddonIncluded
                                                ? `Included in your Elite plan (+${metaAddonPrice}/month)`
                                                : `Add in Subscription first (+${metaAddonPrice}/month)`}
                                        </p>
                                    </div>
                                    {includeMeta && canRequestMeta ? <SquareCheck size={19} style={{ color: 'hsl(220,70%,55%)' }} /> : <Square size={19} style={{ color: 'hsl(var(--muted-foreground))' }} />}
                                </div>
                            </button>
                        </div>
                    </div>

                    <div className="glass-panel-strong p-4">
                        <h2 className="text-sm font-bold mb-3" style={{ color: 'hsl(var(--foreground))' }}>Request</h2>
                        {hasActive && (
                            <div className="mb-3">
                                <StatusPill status="approved" active />
                            </div>
                        )}
                        {hasPending && (
                            <div className="mb-3 rounded-xl p-3" style={{ background: 'rgba(249,115,22,0.08)', border: '1px solid rgba(249,115,22,0.2)' }}>
                                <p className="text-xs font-bold" style={{ color: 'hsl(30,90%,45%)' }}>Approval pending</p>
                                <p className="text-[11px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Wait for admin review before sending another ads change.</p>
                            </div>
                        )}
                        <textarea
                            value={sellerNote}
                            onChange={(event) => setSellerNote(event.target.value)}
                            rows={3}
                            maxLength={500}
                            placeholder="Optional note for admin"
                            disabled={Boolean(submitting)}
                            className="w-full rounded-xl px-3 py-2 text-sm glass-input resize-none"
                            style={{ color: 'hsl(var(--foreground))' }}
                        />
                        <button
                            onClick={() => submitRequest()}
                            disabled={Boolean(submitting) || hasPending || featuredProducts.length === 0}
                            className="w-full mt-3 py-3 rounded-xl font-bold text-sm text-white flex items-center justify-center gap-2 disabled:opacity-60"
                            style={{ background: 'linear-gradient(135deg, hsl(270,60%,55%), hsl(190,80%,45%))' }}
                        >
                            {submitting === requestType ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                            {hasActive ? 'Submit Product Changes' : 'Run Ads'}
                        </button>
                        {hasActive && (
                            <button
                                onClick={() => submitRequest('stop')}
                                disabled={Boolean(submitting) || hasPending}
                                className="w-full mt-2 py-2.5 rounded-xl font-bold text-xs flex items-center justify-center gap-2 disabled:opacity-60"
                                style={{ color: 'hsl(0,72%,55%)', background: 'rgba(239,68,68,0.1)' }}
                            >
                                {submitting === 'stop' ? <Loader2 size={14} className="animate-spin" /> : <StopCircle size={14} />}
                                Stop Ads
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <div className="glass-panel-strong p-4 sm:p-5">
                <h2 className="text-base font-bold mb-4" style={{ color: 'hsl(var(--foreground))' }}>Recent Requests</h2>
                {data.recentRequests.length === 0 ? (
                    <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>No ads requests yet.</p>
                ) : (
                    <div className="space-y-3">
                        {data.recentRequests.map((request) => (
                            <div key={request._id} className="rounded-2xl p-3 glass-card">
                                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                                    <div>
                                        <p className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>{requestLabels[request.requestType]}</p>
                                        <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            {request.productIds.length > 0
                                                ? request.products.map((product) => product.name).join(', ')
                                                : 'No products'} · TikTok{request.channels.meta ? ' + Meta' : ''}
                                        </p>
                                    </div>
                                    <StatusPill status={request.status} active={request.active} />
                                </div>
                                {request.adminNote && (
                                    <p className="text-xs mt-2 rounded-xl p-2" style={{ color: 'hsl(var(--muted-foreground))', background: 'rgba(255,255,255,0.1)' }}>
                                        Admin note: {request.adminNote}
                                    </p>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <EliteDialog
                open={showEliteDialog}
                onClose={() => setShowEliteDialog(false)}
                onSubscribe={() => navigate('/seller-dashboard/subscription')}
            />
        </motion.div>
    );
};

export default SellerAds;
