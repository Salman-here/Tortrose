import {
  buildSellerShipping,
  calculateCouponPricing,
  createCheckoutAttemptKey,
  findCouponOverlap,
  normalizePaymentStatus,
  parsePaymentRedirect,
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

  it('creates a stable namespaced idempotency value from secure UUID entropy', () => {
    expect(createCheckoutAttemptKey(() => 'uuid-1')).toBe('mobile-checkout:uuid-1');
  });
});

