const mongoose = require('mongoose');
const WalletTransaction = require('../models/WalletTransaction');
const Notification = require('../models/Notification');
const { stripe, STRIPE_MODE } = require('../config/stripe');
const { convertAmountUsingTrustedRates } = require('../services/currencyService');
const {
    getWalletSummary,
    ensureWallet,
    normalizeWalletCurrency,
    roundMoney,
    walletTopUpDescription,
    serializeWalletTransaction,
    validateWalletTopUpPaymentIntent,
    validateWalletTopUpCheckoutSession,
    recoverWalletTopUpStripeSetup,
    closeWalletTopUpWithoutStripeReference,
    cancelWalletTopUpFromPaymentIntent,
    completeWalletTopUp,
    completeWalletTopUpFromPaymentIntent,
    failWalletTopUp,
    reconcileWalletPaymentLiability,
} = require('../services/walletService');
const {
    getWalletPaymentRiskSummary,
    isWalletPaymentRiskLock,
} = require('../services/walletPaymentLiabilityService');
const {
    ensureStripeCustomerForUser,
    createMobileCustomerAccess,
    getStripeMobileConfig,
} = require('../services/stripeCustomerService');
const {
    createPaymentExpiry,
    closeWalletTopUpPaymentIntent,
} = require('../services/stripePendingPaymentService');
const {
    enqueueWalletTransactionNotification,
} = require('../services/financialNotificationOutboxService');

const configuredPositiveUsdLimit = (name, fallback, environment = process.env) => {
    const raw = environment[name];
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive finite USD amount.`);
    }
    const normalizedValue = roundMoney(value);
    if (normalizedValue <= 0) {
        throw new Error(`${name} must be at least 0.01 USD after cent rounding.`);
    }
    return normalizedValue;
};

const configuredWalletTopUpLimits = (environment = process.env) => {
    const minimumUSD = configuredPositiveUsdLimit('WALLET_MIN_TOP_UP_USD', 1, environment);
    const maximumUSD = configuredPositiveUsdLimit('WALLET_MAX_TOP_UP_USD', 10000, environment);
    if (maximumUSD < minimumUSD) {
        throw new Error('WALLET_MAX_TOP_UP_USD must be greater than or equal to WALLET_MIN_TOP_UP_USD.');
    }
    return { minimumUSD, maximumUSD };
};

const {
    minimumUSD: MIN_TOP_UP_USD,
    maximumUSD: MAX_TOP_UP_USD,
} = configuredWalletTopUpLimits();

exports.__private = {
    configuredPositiveUsdLimit,
    configuredWalletTopUpLimits,
};

const parseWalletTopUpAmount = (rawAmount) => {
    const invalid = () => {
        const error = new Error('Enter a valid Wallet top-up amount greater than zero.');
        error.statusCode = 400;
        error.code = 'WALLET_TOP_UP_AMOUNT_INVALID';
        return error;
    };
    if (
        rawAmount === null
        || rawAmount === undefined
        || typeof rawAmount === 'boolean'
        || !['number', 'string'].includes(typeof rawAmount)
        || (typeof rawAmount === 'string' && rawAmount.trim() === '')
        || !Number.isFinite(Number(rawAmount))
    ) throw invalid();

    let amount;
    try {
        amount = roundMoney(rawAmount);
    } catch (error) {
        if (error?.code !== 'MONEY_AMOUNT_OUT_OF_RANGE') throw error;
        const rangeError = new Error('Wallet top-up amount is too large to process safely.');
        rangeError.statusCode = 400;
        rangeError.code = 'WALLET_TOP_UP_AMOUNT_OUT_OF_RANGE';
        throw rangeError;
    }
    if (!Number.isFinite(amount) || amount <= 0) throw invalid();
    return amount;
};

const expireHostedWalletSessionIfDue = async (transaction, checkoutSession, now = new Date()) => {
    if (
        transaction?.status !== 'pending'
        || !transaction.paymentExpiresAt
        || transaction.paymentExpiresAt > now
        || checkoutSession?.status !== 'open'
    ) return checkoutSession;

    let authoritative = checkoutSession;
    try {
        authoritative = await stripe.checkout.sessions.expire(checkoutSession.id);
    } catch (expireError) {
        // Payment completion can win between retrieve and expire. Re-read the
        // signed/provider-authoritative state before any local close.
        authoritative = await stripe.checkout.sessions.retrieve(checkoutSession.id);
        if (
            authoritative.payment_status !== 'paid'
            && authoritative.status !== 'expired'
            && !(authoritative.status === 'complete' && authoritative.payment_status !== 'paid')
        ) throw expireError;
    }
    validateWalletTopUpCheckoutSession(transaction, authoritative);
    return authoritative;
};

exports.getMyWallet = async (req, res) => {
    try {
        const summary = await getWalletSummary(req.user.id, { limit: req.query.limit });
        return res.status(200).json({ success: true, ...summary });
    } catch (error) {
        console.error('[wallet] summary error:', error);
        return res.status(error.statusCode || 500).json({ msg: error.message || 'Failed to load Rozare Wallet' });
    }
};

exports.createTopUpCheckout = async (req, res) => {
    let transaction = null;
    try {
        const amount = parseWalletTopUpAmount(req.body?.amount);
        if (!stripe) {
            return res.status(503).json({ msg: 'Card payments are not configured.' });
        }

        const currency = normalizeWalletCurrency(req.body?.currency || req.user?.currency || 'USD');
        // The USD-equivalent risk limits are part of a monetary write. Do not
        // approve a non-USD top-up from hard-coded or stale display rates.
        const amountUSD = await convertAmountUsingTrustedRates(amount, currency, 'USD');
        if (amountUSD < MIN_TOP_UP_USD || amountUSD > MAX_TOP_UP_USD) {
            return res.status(400).json({
                msg: `Wallet top-ups must be between $${MIN_TOP_UP_USD} and $${MAX_TOP_UP_USD} USD equivalent.`,
                code: 'WALLET_TOP_UP_LIMIT',
            });
        }

        const requestedFlow = req.body?.paymentFlow || req.body?.payment_flow;
        const paymentFlow = requestedFlow === 'payment_sheet' ? 'payment_sheet' : 'checkout_session';
        const clientSurface = ['mobile', 'web'].includes(req.body?.clientSurface)
            ? req.body.clientSurface
            : req.body?.platform === 'mobile' ? 'mobile' : 'web';
        if (paymentFlow === 'payment_sheet' && clientSurface !== 'mobile') {
            return res.status(400).json({
                msg: 'Stripe PaymentSheet is available only in the mobile app.',
                code: 'PAYMENT_SHEET_MOBILE_ONLY',
            });
        }
        const rawRequestKey = String(req.body?.requestKey || '').trim();
        if (!rawRequestKey) {
            return res.status(400).json({
                msg: 'A requestKey is required for every Wallet top-up.',
                code: 'IDEMPOTENCY_KEY_REQUIRED',
            });
        }
        if (rawRequestKey.length > 160) {
            return res.status(400).json({ msg: 'Invalid Wallet top-up requestKey.', code: 'INVALID_IDEMPOTENCY_KEY' });
        }
        const requestKey = rawRequestKey.slice(0, 160);
        if (!/^[A-Za-z0-9:_\-.]+$/.test(requestKey)) {
            return res.status(400).json({ msg: 'Invalid Wallet top-up requestKey.', code: 'INVALID_IDEMPOTENCY_KEY' });
        }
        const idempotencyKey = `wallet-topup:${req.user.id}:${requestKey}`;
        const existing = await WalletTransaction.findOne({ idempotencyKey });
        transaction = existing || null;
        if (existing && (
            Number(existing.amount) !== amount
            || existing.currency !== currency
            || (existing.paymentFlow || 'checkout_session') !== paymentFlow
            || (existing.clientSurface || 'unknown') !== clientSurface
        )) {
            return res.status(409).json({
                msg: 'This requestKey was already used with different top-up details.',
                code: 'IDEMPOTENCY_CONFLICT',
            });
        }
        if (existing?.status === 'completed') {
            return res.status(200).json({
                success: true,
                completed: true,
                transactionId: existing._id,
                topUpId: existing._id,
                transaction: serializeWalletTransaction(existing.toObject()),
            });
        }
        if (existing && existing.status !== 'pending') {
            return res.status(409).json({
                msg: 'That Wallet top-up attempt is closed. Start a new top-up with a new requestKey.',
                code: 'WALLET_TOP_UP_RETRY_REQUIRED',
            });
        }
        if (existing?.status === 'pending' && paymentFlow === 'payment_sheet' && existing.stripePaymentIntentId) {
            let intent;
            try {
                intent = await stripe.paymentIntents.retrieve(existing.stripePaymentIntentId);
            } catch (retrieveError) {
                if (retrieveError?.code === 'resource_missing') {
                    existing.status = 'failed';
                    existing.paymentSetupState = 'closed';
                    existing.paymentSetupCompletedAt = new Date();
                    existing.failureReason = 'The secure Stripe PaymentIntent is no longer available.';
                    await existing.save();
                    return res.status(409).json({
                        msg: 'That Wallet top-up attempt is closed. Start a new top-up with a new requestKey.',
                        code: 'WALLET_TOP_UP_RETRY_REQUIRED',
                    });
                }
                throw retrieveError;
            }
            validateWalletTopUpPaymentIntent(existing, intent);
            if (existing.paymentExpiresAt && existing.paymentExpiresAt <= new Date() && intent.status !== 'succeeded') {
                await closeWalletTopUpPaymentIntent(existing, {
                    status: 'expired',
                    reason: 'The secure mobile Wallet top-up window expired.',
                    requireExpired: true,
                });
                return res.status(409).json({
                    msg: 'That Wallet top-up attempt expired. Start a new top-up.',
                    code: 'WALLET_TOP_UP_RETRY_REQUIRED',
                });
            }
            if (intent.status === 'canceled') {
                existing.status = 'cancelled';
                existing.paymentSetupState = 'closed';
                existing.paymentSetupCompletedAt = new Date();
                existing.failureReason = 'Stripe confirmed that this Wallet top-up was cancelled.';
                await existing.save();
                return res.status(409).json({
                    msg: 'That Wallet top-up attempt is closed. Start a new top-up.',
                    code: 'WALLET_TOP_UP_RETRY_REQUIRED',
                });
            }
            if (intent.status === 'succeeded') {
                const completed = await completeWalletTopUpFromPaymentIntent(
                    intent,
                    `api-recovery:${intent.id}`,
                );
                await exports.notifyTopUpCompleted(completed);
                return res.status(200).json({
                    success: true,
                    completed: true,
                    webhookProcessed: true,
                    stripePaymentReceived: true,
                    paymentFlow: 'payment_sheet',
                    paymentIntentId: intent.id,
                    transactionId: completed._id,
                    topUpId: completed._id,
                    status: completed.status,
                    transaction: serializeWalletTransaction(completed.toObject()),
                });
            }
            const customerAccess = await createMobileCustomerAccess(existing.stripeCustomerId);
            res.set('Cache-Control', 'no-store, private, max-age=0');
            return res.status(200).json({
                success: true,
                idempotentReplay: true,
                paymentFlow: 'payment_sheet',
                paymentIntentId: intent.id,
                transactionId: existing._id,
                topUpId: existing._id,
                paymentIntentClientSecret: intent.client_secret,
                customerId: existing.stripeCustomerId,
                ...customerAccess,
                expiresAt: existing.paymentExpiresAt,
                transaction: serializeWalletTransaction(existing.toObject()),
                ...getStripeMobileConfig(),
            });
        }
        if (existing?.status === 'pending' && existing.stripeSessionId) {
            let existingSession;
            try {
                existingSession = await stripe.checkout.sessions.retrieve(existing.stripeSessionId);
            } catch (retrieveError) {
                if (retrieveError?.code === 'resource_missing') {
                    existing.status = 'failed';
                    existing.paymentSetupState = 'closed';
                    existing.paymentSetupCompletedAt = new Date();
                    existing.failureReason = 'The secure Stripe Checkout Session is no longer available.';
                    await existing.save();
                    return res.status(409).json({
                        msg: 'That Wallet top-up attempt is closed. Start a new top-up with a new requestKey.',
                        code: 'WALLET_TOP_UP_RETRY_REQUIRED',
                    });
                }
                throw retrieveError;
            }
            validateWalletTopUpCheckoutSession(existing, existingSession);
            existingSession = await expireHostedWalletSessionIfDue(existing, existingSession);
            if (existingSession?.status === 'open' && existingSession.url) {
                return res.status(200).json({
                    success: true,
                    id: existingSession.id,
                    url: existingSession.url,
                    transactionId: existing._id,
                    topUpId: existing._id,
                    transaction: serializeWalletTransaction(existing.toObject()),
                });
            }
            if (existingSession?.status === 'complete' && existingSession.payment_status === 'paid') {
                const completed = await completeWalletTopUp(
                    existingSession,
                    `api-recovery:${existingSession.id}`,
                );
                await exports.notifyTopUpCompleted(completed);
                return res.status(200).json({
                    success: true,
                    completed: true,
                    webhookProcessed: true,
                    stripePaymentReceived: true,
                    transactionId: completed._id,
                    topUpId: completed._id,
                    status: completed.status,
                    transaction: serializeWalletTransaction(completed.toObject()),
                });
            }
            if (existingSession?.status === 'expired' || existingSession?.status === 'complete') {
                existing.status = existingSession.status === 'expired' ? 'expired' : 'failed';
                existing.paymentSetupState = 'closed';
                existing.paymentSetupCompletedAt = new Date();
                existing.failureReason = 'The hosted Wallet top-up did not complete successfully.';
                await existing.save();
                return res.status(409).json({
                    msg: 'That Wallet top-up attempt is closed. Start a new top-up with a new requestKey.',
                    code: 'WALLET_TOP_UP_RETRY_REQUIRED',
                });
            }
            const recoveryError = new Error('Secure Wallet checkout status is temporarily unavailable.');
            recoveryError.code = 'PAYMENT_ATTEMPT_RECOVERY_PENDING';
            throw recoveryError;
        }

        if (
            existing?.status === 'pending'
            && existing.paymentExpiresAt
            && existing.paymentExpiresAt <= new Date()
            && !existing.stripePaymentIntentId
            && !existing.stripeSessionId
            && existing.paymentSetupState === 'not_started'
        ) {
            await closeWalletTopUpWithoutStripeReference(existing, {
                status: 'expired',
                reason: 'The secure Wallet top-up window expired.',
                requireExpired: true,
            });
            return res.status(409).json({
                msg: 'That Wallet top-up attempt expired. Start a new top-up with a new requestKey.',
                code: 'WALLET_TOP_UP_RETRY_REQUIRED',
            });
        }

        if (existing && existing.status !== 'pending') {
            return res.status(409).json({
                msg: 'That Wallet top-up attempt is closed. Start a new top-up to receive a fresh secure checkout.',
                code: 'WALLET_TOP_UP_RETRY_REQUIRED',
            });
        }

        const wallet = await ensureWallet(req.user.id);
        if (wallet.status !== 'active' && !existing) {
            const paymentRisk = await getWalletPaymentRiskSummary(wallet._id);
            const outstanding = paymentRisk.byCurrency[currency]?.outstanding || 0;
            if (outstanding <= 0 || !isWalletPaymentRiskLock(wallet)) {
                return res.status(423).json({
                    msg: outstanding > 0
                        ? 'Your Rozare Wallet has an independent security lock. Contact support before adding funds.'
                        : 'Your Rozare Wallet is locked while a card dispute is reviewed.',
                    code: 'WALLET_LOCKED',
                    paymentRisk,
                });
            }
            // Completion applies every cent FIFO to terminal debt before any
            // surplus becomes available. Partial payments remain restricted,
            // while overpayments settle debt and credit only the remainder.
        }
        const { customer, user } = await ensureStripeCustomerForUser(req.user.id);
        const expiresAt = paymentFlow === 'payment_sheet'
            ? createPaymentExpiry()
            : new Date(Date.now() + 35 * 60 * 1000);
        transaction = existing || await WalletTransaction.findOneAndUpdate(
            { idempotencyKey, user: req.user.id, type: 'top_up' },
            {
                $setOnInsert: {
                    user: req.user.id,
                    type: 'top_up',
                    direction: 'credit',
                    status: 'pending',
                    amount,
                    currency,
                    description: walletTopUpDescription(amount, currency),
                    referenceType: paymentFlow === 'payment_sheet' ? 'stripe_payment_intent' : 'stripe_checkout',
                    referenceId: requestKey,
                    idempotencyKey,
                    stripeCustomerId: customer.id,
                    stripeMode: STRIPE_MODE,
                    paymentFlow,
                    paymentSetupState: 'not_started',
                    clientSurface,
                    paymentExpiresAt: expiresAt,
                    metadata: {
                        requestedBy: req.user.id,
                        paymentFlow,
                        clientSurface,
                        receiptEmail: user.email || '',
                    },
                },
            },
            {
                new: true,
                upsert: true,
                setDefaultsOnInsert: true,
                runValidators: true,
                context: 'query',
            },
        );

        if (
            Number(transaction.amount) !== amount
            || transaction.currency !== currency
            || transaction.paymentFlow !== paymentFlow
            || transaction.clientSurface !== clientSurface
        ) {
            return res.status(409).json({
                msg: 'This requestKey was already used with different top-up details.',
                code: 'IDEMPOTENCY_CONFLICT',
            });
        }

        if (paymentFlow === 'payment_sheet') {
            const setup = await recoverWalletTopUpStripeSetup(transaction);
            transaction = setup.transaction;
            const paymentIntent = setup.stripeObject;
            if (paymentIntent.status === 'canceled') {
                transaction = await cancelWalletTopUpFromPaymentIntent(paymentIntent, {
                    status: 'cancelled',
                    reason: 'Stripe confirmed that this Wallet top-up was cancelled.',
                }) || transaction;
                return res.status(409).json({
                    msg: 'That Wallet top-up attempt is closed. Start a new top-up.',
                    code: 'WALLET_TOP_UP_RETRY_REQUIRED',
                });
            }
            if (paymentIntent.status === 'succeeded') {
                const completed = await completeWalletTopUpFromPaymentIntent(
                    paymentIntent,
                    `api-recovery:${paymentIntent.id}`,
                );
                await exports.notifyTopUpCompleted(completed);
                return res.status(200).json({
                    success: true,
                    completed: true,
                    webhookProcessed: true,
                    stripePaymentReceived: true,
                    paymentFlow: 'payment_sheet',
                    paymentIntentId: paymentIntent.id,
                    transactionId: completed._id,
                    topUpId: completed._id,
                    status: completed.status,
                    transaction: serializeWalletTransaction(completed.toObject()),
                });
            }
            let customerAccess;
            try {
                customerAccess = await createMobileCustomerAccess(transaction.stripeCustomerId);
            } catch (customerSessionError) {
                let closed;
                try {
                    closed = await closeWalletTopUpPaymentIntent(transaction, {
                        status: 'cancelled',
                        reason: 'Stripe CustomerSession preparation failed before PaymentSheet opened.',
                    });
                    transaction = closed?.transaction || transaction;
                } catch (cleanupError) {
                    cleanupError.code = cleanupError.code || 'PAYMENT_ATTEMPT_RECOVERY_PENDING';
                    throw cleanupError;
                }
                if (closed?.status === 'payment_succeeded') {
                    const completed = await completeWalletTopUpFromPaymentIntent(
                        closed.paymentIntent,
                        `api-recovery:${closed.paymentIntent.id}`,
                    );
                    await exports.notifyTopUpCompleted(completed);
                    return res.status(200).json({
                        success: true,
                        completed: true,
                        webhookProcessed: true,
                        stripePaymentReceived: true,
                        paymentFlow: 'payment_sheet',
                        paymentIntentId: paymentIntent.id,
                        transactionId: completed._id,
                        topUpId: completed._id,
                        status: completed.status,
                        transaction: serializeWalletTransaction(completed.toObject()),
                    });
                }
                const preparationError = new Error(
                    'Secure Wallet payment could not open. The payment attempt was closed and no balance was added.'
                );
                preparationError.statusCode = 503;
                preparationError.code = 'PAYMENT_SHEET_PREPARATION_FAILED';
                preparationError.cause = customerSessionError;
                throw preparationError;
            }
            res.set('Cache-Control', 'no-store, private, max-age=0');
            return res.status(201).json({
                success: true,
                paymentFlow: 'payment_sheet',
                paymentIntentId: paymentIntent.id,
                transactionId: transaction._id,
                topUpId: transaction._id,
                paymentIntentClientSecret: paymentIntent.client_secret,
                customerId: transaction.stripeCustomerId,
                ...customerAccess,
                expiresAt: transaction.paymentExpiresAt,
                transaction: serializeWalletTransaction(transaction.toObject()),
                ...getStripeMobileConfig(),
                consent: {
                    usage: 'on_session',
                    message: 'Saving a card requires the customer to opt in from Stripe PaymentSheet.',
                },
            });
        }

        const setup = await recoverWalletTopUpStripeSetup(transaction);
        transaction = setup.transaction;
        const session = setup.stripeObject;
        if (session.payment_status === 'paid') {
            const completed = await completeWalletTopUp(session, `api-recovery:${session.id}`);
            await exports.notifyTopUpCompleted(completed);
            return res.status(200).json({
                success: true,
                completed: true,
                webhookProcessed: true,
                stripePaymentReceived: true,
                transactionId: completed._id,
                topUpId: completed._id,
                status: completed.status,
                transaction: serializeWalletTransaction(completed.toObject()),
            });
        }
        if (session.status !== 'open' || !session.url) {
            transaction = await failWalletTopUp(
                session,
                session.status === 'expired'
                    ? 'The hosted Wallet top-up expired.'
                    : 'The hosted Wallet top-up did not complete successfully.',
            ) || transaction;
            return res.status(409).json({
                msg: 'That Wallet top-up attempt is closed. Start a new top-up with a new requestKey.',
                code: 'WALLET_TOP_UP_RETRY_REQUIRED',
            });
        }

        return res.status(201).json({
            success: true,
            id: session.id,
            url: session.url,
            transactionId: transaction._id,
            topUpId: transaction._id,
            transaction: serializeWalletTransaction(transaction.toObject()),
        });
    } catch (error) {
        if (!error.statusCode || error.statusCode >= 500) {
            console.error('[wallet] top-up checkout error:', error);
        }
        const current = transaction?._id
            ? await WalletTransaction.findById(transaction._id).catch(() => transaction)
            : null;
        const recoveryPending = Boolean(
            current
            && current.status === 'pending'
            && current.paymentSetupState === 'creating'
            && !current.stripeSessionId
            && !current.stripePaymentIntentId
        ) || error.code === 'PAYMENT_ATTEMPT_RECOVERY_PENDING';
        return res.status(error.statusCode || (recoveryPending ? 502 : 500)).json({
            msg: error.statusCode
                ? error.message
                : recoveryPending
                    ? 'Secure Wallet top-up is being recovered. Retry with the same requestKey.'
                    : 'Failed to start Wallet top-up.',
            ...(recoveryPending
                ? { code: error.code || 'PAYMENT_ATTEMPT_RECOVERY_PENDING' }
                : error.code ? { code: error.code } : {}),
        });
    }
};

exports.getTopUpStatus = async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, private, max-age=0');
        if (!mongoose.Types.ObjectId.isValid(req.params.transactionId)) {
            return res.status(404).json({ msg: 'Wallet top-up not found.' });
        }
        let transaction = await WalletTransaction.findOne({
            _id: req.params.transactionId,
            user: req.user.id,
            type: 'top_up',
        });
        if (!transaction) return res.status(404).json({ msg: 'Wallet top-up not found.' });
        const requestedIntentId = String(req.query.paymentIntentId || req.query.payment_intent_id || '');
        if (requestedIntentId && requestedIntentId !== transaction.stripePaymentIntentId) {
            return res.status(400).json({ msg: 'PaymentIntent does not belong to this top-up.', code: 'PAYMENT_INTENT_MISMATCH' });
        }
        let stripeStatus = null;
        let stripePaymentReceived = false;
        let authoritativePaymentIntentId = transaction.stripePaymentIntentId || null;
        if (
            transaction.status === 'pending'
            && transaction.paymentSetupState === 'creating'
            && !transaction.stripePaymentIntentId
            && !transaction.stripeSessionId
        ) {
            const recovered = await recoverWalletTopUpStripeSetup(transaction);
            transaction = recovered.transaction;
        }
        if (transaction.paymentFlow === 'payment_sheet' && transaction.stripePaymentIntentId) {
            if (
                transaction.status === 'pending'
                && transaction.paymentExpiresAt
                && transaction.paymentExpiresAt <= new Date()
            ) {
                await closeWalletTopUpPaymentIntent(transaction, {
                    status: 'expired',
                    reason: 'The secure mobile Wallet top-up window expired.',
                    requireExpired: true,
                });
                transaction = await WalletTransaction.findById(transaction._id);
            }
            let intent;
            try {
                intent = await stripe.paymentIntents.retrieve(transaction.stripePaymentIntentId);
            } catch (retrieveError) {
                if (retrieveError?.code !== 'resource_missing') throw retrieveError;
                if (transaction.status === 'pending') {
                    transaction.status = 'failed';
                    transaction.paymentSetupState = 'closed';
                    transaction.paymentSetupCompletedAt = new Date();
                    transaction.failureReason = 'The secure Stripe PaymentIntent is no longer available.';
                    await transaction.save();
                }
                return res.status(409).json({
                    msg: 'This Wallet top-up attempt is no longer available. Start a new top-up.',
                    code: 'WALLET_TOP_UP_RETRY_REQUIRED',
                });
            }
            validateWalletTopUpPaymentIntent(transaction, intent);
            stripeStatus = intent.status;
            stripePaymentReceived = intent.status === 'succeeded';
            authoritativePaymentIntentId = intent.id;
            if (transaction.status === 'pending' && intent.status === 'succeeded') {
                transaction = await completeWalletTopUpFromPaymentIntent(
                    intent,
                    `api-status-recovery:${intent.id}`,
                );
                await exports.notifyTopUpCompleted(transaction);
            }
        } else if (transaction.paymentFlow === 'checkout_session' && transaction.stripeSessionId) {
            let checkoutSession;
            try {
                checkoutSession = await stripe.checkout.sessions.retrieve(transaction.stripeSessionId);
            } catch (retrieveError) {
                if (retrieveError?.code !== 'resource_missing') throw retrieveError;
                if (transaction.status === 'pending') {
                    transaction.status = 'failed';
                    transaction.paymentSetupState = 'closed';
                    transaction.paymentSetupCompletedAt = new Date();
                    transaction.failureReason = 'The secure Stripe Checkout Session is no longer available.';
                    await transaction.save();
                }
                return res.status(409).json({
                    msg: 'This Wallet top-up attempt is no longer available. Start a new top-up.',
                    code: 'WALLET_TOP_UP_RETRY_REQUIRED',
                });
            }
            validateWalletTopUpCheckoutSession(transaction, checkoutSession);
            checkoutSession = await expireHostedWalletSessionIfDue(transaction, checkoutSession);
            stripeStatus = checkoutSession.status;
            stripePaymentReceived = checkoutSession.payment_status === 'paid';
            authoritativePaymentIntentId = typeof checkoutSession.payment_intent === 'string'
                ? checkoutSession.payment_intent
                : checkoutSession.payment_intent?.id || null;
            if (transaction.status === 'pending' && checkoutSession.payment_status === 'paid') {
                transaction = await completeWalletTopUp(
                    checkoutSession,
                    `api-status-recovery:${checkoutSession.id}`,
                );
                await exports.notifyTopUpCompleted(transaction);
            } else if (transaction.status === 'pending' && checkoutSession.status === 'expired') {
                transaction.status = 'expired';
                transaction.paymentSetupState = 'closed';
                transaction.paymentSetupCompletedAt = new Date();
                transaction.failureReason = 'The hosted Wallet top-up expired.';
                await transaction.save();
            } else if (
                transaction.status === 'pending'
                && checkoutSession.status === 'complete'
                && checkoutSession.payment_status !== 'paid'
            ) {
                transaction.status = 'failed';
                transaction.paymentSetupState = 'closed';
                transaction.paymentSetupCompletedAt = new Date();
                transaction.failureReason = 'The hosted Wallet top-up did not complete successfully.';
                await transaction.save();
            }
        }
        const summary = await getWalletSummary(req.user.id, { limit: 100 });
        return res.status(200).json({
            success: true,
            transactionId: transaction._id,
            status: transaction.status,
            paymentFlow: transaction.paymentFlow,
            paymentIntentId: authoritativePaymentIntentId,
            checkoutSessionId: transaction.stripeSessionId || null,
            amount: transaction.amount,
            currency: transaction.currency,
            expiresAt: transaction.paymentExpiresAt || null,
            webhookProcessed: transaction.status === 'completed',
            stripeStatus,
            stripePaymentReceived,
            walletBalanceAfter: transaction.status === 'completed' ? transaction.balanceAfter : null,
            failureReason: transaction.failureReason || '',
            wallet: summary.wallet,
            transactions: summary.transactions,
        });
    } catch (error) {
        console.error('[wallet] top-up status error:', error);
        return res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : 'Failed to load top-up status.',
            ...(error.code ? { code: error.code } : {}),
        });
    }
};

exports.cancelTopUpPayment = async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, private, max-age=0');
        if (!mongoose.Types.ObjectId.isValid(req.params.transactionId)) {
            return res.status(404).json({ msg: 'Wallet top-up not found.' });
        }
        const transaction = await WalletTransaction.findOne({
            _id: req.params.transactionId,
            user: req.user.id,
            type: 'top_up',
        });
        if (!transaction) return res.status(404).json({ msg: 'Wallet top-up not found.' });
        if (transaction.paymentFlow !== 'payment_sheet') {
            return res.status(400).json({ msg: 'Only native PaymentSheet attempts can be cancelled here.', code: 'NOT_PAYMENT_SHEET_TOP_UP' });
        }
        const requestedIntentId = String(
            req.body?.paymentIntentId || req.body?.payment_intent_id || ''
        ).trim();
        if (requestedIntentId && requestedIntentId !== transaction.stripePaymentIntentId) {
            return res.status(400).json({
                msg: 'PaymentIntent does not belong to this top-up.',
                code: 'PAYMENT_INTENT_MISMATCH',
            });
        }
        const result = await closeWalletTopUpPaymentIntent(transaction, {
            status: 'cancelled',
            reason: 'The buyer dismissed Stripe PaymentSheet.',
        });
        if (result?.status === 'payment_succeeded') {
            const completed = await completeWalletTopUpFromPaymentIntent(
                result.paymentIntent,
                `api-cancel-recovery:${result.paymentIntent.id}`,
            );
            await exports.notifyTopUpCompleted(completed);
            return res.status(409).json({
                msg: 'Stripe already received this payment, so the Wallet top-up was completed.',
                code: 'PAYMENT_ALREADY_SUCCEEDED',
                status: completed.status,
            });
        }
        if (['setup_recovery_pending', 'unsafe_without_reference'].includes(result?.status)) {
            return res.status(409).json({
                msg: 'Secure Wallet setup is still being recovered. Retry cancellation shortly.',
                code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING',
            });
        }
        return res.status(200).json({ success: true, status: result?.status || transaction.status });
    } catch (error) {
        console.error('[wallet] top-up cancellation error:', error);
        return res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : 'Failed to cancel Wallet top-up.',
            ...(error.code ? { code: error.code } : {}),
        });
    }
};

exports.notifyTopUpCompleted = async (transaction) => {
    if (!transaction) return;
    if (transaction.status !== 'completed') return;

    // Completion normally creates these rows atomically in walletService. This
    // exported hook remains a replay/legacy repair boundary for API and webhook
    // recovery paths. Never insert a second, differently-keyed Notification.
    // If an older deployment already wrote the legacy in-app receipt, repair
    // only the missing push/email rows so the buyer does not see it twice.
    const legacyDedupeKey = `wallet-top-up-completed:${transaction._id}`;
    const legacyInAppExists = Boolean(await Notification.exists({ dedupeKey: legacyDedupeKey }));
    await enqueueWalletTransactionNotification(transaction, {
        channels: legacyInAppExists ? ['push', 'email'] : ['inapp', 'push', 'email'],
    });
    await WalletTransaction.updateOne(
        { _id: transaction._id, status: 'completed', notificationSentAt: null },
        { $set: { notificationSentAt: new Date() } },
    );
};

exports.reconcilePaymentRiskLiability = async (req, res) => {
    try {
        if (req.user?.role !== 'admin') {
            return res.status(403).json({ msg: 'Admin access only' });
        }
        const idempotencyKey = String(
            req.get?.('Idempotency-Key') || req.body?.idempotencyKey || ''
        ).trim();
        if (!idempotencyKey || idempotencyKey.length > 200) {
            return res.status(400).json({
                msg: 'A valid Idempotency-Key is required.',
                code: 'IDEMPOTENCY_KEY_REQUIRED',
            });
        }
        const transaction = await reconcileWalletPaymentLiability({
            userId: req.params.userId,
            adminId: req.user.id,
            amount: req.body?.amount,
            currency: req.body?.currency,
            action: req.body?.action,
            note: req.body?.note,
            idempotencyKey: `wallet-risk-admin:${req.params.userId}:${idempotencyKey}`,
        });
        const summary = await getWalletSummary(req.params.userId);
        return res.status(200).json({
            success: true,
            transaction: serializeWalletTransaction(transaction.toObject()),
            ...summary,
        });
    } catch (error) {
        console.error('[wallet] payment-risk reconciliation error:', error);
        return res.status(error.statusCode || 500).json({
            msg: error.message || 'Failed to reconcile Wallet payment risk.',
            ...(error.code ? { code: error.code } : {}),
            ...(error.outstandingAmount != null ? {
                outstandingAmount: error.outstandingAmount,
                currency: error.currency,
            } : {}),
        });
    }
};
