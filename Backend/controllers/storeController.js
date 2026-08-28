const Store = require('../models/Store');
const User = require('../models/User');
const crypto = require('crypto');
const { initializeSubscription } = require('./subscriptionController');
const { publicProductFilter } = require('../services/productModerationService');
const { activeStoreQuery } = require('../services/publicCatalogService');
const { convertAmountSync, isSupportedCurrency } = require('../services/currencyService');
const { getProductCurrency, getProductEffectivePrice } = require('../services/productPricingService');
const {
    resolveRequestedCurrency,
    sellerOrderSummary,
    isSellerRevenueRecognized,
    sumOrderAmountsInCurrency,
    roundMoney,
} = require('../services/orderMoneyService');
const StoreView = require('../models/StoreView');
const { normalizeSocialLinks } = require('../services/socialLinksService');
const { trackStoreVerificationLead } = require('../services/metaConversionsApi');
const {
    ensureStoreProductCurrencyInitialized,
    requestProductCurrencyChange,
    cancelPendingProductCurrencyChange,
    convertPendingProductPrices,
    sellerDefaultProductCurrency,
    normalizeProductCurrency,
} = require('../services/storeProductCurrencyService');
const {
    normalizeStoreTheme,
    sellerCanUseCustomStoreTheme,
    ensureStoreThemeEntitlement,
} = require('../services/storeThemeService');
const {
    buyerLocationFromRequest,
    ensureStoreVisibilityInitialized,
    findVisibleStores,
    isStoreVisibleToBuyer,
    normalizeStoreVisibility,
} = require('../services/storeVisibilityService');
const {
    normalizeStorePaymentPolicy,
    PAYMENT_POLICY_LABELS,
} = require('../services/storePaymentPolicyService');
const { normalizeReturnPolicy } = require('../services/returnPolicyService');
const { attachStoreReviewSummaries } = require('../services/storeReviewService');
const { getSellerInventoryOverview } = require('../services/sellerInventoryOverviewService');
const { trustedRequestIp } = require('../services/requestIdentityService');
const {
    changeStoreSlug,
    releaseExpiredStoreSlug,
} = require('../services/subdomainSlugMutationService');
const {
    MAX_STORE_SLUG_LENGTH,
    validateStoreSlug,
    slugifyStoreName,
} = require('../utils/storeSlug');
const { runInTransaction } = require('../services/walletService');
const {
    enqueueStoreCreatedNotification,
    enqueueStoreVerificationNotification,
} = require('../services/sellerOperationalNotificationService');
const {
    blockedIdSet,
    getBlockedUserIds,
    isUserBlocked,
} = require('../services/userBlockService');

const comparablePriceUSD = (product) =>
    convertAmountSync(getProductEffectivePrice(product), getProductCurrency(product), 'USD');
const hideBlockedStores = async (req, stores) => {
    const blocked = blockedIdSet(await getBlockedUserIds(req));
    return blocked.size
        ? (stores || []).filter(store => !blocked.has(String(store?.seller?._id || store?.seller || '')))
        : (stores || []);
};
const storeAnalyticsDataError = label => {
    const error = new Error(`Stored store analytics ${label} is invalid. Analytics are unavailable until the source data is corrected.`);
    error.code = 'STORE_ANALYTICS_DATA_INVALID';
    error.statusCode = 409;
    return error;
};
const requireStoreAnalyticsCount = (value, label) => {
    if (value === undefined) return 0;
    if (!Number.isSafeInteger(value) || value < 0) throw storeAnalyticsDataError(label);
    return value;
};
const requireStoreAnalyticsMoney = (value, label) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw storeAnalyticsDataError(label);
    }
    try {
        if (roundMoney(value) !== value) throw storeAnalyticsDataError(label);
    } catch (error) {
        if (error?.code === 'STORE_ANALYTICS_DATA_INVALID') throw error;
        throw storeAnalyticsDataError(label);
    }
    return value;
};
const isActiveSellerAccount = async sellerId => Boolean(sellerId && await User.exists({
    _id: sellerId,
    role: 'seller',
    status: 'active',
}));
const requireActiveAdminActor = (req, res) => {
    if (!req.user?.id && !req.user?._id) {
        res.status(401).json({ msg: 'Authentication required', code: 'AUTH_REQUIRED' });
        return false;
    }
    if (req.user.role !== 'admin') {
        res.status(403).json({ msg: 'Admin access only', code: 'ADMIN_REQUIRED' });
        return false;
    }
    if (req.user.status !== 'active') {
        res.status(403).json({
            msg: 'Your account is blocked. For further details contact support.',
            code: 'ACCOUNT_BLOCKED',
        });
        return false;
    }
    return true;
};
const storeTransitionError = (message, statusCode) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
};
const optionalVerificationReason = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value !== 'string') {
        throw storeTransitionError('Verification reason must be text', 400);
    }
    const reason = value.trim().replace(/\s+/g, ' ');
    if (!reason || reason.length > 500) {
        throw storeTransitionError('Verification reason must be between 1 and 500 characters', 400);
    }
    return reason;
};

const cleanList = (items) => [...new Set(
    (items || [])
        .filter(Boolean)
        .map(item => String(item).trim())
        .filter(Boolean)
)].sort((a, b) => a.localeCompare(b));

// Helper function to generate unique slug
const generateUniqueSlug = async (storeName) => {
    const generated = slugifyStoreName(storeName);
    const baseSlug = generated || `store-${crypto.randomBytes(4).toString('hex')}`;
    let slug = baseSlug;

    // Check if slug exists
    let existingStore = await Store.findOne({ storeSlug: slug });
    let counter = 1;

    while (existingStore) {
        const suffix = `-${counter}`;
        slug = `${baseSlug.slice(0, MAX_STORE_SLUG_LENGTH - suffix.length).replace(/-+$/g, '')}${suffix}`;
        existingStore = await Store.findOne({ storeSlug: slug });
        counter++;
    }

    return slug;
};

// ── Change cooldown windows ───────────────────────────────────────────
const COOLDOWN_DAYS = { storeSlug: 30, storeName: 7, sellerType: 30 };
const FIELD_LABELS = { storeSlug: 'subdomain', storeName: 'name', sellerType: 'type' };
const daysBetween = (later, earlier) =>
    Math.ceil((later.getTime() - earlier.getTime()) / (1000 * 60 * 60 * 24));
function checkCooldown(field, lastAt) {
    if (!lastAt) return null;
    const cooldown = COOLDOWN_DAYS[field];
    const next = new Date(new Date(lastAt).getTime() + cooldown * 24 * 60 * 60 * 1000);
    const now = new Date();
    if (now >= next) return null;
    return {
        field,
        label: FIELD_LABELS[field],
        cooldownDays: cooldown,
        daysRemaining: Math.max(1, daysBetween(next, now)),
        nextAllowedAt: next.toISOString(),
    };
}

// Lazily release a slug if the owner is blocked, not subdomain-purchased,
// and the 7-day removal window has passed. Returns true if released.
async function releaseExpiredSlug(store) {
    if (!store) return false;
    const result = await releaseExpiredStoreSlug({
        storeId: store._id,
        sellerId: store.seller,
        expectedSlug: store.storeSlug,
        now: new Date(),
        reason: 'Lazy release after the inactive-store grace period expired',
    });
    return result.released;
}
exports._releaseExpiredSlug = releaseExpiredSlug;
exports.checkSubdomainAvailability = async (req, res) => {
    try {
        const { slug } = req.params;

        const validation = validateStoreSlug(slug);
        if (!validation.valid) {
            return res.status(validation.code === 'RESERVED_SUBDOMAIN' ? 200 : 400).json({
                available: false,
                msg: validation.msg,
                code: validation.code,
            });
        }
        const normalizedSlug = validation.slug;

        // Check if slug is taken
        let existingStore = await Store.findOne({ storeSlug: normalizedSlug });

        // If a store has the slug but is past its blocked-removal window, free it
        if (existingStore) {
            const released = await releaseExpiredSlug(existingStore);
            if (released) existingStore = null;
        }

        if (existingStore) {
            // If it's the current user's store, it's "available" for them
            if (req.user && existingStore.seller.toString() === req.user.id) {
                return res.status(200).json({
                    available: true,
                    isOwned: true,
                    msg: 'This is your current subdomain'
                });
            }
            return res.status(200).json({
                available: false,
                msg: 'This subdomain is already taken'
            });
        }

        res.status(200).json({
            available: true,
            msg: 'Subdomain is available'
        });
    } catch (error) {
        console.error('Check subdomain availability error:', error);
        res.status(500).json({ msg: 'Server error while checking availability' });
    }
};

// Create a new store
exports.createStore = async (req, res) => {
    try {
        const { storeName, storeSlug, description, logo, banner, socialLinks, address, returnPolicy, sellerType, storeTheme, visibility, paymentPolicy } = req.body;
        const sellerId = req.user.id;

        if (
            Object.prototype.hasOwnProperty.call(req.body, 'productCurrency')
            && (
                typeof req.body.productCurrency !== 'string'
                || !req.body.productCurrency.trim()
                || !isSupportedCurrency(req.body.productCurrency)
            )
        ) {
            return res.status(400).json({
                msg: 'Choose a supported product currency: USD, PKR, EUR, or GBP.',
                code: 'PRODUCT_CURRENCY_NOT_SUPPORTED',
            });
        }

        // Check if seller already has a store
        const existingStore = await Store.findOne({ seller: sellerId });
        if (existingStore) {
            return res.status(409).json({ msg: 'You already have a store. Please update your existing store.' });
        }

        // Validate store name
        if (!storeName || storeName.trim().length < 3) {
            return res.status(400).json({ msg: 'Store name must be at least 3 characters long' });
        }

        if (storeName.length > 50) {
            return res.status(400).json({ msg: 'Store name cannot exceed 50 characters' });
        }

        // Check if store name already exists (case-insensitive)
        const duplicateStore = await Store.findOne({
            storeName: { $regex: new RegExp(`^${storeName.trim()}$`, 'i') }
        });
        if (duplicateStore) {
            return res.status(409).json({ msg: 'A store with this name already exists. Please choose a different name.' });
        }

        let finalSlug;
        if (storeSlug) {
            // Validate custom slug
            const validation = validateStoreSlug(storeSlug);
            if (!validation.valid) {
                return res.status(400).json({ msg: validation.msg, code: validation.code });
            }
            const duplicateSlug = await Store.findOne({ storeSlug: validation.slug });
            if (duplicateSlug) {
                return res.status(409).json({ msg: 'This subdomain is already taken' });
            }
            finalSlug = validation.slug;
        } else {
            // Generate unique slug
            finalSlug = await generateUniqueSlug(storeName);
        }

        const seller = await User.findById(sellerId)
            .select('currency sellerInfo.country sellerInfo.countryCode savedShippingInfo.country savedShippingInfo.countryCode')
            .lean();
        const initialAddress = address || {
            street: '',
            city: '',
            state: '',
            country: '',
            postalCode: ''
        };
        const canUseCustomTheme = await sellerCanUseCustomStoreTheme(sellerId);
        const normalizedStoreTheme = storeTheme !== undefined
            ? normalizeStoreTheme(storeTheme, { allowCustom: canUseCustomTheme })
            : normalizeStoreTheme();

        // Construct immutable input outside the transaction, but create a new
        // Mongoose document on every callback attempt. MongoDB may retry the
        // callback after a transient conflict; re-saving an aborted document
        // would otherwise issue an update against a row that never committed.
        const storeData = {
            seller: sellerId,
            storeName: storeName.trim(),
            storeSlug: finalSlug,
            sellerType: sellerType === 'brand' ? 'brand' : 'store',
            description: description || '',
            productCurrency: normalizeProductCurrency(
                Object.prototype.hasOwnProperty.call(req.body, 'productCurrency')
                    ? req.body.productCurrency
                    : sellerDefaultProductCurrency({ address: initialAddress }, seller)
            ),
            productCurrencyStatus: 'active',
            storeTheme: normalizedStoreTheme,
            paymentPolicy: normalizeStorePaymentPolicy(paymentPolicy),
            paymentPolicyUpdatedAt: paymentPolicy !== undefined ? new Date() : null,
            visibility: normalizeStoreVisibility(visibility, {
                store: { address: initialAddress },
                seller,
            }),
            logo: logo || '',
            banner: banner || '',
            socialLinks: normalizeSocialLinks(socialLinks),
            address: initialAddress,
            returnPolicy: normalizeReturnPolicy(returnPolicy || {}, { strict: returnPolicy !== undefined })
        };

        let newStore;
        await runInTransaction(async session => {
            [newStore] = await Store.create([storeData], { session });
            await enqueueStoreCreatedNotification(newStore, { session });
        });

        // Initialize seller subscription (15-day free trial)
        try {
            await initializeSubscription(sellerId);
        } catch (subErr) {
            console.error('Initialize subscription error:', subErr.message);
        }

        res.status(201).json({
            msg: 'Store created successfully',
            store: newStore
        });
    } catch (error) {
        console.error('Create store error:', error);
        res.status(error.status || 500).json({ msg: error.message || 'Server error while creating store' });
    }
};

// Get seller's own store
exports.getMyStore = async (req, res) => {
    try {
        const sellerId = req.user.id;

        const store = await Store.findOne({ seller: sellerId });

        if (!store) {
            return res.status(404).json({ msg: 'You have not created a store yet' });
        }

        // Ensure socialLinks exists (for backward compatibility with old stores)
        if (!store.socialLinks) {
            store.socialLinks = {
                website: '',
                facebook: '',
                instagram: '',
                twitter: '',
                youtube: '',
                tiktok: ''
            };
            await store.save();
        }

        const seller = await User.findById(sellerId)
            .select('currency sellerInfo.country sellerInfo.countryCode savedShippingInfo.country savedShippingInfo.countryCode')
            .lean();

        await ensureStoreVisibilityInitialized(store, seller);
        await ensureStoreProductCurrencyInitialized(sellerId, { store });
        await ensureStoreThemeEntitlement(sellerId, store);

        res.status(200).json({
            msg: 'Store fetched successfully',
            store
        });
    } catch (error) {
        console.error('Get my store error:', error);
        res.status(500).json({ msg: 'Server error while fetching store' });
    }
};

exports.getProductCurrencySettings = async (req, res) => {
    try {
        const state = await ensureStoreProductCurrencyInitialized(req.user.id);
        if (!state.hasStore) {
            return res.status(404).json({ msg: 'You have not created a store yet', productCurrency: state });
        }
        res.status(200).json({ msg: 'Product currency settings fetched successfully', productCurrency: state });
    } catch (error) {
        console.error('Get product currency settings error:', error);
        res.status(500).json({ msg: 'Server error while fetching product currency settings' });
    }
};

exports.updateProductCurrencySettings = async (req, res) => {
    try {
        const state = await requestProductCurrencyChange(req.user.id, req.body.currency, {
            confirm: req.body.confirm === true,
        });
        const statusCode = state.requiresConfirmation ? 409 : 200;
        res.status(statusCode).json({
            msg: state.msg || (state.status === 'pending_conversion'
                ? `Product currency change to ${state.pendingCurrency} is pending. Convert existing product prices from the Products tab before adding more products.`
                : `Product currency is now ${state.activeCurrency}.`),
            productCurrency: state,
            requiresConfirmation: state.requiresConfirmation === true,
        });
    } catch (error) {
        console.error('Update product currency settings error:', error);
        res.status(error.status || 500).json({ msg: error.message || 'Server error while updating product currency settings' });
    }
};

exports.convertProductCurrencyPrices = async (req, res) => {
    try {
        const result = await convertPendingProductPrices(req.user.id);
        res.status(200).json({
            msg: result.converted > 0
                ? `Converted ${result.converted} product price${result.converted === 1 ? '' : 's'} to ${result.state.activeCurrency}.`
                : 'No pending product currency conversion found.',
            converted: result.converted,
            productCurrency: result.state,
        });
    } catch (error) {
        console.error('Convert product currency prices error:', error);
        res.status(error.status || 500).json({ msg: error.message || 'Server error while converting product prices' });
    }
};

exports.cancelProductCurrencyChange = async (req, res) => {
    try {
        const state = await cancelPendingProductCurrencyChange(req.user.id);
        res.status(200).json({
            msg: `Product currency change canceled. Product currency is back to ${state.activeCurrency}.`,
            productCurrency: state,
        });
    } catch (error) {
        console.error('Cancel product currency change error:', error);
        res.status(error.status || 500).json({ msg: error.message || 'Server error while canceling product currency change' });
    }
};

// Update store
exports.updateStore = async (req, res) => {
    const sellerId = req.user.id;
    let pendingSlugChange = null;
    try {
        const { storeName, storeSlug, description, logo, banner, socialLinks, address, returnPolicy, sellerType, storeTheme, visibility, paymentPolicy } = req.body;

        // Find seller's store
        let store = await Store.findOne({ seller: sellerId });

        if (!store) {
            return res.status(404).json({ msg: 'Store not found. Please create a store first.' });
        }

        // Detect intended changes (against current values) before applying
        const wantsNameChange = !!storeName && storeName.trim().toLowerCase() !== store.storeName.toLowerCase();
        const slugValidation = storeSlug ? validateStoreSlug(storeSlug) : null;
        if (slugValidation && !slugValidation.valid) {
            return res.status(400).json({ msg: slugValidation.msg, code: slugValidation.code });
        }
        const normalizedRequestedSlug = slugValidation?.slug || '';
        const wantsSlugChange = !!normalizedRequestedSlug && normalizedRequestedSlug !== store.storeSlug;
        const wantsTypeChange = sellerType !== undefined &&
            (sellerType === 'store' || sellerType === 'brand') &&
            sellerType !== (store.sellerType || 'store');
        const wantsThemeChange = storeTheme !== undefined;
        const wantsVisibilityChange = visibility !== undefined;
        const wantsPaymentPolicyChange = paymentPolicy !== undefined &&
            normalizeStorePaymentPolicy(paymentPolicy) !== normalizeStorePaymentPolicy(store.paymentPolicy);
        const wantsReturnPolicyChange = returnPolicy !== undefined;

        // Block changes while the store is blocked (subscription ended)
        if ((wantsNameChange || wantsSlugChange || wantsTypeChange || wantsThemeChange || wantsVisibilityChange || wantsPaymentPolicyChange || wantsReturnPolicyChange) && store.isActive === false) {
            return res.status(423).json({
                msg: 'Your store is blocked. Reactivate your subscription before changing this.',
                blocked: true,
            });
        }

        // Enforce per-field cooldowns
        for (const [want, field] of [
            [wantsNameChange, 'storeName'],
            [wantsSlugChange, 'storeSlug'],
            [wantsTypeChange, 'sellerType'],
        ]) {
            if (!want) continue;
            const lastAt = field === 'storeName' ? store.lastNameChangeAt
                : field === 'storeSlug' ? store.lastSlugChangeAt
                : store.lastTypeChangeAt;
            const cd = checkCooldown(field, lastAt);
            if (cd) {
                return res.status(423).json({
                    msg: `You can change your ${cd.label} again in ${cd.daysRemaining} day(s).`,
                    cooldown: cd,
                });
            }
        }

        // Validate store name if provided
        if (storeName) {
            if (storeName.trim().length < 3) {
                return res.status(400).json({ msg: 'Store name must be at least 3 characters long' });
            }
            if (storeName.length > 50) {
                return res.status(400).json({ msg: 'Store name cannot exceed 50 characters' });
            }

            // Check if store name already exists (case-insensitive), excluding current store
            if (wantsNameChange) {
                const duplicateStore = await Store.findOne({
                    storeName: { $regex: new RegExp(`^${storeName.trim()}$`, 'i') },
                    _id: { $ne: store._id }
                });
                if (duplicateStore) {
                    return res.status(409).json({ msg: 'A store with this name already exists. Please choose a different name.' });
                }
            }
            store.storeName = storeName.trim();
            if (wantsNameChange) store.lastNameChangeAt = new Date();
        }

        // Handle custom slug/subdomain update if provided
        if (wantsSlugChange) {
            if (store.subdomainPurchase?.paymentRiskState === 'open') {
                return res.status(423).json({
                    msg: 'Your purchased subdomain has an unresolved Stripe payment dispute. It cannot be changed until the dispute is resolved.',
                    code: 'SUBDOMAIN_PAYMENT_RISK_OPEN',
                });
            }
            // Warn: changing slug will forfeit the purchased subdomain ownership
            // If seller has purchased the subdomain, require explicit confirmation
            if (store.subdomainPurchase?.isPurchased && store.subdomainPurchase?.expiresAt && new Date(store.subdomainPurchase.expiresAt) > new Date()) {
                if (!req.body.confirmSubdomainChange) {
                    return res.status(400).json({
                        msg: `You have purchased the subdomain "${store.storeSlug}.rozare.com". Changing it will forfeit your ownership of the old subdomain — anyone else can claim it. To proceed, resend with confirmSubdomainChange: true.`,
                        requiresConfirmation: true,
                        currentSubdomain: store.storeSlug,
                        newSubdomain: normalizedRequestedSlug,
                    });
                }
            }

            // Check if available (lazy-release stale blocked slugs)
            let duplicateSlug = await Store.findOne({
                storeSlug: normalizedRequestedSlug,
                _id: { $ne: store._id }
            });
            if (duplicateSlug) {
                const released = await releaseExpiredSlug(duplicateSlug);
                if (released) duplicateSlug = null;
            }
            if (duplicateSlug) {
                return res.status(409).json({ msg: 'This subdomain is already taken by another store' });
            }

            pendingSlugChange = {
                expectedSlug: store.storeSlug,
                newSlug: normalizedRequestedSlug,
                confirmPurchasedForfeit: req.body.confirmSubdomainChange === true,
            };
        }
        // Note: we no longer auto-regenerate the slug from the store name —
        // the subdomain is now an independent, cooldown-protected field.

        // Update other fields
        if (description !== undefined) store.description = description;
        if (logo !== undefined) store.logo = logo;
        if (banner !== undefined) store.banner = banner;
        if (sellerType !== undefined && (sellerType === 'store' || sellerType === 'brand')) {
            if (wantsTypeChange) store.lastTypeChangeAt = new Date();
            store.sellerType = sellerType;
        }
        if (paymentPolicy !== undefined) {
            store.paymentPolicy = normalizeStorePaymentPolicy(paymentPolicy);
            store.paymentPolicyUpdatedAt = new Date();
        }
        if (socialLinks !== undefined) {
            console.log('Updating socialLinks:', socialLinks);
            store.socialLinks = normalizeSocialLinks(socialLinks);
            store.markModified('socialLinks'); // Mark nested object as modified
        }

        if (address !== undefined) {
            console.log('Updating address:', address);
            store.address = {
                street: address.street || '',
                city: address.city || '',
                state: address.state || '',
                stateCode: address.stateCode || '',
                country: address.country || '',
                countryCode: address.countryCode || '',
                postalCode: address.postalCode || ''
            };
            store.markModified('address');
        }

        if (returnPolicy !== undefined) {
            store.returnPolicy = normalizeReturnPolicy(returnPolicy, { strict: true });
            store.markModified('returnPolicy');
        }

        if (storeTheme !== undefined) {
            const canUseCustomTheme = await sellerCanUseCustomStoreTheme(sellerId);
            store.storeTheme = normalizeStoreTheme(storeTheme, { allowCustom: canUseCustomTheme });
            store.markModified('storeTheme');
        } else {
            await ensureStoreThemeEntitlement(sellerId, store);
        }

        if (visibility !== undefined) {
            const seller = await User.findById(sellerId)
                .select('currency sellerInfo.country sellerInfo.countryCode savedShippingInfo.country savedShippingInfo.countryCode')
                .lean();
            store.visibility = normalizeStoreVisibility(visibility, { store, seller });
            store.markModified('visibility');
        } else {
            const seller = await User.findById(sellerId)
                .select('currency sellerInfo.country sellerInfo.countryCode savedShippingInfo.country savedShippingInfo.countryCode')
                .lean();
            await ensureStoreVisibilityInitialized(store, seller);
        }

        // Validate every non-slug edit before the irreversible public-hostname
        // CAS. The canonical service then serializes the slug against Stripe
        // Checkout, snapshots any legacy paid ownership into its immutable
        // old-slug ledger, and records the actor audit entry.
        await store.validate();
        if (pendingSlugChange) {
            const protectedSlugPaths = new Set([
                'storeSlug',
                'lastSlugChangeAt',
                'subdomainPurchase',
                'subdomainResourceLock',
                'subdomainSlugHistory',
                '_id',
                '__v',
            ]);
            const additionalSet = {};
            for (const path of new Set(store.modifiedPaths().map(field => field.split('.')[0]))) {
                if (!protectedSlugPaths.has(path)) additionalSet[path] = store.get(path);
            }
            const slugResult = await changeStoreSlug({
                storeId: store._id,
                sellerId,
                expectedSlug: pendingSlugChange.expectedSlug,
                newSlug: pendingSlugChange.newSlug,
                confirmPurchasedForfeit: pendingSlugChange.confirmPurchasedForfeit,
                additionalSet,
                actor: {
                    type: 'seller',
                    id: sellerId,
                    reason: 'Seller-confirmed store settings change',
                },
            });
            store = slugResult.store;
        } else {
            await store.save();
        }
        console.log('Store saved with socialLinks:', store.socialLinks);

        res.status(200).json({
            msg: 'Store updated successfully',
            store,
            paymentPolicyLabel: PAYMENT_POLICY_LABELS[normalizeStorePaymentPolicy(store.paymentPolicy)],
        });
    } catch (error) {
        console.error('Update store error:', error);
        res.status(error.statusCode || error.status || 500).json({
            msg: error.message || 'Server error while updating store',
            ...(error.code ? { code: error.code } : {}),
            ...(error.requiresConfirmation ? {
                requiresConfirmation: true,
                currentSubdomain: error.currentSubdomain,
                newSubdomain: error.newSubdomain,
            } : {}),
        });
    }
};

// Delete store
exports.deleteStore = async (req, res) => {
    try {
        const sellerId = req.user.id;

        const store = await Store.findOneAndDelete({ seller: sellerId });

        if (!store) {
            return res.status(404).json({ msg: 'Store not found' });
        }

        res.status(200).json({
            msg: 'Store deleted successfully'
        });
    } catch (error) {
        console.error('Delete store error:', error);
        res.status(500).json({ msg: 'Server error while deleting store' });
    }
};

// Search stores
exports.searchStores = async (req, res) => {
    try {
        const { q } = req.query;
        const buyerLocation = buyerLocationFromRequest(req);

        if (!q || q.trim().length === 0) {
            return res.status(400).json({ msg: 'Search query is required' });
        }

        const safeSearch = String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const stores = await findVisibleStores(Store, activeStoreQuery({
            $or: [
                { storeName: { $regex: safeSearch, $options: 'i' } },
                { storeSlug: { $regex: safeSearch, $options: 'i' } },
                { description: { $regex: safeSearch, $options: 'i' } },
            ],
        }), buyerLocation, {
            populate: { path: 'seller', select: 'username email' },
        });

        const visibleStores = await hideBlockedStores(req, stores);
        const storesWithRatings = await attachStoreReviewSummaries(visibleStores.slice(0, 20));
        res.status(200).json({
            msg: 'Stores fetched successfully',
            stores: storesWithRatings,
            count: storesWithRatings.length,
        });
    } catch (error) {
        console.error('Search stores error:', error);
        res.status(500).json({ msg: 'Server error while searching stores' });
    }
};

// Get store suggestions for autocomplete (limit 5)
exports.getStoreSuggestions = async (req, res) => {
    try {
        const { q } = req.query;
        const buyerLocation = buyerLocationFromRequest(req);

        if (!q || q.trim().length === 0) {
            return res.status(200).json({ suggestions: [] });
        }

        const safeSearch = String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const stores = await findVisibleStores(Store, activeStoreQuery({
            $or: [
                { storeName: { $regex: safeSearch, $options: 'i' } },
                { storeSlug: { $regex: safeSearch, $options: 'i' } },
                { description: { $regex: safeSearch, $options: 'i' } },
            ],
        }), buyerLocation, {
            select: 'storeName storeSlug logo trustCount verification sellerType visibility',
        });

        const visibleStores = await hideBlockedStores(req, stores);
        const suggestions = await attachStoreReviewSummaries(visibleStores.slice(0, 5));
        res.status(200).json({ suggestions });
    } catch (error) {
        console.error('Get store suggestions error:', error);
        res.status(500).json({ msg: 'Server error while fetching suggestions' });
    }
};

// Get store by slug (public)
exports.getStoreBySlug = async (req, res) => {
    try {
        const { slug } = req.params;
        const buyerLocation = buyerLocationFromRequest(req);

        const store = await Store.findOne(activeStoreQuery({ storeSlug: slug }))
            .populate('seller', 'username email avatar role status');

        if (!store || store.seller?.role !== 'seller' || store.seller?.status !== 'active') {
            return res.status(404).json({ msg: 'Store not found' });
        }
        if (await isUserBlocked(req, store.seller?._id || store.seller)) {
            return res.status(404).json({ msg: 'Store not found' });
        }
        if (!isStoreVisibleToBuyer(store, buyerLocation)) {
            return res.status(404).json({ msg: 'Store is not available in your selected area.' });
        }

        await ensureStoreThemeEntitlement(store.seller?._id || store.seller, store);

        const [storeWithRating] = await attachStoreReviewSummaries([store]);
        res.status(200).json({
            msg: 'Store fetched successfully',
            store: storeWithRating,
        });
    } catch (error) {
        console.error('Get store by slug error:', error);
        res.status(500).json({ msg: 'Server error while fetching store' });
    }
};

// Get store by seller ID (public)
exports.getStoreBySellerId = async (req, res) => {
    try {
        const { id } = req.params;
        const buyerLocation = buyerLocationFromRequest(req);

        const store = await Store.findOne(activeStoreQuery({ seller: id }))
            .select('+verification')
            .populate('seller', 'username email avatar role status');

        if (!store || store.seller?.role !== 'seller' || store.seller?.status !== 'active') {
            return res.status(404).json({ msg: 'Store not found for this seller' });
        }
        if (await isUserBlocked(req, store.seller?._id || store.seller)) {
            return res.status(404).json({ msg: 'Store not found for this seller' });
        }
        if (!isStoreVisibleToBuyer(store, buyerLocation)) {
            return res.status(404).json({ msg: 'Store is not available in your selected area.' });
        }

        await ensureStoreThemeEntitlement(store.seller?._id || id, store);

        const [storeWithRating] = await attachStoreReviewSummaries([store]);
        res.status(200).json({
            msg: 'Store fetched successfully',
            store: storeWithRating,
        });
    } catch (error) {
        console.error('Get store by seller ID error:', error);
        res.status(500).json({ msg: 'Server error while fetching store' });
    }
};

// Get products from a specific store
exports.getStoreProducts = async (req, res) => {
    try {
        const { slug } = req.params;
        const { categories, brands, priceRange, search, page = 1, limit = 20 } = req.query;
        const buyerLocation = buyerLocationFromRequest(req);
        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const limitNum = Math.min(48, Math.max(1, parseInt(limit, 10) || 20));

        // Find store
        const store = await Store.findOne(activeStoreQuery({ storeSlug: slug }));

        if (!store) {
            return res.status(404).json({ msg: 'Store not found' });
        }
        if (!await isActiveSellerAccount(store.seller)) {
            return res.status(404).json({ msg: 'Store not found' });
        }
        if (await isUserBlocked(req, store.seller)) {
            return res.status(404).json({ msg: 'Store not found' });
        }
        if (!isStoreVisibleToBuyer(store, buyerLocation)) {
            return res.status(404).json({ msg: 'Store products are not available in your selected area.' });
        }

        // Build query for products
        const Product = require('../models/Product');
        let query = publicProductFilter({ seller: store.seller });

        // Apply filters
        if (categories) {
            const categoryArray = Array.isArray(categories) ? categories : [categories];
            query.category = { $in: categoryArray };
        }

        if (brands) {
            const brandArray = Array.isArray(brands) ? brands : [brands];
            query.brand = { $in: brandArray };
        }

        // priceRange is interpreted as USD for this legacy endpoint.
        let priceMinUSD = null;
        let priceMaxUSD = null;
        if (priceRange) {
            const [min, max] = priceRange.split(',').map(Number);
            priceMinUSD = Number.isFinite(min) ? min : null;
            priceMaxUSD = Number.isFinite(max) ? max : null;
        }

        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } }
            ];
        }

        const allCategories = await Product.distinct('category', publicProductFilter({ seller: store.seller }));

        // Pagination
        const skip = (pageNum - 1) * limitNum;

        let products = await Product.find(query)
            .sort({ createdAt: -1 });

        if (priceMinUSD !== null || priceMaxUSD !== null) {
            products = products.filter((p) => {
                const v = comparablePriceUSD(p);
                if (priceMinUSD !== null && v < priceMinUSD) return false;
                if (priceMaxUSD !== null && v > priceMaxUSD) return false;
                return true;
            });
        }

        const total = products.length;
        products = products.slice(skip, skip + limitNum);

        res.status(200).json({
            msg: 'Products fetched successfully',
            products,
            categories: cleanList(allCategories),
            pagination: {
                total,
                page: pageNum,
                limit: limitNum,
                pages: Math.ceil(total / limitNum)
            }
        });
    } catch (error) {
        console.error('Get store products error:', error);
        res.status(500).json({ msg: 'Server error while fetching store products' });
    }
};

// Get all stores (paginated) — supports ?type=store|brand|all
exports.getAllStores = async (req, res) => {
    try {
        const { page = 1, limit = 12, sort = 'newest', type, search } = req.query;
        const buyerLocation = buyerLocationFromRequest(req);
        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const limitNum = Math.min(48, Math.max(1, parseInt(limit, 10) || 12));

        const sortStores = (items) => {
            const sorted = [...items];
            switch (sort) {
                case 'views':
                case 'popular':
                    sorted.sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0));
                    break;
                case 'trusted':
                    sorted.sort((a, b) => (Number(b.trustCount) || 0) - (Number(a.trustCount) || 0));
                    break;
                case 'rating':
                    sorted.sort((a, b) => (
                        (Number(b.ratingAverage) || 0) - (Number(a.ratingAverage) || 0)
                        || (Number(b.ratingCount) || 0) - (Number(a.ratingCount) || 0)
                    ));
                    break;
                case 'name':
                    sorted.sort((a, b) => String(a.storeName || '').localeCompare(String(b.storeName || '')));
                    break;
                case 'newest':
                default:
                    sorted.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
                    break;
            }
            return sorted;
        };

        const filter = activeStoreQuery();
        const searchText = String(search || '').trim();
        if (searchText) {
            const safeSearch = searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            filter.$or = [
                { storeName: { $regex: safeSearch, $options: 'i' } },
                { storeSlug: { $regex: safeSearch, $options: 'i' } },
                { description: { $regex: safeSearch, $options: 'i' } },
            ];
        }
        if (type === 'store' || type === 'brand') filter.sellerType = type;

        const skip = (pageNum - 1) * limitNum;

        const countBaseFilter = activeStoreQuery();
        if (searchText && filter.$or) countBaseFilter.$or = filter.$or;

        const [allFilteredStores, visibleCountStores] = await Promise.all([
            findVisibleStores(Store, filter, buyerLocation, {
                populate: { path: 'seller', select: 'username email' },
                select: '+verification',
            }),
            findVisibleStores(Store, countBaseFilter, buyerLocation, {
                select: 'seller sellerType visibility storeName storeSlug createdAt views',
            }),
        ]);

        const blockedSellers = blockedIdSet(await getBlockedUserIds(req));
        const filterBlockedStores = stores => blockedSellers.size
            ? (stores || []).filter(store => !blockedSellers.has(String(store?.seller?._id || store?.seller || '')))
            : (stores || []);
        const buyerFilteredStores = filterBlockedStores(allFilteredStores);
        const buyerVisibleCountStores = filterBlockedStores(visibleCountStores);
        const storesForSorting = sort === 'rating'
            ? await attachStoreReviewSummaries(buyerFilteredStores)
            : buyerFilteredStores;
        const sortedStores = sortStores(storesForSorting);
        let stores = sortedStores.slice(skip, skip + limitNum);
        if (sort !== 'rating') {
            stores = await attachStoreReviewSummaries(stores);
        }
        const total = sortedStores.length;
        const allCount = buyerVisibleCountStores.length;
        const brandCount = buyerVisibleCountStores.filter(store => store.sellerType === 'brand').length;
        const storeCount = buyerVisibleCountStores.filter(store => (store.sellerType || 'store') === 'store').length;

        // Get product count for each store
        const Product = require('../models/Product');
        const sellerIds = stores.map(store => store.seller?._id || store.seller).filter(Boolean);
        const productCounts = sellerIds.length
            ? await Product.aggregate([
                { $match: publicProductFilter({ seller: { $in: sellerIds } }) },
                { $group: { _id: '$seller', count: { $sum: 1 } } },
            ])
            : [];
        const productCountBySeller = new Map(productCounts.map(row => [String(row._id), row.count]));
        const storesWithProductCount = stores.map((store) => {
                const sellerId = store.seller?._id || store.seller;
                return {
                    ...store,
                    productCount: sellerId ? productCountBySeller.get(String(sellerId)) || 0 : 0
                };
            });

        res.status(200).json({
            msg: 'Stores fetched successfully',
            stores: storesWithProductCount,
            counts: {
                all: allCount,
                brand: brandCount,
                store: storeCount,
            },
            pagination: {
                total,
                page: pageNum,
                limit: limitNum,
                pages: Math.ceil(total / limitNum),
                hasMore: pageNum < Math.ceil(total / limitNum),
            }
        });
    } catch (error) {
        console.error('Get all stores error:', error);
        res.status(500).json({ msg: 'Server error while fetching stores' });
    }
};

// Increment store view count
exports.incrementStoreView = async (req, res) => {
    try {
        const { slug } = req.params;

        const store = await Store.findOne(activeStoreQuery({ storeSlug: slug })).select('_id views seller');

        if (!store) {
            return res.status(404).json({ msg: 'Store not found' });
        }
        if (!await isActiveSellerAccount(store.seller)) {
            return res.status(404).json({ msg: 'Store not found' });
        }

        const ip = trustedRequestIp(req);
        const userAgent = req.headers['user-agent'] || '';
        const visitorId = String(req.headers['x-rozare-visitor-id'] || '').trim().slice(0, 120);
        const rawVisitor = visitorId || `${ip}|${userAgent}`;
        const visitorKey = crypto.createHash('sha256').update(rawVisitor).digest('hex');
        const ipHash = crypto.createHash('sha256').update(String(ip)).digest('hex');
        const userAgentHash = crypto.createHash('sha256').update(String(userAgent)).digest('hex');
        const bucket = new Date().toISOString().slice(0, 10);

        let counted = false;
        try {
            await StoreView.create({ store: store._id, visitorKey, bucket, ipHash, userAgentHash });
            await Store.updateOne({ _id: store._id }, { $inc: { views: 1 } });
            store.views = Number(store.views || 0) + 1;
            counted = true;
        } catch (err) {
            if (err?.code !== 11000) throw err;
        }

        res.status(200).json({
            msg: counted ? 'View count updated' : 'View already counted for this visitor',
            counted,
            views: store.views
        });
    } catch (error) {
        console.error('Increment store view error:', error);
        res.status(500).json({ msg: 'Server error while updating view count' });
    }
};

// Get store analytics (seller only)
exports.getStoreAnalytics = async (req, res) => {
    try {
        const sellerId = req.user.id;

        const store = await Store.findOne({ seller: sellerId }).lean();

        if (!store) {
            return res.status(404).json({ msg: 'Store not found' });
        }

        const targetCurrency = await resolveRequestedCurrency(req, User);
        const Product = require('../models/Product');
        const [sellerProductIds, inventory] = await Promise.all([
            Product.find({ seller: sellerId }).distinct('_id'),
            getSellerInventoryOverview(sellerId),
        ]);
        const productCount = inventory.totalProducts;

        const Order = require('../models/Order');
        const orders = await Order.find({
            awaitingPayment: { $ne: true },
            $or: [
                { 'orderItems.seller': sellerId },
                ...(sellerProductIds.length ? [{
                    orderItems: {
                        $elemMatch: {
                            seller: null,
                            productId: { $in: sellerProductIds },
                        },
                    },
                }] : []),
            ],
        });

        const sellerProductIdSet = new Set(sellerProductIds.map(id => id.toString()));
        const recognizedOrders = orders.filter(order => isSellerRevenueRecognized(order, sellerId));
        const totalSales = await sumOrderAmountsInCurrency(
            recognizedOrders.map(order => ({
                order,
                amount: sellerOrderSummary(order, sellerProductIdSet, sellerId).totalAmount,
            })),
            targetCurrency
        );
        const views = requireStoreAnalyticsCount(store.views, 'view count');
        const trustCount = requireStoreAnalyticsCount(store.trustCount, 'trust count');
        const recognizedSales = requireStoreAnalyticsMoney(totalSales, 'recognized revenue');

        res.status(200).json({
            msg: 'Analytics fetched successfully',
            analytics: {
                currency: targetCurrency,
                views,
                productCount,
                totalOrders: recognizedOrders.length,
                totalSales: recognizedSales,
                inventory,
                trustCount,
                storeName: store.storeName,
                createdAt: store.createdAt
            }
        });
    } catch (error) {
        console.error('Get store analytics error:', error);
        res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : 'Server error while fetching analytics',
            code: error.code,
        });
    }
};


// Apply for store verification (seller only)
exports.applyForVerification = async (req, res) => {
    try {
        const { applicationMessage, contactEmail, contactPhone } = req.body;
        const sellerId = req.user.id;

        // Validate required fields
        if (!applicationMessage || !applicationMessage.trim()) {
            return res.status(400).json({ msg: 'Application message is required' });
        }

        if (!contactEmail || !contactEmail.trim()) {
            return res.status(400).json({ msg: 'Contact email is required' });
        }

        if (!contactPhone || !contactPhone.trim()) {
            return res.status(400).json({ msg: 'Contact phone number is required' });
        }

        // Basic email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(contactEmail)) {
            return res.status(400).json({ msg: 'Please provide a valid email address' });
        }

        const store = await Store.findOne({ seller: sellerId });

        if (!store) {
            return res.status(404).json({ msg: 'Store not found' });
        }

        if (store.verification.isVerified) {
            return res.status(400).json({ msg: 'Your store is already verified' });
        }

        if (store.verification.status === 'pending') {
            return res.status(400).json({ msg: 'You already have a pending verification application' });
        }

        store.verification.status = 'pending';
        store.verification.appliedAt = new Date();
        store.verification.contactEmail = contactEmail.trim();
        store.verification.contactPhone = contactPhone.trim();
        store.verification.applicationMessage = applicationMessage || '';
        store.verification.rejectionReason = '';

        await store.save();

        User.findById(sellerId)
            .select('username email sellerInfo')
            .then((seller) => trackStoreVerificationLead({
                req,
                store,
                user: seller,
                email: contactEmail.trim(),
                phone: contactPhone.trim(),
                tracking: req.body?.tracking || {},
            }))
            .catch((err) => console.error('[meta] Store verification CRM event failed:', err.message));

        res.status(200).json({
            msg: 'Verification application submitted successfully',
            store
        });
    } catch (error) {
        console.error('Apply for verification error:', error);
        res.status(500).json({ msg: 'Server error while applying for verification' });
    }
};

// Get verification status (seller only)
exports.getVerificationStatus = async (req, res) => {
    try {
        const sellerId = req.user.id;

        const store = await Store.findOne({ seller: sellerId });

        if (!store) {
            return res.status(404).json({ msg: 'Store not found' });
        }

        res.status(200).json({
            msg: 'Verification status fetched successfully',
            verification: store.verification
        });
    } catch (error) {
        console.error('Get verification status error:', error);
        res.status(500).json({ msg: 'Server error while fetching verification status' });
    }
};

// Get all pending verification applications (admin only)
exports.getPendingVerifications = async (req, res) => {
    if (!requireActiveAdminActor(req, res)) return;
    try {
        const stores = await Store.find({ 'verification.status': 'pending' })
            .populate('seller', 'username email')
            .sort({ 'verification.appliedAt': -1 });

        res.status(200).json({
            msg: 'Pending verifications fetched successfully',
            stores,
            count: stores.length
        });
    } catch (error) {
        console.error('Get pending verifications error:', error);
        res.status(500).json({ msg: 'Server error while fetching pending verifications' });
    }
};

// Approve store verification (admin only)
exports.approveVerification = async (req, res) => {
    if (!requireActiveAdminActor(req, res)) return;
    try {
        const { storeId } = req.params;
        const adminId = req.user.id;
        let store;
        await runInTransaction(async session => {
            store = await Store.findById(storeId).session(session);
            if (!store) throw storeTransitionError('Store not found', 404);

            // Allow verification for both pending applications and direct admin verification.
            if (store.verification.isVerified) {
                throw storeTransitionError('Store is already verified', 400);
            }

            const reviewedAt = new Date();
            store.verification.isVerified = true;
            store.verification.status = 'approved';
            store.verification.reviewedAt = reviewedAt;
            store.verification.reviewedBy = adminId;
            store.verification.rejectionReason = '';
            if (!store.verification.appliedAt) store.verification.appliedAt = reviewedAt;

            await store.save({ session });
            await enqueueStoreVerificationNotification(store, 'approved', { session });
        });

        res.status(200).json({
            msg: 'Store verification approved successfully',
            store
        });
    } catch (error) {
        console.error('Approve verification error:', error);
        const status = error.statusCode || 500;
        res.status(status).json({
            msg: status < 500 ? error.message : 'Server error while approving verification',
        });
    }
};

// Reject store verification (admin only)
exports.rejectVerification = async (req, res) => {
    if (!requireActiveAdminActor(req, res)) return;
    try {
        const { storeId } = req.params;
        const { rejectionReason } = req.body;
        const adminId = req.user.id;

        let store;
        await runInTransaction(async session => {
            store = await Store.findById(storeId).session(session);
            if (!store) throw storeTransitionError('Store not found', 404);
            if (store.verification.status !== 'pending') {
                throw storeTransitionError('No pending verification application for this store', 400);
            }

            store.verification.isVerified = false;
            store.verification.status = 'rejected';
            store.verification.reviewedAt = new Date();
            store.verification.reviewedBy = adminId;
            store.verification.rejectionReason = optionalVerificationReason(
                rejectionReason,
                'Application rejected'
            );

            await store.save({ session });
            await enqueueStoreVerificationNotification(store, 'rejected', { session });
        });

        res.status(200).json({
            msg: 'Store verification rejected',
            store
        });
    } catch (error) {
        console.error('Reject verification error:', error);
        const status = error.statusCode || 500;
        res.status(status).json({
            msg: status < 500 ? error.message : 'Server error while rejecting verification',
        });
    }
};

// Get all verified stores (admin only)
exports.getVerifiedStores = async (req, res) => {
    if (!requireActiveAdminActor(req, res)) return;
    try {
        const stores = await Store.find({
            'verification.isVerified': true,
            'verification.status': 'approved'
        })
        .populate('seller', 'username email')
        .sort({ 'verification.reviewedAt': -1 });

        // Get product count for each store
        const Product = require('../models/Product');
        const storesWithProductCount = await Promise.all(
            stores.map(async (store) => {
                const sellerId = store.seller?._id || store.seller;
                const productCount = sellerId
                    ? await Product.countDocuments(publicProductFilter({ seller: sellerId }))
                    : 0;
                return {
                    ...store.toObject(),
                    productCount
                };
            })
        );

        const storesWithRatings = await attachStoreReviewSummaries(storesWithProductCount);
        res.status(200).json({
            msg: 'Verified stores fetched successfully',
            stores: storesWithRatings,
        });
    } catch (error) {
        console.error('Get verified stores error:', error);
        res.status(500).json({ msg: 'Server error while fetching verified stores' });
    }
};

// Remove verification from a store (admin only)
exports.removeVerification = async (req, res) => {
    if (!requireActiveAdminActor(req, res)) return;
    try {
        const { storeId } = req.params;
        const { reason } = req.body;
        const adminId = req.user.id;

        let store;
        await runInTransaction(async session => {
            store = await Store.findById(storeId).session(session);
            if (!store) throw storeTransitionError('Store not found', 404);
            if (!store.verification.isVerified) {
                throw storeTransitionError('Store is not verified', 400);
            }

            store.verification.isVerified = false;
            store.verification.status = 'none';
            store.verification.reviewedAt = new Date();
            store.verification.reviewedBy = adminId;
            store.verification.rejectionReason = optionalVerificationReason(
                reason,
                'Verification removed by admin'
            );

            await store.save({ session });
            await enqueueStoreVerificationNotification(store, 'removed', { session });
        });

        res.status(200).json({
            msg: 'Store verification removed successfully',
            store
        });
    } catch (error) {
        console.error('Remove verification error:', error);
        const status = error.statusCode || 500;
        res.status(status).json({
            msg: status < 500 ? error.message : 'Server error while removing verification',
        });
    }
};
