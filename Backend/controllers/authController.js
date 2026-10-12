const { moderatedStoreInput } = require('../services/catalogModerationService');
const User = require("../models/User");
const OTP = require("../models/OTP");
const mongoose = require('mongoose');
const bcrypt = require('bcrypt')
const { sendEmail } = require('./mailController')
const { welcomeEmail } = require('../utils/emailTemplates');
const { verificationCodeEmail } = require('../utils/accountEmailTemplates');
const { trackCompleteRegistration } = require('../services/tiktokEventsApi');
const { trackSellerLead } = require('../services/metaConversionsApi');
const { normalizeSocialLinks } = require('../services/socialLinksService');
const {
    enqueueStoreCreatedNotification,
    ensureSellerWelcomeNotification,
} = require('../services/sellerOperationalNotificationService');
const { runInTransaction } = require('../services/walletService');
const {
    productCurrencyForSellerSignupOtp,
    productCurrencyFromSellerSignupOtp,
} = require('../services/sellerOnboardingCurrencyService');
const { normalizePhoneDigits, toE164PhoneNumber } = require('../utils/phoneNumber');
const { MAX_STORE_SLUG_LENGTH, safeGeneratedStoreSlugBase } = require('../utils/storeSlug');
const { generateSixDigitOTP, signAuthToken } = require('../utils/authSecurity');


// Step 1: Send OTP to email
exports.sendOTP = async (req, res) => {
    const { username, email, password } = req.body;

    try {
        // Check if user already exists
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(409).json({ msg: 'E-mail is already taken.' });
        }

        // Generate 6-digit OTP
        const otp = generateSixDigitOTP();

        // Delete any existing OTP for this email
        await OTP.deleteMany({ email });

        // Save OTP with user data
        const otpDoc = new OTP({
            email,
            otp,
            userData: {
                username,
                email,
                password, // Will be hashed during user creation
                role: 'user',
                isVerified: true // Will be set to true after OTP verification
            }
        });
        await otpDoc.save();

        await sendEmail({ to: email, ...verificationCodeEmail({ name: username, code: otp, purpose: 'buyer_signup', expiresMinutes: 10 }) });

        res.status(200).json({ 
            msg: 'OTP sent to your email. Please verify to complete registration.',
            email: email 
        });
    } catch (error) {
        console.error('Send OTP error:', error.message);
        
        // Delete the OTP document if email fails
        await OTP.deleteMany({ email });
        
        res.status(500).json({ 
            msg: 'Failed to send OTP. Please try again.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// Step 2: Verify OTP and create user
exports.verifyOTPAndRegister = async (req, res) => {
    const { email, otp } = req.body;

    try {
        // Find OTP document
        const otpDoc = await OTP.findOne({ email, otp, createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) } });

        if (!otpDoc || otpDoc.userData?.role !== 'user') {
            return res.status(400).json({ msg: 'Invalid or expired OTP.' });
        }

        // Check if user already exists (double check)
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            await OTP.deleteOne({ _id: otpDoc._id });
            return res.status(409).json({ msg: 'E-mail is already taken.' });
        }

        // Explicitly set isVerified to true since email was verified via OTP
        const userData = { ...otpDoc.userData, isVerified: true };
        const newUser = new User(userData);
        await newUser.save();

        // Delete OTP document
        await OTP.deleteOne({ _id: otpDoc._id });

        // Generate JWT token and return user data (same as login)
        const payload = {
            id: newUser._id,
            username: newUser.username,
            email: newUser.email,
            role: newUser.role,
            avatar: newUser.avatar
        }

        const token = signAuthToken(payload);

        // Send welcome email
        try {
            const emailData = welcomeEmail(newUser.username);
            await sendEmail({ to: newUser.email, ...emailData });
        } catch (emailErr) {
            console.error('Failed to send welcome email:', emailErr.message);
        }
        
        res.status(200).json({ 
            msg: 'Email verified! Sign up successful.', 
            token: token, 
            user: payload 
        });
    } catch (error) {
        console.error('Verify OTP error:', error);
        res.status(500).json({ msg: 'Verification failed. Please try again.' });
    }
};

// Keep old register for backward compatibility (can be removed later)
exports.registerr = async (req, res) => {
    const { username, email, password } = req.body

    try {
        const existingUser = await User.findOne({ email })
        if (existingUser) {
            return res.status(409).json({ msg: 'E-mail is already taken.' })
        }

        const newUser = new User({ ...req.body, role: 'user' });
        await newUser.save();
        res.status(200).json({ msg: 'Sign up successfull.' })
    } catch (error) {
        console.error(error);
        res.status(409).json({ msg: 'sign up failed.' })
    }
}

exports.login = async (req, res) => {
    try {
        const { email, password } = req.body || {}

        if (!email || !password) {
            return res.status(400).json({ msg: 'Email and password are required.' })
        }

        const userFound = await User.findOne({ email }).select('+password')
        if (!userFound) return res.status(404).json({ msg: 'User not Found!' })

        if (userFound.status === 'blocked') {
            return res.status(403).json({
                msg: 'Your account is blocked. For further details contact support.',
                code: 'ACCOUNT_BLOCKED',
            })
        }

        // Check if user has a password (not OAuth user)
        if (!userFound.password) {
            return res.status(400).json({ msg: 'This account uses Google Sign-In. Please sign in with Google.' })
        }

        const isMatched = await bcrypt.compare(password, userFound.password)
        if (!isMatched) return res.status(401).json({ msg: 'Incorrect password!' })

        const payload = {
            id: userFound._id,
            username: userFound.username,
            email: userFound.email,
            role: userFound.role,
            avatar: userFound.avatar
        }

        const token = signAuthToken(payload)

        return res.status(200).json({ msg: 'Log in successfull.', token: token, user: payload })
    } catch (error) {
        console.error('Login error:', error)
        return res.status(500).json({ msg: 'Log in failed. Please try again.' })
    }
}

exports.googleCallback = async (req, res) => {
    try {
        const state = req.query.state || '';
        const isMobile = state === 'mobile';
        const isSeller = state === 'seller';
        const passportUserId = req.user?._id || req.user?.id;
        const user = passportUserId
            ? await User.findById(passportUserId).select('_id username email role status avatar profilePicture')
            : null;

        if (!user) throw new Error('Google account no longer exists');
        if (user.status === 'blocked') {
            if (isMobile) {
                return res.redirect('rozare://auth/google/error?code=account_blocked');
            }
            return res.redirect(`${process.env.FRONTEND_URL}/login?error=account_blocked`);
        }

        const payload = {
            id: user._id,
            username: user.username,
            email: user.email,
            role: user.role,
            avatar: user.profilePicture || user.avatar
        }

        const token = signAuthToken(payload);

        if (isMobile) {
            // Redirect to app deep link — WebBrowser.openAuthSessionAsync will intercept this
            return res.redirect(`rozare://auth/google/success?token=${encodeURIComponent(token)}`);
        }

        // Web redirect — include redirect param for seller flow
        const redirectParam = isSeller ? `&redirect=${encodeURIComponent('/become-seller?from=google')}` : '';
        res.redirect(`${process.env.FRONTEND_URL}/auth/google/success?token=${token}${redirectParam}`);
    } catch (error) {
        console.error('Google callback error:', error);
        const state = req.query.state || '';
        if (state === 'mobile') {
            return res.redirect('rozare://auth/google/error');
        }
        res.redirect(`${process.env.FRONTEND_URL}/login?error=auth_failed`);
    }
};

// Send OTP for seller registration
exports.sendSellerOTP = async (req, res) => {
    const { username, email, password, phoneNumber, address, city, state, stateCode, country, countryCode, businessName } = req.body;

    let sellerProductCurrency;
    try {
        sellerProductCurrency = productCurrencyForSellerSignupOtp(req.body);
    } catch (error) {
        return res.status(error.statusCode || error.status || 400).json({
            msg: error.message,
            code: error.code,
        });
    }

    try {
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(409).json({ msg: 'E-mail is already taken.' });
        }

        const otp = generateSixDigitOTP();
        await OTP.deleteMany({ email });

        const otpDoc = new OTP({
            email,
            otp,
            userData: {
                username,
                email,
                password,
                role: 'seller',
                isVerified: true,
                productCurrency: sellerProductCurrency,
            }
        });
        // Store seller info in a separate field via the OTP doc
        otpDoc._sellerInfo = { phoneNumber, address, city, state, stateCode, country, countryCode, businessName };
        await otpDoc.save();

        await sendEmail({ to: email, ...verificationCodeEmail({ name: username, code: otp, purpose: 'seller_signup', expiresMinutes: 10 }) });

        res.status(200).json({ msg: 'OTP sent to your email. Please verify to complete seller registration.', email });
    } catch (error) {
        console.error('Send seller OTP error:', error.message);
        await OTP.deleteMany({ email });
        res.status(500).json({ msg: 'Failed to send OTP. Please try again.' });
    }
};

// Verify OTP and create seller
exports.verifySellerOTPAndRegister = async (req, res) => {
    const { email, otp, phoneNumber, address, city, state, stateCode, country, countryCode, businessName, storeName, storeDescription, socialLinks, sellerType, whatsappNumber } = req.body;

    try {
        const otpDoc = await OTP.findOne({ email, otp, createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) } });
        // A seller code must never be interchangeable with the ordinary buyer
        // signup code. Otherwise the buyer verifier could create a seller
        // without the WhatsApp/store transaction, or a buyer code could enter
        // this seller-only flow.
        if (!otpDoc || otpDoc.userData?.role !== 'seller') {
            return res.status(400).json({ msg: 'Invalid or expired OTP.' });
        }

        const existingUser = await User.findOne({ email });
        if (existingUser) {
            await OTP.deleteOne({ _id: otpDoc._id });
            return res.status(409).json({ msg: 'E-mail is already taken.' });
        }

        if (!whatsappNumber) {
            return res.status(400).json({
                msg: 'Please verify your WhatsApp number before creating your seller account.'
            });
        }

        const persistedUserData = typeof otpDoc.userData?.toObject === 'function'
            ? otpDoc.userData.toObject()
            : { ...(otpDoc.userData || {}) };
        const sellerProductCurrency = productCurrencyFromSellerSignupOtp(persistedUserData);
        // productCurrency belongs to Store, not User. Keep it out of the User
        // document and use the value frozen in the OTP record below.
        const accountUserData = { ...persistedUserData };
        delete accountUserData.productCurrency;
        // Reserve one identity for transaction retries, but instantiate a new
        // Mongoose document inside each callback attempt. Reusing a document
        // saved by an aborted transaction can leave `isNew` false and make a
        // retry update a User row that never committed.
        const newUserId = new mongoose.Types.ObjectId();
        const shouldCreateStore = Boolean(storeName && storeName.trim().length >= 3);
        const { normalizeStoreVisibility } = require('../services/storeVisibilityService');
        const storeVisibility = shouldCreateStore ? normalizeStoreVisibility(req.body.visibility, {
            store: { address: normalizeStoreVisibility({ mode: 'country', country, countryCode }) },
        }) : undefined;
        const requestedStoreName = shouldCreateStore ? storeName.trim() : '';
        const sellerWelcomeOccurredAt = new Date();
        const sellerInfo = {
            phoneNumber: phoneNumber?.trim() || '',
            whatsappNumber: toE164PhoneNumber(whatsappNumber),
            whatsappDigits: normalizePhoneDigits(whatsappNumber),
            whatsappVerified: true,
            address: address?.trim() || '',
            city: city?.trim() || '',
            state: state?.trim() || '',
            stateCode: stateCode?.trim() || '',
            country: country?.trim() || '',
            countryCode: countryCode?.trim() || '',
            businessName: businessName?.trim() || ''
        };
        const sellerWelcomeNotice = {
            occurredAt: sellerWelcomeOccurredAt,
            storeName: requestedStoreName,
            notificationEnqueuedAt: null,
        };

        const Store = shouldCreateStore ? require('../models/Store') : null;
        let slug = '';
        if (shouldCreateStore) {
            const baseSlug = safeGeneratedStoreSlugBase(requestedStoreName, newUserId);
            slug = baseSlug;
            let existingStore = await Store.findOne({ storeSlug: slug });
            let counter = 1;
            while (existingStore) {
                const suffix = `-${counter}`;
                slug = `${baseSlug.slice(0, MAX_STORE_SLUG_LENGTH - suffix.length).replace(/-+$/g, '')}${suffix}`;
                existingStore = await Store.findOne({ storeSlug: slug });
                counter++;
            }
        }

        let newUser = null;
        let newStore = null;
        await runInTransaction(async session => {
            const { consumeVerifiedWhatsAppNumber } = require('./sellerWhatsappController');
            const whatsappVerifiedServerSide = await consumeVerifiedWhatsAppNumber(
                whatsappNumber,
                null,
                { session }
            );
            if (!whatsappVerifiedServerSide) {
                const error = new Error('Please verify your WhatsApp number before creating your seller account.');
                error.status = 400;
                error.code = 'SELLER_WHATSAPP_VERIFICATION_REQUIRED';
                throw error;
            }

            const transactionUser = new User({
                ...accountUserData,
                _id: newUserId,
                isVerified: true,
                // A direct seller has no pre-existing account currency. Keep
                // the OTP-frozen supported selection as the authoritative
                // account default as well, so a legacy no-store registration
                // cannot later auto-create a USD store after choosing PKR.
                currency: sellerProductCurrency,
                sellerInfo,
                sellerWelcomeNotice,
            });
            await transactionUser.save({ session });
            newUser = transactionUser;
            if (shouldCreateStore) {
                [newStore] = await Store.create([moderatedStoreInput({
                    seller: transactionUser._id,
                    storeName: requestedStoreName,
                    storeSlug: slug,
                    sellerType: sellerType === 'brand' ? 'brand' : 'store',
                    description: storeDescription?.trim() || '',
                    productCurrency: sellerProductCurrency,
                    visibility: storeVisibility,
                    socialLinks: normalizeSocialLinks(socialLinks),
                    address: {
                        street: address?.trim() || '',
                        city: city?.trim() || '',
                        state: state?.trim() || '',
                        stateCode: stateCode?.trim() || '',
                        country: country?.trim() || '',
                        countryCode: countryCode?.trim() || ''
                    }
                })], { session });
                await enqueueStoreCreatedNotification(newStore, { session });
            }
        });

        // A committed User prevents replay even if this best-effort cleanup is
        // temporarily unavailable; subsequent verification removes the stale
        // email OTP through the existing-user branch above.
        await OTP.deleteOne({ _id: otpDoc._id }).catch(error =>
            console.error('Seller email OTP cleanup failed after registration:', error.message)
        );

        if (newStore) {
            const { initializeSubscription } = require('./subscriptionController');
            await initializeSubscription(newUser._id).catch(error =>
                console.error('Seller subscription initialization failed; recovery is pending:', error.message)
            );
        }
        await ensureSellerWelcomeNotification(newUser).catch(error =>
            console.error('Seller welcome outbox handoff failed; recovery is pending:', error.message)
        );

        const payload = { id: newUser._id, username: newUser.username, email: newUser.email, role: newUser.role, avatar: newUser.avatar };
        const token = signAuthToken(payload);

        trackCompleteRegistration({
            req,
            user: newUser,
            storeName: storeName?.trim(),
            phone: whatsappNumber || phoneNumber,
            eventId: req.body?.tracking?.tiktokCompleteRegistrationEventId,
            tracking: req.body?.tracking || {},
        }).catch(() => {});
        trackSellerLead({
            req,
            user: newUser,
            storeName: storeName?.trim(),
            phone: whatsappNumber || phoneNumber,
            eventId: req.body?.tracking?.metaLeadEventId,
            tracking: req.body?.tracking || {},
        }).catch(() => {});

        res.status(200).json({ msg: 'Seller account created successfully!', token, user: payload });
    } catch (error) {
        console.error('Verify seller OTP error:', error);
        if (error?.code === 11000) {
            return res.status(409).json({
                msg: 'The store name or WhatsApp number is already linked to another account. Please choose different details and retry.',
                code: 'SELLER_ONBOARDING_CONFLICT',
            });
        }
        const status = Number(error.statusCode || error.status);
        if (Number.isInteger(status) && status >= 400 && status < 500) {
            return res.status(status).json({ msg: error.message, code: error.code });
        }
        res.status(500).json({ msg: 'Verification failed. Please try again.' });
    }
};
