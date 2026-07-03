import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import axios from 'axios';
import { toast } from 'react-toastify';
import {
    AlertTriangle,
    CheckCircle,
    Clock,
    Loader2,
    Megaphone,
    RefreshCw,
    Store,
    XCircle,
} from 'lucide-react';
import Loader from '../../common/Loader';
import { getAuthToken } from '../../../utils/cookieHelper';

const API = `${import.meta.env.VITE_API_URL}api/ads`;

const statusStyles = {
    pending: { color: 'hsl(30,90%,50%)', bg: 'rgba(249,115,22,0.12)' },
    approved: { color: 'hsl(150,60%,40%)', bg: 'rgba(16,185,129,0.12)' },
    rejected: { color: 'hsl(0,72%,55%)', bg: 'rgba(239,68,68,0.12)' },
};

const requestLabels = {
    start: 'Start campaign',
    update: 'Change products',
    stop: 'Stop campaign',
};

function productImage(product) {
    return product?.image || product?.images?.[0]?.url || '';
}

function StatusPill({ status, active }) {
    const style = statusStyles[status] || statusStyles.pending;
    return (
        <span
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold capitalize"
            style={{ color: style.color, background: style.bg }}
        >
            {active ? <Megaphone size={11} /> : status === 'pending' ? <Clock size={11} /> : status === 'approved' ? <CheckCircle size={11} /> : <XCircle size={11} />}
            {active ? 'Active' : status}
        </span>
    );
}

const StatCard = ({ label, value, icon, color, bg }) => (
    <div className="glass-card water-shimmer p-4 min-w-0">
        <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'hsl(var(--muted-foreground))' }}>{label}</p>
                <p className="text-2xl font-extrabold mt-2" style={{ color: 'hsl(var(--foreground))' }}>{value}</p>
            </div>
            <div className="p-3 rounded-2xl shrink-0" style={{ color, background: bg }}>
                {icon}
            </div>
        </div>
    </div>
);

const AdminAdsPanel = () => {
    const [loading, setLoading] = useState(true);
    const [savingId, setSavingId] = useState('');
    const [data, setData] = useState({ requests: [], stats: {} });
    const [notes, setNotes] = useState({});

    const fetchRequests = async () => {
        setLoading(true);
        try {
            const token = getAuthToken();
            const res = await axios.get(`${API}/admin/requests`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            setData(res.data);
            const nextNotes = {};
            (res.data.requests || []).forEach((request) => {
                nextNotes[request._id] = request.adminNote || '';
            });
            setNotes(nextNotes);
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Failed to load ads requests.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchRequests();
    }, []);

    const groupedRequests = useMemo(() => {
        const requests = data.requests || [];
        return [
            ...requests.filter((request) => request.status === 'pending'),
            ...requests.filter((request) => request.status !== 'pending'),
        ];
    }, [data.requests]);

    const reviewRequest = async (id, status) => {
        setSavingId(`${id}:${status}`);
        try {
            const token = getAuthToken();
            await axios.patch(`${API}/admin/requests/${id}/review`, {
                status,
                adminNote: notes[id] || '',
            }, {
                headers: { Authorization: `Bearer ${token}` },
            });
            toast.success(`Ads request ${status}.`);
            await fetchRequests();
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Failed to review ads request.');
        } finally {
            setSavingId('');
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <Loader size="default" text="Loading ads requests..." />
            </div>
        );
    }

    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
            <div className="glass-panel-strong p-5 sm:p-6">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                    <div className="flex items-start gap-3">
                        <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0"
                            style={{ background: 'linear-gradient(135deg, hsl(220,70%,55%), hsl(270,60%,55%))', color: 'white' }}>
                            <Megaphone size={22} />
                        </div>
                        <div>
                            <h1 className="text-xl font-bold" style={{ color: 'hsl(var(--foreground))' }}>Seller Ads Requests</h1>
                            <p className="text-sm mt-1 max-w-2xl" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Review seller requests for Rozare-run TikTok and optional Meta ad campaigns.
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={fetchRequests}
                        className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold glass-inner"
                        style={{ color: 'hsl(var(--foreground))' }}
                    >
                        <RefreshCw size={15} /> Refresh
                    </button>
                </div>
            </div>

            <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
                <StatCard label="Pending" value={data.stats?.pending || 0} icon={<Clock size={20} />} color="hsl(30,90%,50%)" bg="rgba(249,115,22,0.12)" />
                <StatCard label="Active" value={data.stats?.active || 0} icon={<Megaphone size={20} />} color="hsl(220,70%,55%)" bg="rgba(99,102,241,0.12)" />
                <StatCard label="Approved" value={data.stats?.approved || 0} icon={<CheckCircle size={20} />} color="hsl(150,60%,40%)" bg="rgba(16,185,129,0.12)" />
                <StatCard label="Rejected" value={data.stats?.rejected || 0} icon={<AlertTriangle size={20} />} color="hsl(0,72%,55%)" bg="rgba(239,68,68,0.12)" />
            </div>

            <div className="glass-panel-strong p-4 sm:p-5">
                {groupedRequests.length === 0 ? (
                    <div className="py-12 text-center">
                        <Megaphone size={28} className="mx-auto mb-2" style={{ color: 'hsl(var(--muted-foreground))' }} />
                        <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>No ads requests yet</p>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {groupedRequests.map((request) => (
                            <div key={request._id} className="rounded-2xl p-4 glass-card">
                                <div className="flex flex-col xl:flex-row xl:items-start justify-between gap-4">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2 mb-2">
                                            <StatusPill status={request.status} active={request.active} />
                                            <span className="text-xs font-bold px-2.5 py-1 rounded-full" style={{ color: 'hsl(220,70%,55%)', background: 'rgba(99,102,241,0.12)' }}>
                                                {requestLabels[request.requestType] || 'Ads request'}
                                            </span>
                                            <span className="text-xs font-bold px-2.5 py-1 rounded-full" style={{ color: 'hsl(150,60%,40%)', background: 'rgba(16,185,129,0.12)' }}>
                                                TikTok{request.channels?.meta ? ' + Meta' : ''}
                                            </span>
                                        </div>
                                        <div className="flex items-start gap-3">
                                            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 glass-inner" style={{ color: 'hsl(220,70%,55%)' }}>
                                                <Store size={18} />
                                            </div>
                                            <div className="min-w-0">
                                                <p className="text-base font-bold" style={{ color: 'hsl(var(--foreground))' }}>
                                                    {request.store?.storeName || 'Store'}
                                                </p>
                                                <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                    {request.seller?.username || 'Seller'} · {request.seller?.email || 'No email'} · {new Date(request.createdAt).toLocaleString()}
                                                </p>
                                                {request.sellerNote && (
                                                    <p className="text-xs mt-2 rounded-xl p-2" style={{ color: 'hsl(var(--foreground))', background: 'rgba(255,255,255,0.1)' }}>
                                                        Seller note: {request.sellerNote}
                                                    </p>
                                                )}
                                            </div>
                                        </div>

                                        {request.requestType !== 'stop' && (
                                            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2 mt-4">
                                                {(request.products || []).map((product) => (
                                                    <div key={product._id} className="flex items-center gap-2 rounded-xl p-2 glass-inner min-w-0">
                                                        <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0">
                                                            {productImage(product) ? (
                                                                <img src={productImage(product)} alt={product.name} className="w-full h-full object-cover" />
                                                            ) : (
                                                                <div className="w-full h-full flex items-center justify-center text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>No img</div>
                                                            )}
                                                        </div>
                                                        <div className="min-w-0">
                                                            <p className="text-xs font-bold truncate" style={{ color: 'hsl(var(--foreground))' }}>{product.name}</p>
                                                            <p className="text-[10px] uppercase tracking-wide truncate" style={{ color: 'hsl(var(--muted-foreground))' }}>{product.category}</p>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    <div className="xl:w-80 shrink-0">
                                        <textarea
                                            value={notes[request._id] || ''}
                                            onChange={(event) => setNotes((prev) => ({ ...prev, [request._id]: event.target.value }))}
                                            rows={3}
                                            disabled={request.status !== 'pending'}
                                            placeholder="Admin note"
                                            className="w-full rounded-xl px-3 py-2 text-sm glass-input resize-none disabled:opacity-70"
                                            style={{ color: 'hsl(var(--foreground))' }}
                                        />
                                        {request.status === 'pending' ? (
                                            <div className="grid grid-cols-2 gap-2 mt-2">
                                                <button
                                                    onClick={() => reviewRequest(request._id, 'rejected')}
                                                    disabled={Boolean(savingId)}
                                                    className="py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 disabled:opacity-60"
                                                    style={{ color: 'hsl(0,72%,55%)', background: 'rgba(239,68,68,0.1)' }}
                                                >
                                                    {savingId === `${request._id}:rejected` ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />}
                                                    Reject
                                                </button>
                                                <button
                                                    onClick={() => reviewRequest(request._id, 'approved')}
                                                    disabled={Boolean(savingId)}
                                                    className="py-2.5 rounded-xl text-xs font-bold text-white flex items-center justify-center gap-2 disabled:opacity-60"
                                                    style={{ background: 'linear-gradient(135deg, hsl(150,60%,45%), hsl(190,80%,45%))' }}
                                                >
                                                    {savingId === `${request._id}:approved` ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
                                                    Approve
                                                </button>
                                            </div>
                                        ) : (
                                            <p className="text-[11px] mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                Reviewed {request.reviewedAt ? new Date(request.reviewedAt).toLocaleString() : ''}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </motion.div>
    );
};

export default AdminAdsPanel;
