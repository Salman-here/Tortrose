const isSafeMinor = (value, { positive = true } = {}) => (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && (positive ? value > 0 : value >= 0)
);

const isWholePercent = value => (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 100
);

const isFreePeriodDays = value => (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 365
);

const normalizePlan = (plan, expectedPlan) => {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
    if (plan.plan !== expectedPlan) return null;
    if (typeof plan.planName !== 'string' || !plan.planName.trim()) return null;
    if (
        !isSafeMinor(plan.listAmountCents)
        || !isSafeMinor(plan.standardAmountCents)
        || !isSafeMinor(plan.founderAmountCents)
        || !isWholePercent(plan.advertisedDiscountPercent)
        || !isFreePeriodDays(plan.freePeriodDays)
        || plan.listAmountCents < plan.standardAmountCents
        || plan.standardAmountCents < plan.founderAmountCents
    ) return null;
    return {
        plan: expectedPlan,
        planName: plan.planName.trim(),
        listAmountCents: plan.listAmountCents,
        standardAmountCents: plan.standardAmountCents,
        founderAmountCents: plan.founderAmountCents,
        advertisedDiscountPercent: plan.advertisedDiscountPercent,
        freePeriodDays: plan.freePeriodDays,
    };
};

export const getSubscriptionPricing = (subscription) => {
    const catalog = subscription?.pricing;
    if (
        !catalog
        || typeof catalog !== 'object'
        || Array.isArray(catalog)
        || catalog.schemaVersion !== 1
        || catalog.currency !== 'USD'
        || !isSafeMinor(catalog.metaAdsAddonCents, { positive: false })
    ) return null;
    const starter = normalizePlan(catalog.starter, 'starter');
    const elite = normalizePlan(catalog.elite, 'elite');
    if (!starter || !elite) return null;
    return {
        schemaVersion: 1,
        currency: 'USD',
        starter,
        elite,
        metaAdsAddonCents: catalog.metaAdsAddonCents,
    };
};

export const formatUsdCents = (amountCents) => {
    if (!isSafeMinor(amountCents, { positive: false })) return null;
    const value = BigInt(amountCents);
    return `$${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
};
