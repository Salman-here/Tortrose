// Middleware to detect and handle subdomain routing
const Store = require('../models/Store');
const { findActiveStore } = require('../services/publicCatalogService');

const subdomainDetector = async (req, res, next) => {
    try {
        let subdomain = null;

        // Priority 1: Explicit ?slug= query param (used when frontend is on a different host)
        if (req.query.slug) {
            subdomain = req.query.slug.toLowerCase().trim();
        }

        // Priority 2: X-Store-Subdomain header (alternative way to pass it)
        if (!subdomain && req.get('x-store-subdomain')) {
            subdomain = req.get('x-store-subdomain').toLowerCase().trim();
        }

        // Priority 3: Detect from Host header (works when backend is on same domain)
        if (!subdomain) {
            const host = req.get('host') || '';
            const parts = host.split('.');
            if (parts.length > 2) {
                const hostSub = parts[0].toLowerCase();
                if (!['www', 'api', 'admin', 'app', 'docs', 'help', 'blog', 'mail', 'cdn', 'static'].includes(hostSub)) {
                    subdomain = hostSub;
                }
            }
        }

        if (!subdomain) {
            return next();
        }

        // Skip common subdomains
        if (['www', 'api', 'admin', 'app', 'docs', 'help', 'blog', 'mail', 'cdn', 'static'].includes(subdomain)) {
            return next();
        }

        // Subdomains are live for active stores. Verification is a trust badge,
        // not a routing requirement.
        // A live Store row is not enough: legacy/manual deletions may have left
        // an orphaned store behind. Require its owning User to still be an
        // active seller before exposing the subdomain.
        const store = await findActiveStore({ storeSlug: subdomain }, { lean: false });
        
        if (store) {
            req.subdomainStore = store;
        } else {
            // Check if the store exists but is blocked/inactive
            const blockedStore = await Store.findOne({ storeSlug: subdomain });
            if (blockedStore && !blockedStore.isActive) {
                // Lazy release: free the slug if blocked + past removal window + not purchased
                const now = new Date();
                const purchased = blockedStore.subdomainPurchase?.isPurchased &&
                    blockedStore.subdomainPurchase?.expiresAt &&
                    new Date(blockedStore.subdomainPurchase.expiresAt) > now;
                const removeAt = blockedStore.subdomainPurchase?.removalScheduledAt;
                if (!purchased && removeAt && new Date(removeAt) <= now) {
                    blockedStore.storeSlug = `released-${blockedStore._id.toString().slice(-8)}-${Date.now()}`;
                    blockedStore.subdomainPurchase = {
                        ...(blockedStore.subdomainPurchase?.toObject?.() || {}),
                        removalScheduledAt: null,
                    };
                    await blockedStore.save();
                    // Slug is now free — fall through as "not found"
                } else {
                    req.subdomainStoreBlocked = true;
                    req.subdomainStoreName = blockedStore.storeName;
                }
            }
        }
        
        next();
    } catch (error) {
        console.error('Subdomain detection error:', error);
        next();
    }
};

module.exports = subdomainDetector;
