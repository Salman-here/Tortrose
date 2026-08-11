const WhatsAppOTP = require('../models/WhatsAppOTP');

const safeEqual = (left, right) => {
    if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
    let mismatch = 0;
    for (let index = 0; index < left.length; index += 1) {
        mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return mismatch === 0;
};

/**
 * Atomically increments a wrong-attempt counter or claims a correct OTP.
 * Parallel guesses cannot overwrite each other's increments, and only one
 * correct request can transition the proof from pending to verified.
 */
const verifyAndClaimWhatsAppOTP = async ({
    number,
    sellerId = null,
    otp,
    validAfter,
    maxAttempts = 5,
}) => {
    const baseFilter = {
        number,
        sellerId: sellerId || null,
        verified: false,
        createdAt: { $gte: validAfter },
    };
    const pending = await WhatsAppOTP.findOne(baseFilter).sort({ createdAt: -1 });
    if (!pending) return { status: 'missing' };
    if ((pending.attempts || 0) >= maxAttempts) return { status: 'locked' };

    if (!safeEqual(String(pending.otp), String(otp))) {
        const updated = await WhatsAppOTP.findOneAndUpdate(
            {
                _id: pending._id,
                verified: false,
                createdAt: { $gte: validAfter },
                attempts: { $lt: maxAttempts },
            },
            { $inc: { attempts: 1 } },
            { new: true }
        );
        if (!updated) return { status: 'missing' };
        return {
            status: updated.attempts >= maxAttempts ? 'locked' : 'invalid',
            attempts: updated.attempts,
            remaining: Math.max(0, maxAttempts - updated.attempts),
        };
    }

    const verifiedAt = new Date();
    const claimed = await WhatsAppOTP.findOneAndUpdate(
        {
            _id: pending._id,
            verified: false,
            createdAt: { $gte: validAfter },
            attempts: { $lt: maxAttempts },
        },
        { $set: { verified: true, verifiedAt } },
        { new: true }
    );
    return claimed ? { status: 'verified', record: claimed } : { status: 'missing' };
};

module.exports = { verifyAndClaimWhatsAppOTP };
