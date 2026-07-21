const SellerSubscription = require('../models/SellerSubscription');
const Store = require('../models/Store');
const User = require('../models/User');
const { sendEmail } = require('./mailController');
const { stripe, STRIPE_MODE } = require('../config/stripe');
const { notifySeller } = require('../services/whatsapp/sellerNotificationService');
const sellerTemplates = require('../services/whatsapp/sellerMessageTemplates');
const {
    META_ADS_ADDON_CENTS,
    buildPlanPricing,
    getPricingCatalog,
} = require('../services/subscriptionPricingService');
const {
    FOUNDER_PROMOTION,
    normalizePromotionCode,
    getFounderPromotionStatus,
    reserveFounderSlot,
    attachCheckoutSessionToReservation,
    releaseFounderReservation,
    claimFounderReservation,
    migrateLegacyFounderSubscribers,
} = require('../services/founderPromotionService');

function formatSubscriptionPriceForSeller(plan, subscription, includeMetaAds = false) {
    const pricing = buildPlanPricing(
        plan,
        includeMetaAds,
        Boolean(subscription?.founderOffer?.active)
    );
    return `$${(pricing.unitAmount / 100).toFixed(2)}/month`;
}

// Email template
const subscriptionEmailTemplate = (title, bodyHtml) => `
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
    .header { background: linear-gradient(135deg, #F59E0B, #EF4444); color: #fff; padding: 1.25rem 2rem; border-radius: 12px 12px 0 0; font-size: 1.2rem; font-weight: 600; text-align: center; }
    .content { padding: 1.5rem 0; line-height: 1.7; }
    .content p { margin: 0.75rem 0; }
    .button { display: inline-block; margin-top: 1.25rem; background: linear-gradient(135deg, #4F46E5, #3B82F6); color: white !important; padding: 0.75rem 1.75rem; border-radius: 10px; text-decoration: none; font-weight: 600; }
    .footer { font-size: 13px; text-align: center; color: #6B7280; margin-top: 2rem; }
    .highlight { background: #FEF3C7; border-radius: 10px; padding: 1rem 1.25rem; margin: 1rem 0; border-left: 4px solid #F59E0B; }
    .danger { background: #FEE2E2; border-left-color: #EF4444; }
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

// Initialize subscription when seller creates store or becomes seller
exports.initializeSubscription = async (sellerId) => {
    try {
        let sub = await SellerSubscription.findOne({ seller: sellerId });
        if (sub) return sub;

        const now = new Date();
        const trialEnd = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000);

        sub = new SellerSubscription({
            seller: sellerId,
            trialStartDate: now,
            trialEndDate: trialEnd,
            status: 'trial',
            plan: 'free_trial',
            planName: 'Rozare Free Trial',
            aiMessageLimit: -1,
        });
        await sub.save();
        return sub;
    } catch (error) {
        console.error('Initialize subscription error:', error);
        throw error;
    }
};

// Get subscription status
exports.getSubscriptionStatus = async (req, res) => {
    try {
        const sellerId = req.user.id;
        let sub = await SellerSubscription.findOne({ seller: sellerId });

        if (!sub) {
            sub = await exports.initializeSubscription(sellerId);
        }

        // Check and update status if trial expired
        await checkAndUpdateStatus(sub);

        // Check bonus features expiry (only for starter plan, not elite)
        if (sub.bonusFeaturesActive && sub.bonusExpiryDate && new Date() > sub.bonusExpiryDate && sub.plan !== 'elite') {
            sub.bonusFeaturesActive = false;
            sub.bonusFeaturesExpiredPermanently = true;
            await sub.save();
        }

        // Calculate grace period info
        const now = new Date();
        const hasGracePeriod = sub.status === 'blocked' && sub.bonusGraceDeadline && now < sub.bonusGraceDeadline && !sub.bonusFeaturesExpiredPermanently;
        const graceDaysRemaining = hasGracePeriod ? Math.ceil((sub.bonusGraceDeadline - now) / (1000 * 60 * 60 * 24)) : 0;

        const founderPromotion = await getFounderPromotionStatus(sub);

        res.json({
            subscription: {
                status: sub.status,
                plan: sub.plan,
                planName: sub.status === 'trial' || sub.plan === 'free_trial'
                    ? 'Rozare Free Trial'
                    : sub.planName || (sub.plan === 'elite' ? 'Rozare Elite' : 'Rozare Starter'),
                trialStartDate: sub.trialStartDate,
                trialEndDate: sub.trialEndDate,
                trialDaysRemaining: sub.trialDaysRemaining,
                isTrialExpiringSoon: sub.isTrialExpiringSoon,
                isBlocked: sub.isBlocked,
                subscribedAt: sub.subscribedAt,
                freePeriodEndDate: sub.freePeriodEndDate,
                currentPeriodEnd: sub.currentPeriodEnd,
                aiMessageLimit: -1,
                aiMessagesUnlimited: true,
                metaAdsIncluded: sub.metaAdsIncluded || false,
                metaAdsAddonCents: META_ADS_ADDON_CENTS,
                cancelledAt: sub.cancelledAt,
                blockedReason: sub.blockedReason,
                bonusFeaturesActive: sub.bonusFeaturesActive,
                bonusExpiryDate: sub.bonusExpiryDate,
                bonusFeaturesExpiredPermanently: sub.bonusFeaturesExpiredPermanently || false,
                bonusGraceDeadline: sub.bonusGraceDeadline || null,
                bonusGraceDaysRemaining: graceDaysRemaining,
                pendingDowngrade: sub.pendingDowngrade?.toPlan || null,
                hasUsedFreePeriod: sub.hasUsedFreePeriod || false,
                pricing: getPricingCatalog(),
                founderOffer: {
                    active: Boolean(sub.founderOffer?.active),
                    code: sub.founderOffer?.code || null,
                    discountPercent: Number(sub.founderOffer?.discountPercent || 0),
                    claimedAt: sub.founderOffer?.claimedAt || null,
                    forfeitedAt: sub.founderOffer?.forfeitedAt || null,
                    source: sub.founderOffer?.source || null,
                },
                founderPromotion,
            },
        });
    } catch (error) {
        console.error('Get subscription status error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

// Check and update subscription status
async function checkAndUpdateStatus(sub) {
    const now = new Date();

    if (sub.status === 'trial' && now > sub.trialEndDate) {
        sub.status = 'blocked';
        sub.blockedAt = now;
        sub.blockedReason = 'Trial period expired. Please subscribe to a paid plan to reactivate your store.';

        // Block the store + schedule subdomain removal in 7 days (if not purchased)
        const storeDoc = await Store.findOne({ seller: sub.seller });
        if (storeDoc) {
            storeDoc.isActive = false;
            storeDoc.blockedAt = now;
            const purchased = storeDoc.subdomainPurchase?.isPurchased &&
                storeDoc.subdomainPurchase?.expiresAt &&
                new Date(storeDoc.subdomainPurchase.expiresAt) > now;
            if (!purchased) {
                storeDoc.subdomainPurchase = {
                    ...(storeDoc.subdomainPurchase?.toObject?.() || {}),
                    removalScheduledAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
                };
            }
            await storeDoc.save();
        }

        await sub.save();
    }

    if (sub.status === 'free_period' && sub.freePeriodEndDate && now > sub.freePeriodEndDate) {
        // Free period ended, transition to active billing
        sub.status = 'active';
        sub.currentPeriodStart = now;
        sub.currentPeriodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        await sub.save();
    }

    return sub;
}

async function createStripeCustomerForSeller(user, sellerId) {
    const customer = await stripe.customers.create({
        email: user.email,
        name: user.username || user.email,
        metadata: { sellerId: sellerId.toString(), stripeMode: STRIPE_MODE },
    });

    return customer.id;
}

async function getUsableStripeCustomerId(sub, user, sellerId) {
    if (!sub.stripeCustomerId) {
        sub.stripeCustomerId = await createStripeCustomerForSeller(user, sellerId);
        sub.stripeSubscriptionId = undefined;
        sub.stripePriceId = undefined;
        await sub.save();
        return sub.stripeCustomerId;
    }

    try {
        const customer = await stripe.customers.retrieve(sub.stripeCustomerId);
        if (customer?.deleted) {
            throw Object.assign(new Error(`Stripe customer ${sub.stripeCustomerId} is deleted`), { code: 'resource_missing' });
        }

        return sub.stripeCustomerId;
    } catch (error) {
        if (error?.code !== 'resource_missing') throw error;

        console.warn('[subscription] Stored Stripe customer is not available in current mode; creating a new customer.', {
            sellerId: sellerId.toString(),
            staleCustomerId: sub.stripeCustomerId,
            stripeMode: STRIPE_MODE,
        });

        sub.stripeCustomerId = await createStripeCustomerForSeller(user, sellerId);
        sub.stripeSubscriptionId = undefined;
        sub.stripePriceId = undefined;
        await sub.save();
        return sub.stripeCustomerId;
    }
}

// Create Stripe checkout for subscription
exports.createCheckout = async (req, res) => {
    let founderReservation = null;
    let sellerId = null;
    try {
        // Guard: Stripe must be configured. In live mode this is the most common
        // cause of a 500 here (e.g. STRIPE_LIVE_SECRET_KEY missing in env).
        if (!stripe) {
            console.error('[subscription] createCheckout: Stripe is not configured');
            return res.status(503).json({
                msg: 'Payments are not configured on the server. Please contact support.',
                code: 'STRIPE_NOT_CONFIGURED',
            });
        }

        sellerId = req.user.id;
        const { plan } = req.body; // 'starter' or 'elite'
        const includeMetaAdsRequested = Boolean(req.body?.includeMetaAds);
        const requestedCouponCode = normalizePromotionCode(req.body?.couponCode);
        if (!['starter', 'elite'].includes(plan)) {
            return res.status(400).json({ msg: 'Choose a valid subscription plan.' });
        }
        if (includeMetaAdsRequested && plan !== 'elite') {
            return res.status(400).json({ msg: 'Meta ads can only be added to the Rozare Elite plan.' });
        }
        if (requestedCouponCode && requestedCouponCode !== FOUNDER_PROMOTION.code) {
            return res.status(400).json({
                msg: 'This subscription coupon is not valid.',
                code: 'INVALID_SUBSCRIPTION_COUPON',
            });
        }
        const user = await User.findById(sellerId);
        if (!user) {
            return res.status(404).json({ msg: 'Seller account not found.' });
        }
        if (!user.email) {
            return res.status(400).json({ msg: 'Your account is missing an email address. Please update your profile before subscribing.' });
        }

        let sub = await SellerSubscription.findOne({ seller: sellerId });

        if (!sub) {
            sub = await exports.initializeSubscription(sellerId);
        }

        // Already subscribed
        if (['active', 'free_period'].includes(sub.status)) {
            return res.status(400).json({ msg: 'You already have an active subscription.' });
        }

        // Create or validate Stripe customer. A saved customer can be stale when
        // switching test/live mode or if it was deleted in Stripe.
        const customerId = await getUsableStripeCustomerId(sub, user, sellerId);

        // Prevent parallel subscription exploit:
        // (1) Expire any OPEN checkout sessions for this customer so they can't be completed later
        // (2) Cancel any existing ACTIVE/TRIALING Stripe subscriptions before creating a new one
        try {
            // Layer 1: Expire open checkout sessions (prevents "two tabs, pay both" exploit)
            const openSessions = await stripe.checkout.sessions.list({
                customer: customerId,
                limit: 20,
            });
            for (const s of openSessions.data) {
                if (s.status === 'open' && s.mode === 'subscription') {
                    try {
                        await stripe.checkout.sessions.expire(s.id);
                        if (s.metadata?.founderReservationToken) {
                            await releaseFounderReservation({
                                sellerId,
                                token: s.metadata.founderReservationToken,
                                checkoutSessionId: s.id,
                            });
                        }
                    } catch (expireError) {
                        console.error(`Failed to expire open checkout session ${s.id}:`, expireError.message);
                    }
                } else if (s.status === 'expired' && s.metadata?.founderReservationToken) {
                    await releaseFounderReservation({
                        sellerId,
                        token: s.metadata.founderReservationToken,
                        checkoutSessionId: s.id,
                    });
                }
            }

            // Layer 2: Cancel any active subscriptions
            const existingSubs = await stripe.subscriptions.list({
                customer: customerId,
                status: 'active',
                limit: 10,
            });
            for (const existing of existingSubs.data) {
                if (existing.id !== sub.stripeSubscriptionId) {
                    await stripe.subscriptions.cancel(existing.id).catch(e =>
                        console.error(`Failed to cancel stale sub ${existing.id}:`, e.message)
                    );
                }
            }
            // Also cancel any trialing subscriptions
            const trialingSubs = await stripe.subscriptions.list({
                customer: customerId,
                status: 'trialing',
                limit: 10,
            });
            for (const existing of trialingSubs.data) {
                if (existing.id !== sub.stripeSubscriptionId) {
                    await stripe.subscriptions.cancel(existing.id).catch(e =>
                        console.error(`Failed to cancel stale trial sub ${existing.id}:`, e.message)
                    );
                }
            }
        } catch (listErr) {
            console.error('Failed to list/expire existing Stripe sessions/subscriptions:', listErr.message);
            // Continue anyway — worst case user has a duplicate; webhook will handle the latest
        }

        if (requestedCouponCode === FOUNDER_PROMOTION.code) {
            if (sub.founderOffer?.claimedAt || sub.founderOffer?.forfeitedAt) {
                return res.status(400).json({
                    msg: sub.founderOffer?.active
                        ? 'Your founder price is already locked to this subscription.'
                        : 'This seller account has already used the founder coupon. The founder rate ends when the subscription ends.',
                    code: 'FOUNDER_COUPON_ALREADY_USED',
                });
            }
            founderReservation = await reserveFounderSlot(sellerId);
        }

        // Determine plan details
        const {
            isElite,
            includeMetaAds,
            planName,
            unitAmount: priceAmount,
            metaAddOn,
        } = buildPlanPricing(plan, includeMetaAdsRequested, Boolean(founderReservation));
        const getsFreePeriod = !sub.hasUsedFreePeriod;
        const trialDays = getsFreePeriod ? (isElite ? 45 : 30) : 0;
        const description = isElite
            ? getsFreePeriod
                ? `Rozare Elite - First 45 days free, then $${(priceAmount / 100).toFixed(2)}/month. Includes all Starter + Bonus features${includeMetaAds ? ' plus Meta ads add-on' : ''}${founderReservation ? ' at the FIRST100 founder rate' : ''}. Cancel anytime.`
                : `Rozare Elite - $${(priceAmount / 100).toFixed(2)}/month. Includes all Starter + Bonus features${includeMetaAds ? ' plus Meta ads add-on' : ''}${founderReservation ? ' at the FIRST100 founder rate' : ''}. Cancel anytime.`
            : getsFreePeriod
                ? `Rozare Starter - First 30 days free, then $${(priceAmount / 100).toFixed(2)}/month${founderReservation ? ' at the FIRST100 founder rate' : ''}. Cancel anytime.`
                : `Rozare Starter - $${(priceAmount / 100).toFixed(2)}/month${founderReservation ? ' at the FIRST100 founder rate' : ''}. Cancel anytime.`;

        // Create a subscription (with or without free trial period)
        const sessionConfig = {
            customer: customerId,
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: planName,
                        description,
                    },
                    unit_amount: priceAmount,
                    recurring: { interval: 'month' },
                },
                quantity: 1,
            }],
            subscription_data: {
                metadata: {
                    sellerId: sellerId.toString(),
                    plan: isElite ? 'elite' : 'starter',
                    includeMetaAds: includeMetaAds ? 'true' : 'false',
                    metaAdsAddonCents: String(metaAddOn || 0),
                    founderCouponCode: founderReservation ? FOUNDER_PROMOTION.code : '',
                    founderReservationToken: founderReservation?.token || '',
                },
            },
            success_url: `${process.env.FRONTEND_URL}/seller-dashboard/subscription?success=true`,
            cancel_url: `${process.env.FRONTEND_URL}/seller-dashboard/subscription?cancelled=true${founderReservation ? `&coupon=${FOUNDER_PROMOTION.code}` : ''}`,
            metadata: {
                sellerId: sellerId.toString(),
                plan: isElite ? 'elite' : 'starter',
                includeMetaAds: includeMetaAds ? 'true' : 'false',
                metaAdsAddonCents: String(metaAddOn || 0),
                founderCouponCode: founderReservation ? FOUNDER_PROMOTION.code : '',
                founderReservationToken: founderReservation?.token || '',
            },
        };

        if (founderReservation) {
            sessionConfig.expires_at = Math.floor(Date.now() / 1000)
                + FOUNDER_PROMOTION.checkoutReservationMinutes * 60;
        }

        // Only add trial days if seller hasn't used free period before
        if (trialDays > 0) {
            sessionConfig.subscription_data.trial_period_days = trialDays;
        }

        const session = await stripe.checkout.sessions.create(sessionConfig);

        if (founderReservation) {
            try {
                await attachCheckoutSessionToReservation(sellerId, founderReservation.token, session.id);
            } catch (reservationError) {
                await stripe.checkout.sessions.expire(session.id).catch(expireError => {
                    console.error('[subscription] Failed to expire Checkout after reservation attach failure:', expireError.message);
                });
                throw reservationError;
            }
        }

        res.json({
            url: session.url,
            sessionId: session.id,
            founderOfferReserved: Boolean(founderReservation),
        });
    } catch (error) {
        if (founderReservation) {
            await releaseFounderReservation({ sellerId, token: founderReservation.token }).catch(releaseError => {
                console.error('[subscription] Failed to release founder reservation after Checkout error:', releaseError.message);
            });
        }
        // Surface a useful diagnostic so the seller (and our logs) can tell
        // *why* checkout failed instead of a generic 500. Stripe SDK errors
        // expose `type`, `code`, and `message`.
        console.error('Create checkout error:', {
            message: error?.message,
            type: error?.type,
            code: error?.code,
            statusCode: error?.statusCode,
            raw: error?.raw?.message,
        });
        const status = [
            'FOUNDER_COUPON_FULL',
            'FOUNDER_COUPON_ALREADY_USED',
            'FOUNDER_CHECKOUT_PENDING',
        ].includes(error?.code) ? 409 : 500;
        res.status(status).json({
            msg: error?.raw?.message || error?.message || 'Failed to create checkout session',
            code: error?.code || error?.type || 'CHECKOUT_ERROR',
        });
    }
};

// Handle subscription webhook events
exports.handleWebhook = async (event) => {
    try {
        switch (event.type) {
            case 'checkout.session.expired': {
                const session = event.data.object;
                if (session.mode !== 'subscription' || !session.metadata?.founderReservationToken) break;
                await releaseFounderReservation({
                    sellerId: session.metadata?.sellerId,
                    token: session.metadata.founderReservationToken,
                    checkoutSessionId: session.id,
                });
                break;
            }

            case 'checkout.session.completed': {
                const session = event.data.object;

                // Handle subdomain purchase (one-time payment)
                if (session.mode === 'payment' && session.metadata?.type === 'subdomain_purchase') {
                    const { handleSubdomainPurchaseWebhook } = require('./subdomainPurchaseController');
                    await handleSubdomainPurchaseWebhook(session);
                    break;
                }

                if (session.mode !== 'subscription') break;

                const sellerId = session.metadata?.sellerId;
                if (!sellerId) break;

                let sub = await SellerSubscription.findOne({ seller: sellerId });
                if (!sub) break;

                const selectedPlan = session.metadata?.plan || 'starter';
                const isElite = selectedPlan === 'elite';
                const includeMetaAds = isElite && session.metadata?.includeMetaAds === 'true';
                const founderReservationToken = session.metadata?.founderReservationToken || '';
                const usesFounderCoupon = session.metadata?.founderCouponCode === FOUNDER_PROMOTION.code
                    && Boolean(founderReservationToken);
                const now = new Date();

                // Atomic race guard: try to "claim" this subscription slot. If another parallel
                // webhook already claimed a DIFFERENT stripeSubscriptionId for this seller in an
                // active billing state, this update will match zero documents and we know the
                // incoming checkout is a duplicate from a parallel-checkout exploit.
                const previousStripeSubId = sub.stripeSubscriptionId;
                const claimed = await SellerSubscription.findOneAndUpdate(
                    {
                        seller: sellerId,
                        $or: [
                            { stripeSubscriptionId: null },
                            { stripeSubscriptionId: { $exists: false } },
                            { stripeSubscriptionId: session.subscription },
                            // Allow overwriting if the existing sub is in a non-billing state
                            { status: { $in: ['trial', 'cancelled', 'blocked'] } },
                        ],
                    },
                    { $set: { stripeSubscriptionId: session.subscription } },
                    { new: false } // we only need to know if a doc matched; we'll reload below
                );

                if (!claimed) {
                    // Another webhook already claimed an active sub — this is a duplicate from
                    // a parallel checkout. Cancel the incoming Stripe sub and bail out.
                    try {
                        await stripe.subscriptions.cancel(session.subscription);
                        console.log(`[subscription] Race lost for seller ${sellerId}. Cancelled duplicate incoming sub ${session.subscription}`);
                    } catch (cancelErr) {
                        console.error('Failed to cancel duplicate incoming subscription:', cancelErr.message);
                    }
                    if (usesFounderCoupon) {
                        await releaseFounderReservation({
                            sellerId,
                            token: founderReservationToken,
                            checkoutSessionId: session.id,
                        });
                    }
                    break;
                }

                // Reload the freshly-claimed document so `sub.save()` works on the latest state
                sub = await SellerSubscription.findOne({ seller: sellerId });
                if (!sub) break;

                if (usesFounderCoupon) {
                    try {
                        const founderClaim = await claimFounderReservation({
                            sellerId,
                            token: founderReservationToken,
                            checkoutSessionId: session.id,
                        });
                        sub.founderOffer = {
                            active: true,
                            code: FOUNDER_PROMOTION.code,
                            discountPercent: FOUNDER_PROMOTION.discountPercent,
                            claimedAt: founderClaim.claimedAt || sub.founderOffer?.claimedAt || now,
                            forfeitedAt: null,
                            source: 'coupon',
                        };
                    } catch (founderError) {
                        const isDeterministicFounderFailure = [
                            'FOUNDER_RESERVATION_INVALID',
                            'FOUNDER_COUPON_ALREADY_USED',
                        ].includes(founderError?.code);
                        if (!isDeterministicFounderFailure) {
                            // A transient database failure must make Stripe retry the webhook.
                            // Cancelling here would incorrectly destroy a valid founder checkout.
                            if (previousStripeSubId) {
                                await SellerSubscription.updateOne(
                                    { seller: sellerId, stripeSubscriptionId: session.subscription },
                                    { $set: { stripeSubscriptionId: previousStripeSubId } }
                                );
                            } else {
                                await SellerSubscription.updateOne(
                                    { seller: sellerId, stripeSubscriptionId: session.subscription },
                                    { $unset: { stripeSubscriptionId: 1 } }
                                );
                            }
                            throw founderError;
                        }

                        console.error('[subscription] Founder reservation claim failed; cancelling discounted subscription.', {
                            sellerId,
                            sessionId: session.id,
                            subscriptionId: session.subscription,
                            code: founderError?.code,
                            message: founderError?.message,
                        });
                        await stripe.subscriptions.cancel(session.subscription).catch(cancelError => {
                            console.error('[subscription] Failed to cancel invalid founder subscription:', cancelError.message);
                        });

                        if (previousStripeSubId) {
                            await SellerSubscription.updateOne(
                                { seller: sellerId, stripeSubscriptionId: session.subscription },
                                { $set: { stripeSubscriptionId: previousStripeSubId } }
                            );
                        } else {
                            await SellerSubscription.updateOne(
                                { seller: sellerId, stripeSubscriptionId: session.subscription },
                                { $unset: { stripeSubscriptionId: 1 } }
                            );
                        }
                        break;
                    }
                }

                // If we claimed over a stale stripeSubscriptionId (different from incoming),
                // cancel the stale one on Stripe's side.
                if (
                    previousStripeSubId &&
                    previousStripeSubId !== session.subscription
                ) {
                    try {
                        await stripe.subscriptions.cancel(previousStripeSubId);
                        console.log(`[subscription] Cancelled stale stripe sub ${previousStripeSubId} in favor of new ${session.subscription}`);
                    } catch (cancelErr) {
                        console.error('Failed to cancel stale subscription:', cancelErr.message);
                    }
                }

                // Determine if seller gets a free period (only first time ever)
                const getsFreePeriod = !sub.hasUsedFreePeriod;
                const freePeriodDays = getsFreePeriod ? (isElite ? 45 : 30) : 0;

                sub.plan = isElite ? 'elite' : 'starter';
                sub.planName = isElite
                    ? (includeMetaAds ? 'Rozare Elite + Meta Ads' : 'Rozare Elite')
                    : 'Rozare Starter';
                sub.metaAdsIncluded = includeMetaAds;
                sub.subscribedAt = now;
                sub.stripeSubscriptionId = session.subscription;
                sub.aiMessageLimit = -1;
                sub.blockedAt = null;
                sub.blockedReason = '';
                sub.pendingDowngrade = { toPlan: null, scheduledAt: null };

                if (getsFreePeriod) {
                    sub.status = 'free_period';
                    sub.freePeriodEndDate = new Date(now.getTime() + freePeriodDays * 24 * 60 * 60 * 1000);
                    sub.hasUsedFreePeriod = true;
                } else {
                    // No free period — go straight to active
                    sub.status = 'active';
                    sub.currentPeriodStart = now;
                    sub.currentPeriodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
                }

                if (isElite) {
                    // Elite plan: bonus features are always active (never expire)
                    sub.bonusFeaturesActive = true;
                    sub.bonusExpiryDate = null; // No expiry for Elite
                    sub.bonusFeaturesExpiredPermanently = false;
                    sub.bonusGraceDeadline = null;
                } else {
                    // Starter plan: check permanent starter bonus usage, grace period, and temp expiry
                    if (sub.starterBonusPeriodUsed) {
                        // This seller has already had their Starter bonus period before — no more bonus on Starter
                        sub.bonusFeaturesActive = false;
                        sub.bonusFeaturesExpiredPermanently = true;
                        sub.bonusGraceDeadline = null;
                    } else if (sub.bonusFeaturesExpiredPermanently) {
                        // Permanently expired (safety check) — Starter re-subscription does NOT restore bonus
                        sub.bonusFeaturesActive = false;
                    } else if (sub.bonusGraceDeadline && now <= sub.bonusGraceDeadline && sub.bonusExpiryDate) {
                        // Re-subscribed within 3-day grace period — keep remaining bonus time
                        sub.bonusFeaturesActive = true;
                        // bonusExpiryDate stays the same (the original 6-month deadline)
                        sub.bonusGraceDeadline = null;
                        // starterBonusPeriodUsed already true from initial subscribe
                    } else if (sub.bonusGraceDeadline && now > sub.bonusGraceDeadline) {
                        // Grace period passed — bonus permanently gone for Starter
                        sub.bonusFeaturesActive = false;
                        sub.bonusFeaturesExpiredPermanently = true;
                        sub.bonusGraceDeadline = null;
                    } else {
                        // Fresh subscription (first time on Starter) — give 6 months bonus
                        const bonusExpiry = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
                        sub.bonusFeaturesActive = true;
                        sub.bonusExpiryDate = bonusExpiry;
                        sub.bonusGraceDeadline = null;
                        sub.starterBonusPeriodUsed = true; // Mark permanently — can never get fresh Starter bonus again
                    }
                }

                await sub.save();

                // Reactivate store + clear blocked / removal markers
                await Store.findOneAndUpdate(
                    { seller: sellerId },
                    {
                        isActive: true,
                        blockedAt: null,
                        'subdomainPurchase.removalScheduledAt': null,
                    }
                );

                // Send confirmation email
                const user = await User.findById(sellerId);
                if (user?.email) {
                    const activatedPricing = buildPlanPricing(
                        selectedPlan,
                        includeMetaAds,
                        Boolean(sub.founderOffer?.active)
                    );
                    const priceStr = `$${(activatedPricing.unitAmount / 100).toFixed(2)}/month`;
                    const bonusStr = isElite
                        ? '<strong>Bonus Features:</strong> Permanently included with your Elite plan'
                        : sub.bonusFeaturesActive && sub.bonusExpiryDate
                            ? `<strong>Bonus Features:</strong> Active for 6 months (until ${new Date(sub.bonusExpiryDate).toLocaleDateString()})`
                            : '<strong>Bonus Features:</strong> Not available (previously expired)';

                    const freePeriodStr = getsFreePeriod
                        ? `<strong>Free Period:</strong> ${freePeriodDays} days (until ${sub.freePeriodEndDate.toLocaleDateString()})<br/>`
                        : '<strong>Billing:</strong> Active immediately<br/>';

                    const html = subscriptionEmailTemplate(
                        `${sub.planName} Activated!`,
                        `<p>Hello ${user.username || 'Seller'},</p>
                        <p>Your <strong>${sub.planName}</strong> plan is now active!</p>
                        <div class="highlight">
                            <strong>Plan:</strong> ${sub.planName} (${priceStr})<br/>
                            ${freePeriodStr}
                            <strong>AI Chat:</strong> Unlimited seller AI chat<br/>
                            ${sub.founderOffer?.active ? '<strong>Founder rate:</strong> Locked while this subscription remains uninterrupted<br/>' : ''}
                            ${includeMetaAds ? '<strong>Meta ads add-on:</strong> Included<br/>' : ''}
                            ${bonusStr}
                        </div>
                        <p>Your store has been reactivated and is now visible to customers.</p>
                        <p style="text-align:center"><a href="${process.env.FRONTEND_URL}/seller-dashboard" class="button">Go to Dashboard</a></p>`
                    );
                    await sendEmail({ to: user.email, subject: `${sub.planName} Activated!`, html });
                }
                // WhatsApp notification to seller (fire-and-forget)
                notifySeller(sellerId, 'subscription_activated', sellerTemplates.subscription_activated(sub.planName, freePeriodDays)).catch(e =>
                    console.error('[whatsapp] seller subscription activated notification failed:', e.message)
                );
                break;
            }

            case 'customer.subscription.deleted': {
                const subscription = event.data.object;
                const sub = await SellerSubscription.findOne({ stripeSubscriptionId: subscription.id });
                if (!sub) break;

                const now = new Date();

                // Check if this is a downgrade to Starter (not a real cancellation)
                if (sub.pendingDowngrade?.toPlan === 'starter') {
                    // Auto-create a new Starter subscription via Stripe
                    try {
                        // Ensure customer has a default payment method
                        // Get the payment method from the cancelled Elite subscription
                        let defaultPaymentMethod = null;
                        try {
                            const customer = await stripe.customers.retrieve(sub.stripeCustomerId);
                            defaultPaymentMethod = customer.invoice_settings?.default_payment_method;

                            // If no default payment method, try to get one from the ended subscription
                            if (!defaultPaymentMethod) {
                                const endedSub = await stripe.subscriptions.retrieve(subscription.id).catch(() => null);
                                if (endedSub?.default_payment_method) {
                                    defaultPaymentMethod = endedSub.default_payment_method;
                                    // Set it as customer's default
                                    await stripe.customers.update(sub.stripeCustomerId, {
                                        invoice_settings: { default_payment_method: defaultPaymentMethod },
                                    });
                                }
                            }
                        } catch (pmErr) {
                            console.error('Error retrieving payment method for downgrade:', pmErr.message);
                        }

                        const starterPricing = buildPlanPricing(
                            'starter',
                            false,
                            Boolean(sub.founderOffer?.active)
                        );
                        const subCreateParams = {
                            customer: sub.stripeCustomerId,
                            items: [{
                                price_data: {
                                    currency: 'usd',
                                    product_data: {
                                        name: 'Rozare Starter',
                                        description: `Rozare Starter - $${(starterPricing.unitAmount / 100).toFixed(2)}/month${sub.founderOffer?.active ? ' at the locked FIRST100 founder rate' : ''}. Cancel anytime.`,
                                    },
                                    unit_amount: starterPricing.unitAmount,
                                    recurring: { interval: 'month' },
                                },
                            }],
                            metadata: {
                                sellerId: sub.seller.toString(),
                                plan: 'starter',
                                founderCouponCode: sub.founderOffer?.active ? FOUNDER_PROMOTION.code : '',
                            },
                            payment_behavior: 'default_incomplete', // Don't block if charge fails
                        };

                        if (defaultPaymentMethod) {
                            subCreateParams.default_payment_method = defaultPaymentMethod;
                        }

                        const newSubscription = await stripe.subscriptions.create(subCreateParams);

                        // Update local subscription to Starter
                        sub.status = 'active';
                        sub.plan = 'starter';
                        sub.planName = 'Rozare Starter';
                        sub.metaAdsIncluded = false;
                        sub.stripeSubscriptionId = newSubscription.id;
                        sub.currentPeriodStart = now;
                        sub.currentPeriodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
                        sub.cancelledAt = null;
                        sub.pendingDowngrade = { toPlan: null, scheduledAt: null };
                        sub.warningEmailSent = false;

                        // Bonus features on downgrade: only give 6 months if seller has NEVER used Starter bonus before
                        // starterBonusPeriodUsed is permanent and never resets — prevents Starter→Elite→Starter exploit
                        if (!sub.starterBonusPeriodUsed) {
                            const bonusExpiry = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
                            sub.bonusFeaturesActive = true;
                            sub.bonusExpiryDate = bonusExpiry;
                            sub.bonusFeaturesExpiredPermanently = false;
                            sub.bonusExpiryWarningEmailSent = false;
                            sub.starterBonusPeriodUsed = true; // Mark permanently
                        } else {
                            // Already used Starter bonus period before — no fresh bonus on downgrade
                            sub.bonusFeaturesActive = false;
                            sub.bonusFeaturesExpiredPermanently = true;
                            sub.bonusExpiryDate = null;
                        }

                        await sub.save();

                        // Send notification
                        const Notification = require('../models/Notification');
                        await Notification.create({
                            user: sub.seller,
                            title: 'Switched to Rozare Starter',
                            body: `Your plan has been switched from Elite to Starter ($${(starterPricing.unitAmount / 100).toFixed(2)}/month). Your store remains active.`,
                            category: 'subscription',
                            linkTo: '/seller-dashboard/subscription',
                            source: 'system',
                        }).catch(e => console.error('Downgrade complete notification failed:', e.message));

                        const user = await User.findById(sub.seller);
                        if (user?.email) {
                            const bonusInfo = sub.bonusFeaturesActive
                                ? `<strong>Bonus Features:</strong> Active for 6 months (until ${sub.bonusExpiryDate.toLocaleDateString()})`
                                : '<strong>Bonus Features:</strong> Not available (previously expired)';

                            const html = subscriptionEmailTemplate(
                                'Switched to Rozare Starter',
                                `<p>Hello ${user.username || 'Seller'},</p>
                                <p>Your plan has been switched from <strong>Rozare Elite</strong> to <strong>Rozare Starter</strong>.</p>
                                <div class="highlight">
                                    <strong>Plan:</strong> Rozare Starter ($${(starterPricing.unitAmount / 100).toFixed(2)}/month)<br/>
                                    ${sub.founderOffer?.active ? '<strong>Founder rate:</strong> Preserved across your plan change<br/>' : ''}
                                    <strong>AI Chat:</strong> Unlimited seller AI chat<br/>
                                    ${bonusInfo}
                                </div>
                                <p>Your store remains active. You can upgrade back to Elite anytime.</p>
                                <p style="text-align:center"><a href="${process.env.FRONTEND_URL}/seller-dashboard/subscription" class="button">View Subscription</a></p>`
                            );
                            await sendEmail({ to: user.email, subject: 'Switched to Rozare Starter', html });
                        }

                        // WhatsApp notification to seller (fire-and-forget)
                        notifySeller(sub.seller.toString(), 'downgrade_scheduled', sellerTemplates.downgrade_scheduled()).catch(e =>
                            console.error('[whatsapp] seller downgrade notification failed:', e.message)
                        );

                        break;
                    } catch (downgradeErr) {
                        console.error('Auto-downgrade to Starter failed:', downgradeErr);
                        // Fall through to regular block behavior if Stripe fails
                    }
                }

                // Regular cancellation — block the store
                sub.status = 'blocked';
                sub.cancelledAt = now;
                sub.blockedAt = now;
                sub.blockedReason = 'Subscription cancelled. Subscribe again to reactivate your store.';
                sub.aiMessageLimit = -1;
                sub.metaAdsIncluded = false;
                sub.pendingDowngrade = { toPlan: null, scheduledAt: null };
                if (sub.founderOffer?.active) {
                    sub.founderOffer.active = false;
                    sub.founderOffer.forfeitedAt = now;
                }

                // Set 3-day bonus grace period if bonus is still active and not permanently expired
                if (sub.plan === 'starter' && sub.bonusFeaturesActive && !sub.bonusFeaturesExpiredPermanently && sub.bonusExpiryDate && now < sub.bonusExpiryDate) {
                    sub.bonusGraceDeadline = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
                    sub.bonusGraceNotificationSent = false;
                }

                await sub.save();

                // Block store + schedule subdomain removal in 7 days (if not purchased)
                {
                    const storeDoc = await Store.findOne({ seller: sub.seller });
                    if (storeDoc) {
                        storeDoc.isActive = false;
                        storeDoc.blockedAt = now;
                        const purchased = storeDoc.subdomainPurchase?.isPurchased &&
                            storeDoc.subdomainPurchase?.expiresAt &&
                            new Date(storeDoc.subdomainPurchase.expiresAt) > now;
                        if (!purchased) {
                            storeDoc.subdomainPurchase = {
                                ...(storeDoc.subdomainPurchase?.toObject?.() || {}),
                                removalScheduledAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
                            };
                        }
                        await storeDoc.save();
                    }
                }

            // Remove seller's products from all customer carts
            const Cart = require('../models/Cart');
            const Product = require('../models/Product');
            const sellerProducts = await Product.find({ seller: sub.seller }).select('_id');
            if (sellerProducts.length > 0) {
                const productIds = sellerProducts.map(p => p._id);
                await Cart.updateMany(
                    { 'cartItems.product': { $in: productIds } },
                    { $pull: { cartItems: { product: { $in: productIds } } } }
                );
            }

            // Send block notification with grace period info
            const Notification = require('../models/Notification');
            const hasGrace = sub.bonusGraceDeadline && now < sub.bonusGraceDeadline;
            const graceMsg = hasGrace
                ? ` You have 3 days to re-subscribe and keep your remaining bonus features.`
                : '';

            await Notification.create({
                user: sub.seller,
                title: 'Store blocked — subscription ended',
                body: `Your subscription has ended. Your store and products are hidden from the marketplace.${graceMsg} Subscribe again to reactivate.`,
                category: 'subscription',
                linkTo: '/seller-dashboard/subscription',
                source: 'system',
            }).catch(e => console.error('Subscription end notification failed:', e.message));

            // Send grace period email if applicable
            if (hasGrace) {
                const user = await User.findById(sub.seller);
                const store = await Store.findOne({ seller: sub.seller });
                const bonusDaysRemaining = Math.ceil((sub.bonusExpiryDate - now) / (1000 * 60 * 60 * 24));

                if (user?.email) {
                    const html = subscriptionEmailTemplate(
                        'You Have 3 Days to Keep Your Bonus Features!',
                        `<p>Hello ${user.username || 'Seller'},</p>
                        <p>Your subscription for <strong>"${store?.storeName || 'your store'}"</strong> has ended and your store is now blocked.</p>
                        <div class="highlight danger">
                            <strong>Important:</strong> You have <strong>3 days</strong> to re-subscribe and keep your bonus features for the remaining <strong>${bonusDaysRemaining} days</strong>.
                        </div>
                        <p>After 3 days, your bonus features will be <strong>permanently removed</strong> from the Starter plan. You would need to upgrade to Rozare Elite ($21.65/month) to get them back.</p>
                        <p><strong>Bonus features at risk:</strong></p>
                        <ul>
                            <li>Advanced analytics & growth insights</li>
                            <li>Smart tag AI generator for products</li>
                            <li>Featured product highlighting on the homepage</li>
                            <li>Priority support & early access to new features</li>
                            <li>Coupon & discount management system</li>
                            <li>Bulk discount & promotional tools</li>
                        </ul>
                        <p style="text-align:center"><a href="${process.env.FRONTEND_URL}/seller-dashboard/subscription" class="button">Re-subscribe Now — Keep Bonus Features</a></p>`
                    );
                    await sendEmail({ to: user.email, subject: '3 Days Left to Keep Your Bonus Features!', html });
                }
                sub.bonusGraceNotificationSent = true;
                await sub.save();
            }

                break;
            }

            case 'invoice.payment_failed': {
                const invoice = event.data.object;
                const sub = await SellerSubscription.findOne({ stripeCustomerId: invoice.customer });
                if (!sub) break;

                sub.status = 'past_due';
                await sub.save();

                const user = await User.findById(sub.seller);
                if (user?.email) {
                    const html = subscriptionEmailTemplate(
                        'Payment Failed',
                        `<p>Hello ${user.username || 'Seller'},</p>
                        <p>We were unable to process your payment for the ${sub.planName || 'Rozare'} Plan.</p>
                        <div class="highlight danger">
                            <strong>Action Required:</strong> Please update your payment method to avoid store suspension.
                        </div>
                        <p style="text-align:center"><a href="${process.env.FRONTEND_URL}/seller-dashboard/subscription" class="button">Update Payment</a></p>`
                    );
                    await sendEmail({ to: user.email, subject: 'Payment Failed - Action Required', html });
                }
                // WhatsApp notification to seller (fire-and-forget)
                notifySeller(sub.seller.toString(), 'payment_failed', sellerTemplates.payment_failed()).catch(e =>
                    console.error('[whatsapp] seller payment failed notification failed:', e.message)
                );
                break;
            }

            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                const sub = await SellerSubscription.findOne({ stripeCustomerId: invoice.customer });
                if (!sub) break;

                // Only handle subscription invoices (skip one-time payments)
                if (!invoice.subscription) break;

                const now = new Date();

                // Recover from past_due back to active
                if (sub.status === 'past_due') {
                    sub.status = 'active';
                    sub.currentPeriodStart = now;
                    sub.currentPeriodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
                    await sub.save();

                    const user = await User.findById(sub.seller);
                    if (user?.email) {
                        const html = subscriptionEmailTemplate(
                            'Payment Received — Subscription Active',
                            `<p>Hello ${user.username || 'Seller'},</p>
                            <p>Your payment has been processed successfully and your ${sub.planName || 'Rozare'} subscription is active again.</p>
                            <p>Thank you for continuing with Rozare!</p>`
                        );
                        await sendEmail({ to: user.email, subject: 'Payment Received — Subscription Active', html });
                    }

                    const Notification = require('../models/Notification');
                    await Notification.create({
                        user: sub.seller,
                        title: 'Subscription active again',
                        body: 'Your payment was successful. Your subscription is now active.',
                        category: 'subscription',
                        linkTo: '/seller-dashboard/subscription',
                        source: 'system',
                    }).catch(e => console.error('Payment success notification failed:', e.message));

                    // WhatsApp notification to seller (fire-and-forget)
                    notifySeller(sub.seller.toString(), 'payment_recovered', sellerTemplates.payment_recovered()).catch(e =>
                        console.error('[whatsapp] seller payment recovered notification failed:', e.message)
                    );
                } else if (sub.status === 'active' && invoice.billing_reason === 'subscription_cycle') {
                    // Regular monthly renewal — update period
                    sub.currentPeriodStart = now;
                    sub.currentPeriodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
                    sub.warningEmailSent = false; // reset for next cycle
                    await sub.save();
                }
                break;
            }
        }
    } catch (error) {
        console.error('Subscription webhook error:', error);
        throw error;
    }
};

// Cancel subscription
exports.cancelSubscription = async (req, res) => {
    try {
        const sellerId = req.user.id;
        const sub = await SellerSubscription.findOne({ seller: sellerId });

        if (!sub || !sub.stripeSubscriptionId) {
            return res.status(400).json({ msg: 'No active subscription found' });
        }

        // Cancel at period end
        await stripe.subscriptions.update(sub.stripeSubscriptionId, {
            cancel_at_period_end: true,
        });

        sub.cancelledAt = new Date();
        await sub.save();

        // Determine if bonus features are still active (for the warning message)
        const now = new Date();
        const hasBonusAtRisk = sub.plan === 'starter' && sub.bonusFeaturesActive && !sub.bonusFeaturesExpiredPermanently && sub.bonusExpiryDate && now < sub.bonusExpiryDate;
        const bonusDaysRemaining = hasBonusAtRisk ? Math.ceil((sub.bonusExpiryDate - now) / (1000 * 60 * 60 * 24)) : 0;

        res.json({
            msg: 'Subscription will be cancelled at the end of the current period.',
            founderWarning: sub.founderOffer?.active
                ? 'Your locked FIRST100 founder rate will be permanently forfeited when this subscription ends.'
                : null,
            bonusWarning: hasBonusAtRisk ? {
                message: 'Once your subscription period ends, you will have 3 days to re-subscribe and keep your bonus features. After 3 days, bonus features will be permanently removed from the Starter plan.',
                bonusDaysRemaining,
            } : null,
        });
    } catch (error) {
        console.error('Cancel subscription error:', error);
        res.status(500).json({ msg: 'Failed to cancel subscription' });
    }
};

// Upgrade from Starter to Elite (swap Stripe subscription)
exports.upgradeToElite = async (req, res) => {
    try {
        const sellerId = req.user.id;
        const includeMetaAdsRequested = Boolean(req.body?.includeMetaAds);
        const sub = await SellerSubscription.findOne({ seller: sellerId });

        if (!sub) {
            return res.status(400).json({ msg: 'No subscription found' });
        }

        const isStarterUpgrade = sub.plan === 'starter';
        const isElitePlanUpdate = sub.plan === 'elite';

        // Must be on an active Starter or Elite plan. Elite sellers use this
        // endpoint to add/remove the Meta ads add-on on the existing Stripe sub.
        if (!['active', 'free_period'].includes(sub.status) || (!isStarterUpgrade && !isElitePlanUpdate)) {
            return res.status(400).json({ msg: 'You can only update an active Starter or Elite plan.' });
        }
        if (isElitePlanUpdate && Boolean(sub.metaAdsIncluded) === includeMetaAdsRequested) {
            return res.status(400).json({
                msg: includeMetaAdsRequested
                    ? 'Meta ads are already included in your Elite plan.'
                    : 'Meta ads are already removed from your Elite plan.',
            });
        }

        if (!sub.stripeSubscriptionId) {
            return res.status(400).json({ msg: 'No active Stripe subscription found.' });
        }

        if (!stripe) {
            return res.status(500).json({ msg: 'Payment system not configured' });
        }

        // Get the current Stripe subscription to find the item
        const stripeSubscription = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
        const subscriptionItemId = stripeSubscription.items.data[0]?.id;

        if (!subscriptionItemId) {
            return res.status(500).json({ msg: 'Could not find subscription item to upgrade.' });
        }

        const {
            includeMetaAds,
            planName,
            unitAmount,
        } = buildPlanPricing(
            'elite',
            includeMetaAdsRequested,
            Boolean(sub.founderOffer?.active)
        );

        // Create a new price for Elite, with or without the optional Meta ads add-on.
        // Update the subscription item to the new price (immediate proration)
        const updatedSubscription = await stripe.subscriptions.update(sub.stripeSubscriptionId, {
            items: [{
                id: subscriptionItemId,
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: planName,
                        description: `${planName} - $${(unitAmount / 100).toFixed(2)}/month. All Starter + Bonus features permanently${includeMetaAds ? ' plus Meta ads add-on' : ''}. Cancel anytime.`,
                    },
                    unit_amount: unitAmount,
                    recurring: { interval: 'month' },
                },
            }],
            proration_behavior: 'create_prorations', // Charge difference immediately
            metadata: {
                sellerId: sellerId.toString(),
                plan: 'elite',
                includeMetaAds: includeMetaAds ? 'true' : 'false',
                metaAdsAddonCents: String(includeMetaAds ? META_ADS_ADDON_CENTS : 0),
                founderCouponCode: sub.founderOffer?.active ? FOUNDER_PROMOTION.code : '',
            },
            cancel_at_period_end: false, // Remove any pending cancellation
        });

        // Update local subscription record
        const now = new Date();
        sub.plan = 'elite';
        sub.planName = planName;
        sub.metaAdsIncluded = includeMetaAds;
        sub.bonusFeaturesActive = true;
        sub.bonusExpiryDate = null; // No expiry for Elite
        sub.bonusFeaturesExpiredPermanently = false;
        sub.bonusGraceDeadline = null;
        sub.cancelledAt = null; // Clear any pending cancellation
        sub.warningEmailSent = false;
        await sub.save();

        // Send confirmation email
        const user = await User.findById(sellerId);
        if (user?.email) {
            const emailTitle = isElitePlanUpdate ? 'Rozare Elite plan updated' : `Upgraded to ${planName}!`;
            const html = subscriptionEmailTemplate(
                emailTitle,
                `<p>Hello ${user.username || 'Seller'},</p>
                <p>Your <strong>${planName}</strong> subscription is now active.</p>
                <div class="highlight">
                    <strong>Plan:</strong> ${planName} ($${(unitAmount / 100).toFixed(2)}/month)<br/>
                    ${sub.founderOffer?.active ? '<strong>Founder rate:</strong> Preserved across your plan change<br/>' : ''}
                    <strong>Bonus Features:</strong> Now permanently included — they will never expire!<br/>
                    <strong>AI Chat:</strong> Unlimited seller AI chat<br/>
                    <strong>Meta ads add-on:</strong> ${includeMetaAds ? 'Included' : 'Not included'}
                </div>
                <p>All your bonus features are now permanently active. No more expiry timers!</p>
                <p style="text-align:center"><a href="${process.env.FRONTEND_URL}/seller-dashboard" class="button">Go to Dashboard</a></p>`
            );
            await sendEmail({ to: user.email, subject: emailTitle, html });
        }

        // WhatsApp notification to seller (fire-and-forget)
        if (!isElitePlanUpdate) {
            notifySeller(sellerId, 'upgrade_completed', sellerTemplates.upgrade_completed()).catch(e =>
                console.error('[whatsapp] seller upgrade completed notification failed:', e.message)
            );
        }

        // In-app notification
        const Notification = require('../models/Notification');
        await Notification.create({
            user: sellerId,
            title: isElitePlanUpdate ? 'Rozare Elite plan updated' : 'Upgraded to Rozare Elite!',
            body: isElitePlanUpdate
                ? `Your Rozare Elite billing is now ${planName}.`
                : 'Your plan has been upgraded to Rozare Elite. Bonus features are now permanently included.',
            category: 'subscription',
            linkTo: '/seller-dashboard/subscription',
            source: 'system',
        }).catch(e => console.error('Upgrade notification failed:', e.message));

        res.json({
            msg: isElitePlanUpdate
                ? 'Rozare Elite plan updated successfully.'
                : 'Successfully upgraded to Rozare Elite! Bonus features are now permanently included.',
            subscription: {
                plan: sub.plan,
                planName: sub.planName,
                metaAdsIncluded: sub.metaAdsIncluded,
                bonusFeaturesActive: sub.bonusFeaturesActive,
                bonusExpiryDate: sub.bonusExpiryDate,
                founderOffer: {
                    active: Boolean(sub.founderOffer?.active),
                    code: sub.founderOffer?.code || null,
                },
            },
        });
    } catch (error) {
        console.error('Upgrade to Elite error:', error);
        res.status(500).json({ msg: 'Failed to upgrade. Please try again.' });
    }
};

// Downgrade from Elite to Starter (Starter starts after Elite period ends)
exports.downgradeToStarter = async (req, res) => {
    try {
        const sellerId = req.user.id;
        const sub = await SellerSubscription.findOne({ seller: sellerId });

        if (!sub) {
            return res.status(400).json({ msg: 'No subscription found' });
        }

        // Must be on an active Elite plan
        if (!['active', 'free_period'].includes(sub.status) || sub.plan !== 'elite') {
            return res.status(400).json({ msg: 'You can only downgrade from an active Elite plan.' });
        }

        if (!sub.stripeSubscriptionId) {
            return res.status(400).json({ msg: 'No active Stripe subscription found.' });
        }

        if (sub.pendingDowngrade?.toPlan === 'starter') {
            return res.status(400).json({ msg: 'Downgrade to Starter is already scheduled.' });
        }

        if (!stripe) {
            return res.status(500).json({ msg: 'Payment system not configured' });
        }

        // Cancel Elite at period end (Stripe will fire customer.subscription.deleted)
        await stripe.subscriptions.update(sub.stripeSubscriptionId, {
            cancel_at_period_end: true,
        });

        // Schedule the downgrade
        sub.pendingDowngrade = {
            toPlan: 'starter',
            scheduledAt: new Date(),
        };
        sub.cancelledAt = new Date();
        await sub.save();

        // Determine bonus eligibility info for the downgrade
        // Using starterBonusPeriodUsed (permanent flag that doesn't reset on Elite upgrade)
        const willGetBonusOnDowngrade = !sub.starterBonusPeriodUsed;
        const bonusMsg = willGetBonusOnDowngrade
            ? 'You will get bonus features for 6 months with the Starter plan.'
            : 'Bonus features are no longer available with the Starter plan for your account (you already used your 6-month Starter bonus period).';
        const starterPricing = buildPlanPricing(
            'starter',
            false,
            Boolean(sub.founderOffer?.active)
        );
        const starterPriceLabel = `$${(starterPricing.unitAmount / 100).toFixed(2)}/month`;

        // Send email
        const user = await User.findById(sellerId);
        if (user?.email) {
            const html = subscriptionEmailTemplate(
                'Downgrade to Starter Scheduled',
                `<p>Hello ${user.username || 'Seller'},</p>
                <p>Your downgrade from <strong>Rozare Elite</strong> to <strong>Rozare Starter</strong> has been scheduled.</p>
                <div class="highlight">
                    <strong>What happens:</strong><br/>
                    - You keep Elite features until the current period ends<br/>
                    - After that, your plan will automatically switch to Starter (${starterPriceLabel})<br/>
                    ${sub.founderOffer?.active ? '- Your FIRST100 founder rate stays locked during this plan change<br/>' : ''}
                    - No free period (you already used yours)<br/>
                    - ${bonusMsg}
                </div>
                <p>Changed your mind? You can cancel the downgrade from your dashboard anytime before the period ends.</p>
                <p style="text-align:center"><a href="${process.env.FRONTEND_URL}/seller-dashboard/subscription" class="button">View Subscription</a></p>`
            );
            await sendEmail({ to: user.email, subject: 'Downgrade to Starter Scheduled', html });
        }

        // WhatsApp notification to seller (fire-and-forget)
        notifySeller(sellerId, 'downgrade_scheduled', sellerTemplates.downgrade_scheduled()).catch(e =>
            console.error('[whatsapp] seller downgrade scheduled notification failed:', e.message)
        );

        // In-app notification
        const Notification = require('../models/Notification');
        await Notification.create({
            user: sellerId,
            title: 'Downgrade to Starter scheduled',
            body: 'Your plan will switch to Rozare Starter after the current Elite period ends.',
            category: 'subscription',
            linkTo: '/seller-dashboard/subscription',
            source: 'system',
        }).catch(e => console.error('Downgrade notification failed:', e.message));

        res.json({
            msg: 'Downgrade scheduled. Your plan will switch to Starter after the current Elite period ends.',
            bonusInfo: bonusMsg,
        });
    } catch (error) {
        console.error('Downgrade to Starter error:', error);
        res.status(500).json({ msg: 'Failed to schedule downgrade.' });
    }
};

// Cancel a pending downgrade (keep Elite)
exports.cancelDowngrade = async (req, res) => {
    try {
        const sellerId = req.user.id;
        const sub = await SellerSubscription.findOne({ seller: sellerId });

        if (!sub || !sub.pendingDowngrade?.toPlan) {
            return res.status(400).json({ msg: 'No pending downgrade to cancel.' });
        }

        if (!stripe || !sub.stripeSubscriptionId) {
            return res.status(500).json({ msg: 'Payment system error.' });
        }

        // Undo the Stripe cancellation
        await stripe.subscriptions.update(sub.stripeSubscriptionId, {
            cancel_at_period_end: false,
        });

        sub.pendingDowngrade = { toPlan: null, scheduledAt: null };
        sub.cancelledAt = null;
        await sub.save();

        res.json({ msg: 'Downgrade cancelled. You will remain on Rozare Elite.' });
    } catch (error) {
        console.error('Cancel downgrade error:', error);
        res.status(500).json({ msg: 'Failed to cancel downgrade.' });
    }
};

// CRON job: Send warning emails 3 days before trial ends & block expired trials
exports.processTrialExpirations = async () => {
    try {
        const now = new Date();
        const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
        const Notification = require('../models/Notification');
        const Cart = require('../models/Cart');
        const Product = require('../models/Product');

        // ── 3-Day Warning: trials expiring soon ──
        const expiringSoon = await SellerSubscription.find({
            status: 'trial',
            trialEndDate: { $lte: threeDaysFromNow, $gt: now },
            warningEmailSent: false,
        });

        for (const sub of expiringSoon) {
            const user = await User.findById(sub.seller);
            const store = await Store.findOne({ seller: sub.seller });
            const daysLeft = Math.ceil((sub.trialEndDate - now) / (1000 * 60 * 60 * 24));

            if (user?.email) {
                const html = subscriptionEmailTemplate(
                    `⏰ Trial Expiring in ${daysLeft} Day${daysLeft > 1 ? 's' : ''}!`,
                    `<p>Hello ${user.username || 'Seller'},</p>
                    <p>Your free trial for <strong>"${store?.storeName || 'your store'}"</strong> expires in <strong>${daysLeft} day${daysLeft > 1 ? 's' : ''}</strong>.</p>
                    <div class="highlight">
                        <strong>What happens next?</strong><br/>
                        If you don't subscribe, your store and products will be hidden from the marketplace and you will no longer receive any orders.
                    </div>
                    <p><strong>Subscribe now</strong> and get:</p>
                    <ul>
                        <li>✅ First 30 days completely FREE</li>
                        <li>✅ Then $9.99/month — cancel anytime</li>
                        <li>✅ FIRST100 can reduce Starter to $5.99/month while founder spots remain</li>
                        <li>✅ Unlimited AI chat for sellers</li>
                        <li>✅ Bonus premium features for 6 months</li>
                        <li>✅ Uninterrupted store visibility</li>
                    </ul>
                    <p style="text-align:center"><a href="${process.env.FRONTEND_URL}/seller-dashboard/subscription" class="button">Subscribe Now — 30 Days Free</a></p>`
                );
                await sendEmail({ to: user.email, subject: `⏰ Trial Expiring in ${daysLeft} Day${daysLeft > 1 ? 's' : ''}!`, html });
            }

            // WhatsApp notification to seller (fire-and-forget)
            notifySeller(sub.seller.toString(), 'trial_expiring', sellerTemplates.trial_expiring(daysLeft)).catch(e =>
                console.error('[whatsapp] seller trial expiring notification failed:', e.message)
            );

            // Create in-app notification
            await Notification.create({
                user: sub.seller,
                title: `Trial expires in ${daysLeft} day${daysLeft > 1 ? 's' : ''}`,
                body: `Your free trial for "${store?.storeName || 'your store'}" expires in ${daysLeft} day${daysLeft > 1 ? 's' : ''}. Subscribe now to keep your store active.`,
                category: 'subscription',
                linkTo: '/seller-dashboard/subscription',
                source: 'system',
            }).catch(e => console.error('Warning notification failed:', e.message));

            sub.warningEmailSent = true;
            await sub.save();
        }

        // ── Block expired trials ──
        const expired = await SellerSubscription.find({
            status: 'trial',
            trialEndDate: { $lte: now },
        });

        for (const sub of expired) {
            sub.status = 'blocked';
            sub.blockedAt = now;
            sub.blockedReason = 'Trial period expired. Subscribe to reactivate your store.';
            await sub.save();

            {
                const storeDoc = await Store.findOne({ seller: sub.seller });
                if (storeDoc) {
                    storeDoc.isActive = false;
                    storeDoc.blockedAt = now;
                    const purchased = storeDoc.subdomainPurchase?.isPurchased &&
                        storeDoc.subdomainPurchase?.expiresAt &&
                        new Date(storeDoc.subdomainPurchase.expiresAt) > now;
                    if (!purchased) {
                        storeDoc.subdomainPurchase = {
                            ...(storeDoc.subdomainPurchase?.toObject?.() || {}),
                            removalScheduledAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
                        };
                    }
                    await storeDoc.save();
                }
            }

            // Send block notification email
            const user = await User.findById(sub.seller);
            const store = await Store.findOne({ seller: sub.seller });
            if (user?.email) {
                const html = subscriptionEmailTemplate(
                    '🚫 Store Blocked — Trial Expired',
                    `<p>Hello ${user.username || 'Seller'},</p>
                    <p>Your free trial for <strong>"${store?.storeName || 'your store'}"</strong> has expired.</p>
                    <div class="highlight">
                        <strong>Your store is now hidden</strong> from the marketplace. You will not receive any new orders until you subscribe.
                    </div>
                    <p>You can still log in and manage your products. Subscribe anytime to reactivate:</p>
                    <p style="text-align:center"><a href="${process.env.FRONTEND_URL}/seller-dashboard/subscription" class="button">Subscribe Now — 30 Days Free</a></p>`
                );
                await sendEmail({ to: user.email, subject: '🚫 Your Rozare Store Has Been Blocked — Subscribe to Reactivate', html });
            }

            // WhatsApp notification to seller (fire-and-forget)
            notifySeller(sub.seller.toString(), 'account_blocked', sellerTemplates.account_blocked(sub.blockedReason || '')).catch(e =>
                console.error('[whatsapp] seller account blocked notification failed:', e.message)
            );

            // Create in-app notification
            await Notification.create({
                user: sub.seller,
                title: 'Store blocked — trial expired',
                body: 'Your free trial has ended. Your store and products are hidden from the marketplace. Subscribe to reactivate.',
                category: 'subscription',
                linkTo: '/seller-dashboard/subscription',
                source: 'system',
            }).catch(e => console.error('Block notification failed:', e.message));

            // ── Cart cleanup: remove this seller's products from ALL customer carts ──
            const sellerProducts = await Product.find({ seller: sub.seller }).select('_id');
            if (sellerProducts.length > 0) {
                const productIds = sellerProducts.map(p => p._id);
                await Cart.updateMany(
                    { 'cartItems.product': { $in: productIds } },
                    { $pull: { cartItems: { product: { $in: productIds } } } }
                );
                console.log(`[subscription] Removed ${sellerProducts.length} products of seller ${sub.seller} from customer carts`);
            }
        }

        // ── Also check active subscriptions approaching end (for paid subscriptions) ──
        // This handles cases where subscription period is about to end
        const subsExpiringSoon = await SellerSubscription.find({
            status: { $in: ['active', 'free_period'] },
            cancelledAt: { $ne: null }, // Only cancelled subs that are still active until period end
            currentPeriodEnd: { $lte: threeDaysFromNow, $gt: now },
            warningEmailSent: false,
        });

        for (const sub of subsExpiringSoon) {
            const user = await User.findById(sub.seller);
            const store = await Store.findOne({ seller: sub.seller });
            const daysLeft = Math.ceil((sub.currentPeriodEnd - now) / (1000 * 60 * 60 * 24));

            if (user?.email) {
                const html = subscriptionEmailTemplate(
                    `⏰ Subscription Ending in ${daysLeft} Day${daysLeft > 1 ? 's' : ''}`,
                    `<p>Hello ${user.username || 'Seller'},</p>
                    <p>Your subscription for <strong>"${store?.storeName || 'your store'}"</strong> is ending in <strong>${daysLeft} day${daysLeft > 1 ? 's' : ''}</strong> because you cancelled it.</p>
                    <div class="highlight">
                        <strong>After expiry:</strong> Your store and products will be hidden from the marketplace.
                    </div>
                    ${sub.founderOffer?.active ? '<div class="highlight danger"><strong>Founder rate:</strong> Your FIRST100 price will be permanently forfeited when this subscription ends.</div>' : ''}
                    <p>Changed your mind? You can re-subscribe anytime from your dashboard.</p>
                    <p style="text-align:center"><a href="${process.env.FRONTEND_URL}/seller-dashboard/subscription" class="button">Re-subscribe Now</a></p>`
                );
                await sendEmail({ to: user.email, subject: `⏰ Subscription Ending in ${daysLeft} Day${daysLeft > 1 ? 's' : ''}`, html });
            }

            // WhatsApp notification to seller (fire-and-forget)
            notifySeller(sub.seller.toString(), 'subscription_ending', sellerTemplates.subscription_ending_soon(daysLeft)).catch(e =>
                console.error('[whatsapp] seller subscription ending notification failed:', e.message)
            );

            await Notification.create({
                user: sub.seller,
                title: `Subscription ending in ${daysLeft} day${daysLeft > 1 ? 's' : ''}`,
                body: `Your subscription for "${store?.storeName || 'your store'}" is ending soon. Your store will be hidden after expiry.`,
                category: 'subscription',
                linkTo: '/seller-dashboard/subscription',
                source: 'system',
            }).catch(e => console.error('Sub expiry warning notification failed:', e.message));

            sub.warningEmailSent = true;
            await sub.save();
        }

        console.log(`Trial check: ${expiringSoon.length} warnings, ${expired.length} blocked, ${subsExpiringSoon.length} sub-expiry warnings`);

        // ── Bonus features expiry warning (7 days before bonus expires) ──
        const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const bonusExpiringSoon = await SellerSubscription.find({
            status: { $in: ['active', 'free_period', 'past_due'] }, // Include past_due so they don't miss it
            plan: { $ne: 'elite' }, // Elite plan doesn't have bonus expiry
            bonusFeaturesActive: true,
            bonusExpiryDate: { $lte: sevenDaysFromNow, $gt: now },
            bonusExpiryWarningEmailSent: { $ne: true },
        });

        for (const sub of bonusExpiringSoon) {
            const user = await User.findById(sub.seller);
            const store = await Store.findOne({ seller: sub.seller });
            const daysLeft = Math.ceil((sub.bonusExpiryDate - now) / (1000 * 60 * 60 * 24));

            if (user?.email) {
                const html = subscriptionEmailTemplate(
                    `Bonus Features Expiring in ${daysLeft} Day${daysLeft > 1 ? 's' : ''}`,
                    `<p>Hello ${user.username || 'Seller'},</p>
                    <p>Your <strong>bonus features</strong> for "${store?.storeName || 'your store'}" will expire in <strong>${daysLeft} day${daysLeft > 1 ? 's' : ''}</strong>.</p>
                    <div class="highlight">
                        <strong>What you'll lose:</strong><br/>
                        - Advanced analytics & growth insights<br/>
                        - Smart tag AI generator for products<br/>
                        - Featured product highlighting on the homepage<br/>
                        - Priority support & early access to new features<br/>
                        - Coupon & discount management system<br/>
                        - Bulk discount & promotional tools
                    </div>
                    <p><strong>Want to keep these features?</strong> Upgrade to the <strong>Rozare Elite</strong> plan (${formatSubscriptionPriceForSeller('elite', sub)}) and get all bonus features permanently!</p>
                    <p style="text-align:center"><a href="${process.env.FRONTEND_URL}/seller-dashboard/subscription" class="button">Upgrade to Elite</a></p>`
                );
                await sendEmail({ to: user.email, subject: `Bonus Features Expiring in ${daysLeft} Day${daysLeft > 1 ? 's' : ''}`, html });
            }

            // WhatsApp notification to seller (fire-and-forget)
            notifySeller(sub.seller.toString(), 'bonus_expiring', sellerTemplates.bonus_expiring(daysLeft)).catch(e =>
                console.error('[whatsapp] seller bonus expiring notification failed:', e.message)
            );

            // In-app notification
            await Notification.create({
                user: sub.seller,
                title: `Bonus features expire in ${daysLeft} day${daysLeft > 1 ? 's' : ''}`,
                body: `Your bonus features will expire soon. Upgrade to Rozare Elite to keep them permanently.`,
                category: 'subscription',
                linkTo: '/seller-dashboard/subscription',
                source: 'system',
            }).catch(e => console.error('Bonus expiry warning notification failed:', e.message));

            sub.bonusExpiryWarningEmailSent = true;
            await sub.save();
        }

        // ── Permanently expire bonus features after 6 months for non-Elite subscribers ──
        const bonusExpired = await SellerSubscription.find({
            plan: { $ne: 'elite' },
            bonusFeaturesActive: true,
            bonusExpiryDate: { $lte: now },
        });

        for (const sub of bonusExpired) {
            sub.bonusFeaturesActive = false;
            sub.bonusFeaturesExpiredPermanently = true;
            await sub.save();

            const user = await User.findById(sub.seller);
            const store = await Store.findOne({ seller: sub.seller });

            // In-app notification
            await Notification.create({
                user: sub.seller,
                title: 'Bonus features have expired',
                body: 'Your 6-month bonus features have expired. Your Starter plan features remain active. Upgrade to Rozare Elite to get bonus features permanently.',
                category: 'subscription',
                linkTo: '/seller-dashboard/subscription',
                source: 'system',
            }).catch(e => console.error('Bonus expired notification failed:', e.message));

            if (user?.email) {
                const html = subscriptionEmailTemplate(
                    'Bonus Features Expired',
                    `<p>Hello ${user.username || 'Seller'},</p>
                    <p>Your <strong>bonus features</strong> for "${store?.storeName || 'your store'}" have now expired.</p>
                    <div class="highlight">
                        <strong>Your Starter plan is still active.</strong> You still have all core features like store visibility, payment processing, subdomain, and order management.
                    </div>
                    <p>To get bonus features back permanently, upgrade to <strong>Rozare Elite</strong> (${formatSubscriptionPriceForSeller('elite', sub)} with 45 days free when eligible):</p>
                    <ul>
                        <li>All Starter features included</li>
                        <li>Advanced analytics & growth insights</li>
                        <li>Smart tag AI generator for products</li>
                        <li>Featured product highlighting</li>
                        <li>Priority support & early access</li>
                        <li>Coupon & discount management</li>
                        <li>Bulk discount & promotional tools</li>
                    </ul>
                    <p style="text-align:center"><a href="${process.env.FRONTEND_URL}/seller-dashboard/subscription" class="button">Upgrade to Elite — 45 Days Free</a></p>`
                );
                await sendEmail({ to: user.email, subject: 'Bonus Features Expired — Upgrade to Keep Them', html });
            }

            // WhatsApp notification to seller (fire-and-forget)
            notifySeller(sub.seller.toString(), 'bonus_expired', sellerTemplates.bonus_expired()).catch(e =>
                console.error('[whatsapp] seller bonus expired notification failed:', e.message)
            );
        }

        if (bonusExpiringSoon.length > 0 || bonusExpired.length > 0) {
            console.log(`Bonus check: ${bonusExpiringSoon.length} warnings, ${bonusExpired.length} expired`);
        }

        // ── Process 3-day bonus grace period expirations ──
        const graceExpired = await SellerSubscription.find({
            status: 'blocked',
            plan: 'starter',
            bonusGraceDeadline: { $lte: now },
            bonusFeaturesExpiredPermanently: { $ne: true },
        });

        for (const sub of graceExpired) {
            sub.bonusFeaturesActive = false;
            sub.bonusFeaturesExpiredPermanently = true;
            sub.bonusGraceDeadline = null;
            await sub.save();

            const user = await User.findById(sub.seller);
            const store = await Store.findOne({ seller: sub.seller });

            // In-app notification
            await Notification.create({
                user: sub.seller,
                title: 'Bonus features permanently removed',
                body: 'The 3-day grace period has passed. Bonus features are no longer available with the Starter plan. Upgrade to Rozare Elite to get them back.',
                category: 'subscription',
                linkTo: '/seller-dashboard/subscription',
                source: 'system',
            }).catch(e => console.error('Grace expiry notification failed:', e.message));

            if (user?.email) {
                const html = subscriptionEmailTemplate(
                    'Bonus Features Permanently Removed',
                    `<p>Hello ${user.username || 'Seller'},</p>
                    <p>The 3-day grace period for <strong>"${store?.storeName || 'your store'}"</strong> has ended.</p>
                    <div class="highlight danger">
                        <strong>Bonus features are now permanently removed</strong> from the Starter plan for your account.
                    </div>
                    <p>If you re-subscribe to the Starter plan, you will only get the core Starter features. To get bonus features back, upgrade to <strong>Rozare Elite</strong> ($21.65/month with 45 days free when eligible).</p>
                    <p style="text-align:center"><a href="${process.env.FRONTEND_URL}/seller-dashboard/subscription" class="button">Upgrade to Elite — 45 Days Free</a></p>`
                );
                await sendEmail({ to: user.email, subject: 'Bonus Features Permanently Removed — Upgrade to Elite', html });
            }
        }

        if (graceExpired.length > 0) {
            console.log(`Grace period check: ${graceExpired.length} permanently expired`);
        }
    } catch (error) {
        console.error('Process trial expirations error:', error);
    }
};


// Admin: Get all seller subscriptions
exports.getAllSubscriptionsForAdmin = async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ msg: 'Access denied. Admin only.' });
        }

        const subscriptions = await SellerSubscription.find()
            .populate('seller', 'username email')
            .sort({ createdAt: -1 });

        const subscriptionsWithStores = await Promise.all(
            subscriptions.map(async (sub) => {
                const store = await Store.findOne({ seller: sub.seller._id }).select('storeName storeSlug');
                return {
                    ...sub.toObject(),
                    store: store ? { name: store.storeName, slug: store.storeSlug } : null
                };
            })
        );

        res.status(200).json({
            msg: 'All subscriptions fetched successfully',
            subscriptions: subscriptionsWithStores
        });
    } catch (error) {
        console.error('Get all subscriptions error:', error);
        res.status(500).json({ msg: 'Failed to fetch subscriptions' });
    }
};

// Returns true if a seller is entitled to bonus features (Trial OR active bonusFeaturesActive OR Elite plan).
// Used by feature-gating helpers like sellerHasFeaturedProducts (bonus-only features).
const isEntitledToBonus = (sub) => {
    if (!sub) return false;
    if (sub.status === 'trial') {
        return sub.trialEndDate ? new Date() < sub.trialEndDate : true;
    }
    // Elite plan always has bonus features
    if (sub.plan === 'elite' && ['active', 'free_period'].includes(sub.status)) {
        return true;
    }
    // Check permanent expiry for non-elite
    if (sub.bonusFeaturesExpiredPermanently) {
        return false;
    }
    if (sub.bonusFeaturesActive) {
        return sub.bonusExpiryDate ? new Date() < sub.bonusExpiryDate : true;
    }
    return false;
};

// Check if seller has an active subscription or trial (for starter-level features like WhatsApp)
const isSellerActive = (sub) => {
    if (!sub) return false;
    if (sub.status === 'trial') {
        return sub.trialEndDate ? new Date() < sub.trialEndDate : true;
    }
    // Any active subscription status means they have starter features
    if (['free_period', 'active', 'past_due'].includes(sub.status)) {
        return true;
    }
    return false;
};

// Gating helper: WhatsApp order auto-verification — included in Starter plan (and trial)
exports.sellerHasWhatsAppVerify = async (sellerId) => {
    try {
        if (!sellerId) return false;
        const sub = await SellerSubscription.findOne({ seller: sellerId });
        return isSellerActive(sub);
    } catch (err) {
        console.error('sellerHasWhatsAppVerify:', err.message);
        return false;
    }
};

// One-time migration: mark existing paid/previously-paid sellers as having used their free period
// This prevents them from getting another free period on re-subscription
exports.migrateHasUsedFreePeriod = async () => {
    try {
        // Any seller whose subscribedAt is set (means they subscribed at some point)
        // should be marked as having used their free period
        const result = await SellerSubscription.updateMany(
            {
                subscribedAt: { $exists: true, $ne: null },
                hasUsedFreePeriod: { $ne: true },
            },
            { $set: { hasUsedFreePeriod: true } }
        );
        if (result.modifiedCount > 0) {
            console.log(`[migration] Marked ${result.modifiedCount} existing sellers as hasUsedFreePeriod=true`);
        }

        // Also migrate: any seller who ever had Starter bonus (active or expired) gets starterBonusPeriodUsed=true
        // A seller qualifies if: they were ever on starter plan AND bonusExpiryDate was set
        const starterBonusResult = await SellerSubscription.updateMany(
            {
                $or: [
                    { plan: 'starter', bonusExpiryDate: { $exists: true, $ne: null } },
                    { bonusFeaturesExpiredPermanently: true },
                    { bonusGraceDeadline: { $exists: true, $ne: null } },
                ],
                starterBonusPeriodUsed: { $ne: true },
            },
            { $set: { starterBonusPeriodUsed: true } }
        );
        if (starterBonusResult.modifiedCount > 0) {
            console.log(`[migration] Marked ${starterBonusResult.modifiedCount} existing sellers as starterBonusPeriodUsed=true`);
        }
    } catch (error) {
        console.error('Migration hasUsedFreePeriod error:', error);
    }
};

// Undo a scheduled cancellation before Stripe ends the subscription.
exports.resumeSubscription = async (req, res) => {
    try {
        const sellerId = req.user.id;
        const sub = await SellerSubscription.findOne({ seller: sellerId });

        if (!sub || !sub.stripeSubscriptionId || !['active', 'free_period'].includes(sub.status)) {
            return res.status(400).json({ msg: 'No active subscription is available to resume.' });
        }
        if (sub.pendingDowngrade?.toPlan) {
            return res.status(400).json({
                msg: 'This is a scheduled plan change. Use Keep Elite to cancel the downgrade.',
            });
        }
        if (!sub.cancelledAt) {
            return res.status(400).json({ msg: 'This subscription is not scheduled for cancellation.' });
        }
        if (!stripe) {
            return res.status(503).json({ msg: 'Payment system not configured.' });
        }

        const stripeSubscription = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
        if (stripeSubscription.status === 'canceled') {
            return res.status(409).json({
                msg: 'This subscription has already ended and cannot be resumed.',
            });
        }

        await stripe.subscriptions.update(sub.stripeSubscriptionId, {
            cancel_at_period_end: false,
        });
        sub.cancelledAt = null;
        await sub.save();

        return res.json({
            msg: sub.founderOffer?.active
                ? 'Subscription resumed. Your FIRST100 founder rate remains locked.'
                : 'Subscription resumed successfully.',
            founderOfferActive: Boolean(sub.founderOffer?.active),
        });
    } catch (error) {
        console.error('Resume subscription error:', error);
        return res.status(500).json({ msg: 'Failed to resume subscription. Please try again.' });
    }
};

// One-time launch migration: sellers already paying the previous $5.99/$12.99
// rates keep those prices as a FIRST100 founder entitlement.
exports.migrateFounderPromotion = async () => {
    try {
        const result = await migrateLegacyFounderSubscribers();
        if (result.migrated > 0) {
            console.log(`[migration] Granted FIRST100 founder pricing to ${result.migrated} existing seller subscription(s)`);
        }
    } catch (error) {
        console.error('Founder promotion migration error:', error);
    }
};

