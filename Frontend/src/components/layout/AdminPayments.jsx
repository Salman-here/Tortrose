import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import axios from 'axios';
import { toast } from 'react-toastify';
import {
    Wallet,
    CreditCard,
    Banknote,
    TrendingUp,
    RefreshCw,
    Users,
    CheckCircle,
    AlertTriangle,
    Building2,
} from 'lucide-react';
import Loader from '../common/Loader';
import { useCurrency } from '../../contexts/CurrencyContext';
import { getAuthToken } from '../../utils/cookieHelper';

const API = `${import.meta.env.VITE_API_URL}api/payments`;
const statuses = ['pending', 'approved', 'processing', 'paid', 'rejected', 'cancelled'];

const statusColors = {
    pending: 'hsl(30,90%,50%)',
    approved: 'hsl(220,70%,55%)',
    processing: 'hsl(200,80%,50%)',
    paid: 'hsl(150,60%,45%)',
    rejected: 'hsl(0,72%,55%)',
    cancelled: 'hsl(0,0%,55%)',
};

const statusBackgrounds = {
    pending: 'rgba(249,115,22,0.12)',
    approved: 'rgba(99,102,241,0.12)',
    processing: 'rgba(14,165,233,0.12)',
    paid: 'rgba(16,185,129,0.12)',
    rejected: 'rgba(239,68,68,0.12)',
    cancelled: 'rgba(148,163,184,0.12)',
};

const StatCard = ({ label, value, icon, color, bg }) => (
    <div className="glass-card water-shimmer p-4 sm:p-5 min-w-0">
        <div className="flex items-start justify-between gap-3 min-w-0">
            <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {label}
                </p>
                <p className="text-xl sm:text-2xl font-extrabold mt-2 break-words" style={{ color: 'hsl(var(--foreground))' }}>
                    {value}
                </p>
            </div>
            <div className="p-3 rounded-2xl" style={{ background: bg, color }}>
                {icon}
            </div>
        </div>
    </div>
);

const StatusPill = ({ status }) => (
    <span
        className="px-2.5 py-1 rounded-full text-[11px] font-semibold capitalize"
        style={{
            color: statusColors[status] || 'hsl(var(--muted-foreground))',
            background: statusBackgrounds[status] || 'rgba(255,255,255,0.08)',
            border: '1px solid var(--glass-border)',
        }}
    >
        {status || 'pending'}
    </span>
);

const AdminPayments = () => {
    const { formatPrice } = useCurrency();
    const [loading, setLoading] = useState(true);
    const [savingId, setSavingId] = useState('');
    const [data, setData] = useState(null);
    const [edits, setEdits] = useState({});

    const fetchOverview = async () => {
        setLoading(true);
        try {
            const token = getAuthToken();
            const res = await axios.get(`${API}/admin/overview`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            setData(res.data);
            const nextEdits = {};
            (res.data.withdrawals || []).forEach((request) => {
                nextEdits[request._id] = {
                    status: request.status || 'pending',
                    adminNote: request.adminNote || '',
                };
            });
            setEdits(nextEdits);
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Failed to load admin payments');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchOverview();
    }, []);

    const updateEdit = (id, field, value) => {
        setEdits((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), [field]: value } }));
    };

    const updateWithdrawal = async (id) => {
        const payload = edits[id] || {};
        setSavingId(id);
        try {
            const token = getAuthToken();
            await axios.patch(`${API}/admin/withdrawals/${id}`, payload, {
                headers: { Authorization: `Bearer ${token}` },
            });
            toast.success('Withdrawal updated');
            await fetchOverview();
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Failed to update withdrawal');
        } finally {
            setSavingId('');
        }
    };

    const pendingRequests = useMemo(
        () => (data?.withdrawals || []).filter((request) => ['pending', 'approved', 'processing'].includes(request.status)).length,
        [data]
    );

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <Loader size="default" text="Loading platform payments..." />
            </div>
        );
    }

    const summary = data?.summary || {};
    const sellers = data?.sellers || [];
    const withdrawals = data?.withdrawals || [];
    const loadErrors = data?.errors || [];

    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="px-3 py-4 sm:p-6 max-w-7xl mx-auto space-y-6 overflow-hidden">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="min-w-0">
                    <div className="tag-pill mb-2"><Wallet size={12} /> Admin Payments</div>
                    <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>
                        Seller Payments & Withdrawals
                    </h1>
                    <p className="text-sm mt-1 max-w-2xl" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        Review seller payout accounts, Stripe withdrawable balances, COD revenue, and withdrawal requests.
                    </p>
                </div>
                <button onClick={fetchOverview} className="w-full sm:w-auto px-4 py-2.5 rounded-xl text-sm font-semibold glass-inner inline-flex items-center justify-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                    <RefreshCw size={16} /> Refresh
                </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
                <StatCard label="Platform Stripe Balance" value={formatPrice(summary.withdrawableBalance || 0)} icon={<Wallet size={22} />} color="hsl(150,60%,45%)" bg="rgba(16,185,129,0.12)" />
                <StatCard label="Delivered COD Revenue" value={formatPrice(summary.codDeliveredRevenue || 0)} icon={<Banknote size={22} />} color="hsl(30,90%,50%)" bg="rgba(249,115,22,0.12)" />
                <StatCard label="Estimated Revenue" value={formatPrice(summary.estimatedRevenue || 0)} icon={<TrendingUp size={22} />} color="hsl(220,70%,55%)" bg="rgba(99,102,241,0.12)" />
                <StatCard label="Paid Out" value={formatPrice(summary.totalWithdrawn || 0)} icon={<CreditCard size={22} />} color="hsl(200,80%,50%)" bg="rgba(14,165,233,0.12)" />
                <StatCard label="Open Requests" value={pendingRequests} icon={<AlertTriangle size={22} />} color="hsl(0,72%,55%)" bg="rgba(239,68,68,0.12)" />
            </div>

            {loadErrors.length > 0 && (
                <div className="glass-inner rounded-2xl p-4 flex items-start gap-3" style={{ border: '1px solid rgba(249,115,22,0.35)' }}>
                    <AlertTriangle size={18} className="shrink-0 mt-0.5" style={{ color: 'hsl(30,90%,50%)' }} />
                    <div className="min-w-0">
                        <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
                            Some seller payment rows could not be loaded.
                        </p>
                        <p className="text-xs mt-1 break-words" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            Refresh after a moment. Loaded rows and withdrawal requests below are still usable.
                        </p>
                    </div>
                </div>
            )}

            <section className="glass-panel water-shimmer p-4 sm:p-6 min-w-0">
                <div className="flex items-start justify-between gap-3 mb-4">
                    <div className="min-w-0">
                        <h2 className="text-lg font-bold" style={{ color: 'hsl(var(--foreground))' }}>Seller Payment Accounts</h2>
                        <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            Stripe revenue is withdrawable here. COD revenue is shown for reporting only.
                        </p>
                    </div>
                    <Users size={20} style={{ color: 'hsl(var(--muted-foreground))' }} />
                </div>

                <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
                    <table className="w-full min-w-[920px] text-sm">
                        <thead>
                            <tr style={{ color: 'hsl(var(--muted-foreground))' }}>
                                <th className="text-left font-semibold py-3 pr-4">Seller</th>
                                <th className="text-left font-semibold py-3 pr-4">Store</th>
                                <th className="text-left font-semibold py-3 pr-4">Bank</th>
                                <th className="text-left font-semibold py-3 pr-4">Stripe balance</th>
                                <th className="text-left font-semibold py-3 pr-4">COD delivered</th>
                                <th className="text-left font-semibold py-3 pr-4">Estimated</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sellers.length === 0 ? (
                                <tr style={{ borderTop: '1px solid var(--glass-border)' }}>
                                    <td className="py-8 text-center text-sm" colSpan={6} style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        No seller payment data found.
                                    </td>
                                </tr>
                            ) : sellers.map((row) => (
                                <tr key={row.seller._id} style={{ borderTop: '1px solid var(--glass-border)' }}>
                                    <td className="py-3 pr-4">
                                        <div className="flex items-center gap-2">
                                            <p className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{row.seller.username}</p>
                                            {row.loadError && <AlertTriangle size={14} style={{ color: 'hsl(30,90%,50%)' }} />}
                                        </div>
                                        <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{row.seller.email}</p>
                                    </td>
                                    <td className="py-3 pr-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        {row.store?.storeName || 'No store'}
                                    </td>
                                    <td className="py-3 pr-4 min-w-[220px]">
                                        {row.paymentAccount ? (
                                            <div>
                                                <p className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
                                                    {row.paymentAccount.bankName}
                                                </p>
                                                <p className="text-xs break-words" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                    {row.paymentAccount.accountHolderName}
                                                    {row.paymentAccount.accountNumber ? ` - ${row.paymentAccount.accountNumber}` : row.paymentAccount.maskedAccountNumber ? ` - ${row.paymentAccount.maskedAccountNumber}` : ''}
                                                    {row.paymentAccount.iban ? ` - IBAN ${row.paymentAccount.iban}` : ''}
                                                </p>
                                            </div>
                                        ) : (
                                            <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Not linked</span>
                                        )}
                                    </td>
                                    <td className="py-3 pr-4 font-semibold whitespace-nowrap" style={{ color: 'hsl(150,60%,45%)' }}>{formatPrice(row.revenue?.withdrawableBalance || 0)}</td>
                                    <td className="py-3 pr-4 whitespace-nowrap" style={{ color: 'hsl(var(--foreground))' }}>{formatPrice(row.revenue?.codDeliveredRevenue || 0)}</td>
                                    <td className="py-3 pr-4 whitespace-nowrap" style={{ color: 'hsl(var(--foreground))' }}>{formatPrice(row.revenue?.estimatedRevenue || 0)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            <section className="glass-panel water-shimmer p-4 sm:p-6 min-w-0">
                <div className="flex items-start justify-between gap-3 mb-4">
                    <div className="min-w-0">
                        <h2 className="text-lg font-bold" style={{ color: 'hsl(var(--foreground))' }}>Withdrawal Requests</h2>
                        <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            Mark requests approved, processing, paid, rejected, or cancelled after admin review.
                        </p>
                    </div>
                    <Building2 size={20} style={{ color: 'hsl(var(--muted-foreground))' }} />
                </div>

                {withdrawals.length === 0 ? (
                    <div className="text-center py-10">
                        <CheckCircle size={34} className="mx-auto mb-3" style={{ color: 'hsl(150,60%,45%)' }} />
                        <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>No withdrawal requests yet.</p>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {withdrawals.map((request) => {
                            const edit = edits[request._id] || { status: request.status, adminNote: request.adminNote || '' };
                            return (
                                <div key={request._id} className="glass-inner rounded-2xl p-4 min-w-0">
                                    <div className="grid lg:grid-cols-[1.2fr_1fr_1.5fr_auto] gap-4 items-start">
                                        <div className="min-w-0">
                                            <div className="flex flex-wrap items-center gap-2 mb-2">
                                                <StatusPill status={request.status} />
                                                <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                    {new Date(request.createdAt).toLocaleString()}
                                                </span>
                                            </div>
                                            <p className="font-semibold break-words" style={{ color: 'hsl(var(--foreground))' }}>
                                                {request.seller?.username || 'Seller'} requested {formatPrice(request.amount || 0)}
                                            </p>
                                            <p className="text-xs mt-1 break-words" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                {request.seller?.email || ''}{request.sellerNote ? ` - Seller note: ${request.sellerNote}` : ''}
                                            </p>
                                        </div>
                                        <div className="text-xs leading-relaxed min-w-0" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            <p className="font-semibold text-sm mb-1" style={{ color: 'hsl(var(--foreground))' }}>
                                                {request.paymentAccountSnapshot?.bankName || 'Bank account'}
                                            </p>
                                            <p>{request.paymentAccountSnapshot?.accountHolderName || 'Account holder'}</p>
                                            <p>{request.paymentAccountSnapshot?.accountNumberLast4 ? `Account: **** ${request.paymentAccountSnapshot.accountNumberLast4}` : 'Account on file'}</p>
                                            {request.paymentAccountSnapshot?.ibanLast4 && <p>IBAN: **** {request.paymentAccountSnapshot.ibanLast4}</p>}
                                        </div>
                                        <div className="grid sm:grid-cols-2 gap-3">
                                            <select
                                                className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none"
                                                value={edit.status}
                                                onChange={(e) => updateEdit(request._id, 'status', e.target.value)}
                                            >
                                                {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
                                            </select>
                                            <input
                                                className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none"
                                                value={edit.adminNote}
                                                onChange={(e) => updateEdit(request._id, 'adminNote', e.target.value)}
                                                placeholder="Admin note"
                                            />
                                        </div>
                                        <button
                                            disabled={savingId === request._id}
                                            onClick={() => updateWithdrawal(request._id)}
                                            className="w-full lg:w-auto px-4 py-2.5 rounded-xl text-sm font-semibold text-white inline-flex items-center justify-center gap-2 disabled:opacity-60"
                                            style={{ background: 'linear-gradient(135deg, hsl(220,70%,55%), hsl(200,80%,50%))' }}
                                        >
                                            {savingId === request._id ? <RefreshCw size={16} className="animate-spin" /> : <CheckCircle size={16} />}
                                            Update
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>
        </motion.div>
    );
};

export default AdminPayments;
