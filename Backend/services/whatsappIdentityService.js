'use strict';

const User = require('../models/User');
const AdminWhatsAppNumber = require('../models/AdminWhatsAppNumber');
const { normalizePhoneDigits } = require('../utils/phoneNumber');

const legacyFormattedNumber = (digits) => {
    const normalized = normalizePhoneDigits(digits);
    return new RegExp(`^[^0-9]*${normalized.split('').join('[^0-9]*')}[^0-9]*$`);
};

const verifiedSellerNumberQuery = (digits, excludeUserId = null, { role = 'seller' } = {}) => ({
    ...(role ? { role } : {}),
    'sellerInfo.whatsappVerified': true,
    ...(excludeUserId ? { _id: { $ne: excludeUserId } } : {}),
    $or: [
        { 'sellerInfo.whatsappDigits': normalizePhoneDigits(digits) },
        { 'sellerInfo.whatsappNumber': legacyFormattedNumber(digits) },
    ],
});

const verifiedBuyerNumberQuery = (digits, excludeUserId = null) => ({
    'whatsappInfo.verified': true,
    'whatsappInfo.number': legacyFormattedNumber(digits),
    ...(excludeUserId ? { _id: { $ne: excludeUserId } } : {}),
});

const useSession = (query, session) => (
    session && typeof query?.session === 'function' ? query.session(session) : query
);

async function findWhatsAppIdentityConflict(
    digits,
    { channel, userId = null, adminNumberId = null, session = null } = {}
) {
    const normalized = normalizePhoneDigits(digits);
    if (!normalized) return null;

    const checks = [];
    const addCheck = (kind, query) => {
        checks.push({ kind, query: useSession(query, session).lean() });
    };
    if (channel !== 'admin') {
        const query = AdminWhatsAppNumber.findOne({
                number: normalized,
                isActive: true,
                ...(adminNumberId ? { _id: { $ne: adminNumberId } } : {}),
            }).select('_id number addedBy');
        addCheck('admin', query);
    }
    if (channel !== 'seller') {
        // Cross-role reuse is ambiguous even when the same User document owns
        // both fields, so do not exclude userId here.
        const query = User.findOne(verifiedSellerNumberQuery(
                normalized,
                null,
                // A demoted seller may retain legacy verified seller fields.
                // Keep that number ambiguous instead of allowing a different
                // administrator's authorization record to elevate it.
                { role: channel === 'admin' ? { $ne: 'admin' } : 'seller' }
            )).select('_id role');
        addCheck('seller', query);
    } else {
        const query = User.findOne(verifiedSellerNumberQuery(normalized, userId)).select('_id role');
        addCheck('seller', query);
    }
    if (channel !== 'buyer') {
        const query = User.findOne(verifiedBuyerNumberQuery(normalized)).select('_id role');
        addCheck('buyer', query);
    } else {
        const query = User.findOne(verifiedBuyerNumberQuery(normalized, userId)).select('_id role');
        addCheck('buyer', query);
    }

    // MongoDB transactions do not support parallel operations on the same
    // session. Run these authority checks in order when onboarding supplies a
    // session, otherwise retain the lower-latency parallel read path.
    if (session) {
        for (const check of checks) {
            const record = await check.query;
            if (record) return { kind: check.kind, record };
        }
        return null;
    }

    const records = await Promise.all(checks.map(check => check.query));
    const matchIndex = records.findIndex(Boolean);
    return matchIndex === -1
        ? null
        : { kind: checks[matchIndex].kind, record: records[matchIndex] };
}

const conflictMessage = (conflict) => {
    if (conflict?.kind === 'admin') {
        return 'This number is reserved for an administrator. Remove it from Admin WhatsApp Numbers before linking it to another account.';
    }
    return 'This WhatsApp number is already verified for another account or role. Unlink it there before continuing.';
};

module.exports = {
    conflictMessage,
    findWhatsAppIdentityConflict,
    legacyFormattedNumber,
    verifiedBuyerNumberQuery,
    verifiedSellerNumberQuery,
};
