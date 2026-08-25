import assert from 'node:assert/strict';
import test from 'node:test';

import { formatUsdCents, getSubscriptionPricing } from '../src/utils/subscriptionPricing.js';

const catalog = {
  schemaVersion: 1,
  currency: 'USD',
  starter: {
    plan: 'starter',
    planName: 'Rozare Starter',
    listAmountCents: 1200,
    standardAmountCents: 1000,
    founderAmountCents: 600,
    advertisedDiscountPercent: 16,
    freePeriodDays: 31,
  },
  elite: {
    plan: 'elite',
    planName: 'Rozare Elite',
    listAmountCents: 3200,
    standardAmountCents: 2200,
    founderAmountCents: 1300,
    advertisedDiscountPercent: 31,
    freePeriodDays: 46,
  },
  metaAdsAddonCents: 450,
};

test('web subscription pricing uses the complete authoritative API catalog', () => {
  assert.deepEqual(getSubscriptionPricing({ pricing: catalog }), catalog);
  assert.equal(formatUsdCents(0), '$0.00');
  assert.equal(formatUsdCents(9007199254740991), '$90071992547409.91');
});
test('web subscription pricing fails closed instead of merging remembered prices', () => {
  assert.equal(getSubscriptionPricing({}), null);
  assert.equal(getSubscriptionPricing({ pricing: { ...catalog, currency: 'PKR' } }), null);
  assert.equal(getSubscriptionPricing({
    pricing: {
      ...catalog,
      starter: { ...catalog.starter, standardAmountCents: true },
    },
  }), null);
  assert.equal(getSubscriptionPricing({
    pricing: {
      ...catalog,
      elite: { ...catalog.elite, founderAmountCents: 999999 },
    },
  }), null);
  assert.equal(formatUsdCents(true), null);
  assert.equal(formatUsdCents(Number.NaN), null);
});
