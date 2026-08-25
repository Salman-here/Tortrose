const mongoose = require('mongoose');
const { createHash, randomUUID } = require('crypto');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Store = require('../models/Store');
const User = require('../models/User');
const SellerPaymentAccount = require('../models/SellerPaymentAccount');
const SellerWithdrawalRequest = require('../models/SellerWithdrawalRequest');
const SellerBalanceTransaction = require('../models/SellerBalanceTransaction');
const SellerSettlementLock = require('../models/SellerSettlementLock');
const SellerPaymentRiskHold = require('../models/SellerPaymentRiskHold');
const {
    normalizeCurrency,
    formatMoneySync,
    getExchangeRateSnapshot,
    convertAmountWithRates,
    exchangeRatesUnavailableError,
    isSupportedCurrency,
} = require('../services/currencyService');
const { runInTransaction } = require('../services/walletService');
const {
    enqueueWithdrawalRequestedAdminNotifications,
    enqueueWithdrawalRequestedSellerNotifications,
    enqueueWithdrawalStatusSellerNotifications,
} = require('../services/financialNotificationOutboxService');
const {
    ensureOrderSellerSettlement,
    sellerOrderSummaryForItems,
    sellerSettlementEntry,
    sellerFulfillmentStatus,
    getOrderCurrency,
    getOrderExchangeRates,
} = require('../services/orderMoneyService');
const {
    allocateConvertedMinorUnitsByRates,
    fromMinorUnits,
    roundMoney,
    toMinorUnits,
} = require('../services/moneyMath');
const { parseStrictFiniteNumber } = require('../services/numericInputService');
const {
    SNAPSHOT_VERSION: PAYOUT_ACCOUNT_SNAPSHOT_VERSION,
    sealPayoutAccountSnapshot,
    openPayoutAccountSnapshot,
    invalidDestinationError,
} = require('../services/payoutAccountSnapshotService');
const {
    enqueuePayoutAccountUpdatedNotification,
} = require('../services/sellerOperationalNotificationService');
const {
    lastFourDestinationCharacters,
    mergeAndValidatePayoutAccountUpdate,
    validatePayoutAccountDestination,
} = require('../services/payoutAccountValidationService');

const ACTIVE_WITHDRAWAL_STATUSES = ['pending', 'approved', 'processing', 'manual_review', 'paid'];
const WITHDRAWAL_TRANSITIONS = Object.freeze({
    pending: new Set(['approved', 'rejected', 'cancelled']),
    approved: new Set(['processing', 'rejected', 'cancelled']),
    // An unknown transfer outcome remains reserved in manual review. Only a
    // definitive no-transfer result can release it as failed.
    processing: new Set(['paid', 'failed', 'manual_review']),
    manual_review: new Set(['paid', 'failed']),
    // A definitive failure released the reservation. Re-approval rechecks and
    // reserves the current balance before a new, separately identified attempt.
    failed: new Set(['approved', 'cancelled']),
    paid: new Set(),
    rejected: new Set(),
    cancelled: new Set(),
});
const canTransitionWithdrawalStatus = (fromStatus, toStatus) => (
    WITHDRAWAL_TRANSITIONS[fromStatus]?.has(toStatus) || false
);
const MIN_WITHDRAWAL_USD = 5;

const toId = (value) => value?._id?.toString?.() || value?.toString?.() || '';
const isDelivered = (order) => order?.orderStatus === 'delivered' || order?.isDelivered === true;
const isDeliveredForSeller = (order, sellerId) => {
    const sellerEntry = (order?.sellerFulfillment || []).find(
        (entry) => toId(entry.seller) === toId(sellerId)
    );
    return sellerEntry ? sellerEntry.status === 'delivered' : isDelivered(order);
};
const isLiveOrder = (order) => order?.awaitingPayment !== true && order?.orderStatus !== 'cancelled';
const isLiveOrderForSeller = (order, sellerId) => {
    if (!isLiveOrder(order)) return false;
    const sellerEntry = (order?.sellerFulfillment || []).find(
        (entry) => toId(entry.seller) === toId(sellerId)
    );
    return !sellerEntry || sellerEntry.status !== 'cancelled';
};
const formatNativeMoney = (amount, currency) =>
    formatMoneySync(amount, currency, { sourceCurrency: currency });

const storedFinancialDataError = label => {
    const error = new Error(`Stored ${label} is invalid. Financial processing is blocked until it is corrected.`);
    error.statusCode = 409;
    error.code = 'SELLER_FINANCIAL_DATA_INVALID';
    return error;
};

const requireStoredExactMoney = (value, label, { minimum = 0 } = {}) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
        throw storedFinancialDataError(label);
    }
    try {
        if (roundMoney(value) !== value) throw storedFinancialDataError(label);
    } catch (error) {
        if (error?.code === 'SELLER_FINANCIAL_DATA_INVALID') throw error;
        throw storedFinancialDataError(label);
    }
    return value;
};

const requireStoredWithdrawalVersion = (value, label) => {
    // Version fields were absent before the frozen-snapshot/auditable-payout
    // migrations. Only a genuinely absent field is legacy version 0; a
    // present string/null/boolean must not be coerced into an authoritative
    // workflow version while reading raw or lean MongoDB documents.
    if (value === undefined) return 0;
    if (!Number.isSafeInteger(value) || ![0, 1].includes(value)) {
        throw storedFinancialDataError(label);
    }
    return value;
};

const addSafeMinorUnits = (left, right, label) => {
    const total = left + right;
    if (!Number.isSafeInteger(total)) throw storedFinancialDataError(label);
    return total;
};

const queryWithSession = (query, session) => (session ? query.session(session) : query);

const normalizeWithdrawalAmount = (rawAmount) => {
    if (
        rawAmount === null
        || rawAmount === undefined
        || typeof rawAmount === 'boolean'
        || (typeof rawAmount === 'string' && !rawAmount.trim())
    ) {
        const error = new Error('Withdrawal amount must be greater than zero');
        error.statusCode = 400;
        throw error;
    }

    const numericAmount = parseStrictFiniteNumber(rawAmount);
    if (numericAmount === null || numericAmount <= 0) {
        const error = new Error('Withdrawal amount must be greater than zero');
        error.statusCode = 400;
        throw error;
    }

    try {
        const roundedAmount = roundMoney(numericAmount);
        if (roundedAmount <= 0) {
            const error = new Error('Withdrawal amount must be at least 0.01');
            error.statusCode = 400;
            throw error;
        }
        return roundedAmount;
    } catch (error) {
        if (error?.code === 'MONEY_AMOUNT_OUT_OF_RANGE') {
            error.message = 'Withdrawal amount is too large.';
            error.statusCode = 400;
        }
        throw error;
    }
};

const quoteWithdrawalAmount = ({ body = {}, userCurrency = 'USD', rates = {} } = {}) => {
    const rawRequestedCurrency = body.requestedCurrency
        ?? body.currency
        ?? userCurrency
        ?? 'USD';
    if (
        typeof rawRequestedCurrency !== 'string'
        || !rawRequestedCurrency.trim()
        || !isSupportedCurrency(rawRequestedCurrency)
    ) {
        const error = new Error('Choose a supported withdrawal currency.');
        error.statusCode = 400;
        throw error;
    }
    const requestedCurrency = normalizeCurrency(rawRequestedCurrency);
    const requestedAmount = normalizeWithdrawalAmount(body.requestedAmount ?? body.amount);
    return {
        requestedCurrency,
        requestedAmount,
        // amountUSD from the client is deliberately ignored. The server owns
        // the conversion used for minimum and available-balance checks. Use
        // the same cent-normalized source amount that is shown and persisted.
        amountUSD: convertAmountWithRates(requestedAmount, requestedCurrency, 'USD', rates),
    };
};

const quotePayoutAmount = (amountUSD, payoutCurrency, rates = {}) => {
    if (!isSupportedCurrency(payoutCurrency)) {
        const error = new Error('The saved payout account has an unsupported currency.');
        error.statusCode = 400;
        throw error;
    }
    return {
        payoutCurrency: normalizeCurrency(payoutCurrency),
        payoutAmount: convertAmountWithRates(
            amountUSD,
            'USD',
            normalizeCurrency(payoutCurrency),
            rates
        ),
    };
};

// A straight USD -> requested-currency quote is rounded in the requested
// currency. At some live rates that rounded amount converts back to $4.99,
// even though the API advertises it as the $5.00 minimum. Move upward by whole
// requested-currency cents until the exact amount we display and accept quotes
// back to at least the canonical USD minimum.
const minimumRequestedAmountForUSD = (amountUSD, requestedCurrency, rates = {}) => {
    const normalizedCurrency = normalizeCurrency(requestedCurrency);
    let requestedMinor = toMinorUnits(convertAmountWithRates(
        amountUSD,
        'USD',
        normalizedCurrency,
        rates
    ));
    const requiredUSDMinor = toMinorUnits(amountUSD);

    // Nearest-cent conversion can undershoot by at most half a requested-
    // currency cent, so one increment is normally sufficient. Keep a small
    // defensive bound so malformed rate tables can never create an open loop.
    for (let attempts = 0; attempts < 4; attempts += 1) {
        const roundTripUSD = convertAmountWithRates(
            fromMinorUnits(requestedMinor),
            normalizedCurrency,
            'USD',
            rates
        );
        if (toMinorUnits(roundTripUSD) >= requiredUSDMinor) {
            return fromMinorUnits(requestedMinor);
        }
        requestedMinor += 1;
    }

    throw exchangeRatesUnavailableError();
};

const withdrawalRatesUnavailableError = () => {
    const error = exchangeRatesUnavailableError();
    error.message = 'Live exchange rates are temporarily unavailable. Please retry the withdrawal shortly.';
    return error;
};

const legacyOrderFxBackfillRequiredError = () => {
    const error = new Error(
        'A legacy foreign-currency order is missing its checkout exchange-rate snapshot. Financial processing is quarantined until an audited backfill is completed.'
    );
    error.statusCode = 409;
    error.code = 'LEGACY_ORDER_FX_BACKFILL_REQUIRED';
    return error;
};

// A provider outage must not block a withdrawal that genuinely performs no FX.
// Both legs must remain USD; otherwise the emergency fallback table would
// permanently determine either the seller's reservation or bank payout.
const assertWithdrawalQuoteCanUseSnapshot = (snapshot, requestedCurrency, payoutCurrency) => {
    if (snapshot?.fallback !== true) return;
    if (
        normalizeCurrency(requestedCurrency) === 'USD'
        && normalizeCurrency(payoutCurrency) === 'USD'
    ) return;
    throw withdrawalRatesUnavailableError();
};

const isSameWithdrawalRequest = (existingRequest, requestedAmount, requestedCurrency) => (
    (() => {
        if (
            !existingRequest
            || !isSupportedCurrency(requestedCurrency)
            || normalizeCurrency(requestedCurrency) !== existingRequest.requestedCurrency
        ) return false;
        try {
            return normalizeWithdrawalAmount(requestedAmount) === roundMoney(existingRequest.requestedAmount);
        } catch (_) {
            return false;
        }
    })()
);

const cleanText = (value, max = 500) => String(value || '').trim().slice(0, max);
const payoutAccountState = value => ({
    accountHolderName: cleanText(value?.accountHolderName, 120),
    bankName: cleanText(value?.bankName, 120),
    accountNumber: cleanText(value?.accountNumber, 80),
    iban: cleanText(value?.iban, 80),
    swiftCode: cleanText(value?.swiftCode, 20).toUpperCase(),
    country: cleanText(value?.country, 80),
    countryCode: cleanText(value?.countryCode, 2).toUpperCase(),
    currency: normalizeCurrency(value?.currency || 'USD'),
    payoutInstructions: cleanText(value?.payoutInstructions, 500),
    isActive: value?.isActive !== false,
});
const payoutAccountFingerprint = value => createHash('sha256')
    .update(JSON.stringify(payoutAccountState(value)))
    .digest('hex');

const withdrawalActionError = (message, code, statusCode = 400, extra = {}) => {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    Object.assign(error, extra);
    return error;
};

const strictActionText = (
    value,
    label,
    { required = false, min = 1, max = 500 } = {}
) => {
    if (value === null || value === undefined || value === '') {
        if (!required) return '';
        throw withdrawalActionError(`${label} is required.`, 'WITHDRAWAL_ACTION_INPUT_REQUIRED');
    }
    if (typeof value !== 'string') {
        throw withdrawalActionError(`${label} must be text.`, 'WITHDRAWAL_ACTION_INPUT_INVALID');
    }
    const normalized = value.trim();
    if ((required && normalized.length < min) || normalized.length > max) {
        throw withdrawalActionError(
            `${label} must contain between ${min} and ${max} characters.`,
            'WITHDRAWAL_ACTION_INPUT_INVALID'
        );
    }
    return normalized;
};

const normalizeWithdrawalOperationKey = (req) => {
    const key = strictActionText(
        req.get?.('Idempotency-Key') || req.body?.operationKey,
        'Withdrawal operation key',
        { required: true, min: 16, max: 200 }
    );
    if (!/^[A-Za-z0-9:_-]+$/.test(key)) {
        throw withdrawalActionError(
            'Withdrawal operation key contains unsupported characters.',
            'WITHDRAWAL_OPERATION_KEY_INVALID'
        );
    }
    return key;
};

const normalizeEvidenceUrl = (rawUrl) => {
    const value = strictActionText(rawUrl, 'Evidence URL', { max: 1000 });
    if (!value) return '';
    let parsed;
    try {
        parsed = new URL(value);
    } catch (_) {
        throw withdrawalActionError(
            'Evidence URL must be a valid HTTPS URL.',
            'WITHDRAWAL_EVIDENCE_URL_INVALID'
        );
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        throw withdrawalActionError(
            'Evidence URL must be a valid HTTPS URL without embedded credentials.',
            'WITHDRAWAL_EVIDENCE_URL_INVALID'
        );
    }
    return parsed.toString();
};

const normalizeWithdrawalAction = (body = {}) => {
    const expectedStatus = strictActionText(body.expectedStatus, 'Expected withdrawal status', {
        required: true,
        max: 30,
    });
    const status = strictActionText(body.status, 'Withdrawal status', {
        required: true,
        max: 30,
    });
    const transferredAtText = strictActionText(body.transferredAt, 'Transfer timestamp', {
        max: 80,
    });
    let transferredAt = '';
    if (transferredAtText) {
        const date = new Date(transferredAtText);
        if (Number.isNaN(date.getTime())) {
            throw withdrawalActionError(
                'Transfer timestamp is invalid.',
                'WITHDRAWAL_TRANSFER_TIMESTAMP_INVALID'
            );
        }
        transferredAt = date.toISOString();
    }

    const action = {
        status,
        expectedStatus,
        adminNote: strictActionText(body.adminNote, 'Admin note', { max: 1000 }),
        payoutProvider: strictActionText(body.payoutProvider, 'Payout provider', { max: 120 }),
        attemptId: strictActionText(body.attemptId, 'Payout attempt ID', { max: 200 }),
        transferReference: strictActionText(
            body.transferReference,
            'Transfer reference',
            { max: 200 }
        ),
        evidenceType: strictActionText(body.evidenceType, 'Evidence type', { max: 40 }),
        evidenceUrl: normalizeEvidenceUrl(body.evidenceUrl),
        evidenceNote: strictActionText(body.evidenceNote, 'Evidence note', { max: 1000 }),
        transferredAt,
        failureCertainty: strictActionText(
            body.failureCertainty,
            'Failure certainty',
            { max: 40 }
        ),
        failureCode: strictActionText(body.failureCode, 'Failure code', { max: 120 }),
        failureReason: strictActionText(body.failureReason, 'Failure reason', { max: 1000 }),
        reconciliationNote: strictActionText(
            body.reconciliationNote,
            'Reconciliation note',
            { max: 1000 }
        ),
    };
    for (const [field, value] of Object.entries({
        status: action.status,
        expectedStatus: action.expectedStatus,
        payoutProvider: action.payoutProvider,
        attemptId: action.attemptId,
        transferReference: action.transferReference,
        evidenceType: action.evidenceType,
        failureCertainty: action.failureCertainty,
        failureCode: action.failureCode,
    })) {
        if (/[\u0000-\u001F\u007F]/.test(value)) {
            throw withdrawalActionError(
                `${field} contains unsupported control characters.`,
                'WITHDRAWAL_ACTION_INPUT_INVALID'
            );
        }
    }
    if (action.attemptId && !/^[A-Za-z0-9:_-]+$/.test(action.attemptId)) {
        throw withdrawalActionError(
            'Payout attempt ID contains unsupported characters.',
            'WITHDRAWAL_PAYOUT_ATTEMPT_ID_INVALID'
        );
    }
    return action;
};

const withdrawalActionFingerprint = action => createHash('sha256')
    .update(JSON.stringify(action))
    .digest('hex');

const findAdminOperation = (request, operationKey) => (
    (request?.adminOperations || []).find(operation => operation.operationKey === operationKey)
);

const assertOperationReplayMatches = (operation, fingerprint) => {
    if (operation && operation.payloadFingerprint !== fingerprint) {
        throw withdrawalActionError(
            'This withdrawal operation key was already used for a different action.',
            'WITHDRAWAL_OPERATION_IDEMPOTENCY_CONFLICT',
            409
        );
    }
};

const findPayoutAttempt = (request, attemptId) => (
    (request?.payoutAttempts || []).find(attempt => attempt.attemptId === attemptId)
);

const requireMatchingActivePayoutAttempt = (request, suppliedAttemptId) => {
    const activeAttemptId = String(request?.activePayoutAttemptId || '');
    if (!activeAttemptId || !suppliedAttemptId || suppliedAttemptId !== activeAttemptId) {
        throw withdrawalActionError(
            'The payout attempt ID is missing or stale. Refresh before resolving this transfer.',
            'WITHDRAWAL_PAYOUT_ATTEMPT_MISMATCH',
            409
        );
    }
    const attempt = findPayoutAttempt(request, activeAttemptId);
    if (!attempt || !['processing', 'manual_review'].includes(attempt.status)) {
        throw withdrawalActionError(
            'The active payout attempt is missing or inconsistent. Manual reconciliation is required.',
            'WITHDRAWAL_PAYOUT_ATTEMPT_INVALID',
            409
        );
    }
    return attempt;
};

const isLegacyProcessingWithdrawal = request => {
    if (request?.status !== 'processing') return false;
    const workflowVersion = requireStoredWithdrawalVersion(
        request?.payoutWorkflowVersion,
        'withdrawal payout workflow version'
    );
    return (
        workflowVersion !== 1
        || !request?.activePayoutAttemptId
        || !findPayoutAttempt(request, request.activePayoutAttemptId)
    );
};

const maskFromLast4 = (suffix) => suffix ? `**** ${suffix}` : '';

const serializePaymentAccount = (account, { includeSensitive = false } = {}) => {
    if (!account) return null;
    const doc = account.toObject ? account.toObject() : account;
    const rawCurrency = doc.currency ?? 'USD';
    if (
        typeof rawCurrency !== 'string'
        || rawCurrency !== rawCurrency.trim().toUpperCase()
        || !isSupportedCurrency(rawCurrency)
    ) {
        throw storedFinancialDataError('payout account currency');
    }
    const base = {
        _id: doc._id,
        accountHolderName: doc.accountHolderName || '',
        bankName: doc.bankName || '',
        accountNumberLast4: doc.accountNumberLast4 || '',
        ibanLast4: doc.ibanLast4 || '',
        maskedAccountNumber: maskFromLast4(doc.accountNumberLast4),
        maskedIban: maskFromLast4(doc.ibanLast4),
        swiftCode: doc.swiftCode || '',
        country: doc.country || '',
        countryCode: doc.countryCode || '',
        currency: normalizeCurrency(rawCurrency),
        payoutInstructions: doc.payoutInstructions || '',
        isActive: doc.isActive !== false,
        updatedAt: doc.updatedAt,
    };
    if (includeSensitive) {
        base.accountNumber = doc.accountNumber || '';
        base.iban = doc.iban || '';
    }
    return base;
};

const completePayoutAccountSnapshot = (account) => {
    const rawCurrency = account?.currency;
    if (
        typeof rawCurrency !== 'string'
        || !isSupportedCurrency(rawCurrency)
        || rawCurrency !== normalizeCurrency(rawCurrency)
    ) {
        const error = new Error(
            'Your saved payout account has an unsupported currency. Re-save the bank details before requesting a withdrawal.'
        );
        error.statusCode = 400;
        error.code = 'PAYOUT_ACCOUNT_CURRENCY_UNSUPPORTED';
        throw error;
    }
    let validated;
    try {
        validated = validatePayoutAccountDestination({
            accountHolderName: account?.accountHolderName,
            bankName: account?.bankName,
            accountNumber: account?.accountNumber,
            iban: account?.iban,
            swiftCode: account?.swiftCode,
            country: account?.countryCode || account?.country,
            currency: rawCurrency,
            payoutInstructions: account?.payoutInstructions,
        });
    } catch (_validationError) {
        const error = new Error(
            'Your saved payout account is incomplete or invalid. Re-save the full bank details before requesting a withdrawal.'
        );
        error.statusCode = 400;
        error.code = 'PAYOUT_ACCOUNT_DETAILS_INCOMPLETE';
        throw error;
    }
    const snapshot = {
        paymentAccountId: toId(account?._id),
        ...validated,
        accountUpdatedAt: account?.updatedAt ? new Date(account.updatedAt).toISOString() : null,
        capturedAt: new Date().toISOString(),
    };
    return snapshot;
};

const payoutSnapshotMetadata = (snapshot) => ({
    accountHolderName: snapshot.accountHolderName,
    bankName: snapshot.bankName,
    accountNumberLast4: lastFourDestinationCharacters(snapshot.accountNumber),
    ibanLast4: lastFourDestinationCharacters(snapshot.iban),
    swiftCode: snapshot.swiftCode,
    country: snapshot.country,
    countryCode: snapshot.countryCode,
    currency: snapshot.currency,
});

const withdrawalAuthorizationContext = (request) => {
    const doc = request?.toObject ? request.toObject() : request;
    const capturedAt = doc?.exchangeRateSnapshot?.capturedAt;
    const capturedDate = capturedAt ? new Date(capturedAt) : null;
    if (!capturedDate || Number.isNaN(capturedDate.getTime())) {
        throw new Error('Invalid withdrawal exchange-rate timestamp');
    }

    const canonicalRate = (currency) => {
        const raw = doc?.exchangeRateSnapshot?.rates?.[currency];
        if (raw === null || raw === undefined) return null;
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) {
            throw new Error('Invalid withdrawal exchange rate');
        }
        return String(value);
    };

    return {
        idempotencyKey: String(doc?.idempotencyKey || ''),
        amountUSDMinor: toMinorUnits(doc?.amount),
        currency: String(doc?.currency || ''),
        requestedAmountMinor: toMinorUnits(doc?.requestedAmount),
        requestedCurrency: String(doc?.requestedCurrency || ''),
        payoutAmountMinor: toMinorUnits(doc?.payoutAmount),
        payoutCurrency: String(doc?.payoutCurrency || ''),
        exchangeRateSnapshot: {
            base: String(doc?.exchangeRateSnapshot?.base || ''),
            rates: {
                USD: canonicalRate('USD'),
                PKR: canonicalRate('PKR'),
                EUR: canonicalRate('EUR'),
                GBP: canonicalRate('GBP'),
            },
            capturedAt: capturedDate.toISOString(),
            source: String(doc?.exchangeRateSnapshot?.source || ''),
            fallback: doc?.exchangeRateSnapshot?.fallback === true,
        },
    };
};

const assertFrozenPayoutAuthorization = (request, snapshot, authorization) => {
    const exactCurrency = (value) => {
        const raw = String(value || '');
        return isSupportedCurrency(raw) && raw === normalizeCurrency(raw);
    };
    if (
        authorization.currency !== 'USD'
        || authorization.amountUSDMinor < toMinorUnits(MIN_WITHDRAWAL_USD)
        || authorization.requestedAmountMinor <= 0
        || authorization.payoutAmountMinor <= 0
        || !exactCurrency(authorization.requestedCurrency)
        || !exactCurrency(authorization.payoutCurrency)
        || authorization.exchangeRateSnapshot.base !== 'USD'
        || authorization.exchangeRateSnapshot.rates.USD !== '1'
        || String(snapshot.currency || '') !== authorization.payoutCurrency
    ) {
        throw invalidDestinationError('WITHDRAWAL_PAYOUT_AUTHORIZATION_INVALID');
    }

    const fallback = authorization.exchangeRateSnapshot.fallback;
    const rateStrings = authorization.exchangeRateSnapshot.rates;
    if (fallback) {
        if (
            authorization.requestedCurrency !== 'USD'
            || authorization.payoutCurrency !== 'USD'
            || rateStrings.PKR !== null
            || rateStrings.EUR !== null
            || rateStrings.GBP !== null
        ) {
            throw invalidDestinationError('WITHDRAWAL_PAYOUT_AUTHORIZATION_INVALID');
        }
    } else if (['PKR', 'EUR', 'GBP'].some(currency => rateStrings[currency] === null)) {
        throw invalidDestinationError('WITHDRAWAL_PAYOUT_AUTHORIZATION_INVALID');
    }

    const rates = Object.fromEntries(
        Object.entries(rateStrings).map(([currency, value]) => [
            currency,
            value === null ? null : Number(value),
        ])
    );
    const expectedPayoutMinor = toMinorUnits(convertAmountWithRates(
        fromMinorUnits(authorization.amountUSDMinor),
        'USD',
        authorization.payoutCurrency,
        rates
    ));
    const requestedQuoteUSDMinor = toMinorUnits(convertAmountWithRates(
        fromMinorUnits(authorization.requestedAmountMinor),
        authorization.requestedCurrency,
        'USD',
        rates
    ));
    if (
        expectedPayoutMinor !== authorization.payoutAmountMinor
        || Math.abs(requestedQuoteUSDMinor - authorization.amountUSDMinor) > 1
    ) {
        throw invalidDestinationError('WITHDRAWAL_PAYOUT_AUTHORIZATION_INVALID');
    }

    // The clear metadata is redacted presentation only, but it must not claim
    // a different destination than the authenticated payload.
    const metadata = request?.paymentAccountSnapshot;
    if (
        metadata
        && (
            String(metadata.currency || '') !== authorization.payoutCurrency
            || String(metadata.accountNumberLast4 || '') !== lastFourDestinationCharacters(snapshot.accountNumber)
            || String(metadata.ibanLast4 || '') !== lastFourDestinationCharacters(snapshot.iban)
        )
    ) {
        throw invalidDestinationError('WITHDRAWAL_PAYOUT_AUTHORIZATION_INVALID');
    }
};

const readFrozenPayoutDestination = (request) => {
    const doc = request?.toObject ? request.toObject() : request;
    const snapshotVersion = requireStoredWithdrawalVersion(
        doc?.paymentAccountSnapshotVersion,
        'withdrawal payout account snapshot version'
    );
    if (
        snapshotVersion !== PAYOUT_ACCOUNT_SNAPSHOT_VERSION
        || !doc?.paymentAccountSnapshotEnvelope
    ) {
        throw invalidDestinationError('WITHDRAWAL_PAYOUT_DESTINATION_MISSING');
    }
    let authorization;
    let snapshot;
    try {
        authorization = withdrawalAuthorizationContext(doc);
        snapshot = openPayoutAccountSnapshot(doc.paymentAccountSnapshotEnvelope, {
            sellerId: toId(doc.seller),
            withdrawalId: toId(doc._id),
            authorization,
        });
    } catch (error) {
        if (error?.code?.startsWith?.('WITHDRAWAL_PAYOUT_DESTINATION_')) throw error;
        if (error?.code?.startsWith?.('WITHDRAWAL_PAYOUT_AUTHORIZATION_')) throw error;
        if (error?.code === 'PAYOUT_ACCOUNT_ENCRYPTION_NOT_CONFIGURED') throw error;
        throw invalidDestinationError('WITHDRAWAL_PAYOUT_AUTHORIZATION_INVALID');
    }
    let validatedSnapshot;
    try {
        validatedSnapshot = validatePayoutAccountDestination(snapshot);
    } catch (_validationError) {
        throw invalidDestinationError();
    }
    const normalizedSnapshot = { ...snapshot, ...validatedSnapshot };
    assertFrozenPayoutAuthorization(doc, normalizedSnapshot, authorization);
    return normalizedSnapshot;
};

const serializeWithdrawalRequest = (request, { includeSensitivePayout = false } = {}) => {
    if (!request) return null;
    const doc = request.toObject ? request.toObject() : { ...request };
    const envelope = doc.paymentAccountSnapshotEnvelope;
    delete doc.paymentAccountSnapshotEnvelope;
    delete doc.adminOperations;
    delete doc.paidPayoutProviderKey;
    delete doc.paidTransferReferenceKey;

    const snapshotVersion = requireStoredWithdrawalVersion(
        doc.paymentAccountSnapshotVersion,
        'withdrawal payout account snapshot version'
    );
    const payoutWorkflowVersion = requireStoredWithdrawalVersion(
        doc.payoutWorkflowVersion,
        'withdrawal payout workflow version'
    );
    let snapshotStatus = snapshotVersion === PAYOUT_ACCOUNT_SNAPSHOT_VERSION
        ? 'complete'
        : 'missing';
    let fullSnapshot = null;
    if (includeSensitivePayout && snapshotStatus === 'complete') {
        try {
            fullSnapshot = readFrozenPayoutDestination({ ...doc, paymentAccountSnapshotEnvelope: envelope });
        } catch (error) {
            snapshotStatus = error?.code === 'WITHDRAWAL_PAYOUT_DESTINATION_MISSING'
                ? 'missing'
                : 'unreadable';
        }
    }

    doc.paymentAccountSnapshot = {
        ...(doc.paymentAccountSnapshot || {}),
        ...(fullSnapshot || {}),
        snapshotStatus,
        payoutBlocked: snapshotStatus !== 'complete',
    };

    const attempts = Array.isArray(doc.payoutAttempts) ? doc.payoutAttempts : [];
    const activeAttempt = attempts.find(
        attempt => attempt.attemptId === doc.activePayoutAttemptId
    );
    const legacyProcessingQuarantined = isLegacyProcessingWithdrawal(doc);
    doc.payoutWorkflow = {
        version: payoutWorkflowVersion,
        attemptCount: attempts.length,
        state: doc.status,
        requiresManualReview: doc.status === 'manual_review' || legacyProcessingQuarantined,
        legacyProcessingQuarantined,
        activeAttemptStatus: activeAttempt?.status,
        paidTransferReference: doc.status === 'paid' ? doc.paidTransferReference : undefined,
        paidPayoutProvider: doc.status === 'paid' ? doc.paidPayoutProvider : undefined,
    };

    if (includeSensitivePayout) {
        doc.payoutAttempts = attempts.map(attempt => ({
            ...attempt,
            initiatedBy: attempt.initiatedBy,
            evidence: attempt.evidence ? { ...attempt.evidence } : undefined,
        }));
    } else {
        delete doc.payoutAttempts;
        delete doc.activePayoutAttemptId;
        delete doc.paidPayoutAttemptId;
        delete doc.paidPayoutProvider;
        delete doc.paidTransferReference;
    }
    return doc;
};

const sellerRevenueForItems = (order, sellerId, sellerItems = []) => {
    return sellerOrderSummaryForItems(order, sellerId, sellerItems);
};

const sellerRevenueForOrder = (order, sellerId, sellerProductIdSet) => {
    const sellerIdStr = toId(sellerId);
    const sellerItems = (order.orderItems || []).filter((item) => {
        // New order items carry the seller at checkout. Treat that immutable
        // snapshot as authoritative and use live product ownership only for
        // legacy items where no seller was recorded.
        if (item?.seller) return toId(item.seller) === sellerIdStr;
        return sellerProductIdSet.has(toId(item.productId));
    });
    return { ...sellerRevenueForItems(order, sellerIdStr, sellerItems), sellerItems };
};

const emptyRevenueSummary = () => ({
    stripeDeliveredRevenue: 0,
    stripePendingRevenue: 0,
    walletDeliveredRevenue: 0,
    walletPendingRevenue: 0,
    codDeliveredRevenue: 0,
    codPendingRevenue: 0,
    onlineDeliveredRevenue: 0,
    onlinePendingRevenue: 0,
    totalDeliveredRevenue: 0,
    estimatedRevenue: 0,
    withdrawableBalance: 0,
    paymentRiskHeldAmount: 0,
    pendingWithdrawalAmount: 0,
    approvedWithdrawalAmount: 0,
    processingWithdrawalAmount: 0,
    manualReviewWithdrawalAmount: 0,
    totalWithdrawn: 0,
    totalReservedOrWithdrawn: 0,
    returnRefundDebits: 0,
    paymentReversalDebits: 0,
    deliveredStripeOrders: 0,
    pendingStripeOrders: 0,
    deliveredWalletOrders: 0,
    pendingWalletOrders: 0,
    deliveredCodOrders: 0,
    pendingCodOrders: 0,
    totalRelevantOrders: 0,
});

const REVENUE_MONEY_FIELDS = [
    'stripeDeliveredRevenue',
    'stripePendingRevenue',
    'walletDeliveredRevenue',
    'walletPendingRevenue',
    'codDeliveredRevenue',
    'codPendingRevenue',
    'onlineDeliveredRevenue',
    'onlinePendingRevenue',
    'totalDeliveredRevenue',
    'estimatedRevenue',
    'withdrawableBalance',
    'paymentRiskHeldAmount',
    'pendingWithdrawalAmount',
    'approvedWithdrawalAmount',
    'processingWithdrawalAmount',
    'manualReviewWithdrawalAmount',
    'totalWithdrawn',
    'totalReservedOrWithdrawn',
    'returnRefundDebits',
    'paymentReversalDebits',
];

const emptyRevenueBuckets = () => Object.fromEntries(
    REVENUE_MONEY_FIELDS.map(field => [field, []])
);

const addRevenueBucketAmount = (
    buckets,
    field,
    order,
    currency,
    amount,
    amountUSDMinor = null
) => {
    const storedAmount = requireStoredExactMoney(amount, 'seller order revenue amount');
    if (!isSupportedCurrency(currency)) {
        throw storedFinancialDataError('seller order revenue currency');
    }
    let storedUSDMinor = null;
    if (amountUSDMinor !== null && amountUSDMinor !== undefined) {
        if (!Number.isSafeInteger(amountUSDMinor) || amountUSDMinor < 0) {
            throw storedFinancialDataError('seller order USD allocation');
        }
        storedUSDMinor = amountUSDMinor;
    }
    if (!buckets[field]) buckets[field] = [];
    buckets[field].push({
        amount: storedAmount,
        currency: normalizeCurrency(currency),
        rates: getOrderExchangeRates(order),
        amountUSDMinor: storedUSDMinor,
    });
};

const materializeRevenueBuckets = (buckets, targetCurrency, rates, { useOrderSnapshots = true } = {}) => {
    const output = emptyRevenueSummary();
    for (const field of REVENUE_MONEY_FIELDS) {
        const liveByCurrency = new Map();
        let convertedMinor = 0;
        for (const entry of buckets[field] || []) {
            if (
                targetCurrency === 'USD'
                && useOrderSnapshots
                && Number.isSafeInteger(entry.amountUSDMinor)
            ) {
                convertedMinor = addSafeMinorUnits(
                    convertedMinor,
                    entry.amountUSDMinor,
                    'seller revenue total',
                );
                continue;
            }
            if (entry.rates && useOrderSnapshots) {
                // Compatibility for pre-snapshot callers. Versioned seller
                // settlements take the exact frozen USD-minor branch above.
                convertedMinor = addSafeMinorUnits(convertedMinor, toMinorUnits(convertAmountWithRates(
                    entry.amount,
                    entry.currency,
                    targetCurrency,
                    entry.rates
                )), 'seller revenue total');
            } else {
                liveByCurrency.set(
                    entry.currency,
                    addSafeMinorUnits(
                        liveByCurrency.get(entry.currency) || 0,
                        toMinorUnits(entry.amount),
                        'seller revenue source-currency total',
                    )
                );
            }
        }
        if (liveByCurrency.size) {
            const liveConversion = allocateConvertedMinorUnitsByRates(
                [...liveByCurrency.entries()].map(([sourceCurrency, amountMinor]) => ({
                    key: sourceCurrency,
                    amount: fromMinorUnits(amountMinor),
                    sourceRate: rates[sourceCurrency],
                })),
                rates[targetCurrency]
            );
            convertedMinor = addSafeMinorUnits(
                convertedMinor,
                liveConversion.totalMinorUnits,
                'seller revenue total',
            );
        }
        output[field] = fromMinorUnits(convertedMinor);
    }
    return output;
};

const orderRevenueClassification = (order, sellerId = null) => {
    const delivered = sellerId ? isDeliveredForSeller(order, sellerId) : isDelivered(order);
    const paymentMethod = order.paymentMethod || 'cash_on_delivery';
    if (paymentMethod === 'stripe' && order.isPaid) {
        return delivered
            ? { moneyField: 'stripeDeliveredRevenue', countField: 'deliveredStripeOrders' }
            : { moneyField: 'stripePendingRevenue', countField: 'pendingStripeOrders' };
    }
    if (paymentMethod === 'wallet' && order.isPaid) {
        return delivered
            ? { moneyField: 'walletDeliveredRevenue', countField: 'deliveredWalletOrders' }
            : { moneyField: 'walletPendingRevenue', countField: 'pendingWalletOrders' };
    }
    if (paymentMethod === 'cash_on_delivery') {
        return delivered
            ? { moneyField: 'codDeliveredRevenue', countField: 'deliveredCodOrders' }
            : { moneyField: 'codPendingRevenue', countField: 'pendingCodOrders' };
    }
    return null;
};

const addOrderRevenueToBuckets = (
    revenue,
    buckets,
    order,
    sourceAmount,
    sourceCurrency,
    sellerId = null,
    amountUSDMinor = null
) => {
    if (sourceAmount <= 0) return false;
    const classification = orderRevenueClassification(order, sellerId);
    if (!classification) return false;
    addRevenueBucketAmount(
        buckets,
        classification.moneyField,
        order,
        sourceCurrency,
        sourceAmount,
        amountUSDMinor
    );
    revenue[classification.countField] += 1;
    return true;
};

const addSellerBalanceTransactionsToSummary = (revenue, transactions = []) => {
    for (const transaction of transactions) {
        if (
            !['reserved', 'completed', 'reversed'].includes(transaction?.status)
            || !['debit', 'credit'].includes(transaction?.direction)
            || !isSupportedCurrency(transaction?.sourceCurrency)
        ) {
            throw storedFinancialDataError('seller balance transaction metadata');
        }
        const amountUSD = requireStoredExactMoney(
            transaction.amountUSD,
            'seller balance transaction USD amount',
        );
        const sourceAmount = requireStoredExactMoney(
            transaction.sourceAmount,
            'seller balance transaction source amount',
        );
        if (amountUSD === 0 && sourceAmount === 0) {
            throw storedFinancialDataError('seller balance transaction amount');
        }
    }
    const activeTransactions = transactions.filter(transaction => (
        ['reserved', 'completed'].includes(transaction.status)
    ));
    const debitTotalMinor = activeTransactions.reduce((sum, transaction) => {
        const amountMinor = toMinorUnits(transaction.amountUSD);
        return addSafeMinorUnits(
            sum,
            transaction.direction === 'credit' ? -amountMinor : amountMinor,
            'seller balance transaction total',
        );
    }, 0);
    const paymentReversalMinor = activeTransactions.reduce((sum, transaction) => {
        if (transaction.referenceType !== 'stripe_payment') return sum;
        const amountMinor = toMinorUnits(transaction.amountUSD);
        return addSafeMinorUnits(
            sum,
            transaction.direction === 'credit' ? -amountMinor : amountMinor,
            'seller payment reversal total',
        );
    }, 0);
    revenue.paymentReversalDebits = fromMinorUnits(Math.max(0, paymentReversalMinor));
    revenue.returnRefundDebits = fromMinorUnits(Math.max(0, debitTotalMinor - paymentReversalMinor));
    revenue.totalReservedOrWithdrawn = fromMinorUnits(
        addSafeMinorUnits(
            toMinorUnits(requireStoredExactMoney(
                revenue.totalReservedOrWithdrawn,
                'reserved or withdrawn total',
            )),
            Math.max(0, debitTotalMinor),
            'reserved or withdrawn total',
        )
    );
};

const addWithdrawalTotalsToSummary = (revenue, withdrawals = [], { stored = true } = {}) => {
    const withdrawalTotals = {
        pending: 0,
        approved: 0,
        processing: 0,
        manual_review: 0,
        paid: 0,
        failed: 0,
        rejected: 0,
        cancelled: 0,
    };

    for (const request of withdrawals) {
        const status = request?.status;
        if (
            withdrawalTotals[status] === undefined
            || (stored && request?.currency !== 'USD')
            || (stored && !isSupportedCurrency(request?.requestedCurrency))
            || (stored && !isSupportedCurrency(request?.payoutCurrency))
        ) {
            throw storedFinancialDataError('withdrawal metadata');
        }
        const amount = requireStoredExactMoney(
            request.amount,
            stored ? 'withdrawal USD amount' : 'converted withdrawal amount',
            { minimum: stored ? 5 : 0 },
        );
        const requestedAmount = stored
            ? requireStoredExactMoney(request.requestedAmount, 'requested withdrawal amount')
            : 0;
        const payoutAmount = stored
            ? requireStoredExactMoney(request.payoutAmount, 'withdrawal payout amount')
            : 0;
        const snapshotVersion = stored
            ? requireStoredWithdrawalVersion(
                request.paymentAccountSnapshotVersion,
                'withdrawal payout account snapshot version'
            )
            : 0;
        if (stored) {
            requireStoredWithdrawalVersion(
                request.payoutWorkflowVersion,
                'withdrawal payout workflow version'
            );
        }
        if (
            stored
            &&
            snapshotVersion >= 1
            && (requestedAmount <= 0 || payoutAmount <= 0)
        ) {
            throw storedFinancialDataError('withdrawal amount snapshot');
        }
        withdrawalTotals[status] = addSafeMinorUnits(
            withdrawalTotals[status],
            toMinorUnits(amount),
            'withdrawal total',
        );
    }

    revenue.pendingWithdrawalAmount = fromMinorUnits(withdrawalTotals.pending);
    revenue.approvedWithdrawalAmount = fromMinorUnits(withdrawalTotals.approved);
    revenue.manualReviewWithdrawalAmount = fromMinorUnits(withdrawalTotals.manual_review);
    revenue.processingWithdrawalAmount = fromMinorUnits(addSafeMinorUnits(
        withdrawalTotals.processing,
        withdrawalTotals.manual_review,
        'processing withdrawal total',
    ));
    revenue.totalWithdrawn = fromMinorUnits(withdrawalTotals.paid);
    revenue.totalReservedOrWithdrawn = fromMinorUnits(
        ACTIVE_WITHDRAWAL_STATUSES.reduce((sum, status) => addSafeMinorUnits(
            sum,
            withdrawalTotals[status] || 0,
            'active withdrawal total',
        ), 0)
    );
};

const finalizeRevenueSummary = (revenue) => {
    revenue.stripeDeliveredRevenue = roundMoney(revenue.stripeDeliveredRevenue);
    revenue.stripePendingRevenue = roundMoney(revenue.stripePendingRevenue);
    revenue.walletDeliveredRevenue = roundMoney(revenue.walletDeliveredRevenue);
    revenue.walletPendingRevenue = roundMoney(revenue.walletPendingRevenue);
    revenue.codDeliveredRevenue = roundMoney(revenue.codDeliveredRevenue);
    revenue.codPendingRevenue = roundMoney(revenue.codPendingRevenue);
    revenue.onlineDeliveredRevenue = fromMinorUnits(addSafeMinorUnits(
        toMinorUnits(revenue.stripeDeliveredRevenue),
        toMinorUnits(revenue.walletDeliveredRevenue),
        'online delivered revenue',
    ));
    revenue.onlinePendingRevenue = fromMinorUnits(addSafeMinorUnits(
        toMinorUnits(revenue.stripePendingRevenue),
        toMinorUnits(revenue.walletPendingRevenue),
        'online pending revenue',
    ));
    revenue.pendingWithdrawalAmount = roundMoney(revenue.pendingWithdrawalAmount);
    revenue.approvedWithdrawalAmount = roundMoney(revenue.approvedWithdrawalAmount);
    revenue.processingWithdrawalAmount = roundMoney(revenue.processingWithdrawalAmount);
    revenue.manualReviewWithdrawalAmount = roundMoney(revenue.manualReviewWithdrawalAmount);
    revenue.totalWithdrawn = roundMoney(revenue.totalWithdrawn);
    revenue.totalReservedOrWithdrawn = roundMoney(revenue.totalReservedOrWithdrawn);
    revenue.returnRefundDebits = roundMoney(revenue.returnRefundDebits);
    revenue.paymentReversalDebits = roundMoney(revenue.paymentReversalDebits);
    revenue.totalDeliveredRevenue = fromMinorUnits(addSafeMinorUnits(
        toMinorUnits(revenue.onlineDeliveredRevenue),
        toMinorUnits(revenue.codDeliveredRevenue),
        'total delivered revenue',
    ));
    revenue.estimatedRevenue = fromMinorUnits(addSafeMinorUnits(
        addSafeMinorUnits(
            toMinorUnits(revenue.totalDeliveredRevenue),
            toMinorUnits(revenue.onlinePendingRevenue),
            'estimated revenue',
        ),
        toMinorUnits(revenue.codPendingRevenue),
        'estimated revenue',
    ));
    revenue.withdrawableBalance = fromMinorUnits(Math.max(
        0,
        addSafeMinorUnits(
            toMinorUnits(revenue.onlineDeliveredRevenue),
            -toMinorUnits(revenue.totalReservedOrWithdrawn),
            'withdrawable balance',
        )
    ));
    return revenue;
};

const addSummaryToTotals = (totals, revenue) => {
    Object.keys(totals).forEach((key) => {
        if (typeof totals[key] !== 'number') return;
        if (REVENUE_MONEY_FIELDS.includes(key)) {
            totals[key] = fromMinorUnits(
                addSafeMinorUnits(
                    toMinorUnits(totals[key]),
                    toMinorUnits(revenue[key]),
                    `aggregate ${key}`,
                )
            );
        } else {
            const count = revenue[key];
            if (!Number.isSafeInteger(count) || count < 0) {
                throw storedFinancialDataError(`aggregate ${key}`);
            }
            const next = totals[key] + count;
            if (!Number.isSafeInteger(next)) {
                throw storedFinancialDataError(`aggregate ${key}`);
            }
            totals[key] = next;
        }
    });
};

const buildSellerOrderGroups = (order, sellerIdSet, productSellerById) => {
    const grouped = new Map();
    for (const item of order.orderItems || []) {
        const snapshotSellerId = toId(item.seller);
        const productSellerId = productSellerById.get(toId(item.productId));
        // Never reattribute a snapshotted sale to a product's later owner. If
        // the historical seller no longer exists, omit that orphan from the
        // current-seller overview instead of crediting somebody else.
        const sellerId = snapshotSellerId ? snapshotSellerId : productSellerId;
        if (!sellerId || !sellerIdSet.has(sellerId)) continue;
        if (!grouped.has(sellerId)) grouped.set(sellerId, []);
        grouped.get(sellerId).push(item);
    }
    return grouped;
};

const buildSellerPaymentSummary = async (sellerId, {
    session = null,
    displayCurrency = 'USD',
    rates: suppliedRates = null,
    rateSnapshot: suppliedRateSnapshot = null,
} = {}) => {
    const sellerIdStr = toId(sellerId);
    const liveRateSnapshot = suppliedRateSnapshot
        ? {
            ...suppliedRateSnapshot,
            base: 'USD',
            rates: suppliedRateSnapshot.rates,
        }
        : suppliedRates
        ? {
            base: 'USD',
            rates: suppliedRates,
            capturedAt: new Date().toISOString(),
            source: 'supplied',
            fallback: false,
        }
        : await getExchangeRateSnapshot();
    const rates = liveRateSnapshot.rates;
    const normalizedDisplayCurrency = normalizeCurrency(displayCurrency);
    const [products, paymentAccount, withdrawals, balanceTransactions, pendingRiskHolds] = await Promise.all([
        queryWithSession(Product.find({ seller: sellerIdStr }).select('_id'), session).lean(),
        queryWithSession(SellerPaymentAccount.findOne({ seller: sellerIdStr }), session).lean(),
        queryWithSession(SellerWithdrawalRequest.find({ seller: sellerIdStr }).sort({ createdAt: -1 }), session).lean(),
        // Read every row so an unknown/corrupt status cannot disappear from
        // the balance merely because it misses an active-status query filter.
        queryWithSession(SellerBalanceTransaction.find({ seller: sellerIdStr }), session).lean(),
        queryWithSession(SellerPaymentRiskHold.find({ seller: sellerIdStr, status: 'pending' }), session).lean(),
    ]);

    const productIds = products.map((product) => product._id);
    const revenue = emptyRevenueSummary();
    const revenueBuckets = emptyRevenueBuckets();

    let recentStripeOrders = [];
    let recentWalletOrders = [];
    let recentCodOrders = [];

    const orderScopes = [
        { 'orderItems.seller': sellerIdStr },
        { 'sellerSettlement.seller': sellerIdStr },
    ];
    if (productIds.length) orderScopes.push({ 'orderItems.productId': { $in: productIds } });

    if (orderScopes.length) {
        const orders = await queryWithSession(Order.find({
            awaitingPayment: { $ne: true },
            orderStatus: { $ne: 'cancelled' },
            $or: orderScopes,
        })
            .select('orderId orderItems sellerShipping sellerFulfillment shippingMethod orderSummary appliedCoupons paymentMethod isPaid paidAt orderStatus isDelivered deliveredAt createdAt currency exchangeRateSnapshot sellerSettlementVersion sellerSettlement')
            .sort({ createdAt: -1 }), session)
            .lean();

        for (const order of orders) {
            if (!isLiveOrderForSeller(order, sellerIdStr)) continue;
            let settlement;
            try {
                settlement = await ensureOrderSellerSettlement(order, {
                    session,
                    requireOrderTotal: true,
                    rateSnapshot: liveRateSnapshot,
                });
            } catch (error) {
                if (error?.code === 'SELLER_SETTLEMENT_HISTORICAL_RATE_MISSING') {
                    throw legacyOrderFxBackfillRequiredError();
                }
                if (error?.code === 'SELLER_SETTLEMENT_EXCHANGE_RATE_MISSING') {
                    throw withdrawalRatesUnavailableError();
                }
                throw error;
            }
            const sellerSettlement = sellerSettlementEntry(settlement, sellerIdStr);
            if (!sellerSettlement || sellerSettlement.sourceAmountMinor <= 0) continue;
            const sellerSourceAmount = fromMinorUnits(sellerSettlement.sourceAmountMinor);
            const sellerRevenueUSD = fromMinorUnits(sellerSettlement.amountUSDMinor);
            revenue.totalRelevantOrders += 1;

            const sourceCurrency = sellerSettlement.sourceCurrency;

            const delivered = isDeliveredForSeller(order, sellerIdStr);
            const paymentMethod = order.paymentMethod || 'cash_on_delivery';

            if (['stripe', 'wallet'].includes(paymentMethod) && order.isPaid) {
                addOrderRevenueToBuckets(
                    revenue,
                    revenueBuckets,
                    order,
                    sellerSourceAmount,
                    sourceCurrency,
                    sellerIdStr,
                    sellerSettlement.amountUSDMinor
                );
                const targetList = paymentMethod === 'wallet' ? recentWalletOrders : recentStripeOrders;
                if (targetList.length < 5) {
                    targetList.push({
                        _id: order._id,
                        orderId: order.orderId,
                        status: sellerFulfillmentStatus(order, sellerIdStr),
                        amount: sellerRevenueUSD,
                        amountCurrency: 'USD',
                        sourceAmount: sellerSourceAmount,
                        sourceCurrency,
                        delivered,
                        createdAt: order.createdAt,
                    });
                }
                continue;
            }

            if (paymentMethod === 'cash_on_delivery') {
                addOrderRevenueToBuckets(
                    revenue,
                    revenueBuckets,
                    order,
                    sellerSourceAmount,
                    sourceCurrency,
                    sellerIdStr,
                    sellerSettlement.amountUSDMinor
                );
                if (recentCodOrders.length < 5) {
                    recentCodOrders.push({
                        _id: order._id,
                        orderId: order.orderId,
                        status: sellerFulfillmentStatus(order, sellerIdStr),
                        amount: sellerRevenueUSD,
                        amountCurrency: 'USD',
                        sourceAmount: sellerSourceAmount,
                        sourceCurrency,
                        delivered,
                        createdAt: order.createdAt,
                    });
                }
            }
        }
    }

    const canonicalOrderRevenue = materializeRevenueBuckets(revenueBuckets, 'USD', rates);
    REVENUE_MONEY_FIELDS.forEach(field => { revenue[field] = canonicalOrderRevenue[field]; });
    addWithdrawalTotalsToSummary(revenue, withdrawals);
    addSellerBalanceTransactionsToSummary(revenue, balanceTransactions);
    finalizeRevenueSummary(revenue);
    if (pendingRiskHolds.length) {
        revenue.paymentRiskHeldAmount = revenue.withdrawableBalance;
        revenue.withdrawableBalance = 0;
    }

    // Display conversion is deliberately live: an amount already denominated
    // in the selected currency stays exact, while other order currencies use
    // the current shared rate table. Canonical USD accounting above remains
    // frozen to each order's checkout snapshot.
    const displayRevenue = materializeRevenueBuckets(
        revenueBuckets,
        normalizedDisplayCurrency,
        rates,
        {
            // During a provider outage, USD withdrawal availability must match
            // the canonical checkout-snapshot ledger. Re-converting foreign
            // orders with the fallback table would make the displayed full
            // balance and the reservable balance disagree.
            useOrderSnapshots: liveRateSnapshot.fallback === true
                && normalizedDisplayCurrency === 'USD',
        }
    );
    displayRevenue.totalRelevantOrders = revenue.totalRelevantOrders;
    addWithdrawalTotalsToSummary(displayRevenue, withdrawals.map(request => ({
        ...request,
        amount: convertAmountWithRates(request.amount, 'USD', normalizedDisplayCurrency, rates),
    })), { stored: false });
    addSellerBalanceTransactionsToSummary(displayRevenue, balanceTransactions.map(transaction => ({
        ...transaction,
        amountUSD: convertAmountWithRates(transaction.amountUSD, 'USD', normalizedDisplayCurrency, rates),
    })));
    finalizeRevenueSummary(displayRevenue);
    if (pendingRiskHolds.length) {
        displayRevenue.paymentRiskHeldAmount = displayRevenue.withdrawableBalance;
        displayRevenue.withdrawableBalance = 0;
    }

    return {
        baseCurrency: 'USD',
        displayCurrency: normalizedDisplayCurrency,
        exchangeRateStatus: {
            source: liveRateSnapshot.source,
            capturedAt: liveRateSnapshot.capturedAt,
            fallback: liveRateSnapshot.fallback === true,
        },
        paymentRiskPending: pendingRiskHolds.length > 0,
        revenue,
        displayRevenue,
        withdrawalLimits: {
            baseCurrency: 'USD',
            displayCurrency: normalizedDisplayCurrency,
            minimumUSD: MIN_WITHDRAWAL_USD,
            minimumDisplayAmount: minimumRequestedAmountForUSD(
                MIN_WITHDRAWAL_USD,
                normalizedDisplayCurrency,
                rates
            ),
            availableUSD: revenue.withdrawableBalance,
            // Withdrawal capacity is the canonical USD ledger quoted into the
            // requested currency at the current trusted rate. displayRevenue
            // intentionally preserves native/live reporting semantics and can
            // differ when checkout FX is frozen, so it is not an authority for
            // how much USD can actually be reserved.
            availableDisplayAmount: convertAmountWithRates(
                revenue.withdrawableBalance,
                'USD',
                normalizedDisplayCurrency,
                rates
            ),
        },
        paymentAccount: serializePaymentAccount(paymentAccount),
        withdrawals: withdrawals.map(request => serializeWithdrawalRequest(request)),
        recentStripeOrders,
        recentWalletOrders,
        recentCodOrders,
    };
};

exports.buildSellerPaymentSummary = buildSellerPaymentSummary;
exports.quoteWithdrawalAmount = quoteWithdrawalAmount;
exports.quotePayoutAmount = quotePayoutAmount;
exports.minimumRequestedAmountForUSD = minimumRequestedAmountForUSD;
exports.assertWithdrawalQuoteCanUseSnapshot = assertWithdrawalQuoteCanUseSnapshot;
exports.isSameWithdrawalRequest = isSameWithdrawalRequest;
exports.canTransitionWithdrawalStatus = canTransitionWithdrawalStatus;

exports.getSellerPaymentSummary = async (req, res) => {
    try {
        if (req.user?.role !== 'seller' && req.user?.role !== 'admin') {
            return res.status(403).json({ msg: 'Seller access required' });
        }

        const sellerId = req.user.role === 'admin' && req.query.sellerId ? req.query.sellerId : req.user.id;
        const requestedDisplayCurrency = req.query?.currency || req.user?.currency || 'USD';
        if (!isSupportedCurrency(requestedDisplayCurrency)) {
            return res.status(400).json({ msg: 'Choose a supported display currency.' });
        }
        const summary = await buildSellerPaymentSummary(sellerId, {
            displayCurrency: requestedDisplayCurrency,
        });

        return res.status(200).json({
            success: true,
            ...summary,
        });
    } catch (error) {
        console.error('[payments] seller summary error:', error);
        return res.status(500).json({ msg: 'Failed to fetch payment summary' });
    }
};

exports.upsertSellerPaymentAccount = async (req, res) => {
    try {
        if (req.user?.role !== 'seller') {
            return res.status(403).json({ msg: 'Seller access required' });
        }

        const sellerId = req.user.id;
        const notificationOperationKey = createHash('sha256')
            .update(`${sellerId}:${randomUUID()}`)
            .digest('hex');
        let account;
        await runInTransaction(async session => {
            const existing = await SellerPaymentAccount.findOne({ seller: sellerId })
                .select('+accountNumber +iban')
                .session(session);
            const normalized = mergeAndValidatePayoutAccountUpdate({
                input: req.body,
                existing,
                defaultCurrency: req.user.currency || 'USD',
            });
            const update = {
                seller: sellerId,
                ...normalized,
                isActive: true,
                updatedBy: sellerId,
            };
            const changed = !existing
                || payoutAccountFingerprint(existing) !== payoutAccountFingerprint(update);
            if (!changed) {
                account = existing;
                return;
            }

            const occurredAt = new Date();
            account = await SellerPaymentAccount.findOneAndUpdate(
                { seller: sellerId },
                { $set: update },
                {
                    new: true,
                    upsert: true,
                    runValidators: true,
                    setDefaultsOnInsert: true,
                    ...(session ? { session } : {}),
                }
            ).select('+accountNumber +iban');
            await enqueuePayoutAccountUpdatedNotification({
                account,
                occurredAt,
                changeFingerprint: notificationOperationKey,
            }, { session });
        });

        return res.status(200).json({
            success: true,
            msg: 'Payment account saved',
            paymentAccount: serializePaymentAccount(account),
        });
    } catch (error) {
        console.error('[payments] account save error:', error);
        const status = error.statusCode || 500;
        return res.status(status).json({
            msg: status < 500 ? error.message : 'Failed to save payment account',
            ...(error.code ? { code: error.code } : {}),
        });
    }
};

exports.createWithdrawalRequest = async (req, res) => {
    try {
        if (req.user?.role !== 'seller') {
            return res.status(403).json({ msg: 'Seller access required' });
        }

        const sellerId = req.user.id;
        const rawIdempotencyKey = String(
            req.get?.('Idempotency-Key') || req.body?.idempotencyKey || ''
        ).trim();
        if (rawIdempotencyKey.length > 200) {
            return res.status(400).json({ msg: 'Withdrawal idempotency key is too long.' });
        }
        if (!rawIdempotencyKey) {
            return res.status(400).json({
                msg: 'A withdrawal attempt key is required. Retry with the same key if the response is interrupted.',
                code: 'WITHDRAWAL_IDEMPOTENCY_KEY_REQUIRED',
            });
        }
        const idempotencyKey = rawIdempotencyKey;
        {
            const existingRequest = await SellerWithdrawalRequest.findOne({
                seller: sellerId,
                idempotencyKey,
            }).lean();
            if (existingRequest) {
                const retryCurrency = req.body?.requestedCurrency || req.body?.currency || req.user.currency || 'USD';
                const retryAmount = req.body?.requestedAmount ?? req.body?.amount;
                const sameRequest = isSameWithdrawalRequest(existingRequest, retryAmount, retryCurrency);
                if (!sameRequest) {
                    return res.status(409).json({
                        msg: 'This withdrawal retry key was already used for a different amount.',
                        code: 'WITHDRAWAL_IDEMPOTENCY_CONFLICT',
                    });
                }
                return res.status(200).json({
                    success: true,
                    reused: true,
                    msg: 'Withdrawal request already submitted',
                    amountUSD: existingRequest.amount,
                    requestedAmount: existingRequest.requestedAmount,
                    requestedCurrency: existingRequest.requestedCurrency,
                    payoutAmount: existingRequest.payoutAmount,
                    payoutCurrency: existingRequest.payoutCurrency,
                    withdrawal: serializeWithdrawalRequest(existingRequest),
                });
            }
        }
        const rateSnapshot = await getExchangeRateSnapshot();
        const rawRequestedCurrency = req.body?.requestedCurrency
            || req.body?.currency
            || req.user.currency
            || 'USD';
        if (!isSupportedCurrency(rawRequestedCurrency)) {
            return res.status(400).json({ msg: 'Choose a supported withdrawal currency.' });
        }
        const requestedCurrencyForQuote = normalizeCurrency(rawRequestedCurrency);
        const account = await SellerPaymentAccount.findOne({ seller: sellerId, isActive: true }).lean();
        if (!account) {
            return res.status(400).json({ msg: 'Add your bank account before requesting a withdrawal' });
        }
        const payoutCurrencyForQuote = account.currency || requestedCurrencyForQuote;
        if (!isSupportedCurrency(payoutCurrencyForQuote)) {
            return res.status(400).json({ msg: 'The saved payout account has an unsupported currency.' });
        }
        assertWithdrawalQuoteCanUseSnapshot(
            rateSnapshot,
            requestedCurrencyForQuote,
            payoutCurrencyForQuote
        );

        const rates = rateSnapshot.rates;
        const quote = quoteWithdrawalAmount({
            body: req.body,
            userCurrency: req.user.currency,
            rates,
        });
        const { requestedCurrency, requestedAmount } = quote;
        const quotedAmountUSD = quote.amountUSD;
        if (quotedAmountUSD < MIN_WITHDRAWAL_USD) {
            const minimumRequestedAmount = minimumRequestedAmountForUSD(
                MIN_WITHDRAWAL_USD,
                requestedCurrency,
                rates
            );
            return res.status(400).json({
                msg: `Minimum withdrawal amount is ${formatNativeMoney(minimumRequestedAmount, requestedCurrency)}.`,
                minimumAmountUSD: MIN_WITHDRAWAL_USD,
                minimumRequestedAmount,
                requestedCurrency,
            });
        }

        const withdrawalResult = await runInTransaction(async (session) => {
            let settlementAmountUSD = quotedAmountUSD;
            // Withdrawals and return refunds share this lock. A transaction that
            // loses the race is retried and sees the newly reserved/debited funds.
            await SellerSettlementLock.findOneAndUpdate(
                { seller: sellerId },
                { $setOnInsert: { seller: sellerId }, $inc: { version: 1 } },
                { upsert: true, new: true, session }
            );

            {
                const existingRequest = await SellerWithdrawalRequest.findOne({
                    seller: sellerId,
                    idempotencyKey,
                }).session(session);
                if (existingRequest) {
                    const sameRequest = isSameWithdrawalRequest(
                        existingRequest,
                        requestedAmount,
                        requestedCurrency
                    );
                    if (!sameRequest) {
                        const error = new Error('This withdrawal retry key was already used for a different amount.');
                        error.statusCode = 409;
                        error.code = 'WITHDRAWAL_IDEMPOTENCY_CONFLICT';
                        throw error;
                    }
                    return { request: existingRequest, reused: true };
                }
            }

            const frozenAccount = await queryWithSession(
                SellerPaymentAccount.findOne({ seller: sellerId, isActive: true })
                    .select('+accountNumber +iban'),
                session
            ).lean();
            if (!frozenAccount) {
                const error = new Error('Add your bank account before requesting a withdrawal');
                error.statusCode = 400;
                throw error;
            }
            const fullPayoutAccountSnapshot = completePayoutAccountSnapshot(frozenAccount);
            assertWithdrawalQuoteCanUseSnapshot(
                rateSnapshot,
                requestedCurrency,
                fullPayoutAccountSnapshot.currency
            );

            const summary = await buildSellerPaymentSummary(sellerId, {
                session,
                displayCurrency: requestedCurrency,
                rateSnapshot,
            });
            if (summary.paymentRiskPending) {
                const error = new Error(
                    'A Stripe refund or dispute is still being reconciled. Withdrawals are temporarily unavailable.'
                );
                error.statusCode = 423;
                error.code = 'SELLER_PAYMENT_RISK_PENDING';
                throw error;
            }
            const availableDisplayAmount = summary.withdrawalLimits.availableDisplayAmount;
            const withdrawableBalanceMinor = toMinorUnits(summary.revenue.withdrawableBalance);
            const isDisplayedFullBalance = toMinorUnits(requestedAmount)
                === toMinorUnits(availableDisplayAmount);
            if (
                isDisplayedFullBalance
                && Math.abs(
                    toMinorUnits(settlementAmountUSD) - withdrawableBalanceMinor
                ) <= 1
            ) {
                // A selected-currency full balance can round one cent above or
                // below the canonical USD ledger when converted back. Reserve
                // the exact canonical balance in either direction so no cent
                // is stranded and no cent is over-reserved. Partial requests
                // never enter this branch.
                settlementAmountUSD = fromMinorUnits(withdrawableBalanceMinor);
            }
            if (toMinorUnits(settlementAmountUSD) < toMinorUnits(MIN_WITHDRAWAL_USD)) {
                // A display-currency round trip can very rarely quote $5.00
                // for a canonical $4.99 full balance. Do not let the clamp
                // bypass the minimum or fall through to a model validation 500.
                const error = new Error(`Minimum withdrawal amount is ${formatNativeMoney(
                    summary.withdrawalLimits.minimumDisplayAmount,
                    requestedCurrency
                )}.`);
                error.statusCode = 400;
                error.code = 'WITHDRAWAL_MINIMUM_NOT_MET';
                throw error;
            }
            if (toMinorUnits(settlementAmountUSD) > withdrawableBalanceMinor) {
                const error = new Error(`You can withdraw up to ${formatNativeMoney(availableDisplayAmount, requestedCurrency)} right now.`);
                error.statusCode = 400;
                error.availableBalance = summary.revenue.withdrawableBalance;
                error.availableBalanceCurrency = 'USD';
                error.availableDisplayAmount = availableDisplayAmount;
                error.displayCurrency = requestedCurrency;
                throw error;
            }

            const payoutQuote = quotePayoutAmount(
                settlementAmountUSD,
                fullPayoutAccountSnapshot.currency,
                rates
            );
            const withdrawalId = new mongoose.Types.ObjectId();
            const withdrawalDocument = {
                _id: withdrawalId,
                seller: sellerId,
                idempotencyKey,
                amount: settlementAmountUSD,
                currency: 'USD',
                requestedAmount: roundMoney(requestedAmount),
                requestedCurrency,
                payoutAmount: payoutQuote.payoutAmount,
                payoutCurrency: payoutQuote.payoutCurrency,
                payoutWorkflowVersion: 1,
                exchangeRateSnapshot: {
                    base: 'USD',
                    // No foreign rate was used by an outage-safe USD -> USD
                    // withdrawal. Keep fallback values out of the permanent
                    // settlement snapshot so they cannot be mistaken for a
                    // trusted quote by future code.
                    rates: rateSnapshot.fallback
                        ? { USD: 1, PKR: null, EUR: null, GBP: null }
                        : rates,
                    capturedAt: new Date(rateSnapshot.capturedAt),
                    source: rateSnapshot.source,
                    fallback: rateSnapshot.fallback,
                },
                sellerNote: cleanText(req.body?.sellerNote, 500),
                paymentAccountSnapshot: payoutSnapshotMetadata(fullPayoutAccountSnapshot),
                paymentAccountSnapshotVersion: PAYOUT_ACCOUNT_SNAPSHOT_VERSION,
            };
            const withdrawalAuthorization = withdrawalAuthorizationContext(withdrawalDocument);
            try {
                // Validate the exact authenticated terms before a pending row
                // exists. An anomalous positive FX rate must never freeze a
                // non-zero USD reservation to a zero-cent bank payout.
                assertFrozenPayoutAuthorization(
                    withdrawalDocument,
                    fullPayoutAccountSnapshot,
                    withdrawalAuthorization
                );
            } catch (_) {
                const error = withdrawalRatesUnavailableError();
                error.message = 'Live exchange rates could not produce a valid bank payout amount. Please retry shortly.';
                error.code = 'WITHDRAWAL_PAYOUT_QUOTE_INVALID';
                throw error;
            }
            withdrawalDocument.paymentAccountSnapshotEnvelope = sealPayoutAccountSnapshot(
                fullPayoutAccountSnapshot,
                {
                    sellerId,
                    withdrawalId,
                    authorization: withdrawalAuthorization,
                }
            );

            const [created] = await SellerWithdrawalRequest.create([
                withdrawalDocument,
            ], { session });
            const adminIds = await queryWithSession(
                User.find({ role: 'admin', status: { $ne: 'blocked' } }).select('_id'),
                session
            ).lean();
            // Financial notifications share the withdrawal transaction. A
            // process crash can therefore never commit the reservation without
            // also committing its durable seller/admin notification events.
            await enqueueWithdrawalRequestedSellerNotifications(created, { session });
            await enqueueWithdrawalRequestedAdminNotifications(
                created,
                adminIds.map(admin => admin._id),
                req.user.username || 'A seller',
                { session }
            );
            return { request: created, reused: false };
        });

        const { request, reused } = withdrawalResult;

        return res.status(reused ? 200 : 201).json({
            success: true,
            reused,
            msg: reused ? 'Withdrawal request already submitted' : 'Withdrawal request submitted',
            amountUSD: request.amount,
            requestedAmount: request.requestedAmount,
            requestedCurrency: request.requestedCurrency,
            payoutAmount: request.payoutAmount,
            payoutCurrency: request.payoutCurrency,
            withdrawal: serializeWithdrawalRequest(request),
        });
    } catch (error) {
        console.error('[payments] withdrawal create error:', error);
        return res.status(error.statusCode || 500).json({
            msg: error.message || 'Failed to create withdrawal request',
            code: error.code,
            availableBalance: error.availableBalance,
            availableBalanceCurrency: error.availableBalanceCurrency,
            availableDisplayAmount: error.availableDisplayAmount,
            displayCurrency: error.displayCurrency,
        });
    }
};

exports.getSellerWithdrawals = async (req, res) => {
    try {
        if (req.user?.role !== 'seller' && req.user?.role !== 'admin') {
            return res.status(403).json({ msg: 'Seller access required' });
        }
        const sellerId = req.user.role === 'admin' && req.query.sellerId ? req.query.sellerId : req.user.id;
        let withdrawalQuery = SellerWithdrawalRequest.find({ seller: sellerId })
            .sort({ createdAt: -1 });
        if (req.user.role === 'admin') {
            withdrawalQuery = withdrawalQuery.select('+paymentAccountSnapshotEnvelope');
        }
        const withdrawals = await withdrawalQuery.lean();
        return res.status(200).json({
            success: true,
            withdrawals: withdrawals.map(request => serializeWithdrawalRequest(request, {
                includeSensitivePayout: req.user.role === 'admin',
            })),
        });
    } catch (error) {
        console.error('[payments] withdrawal list error:', error);
        return res.status(500).json({ msg: 'Failed to fetch withdrawals' });
    }
};

const buildAdminPaymentsOverviewData = async () => {
    const sellers = await User.find({ role: 'seller' }).select('_id username email currency sellerInfo createdAt').lean();
    const sellerIds = sellers.map((seller) => seller._id);
    const sellerIdSet = new Set(sellerIds.map(toId));

    const [
        stores,
        products,
        paymentAccounts,
        allWithdrawals,
        withdrawalList,
        sellerBalanceTransactions,
        pendingRiskHolds,
    ] = await Promise.all([
        Store.find({ seller: { $in: sellerIds } })
            .select('seller storeName storeSlug verification')
            .lean(),
        Product.find({ seller: { $in: sellerIds } })
            .select('_id seller')
            .lean(),
        SellerPaymentAccount.find({ seller: { $in: sellerIds } })
            .select('+accountNumber +iban')
            .lean(),
        SellerWithdrawalRequest.find({ seller: { $in: sellerIds } })
            .sort({ createdAt: -1 })
            .lean(),
        SellerWithdrawalRequest.find()
            .select('+paymentAccountSnapshotEnvelope')
            .populate('processedBy', 'username email')
            .sort({ createdAt: -1 })
            .limit(100)
            .lean(),
        SellerBalanceTransaction.find({ seller: { $in: sellerIds } }).lean(),
        SellerPaymentRiskHold.find({ seller: { $in: sellerIds }, status: 'pending' }).lean(),
    ]);

    const storeBySeller = new Map(stores.map((store) => [toId(store.seller), store]));
    const accountBySeller = new Map(paymentAccounts.map((account) => [toId(account.seller), account]));
    const productSellerById = new Map(products.map((product) => [toId(product._id), toId(product.seller)]));
    const withdrawalsBySeller = new Map();
    const balanceTransactionsBySeller = new Map();
    const pendingRiskHoldsBySeller = new Map();
    for (const request of allWithdrawals) {
        const sellerId = toId(request.seller);
        if (!withdrawalsBySeller.has(sellerId)) withdrawalsBySeller.set(sellerId, []);
        withdrawalsBySeller.get(sellerId).push(request);
    }
    for (const transaction of sellerBalanceTransactions) {
        const sellerId = toId(transaction.seller);
        if (!balanceTransactionsBySeller.has(sellerId)) balanceTransactionsBySeller.set(sellerId, []);
        balanceTransactionsBySeller.get(sellerId).push(transaction);
    }
    for (const hold of pendingRiskHolds) {
        const sellerId = toId(hold.seller);
        if (!pendingRiskHoldsBySeller.has(sellerId)) pendingRiskHoldsBySeller.set(sellerId, []);
        pendingRiskHoldsBySeller.get(sellerId).push(hold);
    }

    const revenueBySeller = new Map(sellers.map((seller) => [toId(seller._id), emptyRevenueSummary()]));
    const revenueBucketsBySeller = new Map(sellers.map((seller) => [toId(seller._id), emptyRevenueBuckets()]));
    const productIds = products.map((product) => product._id);
    let exchangeRatesForAdmin = { USD: 1 };

    if (sellerIds.length > 0) {
        const orderScopes = [
            { 'orderItems.seller': { $in: sellerIds } },
            { 'sellerSettlement.seller': { $in: sellerIds } },
        ];
        if (productIds.length > 0) orderScopes.push({ 'orderItems.productId': { $in: productIds } });

        const rateSnapshotPromise = getExchangeRateSnapshot();
        const orders = await Order.find({
            awaitingPayment: { $ne: true },
            orderStatus: { $ne: 'cancelled' },
            $or: orderScopes,
        })
            .select('orderId orderItems sellerShipping sellerFulfillment shippingMethod orderSummary appliedCoupons paymentMethod isPaid paidAt orderStatus isDelivered deliveredAt createdAt currency exchangeRateSnapshot sellerSettlementVersion sellerSettlement')
            .sort({ createdAt: -1 })
            .lean();

        const adminRateSnapshot = await rateSnapshotPromise;
        exchangeRatesForAdmin = orders.some((order) => getOrderCurrency(order) !== 'USD')
            ? adminRateSnapshot.rates
            : { USD: 1 };
        for (const order of orders) {
            if (!isLiveOrder(order)) continue;
            let settlement;
            try {
                settlement = await ensureOrderSellerSettlement(order, {
                    requireOrderTotal: true,
                    rateSnapshot: adminRateSnapshot,
                });
            } catch (error) {
                if (error?.code === 'SELLER_SETTLEMENT_HISTORICAL_RATE_MISSING') {
                    throw legacyOrderFxBackfillRequiredError();
                }
                if (error?.code === 'SELLER_SETTLEMENT_EXCHANGE_RATE_MISSING') {
                    throw withdrawalRatesUnavailableError();
                }
                throw error;
            }
            for (const sellerSettlement of settlement) {
                const sellerId = toId(sellerSettlement.seller);
                if (!sellerIdSet.has(sellerId)) continue;
                if (!isLiveOrderForSeller(order, sellerId)) continue;
                if (sellerSettlement.sourceAmountMinor <= 0) continue;

                const revenue = revenueBySeller.get(sellerId);
                if (!revenue) continue;
                revenue.totalRelevantOrders += 1;

                addOrderRevenueToBuckets(
                    revenue,
                    revenueBucketsBySeller.get(sellerId),
                    order,
                    fromMinorUnits(sellerSettlement.sourceAmountMinor),
                    sellerSettlement.sourceCurrency,
                    sellerId,
                    sellerSettlement.amountUSDMinor
                );
            }
        }
    }

    const sellerRows = sellers.map((seller) => {
        const sellerId = toId(seller._id);
        const revenue = revenueBySeller.get(sellerId) || emptyRevenueSummary();
        const canonicalOrderRevenue = materializeRevenueBuckets(
            revenueBucketsBySeller.get(sellerId) || emptyRevenueBuckets(),
            'USD',
            exchangeRatesForAdmin
        );
        REVENUE_MONEY_FIELDS.forEach(field => { revenue[field] = canonicalOrderRevenue[field]; });
        addWithdrawalTotalsToSummary(revenue, withdrawalsBySeller.get(sellerId) || []);
        addSellerBalanceTransactionsToSummary(revenue, balanceTransactionsBySeller.get(sellerId) || []);
        finalizeRevenueSummary(revenue);
        const sellerPendingRiskHolds = pendingRiskHoldsBySeller.get(sellerId) || [];
        if (sellerPendingRiskHolds.length) {
            revenue.paymentRiskHeldAmount = revenue.withdrawableBalance;
            revenue.withdrawableBalance = 0;
        }

        return {
            seller: {
                _id: seller._id,
                username: seller.username,
                email: seller.email,
                currency: normalizeCurrency(seller.currency || 'USD'),
            },
            store: storeBySeller.get(sellerId) || null,
            paymentRiskPending: sellerPendingRiskHolds.length > 0,
            paymentRiskHoldCount: sellerPendingRiskHolds.length,
            revenue,
            paymentAccount: serializePaymentAccount(accountBySeller.get(sellerId), { includeSensitive: true }),
        };
    });

    const totals = emptyRevenueSummary();
    sellerRows.forEach((row) => addSummaryToTotals(totals, row.revenue));
    Object.keys(totals).forEach((key) => {
        if (typeof totals[key] === 'number') totals[key] = roundMoney(totals[key]);
    });

    return {
        summary: totals,
        sellers: sellerRows,
        withdrawals: withdrawalList.map((request) => {
            const rawSellerId = toId(request.seller);
            const seller = sellers.find(candidate => toId(candidate._id) === rawSellerId);
            const serialized = serializeWithdrawalRequest(request, {
                includeSensitivePayout: true,
            });
            serialized.seller = seller
                ? {
                    _id: seller._id,
                    username: seller.username,
                    email: seller.email,
                    currency: normalizeCurrency(seller.currency || 'USD'),
                }
                : {
                    _id: request.seller,
                    username: 'Deleted seller',
                    email: '',
                    currency: normalizeCurrency(request.requestedCurrency || 'USD'),
                    deleted: true,
                };
            return serialized;
        }),
        errors: [],
    };
};

exports.buildAdminPaymentsOverviewData = buildAdminPaymentsOverviewData;

exports.getAdminPaymentsOverview = async (req, res) => {
    try {
        if (req.user?.role !== 'admin') {
            return res.status(403).json({ msg: 'Admin access only' });
        }

        const overview = await buildAdminPaymentsOverviewData();

        return res.status(200).json({
            success: true,
            ...overview,
        });
    } catch (error) {
        console.error('[payments] admin overview error:', error);
        return res.status(500).json({ msg: 'Failed to fetch admin payments overview' });
    }
};

exports.updateWithdrawalRequestStatus = async (req, res) => {
    let operationKey = '';
    let operationFingerprint = '';
    try {
        if (req.user?.role !== 'admin') {
            return res.status(403).json({ msg: 'Admin access only' });
        }

        operationKey = normalizeWithdrawalOperationKey(req);
        const action = normalizeWithdrawalAction(req.body || {});
        operationFingerprint = withdrawalActionFingerprint(action);
        if (!Object.prototype.hasOwnProperty.call(WITHDRAWAL_TRANSITIONS, action.status)) {
            throw withdrawalActionError('Invalid withdrawal status.', 'INVALID_WITHDRAWAL_STATUS');
        }
        if (!Object.prototype.hasOwnProperty.call(WITHDRAWAL_TRANSITIONS, action.expectedStatus)) {
            throw withdrawalActionError(
                'Expected withdrawal status is invalid.',
                'INVALID_EXPECTED_WITHDRAWAL_STATUS'
            );
        }

        const existing = await SellerWithdrawalRequest.findById(req.params.id)
            .select('+paymentAccountSnapshotEnvelope +adminOperations')
            .lean();
        if (!existing) {
            return res.status(404).json({ msg: 'Withdrawal request not found' });
        }

        const existingOperation = findAdminOperation(existing, operationKey);
        if (existingOperation) {
            assertOperationReplayMatches(existingOperation, operationFingerprint);
            return res.status(200).json({
                success: true,
                reused: true,
                msg: 'Withdrawal operation already applied',
                withdrawal: serializeWithdrawalRequest(existing, { includeSensitivePayout: true }),
            });
        }
        if (existing.status !== action.expectedStatus) {
            throw withdrawalActionError(
                `Withdrawal changed from ${action.expectedStatus} to ${existing.status}. Refresh before acting.`,
                'WITHDRAWAL_STALE_STATUS',
                409,
                { currentStatus: existing.status }
            );
        }
        if (isLegacyProcessingWithdrawal(existing) && action.status !== 'manual_review') {
            throw withdrawalActionError(
                'This legacy processing withdrawal has no auditable payout attempt. Move it to manual review and reconcile the bank outcome before any other action.',
                'WITHDRAWAL_LEGACY_PROCESSING_QUARANTINED',
                409,
                { currentStatus: existing.status }
            );
        }
        if (!canTransitionWithdrawalStatus(existing.status, action.status)) {
            throw withdrawalActionError(
                `Withdrawal cannot move from ${existing.status} to ${action.status}.`,
                'INVALID_WITHDRAWAL_TRANSITION',
                409,
                { currentStatus: existing.status }
            );
        }

        const checksNewPayoutAuthority = ['approved', 'processing'].includes(action.status);
        const transitionRateSnapshot = checksNewPayoutAuthority
            ? await getExchangeRateSnapshot()
            : null;

        const transitionResult = await runInTransaction(async (session) => {
            await SellerSettlementLock.findOneAndUpdate(
                { seller: existing.seller },
                { $setOnInsert: { seller: existing.seller }, $inc: { version: 1 } },
                { upsert: true, new: true, session }
            );

            const current = await SellerWithdrawalRequest.findById(req.params.id)
                .select('+paymentAccountSnapshotEnvelope +adminOperations')
                .session(session);
            if (!current) return null;

            const replayedOperation = findAdminOperation(current, operationKey);
            if (replayedOperation) {
                assertOperationReplayMatches(replayedOperation, operationFingerprint);
                return { request: current, reused: true };
            }
            if (current.status !== action.expectedStatus) {
                throw withdrawalActionError(
                    `Withdrawal changed from ${action.expectedStatus} to ${current.status}. Refresh before acting.`,
                    'WITHDRAWAL_STALE_STATUS',
                    409,
                    { currentStatus: current.status }
                );
            }
            const legacyProcessing = isLegacyProcessingWithdrawal(current);
            if (legacyProcessing && action.status !== 'manual_review') {
                throw withdrawalActionError(
                    'This legacy processing withdrawal has no auditable payout attempt. Move it to manual review and reconcile the bank outcome before any other action.',
                    'WITHDRAWAL_LEGACY_PROCESSING_QUARANTINED',
                    409,
                    { currentStatus: current.status }
                );
            }
            if (!canTransitionWithdrawalStatus(current.status, action.status)) {
                throw withdrawalActionError(
                    `Withdrawal cannot move from ${current.status} to ${action.status}.`,
                    'INVALID_WITHDRAWAL_TRANSITION',
                    409,
                    { currentStatus: current.status }
                );
            }
            if ((current.adminOperations || []).length >= 200) {
                throw withdrawalActionError(
                    'This withdrawal reached its audit-operation limit and requires support review.',
                    'WITHDRAWAL_AUDIT_LIMIT_REACHED',
                    409
                );
            }

            if (checksNewPayoutAuthority) {
                // Approval/retry and transfer initiation are the only points at
                // which new payout authority is granted. They require the exact
                // frozen destination and a currently covered reservation.
                readFrozenPayoutDestination(current);
                const summary = await buildSellerPaymentSummary(current.seller, {
                    session,
                    displayCurrency: 'USD',
                    rateSnapshot: transitionRateSnapshot,
                });
                if (summary.paymentRiskPending) {
                    throw withdrawalActionError(
                        'This withdrawal cannot advance while a Stripe refund or dispute is still being reconciled.',
                        'SELLER_PAYMENT_RISK_PENDING',
                        409
                    );
                }
                if (
                    toMinorUnits(summary.revenue.totalReservedOrWithdrawn)
                    > toMinorUnits(summary.revenue.onlineDeliveredRevenue)
                ) {
                    throw withdrawalActionError(
                        'This withdrawal is no longer covered by delivered online revenue. Review recent payment refunds or disputes first.',
                        'WITHDRAWAL_BALANCE_AT_RISK',
                        409
                    );
                }
                if (
                    current.status === 'failed'
                    && toMinorUnits(current.amount) > toMinorUnits(summary.revenue.withdrawableBalance)
                ) {
                    throw withdrawalActionError(
                        'The seller no longer has enough available balance to reserve this failed withdrawal for retry.',
                        'WITHDRAWAL_RETRY_BALANCE_UNAVAILABLE',
                        409
                    );
                }
            }

            const now = new Date();
            let operationAttemptId;
            if (action.status === 'processing') {
                if ((current.payoutAttempts || []).length >= 50) {
                    throw withdrawalActionError(
                        'This withdrawal reached its payout-attempt limit and cannot be retried automatically.',
                        'WITHDRAWAL_PAYOUT_ATTEMPT_LIMIT_REACHED',
                        409
                    );
                }
                const provider = strictActionText(action.payoutProvider, 'Payout provider', {
                    required: true,
                    min: 2,
                    max: 120,
                });
                operationAttemptId = action.attemptId || operationKey;
                if (findPayoutAttempt(current, operationAttemptId)) {
                    throw withdrawalActionError(
                        'This payout attempt ID already exists.',
                        'WITHDRAWAL_PAYOUT_ATTEMPT_CONFLICT',
                        409
                    );
                }
                current.payoutAttempts.push({
                    attemptId: operationAttemptId,
                    sequence: current.payoutAttempts.length + 1,
                    provider,
                    status: 'processing',
                    initiatedBy: req.user.id,
                    startedAt: now,
                    updatedAt: now,
                });
                current.payoutWorkflowVersion = 1;
                current.activePayoutAttemptId = operationAttemptId;
            } else if (action.status === 'manual_review') {
                const reconciliationNote = strictActionText(
                    action.reconciliationNote || action.adminNote,
                    'Reconciliation note',
                    { required: true, min: 8, max: 1000 }
                );
                let attempt;
                if (legacyProcessing) {
                    if ((current.payoutAttempts || []).length >= 50) {
                        throw withdrawalActionError(
                            'This withdrawal reached its payout-attempt limit and requires support review.',
                            'WITHDRAWAL_PAYOUT_ATTEMPT_LIMIT_REACHED',
                            409
                        );
                    }
                    const provider = strictActionText(action.payoutProvider, 'Payout provider', {
                        required: true,
                        min: 2,
                        max: 120,
                    });
                    operationAttemptId = action.attemptId || operationKey;
                    if (findPayoutAttempt(current, operationAttemptId)) {
                        throw withdrawalActionError(
                            'This payout attempt ID already exists.',
                            'WITHDRAWAL_PAYOUT_ATTEMPT_CONFLICT',
                            409
                        );
                    }
                    attempt = {
                        attemptId: operationAttemptId,
                        sequence: current.payoutAttempts.length + 1,
                        provider,
                        status: 'manual_review',
                        initiatedBy: req.user.id,
                        startedAt: current.processedAt || current.updatedAt || current.createdAt || now,
                        updatedAt: now,
                        reconciliationNote,
                        legacyImported: true,
                    };
                    current.payoutAttempts.push(attempt);
                    current.payoutWorkflowVersion = 1;
                    current.activePayoutAttemptId = operationAttemptId;
                } else {
                    attempt = requireMatchingActivePayoutAttempt(current, action.attemptId);
                    operationAttemptId = attempt.attemptId;
                    attempt.status = 'manual_review';
                    attempt.updatedAt = now;
                    attempt.reconciliationNote = reconciliationNote;
                }
            } else if (action.status === 'failed') {
                if (action.failureCertainty !== 'definitively_not_sent') {
                    throw withdrawalActionError(
                        'Failure can release the reservation only after confirming that no transfer was sent.',
                        'WITHDRAWAL_FAILURE_NOT_DEFINITIVE',
                        409
                    );
                }
                const failureReason = strictActionText(action.failureReason, 'Failure reason', {
                    required: true,
                    min: 8,
                    max: 1000,
                });
                const attempt = requireMatchingActivePayoutAttempt(current, action.attemptId);
                operationAttemptId = attempt.attemptId;
                attempt.status = 'failed';
                attempt.updatedAt = now;
                attempt.resolvedAt = now;
                attempt.failureCertainty = 'definitively_not_sent';
                attempt.failureCode = action.failureCode;
                attempt.failureReason = failureReason;
                current.activePayoutAttemptId = undefined;
            } else if (action.status === 'paid') {
                const attempt = requireMatchingActivePayoutAttempt(current, action.attemptId);
                operationAttemptId = attempt.attemptId;
                if (!attempt.legacyImported) readFrozenPayoutDestination(current);
                if (action.payoutProvider && action.payoutProvider !== attempt.provider) {
                    throw withdrawalActionError(
                        'Payout provider does not match the active payout attempt.',
                        'WITHDRAWAL_PAYOUT_PROVIDER_MISMATCH',
                        409
                    );
                }
                const transferReference = strictActionText(
                    action.transferReference,
                    'Transfer reference',
                    { required: true, min: 4, max: 200 }
                );
                if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{3,199}$/.test(transferReference)) {
                    throw withdrawalActionError(
                        'Transfer reference contains unsupported characters.',
                        'WITHDRAWAL_TRANSFER_REFERENCE_INVALID'
                    );
                }
                const providerKey = attempt.provider.toLowerCase();
                const transferReferenceKey = transferReference.toUpperCase();
                const evidenceTypes = new Set([
                    'provider_reference',
                    'receipt',
                    'bank_statement',
                    'manual_confirmation',
                ]);
                if (!evidenceTypes.has(action.evidenceType)) {
                    throw withdrawalActionError(
                        'Choose valid transfer evidence before marking this withdrawal paid.',
                        'WITHDRAWAL_PAYOUT_EVIDENCE_REQUIRED'
                    );
                }
                if (!action.transferredAt) {
                    throw withdrawalActionError(
                        'Transfer timestamp is required before marking this withdrawal paid.',
                        'WITHDRAWAL_TRANSFER_TIMESTAMP_REQUIRED'
                    );
                }
                const transferredAt = new Date(action.transferredAt);
                const requestCreatedAt = new Date(current.createdAt || 0);
                if (
                    transferredAt.getTime() > now.getTime() + (5 * 60 * 1000)
                    || transferredAt.getTime() < requestCreatedAt.getTime() - (5 * 60 * 1000)
                ) {
                    throw withdrawalActionError(
                        'Transfer timestamp must correspond to this withdrawal and cannot be in the future.',
                        'WITHDRAWAL_TRANSFER_TIMESTAMP_INVALID'
                    );
                }
                if (
                    ['receipt', 'bank_statement', 'manual_confirmation'].includes(action.evidenceType)
                    && !action.evidenceUrl
                    && action.evidenceNote.length < 8
                ) {
                    throw withdrawalActionError(
                        'Receipt, statement, and manual evidence require an HTTPS link or a detailed evidence note.',
                        'WITHDRAWAL_PAYOUT_EVIDENCE_REQUIRED'
                    );
                }
                const duplicateReference = await SellerWithdrawalRequest.findOne({
                    _id: { $ne: current._id },
                    paidPayoutProviderKey: providerKey,
                    paidTransferReferenceKey: transferReferenceKey,
                }).session(session).select('_id').lean();
                if (duplicateReference) {
                    throw withdrawalActionError(
                        'This provider transfer reference is already attached to another withdrawal.',
                        'WITHDRAWAL_TRANSFER_REFERENCE_ALREADY_USED',
                        409
                    );
                }
                attempt.status = 'paid';
                attempt.updatedAt = now;
                attempt.resolvedAt = now;
                attempt.transferReference = transferReference;
                attempt.transferredAt = transferredAt;
                attempt.evidence = {
                    type: action.evidenceType,
                    reference: transferReference,
                    url: action.evidenceUrl || undefined,
                    note: action.evidenceNote,
                    recordedAt: now,
                    recordedBy: req.user.id,
                };
                current.activePayoutAttemptId = undefined;
                current.paidPayoutAttemptId = attempt.attemptId;
                current.paidPayoutProvider = attempt.provider;
                current.paidPayoutProviderKey = providerKey;
                current.paidTransferReference = transferReference;
                current.paidTransferReferenceKey = transferReferenceKey;
            }

            const fromStatus = current.status;
            current.status = action.status;
            current.adminNote = action.adminNote;
            current.processedBy = req.user.id;
            current.processedAt = ['paid', 'failed', 'rejected', 'cancelled'].includes(action.status)
                ? now
                : null;
            current.adminOperations.push({
                operationKey,
                payloadFingerprint: operationFingerprint,
                fromStatus,
                toStatus: action.status,
                attemptId: operationAttemptId,
                appliedAt: now,
                appliedBy: req.user.id,
            });
            await current.save({ session });
            await enqueueWithdrawalStatusSellerNotifications(current, { session });
            return { request: current, reused: false };
        });
        if (!transitionResult) {
            return res.status(404).json({ msg: 'Withdrawal request not found' });
        }

        const { request, reused } = transitionResult;
        if (reused) {
            return res.status(200).json({
                success: true,
                reused: true,
                msg: 'Withdrawal operation already applied',
                withdrawal: serializeWithdrawalRequest(request, { includeSensitivePayout: true }),
            });
        }

        return res.status(200).json({
            success: true,
            reused: false,
            msg: 'Withdrawal request updated',
            withdrawal: serializeWithdrawalRequest(request, { includeSensitivePayout: true }),
        });
    } catch (error) {
        if (error?.name === 'VersionError' && operationKey && operationFingerprint) {
            const latest = await SellerWithdrawalRequest.findById(req.params.id)
                .select('+paymentAccountSnapshotEnvelope +adminOperations')
                .lean()
                .catch(() => null);
            const operation = findAdminOperation(latest, operationKey);
            if (operation) {
                try {
                    assertOperationReplayMatches(operation, operationFingerprint);
                    return res.status(200).json({
                        success: true,
                        reused: true,
                        msg: 'Withdrawal operation already applied',
                        withdrawal: serializeWithdrawalRequest(latest, { includeSensitivePayout: true }),
                    });
                } catch (replayError) {
                    error = replayError;
                }
            } else {
                error = withdrawalActionError(
                    'The withdrawal changed concurrently. Refresh before trying another action.',
                    'WITHDRAWAL_CONCURRENT_UPDATE',
                    409
                );
            }
        }
        if (error?.code === 11000) {
            error = withdrawalActionError(
                'This provider transfer reference is already attached to another withdrawal.',
                'WITHDRAWAL_TRANSFER_REFERENCE_ALREADY_USED',
                409
            );
        }
        console.error('[payments] withdrawal update error:', error);
        return res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : 'Failed to update withdrawal request',
            code: error.code,
            currentStatus: error.currentStatus,
        });
    }
};
