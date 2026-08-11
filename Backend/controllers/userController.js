const crypto = require('crypto')
const User = require('../models/User')
const { sendEmail } = require('./mailController')
const { sellerAccountCreatedEmail } = require('../utils/emailTemplates')
const { trackCompleteRegistration } = require('../services/tiktokEventsApi')
const { trackSellerLead } = require('../services/metaConversionsApi')
const { normalizeSocialLinks } = require('../services/socialLinksService')
const { notifySeller } = require('../services/whatsapp/sellerNotificationService')
const sellerTemplates = require('../services/whatsapp/sellerMessageTemplates')
const SellerSubscription = require('../models/SellerSubscription')
const Store = require('../models/Store')
const WhatsAppOTP = require('../models/WhatsAppOTP')
const WhatsAppConfig = require('../models/WhatsAppConfig')
const sellerEvolutionClient = require('../services/whatsapp/sellerEvolutionClient')
const { verifyAndClaimWhatsAppOTP } = require('../services/whatsappOtpVerificationService')
const {
    reserveWhatsAppOtpSend,
    releaseWhatsAppOtpSend,
} = require('../services/whatsappOtpRateLimitService')
const {
    normalizePhoneDigits,
    toE164PhoneNumber,
    sellerPhoneConflictQuery,
} = require('../utils/phoneNumber')
const { slugifyStoreName } = require('../utils/storeSlug')
const {
    conflictMessage,
    findWhatsAppIdentityConflict,
} = require('../services/whatsappIdentityService')
const {
    presentSellerSubscription,
    resolveUserJoinedAt,
} = require('../services/adminUserPresentationService')
const { deleteAccountCascade } = require('../services/accountDeletionService')
const { isValidExpoToken } = require('../utils/expoPush')
const {
    registerPushToken,
    revokePushToken: revokePushTokenRegistration,
    isCredentialShape,
    unregisterPushTokenForUser,
} = require('../services/pushTokenRevocationService')

exports.getUsers = async (req, res) => {
    const { role: userRole, id: _id } = req.user
    const { role, status, search } = req.query
    if (userRole !== 'admin') return res.status(403).json({ msg: 'Admin access only.' })


    let query = {}
    try {
        if (role) query.role = role
        if (status) query.status = status
        if (search) {
            query.$or = [
                { username: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } }
            ]
        }
        const users = await User.find(query)
            .select('username email avatar profilePicture role status isVerified sellerInfo whatsappInfo currency savedShippingInfo createdAt updatedAt')
            .sort({ _id: -1 })
            .lean()

        const sellerIds = users.filter(user => user.role === 'seller').map(user => user._id)
        const [subscriptions, stores] = await Promise.all([
            sellerIds.length
                ? SellerSubscription.find({ seller: { $in: sellerIds } })
                    .select('seller status plan planName trialStartDate trialEndDate subscribedAt freePeriodEndDate currentPeriodStart currentPeriodEnd bonusExpiryDate blockedAt blockedReason aiMessageLimit cancelledAt createdAt updatedAt')
                    .lean()
                : [],
            sellerIds.length
                ? Store.find({ seller: { $in: sellerIds } })
                    .select('seller storeName storeSlug sellerType isActive blockedAt productCurrency productCurrencyStatus previousProductCurrency pendingProductCurrency subdomainPurchase verification address createdAt updatedAt')
                    .lean()
                : [],
        ])

        const subscriptionBySeller = new Map(subscriptions.map(sub => [String(sub.seller), sub]))
        const storeBySeller = new Map(stores.map(store => [String(store.seller), store]))

        const enrichedUsers = users.map(user => {
            const joinedAt = resolveUserJoinedAt(user)
            const subscription = user.role === 'seller'
                ? subscriptionBySeller.get(String(user._id)) || null
                : null

            return {
                ...user,
                createdAt: user.createdAt || joinedAt,
                joinedAt,
                sellerSubscription: presentSellerSubscription(subscription),
                store: user.role === 'seller' ? storeBySeller.get(String(user._id)) || null : null,
            }
        })

        res.status(200).json({ msg: 'Users fetched succcessfully.', users: enrichedUsers })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while fetching users.' })
    }
}


exports.toggleBlockUser = async (req, res) => {
    const { role } = req.user
    const { id } = req.params
    if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only.' })
    try {
        const user = await User.findById(id)

        if (!user) res.status(404).json({ msg: "User not found." })

        user.status = user.status === 'blocked' ? 'active' : 'blocked'
        await user.save()
        res.status(200).json({ msg: `${user.username} status updated to ${user.status}.` })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while updating user status.' })
    }
}

exports.unblockSellerSubscription = async (req, res) => {
    const { role } = req.user
    const { id } = req.params
    const extensionDays = Math.max(1, Math.min(90, Number.parseInt(req.body?.extensionDays, 10) || 15))

    if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only.' })

    try {
        const seller = await User.findById(id)
        if (!seller) return res.status(404).json({ msg: 'Seller not found.' })
        if (seller.role !== 'seller') return res.status(400).json({ msg: 'This account is not a seller.' })

        const now = new Date()
        const trialEndDate = new Date(now.getTime() + extensionDays * 24 * 60 * 60 * 1000)

        let subscription = await SellerSubscription.findOne({ seller: seller._id })
        if (!subscription) {
            subscription = new SellerSubscription({
                seller: seller._id,
                trialStartDate: now,
                trialEndDate,
                status: 'trial',
                plan: 'free_trial',
                planName: 'Rozare Free Trial',
                aiMessageLimit: -1,
            })
        } else {
            subscription.status = 'trial'
            subscription.plan = subscription.plan || 'free_trial'
            subscription.planName = subscription.planName || 'Rozare Free Trial'
            subscription.trialEndDate = trialEndDate
            subscription.blockedAt = null
            subscription.blockedReason = ''
            subscription.warningEmailSent = false
            subscription.cancelledAt = null
        }
        await subscription.save()

        seller.status = 'active'
        await seller.save()

        const store = await Store.findOne({ seller: seller._id })
        if (store) {
            store.isActive = true
            store.blockedAt = null
            store.subdomainPurchase = {
                ...(store.subdomainPurchase?.toObject?.() || {}),
                removalScheduledAt: null,
            }
            await store.save()
        }

        res.status(200).json({
            msg: `${seller.username}'s store has been unblocked and the trial was extended for ${extensionDays} day${extensionDays === 1 ? '' : 's'}.`,
            seller: {
                _id: seller._id,
                username: seller.username,
                email: seller.email,
                status: seller.status,
            },
            sellerSubscription: subscription,
            store,
        })
    } catch (error) {
        console.error(error)
        res.status(500).json({ msg: 'Server error while unblocking seller.' })
    }
}


exports.toggleAdminUser = async (req, res) => {
    const { role } = req.user
    const { id } = req.params
    const { newRole } = req.body // Accept specific role from request
    if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only.' })
    try {
        const user = await User.findById(id)

        if (!user) return res.status(404).json({ msg: "User not found." })

        // If newRole is provided, use it; otherwise cycle through roles
        if (newRole && ['user', 'admin', 'seller'].includes(newRole)) {
            user.role = newRole
        } else {
            // Cycle: user -> seller -> admin -> user
            if (user.role === 'user') {
                user.role = 'seller'
            } else if (user.role === 'seller') {
                user.role = 'admin'
            } else {
                user.role = 'user'
            }
        }
        
        await user.save()
        res.status(200).json({ msg: `${user.username}'s role updated to ${user.role}.` })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while updating user role.' })
    }
}


exports.deleteUser = async (req, res) => {
    const { role } = req.user
    const { id } = req.params
    if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only.' })
    try {
        const result = await deleteAccountCascade(id)
        if (!result.found) return res.status(404).json({ msg: 'User not found.' })
        res.status(200).json({ msg: `User has been successfully deleted.` })
    } catch (error) {
        if (error?.code === 'ADMIN_ACCOUNT_DELETE_FORBIDDEN') {
            return res.status(409).json({ msg: error.message })
        }
        console.error(error);
        res.status(500).json({ msg: 'Server error while deleting user.' })
    }
}

exports.deleteOwnAccount = async (req, res) => {
    const { id: _id } = req.user
    try {
        const result = await deleteAccountCascade(_id, { allowAdminDeletion: true })
        if (!result.found) return res.status(404).json({ msg: 'User not found.' })
        res.status(200).json({ msg: 'Your account has been successfully deleted.' })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while deleting account.' })
    }
}

exports.getSingle = async (req, res) => {
    const { id: _id } = req.user
    const { role, status, search } = req.query
    // if (userRole !== 'admin') return res.status(403).json({ msg: 'Admin access only.' })


    // let query = {}
    try {
        // if (role) query.role = role
        // if (status) query.status = status
        // if (search) query.username = { $regex: search, $options: 'i' }
        const user = await User.findById(_id).select('-password')
        res.status(200).json({ msg: 'User fetched succcessfully.', user: user })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while fetching user.' })
    }
}


exports.updateUser = async (req, res) => {
    const { id: _id } = req.user
    const { username } = req.body

    try {
        if (!username) return res.status(401).json({ msg: 'Provide new username' })
        const user = await User.findByIdAndUpdate(_id, { username: username })
        if (!user) return res.status(404).json({ msg: 'User not found!' })
        await user.save()

        res.status(200).json({ msg: 'Your username has been updated successfully' })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while updating username.' })
    }
}


// Become a seller - update user role and save seller information
exports.becomeSeller = async (req, res) => {
    const { id: _id } = req.user
    const { phoneNumber, address, city, state, stateCode, country, countryCode, businessName, storeName, storeDescription, socialLinks, whatsappNumber, whatsappVerified } = req.body

    try {
        // Check if user exists
        const user = await User.findById(_id)
        if (!user) return res.status(404).json({ message: 'User not found!' })

        // Check if user is already a seller or admin
        if (user.role === 'seller' || user.role === 'admin') {
            return res.status(400).json({ message: 'You are already a seller or admin' })
        }

        // Validate required fields
        if (!phoneNumber || phoneNumber.trim().length < 10) {
            return res.status(400).json({ message: 'Please provide a valid phone number (at least 10 digits)' })
        }
        if (!address || address.trim().length < 5) {
            return res.status(400).json({ message: 'Please provide a valid address' })
        }
        if (!city || city.trim().length < 2) {
            return res.status(400).json({ message: 'Please provide your city' })
        }
        if (!country || country.trim().length < 2) {
            return res.status(400).json({ message: 'Please provide your country' })
        }
        if (!storeName || storeName.trim().length < 3) {
            return res.status(400).json({ message: 'Store name is required (at least 3 characters)' })
        }
        if (!storeDescription || storeDescription.trim().length < 10) {
            return res.status(400).json({ message: 'Store description is required (at least 10 characters)' })
        }

        // Check store name uniqueness before proceeding
        const StoreModel = require('../models/Store')
        const baseSlug = slugifyStoreName(storeName) || `store-${user._id.toString().slice(-8)}`
        const desiredSlug = baseSlug
        const slugTaken = await StoreModel.findOne({ storeSlug: desiredSlug })
        if (slugTaken) {
            return res.status(409).json({ message: 'This store name is already taken. Please choose a different name.' })
        }

        // Verify WhatsApp against server-side OTP record (if a number was provided).
        // We DO NOT trust a client-sent `whatsappVerified` flag — the client could
        // simply set it to true without ever going through OTP.
        let whatsappVerifiedServerSide = false;
        if (whatsappNumber) {
            const { consumeVerifiedWhatsAppNumber } = require('./sellerWhatsappController');
            whatsappVerifiedServerSide = await consumeVerifiedWhatsAppNumber(whatsappNumber, _id);
        }
        if (!whatsappVerifiedServerSide) {
            return res.status(400).json({
                message: 'Please verify your WhatsApp number before activating your seller account.'
            });
        }

        // Update user role to seller and save seller information
        user.role = 'seller'
        user.sellerInfo = {
            phoneNumber: phoneNumber.trim(),
            whatsappNumber: whatsappVerifiedServerSide ? toE164PhoneNumber(whatsappNumber) : '',
            whatsappDigits: whatsappVerifiedServerSide ? normalizePhoneDigits(whatsappNumber) : '',
            whatsappVerified: whatsappVerifiedServerSide,
            address: address.trim(),
            city: city.trim(),
            state: state?.trim() || '',
            stateCode: stateCode?.trim() || '',
            country: country.trim(),
            countryCode: countryCode?.trim() || '',
            businessName: businessName?.trim() || ''
        }
        
        await user.save()

        let createdStoreName = ''

        // Auto-create store (storeName is now required)
        try {
            const Store = require('../models/Store')
            const { initializeSubscription } = require('./subscriptionController')
            
            // Use the slug we already validated above
            const newStore = new Store({
                seller: user._id,
                storeName: storeName.trim(),
                storeSlug: desiredSlug,
                description: storeDescription.trim(),
                socialLinks: normalizeSocialLinks(socialLinks),
                address: {
                    street: address?.trim() || '',
                    city: city?.trim() || '',
                    state: state?.trim() || '',
                    stateCode: stateCode?.trim() || '',
                    country: country?.trim() || '',
                    countryCode: countryCode?.trim() || ''
                }
            })
            await newStore.save()
            await initializeSubscription(user._id)
            createdStoreName = newStore.storeName
        } catch (storeErr) {
            console.error('Auto-create store error:', storeErr.message)
            // If store creation fails due to duplicate (race condition), return error
            if (storeErr.code === 11000) {
                return res.status(409).json({ message: 'This store name is already taken. Please choose a different name.' })
            }
        }

        notifySeller(user._id, 'seller_welcome', sellerTemplates.seller_welcome(createdStoreName)).catch(e =>
            console.error('Seller WhatsApp welcome failed:', e.message)
        )

        // Generate new JWT token with updated role
        const jwt = require('jsonwebtoken')
        const token = jwt.sign(
            { id: user._id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        )

        // Send seller account created email
        try {
            const emailData = sellerAccountCreatedEmail(user.username);
            await sendEmail({ to: user.email, ...emailData });
        } catch (emailErr) {
            console.error('Failed to send seller account email:', emailErr.message);
        }

        trackCompleteRegistration({
            req,
            user,
            storeName: storeName?.trim(),
            phone: whatsappVerifiedServerSide ? whatsappNumber.trim() : phoneNumber.trim(),
            eventId: req.body?.tracking?.tiktokCompleteRegistrationEventId,
            tracking: req.body?.tracking || {},
        }).catch(() => {});
        trackSellerLead({
            req,
            user,
            storeName: storeName?.trim(),
            phone: whatsappVerifiedServerSide ? whatsappNumber.trim() : phoneNumber.trim(),
            eventId: req.body?.tracking?.metaLeadEventId,
            tracking: req.body?.tracking || {},
        }).catch(() => {});

        res.status(200).json({ 
            message: 'Congratulations! You are now a seller',
            token: token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                role: user.role,
                sellerInfo: user.sellerInfo
            }
        })
    } catch (error) {
        console.error('Error in becomeSeller:', error);
        res.status(500).json({ message: 'Server error while creating seller account.' })
    }
}

// Get saved shipping info
exports.getShippingInfo = async (req, res) => {
    const { id: _id } = req.user
    try {
        const user = await User.findById(_id).select('savedShippingInfo')
        res.status(200).json({ msg: 'Shipping info fetched', shippingInfo: user?.savedShippingInfo || {} })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while fetching shipping info' })
    }
}

// Save/update shipping info
exports.updateShippingInfo = async (req, res) => {
    const { id: _id } = req.user
    const { shippingInfo } = req.body
    try {
        if (!shippingInfo) return res.status(400).json({ msg: 'Shipping info is required' })
        await User.findByIdAndUpdate(_id, { savedShippingInfo: shippingInfo })
        res.status(200).json({ msg: 'Shipping info saved successfully' })
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while saving shipping info' })
    }
}

// ============================================================================
// Saved Addresses (address book) — multi-address CRUD
// ============================================================================

const sanitizeAddress = (a = {}) => ({
    label: (a.label || 'Home').toString().trim().slice(0, 30),
    fullName: (a.fullName || '').toString().trim(),
    email: (a.email || '').toString().trim(),
    phone: (a.phone || '').toString().trim(),
    address: (a.address || '').toString().trim(),
    city: (a.city || '').toString().trim(),
    state: (a.state || '').toString().trim(),
    stateCode: (a.stateCode || '').toString().trim().toUpperCase(),
    postalCode: (a.postalCode || '').toString().trim(),
    country: (a.country || 'Pakistan').toString().trim(),
    countryCode: (a.countryCode || 'PK').toString().trim().toUpperCase(),
    isDefault: !!a.isDefault,
});

const validateAddress = (a) => {
    if (!a.fullName || a.fullName.length < 2) return 'Full name is required';
    if (!a.address || a.address.length < 4) return 'Street address is required';
    if (!a.city) return 'City is required';
    return null;
};

exports.getAddresses = async (req, res) => {
    const { id: _id } = req.user;
    try {
        const user = await User.findById(_id).select('savedAddresses');
        res.status(200).json({ msg: 'Addresses fetched', addresses: user?.savedAddresses || [] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while fetching addresses' });
    }
};

exports.addAddress = async (req, res) => {
    const { id: _id } = req.user;
    try {
        const sanitized = sanitizeAddress(req.body || {});
        const err = validateAddress(sanitized);
        if (err) return res.status(400).json({ msg: err });

        const user = await User.findById(_id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        // First address is automatically default
        if (!user.savedAddresses || user.savedAddresses.length === 0) sanitized.isDefault = true;
        // If new one is default, unset others
        if (sanitized.isDefault) {
            user.savedAddresses.forEach((a) => { a.isDefault = false; });
        }
        user.savedAddresses.push(sanitized);
        await user.save();
        res.status(201).json({ msg: 'Address added', addresses: user.savedAddresses });
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while adding address' });
    }
};

exports.updateAddress = async (req, res) => {
    const { id: _id } = req.user;
    const { addressId } = req.params;
    try {
        const sanitized = sanitizeAddress(req.body || {});
        const err = validateAddress(sanitized);
        if (err) return res.status(400).json({ msg: err });

        const user = await User.findById(_id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        const target = user.savedAddresses.id(addressId);
        if (!target) return res.status(404).json({ msg: 'Address not found' });

        if (sanitized.isDefault) {
            user.savedAddresses.forEach((a) => { a.isDefault = false; });
        }
        Object.assign(target, sanitized);
        await user.save();
        res.status(200).json({ msg: 'Address updated', addresses: user.savedAddresses });
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while updating address' });
    }
};

exports.deleteAddress = async (req, res) => {
    const { id: _id } = req.user;
    const { addressId } = req.params;
    try {
        const user = await User.findById(_id);
        if (!user) return res.status(404).json({ msg: 'User not found' });
        const target = user.savedAddresses.id(addressId);
        if (!target) return res.status(404).json({ msg: 'Address not found' });
        const wasDefault = target.isDefault;
        target.deleteOne();
        // Promote first remaining as default if needed
        if (wasDefault && user.savedAddresses.length > 0) {
            user.savedAddresses[0].isDefault = true;
        }
        await user.save();
        res.status(200).json({ msg: 'Address deleted', addresses: user.savedAddresses });
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while deleting address' });
    }
};

exports.setDefaultAddress = async (req, res) => {
    const { id: _id } = req.user;
    const { addressId } = req.params;
    try {
        const user = await User.findById(_id);
        if (!user) return res.status(404).json({ msg: 'User not found' });
        const target = user.savedAddresses.id(addressId);
        if (!target) return res.status(404).json({ msg: 'Address not found' });
        user.savedAddresses.forEach((a) => { a.isDefault = false; });
        target.isDefault = true;
        await user.save();
        res.status(200).json({ msg: 'Default address updated', addresses: user.savedAddresses });
    } catch (error) {
        console.error(error);
        res.status(500).json({ msg: 'Server error while setting default address' });
    }
};

// Register / save an Expo push token for the authenticated user
exports.savePushToken = async (req, res) => {
    const { id: userId } = req.user;
    const { pushToken, revocationCredential } = req.body || {};
    if (!pushToken || typeof pushToken !== 'string') {
        return res.status(400).json({ msg: 'pushToken is required' });
    }
    const normalizedToken = pushToken.trim()
    if (!isValidExpoToken(normalizedToken)) {
        return res.status(400).json({ msg: 'Invalid Expo push token format' });
    }
    if (revocationCredential !== undefined && !isCredentialShape(revocationCredential)) {
        return res.status(400).json({ msg: 'Invalid revocationCredential format' })
    }
    try {
        const { credential, clientProvidedCredential } = await registerPushToken(
            userId,
            normalizedToken,
            revocationCredential
        )
        res.status(200).json({
            msg: 'Push token saved',
            registered: true,
            // Legacy clients can still migrate by persisting the generated
            // credential. New clients supply their own before making the
            // request, so a lost response is never an ambiguous commit.
            ...(!clientProvidedCredential ? { revocationCredential: credential } : {}),
        });
    } catch (error) {
        if (error?.code === 'PUSH_TOKEN_USER_NOT_FOUND') {
            return res.status(404).json({ msg: 'User not found' })
        }
        if (error?.code === 'PUSH_TOKEN_OWNERSHIP_CHANGED') {
            return res.status(409).json({ msg: 'Push token ownership changed. Please retry.' })
        }
        console.error('savePushToken error:', error.message);
        res.status(500).json({ msg: 'Server error saving push token' });
    }
};

// Remove a push token (e.g. on logout)
exports.removePushToken = async (req, res) => {
    const { id: userId } = req.user;
    const { pushToken } = req.body;
    if (!pushToken || typeof pushToken !== 'string') {
        return res.status(400).json({ msg: 'pushToken is required' });
    }
    const normalizedToken = pushToken.trim()
    if (!isValidExpoToken(normalizedToken)) {
        return res.status(400).json({ msg: 'Invalid Expo push token format' });
    }
    try {
        await unregisterPushTokenForUser(userId, normalizedToken)
        res.status(200).json({ msg: 'Push token removed' });
    } catch (error) {
        console.error('removePushToken error:', error.message);
        res.status(500).json({ msg: 'Server error removing push token' });
    }
};

// Public installation cleanup for offline logout. Possession of the random
// per-registration credential authorizes only this exact Expo token.
exports.revokePushToken = async (req, res) => {
    const { pushToken, revocationCredential } = req.body || {}
    if (!pushToken || typeof pushToken !== 'string' || !isValidExpoToken(pushToken.trim())) {
        return res.status(400).json({ msg: 'A valid pushToken is required' })
    }
    if (!isCredentialShape(revocationCredential)) {
        return res.status(400).json({ msg: 'A valid revocationCredential is required' })
    }

    try {
        const result = await revokePushTokenRegistration(pushToken.trim(), revocationCredential.trim())
        return res.status(200).json({
            msg: 'Push token revoked',
            revoked: true,
            alreadyRevoked: result.alreadyRevoked,
        })
    } catch (error) {
        if (error?.code === 'INVALID_PUSH_REVOCATION_CREDENTIAL') {
            return res.status(401).json({ msg: 'Invalid revocation credential' })
        }
        console.error('revokePushToken error:', error.message)
        return res.status(500).json({ msg: 'Server error revoking push token' })
    }
}

// ============================================================
// SELLER PROFILE — Change WhatsApp Number & Email
// ============================================================

const OTP = require('../models/OTP');
const CHANGE_COOLDOWN_DAYS = 30;

/**
 * POST /api/user/seller/change-whatsapp/initiate
 * Initiates WhatsApp number change by sending OTP to the NEW number.
 * Enforces 30-day cooldown.
 */
exports.initiateWhatsAppChange = async (req, res) => {
    const { id: userId } = req.user;
    const { newWhatsappNumber } = req.body;

    try {
        const user = await User.findById(userId);
        if (!user || user.role !== 'seller') {
            return res.status(403).json({ msg: 'Only sellers can change their WhatsApp number.' });
        }

        const cleanDigits = normalizePhoneDigits(newWhatsappNumber);
        if (cleanDigits.length < 10) {
            return res.status(400).json({ msg: 'Please provide a valid WhatsApp number.' });
        }

        // Check if the new number is the same as the current one
        const currentWhatsApp = normalizePhoneDigits(user.sellerInfo?.whatsappNumber);
        const currentPhone = normalizePhoneDigits(user.sellerInfo?.phoneNumber);
        if (cleanDigits === currentWhatsApp || cleanDigits === currentPhone) {
            return res.status(400).json({ msg: 'This is already your current WhatsApp number.' });
        }

        // 30-day cooldown check
        if (user.sellerInfo?.lastWhatsAppChange) {
            const daysSinceChange = (Date.now() - new Date(user.sellerInfo.lastWhatsAppChange).getTime()) / (1000 * 60 * 60 * 24);
            if (daysSinceChange < CHANGE_COOLDOWN_DAYS) {
                const daysLeft = Math.ceil(CHANGE_COOLDOWN_DAYS - daysSinceChange);
                return res.status(429).json({ msg: `You can only change your WhatsApp number once every 30 days. Please try again in ${daysLeft} day${daysLeft > 1 ? 's' : ''}.` });
            }
        }

        const identityConflict = await findWhatsAppIdentityConflict(cleanDigits, {
            channel: 'seller',
            userId,
        })
        if (identityConflict) {
            return res.status(409).json({ msg: conflictMessage(identityConflict) })
        }

        // Check if the new number is already used by another seller
        const existingSeller = await User.findOne(
            sellerPhoneConflictQuery(cleanDigits, userId)
        ).select('_id');
        if (existingSeller) {
            return res.status(409).json({ msg: 'This number is already associated with another seller account.' });
        }

        // Send WhatsApp OTP to the new number using the existing WhatsApp OTP system
        // We forward to the sellerWhatsapp send-otp logic
        const cfg = await WhatsAppConfig.findOne({ singletonKey: 'seller' });
        if (!cfg || cfg.status !== 'connected') {
            return res.status(503).json({ msg: 'WhatsApp verification service is temporarily unavailable.' });
        }

        if (!sellerEvolutionClient.isConfigured()) {
            return res.status(503).json({ msg: 'WhatsApp service is not configured.' });
        }

        let rateReservation;
        try {
            rateReservation = await reserveWhatsAppOtpSend({ number: cleanDigits, sellerId: userId });
        } catch (rateError) {
            if (rateError?.code?.startsWith('WHATSAPP_OTP_')) {
                return res.status(429).json({ msg: rateError.message });
            }
            throw rateError;
        }

        const otp = crypto.randomInt(100000, 1000000).toString();
        const message = `*Rozare Verification*\n\nYour verification code is: *${otp}*\n\nThis code expires in 2 minutes.\nDo not share this code with anyone.`;

        try {
            await sellerEvolutionClient.sendText(cleanDigits, message);
        } catch (sendErr) {
            await releaseWhatsAppOtpSend(rateReservation).catch(() => null);
            return res.status(502).json({ msg: 'Failed to send verification code. Please try again.' });
        }

        await WhatsAppOTP.create({
            number: cleanDigits,
            otp,
            sellerId: userId,
            attempts: 0,
            verified: false,
        });

        res.status(200).json({ msg: 'Verification code sent to the new WhatsApp number.' });
    } catch (error) {
        console.error('initiateWhatsAppChange error:', error.message);
        res.status(500).json({ msg: 'Server error. Please try again.' });
    }
};

/**
 * POST /api/user/seller/change-whatsapp/verify
 * Verifies OTP and updates the WhatsApp number.
 */
exports.verifyWhatsAppChange = async (req, res) => {
    const { id: userId } = req.user;
    const { newWhatsappNumber, otp } = req.body;

    try {
        const user = await User.findById(userId);
        if (!user || user.role !== 'seller') {
            return res.status(403).json({ msg: 'Only sellers can change their WhatsApp number.' });
        }

        if (!newWhatsappNumber || !otp) {
            return res.status(400).json({ msg: 'Number and OTP are required.' });
        }

        const cleanDigits = normalizePhoneDigits(newWhatsappNumber);
        if (cleanDigits.length < 10 || !/^\d{6}$/.test(String(otp).trim())) {
            return res.status(400).json({ msg: 'Invalid WhatsApp number or code format.' });
        }

        const currentDigits = normalizePhoneDigits(user.sellerInfo?.whatsappNumber);
        if (user.sellerInfo?.whatsappVerified && currentDigits === cleanDigits) {
            return res.status(400).json({ msg: 'This is already your current WhatsApp number.' });
        }

        // Re-check the cooldown at verification time so an older code cannot
        // bypass a number change completed after that code was issued.
        if (user.sellerInfo?.lastWhatsAppChange) {
            const daysSinceChange = (Date.now() - new Date(user.sellerInfo.lastWhatsAppChange).getTime()) / (1000 * 60 * 60 * 24);
            if (daysSinceChange < CHANGE_COOLDOWN_DAYS) {
                const daysLeft = Math.ceil(CHANGE_COOLDOWN_DAYS - daysSinceChange);
                await WhatsAppOTP.deleteMany({ number: cleanDigits, sellerId: userId });
                return res.status(429).json({ msg: `You can only change your WhatsApp number once every 30 days. Please try again in ${daysLeft} day${daysLeft > 1 ? 's' : ''}.` });
            }
        }

        const verification = await verifyAndClaimWhatsAppOTP({
            number: cleanDigits,
            sellerId: userId,
            otp: String(otp).trim(),
            validAfter: new Date(Date.now() - 2 * 60 * 1000),
            maxAttempts: 5,
        });

        if (verification.status === 'missing') {
            return res.status(400).json({ msg: 'No verification code found. Please request a new one.' });
        }
        if (verification.status === 'locked') {
            return res.status(400).json({ msg: 'Too many wrong attempts. Please request a new code.' });
        }
        if (verification.status === 'invalid') {
            return res.status(400).json({ msg: 'Invalid code. Please try again.' });
        }
        const otpRecord = verification.record;

        const identityConflict = await findWhatsAppIdentityConflict(cleanDigits, {
            channel: 'seller',
            userId,
        })
        if (identityConflict) {
            await WhatsAppOTP.deleteOne({ _id: otpRecord._id })
            return res.status(409).json({ msg: conflictMessage(identityConflict) })
        }

        // Double-check the number isn't taken (race condition protection)
        const existingSeller = await User.findOne(
            sellerPhoneConflictQuery(cleanDigits, userId)
        ).select('_id');
        if (existingSeller) {
            await WhatsAppOTP.deleteOne({ _id: otpRecord._id });
            return res.status(409).json({ msg: 'This number is now associated with another seller account. Please use a different number.' });
        }

        // OTP matches — update user's WhatsApp number
        const canonicalNumber = toE164PhoneNumber(cleanDigits);
        try {
            const updatedUser = await User.findOneAndUpdate(
                { _id: userId, role: 'seller', updatedAt: user.updatedAt },
                {
                    $set: {
                        'sellerInfo.whatsappNumber': canonicalNumber,
                        'sellerInfo.phoneNumber': canonicalNumber,
                        'sellerInfo.whatsappDigits': cleanDigits,
                        'sellerInfo.whatsappVerified': true,
                        'sellerInfo.lastWhatsAppChange': new Date(),
                    },
                },
                { new: true }
            );
            if (!updatedUser) {
                await WhatsAppOTP.deleteOne({ _id: otpRecord._id });
                return res.status(409).json({
                    msg: 'Your seller profile changed while this code was being verified. Please request a new code.',
                });
            }
        } catch (updateError) {
            await WhatsAppOTP.deleteOne({ _id: otpRecord._id });
            if (updateError?.code === 11000) {
                return res.status(409).json({
                    msg: 'This number is now associated with another seller account. Please use a different number.',
                });
            }
            throw updateError;
        }
        await WhatsAppOTP.deleteOne({ _id: otpRecord._id });

        res.status(200).json({ msg: 'WhatsApp number updated successfully.', whatsappNumber: canonicalNumber });
    } catch (error) {
        console.error('verifyWhatsAppChange error:', error.message);
        res.status(500).json({ msg: 'Server error. Please try again.' });
    }
};

/**
 * POST /api/user/seller/change-email/initiate
 * Sends OTP to the NEW email address. Enforces 30-day cooldown.
 */
exports.initiateEmailChange = async (req, res) => {
    const { id: userId } = req.user;
    const { newEmail } = req.body;

    try {
        const user = await User.findById(userId);
        if (!user || user.role !== 'seller') {
            return res.status(403).json({ msg: 'Only sellers can change their email here.' });
        }

        if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
            return res.status(400).json({ msg: 'Please provide a valid email address.' });
        }

        if (newEmail.toLowerCase() === user.email.toLowerCase()) {
            return res.status(400).json({ msg: 'This is already your current email.' });
        }

        // 30-day cooldown check
        if (user.sellerInfo?.lastEmailChange) {
            const daysSinceChange = (Date.now() - new Date(user.sellerInfo.lastEmailChange).getTime()) / (1000 * 60 * 60 * 24);
            if (daysSinceChange < CHANGE_COOLDOWN_DAYS) {
                const daysLeft = Math.ceil(CHANGE_COOLDOWN_DAYS - daysSinceChange);
                return res.status(429).json({ msg: `You can only change your email once every 30 days. Please try again in ${daysLeft} day${daysLeft > 1 ? 's' : ''}.` });
            }
        }

        // Check if the new email is already used by another user
        const existingUser = await User.findOne({ email: newEmail.toLowerCase(), _id: { $ne: userId } });
        if (existingUser) {
            return res.status(409).json({ msg: 'This email is already in use by another account.' });
        }

        // Generate OTP and send to new email
        const otpCode = crypto.randomInt(100000, 1000000).toString();
        // A seller may have only one live email-change challenge. Reissuing a
        // code invalidates challenges for every previously requested address.
        await OTP.deleteMany({
            'userData.type': 'email-change',
            'userData.sellerId': userId,
        });

        const otpDoc = new OTP({
            email: newEmail.toLowerCase(),
            otp: otpCode,
            userData: { sellerId: userId, type: 'email-change' }
        });
        await otpDoc.save();

        // Send professional email
        const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Verify Email Change</title></head>
<body style="margin:0;padding:0;background-color:#f0f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;line-height:1.6;">
    <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <div style="background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 50%,#a78bfa 100%);padding:48px 32px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">Verify Your New Email</h1>
            <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:15px;">Email change verification</p>
        </div>
        <div style="padding:40px 32px;">
            <p style="color:#334155;font-size:16px;margin:0 0 20px;">Hi <strong>${user.username}</strong>,</p>
            <p style="color:#475569;font-size:15px;margin:0 0 28px;">
                You requested to change your email address on Rozare. Enter the code below to verify this new email:
            </p>
            <div style="background:linear-gradient(135deg,#f8faff 0%,#f0f4ff 100%);border:2px solid #e0e7ff;border-radius:12px;padding:28px 20px;text-align:center;margin:0 0 28px;">
                <p style="margin:0 0 12px;color:#64748b;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;">Verification Code</p>
                <div style="font-size:38px;font-weight:800;color:#6366f1;letter-spacing:10px;font-family:'Courier New',monospace;padding:8px 0;">${otpCode}</div>
                <div style="margin-top:12px;display:inline-block;background:#fef3c7;border-radius:20px;padding:6px 14px;">
                    <span style="color:#92400e;font-size:12px;font-weight:600;">Expires in 10 minutes</span>
                </div>
            </div>
            <div style="border-top:1px solid #e2e8f0;padding-top:20px;">
                <p style="color:#94a3b8;font-size:13px;margin:0;">If you didn't request this change, please ignore this email. Your account is safe.</p>
            </div>
        </div>
        <div style="background:#f8fafc;padding:24px 32px;text-align:center;border-top:1px solid #e2e8f0;">
            <p style="margin:0 0 4px;color:#94a3b8;font-size:12px;">&copy; ${new Date().getFullYear()} Rozare. All rights reserved.</p>
        </div>
    </div>
</body>
</html>`;

        await sendEmail({
            to: newEmail,
            subject: 'Verify Your New Email - Rozare',
            text: `Your verification code is: ${otpCode}. Valid for 10 minutes.`,
            html
        });

        res.status(200).json({ msg: 'Verification code sent to your new email address.' });
    } catch (error) {
        console.error('initiateEmailChange error:', error.message);
        res.status(500).json({ msg: 'Server error. Please try again.' });
    }
};

/**
 * POST /api/user/seller/change-email/verify
 * Verifies OTP and updates the email address.
 */
exports.verifyEmailChange = async (req, res) => {
    const { id: userId } = req.user;
    const { newEmail, otp } = req.body;

    try {
        const user = await User.findById(userId);
        if (!user || user.role !== 'seller') {
            return res.status(403).json({ msg: 'Only sellers can change their email here.' });
        }

        if (!newEmail || !otp) {
            return res.status(400).json({ msg: 'Email and OTP are required.' });
        }

        // Re-check at consumption time. A code issued before another successful
        // change must not bypass the 30-day policy.
        if (user.sellerInfo?.lastEmailChange) {
            const daysSinceChange = (Date.now() - new Date(user.sellerInfo.lastEmailChange).getTime()) / (1000 * 60 * 60 * 24);
            if (daysSinceChange < CHANGE_COOLDOWN_DAYS) {
                const daysLeft = Math.ceil(CHANGE_COOLDOWN_DAYS - daysSinceChange);
                await OTP.deleteMany({
                    'userData.type': 'email-change',
                    'userData.sellerId': userId,
                });
                return res.status(429).json({ msg: `You can only change your email once every 30 days. Please try again in ${daysLeft} day${daysLeft > 1 ? 's' : ''}.` });
            }
        }

        // Find the OTP record
        const otpDoc = await OTP.findOne({ email: newEmail.toLowerCase(), otp });
        if (!otpDoc) {
            return res.status(400).json({ msg: 'Invalid or expired verification code.' });
        }

        // Verify it's for an email change
        if (
            otpDoc.userData?.type !== 'email-change' ||
            String(otpDoc.userData?.sellerId || '') !== String(userId)
        ) {
            return res.status(400).json({ msg: 'Invalid verification code for this request.' });
        }

        // Double-check email is not taken (race condition)
        const existingUser = await User.findOne({ email: newEmail.toLowerCase(), _id: { $ne: userId } });
        if (existingUser) {
            await OTP.deleteOne({ _id: otpDoc._id });
            return res.status(409).json({ msg: 'This email is now in use by another account.' });
        }

        // Update email
        user.email = newEmail.toLowerCase();
        user.sellerInfo.lastEmailChange = new Date();
        await user.save();
        await OTP.deleteMany({
            'userData.type': 'email-change',
            'userData.sellerId': userId,
        });

        // Generate new JWT with updated email
        const jwt = require('jsonwebtoken');
        const token = jwt.sign(
            { id: user._id, username: user.username, email: user.email, role: user.role, avatar: user.profilePicture || user.avatar },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.status(200).json({ msg: 'Email updated successfully.', email: user.email, token });
    } catch (error) {
        console.error('verifyEmailChange error:', error.message);
        res.status(500).json({ msg: 'Server error. Please try again.' });
    }
};
