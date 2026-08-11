const crypto = require('crypto');
const WhatsAppOTP = require('../models/WhatsAppOTP');
const WhatsAppConfig = require('../models/WhatsAppConfig');
const User = require('../models/User');
const sellerEvolutionClient = require('../services/whatsapp/sellerEvolutionClient');
const { verifyAndClaimWhatsAppOTP } = require('../services/whatsappOtpVerificationService');
const {
    reserveWhatsAppOtpSend,
    releaseWhatsAppOtpSend,
} = require('../services/whatsappOtpRateLimitService');
const {
    normalizePhoneDigits,
    toE164PhoneNumber,
    sellerPhoneConflictQuery,
} = require('../utils/phoneNumber');
const {
    conflictMessage,
    findWhatsAppIdentityConflict,
} = require('../services/whatsappIdentityService');

// Configuration constants
const OTP_EXPIRY_MINUTES = 2;         // How long a code is valid for ENTRY
const VERIFIED_EXPIRY_MINUTES = 10;   // How long a verified record is valid for CONSUMPTION during signup
const MAX_ATTEMPTS = 5;               // Wrong OTP tries before the record is locked
const WHATSAPP_CHANGE_COOLDOWN_DAYS = 30;

// Generate a 6-digit OTP
const generateOTP = () => {
    return crypto.randomInt(100000, 1000000).toString();
};

// Clean number to digits only
const cleanNumber = normalizePhoneDigits;

const getWhatsAppChangeCooldown = (user, now = new Date()) => {
    const lastChange = user?.sellerInfo?.lastWhatsAppChange;
    if (!lastChange) return null;

    const nextChangeAt = new Date(new Date(lastChange).getTime()
        + WHATSAPP_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
    if (!Number.isFinite(nextChangeAt.getTime()) || nextChangeAt <= now) return null;

    return {
        daysLeft: Math.max(1, Math.ceil((nextChangeAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))),
        nextChangeAt,
    };
};

const isChangingVerifiedWhatsAppNumber = (user, digits) => {
    if (user?.role !== 'seller' || !user?.sellerInfo?.whatsappVerified) return false;
    const currentDigits = cleanNumber(user.sellerInfo.whatsappNumber);
    return Boolean(currentDigits && currentDigits !== digits);
};

/**
 * Helper (internal): Consume a verified OTP record during signup/becomeSeller.
 * Returns true if a valid, recently-verified record exists for the given number,
 * and deletes it to prevent replay. Returns false otherwise.
 *
 * This is how the backend PROVES the phone was actually verified via OTP,
 * without trusting a client-sent `whatsappVerified` boolean.
 */
exports.consumeVerifiedWhatsAppNumber = async (whatsappNumber, sellerId = null) => {
    if (!whatsappNumber) return false;
    const digits = cleanNumber(whatsappNumber);
    if (!digits) return false;

    const identityConflict = await findWhatsAppIdentityConflict(digits, {
        channel: 'seller',
        userId: sellerId,
    });
    if (identityConflict) {
        await WhatsAppOTP.deleteMany({ number: digits, sellerId: sellerId || null });
        return false;
    }

    const cutoff = new Date(Date.now() - VERIFIED_EXPIRY_MINUTES * 60 * 1000);
    const record = await WhatsAppOTP.findOneAndDelete({
        number: digits,
        sellerId: sellerId || null,
        verified: true,
        verifiedAt: { $gte: cutoff },
    }).sort({ verifiedAt: -1 });

    return !!record;
};

/**
 * POST /api/seller-whatsapp/send-otp
 * Send a WhatsApp OTP for verification.
 * Body: { whatsappNumber } — E.164 format like "+923028588506"
 *
 * Rate-limited: 3 per number per hour, plus a global 200/hour circuit breaker.
 */
exports.sendWhatsAppOTP = async (req, res) => {
    try {
        const { whatsappNumber } = req.body;

        if (!whatsappNumber) {
            return res.status(400).json({ success: false, msg: 'WhatsApp number is required' });
        }

        const digits = cleanNumber(whatsappNumber);
        if (!digits || digits.length < 10) {
            return res.status(400).json({ success: false, msg: 'Invalid WhatsApp number format' });
        }

        // Check that the seller WhatsApp instance is connected
        const cfg = await WhatsAppConfig.findOne({ singletonKey: 'seller' });
        if (!cfg || cfg.status !== 'connected') {
            return res.status(503).json({
                success: false,
                msg: 'WhatsApp verification service is temporarily unavailable. Please try again later.'
            });
        }

        if (!sellerEvolutionClient.isConfigured()) {
            return res.status(503).json({
                success: false,
                msg: 'WhatsApp service is not configured. Please contact support.'
            });
        }

        // Check ownership before sending. A number owned by any other seller is
        // never eligible, even if legacy data contains duplicate number rows.
        const requestingUserId = req.user?.id || req.user?._id || null;
        const requestingUser = requestingUserId
            ? await User.findById(requestingUserId).select('role sellerInfo')
            : null;
        const identityConflict = await findWhatsAppIdentityConflict(digits, {
            channel: 'seller',
            userId: requestingUserId,
        });
        if (identityConflict) {
            return res.status(409).json({
                success: false,
                msg: conflictMessage(identityConflict),
            });
        }
        const conflictingSeller = await User.findOne(
            sellerPhoneConflictQuery(digits, requestingUserId)
        ).select('_id');
        if (conflictingSeller) {
            return res.status(409).json({
                success: false,
                msg: 'This number is already associated with an existing seller account. Please use a different WhatsApp number.'
            });
        }

        // The authenticated seller may verify their own legacy/unverified
        // current number. Already-verified current numbers remain blocked.
        const currentDigits = cleanNumber(requestingUser?.sellerInfo?.whatsappNumber);
        if (
            requestingUser?.role === 'seller'
            && requestingUser?.sellerInfo?.whatsappVerified
            && currentDigits === digits
        ) {
            return res.status(409).json({
                success: false,
                msg: 'This is already your current WhatsApp number.'
            });
        }

        if (isChangingVerifiedWhatsAppNumber(requestingUser, digits)) {
            const cooldown = getWhatsAppChangeCooldown(requestingUser);
            if (cooldown) {
                return res.status(429).json({
                    success: false,
                    msg: `You can only change your WhatsApp number once every 30 days. Please try again in ${cooldown.daysLeft} day${cooldown.daysLeft === 1 ? '' : 's'}.`,
                    daysLeft: cooldown.daysLeft,
                    nextWhatsAppChangeAt: cooldown.nextChangeAt.toISOString(),
                });
            }
        }

        // Atomically reserve rolling one-hour slots for both this number and
        // the global circuit breaker. Parallel requests cannot overrun the cap.
        let rateReservation;
        try {
            rateReservation = await reserveWhatsAppOtpSend({
                number: digits,
                sellerId: requestingUserId,
            });
        } catch (rateError) {
            if (rateError?.code === 'WHATSAPP_OTP_GLOBAL_RATE_LIMIT') {
                console.warn('[sellerWhatsapp] Global OTP rate limit hit — possible abuse');
                return res.status(429).json({
                    success: false,
                    msg: 'Verification service is busy. Please try again in a few minutes.'
                });
            }
            if (rateError?.code === 'WHATSAPP_OTP_NUMBER_RATE_LIMIT') {
                return res.status(429).json({ success: false, msg: rateError.message });
            }
            throw rateError;
        }

        // Check if number is on WhatsApp. If the check itself fails (null),
        // we bail rather than risk messaging invalid numbers and burning quota.
        let isOnWhatsApp;
        try {
            isOnWhatsApp = await sellerEvolutionClient.checkWhatsAppNumber(digits);
        } catch (checkError) {
            await releaseWhatsAppOtpSend(rateReservation).catch(() => null);
            throw checkError;
        }
        if (isOnWhatsApp === false) {
            await releaseWhatsAppOtpSend(rateReservation).catch(() => null);
            return res.status(400).json({
                success: false,
                msg: 'This number is not registered on WhatsApp. Please use a valid WhatsApp number.'
            });
        }
        if (isOnWhatsApp === null) {
            await releaseWhatsAppOtpSend(rateReservation).catch(() => null);
            return res.status(503).json({
                success: false,
                msg: 'Unable to verify the number with WhatsApp right now. Please try again shortly.'
            });
        }

        // Generate OTP and send it FIRST; persist only on success to avoid
        // burning the per-hour quota when the gateway fails.
        const otp = generateOTP();
        const message = `*Rozare Verification*\n\nYour verification code is: *${otp}*\n\nThis code expires in ${OTP_EXPIRY_MINUTES} minutes.\nDo not share this code with anyone.`;

        try {
            await sellerEvolutionClient.sendText(digits, message);
        } catch (sendErr) {
            console.error('[sellerWhatsapp] sendText failed:', sendErr.message);
            await releaseWhatsAppOtpSend(rateReservation).catch(() => null);
            return res.status(502).json({
                success: false,
                msg: 'Failed to send verification code. Please try again.'
            });
        }

        await WhatsAppOTP.create({
            number: digits,
            otp,
            sellerId: requestingUserId,
            attempts: 0,
            verified: false,
        });

        return res.status(200).json({
            success: true,
            msg: 'Verification code sent to your WhatsApp'
        });
    } catch (error) {
        console.error('[sellerWhatsapp] sendWhatsAppOTP error:', error.message);
        return res.status(500).json({
            success: false,
            msg: 'Failed to send verification code. Please try again.'
        });
    }
};

/**
 * POST /api/seller-whatsapp/verify-otp
 * Verify a WhatsApp OTP.
 * Body: { whatsappNumber, otp }
 *
 * On success:
 *   - If authenticated: updates User.sellerInfo.whatsappNumber + whatsappVerified.
 *   - If unauthenticated (signup flow): marks the OTP record as verified,
 *     which the subsequent registration endpoint will consume as proof.
 *
 * Brute-force protection: max 5 wrong attempts per OTP record; after that
 * the record is force-expired.
 */
exports.verifyWhatsAppOTP = async (req, res) => {
    try {
        const { whatsappNumber, otp } = req.body;

        if (!whatsappNumber || !otp) {
            return res.status(400).json({ success: false, msg: 'WhatsApp number and OTP are required' });
        }

        const digits = cleanNumber(whatsappNumber);
        const otpStr = String(otp).trim();
        if (!digits || !/^\d{6}$/.test(otpStr)) {
            return res.status(400).json({ success: false, msg: 'Invalid WhatsApp number or code format' });
        }

        // Atomically claim a correct OTP or increment a wrong-attempt counter.
        const otpExpiry = new Date(Date.now() - OTP_EXPIRY_MINUTES * 60 * 1000);
        const requestingUserId = req.user?.id || req.user?._id || null;
        const verification = await verifyAndClaimWhatsAppOTP({
            number: digits,
            sellerId: requestingUserId || null,
            otp: otpStr,
            validAfter: otpExpiry,
            maxAttempts: MAX_ATTEMPTS,
        });

        if (verification.status === 'missing') {
            return res.status(400).json({
                success: false,
                msg: 'No pending verification. Please request a new code.'
            });
        }

        if (verification.status === 'locked') {
            return res.status(429).json({
                success: false,
                msg: 'Too many incorrect attempts. Please request a new code.'
            });
        }

        if (verification.status === 'invalid') {
            const remaining = verification.remaining;
            return res.status(400).json({
                success: false,
                msg: remaining > 0
                    ? `Invalid verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
                    : 'Too many incorrect attempts. Please request a new code.',
            });
        }

        // Correct OTP — mark verified (but do NOT delete yet)
        const otpRecord = verification.record;

        // Recheck after the code is claimed. Another account or an admin can
        // reserve the number while the OTP is in flight.
        const identityConflict = await findWhatsAppIdentityConflict(digits, {
            channel: 'seller',
            userId: requestingUserId,
        });
        if (identityConflict) {
            await WhatsAppOTP.deleteOne({ _id: otpRecord._id });
            return res.status(409).json({
                success: false,
                msg: conflictMessage(identityConflict),
            });
        }

        // For existing sellers updating WhatsApp settings: immediately update
        // their user record and delete the OTP record. For buyers becoming
        // sellers, keep the verified OTP record so the seller-registration
        // endpoint can consume it as server-side proof.
        const sellerId = requestingUserId;
        if (sellerId) {
            const user = await User.findById(sellerId).select('role sellerInfo updatedAt');
            if (user?.role === 'seller') {
                const conflictingSeller = await User.findOne(
                    sellerPhoneConflictQuery(digits, sellerId)
                ).select('_id');
                if (conflictingSeller) {
                    await WhatsAppOTP.deleteOne({ _id: otpRecord._id });
                    return res.status(409).json({
                        success: false,
                        msg: 'This number is now associated with another seller account. Please use a different number.',
                    });
                }

                const isNumberChange = isChangingVerifiedWhatsAppNumber(user, digits);
                if (isNumberChange) {
                    const cooldown = getWhatsAppChangeCooldown(user);
                    if (cooldown) {
                        await WhatsAppOTP.deleteOne({ _id: otpRecord._id });
                        return res.status(429).json({
                            success: false,
                            msg: `You can only change your WhatsApp number once every 30 days. Please try again in ${cooldown.daysLeft} day${cooldown.daysLeft === 1 ? '' : 's'}.`,
                            daysLeft: cooldown.daysLeft,
                            nextWhatsAppChangeAt: cooldown.nextChangeAt.toISOString(),
                        });
                    }
                }

                // Store one canonical identity. The unique normalized field is
                // the final atomic guard if two sellers race for the same number.
                const storedNumber = toE164PhoneNumber(digits);
                const update = {
                    'sellerInfo.whatsappNumber': storedNumber,
                    'sellerInfo.whatsappDigits': digits,
                    'sellerInfo.whatsappVerified': true,
                };
                if (isNumberChange) update['sellerInfo.lastWhatsAppChange'] = new Date();
                try {
                    const updatedUser = await User.findOneAndUpdate(
                        { _id: sellerId, role: 'seller', updatedAt: user.updatedAt },
                        { $set: update },
                        { new: true }
                    );
                    if (!updatedUser) {
                        await WhatsAppOTP.deleteOne({ _id: otpRecord._id });
                        return res.status(409).json({
                            success: false,
                            msg: 'Your seller profile changed while this code was being verified. Please request a new code.',
                        });
                    }
                } catch (updateError) {
                    await WhatsAppOTP.deleteOne({ _id: otpRecord._id });
                    if (updateError?.code === 11000) {
                        return res.status(409).json({
                            success: false,
                            msg: 'This number is now associated with another seller account. Please use a different number.',
                        });
                    }
                    throw updateError;
                }
                await WhatsAppOTP.deleteOne({ _id: otpRecord._id });
            }
        }
        // For signup flow: the verified record stays in the DB. The registration
        // endpoint (verifySellerOTPAndRegister / becomeSeller) will call
        // consumeVerifiedWhatsAppNumber() to atomically prove + consume it.

        return res.status(200).json({
            success: true,
            verified: true,
            msg: 'WhatsApp number verified successfully'
        });
    } catch (error) {
        console.error('[sellerWhatsapp] verifyWhatsAppOTP error:', error.message);
        return res.status(500).json({
            success: false,
            msg: 'Verification failed. Please try again.'
        });
    }
};

/**
 * GET /api/seller-whatsapp/prefs
 * Get seller's WhatsApp notification preferences
 */
exports.getWhatsAppPrefs = async (req, res) => {
    try {
        const sellerId = req.user?.id || req.user?._id;
        if (!sellerId) {
            return res.status(401).json({ success: false, msg: 'Authentication required' });
        }
        if (req.user?.role !== 'seller') {
            return res.status(403).json({ success: false, msg: 'Seller access required' });
        }

        const user = await User.findById(sellerId).select('sellerInfo.whatsappNumber sellerInfo.whatsappVerified sellerInfo.lastWhatsAppChange whatsappNotificationPrefs');
        if (!user) {
            return res.status(404).json({ success: false, msg: 'User not found' });
        }

        const cooldown = getWhatsAppChangeCooldown(user);
        return res.status(200).json({
            success: true,
            whatsappNumber: user.sellerInfo?.whatsappNumber || null,
            whatsappVerified: user.sellerInfo?.whatsappVerified || false,
            lastWhatsAppChange: user.sellerInfo?.lastWhatsAppChange || null,
            nextWhatsAppChangeAt: cooldown?.nextChangeAt?.toISOString() || null,
            whatsappChangeDaysLeft: cooldown?.daysLeft || 0,
            prefs: {
                enabled: user.whatsappNotificationPrefs?.enabled ?? true,
                newOrders: user.whatsappNotificationPrefs?.newOrders ?? true,
                orderUpdates: user.whatsappNotificationPrefs?.orderUpdates ?? true,
                subscriptionAlerts: user.whatsappNotificationPrefs?.subscriptionAlerts ?? true,
                bonusAlerts: user.whatsappNotificationPrefs?.bonusAlerts ?? true,
                storeAlerts: user.whatsappNotificationPrefs?.storeAlerts ?? true,
            }
        });
    } catch (error) {
        console.error('[sellerWhatsapp] getWhatsAppPrefs error:', error.message);
        return res.status(500).json({ success: false, msg: 'Failed to fetch preferences' });
    }
};

/**
 * PUT /api/seller-whatsapp/prefs
 * Update seller's WhatsApp notification preferences
 * Body: { enabled, newOrders, orderUpdates, subscriptionAlerts, bonusAlerts, storeAlerts }
 *
 * SECURITY: Explicitly allowlists keys to prevent arbitrary field overwrite.
 */
exports.updateWhatsAppPrefs = async (req, res) => {
    try {
        const sellerId = req.user?.id || req.user?._id;
        if (!sellerId) {
            return res.status(401).json({ success: false, msg: 'Authentication required' });
        }
        if (req.user?.role !== 'seller') {
            return res.status(403).json({ success: false, msg: 'Seller access required' });
        }

        const { enabled, newOrders, orderUpdates, subscriptionAlerts, bonusAlerts, storeAlerts } = req.body;

        const update = {};
        if (typeof enabled === 'boolean') update['whatsappNotificationPrefs.enabled'] = enabled;
        if (typeof newOrders === 'boolean') update['whatsappNotificationPrefs.newOrders'] = newOrders;
        if (typeof orderUpdates === 'boolean') update['whatsappNotificationPrefs.orderUpdates'] = orderUpdates;
        if (typeof subscriptionAlerts === 'boolean') update['whatsappNotificationPrefs.subscriptionAlerts'] = subscriptionAlerts;
        if (typeof bonusAlerts === 'boolean') update['whatsappNotificationPrefs.bonusAlerts'] = bonusAlerts;
        if (typeof storeAlerts === 'boolean') update['whatsappNotificationPrefs.storeAlerts'] = storeAlerts;

        if (Object.keys(update).length === 0) {
            return res.status(400).json({ success: false, msg: 'No valid preferences provided' });
        }

        const user = await User.findByIdAndUpdate(sellerId, { $set: update }, { new: true })
            .select('whatsappNotificationPrefs');

        if (!user) {
            return res.status(404).json({ success: false, msg: 'User not found' });
        }

        return res.status(200).json({
            success: true,
            msg: 'WhatsApp notification preferences updated',
            prefs: {
                enabled: user.whatsappNotificationPrefs?.enabled ?? true,
                newOrders: user.whatsappNotificationPrefs?.newOrders ?? true,
                orderUpdates: user.whatsappNotificationPrefs?.orderUpdates ?? true,
                subscriptionAlerts: user.whatsappNotificationPrefs?.subscriptionAlerts ?? true,
                bonusAlerts: user.whatsappNotificationPrefs?.bonusAlerts ?? true,
                storeAlerts: user.whatsappNotificationPrefs?.storeAlerts ?? true,
            }
        });
    } catch (error) {
        console.error('[sellerWhatsapp] updateWhatsAppPrefs error:', error.message);
        return res.status(500).json({ success: false, msg: 'Failed to update preferences' });
    }
};
