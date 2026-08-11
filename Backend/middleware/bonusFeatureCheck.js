const SellerSubscription = require('../models/SellerSubscription');
const { buildPlanPricing } = require('../services/subscriptionPricingService');

// Middleware to restrict access to bonus features after 6-month expiry
const bonusFeatureCheck = (featureName) => async (req, res, next) => {
    try {
        // Only apply to sellers
        if (req.user?.role !== 'seller') return next();

        const sub = await SellerSubscription.findOne({ seller: req.user.id });

        // No subscription = new seller on trial, allow access during trial
        if (!sub) return next();

        // Trial users get all features during trial
        if (sub.status === 'trial') return next();

        // Elite plan subscribers always have bonus features
        if (sub.plan === 'elite' && ['active', 'free_period'].includes(sub.status)) return next();

        const elitePrice = buildPlanPricing('elite', false, Boolean(sub.founderOffer?.active));
        const elitePriceLabel = `$${(elitePrice.unitAmount / 100).toFixed(2)}/month`;

        // Check if bonus features have expired permanently
        if (sub.bonusFeaturesExpiredPermanently) {
            return res.status(403).json({
                msg: `${featureName} is a premium feature. Your bonus period has expired permanently. Subscribe to the Rozare Elite plan (${elitePriceLabel}) to access this feature.`,
                bonusExpired: true,
                bonusExpiredPermanently: true,
                featureName,
                upgradePlan: 'elite',
            });
        }

        // Check if bonus features have expired
        if (sub.bonusExpiryDate && new Date() > sub.bonusExpiryDate) {
            // Auto-deactivate if still marked active
            if (sub.bonusFeaturesActive) {
                sub.bonusFeaturesActive = false;
                sub.bonusFeaturesExpiredPermanently = true;
                await sub.save();
            }

            return res.status(403).json({
                msg: `${featureName} is a premium feature. Your bonus period has expired. Subscribe to the Rozare Elite plan (${elitePriceLabel}) to access this feature.`,
                bonusExpired: true,
                bonusExpiredPermanently: true,
                featureName,
                upgradePlan: 'elite',
            });
        }

        // Bonus still active or subscribed — allow
        next();
    } catch (error) {
        console.error('Bonus feature check error:', error);
        if (req.user?.role === 'seller') {
            return res.status(503).json({
                msg: `${featureName} entitlement could not be verified. Please try again shortly.`,
                code: 'BONUS_ENTITLEMENT_UNAVAILABLE',
                featureName,
            });
        }
        next();
    }
};

module.exports = bonusFeatureCheck;
