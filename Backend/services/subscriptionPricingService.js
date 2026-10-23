const META_ADS_ADDON_CENTS = 400;
const billingTest = require('./subscriptionBillingTestPolicy');

const PLAN_PRICING = Object.freeze({
    starter: Object.freeze({
        plan: 'starter',
        planName: 'Rozare Starter',
        listAmountCents: 1175,
        standardAmountCents: 999,
        founderAmountCents: 599,
        advertisedDiscountPercent: 15,
        freePeriodDays: 30,
    }),
    elite: Object.freeze({
        plan: 'elite',
        planName: 'Rozare Elite',
        listAmountCents: 3093,
        standardAmountCents: 2165,
        founderAmountCents: 1299,
        advertisedDiscountPercent: 30,
        freePeriodDays: 45,
    }),
});

function getPlanDefinition(plan) {
    const definition = PLAN_PRICING[plan];
    if (!definition) {
        throw Object.assign(new Error('Choose a valid subscription plan.'), {
            code: 'INVALID_SUBSCRIPTION_PLAN',
        });
    }
    return definition;
}

function buildPlanPricing(plan, includeMetaAds = false, founderRate = false, { ignoreTest = true } = {}) {
    const definition = getPlanDefinition(plan);
    if (typeof includeMetaAds !== 'boolean' || typeof founderRate !== 'boolean') {
        throw Object.assign(new Error('Subscription pricing flags must be explicit booleans.'), {
            code: 'INVALID_SUBSCRIPTION_PRICING_FLAGS',
        });
    }
    const isElite = plan === 'elite';
    const includeMeta = isElite && includeMetaAds;
    const test = !ignoreTest && billingTest.readWindow();
    const baseAmount = founderRate
        ? definition.founderAmountCents
        : definition.standardAmountCents;
    const metaAddOn = test ? 0 : includeMeta ? META_ADS_ADDON_CENTS : 0;

    return {
        ...definition,
        isElite,
        founderRate,
        includeMetaAds: includeMeta,
        baseAmountCents: test ? 100 : baseAmount,
        unitAmount: test ? 100 : baseAmount + metaAddOn,
        metaAddOn,
        ...(test ? { billingTest: test } : {}),
        planName: isElite && includeMeta
            ? 'Rozare Elite + Meta Ads'
            : definition.planName,
    };
}

function getPricingCatalog() {
    const test = billingTest.readWindow();
    const catalog = {
        schemaVersion: 1,
        currency: 'USD',
        starter: { ...PLAN_PRICING.starter },
        elite: { ...PLAN_PRICING.elite },
        metaAdsAddonCents: META_ADS_ADDON_CENTS,
    };
    if (test) {
        catalog.normalPricing = { ...catalog, starter:{...catalog.starter}, elite:{...catalog.elite} };
        for (const plan of ['starter', 'elite']) Object.assign(catalog[plan], {
            listAmountCents: 100, standardAmountCents: 100, founderAmountCents: 100, advertisedDiscountPercent: 0,
        });
        catalog.metaAdsAddonCents = 0;
        catalog.billingTest = test;
    }
    return catalog;
}

module.exports = {
    META_ADS_ADDON_CENTS,
    PLAN_PRICING,
    buildPlanPricing,
    getPlanDefinition,
    getPricingCatalog,
};
