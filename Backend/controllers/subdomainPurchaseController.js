const Store = require('../models/Store');
const User = require('../models/User');
const { stripe } = require('../config/stripe');
const { getHostedCheckoutReturnUrls } = require('../utils/hostedCheckoutReturnUrls');
const {
    fingerprintCheckoutRequest,
    claimSellerCheckout,
    attachSellerCheckoutSession,
    markSellerCheckoutClaimRecoverable,
    releaseSellerCheckoutClaim,
    checkoutClaimRetryAfterSeconds,
} = require('../services/sellerCheckoutClaimService');
const { isDefinitiveStripeCreationError } = require('../services/stripePaymentIntentFactory');
const {
    ensureSubdomainLegacyLedger,
    recomputeSubdomainEntitlement,
    recordSubdomainCheckoutPayment,
    SUBDOMAIN_PRICE_MINOR,
} = require('../services/stripeEntitlementPaymentService');
const {
    acquireSubdomainCheckoutLock,
    releaseSubdomainResourceLock,
} = require('../services/subdomainResourceLockService');
const { releaseExpiredStoreSlug } = require('../services/subdomainSlugMutationService');
const {
    enqueueSubdomainOwnershipExpiredNotification,
    enqueueSubdomainRemovedNotification,
} = require('../services/subdomainLifecycleNotificationService');

const SUBDOMAIN_OWNERSHIP_YEARS = 3;

const sameDate = (left, right) => (
    Number.isFinite(new Date(left || 0).getTime())
    && new Date(left).getTime() === new Date(right).getTime()
);

const clearExpiryNotice = store => Store.updateOne({
    _id: store._id,
    'subdomainPurchase.expiryNotice.slug': store.subdomainPurchase?.expiryNotice?.slug,
    'subdomainPurchase.expiryNotice.expiresAt': store.subdomainPurchase?.expiryNotice?.expiresAt,
    'subdomainPurchase.expiryNotice.notificationEnqueuedAt': null,
}, {
    $set: {
        'subdomainPurchase.expiryNotice.slug': '',
        'subdomainPurchase.expiryNotice.expiresAt': null,
        'subdomainPurchase.expiryNotice.notificationEnqueuedAt': null,
    },
});

const reconcileExpiryNotice = async storeId => {
    const pending = await Store.findById(storeId);
    const notice = pending?.subdomainPurchase?.expiryNotice;
    if (!pending || !notice?.slug || !notice?.expiresAt || notice.notificationEnqueuedAt) return false;

    // A renewal may race the cron after the old projection first looked
    // expired. Recompute before notifying and clear the stale marker when the
    // current ledger still protects the hostname.
    await ensureSubdomainLegacyLedger(pending);
    const current = await recomputeSubdomainEntitlement(pending._id);
    if (!current) return false;
    const currentNotice = current.subdomainPurchase?.expiryNotice;
    if (
        currentNotice?.slug !== notice.slug
        || !sameDate(currentNotice?.expiresAt, notice.expiresAt)
        || currentNotice?.notificationEnqueuedAt
    ) return false;
    if (current.subdomainPurchase?.isPurchased === true) {
        await clearExpiryNotice(current);
        return false;
    }

    await enqueueSubdomainOwnershipExpiredNotification(current);
    await Store.updateOne({
        _id: current._id,
        'subdomainPurchase.expiryNotice.slug': notice.slug,
        'subdomainPurchase.expiryNotice.expiresAt': notice.expiresAt,
        'subdomainPurchase.expiryNotice.notificationEnqueuedAt': null,
    }, {
        $set: { 'subdomainPurchase.expiryNotice.notificationEnqueuedAt': new Date() },
    });
    return true;
};

const reconcileRemovalNotice = async storeId => {
    const store = await Store.findById(storeId);
    const notice = store?.subdomainPurchase?.removalNotice;
    if (!store || !notice?.previousSlug || !notice?.removedAt || notice.notificationEnqueuedAt) return false;
    await enqueueSubdomainRemovedNotification(store);
    await Store.updateOne({
        _id: store._id,
        'subdomainPurchase.removalNotice.previousSlug': notice.previousSlug,
        'subdomainPurchase.removalNotice.removedAt': notice.removedAt,
        'subdomainPurchase.removalNotice.notificationEnqueuedAt': null,
    }, {
        $set: { 'subdomainPurchase.removalNotice.notificationEnqueuedAt': new Date() },
    });
    return true;
};

const reconcilePendingSubdomainNotices = async () => {
    const [expiryStores, removalStores] = await Promise.all([
        Store.find({
            'subdomainPurchase.expiryNotice.slug': { $ne: '' },
            'subdomainPurchase.expiryNotice.expiresAt': { $ne: null },
            'subdomainPurchase.expiryNotice.notificationEnqueuedAt': null,
        }).select('_id').limit(200).lean(),
        Store.find({
            'subdomainPurchase.removalNotice.previousSlug': { $ne: '' },
            'subdomainPurchase.removalNotice.removedAt': { $ne: null },
            'subdomainPurchase.removalNotice.notificationEnqueuedAt': null,
        }).select('_id').limit(200).lean(),
    ]);
    for (const store of expiryStores) {
        await reconcileExpiryNotice(store._id).catch(error => {
            console.error(`[subdomain] Expiry notification retry failed for ${store._id}:`, error.message);
        });
    }
    for (const store of removalStores) {
        await reconcileRemovalNotice(store._id).catch(error => {
            console.error(`[subdomain] Removal notification retry failed for ${store._id}:`, error.message);
        });
    }
};

// Get subdomain ownership status
exports.getSubdomainOwnership = async (req, res) => {
    try {
        const sellerId = req.user.id;
        const store = await Store.findOne({ seller: sellerId });

        if (!store) {
            return res.status(404).json({ msg: 'Store not found' });
        }

        const purchase = store.subdomainPurchase || {};
        const now = new Date();
        const isOwned = Boolean(
            purchase.isPurchased
            && purchase.expiresAt
            && new Date(purchase.expiresAt) > now
        );

        res.json({
            subdomain: store.storeSlug,
            url: `${store.storeSlug}.rozare.com`,
            ownership: {
                isPurchased: !!purchase.isPurchased,
                isOwned, // currently valid ownership
                purchasedAt: purchase.purchasedAt || null,
                expiresAt: purchase.expiresAt || null,
                daysRemaining: isOwned ? Math.ceil((new Date(purchase.expiresAt) - now) / (1000 * 60 * 60 * 24)) : 0,
            },
            price: SUBDOMAIN_PRICE_MINOR / 100,
            priceMinor: SUBDOMAIN_PRICE_MINOR,
            priceCurrency: 'USD',
            ownershipYears: SUBDOMAIN_OWNERSHIP_YEARS,
        });
    } catch (error) {
        console.error('Get subdomain ownership error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

// Create Stripe checkout for the authoritative one-time USD ownership price.
// Also supports renewal when ownership is still valid (extends the expiry by 3 more years)
exports.purchaseSubdomain = async (req, res) => {
    let checkoutClaim = null;
    let checkoutSession = null;
    let sellerId = null;
    let resourceLock = null;
    let stripeCreateStarted = false;
    let stripeCreateCompleted = false;
    try {
        sellerId = req.user.id;
        const user = await User.findById(sellerId);
        const store = await Store.findOne({ seller: sellerId });

        if (!user || user.role !== 'seller') {
            return res.status(403).json({ msg: 'Only sellers can purchase a store subdomain.' });
        }
        if (!store) {
            return res.status(404).json({ msg: 'Store not found. Create a store first.' });
        }

        const purchase = store.subdomainPurchase || {};
        if (purchase.paymentRiskState === 'open') {
            return res.status(423).json({
                msg: 'This subdomain has an unresolved Stripe payment dispute. Renewal is temporarily frozen.',
                code: 'SUBDOMAIN_PAYMENT_RISK_OPEN',
            });
        }
        const isRenewal = Boolean(
            purchase.isPurchased
            && purchase.expiresAt
            && new Date(purchase.expiresAt) > new Date()
        );

        if (!stripe) {
            return res.status(500).json({ msg: 'Payment system not configured' });
        }

        const requestFingerprint = fingerprintCheckoutRequest({
            storeId: store._id.toString(),
            storeSlug: store.storeSlug,
            isRenewal: Boolean(isRenewal),
            checkoutClient: String(req.body?.checkoutClient || 'web').trim().toLowerCase(),
        });
        const claimResult = await claimSellerCheckout({
            sellerId,
            flow: 'subdomain',
            requestFingerprint,
        });
        if (!claimResult.acquired) {
            const existingClaim = claimResult.claim;
            if (
                existingClaim.requestFingerprint === requestFingerprint
                && existingClaim.sessionId
                && existingClaim.sessionUrl
            ) {
                return res.json({
                    url: existingClaim.sessionUrl,
                    sessionId: existingClaim.sessionId,
                    isRenewal: Boolean(isRenewal),
                    reused: true,
                });
            }
            return res.status(409).json({
                msg: 'A subdomain checkout is already in progress. Complete or cancel it before starting another.',
                code: 'CHECKOUT_PENDING',
                retryAfterSeconds: checkoutClaimRetryAfterSeconds(existingClaim),
            });
        }
        checkoutClaim = claimResult.claim;

        resourceLock = await acquireSubdomainCheckoutLock({
            storeId: store._id,
            sellerId,
            storeSlug: store.storeSlug,
            token: checkoutClaim.token,
            checkoutClaimExpiry: checkoutClaim.expiresAt,
        });
        if (!resourceLock) {
            const error = new Error('The subdomain is currently being changed. Try Checkout again after that update finishes.');
            error.code = 'SUBDOMAIN_RESOURCE_LOCKED';
            error.statusCode = 423;
            throw error;
        }

        const checkoutReturnUrls = getHostedCheckoutReturnUrls({
            client: req.body?.checkoutClient,
            flow: 'subdomain',
            frontendUrl: process.env.FRONTEND_URL,
            backendUrl: process.env.BACKEND_PUBLIC_URL || 'https://rozare.up.railway.app',
        });

        // Create Stripe checkout session for one-time payment
        stripeCreateStarted = true;
        checkoutSession = await stripe.checkout.sessions.create({
            mode: 'payment',
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: isRenewal ? `Renew Subdomain: ${store.storeSlug}.rozare.com` : `Subdomain: ${store.storeSlug}.rozare.com`,
                        description: isRenewal
                            ? `Extend your subdomain "${store.storeSlug}.rozare.com" ownership by ${SUBDOMAIN_OWNERSHIP_YEARS} more years.`
                            : `Secure your subdomain "${store.storeSlug}.rozare.com" for ${SUBDOMAIN_OWNERSHIP_YEARS} years. Your subdomain is protected even if your account is blocked.`,
                    },
                    unit_amount: SUBDOMAIN_PRICE_MINOR,
                },
                quantity: 1,
            }],
            success_url: checkoutReturnUrls.successUrl,
            cancel_url: checkoutReturnUrls.cancelUrl,
            metadata: {
                sellerId: sellerId.toString(),
                storeId: store._id.toString(),
                storeSlug: store.storeSlug,
                type: 'subdomain_purchase',
                isRenewal: isRenewal ? 'true' : 'false',
                checkoutClaimToken: checkoutClaim.token,
            },
            // Checkout Session metadata is not copied to the PaymentIntent or
            // Charge. Mirror the immutable entitlement identity explicitly so
            // future refund/dispute webhooks remain attributable.
            payment_intent_data: {
                metadata: {
                    sellerId: sellerId.toString(),
                    storeId: store._id.toString(),
                    storeSlug: store.storeSlug,
                    type: 'subdomain_purchase',
                },
            },
            customer_email: user.email,
            expires_at: Math.floor(new Date(checkoutClaim.expiresAt).getTime() / 1000),
        }, {
            idempotencyKey: `rozare-subdomain-checkout-${checkoutClaim.token}`,
        });
        stripeCreateCompleted = true;

        if (!checkoutSession?.id || !checkoutSession?.url) {
            throw new Error('Stripe did not return a usable Checkout Session.');
        }
        await attachSellerCheckoutSession({
            sellerId,
            flow: 'subdomain',
            token: checkoutClaim.token,
            sessionId: checkoutSession.id,
            sessionUrl: checkoutSession.url,
        });

        res.json({ url: checkoutSession.url, sessionId: checkoutSession.id, isRenewal });
    } catch (error) {
        console.error('Purchase subdomain error:', error);
        let checkoutExpiryConfirmed = false;
        if (checkoutSession?.id && stripe?.checkout?.sessions?.expire) {
            try {
                const expiredSession = await stripe.checkout.sessions.expire(checkoutSession.id);
                checkoutExpiryConfirmed = expiredSession?.status === 'expired';
            } catch (expireError) {
                console.error('Failed to expire unusable subdomain Checkout:', expireError.message);
            }
        }
        const createDefinitivelyRejected = stripeCreateStarted
            && !stripeCreateCompleted
            && isDefinitiveStripeCreationError(error);
        const safeToReleaseCheckout = !stripeCreateStarted
            || createDefinitivelyRejected
            || checkoutExpiryConfirmed;
        if (safeToReleaseCheckout && checkoutClaim && sellerId) {
            await releaseSellerCheckoutClaim({
                sellerId,
                flow: 'subdomain',
                token: checkoutClaim.token,
            }).catch(releaseError => {
                console.error('Failed to release subdomain Checkout claim:', releaseError.message);
            });
        }
        if (safeToReleaseCheckout && resourceLock && checkoutClaim && sellerId) {
            await releaseSubdomainResourceLock({
                storeId: resourceLock._id,
                sellerId,
                token: checkoutClaim.token,
            }).catch(releaseError => {
                console.error('Failed to release subdomain resource lock:', releaseError.message);
            });
        }
        if (!safeToReleaseCheckout && checkoutClaim && sellerId) {
            await markSellerCheckoutClaimRecoverable({
                sellerId,
                flow: 'subdomain',
                token: checkoutClaim.token,
                error,
            }).catch(recoveryError => {
                console.error('Failed to mark subdomain Checkout claim recoverable:', recoveryError.message);
            });
        }
        res.status(!safeToReleaseCheckout
            ? 503
            : error?.statusCode || (error?.code === 'CHECKOUT_PENDING' ? 409 : 500)).json({
            msg: !safeToReleaseCheckout
                ? 'Checkout creation could not be confirmed. Retry the same subdomain purchase to recover this payment attempt.'
                : error?.message || 'Failed to create checkout session',
            code: !safeToReleaseCheckout
                ? 'CHECKOUT_RECOVERY_PENDING'
                : error?.code || 'CHECKOUT_ERROR',
        });
    }
};

// Handle subdomain purchase webhook (called from main webhook handler)
exports.handleSubdomainPurchaseWebhook = async (session) => {
    try {
        if (session.metadata?.type !== 'subdomain_purchase') return false;
        const sellerId = session.metadata.sellerId;
        if (!String(session.metadata.storeSlug || '').trim()) {
            // Sessions opened before the slug-binding deployment did not carry
            // storeSlug. Ownership is still bound by both immutable ids; retain
            // this narrow compatibility path until those sessions expire.
            console.warn('Subdomain purchase webhook: processing legacy session without storeSlug snapshot', {
                sessionId: session.id,
                storeId: session.metadata.storeId,
                sellerId,
            });
        }
        const result = await recordSubdomainCheckoutPayment(session);
        const store = result.store;
        await releaseSubdomainResourceLock({
            storeId: session.metadata.storeId,
            sellerId,
            token: session.metadata.checkoutClaimToken,
        });
        // Exact amount + expiry notifications are durably outboxed by the
        // entitlement service on every replay; the event key dedupes channels.
        return true;
    } catch (error) {
        console.error('Subdomain purchase webhook error:', error);
        throw error;
    }
};

// CRON: Process subdomain removals for blocked accounts (7 days after block)
// and process expired subdomain purchases (3 years)
exports.processSubdomainRemovals = async () => {
    try {
        const now = new Date();
        const SellerSubscription = require('../models/SellerSubscription');

        // Repair any state transition that committed immediately before its
        // durable outbox insert/marker update was interrupted.
        await reconcilePendingSubdomainNotices();

        // 1. Schedule removal for newly blocked accounts that haven't purchased subdomain
        //    Only process subs where blockedAt is recent enough to still matter
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const blockedSubs = await SellerSubscription.find({
            status: 'blocked',
            blockedAt: { $gte: sevenDaysAgo }, // only recent blocks
        });

        for (const sub of blockedSubs) {
            const store = await Store.findOne({ seller: sub.seller });
            if (!store) continue;

            // Skip if subdomain was already removed (slug starts with "removed-")
            if (store.storeSlug && store.storeSlug.startsWith('removed-')) continue;

            // Skip if subdomain is purchased and still valid
            if (store.subdomainPurchase?.isPurchased && store.subdomainPurchase?.expiresAt && new Date(store.subdomainPurchase.expiresAt) > now) {
                // Clear any removal schedule
                if (store.subdomainPurchase.removalScheduledAt) {
                    store.subdomainPurchase.removalScheduledAt = null;
                    await store.save();
                }
                continue;
            }

            // Schedule removal if not already scheduled
            if (!store.subdomainPurchase?.removalScheduledAt && sub.blockedAt) {
                const removalDate = new Date(sub.blockedAt.getTime() + 7 * 24 * 60 * 60 * 1000);
                if (!store.subdomainPurchase) {
                    store.subdomainPurchase = {};
                }
                store.subdomainPurchase.removalScheduledAt = removalDate;
                await store.save();
            }
        }

        // 2. Remove subdomains that have been scheduled and the 7-day period has passed
        //    Exclude stores that already have "removed-" prefix (already processed)
        const storesToRemoveSubdomain = await Store.find({
            isActive: false,
            'subdomainPurchase.removalScheduledAt': { $lte: now, $ne: null },
            'subdomainPurchase.isPurchased': { $ne: true },
            storeSlug: { $not: /^removed-/ }, // prevent double-processing
        });

        let removedCount = 0;
        for (const selectedStore of storesToRemoveSubdomain) {
            const oldSlug = selectedStore.storeSlug;
            const release = await releaseExpiredStoreSlug({
                storeId: selectedStore._id,
                sellerId: selectedStore.seller,
                expectedSlug: oldSlug,
                now,
                reason: 'Scheduled release after the inactive-store grace period expired',
                releasedPrefix: 'removed',
            });
            // A payable Checkout owns the slug until its completion/expiry is
            // settled. Skip this cron run instead of charging against a slug we
            // release out from under the signed Checkout metadata.
            if (!release.released) continue;
            const store = release.store;
            removedCount += 1;

            console.log(`[subdomain] Removed subdomain "${oldSlug}" from blocked store ${store._id} (7-day grace period expired)`);
            await reconcileRemovalNotice(store._id).catch(error => {
                // The removalNotice marker was written atomically with the
                // slug release, so a later cron run repairs this safely.
                console.error('Subdomain removal notification enqueue failed:', error.message);
            });
        }

        // 3. Expire purchased subdomains that have passed 3-year ownership
        const expiredPurchases = await Store.find({
            'subdomainPurchase.isPurchased': true,
            'subdomainPurchase.expiresAt': { $lte: now, $ne: null },
        });

        for (const store of expiredPurchases) {
            const expiresAt = new Date(store.subdomainPurchase.expiresAt);
            const staged = await Store.findOneAndUpdate({
                _id: store._id,
                seller: store.seller,
                storeSlug: store.storeSlug,
                'subdomainPurchase.isPurchased': true,
                'subdomainPurchase.expiresAt': expiresAt,
            }, {
                $set: {
                    'subdomainPurchase.expiryNotice.slug': store.storeSlug,
                    'subdomainPurchase.expiryNotice.expiresAt': expiresAt,
                    'subdomainPurchase.expiryNotice.notificationEnqueuedAt': null,
                },
            }, { new: true, runValidators: true });
            if (!staged) continue;

            await reconcileExpiryNotice(staged._id).catch(error => {
                // The frozen marker survives recomputation and is retried at
                // the start of the next cron run.
                console.error('Subdomain expiry notification enqueue failed:', error.message);
            });
            console.log(`[subdomain] Subdomain purchase expired for store ${store._id} (${store.storeSlug})`);
        }

        await reconcilePendingSubdomainNotices();

        if (removedCount > 0 || expiredPurchases.length > 0) {
            console.log(`[subdomain] Processed: ${removedCount} removals, ${expiredPurchases.length} purchase expirations`);
        }
    } catch (error) {
        console.error('Process subdomain removals error:', error);
    }
};
