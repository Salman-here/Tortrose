const Store = require('../models/Store');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { sendEmail } = require('./mailController');
const { stripe } = require('../config/stripe');
const { getHostedCheckoutReturnUrls } = require('../utils/hostedCheckoutReturnUrls');
const {
    fingerprintCheckoutRequest,
    claimSellerCheckout,
    attachSellerCheckoutSession,
    releaseSellerCheckoutClaim,
    checkoutClaimRetryAfterSeconds,
} = require('../services/sellerCheckoutClaimService');

const SUBDOMAIN_PRICE_CENTS = 1500; // $15.00
const SUBDOMAIN_OWNERSHIP_YEARS = 3;

// Email template
const subdomainEmailTemplate = (title, bodyHtml) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${title}</title>
  <style>
    body { background-color: #F8F9FA; font-family: 'Inter', 'Segoe UI', Tahoma, sans-serif; color: #1A1A1A; margin: 0; padding: 0; }
    .email-wrapper { max-width: 600px; margin: 0 auto; padding: 1.5rem; }
    .card { background: #FFFFFF; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); padding: 2rem; }
    .header { background: linear-gradient(135deg, #6366F1, #3B82F6); color: #fff; padding: 1.25rem 2rem; border-radius: 12px 12px 0 0; font-size: 1.2rem; font-weight: 600; text-align: center; }
    .content { padding: 1.5rem 0; line-height: 1.7; }
    .content p { margin: 0.75rem 0; }
    .button { display: inline-block; margin-top: 1.25rem; background: linear-gradient(135deg, #4F46E5, #3B82F6); color: white !important; padding: 0.75rem 1.75rem; border-radius: 10px; text-decoration: none; font-weight: 600; }
    .footer { font-size: 13px; text-align: center; color: #6B7280; margin-top: 2rem; }
    .highlight { background: #EEF2FF; border-radius: 10px; padding: 1rem 1.25rem; margin: 1rem 0; border-left: 4px solid #6366F1; }
  </style>
</head>
<body>
  <div class="email-wrapper">
    <div class="card">
      <div class="header">${title}</div>
      <div class="content">
        ${bodyHtml}
        <p>Best regards,<br/>The Rozare Team</p>
      </div>
    </div>
    <div class="footer">&copy; ${new Date().getFullYear()} Rozare. All rights reserved.</div>
  </div>
</body>
</html>
`;

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
        const isOwned = purchase.isPurchased && purchase.expiresAt && new Date(purchase.expiresAt) > now;

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
            price: SUBDOMAIN_PRICE_CENTS / 100,
            ownershipYears: SUBDOMAIN_OWNERSHIP_YEARS,
        });
    } catch (error) {
        console.error('Get subdomain ownership error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

// Create Stripe checkout for subdomain purchase ($15 one-time)
// Also supports renewal when ownership is still valid (extends the expiry by 3 more years)
exports.purchaseSubdomain = async (req, res) => {
    let checkoutClaim = null;
    let checkoutSession = null;
    let sellerId = null;
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
        const isRenewal = purchase.isPurchased && purchase.expiresAt && new Date(purchase.expiresAt) > new Date();

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

        const checkoutReturnUrls = getHostedCheckoutReturnUrls({
            client: req.body?.checkoutClient,
            flow: 'subdomain',
            frontendUrl: process.env.FRONTEND_URL,
            backendUrl: process.env.BACKEND_PUBLIC_URL || 'https://rozare.up.railway.app',
        });

        // Create Stripe checkout session for one-time payment
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
                    unit_amount: SUBDOMAIN_PRICE_CENTS,
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
            customer_email: user.email,
            expires_at: Math.floor(new Date(checkoutClaim.expiresAt).getTime() / 1000),
        }, {
            idempotencyKey: `rozare-subdomain-checkout-${checkoutClaim.token}`,
        });

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
        if (checkoutSession?.id && stripe?.checkout?.sessions?.expire) {
            await stripe.checkout.sessions.expire(checkoutSession.id).catch(expireError => {
                console.error('Failed to expire unusable subdomain Checkout:', expireError.message);
            });
        }
        if (checkoutClaim && sellerId) {
            await releaseSellerCheckoutClaim({
                sellerId,
                flow: 'subdomain',
                token: checkoutClaim.token,
            }).catch(releaseError => {
                console.error('Failed to release subdomain Checkout claim:', releaseError.message);
            });
        }
        res.status(error?.code === 'CHECKOUT_PENDING' ? 409 : 500).json({
            msg: error?.message || 'Failed to create checkout session',
            code: error?.code || 'CHECKOUT_ERROR',
        });
    }
};

// Handle subdomain purchase webhook (called from main webhook handler)
exports.handleSubdomainPurchaseWebhook = async (session) => {
    try {
        if (session.metadata?.type !== 'subdomain_purchase') return false;

        const storeId = session.metadata.storeId;
        const sellerId = session.metadata.sellerId;
        const purchasedSlug = String(session.metadata.storeSlug || '').trim().toLowerCase();
        const hasSlugSnapshot = Boolean(purchasedSlug);
        const isRenewal = session.metadata.isRenewal === 'true';
        const paymentReference = String(session.payment_intent?.id || session.payment_intent || session.id || '').trim();
        if (!storeId || !sellerId || !paymentReference) {
            const error = new Error('Subdomain purchase webhook has incomplete payment metadata.');
            error.code = 'SUBDOMAIN_CHECKOUT_METADATA_INVALID';
            throw error;
        }
        if (!hasSlugSnapshot) {
            // Sessions opened before the slug-binding deployment did not carry
            // storeSlug. Ownership is still bound by both immutable ids; retain
            // this narrow compatibility path until those sessions expire.
            console.warn('Subdomain purchase webhook: processing legacy session without storeSlug snapshot', {
                sessionId: session.id,
                storeId,
                sellerId,
            });
        }

        const now = new Date();
        const ownershipMs = SUBDOMAIN_OWNERSHIP_YEARS * 365 * 24 * 60 * 60 * 1000;
        const expiryBase = isRenewal
            ? {
                $cond: [
                    { $gt: ['$subdomainPurchase.expiresAt', now] },
                    '$subdomainPurchase.expiresAt',
                    now,
                ],
            }
            : now;
        const purchasedAt = isRenewal
            ? { $ifNull: ['$subdomainPurchase.purchasedAt', now] }
            : now;

        // Claim and apply this payment atomically. Stripe may deliver the same
        // completion more than once (including concurrently), and renewals must
        // never gain another three years from a retry. Seller ownership is part
        // of the write filter so stale/tampered metadata cannot mutate a store.
        const store = await Store.findOneAndUpdate(
            {
                _id: storeId,
                seller: sellerId,
                ...(hasSlugSnapshot ? { storeSlug: purchasedSlug } : {}),
                'subdomainPurchase.stripePaymentId': { $ne: paymentReference },
                'subdomainPurchase.processedPaymentIds': { $ne: paymentReference },
            },
            [{
                $set: {
                    subdomainPurchase: {
                        isPurchased: true,
                        purchasedAt,
                        expiresAt: { $add: [expiryBase, ownershipMs] },
                        stripePaymentId: paymentReference,
                        processedPaymentIds: {
                            $setUnion: [
                                { $ifNull: ['$subdomainPurchase.processedPaymentIds', []] },
                                [paymentReference],
                            ],
                        },
                        removalScheduledAt: null,
                    },
                },
            }],
            { new: true }
        );

        if (!store) {
            const existingStore = await Store.findOne({
                _id: storeId,
                seller: sellerId,
                ...(hasSlugSnapshot ? { storeSlug: purchasedSlug } : {}),
            })
                .select('subdomainPurchase.stripePaymentId subdomainPurchase.processedPaymentIds')
                .lean();
            const alreadyProcessed = existingStore && (
                existingStore.subdomainPurchase?.stripePaymentId === paymentReference
                || existingStore.subdomainPurchase?.processedPaymentIds?.includes(paymentReference)
            );
            if (alreadyProcessed) return true;

            const error = new Error('The paid subdomain no longer matches the seller and store recorded at Checkout.');
            error.code = 'SUBDOMAIN_CHECKOUT_STORE_MISMATCH';
            throw error;
        }
        const expiresAt = new Date(store.subdomainPurchase.expiresAt);

        // Send confirmation email
        const user = await User.findById(sellerId);
        if (user?.email) {
            const emailTitle = isRenewal ? 'Subdomain Renewed!' : 'Subdomain Purchased!';
            const html = subdomainEmailTemplate(
                emailTitle,
                `<p>Hello ${user.username || 'Seller'},</p>
                <p>Your subdomain <strong>${store.storeSlug}.rozare.com</strong> is ${isRenewal ? 'now extended' : 'now secured'}!</p>
                <div class="highlight">
                    <strong>Subdomain:</strong> ${store.storeSlug}.rozare.com<br/>
                    <strong>${isRenewal ? 'New Expiry:' : 'Ownership Period:'}</strong> ${isRenewal ? expiresAt.toLocaleDateString() : `${SUBDOMAIN_OWNERSHIP_YEARS} years (until ${expiresAt.toLocaleDateString()})`}<br/>
                    <strong>Protection:</strong> Your subdomain is protected even if your account is blocked.
                </div>
                <p>Your subdomain cannot be claimed by anyone else until ${expiresAt.toLocaleDateString()}.</p>
                <p style="text-align:center"><a href="${process.env.FRONTEND_URL}/seller-dashboard/subdomain" class="button">View Subdomain</a></p>`
            );
            await sendEmail({ to: user.email, subject: emailTitle, html })
                .catch(error => console.error('Subdomain purchase confirmation email failed:', error.message));
        }

        // In-app notification
        await Notification.create({
            user: sellerId,
            title: isRenewal ? 'Subdomain renewed!' : 'Subdomain purchased!',
            body: `Your subdomain ${store.storeSlug}.rozare.com is now secured until ${expiresAt.toLocaleDateString()}.`,
            category: 'system',
            linkTo: '/seller-dashboard/subdomain',
            source: 'system',
            targetRole: 'seller',
            audience: 'specific',
        }).catch(e => console.error('Subdomain purchase notification failed:', e.message));

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
            'subdomainPurchase.removalScheduledAt': { $lte: now, $ne: null },
            'subdomainPurchase.isPurchased': { $ne: true },
            storeSlug: { $not: /^removed-/ }, // prevent double-processing
        });

        for (const store of storesToRemoveSubdomain) {
            const oldSlug = store.storeSlug;

            // Generate a unique removed slug with random suffix to prevent collisions
            const randomSuffix = Math.random().toString(36).substring(2, 8);
            const newSlug = `removed-${store._id.toString().slice(-8)}-${Date.now().toString(36)}-${randomSuffix}`;

            // Double-check no collision (extremely unlikely but safe)
            const existing = await Store.findOne({ storeSlug: newSlug });
            if (existing && existing._id.toString() !== store._id.toString()) {
                console.warn(`[subdomain] Slug collision detected for ${newSlug}, skipping this run`);
                continue;
            }

            store.storeSlug = newSlug;
            if (store.subdomainPurchase) {
                store.subdomainPurchase.removalScheduledAt = null;
            }
            await store.save();

            console.log(`[subdomain] Removed subdomain "${oldSlug}" from blocked store ${store._id} (7-day grace period expired)`);

            // Notify seller
            await Notification.create({
                user: store.seller,
                title: 'Subdomain removed',
                body: `Your subdomain "${oldSlug}.rozare.com" has been removed because your account remained blocked for 7 days. Subscribe to get a new subdomain or purchase one to protect it.`,
                category: 'system',
                linkTo: '/seller-dashboard/subdomain',
                source: 'system',
                targetRole: 'seller',
                audience: 'specific',
            }).catch(e => console.error('Subdomain removal notification failed:', e.message));
        }

        // 3. Expire purchased subdomains that have passed 3-year ownership
        const expiredPurchases = await Store.find({
            'subdomainPurchase.isPurchased': true,
            'subdomainPurchase.expiresAt': { $lte: now, $ne: null },
        });

        for (const store of expiredPurchases) {
            store.subdomainPurchase.isPurchased = false;
            store.subdomainPurchase.purchasedAt = null;
            store.subdomainPurchase.expiresAt = null;
            store.subdomainPurchase.stripePaymentId = '';
            await store.save();

            console.log(`[subdomain] Subdomain purchase expired for store ${store._id} (${store.storeSlug})`);

            // Notify seller about expiry
            const user = await User.findById(store.seller);
            if (user?.email) {
                const html = subdomainEmailTemplate(
                    'Subdomain Ownership Expired',
                    `<p>Hello ${user.username || 'Seller'},</p>
                    <p>Your subdomain ownership for <strong>${store.storeSlug}.rozare.com</strong> has expired after ${SUBDOMAIN_OWNERSHIP_YEARS} years.</p>
                    <div class="highlight">
                        <strong>What this means:</strong> Your subdomain is no longer protected. If your account is blocked, the subdomain may be released to others after 7 days.
                    </div>
                    <p>You can renew your subdomain ownership from your dashboard for $${SUBDOMAIN_PRICE_CENTS / 100}.</p>
                    <p style="text-align:center"><a href="${process.env.FRONTEND_URL}/seller-dashboard/subdomain" class="button">Renew Subdomain</a></p>`
                );
                await sendEmail({ to: user.email, subject: 'Subdomain Ownership Expired — Renew Now', html });
            }

            await Notification.create({
                user: store.seller,
                title: 'Subdomain ownership expired',
                body: `Your subdomain ownership for "${store.storeSlug}.rozare.com" has expired. Renew to keep it protected.`,
                category: 'system',
                linkTo: '/seller-dashboard/subdomain',
                source: 'system',
                targetRole: 'seller',
                audience: 'specific',
            }).catch(e => console.error('Subdomain expiry notification failed:', e.message));
        }

        if (storesToRemoveSubdomain.length > 0 || expiredPurchases.length > 0) {
            console.log(`[subdomain] Processed: ${storesToRemoveSubdomain.length} removals, ${expiredPurchases.length} purchase expirations`);
        }
    } catch (error) {
        console.error('Process subdomain removals error:', error);
    }
};
