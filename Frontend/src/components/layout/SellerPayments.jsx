import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { useAuth } from '../../contexts/AuthContext';
import { getAuthToken } from '../../utils/cookieHelper';
import {
    toCurrencyMinorUnits,
} from '../../utils/currencySafety';
import {
    clearPersistedMutationAttemptFromLedger,
    createScopedMutationStorageKey,
    getOrCreatePersistedMutationAttemptInLedger,
} from '../../utils/persistedMutationAttempt';
import {
    exactCurrencyCode,
    isExactNonNegativeJsonMoney,
    parseExactMoneyInput,
    selectWithdrawalHistoryMoney,
    shouldRetainWithdrawalAttempt,
    withdrawalNeedsLiveFx,
} from '../../utils/sellerMoneySafety';
import { inspectSellerProductCurrencyState } from '../../utils/productFormCurrency';

const API = `${import.meta.env.VITE_API_URL}api/payments`;
const WITHDRAWAL_ATTEMPT_STORAGE_KEY = 'rozare_seller_withdrawal_attempt_v1';
const REQUIRED_DISPLAY_REVENUE_FIELDS = [
    'withdrawableBalance',
    'onlineDeliveredRevenue',
    'codDeliveredRevenue',
    'totalDeliveredRevenue',
    'estimatedRevenue',
    'stripeDeliveredRevenue',
    'walletDeliveredRevenue',
    'onlinePendingRevenue',
    'pendingWithdrawalAmount',
    'processingWithdrawalAmount',
    'totalWithdrawn',
    'returnRefundDebits',
    'codPendingRevenue',
];

const statusColors = {
    pending: 'hsl(30,90%,50%)',
    approved: 'hsl(220,70%,55%)',
    processing: 'hsl(200,80%,50%)',
    manual_review: 'hsl(38,92%,45%)',
    paid: 'hsl(150,60%,45%)',
    failed: 'hsl(0,72%,55%)',
    rejected: 'hsl(0,72%,55%)',
    cancelled: 'hsl(0,0%,55%)',
};

const statusBackgrounds = {
    pending: 'rgba(249,115,22,0.12)',
    approved: 'rgba(99,102,241,0.12)',
    processing: 'rgba(14,165,233,0.12)',
    manual_review: 'rgba(245,158,11,0.14)',
    paid: 'rgba(16,185,129,0.12)',
    failed: 'rgba(239,68,68,0.12)',
    rejected: 'rgba(239,68,68,0.12)',
    cancelled: 'rgba(148,163,184,0.12)',
};

const statusLabels = {
    manual_review: 'Manual review',
    failed: 'Failed',
};

const statusDescriptions = {
    manual_review: 'Funds remain reserved while the payout outcome is reviewed.',
    failed: 'The payout was not sent and the reserved funds were released.',
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
        {statusLabels[status] || status || 'pending'}
    </span>
);

const SellerPayments = () => {
    const { formatAmount, currencies } = useCurrency();
    const { currentUser } = useAuth();
    const withdrawalAttemptStorageKey = createScopedMutationStorageKey(
        WITHDRAWAL_ATTEMPT_STORAGE_KEY,
        currentUser?._id || currentUser?.id || 'guest'
    );
    const [loading, setLoading] = useState(true);
    const [refreshingSummary, setRefreshingSummary] = useState(false);
    const [loadError, setLoadError] = useState('');
    const [savingAccount, setSavingAccount] = useState(false);
    const [requesting, setRequesting] = useState(false);
    const [summary, setSummary] = useState(null);
    const [sellerCurrency, setSellerCurrency] = useState(null);
    const [accountForm, setAccountForm] = useState(defaultAccountForm);
    const [showAccountForm, setShowAccountForm] = useState(false);
    const [withdrawAmount, setWithdrawAmount] = useState('');
    const summaryRef = useRef(null);
    const summaryRequestRef = useRef({ id: 0, controller: null });
    const activeWithdrawalAttemptRef = useRef(null);
    const withdrawalAttemptResetRef = useRef(Promise.resolve());

    const retireActiveWithdrawalAttempt = useCallback(() => {
        const attempt = activeWithdrawalAttemptRef.current;
        if (!attempt) return withdrawalAttemptResetRef.current;
        activeWithdrawalAttemptRef.current = null;
        const reset = withdrawalAttemptResetRef.current
            .catch(() => undefined)
            .then(() => clearPersistedMutationAttemptFromLedger(
                localStorage,
                attempt.storageKey,
                attempt.fingerprint,
                attempt.key,
            ));
        withdrawalAttemptResetRef.current = reset;
        return reset;
    }, []);

    const updateWithdrawAmount = (value) => {
        if (value !== withdrawAmount) void retireActiveWithdrawalAttempt();
        setWithdrawAmount(value);
    };

    useEffect(() => {
        void retireActiveWithdrawalAttempt();
        setWithdrawAmount('');
    }, [sellerCurrency, retireActiveWithdrawalAttempt]);

    const fetchSummary = useCallback(async () => {
        const requestId = summaryRequestRef.current.id + 1;
        summaryRequestRef.current.controller?.abort();
        const controller = new AbortController();
        summaryRequestRef.current = { id: requestId, controller };
        summaryRef.current = null;
        setSummary(null);
        setSellerCurrency(null);
        setLoadError('');
        setLoading(true);
        setRefreshingSummary(true);
        try {
            const token = getAuthToken();
            const productCurrencyResponse = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/product-currency`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: controller.signal,
            });
            if (summaryRequestRef.current.id !== requestId) return;
            const productCurrencyState = inspectSellerProductCurrencyState(
                productCurrencyResponse.data?.productCurrency
            );
            if (!productCurrencyState.valid || productCurrencyState.hasStore !== true) {
                throw new Error('Your store product currency could not be verified. Please retry.');
            }
            const requestCurrency = productCurrencyState.activeCurrency;
            const res = await axios.get(`${API}/seller/summary?currency=${encodeURIComponent(requestCurrency)}`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: controller.signal,
            });
            if (summaryRequestRef.current.id !== requestId) return;
            const responseCurrency = exactCurrencyCode(res.data?.displayCurrency);
            if (responseCurrency !== requestCurrency) {
                throw new Error('Payment summary returned in an unexpected currency. Please retry.');
            }
            const displayRevenue = res.data?.displayRevenue || {};
            const limits = res.data?.withdrawalLimits || {};
            const account = res.data?.paymentAccount;
            const completeMoneySummary = REQUIRED_DISPLAY_REVENUE_FIELDS.every((field) => (
                isExactNonNegativeJsonMoney(displayRevenue[field])
            )) && isExactNonNegativeJsonMoney(limits.availableDisplayAmount)
                && isExactNonNegativeJsonMoney(limits.minimumDisplayAmount)
                && isExactNonNegativeJsonMoney(limits.availableUSD)
                && isExactNonNegativeJsonMoney(limits.minimumUSD)
                && exactCurrencyCode(limits.displayCurrency) === requestCurrency
                && exactCurrencyCode(limits.baseCurrency) === 'USD'
                && typeof res.data?.exchangeRateStatus?.fallback === 'boolean'
                && Array.isArray(res.data?.withdrawals)
                && (!account || exactCurrencyCode(account.currency) !== null);
            if (!completeMoneySummary) {
                throw new Error('Payment summary did not include complete authoritative money totals.');
            }

            const nextSummary = { ...res.data, displayCurrency: responseCurrency };
            summaryRef.current = nextSummary;
            setSellerCurrency(requestCurrency);
            setSummary(nextSummary);
            setLoadError('');
            setAccountForm({
                ...defaultAccountForm,
                accountHolderName: account?.accountHolderName || '',
                bankName: account?.bankName || '',
                swiftCode: account?.swiftCode || '',
                country: account?.country || '',
                currency: account?.currency || requestCurrency,
                payoutInstructions: account?.payoutInstructions || '',
                accountNumber: '',
                iban: '',
            });
        } catch (error) {
            if (error.code === 'ERR_CANCELED' || error.name === 'CanceledError') return;
            if (summaryRequestRef.current.id !== requestId) return;
            const message = error.response?.data?.msg || error.message || 'Failed to load payments';
            setLoadError(message);
            toast.error(message);
        } finally {
            if (summaryRequestRef.current.id === requestId) {
                setLoading(false);
                setRefreshingSummary(false);
            }
        }
    }, []);

    useEffect(() => {
        fetchSummary();
        return () => {
            summaryRequestRef.current.id += 1;
            summaryRequestRef.current.controller?.abort();
        };
    }, [fetchSummary]);

    const summaryMatchesCurrency = Boolean(summary)
        && Boolean(sellerCurrency)
        && String(summary.displayCurrency).toUpperCase() === sellerCurrency;
    const activeSummary = summaryMatchesCurrency ? summary : null;
    const displayRevenue = activeSummary?.displayRevenue || {};
    const displayValue = (field) => displayRevenue[field];
    const withdrawalLimits = activeSummary?.withdrawalLimits || {};
    const paymentAccount = activeSummary?.paymentAccount;
    const exchangeRatesAreFallback = activeSummary?.exchangeRateStatus?.fallback !== false;
    const withdrawalRequiresLiveFx = withdrawalNeedsLiveFx(sellerCurrency, paymentAccount?.currency);
    const withdrawalBlockedByFallback = exchangeRatesAreFallback && withdrawalRequiresLiveFx;
    const displayMoneyIsApproximate = exchangeRatesAreFallback && sellerCurrency !== 'USD';
    const formatDisplayMoney = (amount) => `${displayMoneyIsApproximate ? '≈' : ''}${formatAmount(amount, { targetCurrency: sellerCurrency })}`;
    const availableInCurrentCurrency = withdrawalLimits.availableDisplayAmount;
    const minimumWithdrawalInCurrentCurrency = withdrawalLimits.minimumDisplayAmount;
    const withdrawalInput = parseExactMoneyInput(withdrawAmount, { allowZero: false });
    const withdrawalInputError = withdrawAmount && !withdrawalInput
        ? 'Enter a positive amount with no more than 2 decimal places.'
        : '';

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
        if (!activeSummary || refreshingSummary) {
            toast.error('Refresh the live payment summary before requesting a withdrawal.');
            return;
        }
        if (withdrawalBlockedByFallback) {
            toast.error('Live exchange rates are unavailable. Refresh and retry before requesting a withdrawal.');
            return;
        }
        if (!paymentAccount) {
            toast.error('Link your payment account before requesting a withdrawal');
            return;
        }
        if (toCurrencyMinorUnits(availableInCurrentCurrency) <= 0) {
            toast.error('You have zero balance and cannot withdraw right now');
            return;
        }
        if (toCurrencyMinorUnits(availableInCurrentCurrency) < toCurrencyMinorUnits(minimumWithdrawalInCurrentCurrency)) {
            toast.error(`Minimum withdrawal amount is ${formatAmount(minimumWithdrawalInCurrentCurrency, { targetCurrency: sellerCurrency })}`);
            return;
        }
        if (!withdrawalInput) {
            toast.error('Enter a positive withdrawal amount with no more than 2 decimal places.');
            return;
        }
        const amount = withdrawalInput.amount;
        if (toCurrencyMinorUnits(amount) < toCurrencyMinorUnits(minimumWithdrawalInCurrentCurrency)) {
            toast.error(`Minimum withdrawal amount is ${formatAmount(minimumWithdrawalInCurrentCurrency, { targetCurrency: sellerCurrency })}`);
            return;
        }
        if (toCurrencyMinorUnits(amount) > toCurrencyMinorUnits(availableInCurrentCurrency)) {
            toast.error(`You can withdraw up to ${formatAmount(availableInCurrentCurrency, { targetCurrency: sellerCurrency })}`);
            return;
        }

        setRequesting(true);
        const fingerprint = `${currentUser?._id || currentUser?.id || 'guest'}:${sellerCurrency}:${amount.toFixed(2)}`;
        let attemptKey = '';
        try {
            await withdrawalAttemptResetRef.current;
            const attempt = await getOrCreatePersistedMutationAttemptInLedger({
                storage: localStorage,
                storageKey: withdrawalAttemptStorageKey,
                fingerprint,
                keyPrefix: 'seller-withdrawal',
            });
            attemptKey = attempt.key;
            activeWithdrawalAttemptRef.current = {
                fingerprint,
                key: attempt.key,
                storageKey: withdrawalAttemptStorageKey,
            };
            const token = getAuthToken();
            await axios.post(
                `${API}/seller/withdrawals`,
                {
                    amount,
                    currency: sellerCurrency,
                },
                { headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': attempt.key } }
            );
            await retireActiveWithdrawalAttempt();
            toast.success('Withdrawal request submitted');
            setWithdrawAmount('');
            await fetchSummary();
        } catch (error) {
            if (!shouldRetainWithdrawalAttempt(error) && attemptKey) {
                await retireActiveWithdrawalAttempt();
            }
            toast.error(error.response?.data?.msg || 'Failed to request withdrawal');
        } finally {
            setRequesting(false);
        }
    };

    if (loading || (!loadError && summary && !summaryMatchesCurrency)) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <Loader size="default" text="Loading payments..." />
            </div>
        );
    }

    const withdrawals = activeSummary?.withdrawals || [];

    if (!activeSummary) {
        return (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="px-3 py-4 sm:p-6 max-w-7xl mx-auto space-y-6 overflow-hidden">
                <div>
                    <div className="tag-pill mb-2"><Wallet size={12} /> Seller Payments</div>
                    <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>
                        Payments & Revenue
                    </h1>
                    <p className="text-sm mt-1 max-w-2xl" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        Track card and Wallet balance, COD revenue, and withdrawal requests.
                    </p>
                </div>
                <div className="glass-panel p-6 text-center space-y-4" role="alert" aria-live="polite">
                    <AlertTriangle size={30} className="mx-auto" style={{ color: 'hsl(30,90%,50%)' }} />
                    <div>
                        <h2 className="text-base font-bold" style={{ color: 'hsl(var(--foreground))' }}>Payment summary unavailable</h2>
                        <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{loadError || 'Live payment balances could not be loaded.'}</p>
                    </div>
                    <button type="button" onClick={fetchSummary} disabled={refreshingSummary} className="px-4 py-2.5 rounded-xl glass-inner text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60">
                        <RefreshCw size={16} className={refreshingSummary ? 'animate-spin' : ''} /> Retry
                    </button>
                </div>
            </motion.div>
        );
    }

    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="px-3 py-4 sm:p-6 max-w-7xl mx-auto space-y-6 overflow-hidden">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="min-w-0">
                    <div className="tag-pill mb-2"><Wallet size={12} /> Seller Payments</div>
                    <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>
                        Payments & Revenue
                    </h1>
                    <p className="text-sm mt-1 max-w-2xl" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        Track card and Wallet balance, COD revenue, and withdrawal requests. COD payments are collected and managed by you directly.
                    </p>
                </div>
                <motion.button
                    whileTap={{ scale: 0.96 }}
                    onClick={fetchSummary}
                    disabled={refreshingSummary}
                    className="w-full sm:w-auto px-4 py-2.5 rounded-xl text-sm font-semibold glass-inner inline-flex items-center justify-center gap-2"
                    style={{ color: 'hsl(var(--foreground))' }}
                >
                    <RefreshCw size={16} className={refreshingSummary ? 'animate-spin' : ''} /> Refresh
                </motion.button>
            </div>

            {exchangeRatesAreFallback && (
                <div className="glass-panel p-4 flex items-start gap-3" role="alert">
                    <AlertTriangle size={18} className="shrink-0 mt-0.5" style={{ color: 'hsl(30,90%,50%)' }} />
                    <p className="text-sm" style={{ color: 'hsl(var(--foreground))' }}>
                        {withdrawalBlockedByFallback
                            ? 'Live FX is temporarily unavailable. Cross-currency totals are estimates and this withdrawal needs a conversion, so it is paused until a trusted rate refresh succeeds.'
                            : 'Live FX is temporarily unavailable. This USD-to-USD withdrawal does not require conversion and remains available.'}
                    </p>
                </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                <PaymentStat
                    label="Withdrawable Online Balance"
                    value={formatDisplayMoney(displayValue('withdrawableBalance'))}
                    description="Delivered card and Wallet orders minus withdrawals and return-refund reserves."
                    icon={<Wallet size={22} />}
                    color="hsl(150,60%,45%)"
                    bg="rgba(16,185,129,0.12)"
                />
                <PaymentStat
                    label="Delivered COD Revenue"
                    value={formatDisplayMoney(displayValue('codDeliveredRevenue'))}
                    description="Delivered COD order revenue you collect from buyers yourself."
                    icon={<Banknote size={22} />}
                    color="hsl(30,90%,50%)"
                    bg="rgba(249,115,22,0.12)"
                    delay={0.05}
                />
                <PaymentStat
                    label="Total Delivered Revenue"
                    value={formatDisplayMoney(displayValue('totalDeliveredRevenue'))}
                    description="Delivered card, Wallet, and COD revenue."
                    icon={<TrendingUp size={22} />}
                    color="hsl(220,70%,55%)"
                    bg="rgba(99,102,241,0.12)"
                    delay={0.1}
                />
                <PaymentStat
                    label="Estimated Revenue"
                    value={formatDisplayMoney(displayValue('estimatedRevenue'))}
                    description="Delivered revenue plus pending card, Wallet, and COD orders."
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
                                Used for payouts of delivered card and Rozare Wallet orders.
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
                                    <input maxLength={80} className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none" value={accountForm.accountNumber} onChange={(e) => handleAccountChange('accountNumber', e.target.value)} placeholder={paymentAccount?.maskedAccountNumber || 'Enter account number'} />
                                </label>
                                <label className="space-y-1.5">
                                    <span className="text-xs font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>IBAN</span>
                                    <input maxLength={80} className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm uppercase outline-none" value={accountForm.iban} onChange={(e) => handleAccountChange('iban', e.target.value.toUpperCase())} placeholder={paymentAccount?.maskedIban || 'Optional IBAN'} autoComplete="off" />
                                </label>
                                <label className="space-y-1.5">
                                    <span className="text-xs font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>SWIFT / BIC</span>
                                    <input maxLength={20} className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm uppercase outline-none" value={accountForm.swiftCode} onChange={(e) => handleAccountChange('swiftCode', e.target.value.toUpperCase())} placeholder="Optional 8 or 11 character code" autoComplete="off" />
                                </label>
                                <label className="space-y-1.5">
                                    <span className="text-xs font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>Payout bank country</span>
                                    <input maxLength={80} className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none" value={accountForm.country} onChange={(e) => handleAccountChange('country', e.target.value)} placeholder="Pakistan" required />
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
                                    Available now: {formatDisplayMoney(availableInCurrentCurrency)}. Minimum: {formatDisplayMoney(minimumWithdrawalInCurrentCurrency)}
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
                                <span className="text-xs font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>Amount in {sellerCurrency}</span>
                                <input type="number" min={minimumWithdrawalInCurrentCurrency.toFixed(2)} step="0.01" disabled={requesting || withdrawalBlockedByFallback || refreshingSummary} aria-invalid={!!withdrawalInputError} className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none disabled:opacity-60" value={withdrawAmount} onChange={(e) => updateWithdrawAmount(e.target.value)} placeholder="0.00" />
                                {!!withdrawalInputError && <span className="block text-xs mt-1.5" style={{ color: 'hsl(0,72%,55%)' }}>{withdrawalInputError}</span>}
                            </label>
                            <button type="button" disabled={requesting || withdrawalBlockedByFallback || refreshingSummary} className="w-full sm:w-auto sm:self-end px-4 py-2.5 rounded-xl text-sm font-semibold glass-inner disabled:opacity-60" style={{ color: 'hsl(var(--foreground))' }} onClick={() => updateWithdrawAmount(availableInCurrentCurrency.toFixed(2))}>
                                Full balance
                            </button>
                        </div>

                        <button disabled={requesting || withdrawalBlockedByFallback || refreshingSummary || !paymentAccount || !withdrawalInput} className="w-full sm:w-auto px-5 py-3 rounded-xl text-sm font-semibold text-white inline-flex items-center justify-center gap-2 disabled:opacity-60" style={{ background: 'linear-gradient(135deg, hsl(150,60%,45%), hsl(200,80%,45%))' }}>
                            {requesting ? <RefreshCw size={16} className="animate-spin" /> : <Send size={16} />}
                            Send withdrawal request
                        </button>
                    </form>

                    <div className="glass-panel water-shimmer p-4 sm:p-6 min-w-0">
                        <h2 className="text-lg font-bold mb-4" style={{ color: 'hsl(var(--foreground))' }}>Balance Details</h2>
                        <div className="space-y-3">
                            {[
                                ['Card delivered revenue', displayValue('stripeDeliveredRevenue')],
                                ['Wallet delivered revenue', displayValue('walletDeliveredRevenue')],
                                ['Pending online estimate', displayValue('onlinePendingRevenue')],
                                ['Pending withdrawals', displayValue('pendingWithdrawalAmount')],
                                ['Processing withdrawals', displayValue('processingWithdrawalAmount')],
                                ['Already paid out', displayValue('totalWithdrawn')],
                                ['Return-refund reserve', displayValue('returnRefundDebits')],
                                ['Pending COD estimate', displayValue('codPendingRevenue')],
                            ].map(([label, amount]) => (
                                <div key={label} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 text-sm">
                                    <span style={{ color: 'hsl(var(--muted-foreground))' }}>{label}</span>
                                    <span className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{formatDisplayMoney(amount)}</span>
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
                                {withdrawals.map((request) => {
                                    const money = selectWithdrawalHistoryMoney(request);
                                    return (
                                        <tr key={request._id} style={{ borderTop: '1px solid var(--glass-border)' }}>
                                            <td className="py-3 pr-4 whitespace-nowrap" style={{ color: 'hsl(var(--foreground))' }}>{new Date(request.createdAt).toLocaleDateString()}</td>
                                            <td className="py-3 pr-4 whitespace-nowrap" style={{ color: 'hsl(var(--foreground))' }}>
                                                <div className="font-semibold">
                                                    {money.requested
                                                        ? `Requested: ${formatAmount(money.requested.amount, { targetCurrency: money.requested.currency, showCode: true })}`
                                                        : 'Requested amount: Unavailable'}
                                                </div>
                                                {money.status === 'unavailable' && (
                                                    <div className="text-xs mt-1" style={{ color: 'hsl(0,72%,55%)' }}>Expected bank payout: Unavailable</div>
                                                )}
                                                {money.showPayout && money.payout && (
                                                    <div className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                        Expected bank payout: {formatAmount(money.payout.amount, { targetCurrency: money.payout.currency, showCode: true })}
                                                    </div>
                                                )}
                                                {money.status === 'legacy' && (
                                                    <div className="text-xs mt-1" style={{ color: 'hsl(30,90%,45%)' }}>Legacy request: expected bank payout was not frozen.</div>
                                                )}
                                            </td>
                                            <td className="py-3 pr-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                {request.paymentAccountSnapshot?.bankName || 'Bank'} - {request.paymentAccountSnapshot?.accountNumberLast4 ? `**** ${request.paymentAccountSnapshot.accountNumberLast4}` : 'saved account'}
                                            </td>
                                            <td className="py-3 pr-4">
                                                <StatusPill status={request.status} />
                                                {statusDescriptions[request.status] && (
                                                    <p className="mt-1.5 max-w-[15rem] text-xs leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                        {statusDescriptions[request.status]}
                                                    </p>
                                                )}
                                            </td>
                                            <td className="py-3 pr-4 max-w-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{request.adminNote || '-'}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </motion.div>
        </motion.div>
    );
};

export default SellerPayments;
