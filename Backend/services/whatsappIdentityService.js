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

async function findWhatsAppIdentityConflict(digits, { channel, userId = null, adminNumberId = null } = {}) {
    const normalized = normalizePhoneDigits(digits);
    if (!normalized) return null;

    const checks = [];
    if (channel !== 'admin') {
        checks.push(
            AdminWhatsAppNumber.findOne({
                number: normalized,
                isActive: true,
                ...(adminNumberId ? { _id: { $ne: adminNumberId } } : {}),
            }).select('_id number addedBy').lean()
                .then(record => record ? { kind: 'admin', record } : null)
        );
    }
    if (channel !== 'seller') {
        // Cross-role reuse is ambiguous even when the same User document owns
        // both fields, so do not exclude userId here.
        checks.push(
            User.findOne(verifiedSellerNumberQuery(
                normalized,
                null,
                // A demoted seller may retain legacy verified seller fields.
                // Keep that number ambiguous instead of allowing a different
                // administrator's authorization record to elevate it.
                { role: channel === 'admin' ? { $ne: 'admin' } : 'seller' }
            )).select('_id role').lean()
                .then(record => record ? { kind: 'seller', record } : null)
        );
    } else {
        checks.push(
            User.findOne(verifiedSellerNumberQuery(normalized, userId)).select('_id role').lean()
                .then(record => record ? { kind: 'seller', record } : null)
        );
    }
    if (channel !== 'buyer') {
        checks.push(
            User.findOne(verifiedBuyerNumberQuery(normalized)).select('_id role').lean()
                .then(record => record ? { kind: 'buyer', record } : null)
        );
    } else {
        checks.push(
            User.findOne(verifiedBuyerNumberQuery(normalized, userId)).select('_id role').lean()
                .then(record => record ? { kind: 'buyer', record } : null)
        );
    }

    const conflicts = await Promise.all(checks);
    return conflicts.find(Boolean) || null;
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
