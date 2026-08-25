jest.mock('expo-linking', () => ({
  createURL: jest.fn((path = '') => `rozare://${String(path).replace(/^\//, '')}`),
}));
import { readFileSync } from 'fs';
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { appOwnership: 'standalone' },
}));

import {
  buildSellerShipping,
  cancelOrderPaymentAttempt,
  calculateCouponPricing,
  CHECKOUT_ATTEMPT_MAX_AGE_MS,
  createCheckoutAttemptKey,
  createCheckoutFingerprint,
  getCartItemQuantity,
  getOrCreateCheckoutAttempt,
  findCouponOverlap,
  isCheckoutRepriceRequired,
  isPositiveSourceAmountRoundedToZero,
  isTransientPaymentVerificationError,
  normalizePaymentStatus,
  parseCheckoutCouponAvailabilityResponse,
  parseCheckoutShippingMethodsResponse,
  parseCheckoutTaxConfigResponse,
  parsePaymentRedirect,
  parseValidatedCheckoutCouponResponse,
  prepareStripeAfterOrderResponse,
  reconcileAppliedCheckoutCoupons,
  runOrderPaymentSheetAttempt,
  selectDefaultShippingMethods,
  verifyOrderPayment,
} from '../../src/utils/checkout';
import { convertCurrencyAmount, convertCurrencyLineAmounts } from '../../src/utils/currencySafety';
import {
  MUTATION_ATTEMPT_MAX_AGE_MS,
  clearPersistedMutationAttemptForFingerprint,
  createChatMutationFingerprint,
  createMutationAttemptRecordStorageKey,
  createScopedMutationStorageKey,
  getOrCreatePersistedMutationAttempt,
  getOrCreatePersistedMutationAttemptForFingerprint,
} from '../../src/utils/persistedMutationAttempt';

describe('checkout production contracts', () => {
  const shippingMethod = (overrides = {}) => ({
    type: 'standard',
    cost: 5,
    currency: 'USD',
    costCurrency: 'USD',
    costInputAmount: 5,
    deliveryDays: 5,
    isActive: true,
    ...overrides,
  });

  it('never coerces a present malformed cart quantity into one', () => {
    expect(getCartItemQuantity({})).toBe(1);
    expect(getCartItemQuantity({ qty: null })).toBe(1);
    expect(getCartItemQuantity({ qty: 2, quantity: 2 })).toBe(2);
    [0, -1, 1.5, '2', true, Number.POSITIVE_INFINITY].forEach((qty) => {
      expect(() => getCartItemQuantity({ qty })).toThrow(
        expect.objectContaining({ code: 'CART_PRESENTATION_DATA_INVALID' }),
      );
    });
    expect(() => getCartItemQuantity({ qty: 1, quantity: 2 })).toThrow();
    expect(() => createCheckoutFingerprint({
      orderItems: [{ id: 'p1', quantity: '2' }],
    })).toThrow(expect.objectContaining({ code: 'CART_PRESENTATION_DATA_INVALID' }));
  });

  it('selects free shipping by default and preserves a valid buyer choice', () => {
    const sellerMap = {
      sellerA: { methods: [
        { type: 'standard', cost: 8, deliveryDays: 5 },
        { type: 'free', cost: 0, deliveryDays: 8 },
      ] },
      sellerB: { methods: [{ type: 'fast', cost: 12, deliveryDays: 2 }] },
    };

    expect(selectDefaultShippingMethods(sellerMap, {}).sellerA.type).toBe('free');
    expect(selectDefaultShippingMethods(sellerMap, { sellerA: { type: 'standard' } }).sellerA.type).toBe('standard');
  });

  it('blocks checkout until every seller has an explicit shipping selection', () => {
    const sellerMap = {
      sellerA: { methods: [shippingMethod({ type: 'free', cost: 0, costInputAmount: 0 })] },
      sellerB: { methods: [shippingMethod()] },
    };
    const partial = buildSellerShipping({
      sellerMap,
      selections: { sellerA: sellerMap.sellerA.methods[0] },
      convertShippingCost: (method) => method.cost,
    });
    expect(partial.valid).toBe(false);
    expect(partial.missingSellerIds).toEqual(['sellerB']);

    const complete = buildSellerShipping({
      sellerMap,
      selections: { sellerA: sellerMap.sellerA.methods[0], sellerB: sellerMap.sellerB.methods[0] },
      convertShippingCost: (method) => method.cost,
    });
    expect(complete.valid).toBe(true);
    expect(complete.shippingCost).toBe(5);
    expect(complete.sellerShipping).toHaveLength(2);
  });

  it('globally allocates tiny foreign shipping fees without losing their combined cent', () => {
    const sellerMap = {
      sellerA: { methods: [shippingMethod({ cost: 1, currency: 'PKR', costCurrency: 'PKR', costInputAmount: 1 })] },
      sellerB: { methods: [shippingMethod({ cost: 1, currency: 'PKR', costCurrency: 'PKR', costInputAmount: 1 })] },
    };
    const selections = {
      sellerA: sellerMap.sellerA.methods[0],
      sellerB: sellerMap.sellerB.methods[0],
    };
    const result = buildSellerShipping({
      sellerMap,
      selections,
      sellerIds: ['sellerA', 'sellerB'],
      convertShippingCost: () => 0,
      convertShippingCosts: (entries) => convertCurrencyLineAmounts(entries.map(({ method }) => ({
        unitAmount: method.cost,
        quantity: 1,
        sourceCurrency: method.currency,
      })), 'USD', { USD: 1, PKR: 284.6 }),
    });

    expect(result.valid).toBe(true);
    expect(result.shippingCost).toBe(0.01);
    expect(result.sellerShipping.map((entry) => entry.shippingMethod.price)).toEqual([0.01, 0]);
  });

  it('accepts only canonical shipping responses for exactly the cart sellers', () => {
    const payload = () => ({
      success: true,
      shippingMethods: {
        sellerA: {
          seller: { _id: 'sellerA', username: 'Store A' },
          paymentPolicy: 'advance_only',
          allowsCashOnDelivery: false,
          methods: [shippingMethod({ cost: 250, currency: 'PKR', costCurrency: 'PKR', costInputAmount: 250 })],
        },
      },
    });
    expect(parseCheckoutShippingMethodsResponse(payload(), ['sellerA']).sellerA.methods[0].cost).toBe(250);

    [
      (value) => { value.success = false; },
      (value) => { value.shippingMethods.sellerA.seller._id = 'sellerB'; },
      (value) => { value.shippingMethods.sellerA.allowsCashOnDelivery = true; },
      (value) => { value.shippingMethods.sellerA.methods[0].cost = '250'; },
      (value) => { value.shippingMethods.sellerA.methods[0].cost = 250.001; },
      (value) => { value.shippingMethods.sellerA.methods[0].currency = 'pkr'; },
      (value) => { value.shippingMethods.sellerA.methods[0].costCurrency = 'USD'; },
      (value) => { value.shippingMethods.sellerA.methods[0].deliveryDays = true; },
      (value) => { value.shippingMethods.sellerA.methods[0].isActive = false; },
    ].forEach((corrupt) => {
      const value = payload();
      corrupt(value);
      expect(() => parseCheckoutShippingMethodsResponse(value, ['sellerA'])).toThrow();
    });
    expect(() => parseCheckoutShippingMethodsResponse(payload(), ['sellerB'])).toThrow();
  });

  it('fails tax closed unless a successful response explicitly confirms a valid configuration', () => {
    expect(parseCheckoutTaxConfigResponse({
      success: true,
      taxConfig: { type: 'none', value: 0, currency: 'USD' },
    })).toEqual({ type: 'none', value: 0, currency: 'USD' });
    expect(parseCheckoutTaxConfigResponse({
      success: true,
      taxConfig: { type: 'fixed', value: 125.25, currency: 'PKR' },
    })).toEqual({ type: 'fixed', value: 125.25, currency: 'PKR' });
    expect(parseCheckoutTaxConfigResponse({
      success: true,
      taxConfig: { type: 'percentage', value: 5, currency: 'USD' },
    }).value).toBe(5);
    expect(parseCheckoutTaxConfigResponse({
      success: true,
      taxConfig: { type: 'percentage', value: 0, currency: 'USD' },
    })).toEqual({ type: 'percentage', value: 0, currency: 'USD' });
    expect(parseCheckoutTaxConfigResponse({
      success: true,
      taxConfig: { type: 'fixed', value: 0, currency: 'PKR' },
    })).toEqual({ type: 'fixed', value: 0, currency: 'PKR' });

    [
      { success: false, taxConfig: { type: 'none', value: 0 } },
      { success: true, taxConfig: [] },
      { success: true, taxConfig: { type: 'NONE', value: 0, currency: 'USD' } },
      { success: true, taxConfig: { type: 'none', value: 4, currency: 'PKR' } },
      { success: true, taxConfig: { type: 'percentage', value: '5', currency: 'USD' } },
      { success: true, taxConfig: { type: 'percentage', value: 7.1234567, currency: 'USD' } },
      { success: true, taxConfig: { type: 'percentage', value: 5, currency: 'PKR' } },
      { success: true, taxConfig: { type: 'percentage', value: 100.01, currency: 'USD' } },
      { success: true, taxConfig: { type: 'fixed', value: 1, currency: 'JPY' } },
      { success: true, taxConfig: { type: 'fixed', value: '1.00', currency: 'USD' } },
      { success: true, taxConfig: { type: 'fixed', value: 1.001, currency: 'USD' } },
      { success: true, taxConfig: { type: 'fixed', value: 1, currency: 'usd' } },
    ].forEach((payload) => expect(() => parseCheckoutTaxConfigResponse(payload)).toThrow());
  });

  it('requires canonical authoritative coupon availability and validation responses', () => {
    const coupon = {
      _id: 'couponA',
      code: 'SAVE10',
      discountType: 'fixed',
      discountValue: 25,
      currency: 'PKR',
      applicableTo: 'all',
      applicableProducts: [],
      minOrderAmount: 100,
      maxDiscountAmount: null,
    };
    expect(parseCheckoutCouponAvailabilityResponse({
      sellerCoupons: { sellerA: [coupon] },
    }, ['sellerA']).sellerA[0].discountValue).toBe(25);
    expect(parseValidatedCheckoutCouponResponse({
      valid: true,
      coupon: { ...coupon, seller: 'sellerA', applicableProductIds: ['productA'] },
    }, { expectedSellerIds: ['sellerA'], expectedProductIds: ['productA'] }).seller).toBe('sellerA');

    [
      { discountValue: '25' },
      { discountValue: 25.001 },
      { currency: 'pkr' },
      { minOrderAmount: true },
      { maxDiscountAmount: 0 },
    ].forEach((mutation) => {
      expect(() => parseCheckoutCouponAvailabilityResponse({
        sellerCoupons: { sellerA: [{ ...coupon, ...mutation }] },
      }, ['sellerA'])).toThrow();
    });
    expect(() => parseValidatedCheckoutCouponResponse({
      valid: true,
      coupon: { ...coupon, seller: 'sellerB', applicableProductIds: ['productA'] },
    }, { expectedSellerIds: ['sellerA'], expectedProductIds: ['productA'] })).toThrow();
  });

  it('recognizes exact repricing conflicts and distinguishes paid sub-cent shipping from free shipping', () => {
    expect(isCheckoutRepriceRequired({ response: { status: 409, data: { code: 'CHECKOUT_REPRICE_REQUIRED' } } })).toBe(true);
    expect(isCheckoutRepriceRequired({ response: { status: 409, data: { code: 'COUPON_UPDATE_CONFLICT' } } })).toBe(false);
    expect(isCheckoutRepriceRequired({ response: { status: 400, data: { code: 'CHECKOUT_REPRICE_REQUIRED' } } })).toBe(false);
    expect(isPositiveSourceAmountRoundedToZero(1, 0)).toBe(true);
    expect(isPositiveSourceAmountRoundedToZero(0, 0)).toBe(false);
    expect(isPositiveSourceAmountRoundedToZero(1, 0.01)).toBe(false);
  });

  it('applies a fixed coupon once and proportionally allocates it across eligible lines', () => {
    const cartItems = [
      { _id: 'line-a', product: { _id: 'product-a' }, qty: 2, unitPrice: 25 },
      { _id: 'line-b', product: { _id: 'product-b' }, qty: 1, unitPrice: 50 },
    ];
    const coupon = {
      _id: 'coupon-a', code: 'FIXED20', discountType: 'fixed', discountValue: 20,
      currency: 'USD',
      applicableProductIds: ['product-a', 'product-b'],
    };
    const pricing = calculateCouponPricing({
      appliedCoupons: [coupon],
      cartItems,
      getItemPrice: (item) => item.unitPrice,
      convertCouponAmount: (amount) => amount,
      targetCurrency: 'USD',
      exchangeRates: { USD: 1 },
    });

    expect(pricing.totalDiscount).toBe(20);
    expect(pricing.lineDiscounts.get('line-a')).toBe(10);
    expect(pricing.lineDiscounts.get('line-b')).toBe(10);
  });

  it('uses authoritative pre-converted line totals for coupon scope math', () => {
    const cartItems = [
      { _id: 'cheap-bulk', product: { _id: 'product-pkr' }, qty: 1000, convertedUnitPrice: 0 },
    ];
    const pricing = calculateCouponPricing({
      appliedCoupons: [{
        _id: 'coupon-pkr',
        discountType: 'percentage',
        discountValue: 10,
        currency: 'USD',
        applicableProductIds: ['product-pkr'],
      }],
      cartItems,
      getItemPrice: (item) => item.convertedUnitPrice,
      getItemLineTotal: () => 3.57,
      convertCouponAmount: (amount) => amount,
      targetCurrency: 'USD',
      exchangeRates: { USD: 1 },
    });

    expect(pricing.couponDiscounts[0].eligibleSubtotal).toBe(3.57);
    expect(pricing.totalDiscount).toBe(0.36);
    expect(pricing.lineDiscounts.get('cheap-bulk')).toBe(0.36);
  });

  it('globally allocates foreign coupon cents exactly like backend settlement', () => {
    const rates = { USD: 1, PKR: 284.6 };
    const cartItems = [
      { _id: 'line-a', product: { _id: 'product-a' }, qty: 1 },
      { _id: 'line-b', product: { _id: 'product-b' }, qty: 1 },
    ];
    const pricing = calculateCouponPricing({
      appliedCoupons: [
        { _id: 'coupon-b', code: 'B', currency: 'PKR', discountType: 'fixed', discountValue: 4, applicableProductIds: ['product-b'] },
        { _id: 'coupon-a', code: 'A', currency: 'PKR', discountType: 'fixed', discountValue: 4, applicableProductIds: ['product-a'] },
      ],
      cartItems,
      getItemLineTotal: () => 1,
      convertCouponAmount: (amount, coupon) => convertCurrencyAmount(amount, coupon.currency, 'USD', rates),
      targetCurrency: 'USD',
      exchangeRates: rates,
    });

    expect(pricing.error).toBeNull();
    expect(pricing.totalDiscount).toBe(0.03);
    expect(pricing.couponDiscounts.map(({ coupon, discount }) => [coupon._id, discount])).toEqual([
      ['coupon-a', 0.02],
      ['coupon-b', 0.01],
    ]);
  });

  it('blocks a foreign coupon whose backend allocation rounds to zero', () => {
    const rates = { USD: 1, PKR: 284.6 };
    const pricing = calculateCouponPricing({
      appliedCoupons: [{
        _id: 'coupon-tiny', code: 'TINY', currency: 'PKR', discountType: 'fixed', discountValue: 1,
        applicableProductIds: ['product-a'],
      }],
      cartItems: [{ _id: 'line-a', product: { _id: 'product-a' }, qty: 1 }],
      getItemLineTotal: () => 1,
      convertCouponAmount: (amount) => convertCurrencyAmount(amount, 'PKR', 'USD', rates),
      targetCurrency: 'USD',
      exchangeRates: rates,
    });

    expect(pricing.totalDiscount).toBe(0);
    expect(pricing.error).toContain('too small');
  });

  it.each([
    ['boolean discount', { discountValue: true }],
    ['string discount', { discountValue: '1' }],
    ['sub-cent fixed discount', { discountValue: 1.001 }],
    ['over-precise percentage', { discountType: 'percentage', discountValue: 0.1234567 }],
    ['boolean minimum', { minOrderAmount: false }],
    ['boolean maximum', { maxDiscountAmount: false }],
    ['missing currency', { currency: undefined }],
    ['noncanonical currency', { currency: 'usd' }],
    ['unsupported currency', { currency: 'CAD' }],
    ['unknown type', { discountType: 'mystery' }],
    ['collided fixed amount', { discountValue: 70368744177664.02 }],
  ])('fails closed for %s in an authoritative coupon response', (_label, override) => {
    const pricing = calculateCouponPricing({
      appliedCoupons: [{
        _id: 'coupon-corrupt',
        code: 'BAD',
        currency: 'USD',
        discountType: 'fixed',
        discountValue: 1,
        applicableProductIds: ['product-a'],
        ...override,
      }],
      cartItems: [{ _id: 'line-a', product: { _id: 'product-a' }, qty: 1 }],
      getItemLineTotal: () => 10,
      targetCurrency: 'USD',
      exchangeRates: { USD: 1 },
    });
    expect(pricing.totalDiscount).toBe(0);
    expect(pricing.error).toContain('invalid');
  });

  it('supports multiple coupons only on non-overlapping products', () => {
    const existing = [{ _id: 'c1', applicableProductIds: ['p1', 'p2'] }];
    expect(findCouponOverlap({ applicableProductIds: ['p2', 'p3'] }, existing)).toEqual(['p2']);
    expect(findCouponOverlap({ applicableProductIds: ['p3'] }, existing)).toEqual([]);
  });

  it('reconciles applied coupons to authoritative values and removes unavailable coupons', () => {
    const cart = [
      { product: { _id: 'product-a', seller: { _id: 'seller-a' } } },
      { product: { _id: 'product-b', seller: 'seller-a' } },
      { product: { _id: 'product-c', seller: 'seller-b' } },
    ];
    const reconciled = reconcileAppliedCheckoutCoupons([
      {
        _id: 'coupon-a', seller: 'seller-a', code: 'SAVE', discountType: 'fixed',
        discountValue: 5, currency: 'USD', applicableProductIds: ['product-a', 'product-b'],
      },
      {
        _id: 'coupon-b', seller: 'seller-b', code: 'OLD', discountType: 'percentage',
        discountValue: 10, applicableProductIds: ['product-c'],
      },
    ], cart, {
      'seller-a': [{
        _id: 'coupon-a', code: 'SAVE', discountType: 'fixed', discountValue: 900,
        currency: 'PKR', applicableTo: 'selected', applicableProducts: ['product-b'],
      }],
    });

    expect(reconciled).toEqual([expect.objectContaining({
      _id: 'coupon-a', discountValue: 900, currency: 'PKR', seller: 'seller-a',
      applicableProductIds: ['product-b'],
    })]);
  });

  it('parses native Stripe return links without trusting them as proof of payment', () => {
    expect(parsePaymentRedirect('rozare://payment-success?session_id=cs_123&orderId=ORD-1')).toEqual(expect.objectContaining({
      type: 'success', sessionId: 'cs_123', orderId: 'ORD-1',
    }));
    expect(parsePaymentRedirect('rozare://payment-cancel?orderId=ORD-1').type).toBe('cancel');
  });

  it('normalizes backend payment states conservatively', () => {
    expect(normalizePaymentStatus({ isPaid: true, status: 'pending' })).toBe('paid');
    expect(normalizePaymentStatus({ status: 'succeeded' })).toBe('paid');
    expect(normalizePaymentStatus({ status: 'expired' })).toBe('failed');
    expect(normalizePaymentStatus({ status: 'unknown' })).toBe('pending');
  });

  it('polls until the webhook-authoritative endpoint reports paid', async () => {
    const apiClient = {
      get: jest.fn()
        .mockResolvedValueOnce({ data: { status: 'pending', isPaid: false } })
        .mockResolvedValueOnce({ data: { status: 'paid', isPaid: true } }),
    };
    const result = await verifyOrderPayment({
      apiClient,
      orderId: 'ORD-1',
      sessionId: 'cs_123',
      attempts: 3,
      delayMs: 0,
      sleep: jest.fn().mockResolvedValue(undefined),
    });
    expect(result.status).toBe('paid');
    expect(apiClient.get).toHaveBeenCalledTimes(2);
    expect(apiClient.get).toHaveBeenLastCalledWith('/api/order/payment-status/ORD-1', { params: { sessionId: 'cs_123' } });
  });

  it('sends a native PaymentIntent reference without requiring a Checkout Session', async () => {
    const apiClient = { get: jest.fn().mockResolvedValue({ data: { status: 'paid', isPaid: true } }) };
    const result = await verifyOrderPayment({
      apiClient,
      orderId: 'ORD-2',
      paymentIntentId: 'pi_123',
      attempts: 1,
    });
    expect(result.status).toBe('paid');
    expect(apiClient.get).toHaveBeenCalledWith('/api/order/payment-status/ORD-2', {
      params: { paymentIntentId: 'pi_123' },
    });
  });

  it.each([
    [409, 'CHECKOUT_IN_PROGRESS'],
    [429, 'PAYMENT_RATE_LIMITED'],
  ])('keeps polling after transient payment verification %i %s responses', async (status, code) => {
    const error = Object.assign(new Error(code), { response: { status, data: { code } } });
    const apiClient = { get: jest.fn().mockRejectedValue(error) };
    const sleep = jest.fn().mockResolvedValue(undefined);

    expect(isTransientPaymentVerificationError(error)).toBe(true);
    await expect(verifyOrderPayment({
      apiClient,
      orderId: 'ORD-PENDING',
      attempts: 2,
      delayMs: 0,
      sleep,
    })).resolves.toEqual(expect.objectContaining({ status: 'pending', error }));
    expect(apiClient.get).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('treats a non-transient payment verification rejection as terminal', async () => {
    const error = Object.assign(new Error('Not found'), {
      response: { status: 404, data: { code: 'ORDER_NOT_FOUND' } },
    });
    const apiClient = { get: jest.fn().mockRejectedValue(error) };

    await expect(verifyOrderPayment({ apiClient, orderId: 'ORD-MISSING', attempts: 3 }))
      .resolves.toEqual(expect.objectContaining({ status: 'failed', reason: 'verification_rejected' }));
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('closes a dismissed native order payment through the authoritative cancel endpoint', async () => {
    const apiClient = { post: jest.fn().mockResolvedValue({ data: { status: 'cancelled' } }) };
    const result = await cancelOrderPaymentAttempt({
      apiClient,
      orderId: 'ORD/3',
      paymentIntentId: 'pi_123',
    });
    expect(result.status).toBe('cancelled');
    expect(apiClient.post).toHaveBeenCalledWith('/api/order/payment/ORD%2F3/cancel', {
      paymentIntentId: 'pi_123',
    });
  });

  it('cancels the order and releases its reservation when PaymentSheet initialization fails', async () => {
    const initError = { code: 'Failed', localizedMessage: 'PaymentSheet could not initialize' };
    const apiClient = { post: jest.fn().mockResolvedValue({ data: { status: 'cancelled' } }) };
    const presentPaymentSheet = jest.fn();

    const result = await runOrderPaymentSheetAttempt({
      initPaymentSheet: jest.fn().mockResolvedValue({ error: initError }),
      presentPaymentSheet,
      options: {},
      apiClient,
      orderId: 'ORD/INIT',
      paymentIntentId: 'pi_init',
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'failed', stage: 'initialize', error: initError,
      cancellation: expect.objectContaining({ status: 'cancelled' }),
    }));
    expect(presentPaymentSheet).not.toHaveBeenCalled();
    expect(apiClient.post).toHaveBeenCalledWith('/api/order/payment/ORD%2FINIT/cancel', {
      paymentIntentId: 'pi_init',
    });
  });

  it('still calls order cleanup when the PaymentIntent reference is unavailable', async () => {
    const apiClient = { post: jest.fn().mockResolvedValue({ data: { status: 'cancelled' } }) };
    const result = await cancelOrderPaymentAttempt({ apiClient, orderId: 'ORD-REF' });

    expect(result.status).toBe('cancelled');
    expect(apiClient.post).toHaveBeenCalledWith('/api/order/payment/ORD-REF/cancel', {});
  });

  it('routes an already-succeeded cancellation race to server verification', async () => {
    const error = Object.assign(new Error('Already succeeded'), {
      response: { status: 409, data: { code: 'PAYMENT_ALREADY_SUCCEEDED' } },
    });
    const result = await cancelOrderPaymentAttempt({
      apiClient: { post: jest.fn().mockRejectedValue(error) },
      orderId: 'ORD-4',
      paymentIntentId: 'pi_456',
    });
    expect(result.status).toBe('payment_received');
  });

  it('keeps an unresolved payment attempt retry-safe when cancellation is unavailable', async () => {
    const result = await cancelOrderPaymentAttempt({
      apiClient: { post: jest.fn().mockRejectedValue(new Error('offline')) },
      orderId: 'ORD-5',
      paymentIntentId: 'pi_789',
    });
    expect(result).toEqual(expect.objectContaining({
      status: 'unavailable', reason: 'cancellation_unconfirmed',
    }));
  });

  it('creates a stable namespaced idempotency value from secure UUID entropy', () => {
    expect(createCheckoutAttemptKey(() => 'uuid-1')).toBe('mobile-checkout:uuid-1');
    expect(() => createCheckoutAttemptKey()).toThrow('Secure checkout retry-key generation is unavailable');
  });

  it('does not initialize Stripe when the server atomically completes a no-charge card order', async () => {
    const ensureStripeReady = jest.fn().mockResolvedValue({ publishableKey: 'pk_test_should_not_load' });

    const completed = await prepareStripeAfterOrderResponse({
      response: {
        data: {
          isPaid: true,
          completed: true,
          noPaymentRequired: true,
          orderId: 'ORD-FREE-1',
        },
      },
      normalizedPayment: { completed: true },
      ensureStripeReady,
    });

    expect(completed).toEqual({ paymentRequired: false, stripeConfig: null });
    expect(ensureStripeReady).not.toHaveBeenCalled();

    const payable = await prepareStripeAfterOrderResponse({
      response: { data: { isPaid: false, completed: false, paymentIntentId: 'pi_payable' } },
      normalizedPayment: { completed: false },
      ensureStripeReady,
    });
    expect(payable).toEqual({
      paymentRequired: true,
      stripeConfig: { publishableKey: 'pk_test_should_not_load' },
    });
    expect(ensureStripeReady).toHaveBeenCalledTimes(1);
  });

  it('changes the checkout fingerprint for every money-affecting buyer choice', () => {
    const base = {
      orderItems: [{ id: 'p1', quantity: 1, selectedColor: 'red' }],
      shippingInfo: { city: 'Karachi' },
      buyerLocation: { countryCode: 'PK' },
      sellerShipping: [{ seller: 's1', shippingMethod: { name: 'standard' } }],
      currency: 'PKR',
      appliedCoupons: [{ couponId: 'c1', code: 'SAVE', applicableProductIds: ['p1'] }],
      paymentMethod: 'stripe',
      instructions: '',
    };
    const original = createCheckoutFingerprint(base);
    expect(createCheckoutFingerprint({ ...base, currency: 'USD' })).not.toBe(original);
    expect(createCheckoutFingerprint({ ...base, instructions: 'Call first' })).not.toBe(original);
    expect(createCheckoutFingerprint({ ...base, shippingInfo: { city: 'Lahore' } })).not.toBe(original);
    expect(createCheckoutFingerprint({ ...base, appliedCoupons: [] })).not.toBe(original);
  });

  it('keeps the retry fingerprint stable when only live prices or delivery estimates change', () => {
    const base = {
      orderItems: [{ id: 'p1', quantity: 2, price: 0.02, sourcePrice: 5 }],
      shippingInfo: { city: 'Karachi', address: '1 Test Road' },
      buyerLocation: { countryCode: 'PK' },
      shippingMethod: { seller: 's1', name: 'standard', price: 4.1, estimatedDays: 4 },
      sellerShipping: [{ seller: 's1', shippingMethod: { name: 'standard', price: 4.1, estimatedDays: 4 } }],
      orderSummary: { subtotal: 0.04, shippingCost: 4.1, totalAmount: 4.14 },
      currency: 'PKR',
      appliedCoupons: [{ couponId: 'c1', code: 'SAVE', applicableProductIds: ['p1'], discountValue: 1 }],
      paymentMethod: 'wallet',
      clientSurface: 'mobile',
    };
    const repriced = {
      ...base,
      orderItems: [{ ...base.orderItems[0], price: 0.03 }],
      shippingMethod: { ...base.shippingMethod, price: 4.25, estimatedDays: 6 },
      sellerShipping: [{ seller: 's1', shippingMethod: { name: 'standard', price: 4.25, estimatedDays: 6 } }],
      orderSummary: { subtotal: 0.06, shippingCost: 4.25, totalAmount: 4.31 },
    };

    expect(createCheckoutFingerprint(repriced)).toBe(createCheckoutFingerprint(base));
  });

  it('canonicalizes item, coupon scope, seller, and object-key order', () => {
    const base = {
      orderItems: [
        { id: 'p2', quantity: 1, selectedOptions: { size: 'L', finish: 'matte' } },
        { id: 'p1', quantity: 2 },
      ],
      shippingInfo: { fullName: 'Buyer', city: 'Karachi', address: '1 Test Road', email: ' Buyer@Example.COM ' },
      buyerLocation: { countryCode: 'PK', country: 'Pakistan' },
      sellerShipping: [
        { seller: 's2', shippingMethod: { name: 'fast' } },
        { seller: 's1', shippingMethod: { name: 'standard' } },
      ],
      currency: 'PKR',
      appliedCoupons: [{ couponId: 'c1', code: 'save', applicableProductIds: ['p2', 'p1'] }],
      paymentMethod: 'wallet',
      clientSurface: 'mobile',
    };
    const reordered = {
      ...base,
      orderItems: [...base.orderItems].reverse(),
      shippingInfo: { address: '1 Test Road', city: 'Karachi', fullName: 'Buyer', email: 'buyer@example.com' },
      sellerShipping: [...base.sellerShipping].reverse(),
      appliedCoupons: [{ ...base.appliedCoupons[0], applicableProductIds: ['p1', 'p2'] }],
    };

    expect(createCheckoutFingerprint(reordered)).toBe(createCheckoutFingerprint(base));
  });

  it('rotates the retry fingerprint for shipping method, payment method, or currency changes', () => {
    const base = {
      orderItems: [{ id: 'p1', quantity: 1 }],
      shippingInfo: { city: 'Karachi' },
      buyerLocation: { countryCode: 'PK' },
      sellerShipping: [{ seller: 's1', shippingMethod: { name: 'standard', price: 4 } }],
      currency: 'PKR',
      paymentMethod: 'wallet',
      clientSurface: 'mobile',
    };
    const original = createCheckoutFingerprint(base);
    expect(createCheckoutFingerprint({ ...base, sellerShipping: [{ seller: 's1', shippingMethod: { name: 'fast', price: 4 } }] })).not.toBe(original);
    expect(createCheckoutFingerprint({ ...base, paymentMethod: 'cash_on_delivery' })).not.toBe(original);
    expect(createCheckoutFingerprint({ ...base, currency: 'USD' })).not.toBe(original);
  });

  it('restores a persisted attempt after restart and rotates it only when buyer intent changes', async () => {
    const values = new Map();
    const storage = {
      getItem: jest.fn(async (key) => values.get(key) || null),
      setItem: jest.fn(async (key, value) => { values.set(key, value); }),
      removeItem: jest.fn(async (key) => { values.delete(key); }),
    };
    const now = 1_800_000_000_000;

    const first = await getOrCreateCheckoutAttempt({ storage, fingerprint: 'intent-a', now });
    const afterRestart = await getOrCreateCheckoutAttempt({ storage, fingerprint: 'intent-a', now: now + 60_000 });
    const changedIntent = await getOrCreateCheckoutAttempt({ storage, fingerprint: 'intent-b', now: now + 120_000 });

    expect(first).toEqual({
      key: expect.stringMatching(/^mobile-checkout:v2:[a-f0-9]{64}:0$/),
      fingerprint: 'intent-a',
      createdAt: now,
    });
    expect(afterRestart).toEqual(first);
    expect(changedIntent.key).toMatch(/^mobile-checkout:v2:[a-f0-9]{64}:0$/);
    expect(changedIntent.key).not.toBe(first.key);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('uses a 24-hour retry window and refuses to mutate when the attempt cannot be persisted', async () => {
    expect(CHECKOUT_ATTEMPT_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
    const storage = {
      getItem: jest.fn().mockResolvedValue(null),
      setItem: jest.fn().mockRejectedValue(new Error('storage full')),
      removeItem: jest.fn(),
    };

    await expect(getOrCreateCheckoutAttempt({
      storage,
      fingerprint: 'intent',
      randomUUID: () => 'uuid',
    })).rejects.toThrow('storage full');
  });

  it('persists withdrawal, chat, and top-up mutation attempts across app restarts', async () => {
    const values = new Map();
    const storage = {
      getItem: jest.fn(async (key) => values.get(key) || null),
      setItem: jest.fn(async (key, value) => { values.set(key, value); }),
      removeItem: jest.fn(async (key) => { values.delete(key); }),
    };
    const uuids = ['first', 'second'];
    const now = 1_800_000_000_000;
    const first = await getOrCreatePersistedMutationAttempt({
      storage, storageKey: 'attempt', fingerprint: 'USD:5.00', keyPrefix: 'mobile-wallet',
      randomUUID: () => uuids.shift(), now,
    });
    const replay = await getOrCreatePersistedMutationAttempt({
      storage, storageKey: 'attempt', fingerprint: 'USD:5.00', keyPrefix: 'mobile-wallet',
      randomUUID: () => uuids.shift(), now: now + MUTATION_ATTEMPT_MAX_AGE_MS - 1,
    });
    const changed = await getOrCreatePersistedMutationAttempt({
      storage, storageKey: 'attempt', fingerprint: 'PKR:5.00', keyPrefix: 'mobile-wallet',
      randomUUID: () => uuids.shift(), now: now + 1000,
    });

    expect(MUTATION_ATTEMPT_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
    expect(createScopedMutationStorageKey('checkout', 'seller/one')).toBe('checkout:seller%2Fone');
    expect(createScopedMutationStorageKey('checkout', 'seller-a'))
      .not.toBe(createScopedMutationStorageKey('checkout', 'seller-b'));
    expect(replay.key).toBe(first.key);
    expect(changed.key).not.toBe(first.key);
    expect(createChatMutationFingerprint({ actorId: 'u1', currency: 'pkr', text: ' Confirm order ' }))
      .toBe(createChatMutationFingerprint({ actorId: 'u1', currency: 'PKR', text: 'Confirm order' }));
    expect(createChatMutationFingerprint({ actorId: 'u1', attachments: [{ name: 'same.jpg', type: 'image/jpeg', size: 10, uri: 'file:///a', assetId: 'a' }] }))
      .not.toBe(createChatMutationFingerprint({ actorId: 'u1', attachments: [{ name: 'same.jpg', type: 'image/jpeg', size: 10, uri: 'file:///b', assetId: 'b' }] }));
  });

  it('fails closed when a persisted mutation or checkout attempt cannot be read back', async () => {
    const storage = {
      getItem: jest.fn().mockResolvedValue(null),
      setItem: jest.fn().mockResolvedValue(undefined),
      removeItem: jest.fn().mockResolvedValue(undefined),
    };
    await expect(getOrCreatePersistedMutationAttempt({
      storage,
      storageKey: 'attempt',
      fingerprint: 'USD:5.00',
      keyPrefix: 'mobile-wallet',
      randomUUID: () => 'uuid',
    })).rejects.toThrow('could not be confirmed');
    await expect(getOrCreateCheckoutAttempt({
      storage,
      fingerprint: 'checkout-intent',
      randomUUID: () => 'uuid',
    })).rejects.toThrow('could not be confirmed');
  });

  it('uses independent collision-free chat records and rotates only a terminal intent', async () => {
    const values = new Map();
    const storage = {
      getItem: jest.fn(async (key) => values.get(key) || null),
      setItem: jest.fn(async (key, value) => { values.set(key, value); }),
      removeItem: jest.fn(async (key) => { values.delete(key); }),
    };
    const uuids = ['first', 'second', 'after-terminal'];
    const now = 1_800_000_000_000;
    const [first, second] = await Promise.all([
      getOrCreatePersistedMutationAttemptForFingerprint({
        storage, storageKey: 'chat-ledger', fingerprint: 'intent-a', keyPrefix: 'chat',
        randomUUID: () => uuids.shift(), now,
      }),
      getOrCreatePersistedMutationAttemptForFingerprint({
        storage, storageKey: 'chat-ledger', fingerprint: 'intent-b', keyPrefix: 'chat',
        randomUUID: () => uuids.shift(), now: now + 1,
      }),
    ]);
    const firstReplay = await getOrCreatePersistedMutationAttemptForFingerprint({
      storage, storageKey: 'chat-ledger', fingerprint: 'intent-a', keyPrefix: 'chat',
      randomUUID: () => uuids.shift(), now: now + 2,
    });

    expect(firstReplay.key).toBe(first.key);
    expect(second.key).not.toBe(first.key);
    const firstRecordKey = await createMutationAttemptRecordStorageKey('chat-ledger', 'intent-a');
    const secondRecordKey = await createMutationAttemptRecordStorageKey('chat-ledger', 'intent-b');
    expect(firstRecordKey).not.toBe(secondRecordKey);
    expect(firstRecordKey).not.toContain('intent-a');
    expect(firstRecordKey.length).toBeLessThan(100);
    expect(JSON.parse(values.get(firstRecordKey)).attempt.key).toBe(first.key);
    expect(JSON.parse(values.get(secondRecordKey)).attempt.key).toBe(second.key);
    expect(values.has('chat-ledger')).toBe(false);

    await expect(clearPersistedMutationAttemptForFingerprint(
      storage,
      'chat-ledger',
      'intent-b',
      second.key,
      now + 3,
    )).resolves.toBe(true);
    const afterTerminal = await getOrCreatePersistedMutationAttemptForFingerprint({
      storage, storageKey: 'chat-ledger', fingerprint: 'intent-b', keyPrefix: 'chat',
      randomUUID: () => uuids.shift(), now: now + 4,
    });
    expect(afterTerminal.key).not.toBe(second.key);
    expect(JSON.parse(values.get(firstRecordKey)).attempt.key).toBe(first.key);
  });

  it('migrates every fresh legacy chat retry without deleting the safety copy', async () => {
    const now = 1_800_000_000_000;
    const legacyAttempts = [
      { key: 'chat:legacy-a', fingerprint: 'intent-a', createdAt: now - 2 },
      { key: 'chat:legacy-b', fingerprint: 'intent-b', createdAt: now - 1 },
    ];
    const values = new Map([[
      'chat-ledger',
      JSON.stringify({ version: 1, attempts: legacyAttempts }),
    ]]);
    const storage = {
      getItem: jest.fn(async (key) => values.get(key) || null),
      setItem: jest.fn(async (key, value) => { values.set(key, value); }),
      removeItem: jest.fn(async (key) => { values.delete(key); }),
    };

    await getOrCreatePersistedMutationAttemptForFingerprint({
      storage, storageKey: 'chat-ledger', fingerprint: 'intent-c', keyPrefix: 'chat',
      randomUUID: () => 'new-c', now,
    });
    for (const attempt of legacyAttempts) {
      const recordKey = await createMutationAttemptRecordStorageKey('chat-ledger', attempt.fingerprint);
      const persisted = JSON.parse(values.get(recordKey));
      expect(persisted.attempt.key).toBe(attempt.key);
      expect(persisted.attempt.createdAt).toBe(attempt.createdAt);
    }
    expect(JSON.parse(values.get('chat-ledger')).attempts).toEqual(legacyAttempts);

    await clearPersistedMutationAttemptForFingerprint(
      storage,
      'chat-ledger',
      'intent-a',
      legacyAttempts[0].key,
      now + 1,
    );
    const rotated = await getOrCreatePersistedMutationAttemptForFingerprint({
      storage, storageKey: 'chat-ledger', fingerprint: 'intent-a', keyPrefix: 'chat',
      randomUUID: () => 'new-a', now: now + 2,
    });
    expect(rotated.key).not.toBe(legacyAttempts[0].key);
    expect(rotated.key).toMatch(/^chat:v2:[a-f0-9]{64}:1$/);
  });

  it('keeps retyped yes retries fail-closed until the original attempt is terminal', async () => {
    const values = new Map();
    const storage = {
      getAllKeys: jest.fn(async () => [...values.keys()]),
      getItem: jest.fn(async (key) => values.get(key) || null),
      setItem: jest.fn(async (key, value) => { values.set(key, value); }),
      removeItem: jest.fn(async (key) => { values.delete(key); }),
    };
    const now = 1_800_000_000_000;
    const fingerprint = createChatMutationFingerprint({
      actorId: 'buyer-1', currency: 'PKR', text: 'yes',
    });
    const retypedFingerprint = createChatMutationFingerprint({
      actorId: 'buyer-1', currency: 'pkr', text: ' YES ',
      conversationId: 'changed-after-lost-response',
    });
    expect(retypedFingerprint).toBe(fingerprint);

    const first = await getOrCreatePersistedMutationAttemptForFingerprint({
      storage, storageKey: 'chat-ledger', fingerprint, keyPrefix: 'chat',
      randomUUID: () => 'first', now,
    });
    const unresolvedRetry = await getOrCreatePersistedMutationAttemptForFingerprint({
      storage, storageKey: 'chat-ledger', fingerprint: retypedFingerprint, keyPrefix: 'chat',
      randomUUID: () => 'must-not-run', now: now + 1,
    });
    expect(unresolvedRetry.key).toBe(first.key);

    await clearPersistedMutationAttemptForFingerprint(
      storage,
      'chat-ledger',
      fingerprint,
      first.key,
      now + 2,
    );
    const nextYes = await getOrCreatePersistedMutationAttemptForFingerprint({
      storage, storageKey: 'chat-ledger', fingerprint, keyPrefix: 'chat',
      randomUUID: () => 'second', now: now + 3,
    });
    expect(nextYes.key).not.toBe(first.key);
    expect([...values.keys()].filter(key => key.includes(':terminal:'))).toHaveLength(1);

    await getOrCreatePersistedMutationAttemptForFingerprint({
      storage,
      storageKey: 'chat-ledger',
      fingerprint: 'cleanup-trigger',
      keyPrefix: 'chat',
      now: now + MUTATION_ATTEMPT_MAX_AGE_MS + 4,
    });
    expect([...values.keys()].filter(key => key.includes(':terminal:'))).toHaveLength(0);
  });

  it('does not let a stale or uncorrelated mobile return terminalize a newer generation', async () => {
    const values = new Map();
    const storage = {
      getAllKeys: jest.fn(async () => [...values.keys()]),
      getItem: jest.fn(async (key) => values.get(key) || null),
      setItem: jest.fn(async (key, value) => { values.set(key, value); }),
      removeItem: jest.fn(async (key) => { values.delete(key); }),
    };
    const options = {
      storage,
      storageKey: 'mobile-wallet:buyer-1',
      fingerprint: 'buyer-1:PKR:500.00',
      keyPrefix: 'mobile-wallet',
    };
    const now = 1_800_000_000_000;
    const generation0 = await getOrCreatePersistedMutationAttemptForFingerprint({ ...options, now });
    await expect(clearPersistedMutationAttemptForFingerprint(
      storage, options.storageKey, options.fingerprint, generation0.key, now + 1,
    )).resolves.toBe(true);
    const generation1 = await getOrCreatePersistedMutationAttemptForFingerprint({ ...options, now: now + 2 });

    await expect(clearPersistedMutationAttemptForFingerprint(
      storage, options.storageKey, options.fingerprint, generation0.key, now + 3,
    )).resolves.toBe(false);
    await expect(clearPersistedMutationAttemptForFingerprint(
      storage, options.storageKey, options.fingerprint, '', now + 4,
    )).resolves.toBe(false);
    const replay = await getOrCreatePersistedMutationAttemptForFingerprint({ ...options, now: now + 5 });
    expect(replay.key).toBe(generation1.key);
  });

  it('does not recycle a durable mobile idempotency key after record compaction', async () => {
    const values = new Map();
    const storage = {
      getAllKeys: jest.fn(async () => [...values.keys()]),
      getItem: jest.fn(async (key) => values.get(key) || null),
      setItem: jest.fn(async (key, value) => { values.set(key, value); }),
      removeItem: jest.fn(async (key) => { values.delete(key); }),
    };
    const options = {
      storage,
      storageKey: 'mobile-checkout:buyer-1',
      fingerprint: 'same-order-intent',
      keyPrefix: 'mobile-checkout',
    };
    const now = 1_800_000_000_000;
    const generation0 = await getOrCreatePersistedMutationAttemptForFingerprint({ ...options, now });
    await expect(clearPersistedMutationAttemptForFingerprint(
      storage,
      options.storageKey,
      options.fingerprint,
      generation0.key,
      now + 1,
    )).resolves.toBe(true);

    const afterCompaction = await getOrCreatePersistedMutationAttemptForFingerprint({
      ...options,
      now: now + (32 * 24 * 60 * 60 * 1000),
    });
    expect(afterCompaction.key).not.toBe(generation0.key);
    expect(afterCompaction.key).toMatch(/^mobile-checkout:v2:[a-f0-9]{64}:1$/);
  });

  it('serializes concurrent mobile invocations onto one deterministic generation', async () => {
    const values = new Map();
    const storage = {
      getAllKeys: jest.fn(async () => [...values.keys()]),
      getItem: jest.fn(async (key) => values.get(key) || null),
      setItem: jest.fn(async (key, value) => {
        await Promise.resolve();
        values.set(key, value);
      }),
      removeItem: jest.fn(async (key) => { values.delete(key); }),
    };
    const options = {
      storage,
      storageKey: 'mobile-checkout:buyer-1',
      fingerprint: 'buyer-1:checkout-intent',
      keyPrefix: 'mobile-checkout',
      now: 1_800_000_000_000,
    };

    const [first, second, third] = await Promise.all([
      getOrCreatePersistedMutationAttemptForFingerprint(options),
      getOrCreatePersistedMutationAttemptForFingerprint(options),
      getOrCreatePersistedMutationAttemptForFingerprint(options),
    ]);
    expect(second.key).toBe(first.key);
    expect(third.key).toBe(first.key);
    expect([...values.keys()].filter(key => key.includes(':attempt-v2:'))).toHaveLength(1);
  });

  it('wires mobile money submissions to deterministic ledgers, synchronous guards, and exact return correlation', () => {
    const checkoutSource = readFileSync(require.resolve('../../src/screens/CheckoutScreen.js'), 'utf8');
    const walletSource = readFileSync(require.resolve('../../src/screens/WalletScreen.js'), 'utf8');
    const sellerPaymentsSource = readFileSync(require.resolve('../../src/screens/seller/SellerPaymentsScreen.js'), 'utf8');
    const successSource = readFileSync(require.resolve('../../src/screens/PaymentSuccessScreen.js'), 'utf8');

    expect(checkoutSource).toMatch(/submittingRef\.current/);
    expect(checkoutSource).toMatch(/checkoutAttemptFingerprint: fingerprint/);
    expect(checkoutSource).toMatch(/checkoutAttemptKey: checkoutAttempt\.key/);
    expect(checkoutSource).toMatch(/checkoutAttemptKey: paymentNotice\.checkoutAttemptKey/);
    expect(walletSource).toMatch(/topUpSubmissionRef\.current/);
    expect(walletSource).toMatch(/getOrCreatePersistedMutationAttemptInLedger/);
    expect(walletSource).toMatch(/type: 'pending',[\s\S]{0,80}title: 'Checking top-up status'/);
    expect(walletSource).toMatch(/title: 'Checking top-up status'/);
    expect(walletSource).not.toMatch(/route\.params\.top_up === 'success'[\s\S]{0,200}type: 'success'/);
    expect(sellerPaymentsSource).toMatch(/withdrawalSubmissionRef\.current/);
    expect(sellerPaymentsSource).toMatch(/getOrCreatePersistedMutationAttemptInLedger/);
    expect(successSource).toMatch(/if \(hasAttemptCorrelation\)/);
  });

  it('fails closed when an independent chat attempt cannot be read back', async () => {
    const storage = {
      getItem: jest.fn().mockResolvedValue(null),
      setItem: jest.fn().mockResolvedValue(undefined),
      removeItem: jest.fn().mockResolvedValue(undefined),
    };
    await expect(getOrCreatePersistedMutationAttemptForFingerprint({
      storage,
      storageKey: 'chat-ledger',
      fingerprint: 'intent-a',
      keyPrefix: 'chat',
      randomUUID: () => 'uuid',
    })).rejects.toThrow('could not be confirmed');
  });
});
