jest.mock('expo-linking', () => ({
  createURL: jest.fn((path = '') => `rozare://${String(path).replace(/^\//, '')}`),
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { appOwnership: 'standalone' },
}));

import {
  buildSellerShipping,
  cancelOrderPaymentAttempt,
  calculateCouponPricing,
  createCheckoutAttemptKey,
  findCouponOverlap,
  normalizePaymentStatus,
  parsePaymentRedirect,
  runOrderPaymentSheetAttempt,
  selectDefaultShippingMethods,
  verifyOrderPayment,
} from '../../src/utils/checkout';

describe('checkout production contracts', () => {
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
      sellerA: { methods: [{ type: 'free', cost: 0 }] },
      sellerB: { methods: [{ type: 'standard', cost: 5 }] },
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

  it('applies a fixed coupon once and proportionally allocates it across eligible lines', () => {
    const cartItems = [
      { _id: 'line-a', product: { _id: 'product-a' }, qty: 2, unitPrice: 25 },
      { _id: 'line-b', product: { _id: 'product-b' }, qty: 1, unitPrice: 50 },
    ];
    const coupon = {
      _id: 'coupon-a', code: 'FIXED20', discountType: 'fixed', discountValue: 20,
      applicableProductIds: ['product-a', 'product-b'],
    };
    const pricing = calculateCouponPricing({
      appliedCoupons: [coupon],
      cartItems,
      getItemPrice: (item) => item.unitPrice,
      convertCouponAmount: (amount) => amount,
    });

    expect(pricing.totalDiscount).toBe(20);
    expect(pricing.lineDiscounts.get('line-a')).toBe(10);
    expect(pricing.lineDiscounts.get('line-b')).toBe(10);
  });

  it('supports multiple coupons only on non-overlapping products', () => {
    const existing = [{ _id: 'c1', applicableProductIds: ['p1', 'p2'] }];
    expect(findCouponOverlap({ applicableProductIds: ['p2', 'p3'] }, existing)).toEqual(['p2']);
    expect(findCouponOverlap({ applicableProductIds: ['p3'] }, existing)).toEqual([]);
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
  });
});
