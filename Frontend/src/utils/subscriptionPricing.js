export const FALLBACK_SUBSCRIPTION_PRICING = Object.freeze({
    starter: Object.freeze({
        listAmountCents: 1175,
        standardAmountCents: 999,
        founderAmountCents: 599,
        advertisedDiscountPercent: 15,
        freePeriodDays: 30,
    }),
    elite: Object.freeze({
        listAmountCents: 3093,
        standardAmountCents: 2165,
        founderAmountCents: 1299,
        advertisedDiscountPercent: 30,
        freePeriodDays: 45,
    }),
    metaAdsAddonCents: 400,
});

export const getSubscriptionPricing = (subscription) => ({
    starter: {
        ...FALLBACK_SUBSCRIPTION_PRICING.starter,
        ...(subscription?.pricing?.starter || {}),
    },
    elite: {
        ...FALLBACK_SUBSCRIPTION_PRICING.elite,
        ...(subscription?.pricing?.elite || {}),
    },
    metaAdsAddonCents: Number(
        subscription?.pricing?.metaAdsAddonCents
        ?? subscription?.metaAdsAddonCents
        ?? FALLBACK_SUBSCRIPTION_PRICING.metaAdsAddonCents
    ),
});

export const formatUsdCents = (amountCents) => `$${(Number(amountCents || 0) / 100).toFixed(2)}`;
