const crypto = require('crypto');
const WhatsAppOTPRateEvent = require('../models/WhatsAppOTPRateEvent');

const WINDOW_MS = 60 * 60 * 1000;
const PER_NUMBER_LIMIT = 3;
const GLOBAL_LIMIT = 200;

const duplicateKey = (error) => error?.code === 11000 || error?.code === 11001;

const reserveScopeSlot = async ({ scope, limit, number, sellerId }) => {
    await WhatsAppOTPRateEvent.init();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + WINDOW_MS);
    const startSlot = crypto.randomInt(0, limit);

    for (let offset = 0; offset < limit; offset += 1) {
        const slot = (startSlot + offset) % limit;
        const token = crypto.randomUUID();
        try {
            const event = await WhatsAppOTPRateEvent.findOneAndUpdate(
                {
                    scope,
                    slot,
                    $or: [
                        { expiresAt: { $lte: now } },
                        { expiresAt: null },
                        { expiresAt: { $exists: false } },
                    ],
                },
                {
                    $set: {
                        scope,
                        slot,
                        token,
                        number,
                        sellerId: sellerId || null,
                        createdAt: now,
                        expiresAt,
                    },
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
            return event;
        } catch (error) {
            if (!duplicateKey(error)) throw error;
        }
    }
    return null;
};

const reserveWhatsAppOtpSend = async ({
    number,
    sellerId = null,
    perNumberLimit = PER_NUMBER_LIMIT,
    globalLimit = GLOBAL_LIMIT,
}) => {
    const numberLease = await reserveScopeSlot({
        scope: `number:${number}`,
        limit: perNumberLimit,
        number,
        sellerId,
    });
    if (!numberLease) {
        const error = new Error('Too many verification attempts for this number. Please try again in an hour.');
        error.code = 'WHATSAPP_OTP_NUMBER_RATE_LIMIT';
        throw error;
    }

    const globalLease = await reserveScopeSlot({
        scope: 'global',
        limit: globalLimit,
        number,
        sellerId,
    });
    if (!globalLease) {
        await WhatsAppOTPRateEvent.deleteOne({ _id: numberLease._id, token: numberLease.token });
        const error = new Error('Verification service is busy. Please try again in a few minutes.');
        error.code = 'WHATSAPP_OTP_GLOBAL_RATE_LIMIT';
        throw error;
    }

    return { numberLease, globalLease };
};

const releaseWhatsAppOtpSend = async (reservation) => {
    const leases = [reservation?.numberLease, reservation?.globalLease].filter(Boolean);
    if (!leases.length) return;
    await WhatsAppOTPRateEvent.deleteMany({
        $or: leases.map(lease => ({ _id: lease._id, token: lease.token })),
    });
};

module.exports = {
    WINDOW_MS,
    PER_NUMBER_LIMIT,
    GLOBAL_LIMIT,
    reserveWhatsAppOtpSend,
    releaseWhatsAppOtpSend,
};
