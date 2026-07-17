const crypto = require('crypto');
const WalletTransaction = require('../models/WalletTransaction');
const Notification = require('../models/Notification');
const { stripe } = require('../config/stripe');
const { convertToUSD, formatMoneySync } = require('../services/currencyService');
const {
    getWalletSummary,
    normalizeWalletCurrency,
    toStripeMinorUnits,
    roundMoney,
} = require('../services/walletService');

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
    try {
        if (!stripe) {
            return res.status(503).json({ msg: 'Card payments are not configured.' });
        }

        const currency = normalizeWalletCurrency(req.body?.currency || req.user?.currency || 'USD');
        const amount = roundMoney(req.body?.amount);
        const amountUSD = await convertToUSD(amount, currency);
        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ msg: 'Top-up amount must be greater than zero.' });
        }
        if (amountUSD < MIN_TOP_UP_USD || amountUSD > MAX_TOP_UP_USD) {
            return res.status(400).json({
                msg: `Wallet top-ups must be between $${MIN_TOP_UP_USD} and $${MAX_TOP_UP_USD} USD equivalent.`,
                code: 'WALLET_TOP_UP_LIMIT',
            });
        }

        const requestKey = String(req.body?.requestKey || crypto.randomUUID()).trim().slice(0, 160);
        const idempotencyKey = `wallet-topup:${req.user.id}:${requestKey}`;
        const existing = await WalletTransaction.findOne({ idempotencyKey });
        if (existing?.status === 'completed') {
            return res.status(200).json({ success: true, completed: true, transaction: existing });
        }
        if (existing?.status === 'pending' && existing.stripeSessionId) {
            const existingSession = await stripe.checkout.sessions.retrieve(existing.stripeSessionId);
            if (existingSession?.status === 'open' && existingSession.url) {
                return res.status(200).json({
                    success: true,
                    id: existingSession.id,
                    url: existingSession.url,
                    transaction: existing,
                });
            }
        }

        if (existing && existing.status !== 'pending') {
            return res.status(409).json({
                msg: 'That Wallet top-up attempt is closed. Start a new top-up to receive a fresh secure checkout.',
                code: 'WALLET_TOP_UP_RETRY_REQUIRED',
            });
        }

        transaction = existing || await WalletTransaction.create({
            user: req.user.id,
            type: 'top_up',
            direction: 'credit',
            status: 'pending',
            amount,
            currency,
            description: `Rozare Wallet top-up of ${formatMoneySync(amount, currency)}`,
            referenceType: 'stripe_checkout',
            referenceId: requestKey,
            idempotencyKey,
            metadata: { requestedBy: req.user.id },
        });

        const frontendUrl = process.env.FRONTEND_URL || 'https://rozare.com';
        const isMobile = req.body?.platform === 'mobile';
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            payment_method_types: ['card'],
            customer_email: req.user.email || undefined,
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
                ? 'rozare://wallet?top_up=success&session_id={CHECKOUT_SESSION_ID}'
                : `${frontendUrl}/user-dashboard/wallet?top_up=success&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: isMobile
                ? 'rozare://wallet?top_up=cancelled'
                : `${frontendUrl}/user-dashboard/wallet?top_up=cancelled`,
            expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
            metadata: {
                type: 'wallet_top_up',
                walletTransactionId: String(transaction._id),
                userId: String(req.user.id),
            },
        }, {
            idempotencyKey: `stripe-${idempotencyKey}`,
        });

        transaction.stripeSessionId = session.id;
        await transaction.save();

        return res.status(201).json({
            success: true,
            id: session.id,
            url: session.url,
            transaction,
        });
    } catch (error) {
        console.error('[wallet] top-up checkout error:', error);
        if (transaction && transaction.status === 'pending' && !transaction.stripeSessionId) {
            transaction.status = 'failed';
            transaction.failureReason = String(error.message || error).slice(0, 500);
            await transaction.save().catch(() => {});
        }
        return res.status(error.statusCode || 500).json({ msg: error.message || 'Failed to start wallet top-up' });
    }
};

exports.notifyTopUpCompleted = async (transaction) => {
    if (!transaction) return;
    const claimed = await WalletTransaction.findOneAndUpdate(
        { _id: transaction._id, status: 'completed', notificationSentAt: null },
        { $set: { notificationSentAt: new Date() } },
        { new: true }
    );
    if (!claimed) return;
    await Notification.create({
        user: claimed.user,
        title: 'Wallet top-up completed',
        body: `${formatMoneySync(claimed.amount, claimed.currency)} was added to your Rozare Wallet.`,
        category: 'system',
        linkTo: '/user-dashboard/wallet',
        source: 'system',
    }).catch((error) => console.error('[wallet] top-up notification failed:', error.message));
};
