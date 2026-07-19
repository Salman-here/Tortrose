const {
  META_ADS_ADDON_CENTS,
  buildPlanPricing,
  getPricingCatalog,
} = require('../../services/subscriptionPricingService');

describe('subscriptionPricingService', () => {
  test('uses the advertised standard monthly prices', () => {
    const starter = buildPlanPricing('starter');
    const elite = buildPlanPricing('elite');

    expect(starter).toMatchObject({
      listAmountCents: 1175,
      standardAmountCents: 999,
      advertisedDiscountPercent: 15,
      unitAmount: 999,
    });
    expect(elite).toMatchObject({
      listAmountCents: 3093,
      standardAmountCents: 2165,
      advertisedDiscountPercent: 30,
      unitAmount: 2165,
    });
  });

  test('locks the exact founder prices after the extra 40 percent offer', () => {
    expect(buildPlanPricing('starter', false, true).unitAmount).toBe(599);
    expect(buildPlanPricing('elite', false, true).unitAmount).toBe(1299);
  });

  test('keeps the Meta ads add-on at the full four dollars', () => {
    const standard = buildPlanPricing('elite', true, false);
    const founder = buildPlanPricing('elite', true, true);

    expect(META_ADS_ADDON_CENTS).toBe(400);
    expect(standard.unitAmount).toBe(2565);
    expect(founder.unitAmount).toBe(1699);
    expect(founder.metaAddOn).toBe(400);
  });

  test('returns a stable client pricing catalog', () => {
    const catalog = getPricingCatalog();
    expect(catalog.starter.founderAmountCents).toBe(599);
    expect(catalog.elite.founderAmountCents).toBe(1299);
    expect(catalog.metaAdsAddonCents).toBe(400);
  });
});
