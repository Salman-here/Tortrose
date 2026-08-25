import {
  addCurrencyAmounts,
  allocateCurrencyAmount,
  allocateConvertedCurrencyAmounts,
  assertSafeCurrencyConversion,
  canSafelyConvertCurrency,
  checkoutHasUnsupportedCurrency,
  checkoutRequiresCurrencyConversion,
  checkoutRequiresTrustedRates,
  convertCurrencyAmount,
  convertCurrencyLineAmount,
  convertCurrencyLineAmounts,
  couponHasCurrencyAmount,
  currencyConversionRequiresRates,
  getEffectiveProductSourcePrice,
  getProductSourceAmount,
  hasCurrencyAmount,
  isFiniteJsonNumber,
  multiplyCurrencyAmount,
  normalizeCompleteExchangeRates,
  percentageCurrencyAmount,
  roundCurrencyAmount,
  sellerAnalyticsMoneyIsValid,
  shouldRefreshExchangeRates,
  shouldRetainIdempotencyKey,
  toCurrencyMinorUnits,
} from '../../src/utils/currencySafety';

describe('currency safety', () => {
  it('rejects coercible booleans and non-USD-base exchange-rate tables', () => {
    expect(normalizeCompleteExchangeRates({
      USD: 1,
      PKR: '284.6',
      EUR: 0.92,
      GBP: 0.79,
    })).toEqual({ USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 });
    expect(normalizeCompleteExchangeRates({ USD: 1, PKR: true, EUR: 0.92, GBP: 0.79 })).toBeNull();
    expect(normalizeCompleteExchangeRates({ USD: 2, PKR: 284.6, EUR: 0.92, GBP: 0.79 })).toBeNull();
  });

  it('refreshes stale live rates and retries fallback rates without resume storms', () => {
    const now = 1_000_000;
    expect(shouldRefreshExchangeRates({ now, lastAttemptAt: now - 5_000, lastLiveAt: 0 })).toBe(false);
    expect(shouldRefreshExchangeRates({ now, lastAttemptAt: now - 60_000, lastLiveAt: 0 })).toBe(true);
    expect(shouldRefreshExchangeRates({ now, lastAttemptAt: now - 60_000, lastLiveAt: now - 10_000 })).toBe(false);
    expect(shouldRefreshExchangeRates({
      now,
      lastAttemptAt: now - 60_000,
      lastLiveAt: now - (15 * 60 * 1000),
    })).toBe(true);
  });

  it('keeps same-currency amounts exact even when live rates are unavailable', () => {
    expect(currencyConversionRequiresRates('pkr', 'PKR')).toBe(false);
    expect(canSafelyConvertCurrency('PKR', 'PKR', {
      ratesFallback: true,
      ratesLoading: true,
    })).toBe(true);
  });

  it('blocks a cross-currency conversion while rates are loading or fallback', () => {
    expect(canSafelyConvertCurrency('USD', 'PKR', {
      ratesFallback: false,
      ratesLoading: true,
    })).toBe(false);
    expect(canSafelyConvertCurrency('USD', 'PKR', {
      ratesFallback: true,
      ratesLoading: false,
    })).toBe(false);
    expect(() => assertSafeCurrencyConversion('USD', 'PKR', {
      ratesFallback: true,
      ratesLoading: false,
    })).toThrow('Live exchange rates are unavailable');
  });

  it('keeps outage estimates renderable while the money-action assertion fails closed', () => {
    const retainedRates = { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 };
    expect(convertCurrencyAmount(10, 'USD', 'PKR', retainedRates)).toBe(2846);
    expect(() => assertSafeCurrencyConversion('USD', 'PKR', {
      ratesFallback: true,
      ratesLoading: false,
    })).toThrow();
  });

  it('allows cross-currency conversion only with a trusted loaded snapshot', () => {
    expect(canSafelyConvertCurrency('USD', 'EUR', {
      ratesFallback: false,
      ratesLoading: false,
    })).toBe(true);
  });

  it('detects mixed checkout source currencies', () => {
    expect(checkoutRequiresCurrencyConversion(['PKR', null, 'PKR'], 'PKR')).toBe(false);
    expect(checkoutRequiresCurrencyConversion(['PKR', 'USD'], 'PKR')).toBe(true);
  });

  it('requires a trusted settlement snapshot for every non-USD checkout', () => {
    expect(checkoutRequiresTrustedRates(['PKR'], 'PKR')).toBe(true);
    expect(checkoutRequiresTrustedRates(['EUR'], 'EUR')).toBe(true);
    expect(checkoutRequiresTrustedRates(['USD'], 'USD')).toBe(false);
    expect(checkoutRequiresTrustedRates(['PKR'], 'USD')).toBe(true);
  });

  it('does not invent FX dependencies for zero-value or pure-percentage components', () => {
    expect(couponHasCurrencyAmount({
      discountType: 'percentage',
      discountValue: 10,
      currency: 'USD',
      minOrderAmount: 0,
      maxDiscountAmount: 0,
    })).toBe(false);
    expect(couponHasCurrencyAmount({ discountType: 'fixed', discountValue: 0 })).toBe(false);
    const freeForeignProductSources = [hasCurrencyAmount(0) ? 'PKR' : null];
    const paidForeignProductSources = [hasCurrencyAmount(0.01) ? 'PKR' : null];
    expect(checkoutRequiresCurrencyConversion(freeForeignProductSources, 'USD')).toBe(false);
    expect(checkoutRequiresCurrencyConversion(paidForeignProductSources, 'USD')).toBe(true);
  });

  it('detects every nonzero currency-denominated coupon component', () => {
    expect(couponHasCurrencyAmount({ discountType: 'fixed', discountValue: 5 })).toBe(true);
    expect(couponHasCurrencyAmount({ discountType: 'percentage', discountValue: 10, minOrderAmount: 1 })).toBe(true);
    expect(couponHasCurrencyAmount({ discountType: 'percentage', discountValue: 10, maxDiscountAmount: 1 })).toBe(true);
  });

  it('selects one effective native product price across current and legacy fields', () => {
    expect(getEffectiveProductSourcePrice({ price: 100, discountedPrice: 80 })).toBe(80);
    expect(getEffectiveProductSourcePrice({ price: Number.NaN, priceOriginal: 100, discountedPriceOriginal: 80 })).toBe(80);
    expect(getEffectiveProductSourcePrice({ price: null, priceOriginal: 100, discountedPrice: null, discountedPriceOriginal: 80 })).toBe(80);
    expect(getEffectiveProductSourcePrice({ price: 100, discountedPrice: 0, discountedPriceOriginal: 80 })).toBe(100);
    expect(getEffectiveProductSourcePrice({ price: 100, discountedPrice: 101 })).toBe(100);
    expect(getEffectiveProductSourcePrice({ price: 0, priceOriginal: 100, discountedPriceOriginal: 80 })).toBe(0);
    expect(getProductSourceAmount({ price: Infinity, priceOriginal: 50 }, 'price')).toBe(50);
    expect(getProductSourceAmount({ price: '50', priceOriginal: 40 }, 'price')).toBe(40);
  });

  it('accepts only complete finite seller analytics money in the requested currency', () => {
    const valid = {
      currency: 'PKR',
      summary: { totalRevenue: 0, avgOrderValue: 0, paidOrders: 0, totalUnitsSold: 0 },
      revenueByDay: [{ revenue: 0, orders: 0 }, { revenue: 125.5, orders: 2 }],
      topProducts: [{ revenue: 25, sold: 1 }],
      categoryBreakdown: [{ count: 0 }],
      statusBreakdown: [{ value: 0 }],
    };
    expect(sellerAnalyticsMoneyIsValid(valid, 'PKR')).toBe(true);
    expect(sellerAnalyticsMoneyIsValid({ ...valid, currency: 'USD' }, 'PKR')).toBe(false);
    expect(sellerAnalyticsMoneyIsValid({ ...valid, summary: { ...valid.summary, totalRevenue: NaN } }, 'PKR')).toBe(false);
    expect(sellerAnalyticsMoneyIsValid({ ...valid, summary: { ...valid.summary, totalRevenue: null } }, 'PKR')).toBe(false);
    expect(sellerAnalyticsMoneyIsValid({ ...valid, summary: { ...valid.summary, avgOrderValue: '0' } }, 'PKR')).toBe(false);
    expect(sellerAnalyticsMoneyIsValid({ ...valid, revenueByDay: [{ revenue: 'not-a-number' }] }, 'PKR')).toBe(false);
    expect(sellerAnalyticsMoneyIsValid({ ...valid, revenueByDay: [{ revenue: 0, orders: Infinity }] }, 'PKR')).toBe(false);
    expect(sellerAnalyticsMoneyIsValid({ ...valid, topProducts: [{ revenue: Infinity }] }, 'PKR')).toBe(false);
    expect(sellerAnalyticsMoneyIsValid({ ...valid, topProducts: [{ revenue: 0, sold: 0.5 }] }, 'PKR')).toBe(false);
    expect(sellerAnalyticsMoneyIsValid({ ...valid, categoryBreakdown: [{ count: null }] }, 'PKR')).toBe(false);
    expect(sellerAnalyticsMoneyIsValid({ ...valid, statusBreakdown: [{ value: -1 }] }, 'PKR')).toBe(false);
    expect(sellerAnalyticsMoneyIsValid({ ...valid, categoryBreakdown: [], statusBreakdown: [] }, 'PKR')).toBe(true);
  });

  it('accepts only actual finite JSON numbers for authoritative payment amounts', () => {
    expect(isFiniteJsonNumber(0)).toBe(true);
    expect(isFiniteJsonNumber(125.5)).toBe(true);
    expect(isFiniteJsonNumber(null)).toBe(false);
    expect(isFiniteJsonNumber('')).toBe(false);
    expect(isFiniteJsonNumber('0')).toBe(false);
    expect(isFiniteJsonNumber(Number.NaN)).toBe(false);
    expect(isFiniteJsonNumber(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('fails closed for currency codes the product does not support', () => {
    expect(checkoutHasUnsupportedCurrency(['PKR', 'USD', 'EUR', 'GBP'])).toBe(false);
    expect(checkoutHasUnsupportedCurrency(['PKR', 'JPY'])).toBe(true);
    expect(checkoutHasUnsupportedCurrency(['usd', ''])).toBe(false);
  });

  it('rounds decimal edge cases to exact minor units', () => {
    expect(roundCurrencyAmount(1.005)).toBe(1.01);
    expect(roundCurrencyAmount(2.675)).toBe(2.68);
    expect(roundCurrencyAmount(-1.005)).toBe(-1.01);
    expect(toCurrencyMinorUnits('999.99')).toBe(99999);
    expect(toCurrencyMinorUnits('.005')).toBe(1);
    expect(toCurrencyMinorUnits('5e-3')).toBe(1);
  });

  it('rejects safe integer cents that cannot round-trip through major-unit Numbers', () => {
    expect(toCurrencyMinorUnits('70368744177664.00')).toBe(7036874417766400);
    expect(roundCurrencyAmount(70368744177664)).toBe(70368744177664);
    expect(toCurrencyMinorUnits('70368744177664.01')).toBe(0);
    expect(toCurrencyMinorUnits('90071992547409.90')).toBe(0);
    expect(toCurrencyMinorUnits('90071992547409.91')).toBe(0);
    expect(toCurrencyMinorUnits('90071992547409.92')).toBe(0);
    expect(toCurrencyMinorUnits(1, -1)).toBe(0);
    expect(toCurrencyMinorUnits(1, 1.5)).toBe(0);
    expect(toCurrencyMinorUnits(1, 7)).toBe(0);
    expect(toCurrencyMinorUnits(1, '2')).toBe(0);
    expect(toCurrencyMinorUnits(true)).toBe(0);
    expect(toCurrencyMinorUnits('')).toBe(0);
    expect(addCurrencyAmounts(70368744177664, 0.01)).toBe(0);
    expect(multiplyCurrencyAmount(35184372088832.01, 2)).toBe(0);
  });

  it('preserves native amounts and converts all supported pairs from one rate table', () => {
    const rates = { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 };
    expect(convertCurrencyAmount(284.6, 'PKR', 'PKR', rates)).toBe(284.6);
    expect(convertCurrencyAmount(1, 'USD', 'PKR', rates)).toBe(284.6);
    expect(convertCurrencyAmount(284.6, 'PKR', 'USD', rates)).toBe(1);
    expect(convertCurrencyAmount(10, 'EUR', 'PKR', rates)).toBe(3093.48);
    expect(convertCurrencyAmount(10, 'GBP', 'EUR', rates)).toBe(11.65);
  });

  it('multiplies in the native currency before rounding the converted line', () => {
    const rates = { USD: 1, PKR: 280, EUR: 0.92, GBP: 0.79 };
    expect(convertCurrencyAmount(1, 'PKR', 'USD', rates)).toBe(0);
    expect(convertCurrencyLineAmount(1, 1000, 'PKR', 'USD', rates)).toBe(3.57);
    expect(convertCurrencyLineAmount(1, 1000, 'PKR', 'PKR', rates)).toBe(1000);
  });

  it('conserves target cents across a same-source currency bucket', () => {
    const rates = { USD: 1, PKR: 280, EUR: 0.92, GBP: 0.79 };
    expect(convertCurrencyLineAmounts([
      { unitAmount: 1, quantity: 140, sourceCurrency: 'PKR' },
      { unitAmount: 1, quantity: 140, sourceCurrency: 'PKR' },
    ], 'USD', rates)).toEqual([0.5, 0.5]);
    expect(convertCurrencyLineAmounts([
      { unitAmount: 1.25, quantity: 4, sourceCurrency: 'PKR' },
      { unitAmount: 0.01, quantity: 1000, sourceCurrency: 'USD' },
    ], 'PKR', rates)).toEqual([5, 2800]);
  });

  it('rounds every foreign source globally while preserving native target cents', () => {
    const rates = { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 };
    expect(convertCurrencyLineAmounts([
      { unitAmount: 0.01, quantity: 1, sourceCurrency: 'USD' },
      { unitAmount: 1, quantity: 1, sourceCurrency: 'PKR' },
      { unitAmount: 0.01, quantity: 1, sourceCurrency: 'GBP' },
    ], 'USD', rates)).toEqual([0.01, 0.01, 0.01]);
  });

  it('does not overcharge when separately rounded foreign buckets would add a cent', () => {
    const rates = { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 };
    expect(convertCurrencyLineAmounts([
      { unitAmount: 2, quantity: 1, sourceCurrency: 'PKR' },
      { unitAmount: 0.02, quantity: 1, sourceCurrency: 'GBP' },
    ], 'USD', rates)).toEqual([0.01, 0.02]);
  });

  it('breaks equal foreign-cent remainders by original line order', () => {
    const rates = { USD: 1, PKR: 100, EUR: 0.92, GBP: 2 };
    expect(convertCurrencyLineAmounts([
      { unitAmount: 0.5, quantity: 1, sourceCurrency: 'PKR' },
      { unitAmount: 0.01, quantity: 1, sourceCurrency: 'GBP' },
    ], 'USD', rates)).toEqual([0.01, 0]);
    expect(convertCurrencyLineAmounts([
      { unitAmount: 0.01, quantity: 1, sourceCurrency: 'GBP' },
      { unitAmount: 0.5, quantity: 1, sourceCurrency: 'PKR' },
    ], 'USD', rates)).toEqual([0.01, 0]);
  });

  it('matches backend capped global conversion allocation for foreign amounts', () => {
    const rates = { USD: 1, PKR: 284.6 };
    expect(allocateConvertedCurrencyAmounts([
      { sourceAmount: 4, sourceCurrency: 'PKR', maximumTargetAmount: 1, maximumAllocatedTargetAmount: 1 },
      { sourceAmount: 4, sourceCurrency: 'PKR', maximumTargetAmount: 1, maximumAllocatedTargetAmount: 1 },
    ], 'USD', rates)).toEqual([0.02, 0.01]);
    expect(allocateConvertedCurrencyAmounts([
      { sourceAmount: 100, sourceCurrency: 'PKR', maximumTargetAmount: 0.2, maximumAllocatedTargetAmount: 0.15 },
      { sourceAmount: 100, sourceCurrency: 'PKR', maximumTargetAmount: 0.2, maximumAllocatedTargetAmount: 0.15 },
    ], 'USD', rates)).toEqual([0.15, 0.15]);
  });

  it('rejects non-safe line quantities instead of coercing them into money', () => {
    const rates = { USD: 1, PKR: 280 };
    expect(convertCurrencyLineAmount(100, true, 'PKR', 'USD', rates)).toBe(0);
    expect(convertCurrencyLineAmount(100, '', 'PKR', 'USD', rates)).toBe(0);
    expect(convertCurrencyLineAmount(100, 1.5, 'PKR', 'USD', rates)).toBe(0);
    expect(convertCurrencyLineAmount(100, Number.MAX_SAFE_INTEGER + 1, 'PKR', 'USD', rates)).toBe(0);
  });

  it('sums and multiplies through integer minor units', () => {
    expect(multiplyCurrencyAmount(19.99, 3)).toBe(59.97);
    expect(addCurrencyAmounts(0.1, 0.2, 19.99)).toBe(20.29);
    expect(percentageCurrencyAmount(0.05, 10)).toBe(0.01);
  });

  it('allocates every cent exactly without negative line discounts', () => {
    const allocations = allocateCurrencyAmount(0.05, Array(10).fill(1));
    expect(addCurrencyAmounts(...allocations)).toBe(0.05);
    expect(allocations.every((amount) => amount >= 0)).toBe(true);
    expect(allocations.filter((amount) => amount === 0.01)).toHaveLength(5);
  });

  it('allocates large uneven cent weights without floating-point remainder drift', () => {
    const amount = 1000000000.01;
    const weights = [999999999.99, 0.01, 0.01];
    const allocations = allocateCurrencyAmount(amount, weights);
    expect(allocations).toEqual(weights);
    expect(toCurrencyMinorUnits(addCurrencyAmounts(...allocations))).toBe(toCurrencyMinorUnits(amount));
  });

  it('breaks equal allocation remainders by original line order', () => {
    expect(allocateCurrencyAmount(0.03, [1, 1, 1, 1])).toEqual([0.01, 0.01, 0.01, 0]);
    expect(allocateCurrencyAmount(0.01, [1000000000, 1000000000, 1000000000])).toEqual([0.01, 0, 0]);
  });

  it('keeps retry keys only for ambiguous request outcomes', () => {
    expect(shouldRetainIdempotencyKey(undefined)).toBe(true);
    expect(shouldRetainIdempotencyKey(408)).toBe(true);
    expect(shouldRetainIdempotencyKey(503)).toBe(true);
    expect(shouldRetainIdempotencyKey(400)).toBe(false);
    expect(shouldRetainIdempotencyKey(409)).toBe(true);
  });
});
