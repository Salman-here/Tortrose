import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import axios from 'axios';
import { toast } from 'react-toastify';
import {
    Landmark,
    Wallet,
    CreditCard,
    Banknote,
    TrendingUp,
    Clock,
    CheckCircle,
    AlertTriangle,
    RefreshCw,
    Send,
    ShieldCheck,
} from 'lucide-react';
import Loader from '../common/Loader';
import { useCurrency } from '../../contexts/CurrencyContext';
import { getAuthToken } from '../../utils/cookieHelper';

const API = `${import.meta.env.VITE_API_URL}api/payments`;
const MIN_WITHDRAWAL_USD = 5;

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

const defaultAccountForm = {
    accountHolderName: '',
    bankName: '',
    accountNumber: '',
    iban: '',
    swiftCode: '',
    country: '',
    currency: 'USD',
    payoutInstructions: '',
};

const PaymentStat = ({ label, value, description, icon, color, bg, delay = 0 }) => (
    <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay }}
        className="glass-card water-shimmer p-4 sm:p-5 min-w-0"
    >
        <div className="flex items-start justify-between gap-3 min-w-0">
            <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {label}
                </p>
                <p className="text-xl sm:text-2xl font-extrabold mt-2 break-words" style={{ color: 'hsl(var(--foreground))' }}>
                    {value}
                </p>
                <p className="text-xs mt-2 leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {description}
                </p>
            </div>
            <div className="p-3 rounded-2xl shrink-0" style={{ background: bg || 'rgba(255,255,255,0.08)', color }}>
                {icon}
            </div>
        </div>
    </motion.div>
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

const SellerPayments = () => {
    const { formatPrice, convertPrice, convertToUSD, currency, currencies } = useCurrency();
    const [loading, setLoading] = useState(true);
    const [savingAccount, setSavingAccount] = useState(false);
    const [requesting, setRequesting] = useState(false);
    const [summary, setSummary] = useState(null);
    const [accountForm, setAccountForm] = useState(defaultAccountForm);
    const [showAccountForm, setShowAccountForm] = useState(false);
    const [withdrawAmount, setWithdrawAmount] = useState('');

    const fetchSummary = async () => {
        setLoading(true);
        try {
            const token = getAuthToken();
            const res = await axios.get(`${API}/seller/summary`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            setSummary(res.data);
            const account = res.data.paymentAccount;
            setAccountForm({
                ...defaultAccountForm,
                accountHolderName: account?.accountHolderName || '',
                bankName: account?.bankName || '',
                swiftCode: account?.swiftCode || '',
                country: account?.country || '',
                currency: account?.currency || currency || 'USD',
                payoutInstructions: account?.payoutInstructions || '',
                accountNumber: '',
                iban: '',
            });
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Failed to load payments');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchSummary();
    }, []);

    const revenue = summary?.revenue || {};
    const availableInCurrentCurrency = useMemo(
        () => convertPrice(revenue.withdrawableBalance || 0),
        [revenue.withdrawableBalance, convertPrice]
    );
    const minimumWithdrawalInCurrentCurrency = useMemo(
        () => convertPrice(MIN_WITHDRAWAL_USD),
        [convertPrice]
    );

    const handleAccountChange = (field, value) => {
        setAccountForm((prev) => ({ ...prev, [field]: value }));
    };

    const saveAccount = async (event) => {
        event.preventDefault();
        setSavingAccount(true);
        try {
            const token = getAuthToken();
            const res = await axios.put(`${API}/seller/account`, accountForm, {
                headers: { Authorization: `Bearer ${token}` },
            });
            toast.success(res.data.msg || 'Payment account saved');
            await fetchSummary();
            setShowAccountForm(false);
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Failed to save payment account');
        } finally {
            setSavingAccount(false);
        }
    };

    const requestWithdrawal = async (event) => {
        event.preventDefault();
        if (!paymentAccount) {
            toast.error('Link your payment account before requesting a withdrawal');
            return;
        }
        if ((revenue.withdrawableBalance || 0) <= 0) {
            toast.error('You have zero balance and cannot withdraw right now');
            return;
        }
        if ((revenue.withdrawableBalance || 0) < MIN_WITHDRAWAL_USD) {
            toast.error(`Minimum withdrawal amount is ${formatPrice(MIN_WITHDRAWAL_USD)}`);
            return;
        }
        const amount = Number(withdrawAmount);
        if (!Number.isFinite(amount) || amount <= 0) {
            toast.error('Enter a valid withdrawal amount');
            return;
        }
        const amountUSD = convertToUSD(amount);
        if (amountUSD < MIN_WITHDRAWAL_USD) {
            toast.error(`Minimum withdrawal amount is ${formatPrice(MIN_WITHDRAWAL_USD)}`);
            return;
        }
        if (amountUSD > (revenue.withdrawableBalance || 0) + 0.01) {
            toast.error(`You can withdraw up to ${formatPrice(revenue.withdrawableBalance || 0)}`);
            return;
        }

        setRequesting(true);
        try {
            const token = getAuthToken();
            await axios.post(
                `${API}/seller/withdrawals`,
                {
                    amountUSD,
                    requestedAmount: amount,
                    requestedCurrency: currency,
                },
                { headers: { Authorization: `Bearer ${token}` } }
            );
            toast.success('Withdrawal request submitted');
            setWithdrawAmount('');
            await fetchSummary();
        } catch (error) {
            toast.error(error.response?.data?.msg || 'Failed to request withdrawal');
        } finally {
            setRequesting(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <Loader size="default" text="Loading payments..." />
            </div>
        );
    }

    const paymentAccount = summary?.paymentAccount;
    const withdrawals = summary?.withdrawals || [];

    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="px-3 py-4 sm:p-6 max-w-7xl mx-auto space-y-6 overflow-hidden">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="min-w-0">
                    <div className="tag-pill mb-2"><Wallet size={12} /> Seller Payments</div>
                    <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>
                        Payments & Revenue
                    </h1>
                    <p className="text-sm mt-1 max-w-2xl" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        Track Stripe balance, COD revenue, and withdrawal requests. COD payments are collected and managed by you directly.
                    </p>
                </div>
                <motion.button
                    whileTap={{ scale: 0.96 }}
                    onClick={fetchSummary}
                    className="w-full sm:w-auto px-4 py-2.5 rounded-xl text-sm font-semibold glass-inner inline-flex items-center justify-center gap-2"
                    style={{ color: 'hsl(var(--foreground))' }}
                >
                    <RefreshCw size={16} /> Refresh
                </motion.button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                <PaymentStat
                    label="Withdrawable Stripe Balance"
                    value={formatPrice(revenue.withdrawableBalance || 0)}
                    description="Delivered Stripe-paid orders minus pending and paid withdrawals."
                    icon={<Wallet size={22} />}
                    color="hsl(150,60%,45%)"
                    bg="rgba(16,185,129,0.12)"
                />
                <PaymentStat
                    label="Delivered COD Revenue"
                    value={formatPrice(revenue.codDeliveredRevenue || 0)}
                    description="Delivered COD order revenue you collect from buyers yourself."
                    icon={<Banknote size={22} />}
                    color="hsl(30,90%,50%)"
                    bg="rgba(249,115,22,0.12)"
                    delay={0.05}
                />
                <PaymentStat
                    label="Total Delivered Revenue"
                    value={formatPrice(revenue.totalDeliveredRevenue || 0)}
                    description="Stripe delivered revenue plus delivered COD revenue."
                    icon={<TrendingUp size={22} />}
                    color="hsl(220,70%,55%)"
                    bg="rgba(99,102,241,0.12)"
                    delay={0.1}
                />
                <PaymentStat
                    label="Estimated Revenue"
                    value={formatPrice(revenue.estimatedRevenue || 0)}
                    description="Delivered revenue plus pending Stripe and COD order revenue."
                    icon={<Clock size={22} />}
                    color="hsl(200,80%,50%)"
                    bg="rgba(14,165,233,0.12)"
                    delay={0.15}
                />
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                <motion.section
                    initial={{ opacity: 0, y: 18 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="glass-panel water-shimmer p-4 sm:p-6 space-y-4 min-w-0"
                >
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                        <div className="min-w-0">
                            <h2 className="text-lg font-bold" style={{ color: 'hsl(var(--foreground))' }}>Bank Account</h2>
                            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Used for manual payouts of Stripe-paid delivered orders.
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setShowAccountForm((value) => !value)}
                            className="w-full sm:w-auto px-4 py-2.5 rounded-xl text-sm font-semibold glass-inner inline-flex items-center justify-center gap-2"
                            style={{ color: 'hsl(var(--foreground))' }}
                        >
                            <Landmark size={16} />
                            {paymentAccount ? (showAccountForm ? 'Hide account form' : 'Update payment account') : (showAccountForm ? 'Hide account form' : 'Add payment account')}
                        </button>
                    </div>

                    {paymentAccount && (
                        <div className="rounded-2xl p-4 glass-inner flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 min-w-0">
                            <div className="min-w-0">
                                <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
                                    <ShieldCheck size={16} style={{ color: 'hsl(150,60%,45%)' }} />
                                    Linked payment account
                                </div>
                                <p className="text-xs mt-2 break-words" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    {paymentAccount.bankName} - {paymentAccount.accountHolderName}
                                    {paymentAccount.maskedAccountNumber ? ` - ${paymentAccount.maskedAccountNumber}` : ''}
                                    {paymentAccount.maskedIban ? ` - IBAN ${paymentAccount.maskedIban}` : ''}
                                </p>
                            </div>
                            <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold" style={{ color: 'hsl(150,60%,45%)', background: 'rgba(16,185,129,0.12)', border: '1px solid var(--glass-border)' }}>
                                Linked
                            </span>
                        </div>
                    )}

                    {showAccountForm && (
                        <form className="space-y-4" onSubmit={saveAccount}>
                            <div className="grid sm:grid-cols-2 gap-4">
                                <label className="space-y-1.5">
                                    <span className="text-xs font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>Account holder name</span>
                                    <input className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none" value={accountForm.accountHolderName} onChange={(e) => handleAccountChange('accountHolderName', e.target.value)} required />
                                </label>
                                <label className="space-y-1.5">
                                    <span className="text-xs font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>Bank name</span>
                                    <input className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none" value={accountForm.bankName} onChange={(e) => handleAccountChange('bankName', e.target.value)} required />
                                </label>
                                <label className="space-y-1.5">
                                    <span className="text-xs font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>Account number</span>
                                    <input className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none" value={accountForm.accountNumber} onChange={(e) => handleAccountChange('accountNumber', e.target.value)} placeholder={paymentAccount?.maskedAccountNumber || 'Enter account number'} />
                                </label>
                                <label className="space-y-1.5">
                                    <span className="text-xs font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>IBAN</span>
                                    <input className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none" value={accountForm.iban} onChange={(e) => handleAccountChange('iban', e.target.value)} placeholder={paymentAccount?.maskedIban || 'Optional IBAN'} />
                                </label>
                                <label className="space-y-1.5">
                                    <span className="text-xs font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>Country</span>
                                    <input className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none" value={accountForm.country} onChange={(e) => handleAccountChange('country', e.target.value)} />
                                </label>
                                <label className="space-y-1.5">
                                    <span className="text-xs font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>Payout currency</span>
                                    <select className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none" value={accountForm.currency} onChange={(e) => handleAccountChange('currency', e.target.value)}>
                                        {Object.keys(currencies).map((code) => <option key={code} value={code}>{code} - {currencies[code].name}</option>)}
                                    </select>
                                </label>
                            </div>

                            <label className="space-y-1.5 block">
                                <span className="text-xs font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>Payout instructions</span>
                                <textarea className="w-full glass-inner rounded-xl px-3 py-2.5 text-sm outline-none min-h-[86px]" value={accountForm.payoutInstructions} onChange={(e) => handleAccountChange('payoutInstructions', e.target.value)} placeholder="Optional transfer details" />
                            </label>

                            <button disabled={savingAccount} className="w-full sm:w-auto px-5 py-3 rounded-xl text-sm font-semibold text-white inline-flex items-center justify-center gap-2 disabled:opacity-60" style={{ background: 'linear-gradient(135deg, hsl(220,70%,55%), hsl(200,80%,50%))' }}>
                                {savingAccount ? <RefreshCw size={16} className="animate-spin" /> : <CheckCircle size={16} />}
                                Link payment account
                            </button>
                        </form>
                    )}
                </motion.section>

                <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
                    <form className="glass-panel water-shimmer p-4 sm:p-6 space-y-4 min-w-0" onSubmit={requestWithdrawal}>
                        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                            <div className="min-w-0">
                                <h2 className="text-lg font-bold" style={{ color: 'hsl(var(--foreground))' }}>Request Withdrawal</h2>
                                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    Available now: {formatPrice(revenue.withdrawableBalance || 0)}. Minimum: {formatPrice(MIN_WITHDRAWAL_USD)}
                                </p>
                            </div>
                            <div className="p-3 rounded-2xl" style={{ background: 'rgba(16,185,129,0.12)', color: 'hsl(150,60%,45%)' }}>
                                <CreditCard size={22} />
                            </div>
                        </div>

                        {!paymentAccount && (
                            <div className="rounded-2xl p-4 flex gap-3" style={{ background: 'rgba(249,115,22,0.10)', border: '1px solid rgba(249,115,22,0.20)' }}>
                                <AlertTriangle size={18} className="shrink-0 mt-0.5" style={{ color: 'hsl(30,90%,50%)' }} />
                                <p className="text-sm" style={{ color: 'hsl(var(--foreground))' }}>
                                    Add your bank account first. Withdrawals are only sent to the saved payout account.
                                </p>
                            </div>
                        )}

                        <div className="grid sm:grid-cols-[1fr_auto] gap-3">
                            <label className="space-y-1.5">
                                <span className="text-xs font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>Amount in {currency}</span>
                                <input type="number" min={minimumWithdrawalInCurrentCurrency.toFixed(2)} step="0.01" className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none" value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} placeholder="0.00" />
                            </label>
                            <button type="button" className="w-full sm:w-auto sm:self-end px-4 py-2.5 rounded-xl text-sm font-semibold glass-inner" style={{ color: 'hsl(var(--foreground))' }} onClick={() => setWithdrawAmount(availableInCurrentCurrency.toFixed(2))}>
                                Full balance
                            </button>
                        </div>

                        <button disabled={requesting} className="w-full sm:w-auto px-5 py-3 rounded-xl text-sm font-semibold text-white inline-flex items-center justify-center gap-2 disabled:opacity-60" style={{ background: 'linear-gradient(135deg, hsl(150,60%,45%), hsl(200,80%,45%))' }}>
                            {requesting ? <RefreshCw size={16} className="animate-spin" /> : <Send size={16} />}
                            Send withdrawal request
                        </button>
                    </form>

                    <div className="glass-panel water-shimmer p-4 sm:p-6 min-w-0">
                        <h2 className="text-lg font-bold mb-4" style={{ color: 'hsl(var(--foreground))' }}>Balance Details</h2>
                        <div className="space-y-3">
                            {[
                                ['Stripe delivered revenue', revenue.stripeDeliveredRevenue || 0],
                                ['Pending Stripe estimate', revenue.stripePendingRevenue || 0],
                                ['Pending withdrawals', revenue.pendingWithdrawalAmount || 0],
                                ['Processing withdrawals', revenue.processingWithdrawalAmount || 0],
                                ['Already paid out', revenue.totalWithdrawn || 0],
                                ['Pending COD estimate', revenue.codPendingRevenue || 0],
                            ].map(([label, amount]) => (
                                <div key={label} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 text-sm">
                                    <span style={{ color: 'hsl(var(--muted-foreground))' }}>{label}</span>
                                    <span className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{formatPrice(amount)}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </motion.div>
            </div>

            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} className="glass-panel water-shimmer p-4 sm:p-6 min-w-0">
                <h2 className="text-lg font-bold mb-4" style={{ color: 'hsl(var(--foreground))' }}>Withdrawal History</h2>
                {withdrawals.length === 0 ? (
                    <div className="text-center py-10">
                        <Wallet size={34} className="mx-auto mb-3" style={{ color: 'hsl(var(--muted-foreground))' }} />
                        <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>No withdrawal requests yet.</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
                        <table className="w-full min-w-[680px] text-sm">
                            <thead>
                                <tr style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    <th className="text-left font-semibold py-3 pr-4">Requested</th>
                                    <th className="text-left font-semibold py-3 pr-4">Amount</th>
                                    <th className="text-left font-semibold py-3 pr-4">Bank</th>
                                    <th className="text-left font-semibold py-3 pr-4">Status</th>
                                    <th className="text-left font-semibold py-3 pr-4">Admin note</th>
                                </tr>
                            </thead>
                            <tbody>
                                {withdrawals.map((request) => (
                                    <tr key={request._id} style={{ borderTop: '1px solid var(--glass-border)' }}>
                                        <td className="py-3 pr-4 whitespace-nowrap" style={{ color: 'hsl(var(--foreground))' }}>{new Date(request.createdAt).toLocaleDateString()}</td>
                                        <td className="py-3 pr-4 font-semibold whitespace-nowrap" style={{ color: 'hsl(var(--foreground))' }}>{formatPrice(request.amount || 0)}</td>
                                        <td className="py-3 pr-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            {request.paymentAccountSnapshot?.bankName || 'Bank'} - {request.paymentAccountSnapshot?.accountNumberLast4 ? `**** ${request.paymentAccountSnapshot.accountNumberLast4}` : 'saved account'}
                                        </td>
                                        <td className="py-3 pr-4"><StatusPill status={request.status} /></td>
                                        <td className="py-3 pr-4 max-w-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{request.adminNote || '-'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </motion.div>
        </motion.div>
    );
};

export default SellerPayments;
