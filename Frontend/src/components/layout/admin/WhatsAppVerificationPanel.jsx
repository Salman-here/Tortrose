import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';
import {
    MessageCircle, QrCode, Power, RefreshCw, X, AlertTriangle, CheckCircle2,
    Loader2, Phone, Clock, ShieldAlert, Activity, Inbox, Send, ThumbsUp, ThumbsDown,
    TrendingUp, BarChart3, Timer, RotateCcw, Bell,
} from 'lucide-react';
import PhoneField, { isValidPhone } from '../../common/PhoneField';
import { getAuthToken } from "../../../utils/cookieHelper";


const API = import.meta.env.VITE_API_URL;
const authHeaders = () => ({ Authorization: `Bearer ${getAuthToken()}` });

const STATUS_META = {
    disconnected: { label: 'Disconnected', color: 'hsl(0, 0%, 55%)', bg: 'rgba(120,120,120,0.12)' },
    pending_qr:   { label: 'Awaiting QR scan', color: 'hsl(38, 92%, 50%)', bg: 'rgba(245,158,11,0.12)' },
    connecting:   { label: 'Connecting…', color: 'hsl(220, 70%, 55%)', bg: 'rgba(99,102,241,0.12)' },
    connected:    { label: 'Connected', color: 'hsl(150, 70%, 40%)', bg: 'rgba(34,197,94,0.12)' },
    error:        { label: 'Error', color: 'hsl(0, 72%, 55%)', bg: 'rgba(239,68,68,0.12)' },
};

const QUEUE_STATUS_META = {
    queued:    { label: 'Queued',     color: 'hsl(0,0%,55%)',     icon: Clock },
    sending:   { label: 'Sending',    color: 'hsl(220,70%,55%)',  icon: Loader2 },
    sent:      { label: 'Sent',       color: 'hsl(220,70%,55%)',  icon: CheckCircle2 },
    voted_yes: { label: 'Confirmed ✓',color: 'hsl(150,70%,40%)',  icon: CheckCircle2 },
    voted_no:  { label: 'Declined',   color: 'hsl(0,72%,55%)',    icon: X },
    failed:    { label: 'Failed',     color: 'hsl(0,72%,55%)',    icon: AlertTriangle },
    failed_invalid_number: { label: 'Invalid Number', color: 'hsl(0,72%,55%)', icon: AlertTriangle },
    expired:   { label: 'Expired',    color: 'hsl(0,0%,55%)',     icon: Clock },
};

const formatTime = (d) => {
    if (!d) return '—';
    try { return new Date(d).toLocaleString(); } catch { return '—'; }
};

const StatCard = ({ icon: Icon, label, value, sub, color }) => (
    <div className="glass-panel-strong rounded-2xl p-4 flex flex-col gap-2">
        <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'hsl(var(--muted-foreground))' }}>{label}</span>
            <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: `${color}1A`, color }}>
                <Icon size={14} />
            </div>
        </div>
        <div className="text-2xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>{value ?? 0}</div>
        {sub && <div className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>{sub}</div>}
    </div>
);

const Timeline = ({ data }) => {
    const max = Math.max(1, ...data.map(d => d.sent));
    return (
        <div className="flex items-end gap-2 h-32">
            {data.map((d, i) => {
                const sentH = (d.sent / max) * 100;
                const confirmedH = (d.confirmed / max) * 100;
                const declinedH = (d.declined / max) * 100;
                const dayLabel = new Date(d.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' });
                return (
                    <div key={i} className="flex-1 flex flex-col items-center gap-1.5">
                        <div className="w-full flex-1 flex items-end gap-0.5">
                            <div className="flex-1 rounded-t-md transition-all" style={{ height: `${sentH}%`, background: 'hsl(220,70%,55%)', minHeight: d.sent ? 4 : 0 }} title={`${d.sent} sent`} />
                            <div className="flex-1 rounded-t-md transition-all" style={{ height: `${confirmedH}%`, background: 'hsl(150,70%,40%)', minHeight: d.confirmed ? 4 : 0 }} title={`${d.confirmed} confirmed`} />
                            <div className="flex-1 rounded-t-md transition-all" style={{ height: `${declinedH}%`, background: 'hsl(0,72%,55%)', minHeight: d.declined ? 4 : 0 }} title={`${d.declined} declined`} />
                        </div>
                        <span className="text-[9px] font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{dayLabel}</span>
                    </div>
                );
            })}
        </div>
    );
};

const SellerTimeline = ({ data }) => {
    const max = Math.max(1, ...data.map(d => d.sent + d.failed + d.skipped));
    return (
        <div className="flex items-end gap-2 h-32">
            {data.map((d, i) => {
                const sentH = (d.sent / max) * 100;
                const failedH = (d.failed / max) * 100;
                const skippedH = (d.skipped / max) * 100;
                const dayLabel = new Date(d.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' });
                return (
                    <div key={i} className="flex-1 flex flex-col items-center gap-1.5">
                        <div className="w-full flex-1 flex items-end gap-0.5">
                            <div className="flex-1 rounded-t-md transition-all" style={{ height: `${sentH}%`, background: 'hsl(220,70%,55%)', minHeight: d.sent ? 4 : 0 }} title={`${d.sent} sent`} />
                            <div className="flex-1 rounded-t-md transition-all" style={{ height: `${failedH}%`, background: 'hsl(0,72%,55%)', minHeight: d.failed ? 4 : 0 }} title={`${d.failed} failed`} />
                            <div className="flex-1 rounded-t-md transition-all" style={{ height: `${skippedH}%`, background: 'hsl(0,0%,55%)', minHeight: d.skipped ? 4 : 0 }} title={`${d.skipped} skipped`} />
                        </div>
                        <span className="text-[9px] font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{dayLabel}</span>
                    </div>
                );
            })}
        </div>
    );
};

const WhatsAppVerificationPanel = () => {
    const [activeTab, setActiveTab] = useState('seller');
    const [status, setStatus] = useState(null);
    const [queue, setQueue] = useState([]);
    const [queueMeta, setQueueMeta] = useState({ total: 0, page: 1, totalPages: 1 });
    const [queueFilter, setQueueFilter] = useState('all');
    const [queuePage, setQueuePage] = useState(1);
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);
    const [showQrModal, setShowQrModal] = useState(false);
    const [qrLoading, setQrLoading] = useState(false);
    const [qrBase64, setQrBase64] = useState('');
    const [qrError, setQrError] = useState('');
    const [qrHint, setQrHint] = useState('');
    const [qrDiagnostic, setQrDiagnostic] = useState('');
    const [pairingCode, setPairingCode] = useState('');
    const [phoneNumber, setPhoneNumber] = useState('');
    const [showPairingInput, setShowPairingInput] = useState(false);
    const [pairingLoading, setPairingLoading] = useState(false);
    const [confirmDisconnect, setConfirmDisconnect] = useState(false);
    const [confirmReset, setConfirmReset] = useState(false);
    const [resetting, setResetting] = useState(false);
    const [resetMsg, setResetMsg] = useState('');
    const pollRef = useRef(null);

    const fetchQueue = useCallback(async (filter, page) => {
        try {
            const { data } = await axios.get(`${API}api/whatsapp/queue?filter=${filter}&page=${page}&limit=15`, { headers: authHeaders() });
            setQueue(data.items || []);
            setQueueMeta({ total: data.total || 0, page: data.page || 1, totalPages: data.totalPages || 1 });
        } catch { /* ignore */ }
    }, []);

    const fetchStatus = useCallback(async () => {
        try {
            const [s, st] = await Promise.all([
                axios.get(`${API}api/whatsapp/status`, { headers: authHeaders() }),
                axios.get(`${API}api/whatsapp/stats`, { headers: authHeaders() }).catch(() => ({ data: null })),
            ]);
            setStatus(s.data);
            if (s.data?.qrBase64) {
                setQrBase64(s.data.qrBase64);
                setQrError('');
            }
            setQrDiagnostic(s.data?.lastError || '');
            if (s.data?.status === 'connected') {
                setQrHint('');
                setQrDiagnostic('');
                setPairingCode('');
            }
            if (st.data) setStats(st.data);
        } catch (err) {
            console.error('whatsapp panel fetch error:', err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchStatus();
    }, [fetchStatus]);

    useEffect(() => {
        fetchQueue(queueFilter, queuePage);
    }, [fetchQueue, queueFilter, queuePage]);

    // Refetch queue when filter/page changes
    const handleFilterChange = (f) => { setQueueFilter(f); setQueuePage(1); };
    const handlePageChange = (p) => { setQueuePage(p); };

    const requestQr = useCallback(async () => {
        setQrLoading(true);
        setQrError('');
        try {
            const { data } = await axios.post(
                `${API}api/whatsapp/connect`,
                {},
                { headers: authHeaders(), timeout: 25000 }
            );
            setQrBase64(data.qrBase64 || '');
            setPairingCode(data.code || '');
            setQrDiagnostic(data.gatewayDiagnostic || '');
            setQrHint(data.fallback || data.msg ? (data.msg || 'Waiting for QR…') : '');
            if (data.recovered) {
                setResetMsg('The previous stuck link session was recreated automatically.');
            }
            if (data.alreadyLinked) {
                setQrError('');
                setQrHint('');
                setQrDiagnostic('');
                setPairingCode('');
            }
            await fetchStatus();
        } catch (err) {
            setQrHint('');
            setPairingCode('');
            const offline =
                err.code === 'ECONNABORTED' ||
                err.message === 'Network Error' ||
                err.response?.status === 503 ||
                err.response?.status === 502;
            setQrError(
                err.response?.data?.msg ||
                (offline
                    ? 'WhatsApp gateway is temporarily unavailable. Try again or reset the instance below.'
                    : 'Failed to fetch QR code')
            );
        } finally {
            setQrLoading(false);
        }
    }, [fetchStatus]);

    // Refresh QR every 25s while modal is open and not yet connected
    useEffect(() => {
        if (showQrModal && status?.status !== 'connected') {
            const id = setInterval(() => requestQr(), 25000);
            return () => clearInterval(id);
        }
    }, [showQrModal, status?.status, requestQr]);

    // Poll status every 5s while QR modal is open, every 30s otherwise
    useEffect(() => {
        if (pollRef.current) clearInterval(pollRef.current);
        const interval = showQrModal ? 5000 : 30000;
        pollRef.current = setInterval(fetchStatus, interval);
        return () => { if (pollRef.current) clearInterval(pollRef.current); };
    }, [showQrModal, fetchStatus]);

    const requestPairingCode = async () => {
        if (!isValidPhone(phoneNumber)) {
            setQrError('Please enter a valid phone number (pick your country and type the number).');
            return;
        }
        // Backend expects digits only (e.g. 923001234567)
        const digitsOnly = String(phoneNumber).replace(/\D/g, '');

        setPairingLoading(true);
        setQrError('');
        try {
            const { data } = await axios.post(
                `${API}api/whatsapp/pairing-code`,
                { phoneNumber: digitsOnly },
                { headers: authHeaders(), timeout: 15000 }
            );
            
            if (data.code) {
                setPairingCode(data.code);
                setQrHint('Enter this code in WhatsApp when prompted');
                setShowPairingInput(false);
            } else {
                setQrHint(data.msg || 'Pairing code requested. Check status in a moment.');
            }
            
            await fetchStatus();
        } catch (err) {
            setQrError(err.response?.data?.msg || 'Failed to request pairing code');
        } finally {
            setPairingLoading(false);
        }
    };

    const openQrModal = async () => {
        setShowQrModal(true);
        setQrBase64(status?.qrBase64 || '');
        setQrError('');
        setQrHint(status?.status === 'connected' ? '' : 'Starting WhatsApp link session…');
        setQrDiagnostic(status?.lastError || '');
        setPairingCode('');
        await requestQr();
    };

    const closeQrModal = () => {
        setShowQrModal(false);
        // If not connected after closing, reset status to disconnected
        // so it doesn't stay stuck at "connecting"
        if (status?.status !== 'connected') {
            setStatus(prev => ({ ...prev, status: 'disconnected', qrBase64: '' }));
        }
        // Fetch fresh status after a moment to reconcile with live state
        setTimeout(() => fetchStatus(), 1500);
    };

    const handleDisconnect = async () => {
        try {
            await axios.post(`${API}api/whatsapp/disconnect`, {}, { headers: authHeaders() });
            setConfirmDisconnect(false);
            // Optimistically update status immediately — don't rely on fetchStatus
            // because Evolution may still briefly report 'open' right after logout
            setStatus(prev => ({ ...prev, status: 'disconnected', linkedNumber: '', qrBase64: '' }));
            // Fetch again after a delay to confirm
            setTimeout(() => fetchStatus(), 2000);
        } catch (err) {
            console.error(err);
        }
    };

    const handleReset = async () => {
        setResetting(true);
        setResetMsg('');
        try {
            const { data } = await axios.post(
                `${API}api/whatsapp/reset`,
                {},
                { headers: authHeaders(), timeout: 30000 }
            );
            setQrBase64('');
            setPairingCode('');
            setQrError('');
            setQrHint('Instance reset. Click "Link WhatsApp" to scan a new QR.');
            setResetMsg(data?.msg || 'Instance reset.');
            setConfirmReset(false);
            setShowQrModal(false);
            await fetchStatus();
        } catch (err) {
            setResetMsg(err.response?.data?.msg || 'Failed to reset WhatsApp instance.');
        } finally {
            setResetting(false);
        }
    };

    // Show reset only when the link flow is stuck: status pending_qr/connecting/error
    // AND we currently have no usable QR or pairing code on screen.
    const isStuckLinking =
        ['pending_qr', 'connecting', 'error'].includes(status?.status) &&
        !qrBase64 &&
        !pairingCode &&
        !qrLoading &&
        status?.status !== 'connected';

    // Auto-close QR modal on connected
    useEffect(() => {
        if (showQrModal && status?.status === 'connected') {
            setTimeout(() => setShowQrModal(false), 1200);
        }
    }, [status?.status, showQrModal]);

    const meta = STATUS_META[status?.status] || STATUS_META.disconnected;

    return (
        <>
            <div className="min-h-screen p-4 lg:p-8 max-w-6xl mx-auto">
                {/* Header */}
                <div className="glass-panel-strong rounded-3xl p-6 mb-6">
                    <div className="flex items-start gap-4">
                        <div className="w-14 h-14 rounded-2xl flex items-center justify-center shrink-0"
                            style={{ background: activeTab === 'orders'
                                ? 'linear-gradient(135deg, hsl(150, 70%, 40%), hsl(170, 70%, 38%))'
                                : 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(240, 60%, 50%))', color: '#fff' }}>
                            {activeTab === 'orders' ? <MessageCircle size={26} /> : <Bell size={26} />}
                        </div>
                        <div className="flex-1">
                            <h1 className="text-2xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>
                                {activeTab === 'orders' ? 'Buyer Order WhatsApp Activity' : 'Unified WhatsApp Gateway'}
                            </h1>
                            <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                {activeTab === 'orders'
                                    ? 'Buyer confirmations, payment notices, and buyer AI messages use the unified gateway.'
                                    : 'One connected WhatsApp number handles buyers, sellers, admins, order confirmations, OTPs, and AI chat.'}
                            </p>
                        </div>
                    </div>
                </div>

                {/* Tab Switcher */}
                <div className="glass-panel-strong rounded-2xl p-1.5 mb-6 flex gap-1">
                    {[
                        { key: 'seller', label: 'Unified Gateway', Icon: Bell, color: 'hsl(220,70%,55%)' },
                        { key: 'orders', label: 'Buyer Orders', Icon: MessageCircle, color: 'hsl(150,70%,40%)' },
                    ].map(tab => (
                        <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                            className={`flex-1 py-2.5 px-4 rounded-xl text-sm font-bold inline-flex items-center justify-center gap-2 transition-all ${activeTab === tab.key ? 'text-white' : ''}`}
                            style={activeTab === tab.key ? { background: tab.color } : { color: 'hsl(var(--muted-foreground))' }}>
                            <tab.Icon size={16} /> {tab.label}
                        </button>
                    ))}
                </div>

                {/* Buyer order activity tab */}
                {activeTab === 'orders' && (
                <>
                {/* Status card */}
                <div className="glass-panel-strong rounded-3xl p-6 mb-6">
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                        <div className="flex items-center gap-4">
                            <span className="px-3 py-1.5 rounded-full text-xs font-bold inline-flex items-center gap-1.5"
                                style={{ background: meta.bg, color: meta.color }}>
                                <Activity size={12} /> {meta.label}
                            </span>
                            {status?.linkedNumber && (
                                <span className="text-sm font-medium inline-flex items-center gap-1.5"
                                    style={{ color: 'hsl(var(--foreground))' }}>
                                    <Phone size={14} /> {status.linkedNumber}
                                </span>
                            )}
                            {status?.lastSeen && (
                                <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    Last seen {formatTime(status.lastSeen)}
                                </span>
                            )}
                        </div>
                        <div className="flex gap-2">
                            <button onClick={fetchStatus} disabled={loading}
                                className="px-3 py-2 rounded-xl text-sm font-medium glass-inner inline-flex items-center gap-1.5 disabled:opacity-50"
                                style={{ color: 'hsl(var(--foreground))' }}>
                                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
                            </button>
                            <span className="px-3 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-1.5"
                                style={{ background: 'rgba(59,130,246,0.10)', color: 'hsl(220,70%,55%)' }}>
                                <Bell size={14} /> Managed in Unified Gateway
                            </span>
                        </div>
                    </div>

                    {!status?.configured && (
                        <div className="mt-4 p-4 rounded-2xl flex items-start gap-3"
                            style={{ background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.25)' }}>
                            <AlertTriangle size={18} style={{ color: 'hsl(38, 92%, 50%)' }} className="shrink-0 mt-0.5" />
                            <div className="text-xs" style={{ color: 'hsl(var(--foreground))' }}>
                                <strong>Gateway not configured.</strong> Add the Evolution API URL/key and unified instance name in the backend secrets, then redeploy.
                            </div>
                        </div>
                    )}

                    {status?.lastError && (
                        <div className="mt-4 p-4 rounded-2xl text-xs"
                            style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: 'hsl(0,72%,55%)' }}>
                            <strong>Last error:</strong> {status.lastError}
                        </div>
                    )}

                    {resetMsg && !confirmReset && (
                        <div className="mt-4 p-4 rounded-2xl text-xs"
                            style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', color: 'hsl(var(--foreground))' }}>
                            {resetMsg}
                        </div>
                    )}
                </div>

                {/* Disclaimer */}
                <div className="glass-panel rounded-3xl p-5 mb-6 flex items-start gap-3">
                    <ShieldAlert size={20} style={{ color: 'hsl(38, 92%, 50%)' }} className="shrink-0 mt-0.5" />
                    <div className="text-xs leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        <strong style={{ color: 'hsl(var(--foreground))' }}>Unified gateway:</strong> Buyer order messages use the same connected WhatsApp number managed in the Unified Gateway tab. Sends are immediate and still capped server-side for safety.
                    </div>
                </div>

                {/* Analytics */}
                {stats && (
                    <div className="mb-6">
                        <h2 className="text-sm font-bold uppercase tracking-wider inline-flex items-center gap-2 mb-3 px-1"
                            style={{ color: 'hsl(var(--muted-foreground))' }}>
                            <BarChart3 size={14} /> Analytics
                        </h2>

                        {/* Top KPIs */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                            <StatCard icon={Send} label="Messages Sent" value={stats.sent} sub={`${stats.last24h} in last 24h`} color="hsl(220,70%,55%)" />
                            <StatCard icon={ThumbsUp} label="Confirmed" value={stats.confirmed} sub={`${stats.confirmationRate}% of replies`} color="hsl(150,70%,40%)" />
                            <StatCard icon={ThumbsDown} label="Declined" value={stats.declined} sub="Orders rejected by buyer" color="hsl(0,72%,55%)" />
                            <StatCard icon={TrendingUp} label="Response Rate" value={`${stats.responseRate}%`} sub={`${stats.last7d} sent this week`} color="hsl(38,92%,50%)" />
                        </div>

                        {/* Secondary KPIs */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                            <StatCard icon={Clock} label="In Queue" value={stats.queued} color="hsl(220,15%,55%)" />
                            <StatCard icon={AlertTriangle} label="Failed" value={stats.failed} color="hsl(0,72%,55%)" sub={stats.neverQueued > 0 ? `${stats.neverQueued} never queued` : undefined} />
                            <StatCard icon={Timer} label="Avg Reply Time" value={stats.avgResponseMinutes != null ? `${stats.avgResponseMinutes}m` : '—'} color="hsl(260,60%,60%)" />
                            <StatCard icon={MessageCircle} label="Total All Time" value={stats.total} color="hsl(180,60%,40%)" />
                        </div>

                        {/* 7-day timeline sparkline */}
                        {stats.timeline && stats.timeline.length > 0 && (
                            <div className="glass-panel-strong rounded-3xl p-5">
                                <div className="flex items-center justify-between mb-3">
                                    <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: 'hsl(var(--muted-foreground))' }}>Last 7 Days</h3>
                                    <div className="flex gap-3 text-[10px]">
                                        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: 'hsl(220,70%,55%)' }} />Sent</span>
                                        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: 'hsl(150,70%,40%)' }} />Confirmed</span>
                                        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: 'hsl(0,72%,55%)' }} />Declined</span>
                                    </div>
                                </div>
                                <Timeline data={stats.timeline} />
                            </div>
                        )}
                    </div>
                )}

                {/* Recent activity */}
                <div className="glass-panel-strong rounded-3xl p-6">
                    <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                        <h2 className="text-sm font-bold uppercase tracking-wider inline-flex items-center gap-2"
                            style={{ color: 'hsl(var(--muted-foreground))' }}>
                            <Inbox size={14} /> Recent Activity
                        </h2>
                        <div className="flex gap-1 flex-wrap">
                            {[
                                { key: 'all', label: 'All' },
                                { key: 'sent', label: 'Sent' },
                                { key: 'confirmed', label: 'Confirmed' },
                                { key: 'cancelled', label: 'Declined' },
                                { key: 'queued', label: 'Queued' },
                                { key: 'failed', label: 'Failed' },
                            ].map(f => (
                                <button key={f.key} onClick={() => handleFilterChange(f.key)}
                                    className="px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all"
                                    style={queueFilter === f.key
                                        ? { background: 'hsl(220,70%,55%)', color: '#fff' }
                                        : { background: 'transparent', color: 'hsl(var(--muted-foreground))' }}>
                                    {f.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {queue.length === 0 ? (
                        <div className="text-center py-12 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            {queueFilter === 'all'
                                ? 'No messages yet. New orders will appear here once WhatsApp is linked.'
                                : `No ${queueFilter} messages found.`}
                        </div>
                    ) : (
                        <>
                        <div className="space-y-2">
                            {queue.map(item => {
                                let qm = QUEUE_STATUS_META[item.status] || QUEUE_STATUS_META.queued;
                                let overrideLabel = null;
                                if (item.status === 'voted_yes' && item.cancelledAfterConfirm) {
                                    qm = { label: 'Cancelled', color: 'hsl(0,72%,55%)', icon: X };
                                    overrideLabel = 'Confirmed → then cancelled from email';
                                } else if (item.status === 'voted_yes' && item.currentOrderStatus === 'cancelled') {
                                    qm = { label: 'Cancelled', color: 'hsl(0,72%,55%)', icon: X };
                                    overrideLabel = 'Confirmed → then cancelled';
                                }
                                const Icon = qm.icon;
                                return (
                                    <div key={item._id} className="glass-inner rounded-2xl p-3 flex items-center gap-3">
                                        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                                            style={{ background: `${qm.color}1A`, color: qm.color }}>
                                            <Icon size={16} className={item.status === 'sending' ? 'animate-spin' : ''} />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>
                                                    #{item.orderId}
                                                </span>
                                                <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                    {item.phone}
                                                </span>
                                            </div>
                                            <div className="text-[11px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                {formatTime(item.repliedAt || item.sentAt || item.updatedAt)}
                                                {item.attempts > 0 && ` · ${item.attempts} attempt${item.attempts > 1 ? 's' : ''}`}
                                            </div>
                                            {overrideLabel && (
                                                <div className="text-[10px] mt-0.5 font-medium" style={{ color: 'hsl(0,72%,55%)' }}>
                                                    {overrideLabel}
                                                </div>
                                            )}
                                        </div>
                                        <span className="text-[11px] font-bold px-2 py-1 rounded-full"
                                            style={{ background: `${qm.color}1A`, color: qm.color }}>
                                            {qm.label}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>

                        {/* Pagination */}
                        <div className="flex items-center justify-between mt-4 pt-3" style={{ borderTop: '1px solid hsl(var(--border))' }}>
                            <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                {queueMeta.total > 0 ? `Page ${queueMeta.page} of ${queueMeta.totalPages} (${queueMeta.total} total)` : ''}
                            </span>
                            {queueMeta.totalPages > 1 && (
                                <div className="flex gap-1">
                                    <button onClick={() => handlePageChange(queuePage - 1)} disabled={queuePage <= 1}
                                        className="px-2.5 py-1 rounded-lg text-[11px] font-medium glass-inner disabled:opacity-40"
                                        style={{ color: 'hsl(var(--foreground))' }}>← Prev</button>
                                    <button onClick={() => handlePageChange(queuePage + 1)} disabled={queuePage >= queueMeta.totalPages}
                                        className="px-2.5 py-1 rounded-lg text-[11px] font-medium glass-inner disabled:opacity-40"
                                        style={{ color: 'hsl(var(--foreground))' }}>Next →</button>
                                </div>
                            )}
                        </div>
                        </>
                    )}
                </div>
                </>
                )}

                {/* Unified gateway tab */}
                {activeTab === 'seller' && (
                    <SellerNotificationTab />
                )}
            </div>

            {/* QR Modal */}
            {showQrModal && createPortal(
                <AnimatePresence>
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4"
                        onClick={closeQrModal}>
                        <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
                            onClick={(e) => e.stopPropagation()}
                            className="glass-panel-strong rounded-3xl p-6 max-w-md w-full">
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="text-lg font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>
                                    Link WhatsApp
                                </h3>
                                <button onClick={closeQrModal}
                                    className="p-1.5 rounded-lg glass-inner"><X size={16} /></button>
                            </div>

                            <ol className="text-xs mb-4 space-y-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                <li>1. Open <strong>WhatsApp</strong> on your phone</li>
                                <li>2. Tap <strong>Settings</strong> → <strong>Linked Devices</strong></li>
                                <li>3. Tap <strong>Link a Device</strong></li>
                                <li>4. {pairingCode ? 'Enter the pairing code below' : 'Scan the QR code below'}</li>
                            </ol>

                            <div className="aspect-square rounded-2xl glass-inner flex items-center justify-center overflow-hidden p-4">
                                {qrLoading && !qrBase64 && !pairingCode ? (
                                    <div className="text-center">
                                        <Loader2 size={32} className="animate-spin mx-auto mb-2" style={{ color: 'hsl(150,70%,40%)' }} />
                                        <div className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            Starting WhatsApp connection...
                                        </div>
                                    </div>
                                ) : qrError ? (
                                    <div className="text-center text-xs px-4" style={{ color: 'hsl(0,72%,55%)' }}>
                                        {qrError}
                                    </div>
                                ) : pairingCode ? (
                                    <div className="text-center w-full">
                                        <div className="mb-3">
                                            <div className="text-xs uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                Pairing Code
                                            </div>
                                            <div className="text-4xl font-extrabold tracking-[0.3em] py-4 px-6 rounded-xl glass-panel-strong" 
                                                style={{ color: 'hsl(150,70%,40%)', fontFamily: 'monospace' }}>
                                                {pairingCode}
                                            </div>
                                        </div>
                                        <div className="text-[10px] leading-relaxed px-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            Enter this code in WhatsApp when prompted. The code expires in a few minutes.
                                        </div>
                                        {qrBase64 && (
                                            <div className="mt-4 pt-4 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
                                                <div className="text-[10px] mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                    Or scan QR code:
                                                </div>
                                                <img src={qrBase64} alt="WhatsApp QR" className="w-48 h-48 mx-auto object-contain" />
                                            </div>
                                        )}
                                    </div>
                                ) : qrBase64 ? (
                                    <img src={qrBase64} alt="WhatsApp QR" className="w-full h-full object-contain" />
                                ) : status?.status === 'connected' ? (
                                    <div className="text-center" style={{ color: 'hsl(150,70%,40%)' }}>
                                        <CheckCircle2 size={48} className="mx-auto mb-2" />
                                        <div className="text-sm font-bold">Connected!</div>
                                    </div>
                                ) : (
                                    <div className="text-center px-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        <div className="text-xs">{qrHint || 'Waiting for QR or pairing code...'}</div>
                                        {qrDiagnostic && (
                                            <div className="mt-3 text-[10px] leading-relaxed" style={{ color: 'hsl(var(--foreground))' }}>
                                                {qrDiagnostic}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                            <button onClick={requestQr} disabled={qrLoading}
                                className="w-full mt-4 py-2.5 rounded-xl text-sm font-medium glass-inner inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                                style={{ color: 'hsl(var(--foreground))' }}>
                                <RefreshCw size={14} className={qrLoading ? 'animate-spin' : ''} /> Refresh QR
                            </button>

                            {!showPairingInput && !pairingCode && status?.status !== 'connected' && (
                                <button
                                    onClick={() => setShowPairingInput(true)}
                                    className="w-full mt-2 py-2.5 rounded-xl text-sm font-medium glass-inner inline-flex items-center justify-center gap-1.5"
                                    style={{ color: 'hsl(var(--foreground))' }}
                                >
                                    <Phone size={14} /> Get Pairing Code Instead
                                </button>
                            )}

                            {showPairingInput && (
                                <div className="mt-4 p-4 rounded-2xl glass-inner">
                                    <div className="text-xs font-bold mb-2" style={{ color: 'hsl(var(--foreground))' }}>
                                        Request Pairing Code
                                    </div>
                                    <div className="text-[10px] mb-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        Pick your country, then enter your WhatsApp number.
                                    </div>
                                    <PhoneField
                                        value={phoneNumber}
                                        onChange={(v) => setPhoneNumber(v || '')}
                                        placeholder="Phone number"
                                    />
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => setShowPairingInput(false)}
                                            className="flex-1 py-2 rounded-lg text-xs font-medium glass-inner"
                                            style={{ color: 'hsl(var(--foreground))' }}
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={requestPairingCode}
                                            disabled={pairingLoading || !phoneNumber}
                                            className="flex-1 py-2 rounded-lg text-xs font-bold text-white inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                                            style={{ background: 'linear-gradient(135deg, hsl(150, 70%, 40%), hsl(170, 70%, 38%))' }}
                                        >
                                            {pairingLoading ? <Loader2 size={12} className="animate-spin" /> : <Phone size={12} />}
                                            {pairingLoading ? 'Requesting...' : 'Get Code'}
                                        </button>
                                    </div>
                                </div>
                            )}

                            <p className="text-[10px] text-center mt-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                QR refreshes automatically every 25s. Keep this window open until you see "Connected".
                            </p>

                            {!qrBase64 && !pairingCode && !qrLoading && status?.status !== 'connected' && (
                                <div className="mt-4 p-4 rounded-2xl text-xs" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', color: 'hsl(var(--foreground))' }}>
                                    <div className="font-bold mb-2">QR Code Not Generating?</div>
                                    <div className="text-[10px] leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        This usually means the Evolution API gateway on your Oracle Cloud VM cannot reach WhatsApp servers. Check:
                                        <ul className="list-disc ml-4 mt-1">
                                            <li>Oracle VM container logs (<code>docker compose logs -f evolution-api</code>) for "Connection Failure" or "error in validating connection"</li>
                                            <li>Oracle VCN security list and Ubuntu UFW allow inbound TCP 8080 and outbound to WhatsApp</li>
                                            <li>The VM has a public IP and <code>EVOLUTION_API_URL</code> on Heroku points to it</li>
                                            <li>Try clicking "Reset instance" below to recreate the session</li>
                                        </ul>
                                    </div>
                                </div>
                            )}

                            {isStuckLinking && (
                                <button
                                    onClick={() => { setResetMsg(''); setConfirmReset(true); }}
                                    className="w-full mt-3 py-2.5 rounded-xl text-sm font-bold inline-flex items-center justify-center gap-1.5"
                                    style={{ background: 'rgba(245,158,11,0.14)', color: 'hsl(38,92%,45%)' }}
                                >
                                    <RotateCcw size={14} /> Reset stuck instance
                                </button>
                            )}
                        </motion.div>
                    </motion.div>
                </AnimatePresence>,
                document.body
            )}

            {/* Disconnect confirm */}
            {confirmDisconnect && createPortal(
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4"
                    onClick={() => setConfirmDisconnect(false)}>
                    <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }}
                        onClick={(e) => e.stopPropagation()}
                        className="glass-panel-strong rounded-3xl p-6 max-w-sm w-full">
                        <h3 className="text-lg font-extrabold mb-2" style={{ color: 'hsl(var(--foreground))' }}>
                            Disconnect WhatsApp?
                        </h3>
                        <p className="text-xs mb-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            New orders will stop sending WhatsApp confirmation polls until you re-link.
                        </p>
                        <div className="flex gap-2">
                            <button onClick={() => setConfirmDisconnect(false)}
                                className="flex-1 py-2.5 rounded-xl text-sm font-medium glass-inner"
                                style={{ color: 'hsl(var(--foreground))' }}>Cancel</button>
                            <button onClick={handleDisconnect}
                                className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white"
                                style={{ background: 'hsl(0,72%,55%)' }}>Disconnect</button>
                        </div>
                    </motion.div>
                </motion.div>,
                document.body
            )}

            {/* Reset instance confirm — only ever opened when stuck without a QR */}
            {confirmReset && createPortal(
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4"
                    onClick={() => !resetting && setConfirmReset(false)}>
                    <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }}
                        onClick={(e) => e.stopPropagation()}
                        className="glass-panel-strong rounded-3xl p-6 max-w-sm w-full">
                        <div className="flex items-start gap-3 mb-3">
                            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                                style={{ background: 'rgba(245,158,11,0.14)', color: 'hsl(38,92%,45%)' }}>
                                <RotateCcw size={18} />
                            </div>
                            <div>
                                <h3 className="text-lg font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>
                                    Reset WhatsApp instance?
                                </h3>
                                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    Use this only when the link flow is stuck without a QR.
                                </p>
                            </div>
                        </div>

                        <div className="text-xs mb-4 p-3 rounded-2xl"
                            style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.22)', color: 'hsl(var(--foreground))' }}>
                            This will <strong>log out, delete and recreate</strong> the gateway instance. No customer data is touched, but you'll need to scan a fresh QR. It's blocked while WhatsApp is currently linked.
                        </div>

                        {resetMsg && (
                            <div className="text-xs mb-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                {resetMsg}
                            </div>
                        )}

                        <div className="flex gap-2">
                            <button onClick={() => setConfirmReset(false)}
                                disabled={resetting}
                                className="flex-1 py-2.5 rounded-xl text-sm font-medium glass-inner disabled:opacity-50"
                                style={{ color: 'hsl(var(--foreground))' }}>Cancel</button>
                            <button onClick={handleReset}
                                disabled={resetting}
                                className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
                                style={{ background: 'hsl(38,92%,45%)' }}>
                                {resetting ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                                {resetting ? 'Resetting…' : 'Reset instance'}
                            </button>
                        </div>
                    </motion.div>
                </motion.div>,
                document.body
            )}
        </>
    );
};

/* ─────────────────────────────────────────────────────────────────────────────
   Unified Gateway Tab
   ───────────────────────────────────────────────────────────────────────────── */

const SellerNotificationTab = () => {
    const [sellerStatus, setSellerStatus] = useState(null);
    const [sellerLoading, setSellerLoading] = useState(true);
    const [sellerStats, setSellerStats] = useState(null);
    const [sellerQueue, setSellerQueue] = useState([]);
    const [sellerQueueMeta, setSellerQueueMeta] = useState({ total: 0, page: 1, totalPages: 1 });
    const [sellerQueueFilter, setSellerQueueFilter] = useState('all');
    const [sellerQueuePage, setSellerQueuePage] = useState(1);
    const [showSellerQrModal, setShowSellerQrModal] = useState(false);
    const [sellerQrLoading, setSellerQrLoading] = useState(false);
    const [sellerQrBase64, setSellerQrBase64] = useState('');
    const [sellerQrError, setSellerQrError] = useState('');
    const [sellerQrHint, setSellerQrHint] = useState('');
    const [sellerPairingCode, setSellerPairingCode] = useState('');
    const [sellerPhoneNumber, setSellerPhoneNumber] = useState('');
    const [showSellerPairingInput, setShowSellerPairingInput] = useState(false);
    const [sellerPairingLoading, setSellerPairingLoading] = useState(false);
    const [confirmSellerDisconnect, setConfirmSellerDisconnect] = useState(false);
    const [confirmSellerReset, setConfirmSellerReset] = useState(false);
    const [sellerResetting, setSellerResetting] = useState(false);
    const [sellerResetMsg, setSellerResetMsg] = useState('');
    const sellerPollRef = useRef(null);

    // ─── Admin AI WhatsApp Numbers ────────────────────────────────────
    const [adminNumbers, setAdminNumbers] = useState([]);
    const [adminNumbersLoading, setAdminNumbersLoading] = useState(true);
    const [newAdminNumber, setNewAdminNumber] = useState('');
    const [newAdminLabel, setNewAdminLabel] = useState('');
    const [addingNumber, setAddingNumber] = useState(false);
    const [adminNumberError, setAdminNumberError] = useState('');
    const [adminNumberSuccess, setAdminNumberSuccess] = useState('');

    const fetchAdminNumbers = useCallback(async () => {
        try {
            const { data } = await axios.get(`${API}api/whatsapp/admin-numbers`, { headers: authHeaders() });
            setAdminNumbers(data.data || data.numbers || []);
        } catch { /* ignore */ }
        finally { setAdminNumbersLoading(false); }
    }, []);

    useEffect(() => { fetchAdminNumbers(); }, [fetchAdminNumbers]);

    const handleAddAdminNumber = async () => {
        const digits = newAdminNumber.replace(/\D/g, '');
        if (!digits || digits.length < 10) {
            setAdminNumberError('Enter a valid phone number with country code');
            return;
        }
        setAddingNumber(true);
        setAdminNumberError('');
        setAdminNumberSuccess('');
        try {
            const { data } = await axios.post(`${API}api/whatsapp/admin-numbers`,
                { number: digits, label: newAdminLabel.trim() || undefined },
                { headers: authHeaders() }
            );
            setAdminNumberSuccess(data.msg || 'Number added');
            setNewAdminNumber('');
            setNewAdminLabel('');
            fetchAdminNumbers();
        } catch (err) {
            setAdminNumberError(err.response?.data?.msg || 'Failed to add number');
        } finally { setAddingNumber(false); }
    };

    const handleRemoveAdminNumber = async (numberId) => {
        try {
            await axios.delete(`${API}api/whatsapp/admin-numbers/${numberId}`, { headers: authHeaders() });
            fetchAdminNumbers();
        } catch { /* ignore */ }
    };

    const handleToggleAdminNumber = async (numberId) => {
        try {
            await axios.patch(`${API}api/whatsapp/admin-numbers/${numberId}/toggle`, {}, { headers: authHeaders() });
            fetchAdminNumbers();
        } catch { /* ignore */ }
    };

    const fetchSellerQueue = useCallback(async (filter, page) => {
        try {
            const { data } = await axios.get(`${API}api/whatsapp/seller/queue?filter=${filter}&page=${page}&limit=15`, { headers: authHeaders() });
            setSellerQueue(data.items || []);
            setSellerQueueMeta({ total: data.total || 0, page: data.page || 1, totalPages: data.totalPages || 1 });
        } catch { /* ignore */ }
    }, []);

    const fetchSellerStatus = useCallback(async () => {
        try {
            const [statusRes, statsRes] = await Promise.all([
                axios.get(`${API}api/whatsapp/seller/status`, { headers: authHeaders() }),
                axios.get(`${API}api/whatsapp/seller/stats`, { headers: authHeaders() }).catch(() => ({ data: null })),
            ]);
            setSellerStatus(statusRes.data);
            if (statusRes.data?.qrBase64) {
                setSellerQrBase64(statusRes.data.qrBase64);
                setSellerQrError('');
            }
            if (statusRes.data?.status === 'connected') {
                setSellerQrHint('');
                setSellerPairingCode('');
            }
            if (statsRes.data) setSellerStats(statsRes.data);
        } catch (err) {
            console.error('seller whatsapp fetch error:', err);
        } finally {
            setSellerLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchSellerStatus();
    }, [fetchSellerStatus]);

    useEffect(() => {
        fetchSellerQueue(sellerQueueFilter, sellerQueuePage);
    }, [fetchSellerQueue, sellerQueueFilter, sellerQueuePage]);

    const handleSellerFilterChange = (f) => { setSellerQueueFilter(f); setSellerQueuePage(1); };
    const handleSellerPageChange = (p) => { setSellerQueuePage(p); };

    const requestSellerQr = useCallback(async () => {
        setSellerQrLoading(true);
        setSellerQrError('');
        try {
            const { data } = await axios.post(
                `${API}api/whatsapp/seller/connect`,
                {},
                { headers: authHeaders(), timeout: 25000 }
            );
            setSellerQrBase64(data.qrBase64 || '');
            setSellerPairingCode(data.code || '');
            setSellerQrHint(data.fallback || data.msg ? (data.msg || 'Waiting for QR…') : '');
            if (data.alreadyLinked) {
                setSellerQrError('');
                setSellerQrHint('');
                setSellerPairingCode('');
            }
            await fetchSellerStatus();
        } catch (err) {
            setSellerQrHint('');
            setSellerPairingCode('');
            const offline =
                err.code === 'ECONNABORTED' ||
                err.message === 'Network Error' ||
                err.response?.status === 503 ||
                err.response?.status === 502;
            setSellerQrError(
                err.response?.data?.msg ||
                (offline
                    ? 'WhatsApp gateway is temporarily unavailable. Try again or reset the instance below.'
                    : 'Failed to fetch QR code')
            );
        } finally {
            setSellerQrLoading(false);
        }
    }, [fetchSellerStatus]);

    // Refresh QR every 25s while modal is open and not yet connected
    useEffect(() => {
        if (showSellerQrModal && sellerStatus?.status !== 'connected') {
            const id = setInterval(() => requestSellerQr(), 25000);
            return () => clearInterval(id);
        }
    }, [showSellerQrModal, sellerStatus?.status, requestSellerQr]);

    // Poll status every 5s while QR modal is open, every 30s otherwise
    useEffect(() => {
        if (sellerPollRef.current) clearInterval(sellerPollRef.current);
        const interval = showSellerQrModal ? 5000 : 30000;
        sellerPollRef.current = setInterval(fetchSellerStatus, interval);
        return () => { if (sellerPollRef.current) clearInterval(sellerPollRef.current); };
    }, [showSellerQrModal, fetchSellerStatus]);

    const requestSellerPairingCode = async () => {
        if (!isValidPhone(sellerPhoneNumber)) {
            setSellerQrError('Please enter a valid phone number (pick your country and type the number).');
            return;
        }
        const digitsOnly = String(sellerPhoneNumber).replace(/\D/g, '');
        setSellerPairingLoading(true);
        setSellerQrError('');
        try {
            const { data } = await axios.post(
                `${API}api/whatsapp/seller/pairing-code`,
                { phoneNumber: digitsOnly },
                { headers: authHeaders(), timeout: 15000 }
            );
            if (data.code) {
                setSellerPairingCode(data.code);
                setSellerQrHint('Enter this code in WhatsApp when prompted');
                setShowSellerPairingInput(false);
            } else {
                setSellerQrHint(data.msg || 'Pairing code requested. Check status in a moment.');
            }
            await fetchSellerStatus();
        } catch (err) {
            setSellerQrError(err.response?.data?.msg || 'Failed to request pairing code');
        } finally {
            setSellerPairingLoading(false);
        }
    };

    const openSellerQrModal = async () => {
        setShowSellerQrModal(true);
        setSellerQrBase64(sellerStatus?.qrBase64 || '');
        setSellerQrError('');
        setSellerQrHint(sellerStatus?.status === 'connected' ? '' : 'Starting WhatsApp link session…');
        setSellerPairingCode('');
        await requestSellerQr();
    };

    const closeSellerQrModal = () => {
        setShowSellerQrModal(false);
        // If not connected after closing, reset status to disconnected
        if (sellerStatus?.status !== 'connected') {
            setSellerStatus(prev => ({ ...prev, status: 'disconnected', qrBase64: '' }));
        }
        setTimeout(() => fetchSellerStatus(), 1500);
    };

    const handleSellerDisconnect = async () => {
        try {
            await axios.post(`${API}api/whatsapp/seller/disconnect`, {}, { headers: authHeaders() });
            setConfirmSellerDisconnect(false);
            // Optimistically update status immediately
            setSellerStatus(prev => ({ ...prev, status: 'disconnected', linkedNumber: '', qrBase64: '' }));
            setTimeout(() => fetchSellerStatus(), 2000);
        } catch (err) {
            console.error(err);
        }
    };

    const handleSellerReset = async () => {
        setSellerResetting(true);
        setSellerResetMsg('');
        try {
            const { data } = await axios.post(
                `${API}api/whatsapp/seller/reset`,
                {},
                { headers: authHeaders(), timeout: 30000 }
            );
            setSellerQrBase64('');
            setSellerPairingCode('');
            setSellerQrError('');
            setSellerQrHint('Instance reset. Click "Link Unified WhatsApp" to scan a new QR.');
            setSellerResetMsg(data?.msg || 'Instance reset.');
            setConfirmSellerReset(false);
            setShowSellerQrModal(false);
            await fetchSellerStatus();
        } catch (err) {
            setSellerResetMsg(err.response?.data?.msg || 'Failed to reset WhatsApp instance.');
        } finally {
            setSellerResetting(false);
        }
    };

    const isSellerStuckLinking =
        ['pending_qr', 'connecting', 'error'].includes(sellerStatus?.status) &&
        !sellerQrBase64 &&
        !sellerPairingCode &&
        !sellerQrLoading &&
        sellerStatus?.status !== 'connected';

    // Auto-close QR modal on connected
    useEffect(() => {
        if (showSellerQrModal && sellerStatus?.status === 'connected') {
            setTimeout(() => setShowSellerQrModal(false), 1200);
        }
    }, [sellerStatus?.status, showSellerQrModal]);

    const meta = STATUS_META[sellerStatus?.status] || STATUS_META.disconnected;

    return (
        <>
            {/* Status card */}
            <div className="glass-panel-strong rounded-3xl p-6 mb-6">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="flex items-center gap-4">
                        <span className="px-3 py-1.5 rounded-full text-xs font-bold inline-flex items-center gap-1.5"
                            style={{ background: meta.bg, color: meta.color }}>
                            <Activity size={12} /> {meta.label}
                        </span>
                        {sellerStatus?.linkedNumber && (
                            <span className="text-sm font-medium inline-flex items-center gap-1.5"
                                style={{ color: 'hsl(var(--foreground))' }}>
                                <Phone size={14} /> {sellerStatus.linkedNumber}
                            </span>
                        )}
                        {sellerStatus?.lastSeen && (
                            <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Last seen {formatTime(sellerStatus.lastSeen)}
                            </span>
                        )}
                    </div>
                    <div className="flex gap-2">
                        <button onClick={fetchSellerStatus} disabled={sellerLoading}
                            className="px-3 py-2 rounded-xl text-sm font-medium glass-inner inline-flex items-center gap-1.5 disabled:opacity-50"
                            style={{ color: 'hsl(var(--foreground))' }}>
                            <RefreshCw size={14} className={sellerLoading ? 'animate-spin' : ''} /> Refresh
                        </button>
                        {isSellerStuckLinking && (
                            <button onClick={() => { setSellerResetMsg(''); setConfirmSellerReset(true); }}
                                className="px-3 py-2 rounded-xl text-sm font-bold inline-flex items-center gap-1.5"
                                style={{ background: 'rgba(245,158,11,0.14)', color: 'hsl(38,92%,45%)' }}
                                title="Reset the WhatsApp instance — only when stuck waiting for QR">
                                <RotateCcw size={14} /> Reset instance
                            </button>
                        )}
                        {sellerStatus?.status === 'connected' ? (
                            <button onClick={() => setConfirmSellerDisconnect(true)}
                                className="px-3 py-2 rounded-xl text-sm font-bold inline-flex items-center gap-1.5"
                                style={{ background: 'rgba(239,68,68,0.12)', color: 'hsl(0,72%,55%)' }}>
                                <Power size={14} /> Disconnect
                            </button>
                        ) : (
                            <button onClick={openSellerQrModal}
                                className="px-4 py-2 rounded-xl text-sm font-bold text-white inline-flex items-center gap-1.5"
                                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(240, 60%, 50%))' }}>
                                <QrCode size={14} /> Link Unified WhatsApp
                            </button>
                        )}
                    </div>
                </div>

                {sellerStatus?.lastError && (
                    <div className="mt-4 p-4 rounded-2xl text-xs"
                        style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: 'hsl(0,72%,55%)' }}>
                        <strong>Last error:</strong> {sellerStatus.lastError}
                    </div>
                )}

                {sellerResetMsg && !confirmSellerReset && (
                    <div className="mt-4 p-4 rounded-2xl text-xs"
                        style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', color: 'hsl(var(--foreground))' }}>
                        {sellerResetMsg}
                    </div>
                )}
            </div>

            {/* Disclaimer */}
            <div className="glass-panel rounded-3xl p-5 mb-6 flex items-start gap-3">
                <ShieldAlert size={20} style={{ color: 'hsl(220, 70%, 55%)' }} className="shrink-0 mt-0.5" />
                <div className="text-xs leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    <strong style={{ color: 'hsl(var(--foreground))' }}>Unified WhatsApp number:</strong> This one connected instance sends buyer order confirmations, buyer OTPs, seller notifications, and admin/seller/buyer AI replies.
                </div>
            </div>

            {/* Seller Analytics */}
            {sellerStats && (
                <div className="mb-6">
                    <h2 className="text-sm font-bold uppercase tracking-wider inline-flex items-center gap-2 mb-3 px-1"
                        style={{ color: 'hsl(var(--muted-foreground))' }}>
                        <BarChart3 size={14} /> Analytics
                    </h2>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                        <StatCard icon={Send} label="Sent" value={sellerStats.sent} sub={`${sellerStats.last24h} in last 24h`} color="hsl(220,70%,55%)" />
                        <StatCard icon={AlertTriangle} label="Failed" value={sellerStats.failed} color="hsl(0,72%,55%)" />
                        <StatCard icon={Clock} label="Skipped" value={sellerStats.skipped} sub="Prefs/cap/unverified" color="hsl(0,0%,55%)" />
                        <StatCard icon={TrendingUp} label="Delivery Rate" value={`${sellerStats.deliveryRate}%`} sub={`${sellerStats.last7d} this week`} color="hsl(150,70%,40%)" />
                    </div>

                    {sellerStats.timeline && sellerStats.timeline.length > 0 && (
                        <div className="glass-panel-strong rounded-3xl p-5">
                            <div className="flex items-center justify-between mb-3">
                                <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: 'hsl(var(--muted-foreground))' }}>Last 7 Days</h3>
                                <div className="flex gap-3 text-[10px]">
                                    <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: 'hsl(220,70%,55%)' }} />Sent</span>
                                    <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: 'hsl(0,72%,55%)' }} />Failed</span>
                                    <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: 'hsl(0,0%,55%)' }} />Skipped</span>
                                </div>
                            </div>
                            <SellerTimeline data={sellerStats.timeline} />
                        </div>
                    )}
                </div>
            )}

            {/* Seller Recent Activity */}
            <div className="glass-panel-strong rounded-3xl p-6 mb-6">
                <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                    <h2 className="text-sm font-bold uppercase tracking-wider inline-flex items-center gap-2"
                        style={{ color: 'hsl(var(--muted-foreground))' }}>
                        <Inbox size={14} /> Recent Activity
                    </h2>
                    <div className="flex gap-1 flex-wrap">
                        {[
                            { key: 'all', label: 'All' },
                            { key: 'sent', label: 'Sent' },
                            { key: 'failed', label: 'Failed' },
                            { key: 'skipped', label: 'Skipped' },
                        ].map(f => (
                            <button key={f.key} onClick={() => handleSellerFilterChange(f.key)}
                                className="px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all"
                                style={sellerQueueFilter === f.key
                                    ? { background: 'hsl(220,70%,55%)', color: '#fff' }
                                    : { background: 'transparent', color: 'hsl(var(--muted-foreground))' }}>
                                {f.label}
                            </button>
                        ))}
                    </div>
                </div>

                {sellerQueue.length === 0 ? (
                    <div className="text-center py-12 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        {sellerQueueFilter === 'all'
                            ? 'No notifications sent yet. Seller notifications will appear here once the instance is connected and sellers are verified.'
                            : `No ${sellerQueueFilter} notifications found.`}
                    </div>
                ) : (
                    <>
                    <div className="space-y-2">
                        {sellerQueue.map(item => {
                            const statusMeta = {
                                sent: { label: 'Sent', color: 'hsl(220,70%,55%)', icon: CheckCircle2 },
                                failed: { label: 'Failed', color: 'hsl(0,72%,55%)', icon: AlertTriangle },
                                skipped: { label: 'Skipped', color: 'hsl(0,0%,55%)', icon: Clock },
                            };
                            const sm = statusMeta[item.status] || statusMeta.skipped;
                            const Icon = sm.icon;
                            return (
                                <div key={item._id} className="glass-inner rounded-2xl p-3 flex items-center gap-3">
                                    <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                                        style={{ background: `${sm.color}1A`, color: sm.color }}>
                                        <Icon size={16} />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>
                                                {item.category?.replace(/_/g, ' ')}
                                            </span>
                                            <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                {item.sellerName || item.phone || '—'}
                                            </span>
                                        </div>
                                        <div className="text-[11px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            {formatTime(item.createdAt)}
                                            {item.reason && ` · ${item.reason}`}
                                        </div>
                                    </div>
                                    <span className="text-[11px] font-bold px-2 py-1 rounded-full"
                                        style={{ background: `${sm.color}1A`, color: sm.color }}>
                                        {sm.label}
                                    </span>
                                </div>
                            );
                        })}
                    </div>

                    {sellerQueueMeta.totalPages > 1 && (
                        <div className="flex items-center justify-between mt-4 pt-3" style={{ borderTop: '1px solid hsl(var(--border))' }}>
                            <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Page {sellerQueueMeta.page} of {sellerQueueMeta.totalPages} ({sellerQueueMeta.total} total)
                            </span>
                            <div className="flex gap-1">
                                <button onClick={() => handleSellerPageChange(sellerQueuePage - 1)} disabled={sellerQueuePage <= 1}
                                    className="px-2.5 py-1 rounded-lg text-[11px] font-medium glass-inner disabled:opacity-40"
                                    style={{ color: 'hsl(var(--foreground))' }}>← Prev</button>
                                <button onClick={() => handleSellerPageChange(sellerQueuePage + 1)} disabled={sellerQueuePage >= sellerQueueMeta.totalPages}
                                    className="px-2.5 py-1 rounded-lg text-[11px] font-medium glass-inner disabled:opacity-40"
                                    style={{ color: 'hsl(var(--foreground))' }}>Next →</button>
                            </div>
                        </div>
                    )}
                    </>
                )}
            </div>

            {/* ─── Admin AI WhatsApp Numbers ──────────────────────────────── */}
            <div className="glass-panel-strong rounded-3xl p-6 mb-6">
                <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                        style={{ background: 'rgba(168,85,247,0.14)', color: 'hsl(270,60%,55%)' }}>
                        <ShieldAlert size={18} />
                    </div>
                    <div>
                        <h2 className="text-base font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>
                            Admin AI WhatsApp Numbers
                        </h2>
                        <p className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            Phone numbers that can chat with AI as <strong>admin</strong> on this seller instance. Everyone else is treated as a seller.
                        </p>
                    </div>
                </div>

                {/* Add number form */}
                <div className="glass-inner rounded-2xl p-4 mb-4">
                    <div className="flex flex-col sm:flex-row gap-2">
                        <div className="flex-1">
                            <PhoneField
                                value={newAdminNumber}
                                onChange={(v) => { setNewAdminNumber(v || ''); setAdminNumberError(''); setAdminNumberSuccess(''); }}
                                placeholder="Admin phone number"
                            />
                        </div>
                        <input
                            type="text"
                            placeholder="Label (optional)"
                            value={newAdminLabel}
                            onChange={(e) => setNewAdminLabel(e.target.value)}
                            className="px-3 py-2 rounded-xl text-sm glass-inner sm:w-40"
                            style={{ color: 'hsl(var(--foreground))', background: 'transparent', border: '1px solid hsl(var(--border))' }}
                        />
                        <button
                            onClick={handleAddAdminNumber}
                            disabled={addingNumber || !newAdminNumber}
                            className="px-4 py-2 rounded-xl text-sm font-bold text-white inline-flex items-center justify-center gap-1.5 disabled:opacity-50 shrink-0"
                            style={{ background: 'linear-gradient(135deg, hsl(270,60%,55%), hsl(290,50%,50%))' }}>
                            {addingNumber ? <Loader2 size={14} className="animate-spin" /> : <Phone size={14} />}
                            Add Number
                        </button>
                    </div>
                    {adminNumberError && (
                        <div className="mt-2 text-xs font-medium" style={{ color: 'hsl(0,72%,55%)' }}>{adminNumberError}</div>
                    )}
                    {adminNumberSuccess && (
                        <div className="mt-2 text-xs font-medium" style={{ color: 'hsl(150,70%,40%)' }}>{adminNumberSuccess}</div>
                    )}
                </div>

                {/* Numbers list */}
                {adminNumbersLoading ? (
                    <div className="text-center py-8">
                        <Loader2 size={24} className="animate-spin mx-auto" style={{ color: 'hsl(var(--muted-foreground))' }} />
                    </div>
                ) : adminNumbers.length === 0 ? (
                    <div className="text-center py-8 text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        No admin numbers added yet. Add a phone number above to enable admin AI chat on WhatsApp.
                    </div>
                ) : (
                    <div className="space-y-2">
                        {adminNumbers.map(num => (
                            <div key={num._id} className="glass-inner rounded-2xl p-3 flex items-center gap-3">
                                <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                                    style={{
                                        background: num.isActive ? 'rgba(168,85,247,0.14)' : 'rgba(120,120,120,0.12)',
                                        color: num.isActive ? 'hsl(270,60%,55%)' : 'hsl(0,0%,55%)',
                                    }}>
                                    <Phone size={16} />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>
                                            +{num.number}
                                        </span>
                                        {num.label && (
                                            <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(168,85,247,0.1)', color: 'hsl(270,60%,55%)' }}>
                                                {num.label}
                                            </span>
                                        )}
                                        <span className="text-[10px] px-2 py-0.5 rounded-full font-bold"
                                            style={{
                                                background: num.isActive ? 'rgba(34,197,94,0.12)' : 'rgba(120,120,120,0.12)',
                                                color: num.isActive ? 'hsl(150,70%,40%)' : 'hsl(0,0%,55%)',
                                            }}>
                                            {num.isActive ? 'Active' : 'Inactive'}
                                        </span>
                                    </div>
                                    <div className="text-[10px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        Added {formatTime(num.createdAt)}
                                    </div>
                                </div>
                                <div className="flex gap-1.5">
                                    <button
                                        onClick={() => handleToggleAdminNumber(num._id)}
                                        className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium glass-inner"
                                        style={{ color: 'hsl(var(--foreground))' }}
                                        title={num.isActive ? 'Deactivate' : 'Activate'}>
                                        <Power size={13} />
                                    </button>
                                    <button
                                        onClick={() => handleRemoveAdminNumber(num._id)}
                                        className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium"
                                        style={{ background: 'rgba(239,68,68,0.1)', color: 'hsl(0,72%,55%)' }}
                                        title="Remove number">
                                        <X size={13} />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Seller QR Modal */}
            {showSellerQrModal && createPortal(
                <AnimatePresence>
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4"
                        onClick={closeSellerQrModal}>
                        <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
                            onClick={(e) => e.stopPropagation()}
                            className="glass-panel-strong rounded-3xl p-6 max-w-md w-full">
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="text-lg font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>
                                    Link Unified WhatsApp
                                </h3>
                                <button onClick={closeSellerQrModal}
                                    className="p-1.5 rounded-lg glass-inner"><X size={16} /></button>
                            </div>

                            <ol className="text-xs mb-4 space-y-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                <li>1. Open <strong>WhatsApp</strong> on the unified gateway phone</li>
                                <li>2. Tap <strong>Settings</strong> → <strong>Linked Devices</strong></li>
                                <li>3. Tap <strong>Link a Device</strong></li>
                                <li>4. {sellerPairingCode ? 'Enter the pairing code below' : 'Scan the QR code below'}</li>
                            </ol>

                            <div className="aspect-square rounded-2xl glass-inner flex items-center justify-center overflow-hidden p-4">
                                {sellerQrLoading && !sellerQrBase64 && !sellerPairingCode ? (
                                    <div className="text-center">
                                        <Loader2 size={32} className="animate-spin mx-auto mb-2" style={{ color: 'hsl(220,70%,55%)' }} />
                                        <div className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            Starting WhatsApp connection...
                                        </div>
                                    </div>
                                ) : sellerQrError ? (
                                    <div className="text-center text-xs px-4" style={{ color: 'hsl(0,72%,55%)' }}>
                                        {sellerQrError}
                                    </div>
                                ) : sellerPairingCode ? (
                                    <div className="text-center w-full">
                                        <div className="mb-3">
                                            <div className="text-xs uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                Pairing Code
                                            </div>
                                            <div className="text-4xl font-extrabold tracking-[0.3em] py-4 px-6 rounded-xl glass-panel-strong"
                                                style={{ color: 'hsl(220,70%,55%)', fontFamily: 'monospace' }}>
                                                {sellerPairingCode}
                                            </div>
                                        </div>
                                        <div className="text-[10px] leading-relaxed px-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            Enter this code in WhatsApp when prompted. The code expires in a few minutes.
                                        </div>
                                        {sellerQrBase64 && (
                                            <div className="mt-4 pt-4 border-t" style={{ borderColor: 'hsl(var(--border))' }}>
                                                <div className="text-[10px] mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                    Or scan QR code:
                                                </div>
                                                <img src={sellerQrBase64} alt="WhatsApp QR" className="w-48 h-48 mx-auto object-contain" />
                                            </div>
                                        )}
                                    </div>
                                ) : sellerQrBase64 ? (
                                    <img src={sellerQrBase64} alt="WhatsApp QR" className="w-full h-full object-contain" />
                                ) : sellerStatus?.status === 'connected' ? (
                                    <div className="text-center" style={{ color: 'hsl(220,70%,55%)' }}>
                                        <CheckCircle2 size={48} className="mx-auto mb-2" />
                                        <div className="text-sm font-bold">Connected!</div>
                                    </div>
                                ) : (
                                    <div className="text-center px-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        <div className="text-xs">{sellerQrHint || 'Waiting for QR or pairing code...'}</div>
                                    </div>
                                )}
                            </div>

                            <button onClick={requestSellerQr} disabled={sellerQrLoading}
                                className="w-full mt-4 py-2.5 rounded-xl text-sm font-medium glass-inner inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                                style={{ color: 'hsl(var(--foreground))' }}>
                                <RefreshCw size={14} className={sellerQrLoading ? 'animate-spin' : ''} /> Refresh QR
                            </button>

                            {!showSellerPairingInput && !sellerPairingCode && sellerStatus?.status !== 'connected' && (
                                <button
                                    onClick={() => setShowSellerPairingInput(true)}
                                    className="w-full mt-2 py-2.5 rounded-xl text-sm font-medium glass-inner inline-flex items-center justify-center gap-1.5"
                                    style={{ color: 'hsl(var(--foreground))' }}
                                >
                                    <Phone size={14} /> Get Pairing Code Instead
                                </button>
                            )}

                            {showSellerPairingInput && (
                                <div className="mt-4 p-4 rounded-2xl glass-inner">
                                    <div className="text-xs font-bold mb-2" style={{ color: 'hsl(var(--foreground))' }}>
                                        Request Pairing Code
                                    </div>
                                    <div className="text-[10px] mb-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        Pick your country, then enter your WhatsApp number.
                                    </div>
                                    <PhoneField
                                        value={sellerPhoneNumber}
                                        onChange={(v) => setSellerPhoneNumber(v || '')}
                                        placeholder="Phone number"
                                    />
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => setShowSellerPairingInput(false)}
                                            className="flex-1 py-2 rounded-lg text-xs font-medium glass-inner"
                                            style={{ color: 'hsl(var(--foreground))' }}
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={requestSellerPairingCode}
                                            disabled={sellerPairingLoading || !sellerPhoneNumber}
                                            className="flex-1 py-2 rounded-lg text-xs font-bold text-white inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                                            style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(240, 60%, 50%))' }}
                                        >
                                            {sellerPairingLoading ? <Loader2 size={12} className="animate-spin" /> : <Phone size={12} />}
                                            {sellerPairingLoading ? 'Requesting...' : 'Get Code'}
                                        </button>
                                    </div>
                                </div>
                            )}

                            <p className="text-[10px] text-center mt-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                QR refreshes automatically every 25s. Keep this window open until you see "Connected".
                            </p>

                            {isSellerStuckLinking && (
                                <button
                                    onClick={() => { setSellerResetMsg(''); setConfirmSellerReset(true); }}
                                    className="w-full mt-3 py-2.5 rounded-xl text-sm font-bold inline-flex items-center justify-center gap-1.5"
                                    style={{ background: 'rgba(245,158,11,0.14)', color: 'hsl(38,92%,45%)' }}
                                >
                                    <RotateCcw size={14} /> Reset stuck instance
                                </button>
                            )}
                        </motion.div>
                    </motion.div>
                </AnimatePresence>,
                document.body
            )}

            {/* Seller Disconnect confirm */}
            {confirmSellerDisconnect && createPortal(
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4"
                    onClick={() => setConfirmSellerDisconnect(false)}>
                    <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }}
                        onClick={(e) => e.stopPropagation()}
                        className="glass-panel-strong rounded-3xl p-6 max-w-sm w-full">
                        <h3 className="text-lg font-extrabold mb-2" style={{ color: 'hsl(var(--foreground))' }}>
                            Disconnect Unified WhatsApp?
                        </h3>
                        <p className="text-xs mb-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            Buyer messages, seller notifications, and WhatsApp AI replies will stop until you re-link this number.
                        </p>
                        <div className="flex gap-2">
                            <button onClick={() => setConfirmSellerDisconnect(false)}
                                className="flex-1 py-2.5 rounded-xl text-sm font-medium glass-inner"
                                style={{ color: 'hsl(var(--foreground))' }}>Cancel</button>
                            <button onClick={handleSellerDisconnect}
                                className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white"
                                style={{ background: 'hsl(0,72%,55%)' }}>Disconnect</button>
                        </div>
                    </motion.div>
                </motion.div>,
                document.body
            )}

            {/* Seller Reset instance confirm */}
            {confirmSellerReset && createPortal(
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4"
                    onClick={() => !sellerResetting && setConfirmSellerReset(false)}>
                    <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }}
                        onClick={(e) => e.stopPropagation()}
                        className="glass-panel-strong rounded-3xl p-6 max-w-sm w-full">
                        <div className="flex items-start gap-3 mb-3">
                            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                                style={{ background: 'rgba(245,158,11,0.14)', color: 'hsl(38,92%,45%)' }}>
                                <RotateCcw size={18} />
                            </div>
                            <div>
                                <h3 className="text-lg font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>
                                    Reset Unified WhatsApp instance?
                                </h3>
                                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    Use this only when the link flow is stuck without a QR.
                                </p>
                            </div>
                        </div>

                        <div className="text-xs mb-4 p-3 rounded-2xl"
                            style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.22)', color: 'hsl(var(--foreground))' }}>
                            This will <strong>log out, delete and recreate</strong> the seller gateway instance. You'll need to scan a fresh QR afterwards.
                        </div>

                        {sellerResetMsg && (
                            <div className="text-xs mb-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                {sellerResetMsg}
                            </div>
                        )}

                        <div className="flex gap-2">
                            <button onClick={() => setConfirmSellerReset(false)}
                                disabled={sellerResetting}
                                className="flex-1 py-2.5 rounded-xl text-sm font-medium glass-inner disabled:opacity-50"
                                style={{ color: 'hsl(var(--foreground))' }}>Cancel</button>
                            <button onClick={handleSellerReset}
                                disabled={sellerResetting}
                                className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
                                style={{ background: 'hsl(38,92%,45%)' }}>
                                {sellerResetting ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                                {sellerResetting ? 'Resetting…' : 'Reset instance'}
                            </button>
                        </div>
                    </motion.div>
                </motion.div>,
                document.body
            )}
        </>
    );
};

export default WhatsAppVerificationPanel;
