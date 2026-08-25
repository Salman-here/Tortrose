import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
    adminPaymentsOverviewIsValid,
    selectAdminWithdrawalPresentationMoney,
} from '../../utils/adminPaymentsSafety';
import {
    clearPersistedMutationAttemptFromLedger,
    getOrCreatePersistedMutationAttemptInLedger,
} from '../../utils/persistedMutationAttempt';

const API = `${import.meta.env.VITE_API_URL}api/payments`;
const WITHDRAWAL_OPERATION_STORAGE_KEY = 'rozare_admin_withdrawal_operation_v1';
const statusTransitions = {
    pending: ['approved', 'rejected', 'cancelled'],
    approved: ['processing', 'rejected', 'cancelled'],
    processing: ['paid', 'failed', 'manual_review'],
    manual_review: ['paid', 'failed'],
    failed: ['approved', 'cancelled'],
    paid: [],
    rejected: [],
    cancelled: [],
};

const statusColors = {
    pending: 'hsl(30,90%,50%)',
    approved: 'hsl(220,70%,55%)',
    processing: 'hsl(200,80%,50%)',
    manual_review: 'hsl(275,70%,55%)',
    paid: 'hsl(150,60%,45%)',
    failed: 'hsl(0,72%,55%)',
    rejected: 'hsl(0,72%,55%)',
    cancelled: 'hsl(0,0%,55%)',
};

const statusBackgrounds = {
    pending: 'rgba(249,115,22,0.12)',
    approved: 'rgba(99,102,241,0.12)',
    processing: 'rgba(14,165,233,0.12)',
    manual_review: 'rgba(168,85,247,0.12)',
    paid: 'rgba(16,185,129,0.12)',
    failed: 'rgba(239,68,68,0.12)',
    rejected: 'rgba(239,68,68,0.12)',
    cancelled: 'rgba(148,163,184,0.12)',
};

const localDateTimeValue = (date = new Date()) => {
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

const withdrawalEdit = request => ({
    status: request.status || 'pending',
    adminNote: request.adminNote || '',
    payoutProvider: '',
    attemptId: request.activePayoutAttemptId || '',
    transferReference: '',
    transferredAt: localDateTimeValue(),
    evidenceType: 'provider_reference',
    evidenceUrl: '',
    evidenceNote: '',
    failureCertainty: '',
    failureCode: '',
    failureReason: '',
    reconciliationNote: '',
});

const transitionPayload = (request, edit) => {
    const payload = {
        status: edit.status,
        expectedStatus: request.status,
        adminNote: edit.adminNote || '',
    };
    if (edit.status === 'processing') {
        payload.payoutProvider = edit.payoutProvider;
        if (edit.attemptId) payload.attemptId = edit.attemptId;
    } else if (edit.status === 'manual_review') {
        payload.attemptId = request.activePayoutAttemptId || edit.attemptId;
        payload.payoutProvider = edit.payoutProvider;
        payload.reconciliationNote = edit.reconciliationNote;
    } else if (edit.status === 'failed') {
        payload.attemptId = request.activePayoutAttemptId;
        payload.failureCertainty = edit.failureCertainty;
        payload.failureCode = edit.failureCode;
        payload.failureReason = edit.failureReason;
    } else if (edit.status === 'paid') {
        const transferredAt = edit.transferredAt ? new Date(edit.transferredAt) : null;
        payload.attemptId = request.activePayoutAttemptId;
        payload.payoutProvider = edit.payoutProvider;
        payload.transferReference = edit.transferReference;
        payload.transferredAt = transferredAt && !Number.isNaN(transferredAt.getTime())
            ? transferredAt.toISOString()
            : '';
        payload.evidenceType = edit.evidenceType;
        payload.evidenceUrl = edit.evidenceUrl;
        payload.evidenceNote = edit.evidenceNote;
    }
    return payload;
};

const transitionInputsComplete = (request, edit) => {
    if (!edit || edit.status === request.status) return false;
    if (edit.status === 'processing') return edit.payoutProvider.trim().length >= 2;
    if (edit.status === 'manual_review') {
        const legacy = request.payoutWorkflow?.legacyProcessingQuarantined === true;
        return edit.reconciliationNote.trim().length >= 8
            && (!legacy || edit.payoutProvider.trim().length >= 2);
    }
    if (edit.status === 'failed') {
        return edit.failureCertainty === 'definitively_not_sent'
            && edit.failureReason.trim().length >= 8
            && Boolean(request.activePayoutAttemptId);
    }
    if (edit.status === 'paid') {
        const evidenceDetailRequired = ['receipt', 'bank_statement', 'manual_confirmation']
            .includes(edit.evidenceType);
        return Boolean(request.activePayoutAttemptId)
            && edit.transferReference.trim().length >= 4
            && Boolean(edit.transferredAt)
            && Boolean(edit.evidenceType)
            && (!evidenceDetailRequired
                || edit.evidenceUrl.trim().length > 0
                || edit.evidenceNote.trim().length >= 8);
    }
    return true;
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
        {String(status || 'pending').replaceAll('_', ' ')}
    </span>
);

const AdminPayments = () => {
    const {
        currency,
        exchangeRatesFallback,
        exchangeRatesLoading,
        formatPrice,
        formatAmount,
    } = useCurrency();
    const [loading, setLoading] = useState(true);
    const [savingId, setSavingId] = useState('');
    const [data, setData] = useState(null);
    const [edits, setEdits] = useState({});
    const [loadError, setLoadError] = useState('');
    const overviewRequestRef = useRef({ id: 0, controller: null });

    const fetchOverview = useCallback(async () => {
        const requestId = overviewRequestRef.current.id + 1;
        overviewRequestRef.current.controller?.abort();
        const controller = new AbortController();
        overviewRequestRef.current = { id: requestId, controller };
        setLoading(true);
        setData(null);
        setEdits({});
        setLoadError('');
        try {
            const token = getAuthToken();
            const res = await axios.get(`${API}/admin/overview`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: controller.signal,
            });
            if (overviewRequestRef.current.id !== requestId) return;
            if (!adminPaymentsOverviewIsValid(res.data)) {
                throw new Error('Admin payments returned incomplete or internally inconsistent financial data.');
            }
            setData(res.data);
            const nextEdits = {};
            res.data.withdrawals.forEach((request) => {
                nextEdits[request._id] = withdrawalEdit(request);
            });
            setEdits(nextEdits);
        } catch (error) {
            if (controller.signal.aborted || error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError') return;
            if (overviewRequestRef.current.id !== requestId) return;
            const message = error.response?.data?.msg || error.message || 'Failed to load admin payments';
            setData(null);
            setEdits({});
            setLoadError(message);
            toast.error(message);
        } finally {
            if (overviewRequestRef.current.id === requestId) setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchOverview();
        return () => {
            overviewRequestRef.current.id += 1;
            overviewRequestRef.current.controller?.abort();
        };
    }, [fetchOverview]);

    const updateEdit = (id, field, value) => {
        setEdits((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), [field]: value } }));
    };

    const updateWithdrawal = async (request) => {
        const edit = edits[request._id] || withdrawalEdit(request);
        const confirmationMessages = {
            processing: 'Start a new bank payout attempt using only this withdrawal\'s frozen destination and frozen payout amount?',
            manual_review: 'Place this payout attempt in manual review? The entire amount will remain reserved and no retry can start until it is resolved.',
            failed: 'Confirm that no transfer was completed and release this reservation? Use this only after definitive bank/provider verification.',
            paid: `Permanently mark this withdrawal paid with transfer reference "${edit.transferReference}"? The recorded proof cannot be replaced.`,
        };
        if (confirmationMessages[edit.status] && !window.confirm(confirmationMessages[edit.status])) {
            return;
        }
        const payload = transitionPayload(request, edit);
        const fingerprint = JSON.stringify({ withdrawalId: request._id, ...payload });
        let attempt;
        setSavingId(request._id);
        try {
            attempt = await getOrCreatePersistedMutationAttemptInLedger({
                storage: window.localStorage,
                storageKey: WITHDRAWAL_OPERATION_STORAGE_KEY,
                fingerprint,
                keyPrefix: 'withdrawal-transition',
            });
            const token = getAuthToken();
            await axios.patch(`${API}/admin/withdrawals/${request._id}`, payload, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Idempotency-Key': attempt.key,
                },
            });
            await clearPersistedMutationAttemptFromLedger(
                window.localStorage,
                WITHDRAWAL_OPERATION_STORAGE_KEY,
                fingerprint,
                attempt.key,
            );
            toast.success('Withdrawal updated');
            await fetchOverview();
        } catch (error) {
            if (attempt && error?.response) {
                await clearPersistedMutationAttemptFromLedger(
                    window.localStorage,
                    WITHDRAWAL_OPERATION_STORAGE_KEY,
                    fingerprint,
                    attempt.key,
                ).catch(() => {});
            }
            toast.error(error.response?.data?.msg || 'Failed to update withdrawal');
        } finally {
            setSavingId('');
        }
    };

    const pendingRequests = useMemo(
        () => (data?.withdrawals || []).filter((request) => (
            ['pending', 'approved', 'processing', 'manual_review'].includes(request.status)
        )).length,
        [data]
    );

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <Loader size="default" text="Loading platform payments..." />
            </div>
        );
    }

    if (!data) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-4">
                <div className="glass-panel p-8 text-center max-w-md">
                    <AlertTriangle size={28} className="mx-auto mb-3" style={{ color: 'hsl(30,90%,50%)' }} />
                    <h2 className="text-lg font-bold" style={{ color: 'hsl(var(--foreground))' }}>Payments unavailable</h2>
                    <p className="text-sm mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>{loadError}</p>
                    <button type="button" onClick={fetchOverview} className="mt-4 px-4 py-2 rounded-xl glass-inner text-sm font-semibold">Retry</button>
                </div>
            </div>
        );
    }

    const summary = data.summary;
    const sellers = data.sellers;
    const withdrawals = data.withdrawals;
    const loadErrors = data.errors;
    const selectedCurrencyUnavailable = currency !== 'USD' && (exchangeRatesLoading || exchangeRatesFallback);
    const formatLedgerAmount = (amount) => selectedCurrencyUnavailable
        ? formatAmount(amount, { targetCurrency: 'USD', showCode: true })
        : formatPrice(amount, { sourceCurrency: 'USD' });

    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="px-3 py-4 sm:p-6 max-w-7xl mx-auto space-y-6 overflow-hidden">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="min-w-0">
                    <div className="tag-pill mb-2"><Wallet size={12} /> Admin Payments</div>
                    <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>
                        Seller Payments & Withdrawals
                    </h1>
                    <p className="text-sm mt-1 max-w-2xl" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        Review seller payout accounts, online withdrawable balances, COD revenue, and withdrawal requests.
                    </p>
                </div>
                <button onClick={fetchOverview} className="w-full sm:w-auto px-4 py-2.5 rounded-xl text-sm font-semibold glass-inner inline-flex items-center justify-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                    <RefreshCw size={16} /> Refresh
                </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-4">
                <StatCard label="Platform Online Balance" value={formatLedgerAmount(summary.withdrawableBalance)} icon={<Wallet size={22} />} color="hsl(150,60%,45%)" bg="rgba(16,185,129,0.12)" />
                <StatCard label="Risk-held Balance" value={formatLedgerAmount(summary.paymentRiskHeldAmount)} icon={<AlertTriangle size={22} />} color="hsl(0,72%,55%)" bg="rgba(239,68,68,0.12)" />
                <StatCard label="Delivered COD Revenue" value={formatLedgerAmount(summary.codDeliveredRevenue)} icon={<Banknote size={22} />} color="hsl(30,90%,50%)" bg="rgba(249,115,22,0.12)" />
                <StatCard label="Estimated Revenue" value={formatLedgerAmount(summary.estimatedRevenue)} icon={<TrendingUp size={22} />} color="hsl(220,70%,55%)" bg="rgba(99,102,241,0.12)" />
                <StatCard label="Paid Out" value={formatLedgerAmount(summary.totalWithdrawn)} icon={<CreditCard size={22} />} color="hsl(200,80%,50%)" bg="rgba(14,165,233,0.12)" />
                <StatCard label="Open Requests" value={pendingRequests} icon={<AlertTriangle size={22} />} color="hsl(0,72%,55%)" bg="rgba(239,68,68,0.12)" />
            </div>

            {selectedCurrencyUnavailable && (
                <div className="glass-inner rounded-2xl p-4 flex items-start gap-3" role="alert" style={{ border: '1px solid rgba(249,115,22,0.35)' }}>
                    <AlertTriangle size={18} className="shrink-0 mt-0.5" style={{ color: 'hsl(30,90%,50%)' }} />
                    <p className="text-xs leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        Live {currency} exchange rates are unavailable. Canonical ledger totals remain shown in USD; frozen bank payout amounts below are unchanged.
                    </p>
                </div>
            )}

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
                            Delivered card and Wallet revenue is withdrawable here. COD revenue is shown for reporting only.
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
                                <th className="text-left font-semibold py-3 pr-4">Online balance</th>
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
                                    <td className="py-3 pr-4 font-semibold whitespace-nowrap" style={{ color: 'hsl(150,60%,45%)' }}>
                                        <p>{formatLedgerAmount(row.revenue.withdrawableBalance)}</p>
                                        {row.paymentRiskPending && (
                                            <p className="text-xs mt-1" style={{ color: 'hsl(0,72%,55%)' }}>
                                                Held: {formatLedgerAmount(row.revenue.paymentRiskHeldAmount)}
                                            </p>
                                        )}
                                    </td>
                                    <td className="py-3 pr-4 whitespace-nowrap" style={{ color: 'hsl(var(--foreground))' }}>{formatLedgerAmount(row.revenue.codDeliveredRevenue)}</td>
                                    <td className="py-3 pr-4 whitespace-nowrap" style={{ color: 'hsl(var(--foreground))' }}>{formatLedgerAmount(row.revenue.estimatedRevenue)}</td>
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
                            Every transfer attempt is auditable. Paid requires transfer proof; uncertain outcomes remain fully reserved in manual review.
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
                            const edit = edits[request._id] || withdrawalEdit(request);
                            const presentationMoney = selectAdminWithdrawalPresentationMoney(request);
                            const payoutDestination = request.paymentAccountSnapshot;
                            const payoutBlocked = presentationMoney.payoutBlocked;
                            const attempts = request.payoutAttempts;
                            const activeAttempt = attempts.find(
                                attempt => attempt.attemptId === request.activePayoutAttemptId
                            );
                            const legacyProcessing = request.payoutWorkflow?.legacyProcessingQuarantined === true;
                            const candidateStatuses = legacyProcessing
                                ? ['manual_review']
                                : (statusTransitions[request.status] || []);
                            const nextStatuses = candidateStatuses.filter((status) => {
                                if (!payoutBlocked) return true;
                                if (['approved', 'processing'].includes(status)) return false;
                                if (status === 'paid' && !activeAttempt?.legacyImported) return false;
                                return true;
                            });
                            const isTerminal = nextStatuses.length === 0;
                            const canSubmit = transitionInputsComplete(request, edit);
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
                                                {request.seller?.username || 'Seller'} requested {formatAmount(presentationMoney.requested.amount, { targetCurrency: presentationMoney.requested.currency, showCode: true })}
                                            </p>
                                            {presentationMoney.payout ? (
                                                <p className="text-sm mt-1 font-semibold" style={{ color: 'hsl(150,60%,40%)' }}>
                                                    Frozen bank payout: {formatAmount(presentationMoney.payout.amount, { targetCurrency: presentationMoney.payout.currency, showCode: true })}
                                                </p>
                                            ) : (
                                                <p className="text-xs mt-1 font-semibold" style={{ color: 'hsl(30,90%,45%)' }}>
                                                    Legacy request: no frozen bank payout amount is available. Reconcile it manually; do not estimate a transfer from live or fallback FX.
                                                </p>
                                            )}
                                            {presentationMoney.requested.currency !== 'USD' && (
                                                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                    Reserved ledger amount: {formatPrice(presentationMoney.ledger.amount, { sourceCurrency: 'USD', targetCurrency: 'USD', showCode: true })}
                                                </p>
                                            )}
                                            <p className="text-xs mt-1 break-words" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                {request.seller?.email || ''}{request.sellerNote ? ` - Seller note: ${request.sellerNote}` : ''}
                                            </p>
                                        </div>
                                        <div className="text-xs leading-relaxed min-w-0" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            <p className="font-semibold text-sm mb-1" style={{ color: 'hsl(var(--foreground))' }}>
                                                {payoutDestination.bankName || 'Bank account'}
                                            </p>
                                            <p>{payoutDestination.accountHolderName || 'Account holder'}</p>
                                            <p>
                                                {payoutDestination.accountNumber
                                                    ? `Account: ${payoutDestination.accountNumber}`
                                                    : payoutDestination.accountNumberLast4
                                                        ? `Account: **** ${payoutDestination.accountNumberLast4}`
                                                        : 'No frozen account number'}
                                            </p>
                                            {payoutDestination.iban
                                                ? <p>IBAN: {payoutDestination.iban}</p>
                                                : payoutDestination.ibanLast4 && <p>IBAN: **** {payoutDestination.ibanLast4}</p>}
                                            {payoutDestination.swiftCode && <p>SWIFT: {payoutDestination.swiftCode}</p>}
                                            {payoutDestination.country && <p>Country: {payoutDestination.country}</p>}
                                            {payoutDestination.payoutInstructions && (
                                                <p className="mt-1 break-words">Instructions: {payoutDestination.payoutInstructions}</p>
                                            )}
                                            {legacyProcessing && (
                                                <p className="mt-2 font-semibold" style={{ color: 'hsl(275,70%,55%)' }}>
                                                    Legacy processing outcome is unknown. Quarantine it in manual review; do not initiate another transfer.
                                                </p>
                                            )}
                                            {payoutBlocked && (
                                                <p className="mt-2 font-semibold" style={{ color: 'hsl(0,72%,55%)' }}>
                                                    Frozen payout details are missing or unreadable. Payout advancement is blocked; do not use the seller&apos;s current account.
                                                </p>
                                            )}
                                            {activeAttempt && (
                                                <div className="mt-2 pt-2 border-t" style={{ borderColor: 'var(--glass-border)' }}>
                                                    <p className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
                                                        Active attempt #{activeAttempt.sequence}: {activeAttempt.provider}
                                                    </p>
                                                    <p className="break-all">ID: {activeAttempt.attemptId}</p>
                                                    {activeAttempt.reconciliationNote && <p>Review: {activeAttempt.reconciliationNote}</p>}
                                                </div>
                                            )}
                                            {attempts.length > 0 && (
                                                <details className="mt-2 pt-2 border-t" style={{ borderColor: 'var(--glass-border)' }}>
                                                    <summary className="font-semibold cursor-pointer" style={{ color: 'hsl(var(--foreground))' }}>
                                                        Payout attempt history ({attempts.length})
                                                    </summary>
                                                    <div className="mt-2 space-y-2">
                                                        {[...attempts].reverse().map((attempt) => (
                                                            <div key={attempt.attemptId} className="glass-inner rounded-lg p-2 break-words">
                                                                <p className="font-semibold">
                                                                    #{attempt.sequence} · {String(attempt.status).replaceAll('_', ' ')} · {attempt.provider}
                                                                </p>
                                                                <p>{new Date(attempt.startedAt).toLocaleString()}</p>
                                                                {attempt.transferReference && <p>Reference: {attempt.transferReference}</p>}
                                                                {attempt.failureCode && <p>Failure code: {attempt.failureCode}</p>}
                                                                {attempt.failureReason && <p>Failure: {attempt.failureReason}</p>}
                                                                {attempt.reconciliationNote && <p>Review: {attempt.reconciliationNote}</p>}
                                                                {attempt.evidence?.type && <p>Evidence: {attempt.evidence.type.replaceAll('_', ' ')}</p>}
                                                                {attempt.evidence?.note && <p>Evidence note: {attempt.evidence.note}</p>}
                                                                {attempt.evidence?.url && (
                                                                    <a
                                                                        href={attempt.evidence.url}
                                                                        target="_blank"
                                                                        rel="noreferrer noopener"
                                                                        className="underline break-all"
                                                                    >
                                                                        Open evidence
                                                                    </a>
                                                                )}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </details>
                                            )}
                                            {request.status === 'paid' && request.paidTransferReference && (
                                                <div className="mt-2 pt-2 border-t" style={{ borderColor: 'var(--glass-border)' }}>
                                                    <p className="font-semibold" style={{ color: 'hsl(150,60%,40%)' }}>
                                                        Paid via {request.paidPayoutProvider}
                                                    </p>
                                                    <p className="break-all">Transfer reference: {request.paidTransferReference}</p>
                                                </div>
                                            )}
                                        </div>
                                        <div className="space-y-3 min-w-0">
                                            <select
                                                className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none"
                                                value={edit.status}
                                                onChange={(e) => updateEdit(request._id, 'status', e.target.value)}
                                                disabled={isTerminal}
                                            >
                                                <option value={request.status}>{request.status.replaceAll('_', ' ')}</option>
                                                {nextStatuses.map((status) => (
                                                    <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>
                                                ))}
                                            </select>
                                            <input
                                                className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none"
                                                value={edit.adminNote}
                                                onChange={(e) => updateEdit(request._id, 'adminNote', e.target.value)}
                                                placeholder="Seller-visible admin note (optional)"
                                            />
                                            {edit.status === 'processing' && (
                                                <input
                                                    className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none"
                                                    value={edit.payoutProvider}
                                                    onChange={(e) => updateEdit(request._id, 'payoutProvider', e.target.value)}
                                                    placeholder="Payout provider / bank transfer rail"
                                                />
                                            )}
                                            {edit.status === 'manual_review' && (
                                                <>
                                                    {legacyProcessing && (
                                                        <input
                                                            className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none"
                                                            value={edit.payoutProvider}
                                                            onChange={(e) => updateEdit(request._id, 'payoutProvider', e.target.value)}
                                                            placeholder="Original payout provider / bank"
                                                        />
                                                    )}
                                                    <textarea
                                                        className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none resize-y"
                                                        value={edit.reconciliationNote}
                                                        onChange={(e) => updateEdit(request._id, 'reconciliationNote', e.target.value)}
                                                        placeholder="Explain why the transfer outcome is uncertain (minimum 8 characters)"
                                                        rows={3}
                                                    />
                                                </>
                                            )}
                                            {edit.status === 'failed' && (
                                                <>
                                                    <input
                                                        className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none"
                                                        value={edit.failureCode}
                                                        onChange={(e) => updateEdit(request._id, 'failureCode', e.target.value)}
                                                        placeholder="Provider failure code (optional)"
                                                    />
                                                    <textarea
                                                        className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none resize-y"
                                                        value={edit.failureReason}
                                                        onChange={(e) => updateEdit(request._id, 'failureReason', e.target.value)}
                                                        placeholder="Definitive evidence that no transfer was sent"
                                                        rows={3}
                                                    />
                                                    <label className="flex items-start gap-2 text-xs font-semibold" style={{ color: 'hsl(0,72%,45%)' }}>
                                                        <input
                                                            type="checkbox"
                                                            className="mt-0.5"
                                                            checked={edit.failureCertainty === 'definitively_not_sent'}
                                                            onChange={(e) => updateEdit(
                                                                request._id,
                                                                'failureCertainty',
                                                                e.target.checked ? 'definitively_not_sent' : ''
                                                            )}
                                                        />
                                                        I verified that no bank transfer was completed. This releases the seller&apos;s reservation.
                                                    </label>
                                                </>
                                            )}
                                            {edit.status === 'paid' && (
                                                <>
                                                    <p className="text-xs font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                        Resolving attempt through {activeAttempt?.provider || 'the recorded provider'}
                                                    </p>
                                                    <input
                                                        className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none"
                                                        value={edit.transferReference}
                                                        onChange={(e) => updateEdit(request._id, 'transferReference', e.target.value)}
                                                        placeholder="Unique provider transfer reference"
                                                    />
                                                    <input
                                                        type="datetime-local"
                                                        className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none"
                                                        value={edit.transferredAt}
                                                        onChange={(e) => updateEdit(request._id, 'transferredAt', e.target.value)}
                                                    />
                                                    <select
                                                        className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none"
                                                        value={edit.evidenceType}
                                                        onChange={(e) => updateEdit(request._id, 'evidenceType', e.target.value)}
                                                    >
                                                        <option value="provider_reference">Provider reference</option>
                                                        <option value="receipt">Transfer receipt</option>
                                                        <option value="bank_statement">Bank statement</option>
                                                        <option value="manual_confirmation">Manual confirmation</option>
                                                    </select>
                                                    <input
                                                        type="url"
                                                        className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none"
                                                        value={edit.evidenceUrl}
                                                        onChange={(e) => updateEdit(request._id, 'evidenceUrl', e.target.value)}
                                                        placeholder="HTTPS evidence link (optional for provider reference)"
                                                    />
                                                    <textarea
                                                        className="w-full min-w-0 glass-inner rounded-xl px-3 py-2.5 text-sm outline-none resize-y"
                                                        value={edit.evidenceNote}
                                                        onChange={(e) => updateEdit(request._id, 'evidenceNote', e.target.value)}
                                                        placeholder="Evidence details"
                                                        rows={2}
                                                    />
                                                </>
                                            )}
                                        </div>
                                        <button
                                            disabled={savingId === request._id || !canSubmit}
                                            onClick={() => updateWithdrawal(request)}
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
