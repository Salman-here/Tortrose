/**
 * Expo Push Notification helper.
 * Sends pushes via the Expo push API and prunes invalid tokens from User docs.
 * No SDK dependency — uses fetch (Node 18+).
 */

const crypto = require('crypto');
const User = require('../models/User');
const ExpoPushTokenRegistration = require('../models/ExpoPushTokenRegistration');

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
const CHUNK_SIZE = 100;

const isValidExpoToken = (t) =>
    typeof t === 'string'
    && /^(?:ExponentPushToken|ExpoPushToken)\[[^\]\s]+\]$/.test(t);

const hashPushToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * ExpoPushTokenRegistration is the delivery authority. User.expoPushTokens is
 * only an index of raw addresses needed by Expo. This makes split ownership
 * writes fail closed: a raw token on an old account is never deliverable after
 * the registry rotates or is revoked.
 */
async function filterAuthoritativeTokens(tokens, {
    recipientUserId = null,
} = {}) {
    const validTokens = [...new Set((tokens || []).filter(isValidExpoToken))];
    if (!validTokens.length) return [];

    // Every delivery is scoped to exactly one account. Accepting an
    // unscoped token (or a role-wide list of owners) makes it possible for a
    // stale raw token index to authorize a notification intended for a
    // different account in the same audience.
    const ownerId = recipientUserId ? String(recipientUserId) : null;
    if (!ownerId) return [];

    const tokenByHash = new Map(validTokens.map(token => [hashPushToken(token), token]));

    const registrations = await ExpoPushTokenRegistration.find({
        tokenHash: { $in: [...tokenByHash.keys()] },
        revokedAt: null,
        user: ownerId,
    }).select('tokenHash user').lean();
    const authorizedHashes = new Set(registrations.map(registration => registration.tokenHash));

    return validTokens.filter(token => authorizedHashes.has(hashPushToken(token)));
}

const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
};

/**
 * Send a push to one or more Expo tokens.
 * @param {string[]} tokens
 * @param {{ title: string, body: string, data?: object, channelId?: string, sound?: 'default'|null, badge?: number }} payload
 * @returns {Promise<{ invalidTokens: string[] }>}
 */
async function sendExpoPush(tokens, payload, ownershipScope = {}) {
    const valid = await filterAuthoritativeTokens(tokens, ownershipScope);
    if (!valid.length) return { invalidTokens: [], sentCount: 0 };

    const recipientUserId = String(ownershipScope.recipientUserId);
    const scopedData = {
        ...(payload.data || {}),
        // The authority scope wins over any caller-provided hint.
        recipientUserId,
    };

    const messages = valid.map((to) => ({
        to,
        title: payload.title,
        body: payload.body,
        data: scopedData,
        sound: payload.sound === null ? null : 'default',
        channelId: payload.channelId || 'general',
        priority: 'high',
        ...(payload.badge != null ? { badge: payload.badge } : {}),
    }));

    const invalidTokens = [];

    for (const batch of chunk(messages, CHUNK_SIZE)) {
        try {
            const res = await fetch(EXPO_URL, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Accept-encoding': 'gzip, deflate',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(batch),
            });
            const json = await res.json().catch(() => ({}));
            const tickets = Array.isArray(json?.data) ? json.data : [];
            tickets.forEach((ticket, i) => {
                if (ticket?.status === 'error') {
                    const errCode = ticket?.details?.error;
                    if (errCode === 'DeviceNotRegistered' || errCode === 'InvalidCredentials') {
                        invalidTokens.push(batch[i].to);
                    }
                    console.warn('[expoPush] error ticket:', ticket?.message, errCode);
                }
            });
        } catch (err) {
            console.error('[expoPush] batch send failed:', err.message);
        }
    }

    return { invalidTokens, sentCount: valid.length };
}

/**
 * Send a push to a specific user (looks up tokens by user id).
 * Auto-prunes invalid tokens from the user document.
 */
async function sendPushToUser(userId, payload) {
    if (!userId) return;
    try {
        const user = await User.findById(userId).select('expoPushTokens role');
        if (!user?.expoPushTokens?.length) return;
        const scopedPayload = {
            ...payload,
            data: {
                ...(payload?.data || {}),
                recipientUserId: String(user._id),
                targetRole: user.role,
            },
        };
        const { invalidTokens } = await sendExpoPush(user.expoPushTokens, scopedPayload, {
            recipientUserId: user._id,
        });
        if (invalidTokens.length) {
            await User.updateOne(
                { _id: userId },
                { $pull: { expoPushTokens: { $in: invalidTokens } } }
            );
        }
    } catch (err) {
        console.error('[expoPush] sendPushToUser failed:', err.message);
    }
}

module.exports = {
    filterAuthoritativeTokens,
    hashPushToken,
    isValidExpoToken,
    sendExpoPush,
    sendPushToUser,
};
