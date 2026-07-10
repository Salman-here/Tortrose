const Store = require('../models/Store');
const User = require('../models/User');
const crypto = require('crypto');
const { sendEmail } = require('./mailController');
const { initializeSubscription } = require('./subscriptionController');
const { publicProductFilter } = require('../services/productModerationService');
const { activeStoreQuery } = require('../services/publicCatalogService');
const { convertAmountSync } = require('../services/currencyService');
const { getProductCurrency, getProductEffectivePrice } = require('../services/productPricingService');
const {
    resolveRequestedCurrency,
    sellerOrderSummaryInCurrency,
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

const comparablePriceUSD = (product) =>
    convertAmountSync(getProductEffectivePrice(product), getProductCurrency(product), 'USD');

const cleanList = (items) => [...new Set(
    (items || [])
        .filter(Boolean)
        .map(item => String(item).trim())
        .filter(Boolean)
)].sort((a, b) => a.localeCompare(b));

// Email template helper
const storeEmailTemplate = (title, bodyHtml, ctaUrl, ctaText) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${title}</title>
  <style>
    body { background-color: #F8F9FA; font-family: 'Inter', 'Segoe UI', Tahoma, sans-serif; color: #1A1A1A; margin: 0; padding: 0; }
    .email-wrapper { max-width: 600px; margin: 0 auto; padding: 1.5rem; }
    .card { background: #FFFFFF; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); padding: 2rem; }
    .header { background: linear-gradient(135deg, #4F46E5, #3B82F6); color: #fff; padding: 1.25rem 2rem; border-radius: 12px 12px 0 0; font-size: 1.2rem; font-weight: 600; text-align: center; }
    .content { padding: 1.5rem 0; line-height: 1.7; }
    .content p { margin: 0.75rem 0; }
    .button { display: inline-block; margin-top: 1.25rem; background: linear-gradient(135deg, #4F46E5, #3B82F6); color: white !important; padding: 0.75rem 1.75rem; border-radius: 10px; text-decoration: none; font-weight: 600; }
    .footer { font-size: 13px; text-align: center; color: #6B7280; margin-top: 2rem; }
    .highlight { background: #F0F4FF; border-radius: 10px; padding: 1rem 1.25rem; margin: 1rem 0; border-left: 4px solid #4F46E5; }
  </style>
</head>
<body>
  <div class="email-wrapper">
    <div class="card">
      <div class="header">${title}</div>
      <div class="content">
        ${bodyHtml}
        ${ctaUrl ? `<p style="text-align:center"><a href="${ctaUrl}" class="button">${ctaText || 'View Details'}</a></p>` : ''}
        <p>Best regards,<br/>The Rozare Team</p>
      </div>
    </div>
    <div class="footer">&copy; ${new Date().getFullYear()} Rozare. All rights reserved.</div>
  </div>
</body>
</html>
`;

// Helper function to generate unique slug
const generateUniqueSlug = async (storeName) => {
    let slug = storeName
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '') // Remove special characters
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/-+/g, '-'); // Replace multiple hyphens with single hyphen

    // Check if slug exists
    let existingStore = await Store.findOne({ storeSlug: slug });
    let counter = 1;

    while (existingStore) {
        slug = `${slug}-${counter}`;
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
    const purchased = store.subdomainPurchase?.isPurchased &&
        store.subdomainPurchase?.expiresAt &&
        new Date(store.subdomainPurchase.expiresAt) > new Date();
    const removeAt = store.subdomainPurchase?.removalScheduledAt;
    if (!purchased && removeAt && new Date(removeAt) <= new Date() && store.storeSlug) {
        // Free the slug — keep store record but mark subdomain as released
        store.storeSlug = `released-${store._id.toString().slice(-8)}-${Date.now()}`;
        store.subdomainPurchase = {
            ...(store.subdomainPurchase?.toObject?.() || {}),
            removalScheduledAt: null,
        };
        await store.save();
        return true;
    }
    return false;
}
exports._releaseExpiredSlug = releaseExpiredSlug;
exports.checkSubdomainAvailability = async (req, res) => {
    try {
        const { slug } = req.params;

        if (!slug || slug.trim().length < 3) {
            return res.status(400).json({
                available: false,
                msg: 'Subdomain must be at least 3 characters'
            });
        }

        // Reserved subdomains
        const reserved = ['www', 'api', 'admin', 'app', 'mail', 'ftp', 'shop', 'store', 'blog', 'docs', 'help', 'cdn', 'static', 'support'];
        if (reserved.includes(slug.toLowerCase())) {
            return res.status(200).json({
                available: false,
                msg: 'This subdomain is reserved by the system'
            });
        }

        // Check if slug is taken
        let existingStore = await Store.findOne({ storeSlug: slug.toLowerCase() });

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
            if (storeSlug.length < 3) {
                return res.status(400).json({ msg: 'Subdomain must be at least 3 characters long' });
            }
            const reserved = ['www', 'api', 'admin', 'app', 'mail', 'ftp', 'shop', 'store', 'blog', 'docs', 'help', 'cdn', 'static', 'support'];
            if (reserved.includes(storeSlug.toLowerCase())) {
                return res.status(400).json({ msg: 'This subdomain is reserved by the system' });
            }
            const duplicateSlug = await Store.findOne({ storeSlug: storeSlug.toLowerCase() });
            if (duplicateSlug) {
                return res.status(409).json({ msg: 'This subdomain is already taken' });
            }
            finalSlug = storeSlug.toLowerCase();
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

        // Create store
        const newStore = new Store({
            seller: sellerId,
            storeName: storeName.trim(),
            storeSlug: finalSlug,
            sellerType: sellerType === 'brand' ? 'brand' : 'store',
            description: description || '',
            productCurrency: normalizeProductCurrency(req.body.productCurrency || sellerDefaultProductCurrency({ address: initialAddress }, seller)),
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
            returnPolicy: returnPolicy || {
                returnsEnabled: false,
                returnDuration: 0,
                refundType: 'none',
                warrantyEnabled: false,
                warrantyDuration: 0,
                warrantyDescription: '',
                policyDescription: ''
            }
        });

        await newStore.save();

        // Initialize seller subscription (15-day free trial)
        try {
            await initializeSubscription(sellerId);
        } catch (subErr) {
            console.error('Initialize subscription error:', subErr.message);
        }

        // Send store creation email
        try {
            const seller = await User.findById(sellerId);
            if (seller?.email) {
                const html = storeEmailTemplate(
                    '🎉 Your Store is Live!',
                    `<p>Hello ${seller.username || 'Seller'},</p>
                    <p>Congratulations! Your store <strong>"${newStore.storeName}"</strong> has been successfully created on Rozare.</p>
                    <div class="highlight">
                        <strong>Store URL:</strong> ${process.env.FRONTEND_URL}/store/${newStore.storeSlug}<br/>
                        <strong>Subdomain:</strong> ${newStore.storeSlug}.rozare.com <em>(live while your store is active)</em>
                    </div>
                    <p>Next steps:</p>
                    <ul>
                        <li>Add products to your store</li>
                        <li>Customize your store settings & branding</li>
                        <li>Apply for verification when you want a verified badge and extra customer trust</li>
                    </ul>`,
                    `${process.env.FRONTEND_URL}/seller-dashboard/store-settings`,
                    'Manage Your Store'
                );
                await sendEmail({ to: seller.email, subject: `Your Store "${newStore.storeName}" is Live! 🎉`, html });
            }
        } catch (emailErr) {
            console.error('Store creation email failed:', emailErr.message);
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
    try {
        const { storeName, storeSlug, description, logo, banner, socialLinks, address, returnPolicy, sellerType, storeTheme, visibility, paymentPolicy } = req.body;
        const sellerId = req.user.id;

        // Find seller's store
        const store = await Store.findOne({ seller: sellerId });

        if (!store) {
            return res.status(404).json({ msg: 'Store not found. Please create a store first.' });
        }

        // Detect intended changes (against current values) before applying
        const wantsNameChange = !!storeName && storeName.trim().toLowerCase() !== store.storeName.toLowerCase();
        const wantsSlugChange = !!storeSlug && storeSlug.toLowerCase() !== store.storeSlug;
        const wantsTypeChange = sellerType !== undefined &&
            (sellerType === 'store' || sellerType === 'brand') &&
            sellerType !== (store.sellerType || 'store');
        const wantsThemeChange = storeTheme !== undefined;
        const wantsVisibilityChange = visibility !== undefined;
        const wantsPaymentPolicyChange = paymentPolicy !== undefined &&
            normalizeStorePaymentPolicy(paymentPolicy) !== normalizeStorePaymentPolicy(store.paymentPolicy);

        // Block changes while the store is blocked (subscription ended)
        if ((wantsNameChange || wantsSlugChange || wantsTypeChange || wantsThemeChange || wantsVisibilityChange || wantsPaymentPolicyChange) && store.isActive === false) {
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
        if (storeSlug && storeSlug !== store.storeSlug) {
            // Validate slug
            if (storeSlug.length < 3) {
                return res.status(400).json({ msg: 'Subdomain must be at least 3 characters long' });
            }

            const reserved = ['www', 'api', 'admin', 'app', 'mail', 'ftp', 'shop', 'store', 'blog', 'docs', 'help', 'cdn', 'static', 'support'];
            if (reserved.includes(storeSlug.toLowerCase())) {
                return res.status(400).json({ msg: 'This subdomain is reserved by the system' });
            }

            // Warn: changing slug will forfeit the purchased subdomain ownership
            // If seller has purchased the subdomain, require explicit confirmation
            if (store.subdomainPurchase?.isPurchased && store.subdomainPurchase?.expiresAt && new Date(store.subdomainPurchase.expiresAt) > new Date()) {
                if (!req.body.confirmSubdomainChange) {
                    return res.status(400).json({
                        msg: `You have purchased the subdomain "${store.storeSlug}.rozare.com". Changing it will forfeit your ownership of the old subdomain — anyone else can claim it. To proceed, resend with confirmSubdomainChange: true.`,
                        requiresConfirmation: true,
                        currentSubdomain: store.storeSlug,
                        newSubdomain: storeSlug.toLowerCase(),
                    });
                }

                // Seller confirmed — clear the purchase since they're abandoning it
                store.subdomainPurchase = {
                    isPurchased: false,
                    purchasedAt: null,
                    expiresAt: null,
                    stripePaymentId: '',
                    removalScheduledAt: null,
                };
            }

            // Check if available (lazy-release stale blocked slugs)
            let duplicateSlug = await Store.findOne({
                storeSlug: storeSlug.toLowerCase(),
                _id: { $ne: store._id }
            });
            if (duplicateSlug) {
                const released = await releaseExpiredSlug(duplicateSlug);
                if (released) duplicateSlug = null;
            }
            if (duplicateSlug) {
                return res.status(409).json({ msg: 'This subdomain is already taken by another store' });
            }

            store.storeSlug = storeSlug.toLowerCase();
            store.lastSlugChangeAt = new Date();
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
            store.returnPolicy = {
                returnsEnabled: returnPolicy.returnsEnabled || false,
                returnDuration: returnPolicy.returnDuration || 0,
                refundType: returnPolicy.refundType || 'none',
                warrantyEnabled: returnPolicy.warrantyEnabled || false,
                warrantyDuration: returnPolicy.warrantyDuration || 0,
                warrantyDescription: returnPolicy.warrantyDescription || '',
                policyDescription: returnPolicy.policyDescription || '',
            };
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

        await store.save();
        console.log('Store saved with socialLinks:', store.socialLinks);

        res.status(200).json({
            msg: 'Store updated successfully',
            store,
            paymentPolicyLabel: PAYMENT_POLICY_LABELS[normalizeStorePaymentPolicy(store.paymentPolicy)],
        });
    } catch (error) {
        console.error('Update store error:', error);
        res.status(error.status || 500).json({ msg: error.message || 'Server error while updating store' });
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

        res.status(200).json({
            msg: 'Stores fetched successfully',
            stores: stores.slice(0, 20),
            count: Math.min(stores.length, 20)
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

        res.status(200).json({
            suggestions: stores.slice(0, 5)
        });
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
            .populate('seller', 'username email avatar');

        if (!store) {
            return res.status(404).json({ msg: 'Store not found' });
        }
        if (!isStoreVisibleToBuyer(store, buyerLocation)) {
            return res.status(404).json({ msg: 'Store is not available in your selected area.' });
        }

        await ensureStoreThemeEntitlement(store.seller?._id || store.seller, store);

        res.status(200).json({
            msg: 'Store fetched successfully',
            store
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
            .populate('seller', 'username email avatar');

        if (!store) {
            return res.status(404).json({ msg: 'Store not found for this seller' });
        }
        if (!isStoreVisibleToBuyer(store, buyerLocation)) {
            return res.status(404).json({ msg: 'Store is not available in your selected area.' });
        }

        await ensureStoreThemeEntitlement(store.seller?._id || id, store);

        res.status(200).json({
            msg: 'Store fetched successfully',
            store
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
                    sorted.sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0));
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

        const sortedStores = sortStores(allFilteredStores);
        const stores = sortedStores.slice(skip, skip + limitNum);
        const total = sortedStores.length;
        const allCount = visibleCountStores.length;
        const brandCount = visibleCountStores.filter(store => store.sellerType === 'brand').length;
        const storeCount = visibleCountStores.filter(store => (store.sellerType || 'store') === 'store').length;

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
        const storesWithProductCount = await Promise.all(
            stores.map(async (store) => {
                const sellerId = store.seller?._id || store.seller;
                return {
                    ...store,
                    productCount: sellerId ? productCountBySeller.get(String(sellerId)) || 0 : 0
                };
            })
        );

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

        const store = await Store.findOne(activeStoreQuery({ storeSlug: slug })).select('_id views');

        if (!store) {
            return res.status(404).json({ msg: 'Store not found' });
        }

        const forwarded = req.headers['x-forwarded-for']?.split(',')[0]?.trim();
        const ip = forwarded || req.headers['x-real-ip'] || req.ip || req.socket?.remoteAddress || '';
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

        const store = await Store.findOne({ seller: sellerId });

        if (!store) {
            return res.status(404).json({ msg: 'Store not found' });
        }

        const targetCurrency = await resolveRequestedCurrency(req, User);
        const Product = require('../models/Product');
        const sellerProductIds = await Product.find({ seller: sellerId }).distinct('_id');
        const productCount = sellerProductIds.length;

        const Order = require('../models/Order');
        const orders = await Order.find({
            'orderItems.productId': { $in: sellerProductIds },
            isPaid: true
        });

        const sellerProductIdSet = new Set(sellerProductIds.map(id => id.toString()));
        let totalSales = 0;
        for (const order of orders) {
            const summary = await sellerOrderSummaryInCurrency(order, sellerProductIdSet, sellerId, targetCurrency);
            totalSales += summary.totalAmount;
        }
        totalSales = roundMoney(totalSales);

        res.status(200).json({
            msg: 'Analytics fetched successfully',
            analytics: {
                currency: targetCurrency,
                views: store.views || 0,
                productCount: productCount || 0,
                totalSales: totalSales || 0,
                trustCount: store.trustCount || 0,
                storeName: store.storeName,
                createdAt: store.createdAt
            }
        });
    } catch (error) {
        console.error('Get store analytics error:', error);
        res.status(500).json({ msg: 'Server error while fetching analytics' });
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
    try {
        const { storeId } = req.params;
        const adminId = req.user.id;

        const store = await Store.findById(storeId);

        if (!store) {
            return res.status(404).json({ msg: 'Store not found' });
        }

        // Allow verification for both pending applications and direct admin verification
        if (store.verification.isVerified) {
            return res.status(400).json({ msg: 'Store is already verified' });
        }

        store.verification.isVerified = true;
        store.verification.status = 'approved';
        store.verification.reviewedAt = new Date();
        store.verification.reviewedBy = adminId;
        store.verification.rejectionReason = '';

        // If there was no application, set appliedAt to now
        if (!store.verification.appliedAt) {
            store.verification.appliedAt = new Date();
        }

        await store.save();

        // Send activation email to seller
        try {
            const seller = await User.findById(store.seller);
            if (seller?.email) {
                const html = storeEmailTemplate(
                    '✅ Store Verified!',
                    `<p>Hello ${seller.username || 'Seller'},</p>
                    <p>Great news! Your store <strong>"${store.storeName}"</strong> has been verified by the Rozare team.</p>
                    <div class="highlight">
                        <strong>🌐 Your store link:</strong><br/>
                        <a href="https://${store.storeSlug}.rozare.com" style="color:#4F46E5;font-weight:600">${store.storeSlug}.rozare.com</a>
                    </div>
                    <p>Your store now displays a verified badge. Your custom subdomain remains live as long as your store is active, so keep sharing your link to bring in customers!</p>`,
                    `${process.env.FRONTEND_URL}/seller-dashboard/subdomain`,
                    'View Subdomain Dashboard'
                );
                await sendEmail({ to: seller.email, subject: `Your Store "${store.storeName}" is Now Verified! ✅`, html });
            }
        } catch (emailErr) {
            console.error('Verification approval email failed:', emailErr.message);
        }

        res.status(200).json({
            msg: 'Store verification approved successfully',
            store
        });
    } catch (error) {
        console.error('Approve verification error:', error);
        res.status(500).json({ msg: 'Server error while approving verification' });
    }
};

// Reject store verification (admin only)
exports.rejectVerification = async (req, res) => {
    try {
        const { storeId } = req.params;
        const { rejectionReason } = req.body;
        const adminId = req.user.id;

        const store = await Store.findById(storeId);

        if (!store) {
            return res.status(404).json({ msg: 'Store not found' });
        }

        if (store.verification.status !== 'pending') {
            return res.status(400).json({ msg: 'No pending verification application for this store' });
        }

        store.verification.isVerified = false;
        store.verification.status = 'rejected';
        store.verification.reviewedAt = new Date();
        store.verification.reviewedBy = adminId;
        store.verification.rejectionReason = rejectionReason || 'Application rejected';

        await store.save();

        // Send rejection email to seller
        try {
            const seller = await User.findById(store.seller);
            if (seller?.email) {
                const html = storeEmailTemplate(
                    '❌ Verification Application Rejected',
                    `<p>Hello ${seller.username || 'Seller'},</p>
                    <p>Unfortunately, the verification application for your store <strong>"${store.storeName}"</strong> has been rejected.</p>
                    <div class="highlight">
                        <strong>Reason:</strong> ${rejectionReason || 'Application did not meet the requirements'}
                    </div>
                    <p>You can update your store information and reapply for verification. If you need assistance, please contact our support team.</p>`,
                    `${process.env.FRONTEND_URL}/seller-dashboard/store-settings`,
                    'Update & Reapply'
                );
                await sendEmail({ to: seller.email, subject: `Verification Rejected — ${store.storeName}`, html });
            }
        } catch (emailErr) {
            console.error('Verification rejection email failed:', emailErr.message);
        }

        res.status(200).json({
            msg: 'Store verification rejected',
            store
        });
    } catch (error) {
        console.error('Reject verification error:', error);
        res.status(500).json({ msg: 'Server error while rejecting verification' });
    }
};

// Get all verified stores (admin only)
exports.getVerifiedStores = async (req, res) => {
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

        res.status(200).json({
            msg: 'Verified stores fetched successfully',
            stores: storesWithProductCount
        });
    } catch (error) {
        console.error('Get verified stores error:', error);
        res.status(500).json({ msg: 'Server error while fetching verified stores' });
    }
};

// Remove verification from a store (admin only)
exports.removeVerification = async (req, res) => {
    try {
        const { storeId } = req.params;
        const { reason } = req.body;
        const adminId = req.user.id;

        const store = await Store.findById(storeId);

        if (!store) {
            return res.status(404).json({ msg: 'Store not found' });
        }

        if (!store.verification.isVerified) {
            return res.status(400).json({ msg: 'Store is not verified' });
        }

        store.verification.isVerified = false;
        store.verification.status = 'none';
        store.verification.reviewedAt = new Date();
        store.verification.reviewedBy = adminId;
        store.verification.rejectionReason = reason || 'Verification removed by admin';

        await store.save();

        // Send deactivation email to seller
        try {
            const seller = await User.findById(store.seller);
            if (seller?.email) {
                const html = storeEmailTemplate(
                    '⚠️ Store Verification Removed',
                    `<p>Hello ${seller.username || 'Seller'},</p>
                    <p>We're writing to inform you that the verification for your store <strong>"${store.storeName}"</strong> has been removed by an administrator.</p>
                    <div class="highlight">
                        <strong>What this means:</strong><br/>
                        • The verified badge has been removed from your store<br/>
                        • Your subdomain <strong>${store.storeSlug}.rozare.com</strong> remains available while your store is active<br/>
                        • Customers can still access your store unless your account or subscription is blocked
                    </div>
                    <p><strong>Reason:</strong> ${reason || 'No reason provided'}</p>
                    <p>If you believe this was a mistake or would like to reapply, please visit your Store Settings or contact our support team.</p>`,
                    `${process.env.FRONTEND_URL}/seller-dashboard/store-settings`,
                    'Go to Store Settings'
                );
                await sendEmail({ to: seller.email, subject: `Store Verification Removed — ${store.storeName}`, html });
            }
        } catch (emailErr) {
            console.error('Verification removal email failed:', emailErr.message);
        }

        res.status(200).json({
            msg: 'Store verification removed successfully',
            store
        });
    } catch (error) {
        console.error('Remove verification error:', error);
        res.status(500).json({ msg: 'Server error while removing verification' });
    }
};
