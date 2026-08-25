const { __private, executeToolCall } = require('../../services/aiActionExecutor');

describe('aiActionExecutor currency resolution', () => {
  test('accepts supported codes and human aliases but rejects unsupported write currencies', () => {
    expect(__private.isRecognizedAIPriceCurrency('PKR')).toBe(true);
    expect(__private.isRecognizedAIPriceCurrency('British pounds')).toBe(true);
    expect(__private.isRecognizedAIPriceCurrency('CAD')).toBe(false);
  });

  test('keeps seller preferred currency when model emits USD for a plain number', () => {
    expect(__private.resolveAIPriceCurrency({
      value: 2500,
      requestedCurrency: 'USD',
      preferredCurrency: 'PKR',
      lastUserText: 'add cotton shirt for 2500',
    })).toBe('PKR');
  });

  test('honors a validated explicit USD tool field when the write contract marks it trusted', () => {
    expect(__private.resolveAIPriceCurrency({
      value: 10,
      requestedCurrency: 'USD',
      preferredCurrency: 'PKR',
      lastUserText: 'set the amount to 10',
      trustRequestedCurrency: true,
    })).toBe('USD');
  });

  test('honors explicit currency aliases from import rows', () => {
    expect(__private.resolveAIPriceCurrency({
      value: 2500,
      requestedCurrency: 'Pakistani Rupee',
      preferredCurrency: 'USD',
      lastUserText: 'import these products',
    })).toBe('PKR');

    expect(__private.resolveAIPriceCurrency({
      value: 35,
      requestedCurrency: 'British pounds',
      preferredCurrency: 'USD',
      lastUserText: 'import these products',
    })).toBe('GBP');
  });

  test('lets explicit price text beat the preferred currency', () => {
    expect(__private.resolveAIPriceCurrency({
      value: '€19.99',
      requestedCurrency: 'USD',
      preferredCurrency: 'PKR',
      lastUserText: 'add this accessory',
    })).toBe('EUR');
  });
});

describe('aiActionExecutor product currency conversion notice', () => {
  test('explains when an explicit price currency is converted to store product currency', async () => {
    const notice = await __private.buildProductCurrencyConversionNotice({
      sourceAmount: 10,
      sourceCurrency: 'USD',
      savedAmount: 2846,
      productCurrency: 'PKR',
    });

    expect(notice).toContain('Your selected product currency is PKR');
    expect(notice).toContain("can't save this product in USD");
    expect(notice).toContain('converted');
    expect(notice).toContain('saved that as the product price');
  });

  test('does not add a conversion notice when input already matches product currency', async () => {
    await expect(__private.buildProductCurrencyConversionNotice({
      sourceAmount: 1000,
      sourceCurrency: 'PKR',
      savedAmount: 1000,
      productCurrency: 'PKR',
    })).resolves.toBe('');
  });
});

describe('aiActionExecutor stored money integrity', () => {
  test('currency-less AI order products remain canonical USD and corrupt metadata fails closed', () => {
    expect(__private.stableAIProductCurrency({ price: 10 })).toBe('USD');
    expect(() => __private.stableAIProductCurrency({ price: 10, currency: 'CAD' })).toThrow(
      expect.objectContaining({ code: 'PRODUCT_CURRENCY_METADATA_INVALID' })
    );
    for (const currency of [null, '', false]) {
      expect(() => __private.stableAIProductCurrency({ price: 10, currency })).toThrow(
        expect.objectContaining({ code: 'PRODUCT_CURRENCY_METADATA_INVALID' })
      );
    }
    expect(() => __private.stableAIProductCurrency({
      price: 10,
      currency: 'USD',
      priceCurrency: 'PKR',
    })).toThrow(expect.objectContaining({ code: 'PRODUCT_CURRENCY_METADATA_INVALID' }));
  });

  test('currency-less AI shipping remains canonical USD and corrupt metadata fails closed', () => {
    expect(__private.requireStoredAIShippingCurrency({ cost: 10 })).toBe('USD');
    expect(__private.requireStoredAIShippingMethod({ type: 'standard', cost: 10 })).toEqual({
      currency: 'USD',
      cost: 10,
    });
    expect(() => __private.requireStoredAIShippingCurrency({ cost: 10, currency: 'CAD' })).toThrow(
      expect.objectContaining({ code: 'SHIPPING_CURRENCY_METADATA_INVALID' })
    );
    for (const currency of [null, '', false]) {
      expect(() => __private.requireStoredAIShippingCurrency({ cost: 10, currency })).toThrow(
        expect.objectContaining({ code: 'SHIPPING_CURRENCY_METADATA_INVALID' })
      );
    }
    expect(() => __private.requireStoredAIShippingCurrency({
      cost: 10,
      currency: 'USD',
      costCurrency: 'PKR',
    })).toThrow(expect.objectContaining({ code: 'SHIPPING_CURRENCY_METADATA_INVALID' }));
    for (const method of [
      { type: 'standard', cost: Number.POSITIVE_INFINITY, currency: 'USD' },
      { type: 'standard', cost: 0.001, currency: 'USD' },
      { type: 'standard', cost: 10, costInputAmount: 0.001, currency: 'USD' },
      { type: 'free', cost: 1, currency: 'USD' },
    ]) {
      expect(() => __private.requireStoredAIShippingMethod(method)).toThrow(
        expect.objectContaining({ code: 'SHIPPING_COST_INVALID' })
      );
    }
  });

  test('AI ordering fails closed for corrupt persisted tax configuration', () => {
    expect(__private.requireStoredAITaxConfig({ type: 'fixed', value: 10 })).toEqual({
      type: 'fixed', value: 10, currency: 'USD',
    });
    for (const config of [
      { type: 'bogus', value: 10, currency: 'USD' },
      { type: 'percentage', value: Number.POSITIVE_INFINITY, currency: 'USD' },
      { type: 'fixed', value: 0.001, currency: 'USD' },
      { type: 'fixed', value: 10, currency: 'CAD' },
      { type: 'fixed', value: 10, currency: null },
      { type: 'fixed', value: 10, currency: '' },
      { type: 'fixed', value: 10, currency: 'usd' },
      { type: 'fixed', value: 10, currency: ' USD ' },
      { type: 'fixed', value: 10, currency: false },
      { type: 'percentage', value: 7.1234567, currency: 'USD' },
      { type: 'none', value: 10, currency: 'USD' },
    ]) {
      expect(() => __private.requireStoredAITaxConfig(config)).toThrow(
        expect.objectContaining({ code: 'TAX_CONFIG_INVALID' })
      );
    }
  });

  test.each([0.001, 0.005, 10.001, -0.001, -0.005, -10.001])(
    'rejects a non-exact-cent AI money amount: %s', value => {
    expect(__private.normalizeMoneyAmount(value)).toBeNull();
    }
  );

  test('does not mask corrupt derived seller revenue as zero', () => {
    expect(__private.requireAIDerivedMoney(undefined, 'revenue')).toBe(0);
    expect(__private.requireAIDerivedMoney(null, 'revenue')).toBe(0);
    expect(__private.requireAIDerivedMoney(0, 'revenue')).toBe(0);
    expect(__private.requireAIDerivedMoney(10.01, 'revenue')).toBe(10.01);
    for (const value of ['', '10', false, Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.004]) {
      expect(() => __private.requireAIDerivedMoney(value, 'revenue')).toThrow(
        expect.objectContaining({ code: 'AI_FINANCIAL_DATA_INVALID' })
      );
    }
  });
});

describe('aiActionExecutor seller money-write validation', () => {
  const seller = { _id: '64b000000000000000000001', role: 'seller', currency: 'PKR' };

  test.each([
    ['update_shipping', { method: 'standard', cost: 500, currency: 'CAD' }, 'Shipping currency'],
    ['update_shipping', { method: 'free', cost: 1, currency: 'PKR' }, 'Free shipping'],
    ['update_shipping', { method: 'standard', cost: 500, deliveryDays: 1.5, currency: 'PKR' }, 'Delivery days'],
    ['update_shipping', { method: 'standard', cost: true, currency: 'PKR' }, 'non-negative number'],
    ['update_shipping', { method: 'standard', cost: ' ', currency: 'PKR' }, 'non-negative number'],
    ['create_coupon', { discountType: 'fixed', discountValue: 500, currency: 'CAD' }, 'Coupon currency'],
    ['create_coupon', { discountType: 'fixed', discountValue: 0.004, currency: 'PKR' }, 'at least 0.01'],
    ['create_coupon', { discountType: 'fixed', discountValue: 10, minOrderAmount: 0.004, currency: 'PKR' }, 'at least 0.01'],
    ['create_coupon', { discountType: 'percentage', discountValue: 0.005 }, 'between 0.01% and 100%'],
    ['create_coupon', { discountType: 'percentage', discountValue: 10, maxUses: 1.5 }, 'whole number'],
    ['create_coupon', { discountType: 'fixed', discountValue: true, currency: 'PKR' }, 'positive number'],
    ['create_coupon', { discountType: 'fixed', discountValue: 10, maxUses: true }, 'whole number'],
    ['bulk_discount', { discountType: 'percentage', discountValue: true }, 'positive discount'],
    ['bulk_price_update', { updateType: 'set', value: '' }, 'valid price update'],
    ['bulk_price_update', { updateType: 'percentage', value: 1e100 }, 'too large'],
    ['bulk_price_update', { updateType: 'percentage', value: -1e100 }, 'too large'],
  ])('rejects unsafe %s input before any write', async (tool, args, expectedError) => {
    await expect(executeToolCall(tool, args, seller)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining(expectedError),
    });
  });
});

describe('aiActionExecutor tax money normalization', () => {
  test('validates a partial update against the persisted tax type', () => {
    expect(() => __private.normalizeTaxConfigUpdate(
      { value: 101 },
      { type: 'percentage', value: 10, currency: 'USD', isActive: true },
      'PKR',
    )).toThrow('cannot exceed 100%');
  });

  test('preserves a fixed tax native currency without silently rounding input', () => {
    expect(__private.normalizeTaxConfigUpdate(
      { value: 500.01 },
      { type: 'fixed', value: 500, currency: 'PKR', isActive: true },
      'USD',
    )).toEqual({
      type: 'fixed',
      value: 500.01,
      currency: 'PKR',
      isActive: true,
    });
    expect(() => __private.normalizeTaxConfigUpdate(
      { value: 500.005 },
      { type: 'fixed', value: 500, currency: 'PKR', isActive: true },
      'USD',
    )).toThrow('exact amount to cents');
  });

  test('uses the selected chat currency for a new fixed tax and rejects coerced inputs', () => {
    expect(__private.normalizeTaxConfigUpdate(
      { type: 'fixed', value: 25 },
      null,
      'GBP',
    )).toMatchObject({ type: 'fixed', value: 25, currency: 'GBP' });
    expect(() => __private.normalizeTaxConfigUpdate(
      { type: 'fixed', value: null, currency: 'PKR' },
      null,
      'PKR',
    )).toThrow('non-negative number');
    expect(() => __private.normalizeTaxConfigUpdate(
      { isActive: 'false' },
      { type: 'none', value: 0, currency: 'USD', isActive: true },
      'USD',
    )).toThrow('true or false');
    expect(() => __private.normalizeTaxConfigUpdate(
      { type: 'fixed', value: 0.004, currency: 'PKR' },
      null,
      'PKR',
    )).toThrow('exact amount to cents');
    expect(() => __private.normalizeTaxConfigUpdate(
      { type: 'percentage', value: 1.0000001 },
      null,
      'USD',
    )).toThrow('at most 6 decimal places');
  });
});
