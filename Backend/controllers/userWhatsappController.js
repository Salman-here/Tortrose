/**
 * User WhatsApp Controller
 * ─────────────────────────
 * Handles WhatsApp number linking for USERS (buyers) so they can
 * chat with the Rozare AI via the unified WhatsApp gateway.
 *
 * Uses the configured buyer logical route for OTP delivery. In unified mode,
 * that logical route is backed by the seller/admin Evolution instance.
 */

const crypto = require('crypto');
const WhatsAppOTP = require('../models/WhatsAppOTP');
const WhatsAppConfig = require('../models/WhatsAppConfig');
const User = require('../models/User');
const evolution = require('../services/whatsapp/evolutionClient');
const { configKeyFor } = require('../services/whatsapp/gatewayMode');
const { verifyAndClaimWhatsAppOTP } = require('../services/whatsappOtpVerificationService');
const {
    reserveWhatsAppOtpSend,
    releaseWhatsAppOtpSend,
} = require('../services/whatsappOtpRateLimitService');
const {
    normalizePhoneDigits,
    toE164PhoneNumber,
} = require('../utils/phoneNumber');
const {
    conflictMessage,
    findWhatsAppIdentityConflict,
} = require('../services/whatsappIdentityService');

// ─── Config ───
const OTP_EXPIRY_MINUTES = 2;
const MAX_ATTEMPTS = 5;

const generateOTP = () => crypto.randomInt(100000, 1000000).toString();

const cleanNumber = normalizePhoneDigits;

/**
 * POST /api/user-whatsapp/send-otp
 * Send a WhatsApp OTP for user-side number verification.
 * Body: { whatsappNumber } — E.164 format like "+923028588506"
 */
exports.sendUserWhatsAppOTP = async (req, res) => {
    try {
        const userId = req.user?.id || req.user?._id;
        if (!userId) {
            return res.status(401).json({ success: false, msg: 'Authentication required' });
        }

        const { whatsappNumber } = req.body;
        if (!whatsappNumber) {
            return res.status(400).json({ success: false, msg: 'WhatsApp number is required' });
        }

        const digits = cleanNumber(whatsappNumber);
        if (!digits || digits.length < 10) {
            return res.status(400).json({ success: false, msg: 'Invalid WhatsApp number format. Use country code + number (e.g. +923001234567)' });
        }

        // Check that the unified WhatsApp gateway is connected
        const cfg = await WhatsAppConfig.findOne({ singletonKey: configKeyFor('main') });
        if (!cfg || cfg.status !== 'connected') {
            return res.status(503).json({
                success: false,
                msg: 'WhatsApp verification service is temporarily unavailable. Please try again later.'
            });
        }

        if (!evolution.isConfigured()) {
            return res.status(503).json({
                success: false,
                msg: 'WhatsApp service is not configured. Please contact support.'
            });
        }

        // A verified number has one owner and one role across buyer, seller and
        // admin routing. This avoids an inherently ambiguous inbound identity.
        const currentUser = await User.findById(userId).select('whatsappInfo');
        if (
            currentUser?.whatsappInfo?.verified
            && cleanNumber(currentUser.whatsappInfo.number) === digits
        ) {
            return res.status(409).json({
                success: false,
                msg: 'This is already your linked WhatsApp number.',
            });
        }

        const identityConflict = await findWhatsAppIdentityConflict(digits, {
            channel: 'buyer',
            userId,
        });
        if (identityConflict) {
            return res.status(409).json({
                success: false,
                msg: conflictMessage(identityConflict),
            });
        }

        let rateReservation;
        try {
            rateReservation = await reserveWhatsAppOtpSend({ number: digits, sellerId: userId });
        } catch (rateError) {
            if (rateError?.code === 'WHATSAPP_OTP_GLOBAL_RATE_LIMIT') {
                return res.status(429).json({
                    success: false,
                    msg: 'Verification service is busy. Please try again in a few minutes.',
                });
            }
            if (rateError?.code === 'WHATSAPP_OTP_NUMBER_RATE_LIMIT') {
                return res.status(429).json({ success: false, msg: rateError.message });
            }
            throw rateError;
        }

        // Check if number is on WhatsApp
        let isOnWhatsApp;
        try {
            isOnWhatsApp = await evolution.checkWhatsAppNumber(digits);
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

        // Generate and send OTP
        const otp = generateOTP();
        const message = [
            `*Rozare WhatsApp Verification* 🔐`,
            ``,
            `Your verification code is: *${otp}*`,
            ``,
            `This code expires in ${OTP_EXPIRY_MINUTES} minutes.`,
            `Do not share this code with anyone.`,
            ``,
            `Once verified, you can chat with Rozare AI directly on WhatsApp! 🤖💙`,
        ].join('\n');

        try {
            await evolution.sendText(digits, message);
        } catch (sendErr) {
            console.error('[userWhatsapp] sendText failed:', sendErr.message);
            await releaseWhatsAppOtpSend(rateReservation).catch(() => null);
            return res.status(502).json({
                success: false,
                msg: 'Failed to send verification code. Please try again.'
            });
        }

        // Persist OTP after successful send
        await WhatsAppOTP.create({
            number: digits,
            otp,
            sellerId: userId, // reusing the existing field for user ID
            attempts: 0,
            verified: false,
        });

        return res.status(200).json({
            success: true,
            msg: 'Verification code sent to your WhatsApp'
        });
    } catch (error) {
        console.error('[userWhatsapp] sendUserWhatsAppOTP error:', error.message);
        return res.status(500).json({
            success: false,
            msg: 'Failed to send verification code. Please try again.'
        });
    }
};

/**
 * POST /api/user-whatsapp/verify-otp
 * Verify a WhatsApp OTP and link the number to the user's account.
 * Body: { whatsappNumber, otp }
 */
exports.verifyUserWhatsAppOTP = async (req, res) => {
    try {
        const userId = req.user?.id || req.user?._id;
        if (!userId) {
            return res.status(401).json({ success: false, msg: 'Authentication required' });
        }

        const { whatsappNumber, otp } = req.body;
        if (!whatsappNumber || !otp) {
            return res.status(400).json({ success: false, msg: 'WhatsApp number and OTP are required' });
        }

        const digits = cleanNumber(whatsappNumber);
        const otpStr = String(otp).trim();
        if (!digits || !/^\d{6}$/.test(otpStr)) {
            return res.status(400).json({ success: false, msg: 'Invalid WhatsApp number or code format' });
        }

        const verification = await verifyAndClaimWhatsAppOTP({
            number: digits,
            sellerId: userId,
            otp: otpStr,
            validAfter: new Date(Date.now() - OTP_EXPIRY_MINUTES * 60 * 1000),
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

        // OTP correct — check uniqueness one more time before saving
        const otpRecord = verification.record;
        const identityConflict = await findWhatsAppIdentityConflict(digits, {
            channel: 'buyer',
            userId,
        });
        if (identityConflict) {
            await WhatsAppOTP.deleteOne({ _id: otpRecord._id });
            return res.status(409).json({
                success: false,
                msg: conflictMessage(identityConflict),
            });
        }

        const storedNumber = toE164PhoneNumber(digits);

        try {
            const updated = await User.findOneAndUpdate(
                { _id: userId },
                {
                    $set: {
                        'whatsappInfo.number': storedNumber,
                        'whatsappInfo.verified': true,
                        'whatsappInfo.verifiedAt': new Date(),
                        'whatsappInfo.lastChange': new Date(),
                    },
                },
                { new: true }
            );
            if (!updated) {
                await WhatsAppOTP.deleteOne({ _id: otpRecord._id });
                return res.status(404).json({ success: false, msg: 'User not found' });
            }
        } catch (updateError) {
            await WhatsAppOTP.deleteOne({ _id: otpRecord._id });
            if (updateError?.code === 11000) {
                return res.status(409).json({
                    success: false,
                    msg: 'This number was just linked to another account. Please use a different number.',
                });
            }
            throw updateError;
        }

        await WhatsAppOTP.deleteOne({ _id: otpRecord._id });

        return res.status(200).json({
            success: true,
            verified: true,
            number: storedNumber,
            msg: 'WhatsApp number verified and linked! You can now chat with Rozare AI on WhatsApp. 🎉'
        });
    } catch (error) {
        console.error('[userWhatsapp] verifyUserWhatsAppOTP error:', error.message);
        return res.status(500).json({
            success: false,
            msg: 'Verification failed. Please try again.'
        });
    }
};

/**
 * POST /api/user-whatsapp/unlink
 * Unlink WhatsApp number from the user's account.
 */
exports.unlinkUserWhatsApp = async (req, res) => {
    try {
        const userId = req.user?.id || req.user?._id;
        if (!userId) {
            return res.status(401).json({ success: false, msg: 'Authentication required' });
        }

        const user = await User.findById(userId).select('whatsappInfo');
        if (!user?.whatsappInfo?.number) {
            return res.status(400).json({ success: false, msg: 'No WhatsApp number linked to your account.' });
        }

        await User.findByIdAndUpdate(userId, {
            $set: {
                'whatsappInfo.number': '',
                'whatsappInfo.verified': false,
                'whatsappInfo.verifiedAt': null,
                'whatsappInfo.lastChange': new Date(),
            }
        });

        return res.status(200).json({
            success: true,
            msg: 'WhatsApp number unlinked from your account.'
        });
    } catch (error) {
        console.error('[userWhatsapp] unlinkUserWhatsApp error:', error.message);
        return res.status(500).json({ success: false, msg: 'Failed to unlink WhatsApp number.' });
    }
};

/**
 * GET /api/user-whatsapp/status
 * Get user's WhatsApp linking status.
 */
exports.getUserWhatsAppStatus = async (req, res) => {
    try {
        const userId = req.user?.id || req.user?._id;
        if (!userId) {
            return res.status(401).json({ success: false, msg: 'Authentication required' });
        }

        const user = await User.findById(userId).select('whatsappInfo');

        // Also check if the unified WhatsApp gateway is connected
        const cfg = await WhatsAppConfig.findOne({ singletonKey: configKeyFor('main') });
        const instanceConnected = cfg?.status === 'connected';

        return res.status(200).json({
            success: true,
            whatsappNumber: user?.whatsappInfo?.number || null,
            verified: user?.whatsappInfo?.verified || false,
            verifiedAt: user?.whatsappInfo?.verifiedAt || null,
            instanceConnected,
            aiWhatsAppNumber: cfg?.linkedNumber || null,
        });
    } catch (error) {
        console.error('[userWhatsapp] getUserWhatsAppStatus error:', error.message);
        return res.status(500).json({ success: false, msg: 'Failed to fetch WhatsApp status.' });
    }
};
