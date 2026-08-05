const crypto = require('crypto');
const mongoose = require('mongoose');
const WalletTransaction = require('../models/WalletTransaction');
const Notification = require('../models/Notification');
const { stripe, STRIPE_MODE } = require('../config/stripe');
const { convertToUSD } = require('../services/currencyService');
const {
    getWalletSummary,
    ensureWallet,
    normalizeWalletCurrency,
    toStripeMinorUnits,
    roundMoney,
    formatWalletMoney,
    walletTopUpDescription,
    serializeWalletTransaction,
    validateWalletTopUpPaymentIntent,
    validateWalletTopUpCheckoutSession,
} = require('../services/walletService');
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
    buildCustomerInitiatedPaymentIntentParams,
    isDefinitiveStripeCreationError,
} = require('../services/stripePaymentIntentFactory');

const MIN_TOP_UP_USD = Number(process.env.WALLET_MIN_TOP_UP_USD || 1);
const MAX_TOP_UP_USD = Number(process.env.WALLET_MAX_TOP_UP_USD || 10000);

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
    let creationWasDefinitivelyRejected = false;
    try {
        if (!stripe) {
            return res.status(503).json({ msg: 'Card payments are not configured.' });
        }

        const amount = roundMoney(req.body?.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ msg: 'Top-up amount must be greater than zero.' });
        }
        const currency = normalizeWalletCurrency(req.body?.currency || req.user?.currency || 'USD');
        const amountUSD = await convertToUSD(amount, currency);
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
        if (paymentFlow === 'payment_sheet' && !rawRequestKey) {
            return res.status(400).json({
                msg: 'A requestKey is required for a native Wallet top-up.',
                code: 'IDEMPOTENCY_KEY_REQUIRED',
            });
        }
        if (rawRequestKey.length > 160) {
            return res.status(400).json({ msg: 'Invalid Wallet top-up requestKey.', code: 'INVALID_IDEMPOTENCY_KEY' });
        }
        const requestKey = String(rawRequestKey || crypto.randomUUID()).slice(0, 160);
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
                existing.failureReason = 'Stripe confirmed that this Wallet top-up was cancelled.';
                await existing.save();
                return res.status(409).json({
                    msg: 'That Wallet top-up attempt is closed. Start a new top-up.',
                    code: 'WALLET_TOP_UP_RETRY_REQUIRED',
                });
            }
            if (intent.status === 'succeeded') {
                return res.status(202).json({
                    success: true,
                    completed: false,
                    webhookProcessed: false,
                    stripePaymentReceived: true,
                    paymentFlow: 'payment_sheet',
                    paymentIntentId: intent.id,
                    transactionId: existing._id,
                    topUpId: existing._id,
                    status: 'pending',
                    transaction: serializeWalletTransaction(existing.toObject()),
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
                return res.status(202).json({
                    success: true,
                    completed: false,
                    webhookProcessed: false,
                    stripePaymentReceived: true,
                    transactionId: existing._id,
                    topUpId: existing._id,
                    status: 'pending',
                    transaction: serializeWalletTransaction(existing.toObject()),
                });
            }
            if (existingSession?.status === 'expired' || existingSession?.status === 'complete') {
                existing.status = existingSession.status === 'expired' ? 'expired' : 'failed';
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
        ) {
            existing.status = 'expired';
            existing.failureReason = 'The secure Wallet top-up window expired.';
            await existing.save();
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
        if (wallet.status !== 'active') {
            return res.status(423).json({ msg: 'Your Rozare Wallet is locked.', code: 'WALLET_LOCKED' });
        }
        const { customer, user } = await ensureStripeCustomerForUser(req.user.id);
        const expiresAt = paymentFlow === 'payment_sheet'
            ? createPaymentExpiry()
            : new Date(Date.now() + 35 * 60 * 1000);
        transaction = existing || await WalletTransaction.create({
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
            clientSurface,
            paymentExpiresAt: expiresAt,
            metadata: {
                requestedBy: req.user.id,
                paymentFlow,
                clientSurface,
                receiptEmail: user.email || '',
            },
        });

        if (paymentFlow === 'payment_sheet') {
            let paymentIntent;
            try {
                paymentIntent = await stripe.paymentIntents.create({
                    ...buildCustomerInitiatedPaymentIntentParams({
                        amountMinor: toStripeMinorUnits(transaction.amount, transaction.currency),
                        currency: transaction.currency,
                        customerId: transaction.stripeCustomerId,
                        receiptEmail: transaction.metadata?.receiptEmail || user.email,
                        metadata: {
                        type: 'wallet_top_up',
                        paymentFlow: 'payment_sheet',
                        walletTransactionId: String(transaction._id),
                        userId: String(req.user.id),
                        amountMinor: String(toStripeMinorUnits(transaction.amount, transaction.currency)),
                        currency: transaction.currency,
                        stripeMode: transaction.stripeMode || STRIPE_MODE,
                        },
                    }),
                    description: walletTopUpDescription(transaction.amount, transaction.currency),
                }, {
                    idempotencyKey: `wallet-topup-pi:${transaction.stripeMode || STRIPE_MODE}:${transaction._id}`,
                });
            } catch (creationError) {
                creationWasDefinitivelyRejected = isDefinitiveStripeCreationError(creationError);
                throw creationError;
            }
            transaction.stripePaymentIntentId = paymentIntent.id;
            transaction.paymentExpiresAt = transaction.paymentExpiresAt || expiresAt;
            await transaction.save();
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
                    return res.status(202).json({
                        success: true,
                        completed: false,
                        webhookProcessed: false,
                        stripePaymentReceived: true,
                        paymentFlow: 'payment_sheet',
                        paymentIntentId: paymentIntent.id,
                        transactionId: transaction._id,
                        topUpId: transaction._id,
                        status: 'pending',
                        transaction: serializeWalletTransaction(transaction.toObject()),
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

        const frontendUrl = process.env.FRONTEND_URL || 'https://rozare.com';
        const isMobile = transaction.clientSurface === 'mobile';
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            payment_method_types: ['card'],
            customer: transaction.stripeCustomerId,
            saved_payment_method_options: {
                payment_method_save: 'enabled',
                payment_method_remove: 'disabled',
            },
            client_reference_id: String(transaction._id),
            line_items: [{
                price_data: {
                    currency: currency.toLowerCase(),
                    product_data: {
                        name: 'Rozare Wallet top-up',
                        description: 'Balance added to your Rozare Wallet after payment confirmation.',
                    },
                    unit_amount: toStripeMinorUnits(amount, currency),
                },
                quantity: 1,
            }],
            success_url: isMobile
                ? `rozare://wallet?top_up=success&transactionId=${transaction._id}&session_id={CHECKOUT_SESSION_ID}`
                : `${frontendUrl}/user-dashboard/wallet?top_up=success&transactionId=${transaction._id}&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: isMobile
                ? `rozare://wallet?top_up=cancelled&transactionId=${transaction._id}`
                : `${frontendUrl}/user-dashboard/wallet?top_up=cancelled&transactionId=${transaction._id}`,
            expires_at: Math.floor(new Date(transaction.paymentExpiresAt).getTime() / 1000),
            metadata: {
                type: 'wallet_top_up',
                walletTransactionId: String(transaction._id),
                userId: String(req.user.id),
                stripeMode: transaction.stripeMode || STRIPE_MODE,
                paymentFlow: 'checkout_session',
            },
        }, {
            idempotencyKey: `wallet-topup-checkout:${transaction.stripeMode || STRIPE_MODE}:${transaction._id}`,
        }).catch((creationError) => {
            creationWasDefinitivelyRejected = isDefinitiveStripeCreationError(creationError);
            throw creationError;
        });

        transaction.stripeSessionId = session.id;
        await transaction.save();

        return res.status(201).json({
            success: true,
            id: session.id,
            url: session.url,
            transactionId: transaction._id,
            topUpId: transaction._id,
            transaction: serializeWalletTransaction(transaction.toObject()),
        });
    } catch (error) {
        console.error('[wallet] top-up checkout error:', error);
        if (
            transaction
            && transaction.status === 'pending'
            && creationWasDefinitivelyRejected
            && !transaction.stripeSessionId
            && !transaction.stripePaymentIntentId
        ) {
            transaction.status = 'failed';
            transaction.failureReason = String(error.message || error).slice(0, 500);
            await transaction.save().catch(() => {});
        }
        const recoveryPending = Boolean(
            transaction
            && transaction.status === 'pending'
            && !creationWasDefinitivelyRejected
        );
        return res.status(error.statusCode || (recoveryPending ? 502 : 500)).json({
            msg: error.statusCode
                ? error.message
                : recoveryPending
                    ? 'Secure Wallet top-up is being recovered. Retry with the same requestKey.'
                    : 'Failed to start Wallet top-up.',
            ...(recoveryPending
                ? { code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING' }
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
        } else if (transaction.paymentFlow === 'checkout_session' && transaction.stripeSessionId) {
            let checkoutSession;
            try {
                checkoutSession = await stripe.checkout.sessions.retrieve(transaction.stripeSessionId);
            } catch (retrieveError) {
                if (retrieveError?.code !== 'resource_missing') throw retrieveError;
                if (transaction.status === 'pending') {
                    transaction.status = 'failed';
                    transaction.failureReason = 'The secure Stripe Checkout Session is no longer available.';
                    await transaction.save();
                }
                return res.status(409).json({
                    msg: 'This Wallet top-up attempt is no longer available. Start a new top-up.',
                    code: 'WALLET_TOP_UP_RETRY_REQUIRED',
                });
            }
            validateWalletTopUpCheckoutSession(transaction, checkoutSession);
            stripeStatus = checkoutSession.status;
            stripePaymentReceived = checkoutSession.payment_status === 'paid';
            authoritativePaymentIntentId = typeof checkoutSession.payment_intent === 'string'
                ? checkoutSession.payment_intent
                : checkoutSession.payment_intent?.id || null;
            if (transaction.status === 'pending' && checkoutSession.status === 'expired') {
                transaction.status = 'expired';
                transaction.failureReason = 'The hosted Wallet top-up expired.';
                await transaction.save();
            } else if (
                transaction.status === 'pending'
                && checkoutSession.status === 'complete'
                && checkoutSession.payment_status !== 'paid'
            ) {
                transaction.status = 'failed';
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
            return res.status(409).json({
                msg: 'Stripe already received this payment. Waiting for secure webhook confirmation.',
                code: 'PAYMENT_ALREADY_SUCCEEDED',
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
    if (transaction.status !== 'completed' || transaction.notificationSentAt) return;
    const dedupeKey = `wallet-top-up-completed:${transaction._id}`;
    await Notification.findOneAndUpdate({ dedupeKey }, { $setOnInsert: {
        user: transaction.user,
        title: 'Wallet top-up completed',
        body: `${formatWalletMoney(transaction.amount, transaction.currency)} was added to your Rozare Wallet.`,
        category: 'system',
        linkTo: '/user-dashboard/wallet',
        source: 'system',
        dedupeKey,
    } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    await WalletTransaction.updateOne(
        { _id: transaction._id, status: 'completed', notificationSentAt: null },
        { $set: { notificationSentAt: new Date() } },
    );
};
