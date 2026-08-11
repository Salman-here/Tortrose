const crypto = require('crypto');
const SellerCheckoutClaim = require('../models/SellerCheckoutClaim');

const DEFAULT_CHECKOUT_CLAIM_MINUTES = 35;

const stableSerialize = (value) => {
    if (Array.isArray(value)) {
        return `[${value.map(stableSerialize).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => (
            `${JSON.stringify(key)}:${stableSerialize(value[key])}`
        )).join(',')}}`;
    }
    return JSON.stringify(value);
};

const fingerprintCheckoutRequest = (payload) => crypto
    .createHash('sha256')
    .update(stableSerialize(payload || {}))
    .digest('hex');

const isDuplicateKeyError = (error) => error?.code === 11000 || error?.code === 11001;

const claimSellerCheckout = async ({
    sellerId,
    flow,
    requestFingerprint,
    durationMinutes = DEFAULT_CHECKOUT_CLAIM_MINUTES,
}) => {
    if (!sellerId || !['subscription', 'subdomain'].includes(flow) || !requestFingerprint) {
        throw new Error('A seller, billing flow, and request fingerprint are required.');
    }

    // Await index creation before the first claim. The unique index is the
    // cross-process mutex; relying only on application timing is not safe.
    await SellerCheckoutClaim.init();

    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationMinutes * 60 * 1000);
    const token = crypto.randomUUID();

    try {
        const claim = await SellerCheckoutClaim.findOneAndUpdate(
            {
                seller: sellerId,
                flow,
                $or: [
                    { expiresAt: { $lte: now } },
                    { expiresAt: null },
                    { expiresAt: { $exists: false } },
                ],
            },
            {
                $set: {
                    seller: sellerId,
                    flow,
                    requestFingerprint,
                    token,
                    sessionId: '',
                    sessionUrl: '',
                    expiresAt,
                },
            },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );

        return { acquired: true, claim };
    } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
    }

    // Another request owns the still-live unique lease. Returning it lets an
    // identical retry reuse the already-created Checkout URL once attached.
    const claim = await SellerCheckoutClaim.findOne({ seller: sellerId, flow });
    if (!claim) {
        // A TTL deletion can race the duplicate-key read. Retry once against
        // the now-empty slot rather than exposing a spurious server error.
        return claimSellerCheckout({ sellerId, flow, requestFingerprint, durationMinutes });
    }
    return { acquired: false, claim };
};

const attachSellerCheckoutSession = async ({
    sellerId,
    flow,
    token,
    sessionId,
    sessionUrl,
}) => {
    const claim = await SellerCheckoutClaim.findOneAndUpdate(
        {
            seller: sellerId,
            flow,
            token,
            expiresAt: { $gt: new Date() },
        },
        { $set: { sessionId, sessionUrl } },
        { new: true }
    );

    if (!claim) {
        const error = new Error('The Checkout creation lease expired before the session could be secured.');
        error.code = 'CHECKOUT_CLAIM_LOST';
        throw error;
    }
    return claim;
};

const releaseSellerCheckoutClaim = async ({ sellerId, flow, token, sessionId }) => {
    if (!sellerId || !flow) return false;
    const filter = { seller: sellerId, flow };
    if (token && sessionId) filter.$or = [{ token }, { sessionId }];
    else if (token) filter.token = token;
    else if (sessionId) filter.sessionId = sessionId;
    else return false;

    const result = await SellerCheckoutClaim.deleteOne(filter);
    return result.deletedCount > 0;
};

const checkoutClaimRetryAfterSeconds = (claim) => Math.max(
    1,
    Math.ceil((new Date(claim?.expiresAt || 0).getTime() - Date.now()) / 1000)
);

module.exports = {
    DEFAULT_CHECKOUT_CLAIM_MINUTES,
    fingerprintCheckoutRequest,
    claimSellerCheckout,
    attachSellerCheckoutSession,
    releaseSellerCheckoutClaim,
    checkoutClaimRetryAfterSeconds,
};
