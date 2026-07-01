/**
 * User WhatsApp Controller
 * ─────────────────────────
 * Handles WhatsApp number linking for USERS (buyers) so they can
 * chat with the Rozare AI via the unified WhatsApp gateway.
 *
 * Uses the configured buyer logical route for OTP delivery. In unified mode,
 * that logical route is backed by the seller/admin Evolution instance.
 */

const WhatsAppOTP = require('../models/WhatsAppOTP');
const WhatsAppConfig = require('../models/WhatsAppConfig');
const User = require('../models/User');
const evolution = require('../services/whatsapp/evolutionClient');
const { configKeyFor } = require('../services/whatsapp/gatewayMode');

// ─── Config ───
const OTP_EXPIRY_MINUTES = 2;
const VERIFIED_EXPIRY_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RATE_LIMIT_PER_HOUR = 3;
const GLOBAL_RATE_LIMIT_PER_HOUR = 200;

const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

const cleanNumber = (number) => String(number || '').replace(/\D/g, '');

// Constant-time string comparison
const safeEqual = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
        mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
};

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

        // Check if number is already linked to ANY user account (uniqueness)
        const numberVariants = [whatsappNumber, `+${digits}`, digits];
        const existingUser = await User.findOne({
            'whatsappInfo.number': { $in: numberVariants },
            'whatsappInfo.verified': true,
        });
        if (existingUser) {
            if (existingUser._id.toString() === String(userId)) {
                return res.status(409).json({
                    success: false,
                    msg: 'This is already your linked WhatsApp number.'
                });
            } else {
                return res.status(409).json({
                    success: false,
                    msg: 'This number is already linked to another account. Each WhatsApp number can only be linked to one account.'
                });
            }
        }

        // If user already has a different linked number, inform them it will be replaced
        const currentUser = await User.findById(userId).select('whatsappInfo');
        const hasExistingNumber = currentUser?.whatsappInfo?.number && currentUser?.whatsappInfo?.verified;

        // A seller/admin number may also be linked for buyer AI mode. Unified
        // routing gives seller/admin identity priority, while this user link is
        // still allowed for buyer tools. We only block if another USER has it.

        // Per-number rate limit
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const perNumberCount = await WhatsAppOTP.countDocuments({
            number: digits,
            createdAt: { $gte: oneHourAgo }
        });
        if (perNumberCount >= RATE_LIMIT_PER_HOUR) {
            return res.status(429).json({
                success: false,
                msg: 'Too many verification attempts for this number. Please try again in an hour.'
            });
        }

        // Global rate limit
        const globalCount = await WhatsAppOTP.countDocuments({ createdAt: { $gte: oneHourAgo } });
        if (globalCount >= GLOBAL_RATE_LIMIT_PER_HOUR) {
            return res.status(429).json({
                success: false,
                msg: 'Verification service is busy. Please try again in a few minutes.'
            });
        }

        // Check if number is on WhatsApp
        const isOnWhatsApp = await evolution.checkWhatsAppNumber(digits);
        if (isOnWhatsApp === false) {
            return res.status(400).json({
                success: false,
                msg: 'This number is not registered on WhatsApp. Please use a valid WhatsApp number.'
            });
        }
        if (isOnWhatsApp === null) {
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

        // Find the most recent unexpired, unverified OTP
        const otpExpiry = new Date(Date.now() - OTP_EXPIRY_MINUTES * 60 * 1000);
        const otpRecord = await WhatsAppOTP.findOne({
            number: digits,
            verified: false,
            createdAt: { $gte: otpExpiry },
        }).sort({ createdAt: -1 });

        if (!otpRecord) {
            return res.status(400).json({
                success: false,
                msg: 'No pending verification. Please request a new code.'
            });
        }

        // Brute-force lockout
        if (otpRecord.attempts >= MAX_ATTEMPTS) {
            otpRecord.createdAt = new Date(0);
            await otpRecord.save().catch(() => null);
            return res.status(429).json({
                success: false,
                msg: 'Too many incorrect attempts. Please request a new code.'
            });
        }

        // Constant-time compare
        if (!safeEqual(otpRecord.otp, otpStr)) {
            otpRecord.attempts = (otpRecord.attempts || 0) + 1;
            await otpRecord.save().catch(() => null);
            const remaining = Math.max(0, MAX_ATTEMPTS - otpRecord.attempts);
            return res.status(400).json({
                success: false,
                msg: remaining > 0
                    ? `Invalid verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
                    : 'Too many incorrect attempts. Please request a new code.',
            });
        }

        // OTP correct — check uniqueness one more time before saving
        const storedNumber = whatsappNumber.trim().startsWith('+')
            ? whatsappNumber.trim()
            : `+${digits}`;

        const numberVariants = [storedNumber, `+${digits}`, digits];
        const existingUser = await User.findOne({
            _id: { $ne: userId },
            'whatsappInfo.number': { $in: numberVariants },
            'whatsappInfo.verified': true,
        });
        if (existingUser) {
            return res.status(409).json({
                success: false,
                msg: 'This number was just linked to another account. Please use a different number.'
            });
        }

        // Update user's whatsappInfo
        await User.findByIdAndUpdate(userId, {
            $set: {
                'whatsappInfo.number': storedNumber,
                'whatsappInfo.verified': true,
                'whatsappInfo.verifiedAt': new Date(),
                'whatsappInfo.lastChange': new Date(),
            }
        });

        // Clean up OTP records
        await WhatsAppOTP.deleteMany({ number: digits });

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
