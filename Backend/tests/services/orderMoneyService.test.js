const fc = require('fast-check');

const {
  buildOrderItemMoneyAllocations,
  buildOrderSellerSettlement,
  convertOrderAmount,
  convertOrderAmountAtCheckout,
  formatOrderMoney,
  getFrozenSellerSettlement,
  getRequestedCurrency,
  resolveRequestedCurrency,
  sellerSettlementUsdTargetForSource,
  sellerOrderSummary,
  isSellerRevenueRecognized,
  sumOrderAmountsInCurrency,
} = require('../../services/orderMoneyService');

const makeOrder = ({ tax = 0, shippingCost = 0, couponDiscount = 0 } = {}) => ({
  currency: 'USD',
  orderItems: [
    { _id: 'item-a', productId: 'product-a', seller: 'seller-a', price: 0.01, quantity: 1 },
    { _id: 'item-b', productId: 'product-b', seller: 'seller-b', price: 0.02, quantity: 1 },
  ],
  sellerShipping: [
    { seller: 'seller-a', shippingMethod: { price: shippingCost, name: 'standard' } },
    { seller: 'seller-b', shippingMethod: { price: 0, name: 'free' } },
  ],
  shippingMethod: { seller: 'seller-a', price: shippingCost },
  appliedCoupons: couponDiscount > 0 ? [{
    couponId: 'coupon-a',
    applicableProductIds: ['product-a', 'product-b'],
    appliedDiscountAmount: couponDiscount,
  }] : [],
  orderSummary: {
    subtotal: 0.03,
    shippingCost,
    tax,
    couponDiscount,
    totalAmount: Math.round((0.03 + shippingCost + tax - couponDiscount) * 100) / 100,
  },
  paymentMethod: 'stripe',
  isPaid: true,
  awaitingPayment: false,
  orderStatus: 'confirmed',
  sellerFulfillment: [
    { seller: 'seller-a', status: 'confirmed' },
    { seller: 'seller-b', status: 'confirmed' },
  ],
});

describe('orderMoneyService exact seller allocation', () => {
  test('financial presentation rejects corrupt stored money instead of relabelling or rounding it', () => {
    expect(formatOrderMoney(280, 'PKR')).toBe('Rs280.00 PKR');
    expect(() => formatOrderMoney(10, 'CAD'))
      .toThrow(expect.objectContaining({ code: 'ORDER_CURRENCY_INVALID' }));
    expect(() => formatOrderMoney(10, 'usd'))
      .toThrow(expect.objectContaining({ code: 'ORDER_CURRENCY_INVALID' }));
    expect(() => formatOrderMoney('', 'USD'))
      .toThrow(expect.objectContaining({ code: 'ORDER_MONEY_INVALID' }));
    expect(() => formatOrderMoney(0.001, 'USD'))
      .toThrow(expect.objectContaining({ code: 'ORDER_MONEY_INVALID' }));
  });

  test('financial reporting rejects a malformed stored unit of account', async () => {
    await expect(convertOrderAmount({ currency: 'usd' }, 10, 'USD'))
      .rejects.toMatchObject({ code: 'ORDER_CURRENCY_INVALID' });
    await expect(convertOrderAmount({ currency: 'USD' }, 10, 'CAD'))
      .rejects.toMatchObject({ code: 'ORDER_CURRENCY_INVALID' });
    await expect(convertOrderAmount({ currency: 'USD' }, 0.001, 'USD'))
      .rejects.toMatchObject({ code: 'ORDER_MONEY_INVALID' });
  });

  test('seller summaries reject corrupt stored quantities even when a line subtotal exists', () => {
    const order = makeOrder();
    order.orderItems[0].lineSubtotal = 0.01;
    order.orderItems[0].quantity = '';
    expect(() => sellerOrderSummary(order, ['product-a'], 'seller-a'))
      .toThrow(expect.objectContaining({ code: 'ORDER_MONEY_INVALID' }));
  });

  test('rejects unsupported direct and stored report currencies instead of silently using USD', async () => {
    expect(() => getRequestedCurrency({ query: { currency: 'CAD' } }))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CURRENCY' }));
    await expect(resolveRequestedCurrency(
      { user: { id: 'buyer-1' } },
      { findById: () => ({ select: () => ({ lean: async () => ({ currency: 'CAD' }) }) }) },
    )).rejects.toMatchObject({ code: 'UNSUPPORTED_CURRENCY', statusCode: 400 });
  });

  test('allocates a one-cent tax once across multiple sellers', () => {
    const order = makeOrder({ tax: 0.01 });
    const sellerA = sellerOrderSummary(order, ['product-a'], 'seller-a');
    const sellerB = sellerOrderSummary(order, ['product-b'], 'seller-b');

    expect(sellerA.tax + sellerB.tax).toBe(0.01);
    expect(sellerA.totalAmount + sellerB.totalAmount).toBe(order.orderSummary.totalAmount);
  });

  test('keeps zero tax exactly zero for every seller and reconciles the buyer total', () => {
    const order = makeOrder({ tax: 0 });
    const sellerA = sellerOrderSummary(order, ['product-a'], 'seller-a');
    const sellerB = sellerOrderSummary(order, ['product-b'], 'seller-b');

    expect(sellerA.tax).toBe(0);
    expect(sellerB.tax).toBe(0);
    expect(sellerA.totalAmount + sellerB.totalAmount).toBe(0.03);
  });

  test('reconciles subtotal, shipping, tax, and coupon discount at item and seller level', () => {
    const order = makeOrder({ shippingCost: 0.01, tax: 0.01, couponDiscount: 0.01 });
    const allocations = buildOrderItemMoneyAllocations(order);
    const sum = map => [...map.values()].reduce((total, amount) => total + amount, 0);
    const sellerA = sellerOrderSummary(order, ['product-a'], 'seller-a');
    const sellerB = sellerOrderSummary(order, ['product-b'], 'seller-b');

    expect(sum(allocations.shipping)).toBe(0.01);
    expect(sum(allocations.tax)).toBe(0.01);
    expect(sum(allocations.discount)).toBe(0.01);
    expect(sum(allocations.total)).toBe(0.04);
    expect(sellerA.totalAmount + sellerB.totalAmount).toBe(0.04);
  });

  test('retains every seller in the frozen ownership snapshot when a full discount makes the order free', () => {
    const order = makeOrder({ couponDiscount: 0.03 });
    const settlement = buildOrderSellerSettlement(order, { requireOrderTotal: true });

    expect(settlement).toEqual([
      expect.objectContaining({ seller: 'seller-a', sourceAmountMinor: 0, amountUSDMinor: 0 }),
      expect.objectContaining({ seller: 'seller-b', sourceAmountMinor: 0, amountUSDMinor: 0 }),
    ]);
    expect(settlement.reduce((sum, entry) => sum + entry.sourceAmountMinor, 0)).toBe(0);
  });

  test.each([
    ['non-finite tax', order => { order.orderSummary.tax = Number.POSITIVE_INFINITY; }],
    ['sub-cent shipping', order => { order.orderSummary.shippingCost = 0.001; }],
    ['blank total', order => { order.orderSummary.totalAmount = ''; }],
    ['mismatched subtotal', order => { order.orderSummary.subtotal = 0.04; }],
    ['discount beyond products', order => {
      order.orderSummary.couponDiscount = 0.04;
      order.orderSummary.totalAmount = 0;
    }],
  ])('fails seller accounting for corrupt persisted %s', (_label, mutate) => {
    const order = makeOrder();
    mutate(order);
    expect(() => buildOrderItemMoneyAllocations(order)).toThrow(expect.objectContaining({
      code: expect.stringMatching(/^ORDER_(?:MONEY_INVALID|TOTAL_MISMATCH)$/),
    }));
  });

  test('fails closed when individually valid lines overflow the reversible aggregate cent range', () => {
    const order = makeOrder();
    order.orderItems = [
      { _id: 'item-a', productId: 'product-a', seller: 'seller-a', price: 35184372088832.01, quantity: 1 },
      { _id: 'item-b', productId: 'product-b', seller: 'seller-b', price: 35184372088832.01, quantity: 1 },
    ];
    expect(() => buildOrderItemMoneyAllocations(order)).toThrow(expect.objectContaining({
      code: 'ORDER_MONEY_INVALID',
    }));
  });

  test('never reallocates a coupon whose stored scope points outside the order', () => {
    const order = makeOrder({ couponDiscount: 0.01 });
    order.appliedCoupons[0].applicableProductIds = ['missing-product'];
    expect(() => buildOrderItemMoneyAllocations(order)).toThrow(expect.objectContaining({
      code: 'ORDER_COUPON_ALLOCATION_INVALID',
    }));
  });

  test('never moves a reserved coupon discount onto another seller', () => {
    const order = makeOrder({ couponDiscount: 0.01 });
    order.couponUsageVersion = 1;
    order.appliedCoupons[0] = {
      ...order.appliedCoupons[0],
      seller: 'seller-b',
      discountType: 'fixed',
      currency: 'USD',
      applicableProductIds: ['product-a'],
    };

    expect(() => buildOrderItemMoneyAllocations(order)).toThrow(expect.objectContaining({
      code: 'ORDER_COUPON_ALLOCATION_INVALID',
    }));
  });

  test('recognizes paid online revenue and delivered COD, never pending/cancelled COD', () => {
    const stripe = makeOrder();
    expect(isSellerRevenueRecognized(stripe, 'seller-a')).toBe(true);

    const wallet = { ...stripe, paymentMethod: 'wallet' };
    expect(isSellerRevenueRecognized(wallet, 'seller-a')).toBe(true);

    const codPending = { ...stripe, paymentMethod: 'cash_on_delivery', isPaid: false };
    expect(isSellerRevenueRecognized(codPending, 'seller-a')).toBe(false);

    const codDelivered = {
      ...codPending,
      sellerFulfillment: [{ seller: 'seller-a', status: 'delivered' }],
    };
    expect(isSellerRevenueRecognized(codDelivered, 'seller-a')).toBe(true);

    const codCancelled = {
      ...codPending,
      sellerFulfillment: [{ seller: 'seller-a', status: 'cancelled' }],
    };
    expect(isSellerRevenueRecognized(codCancelled, 'seller-a')).toBe(false);
  });

  test('aggregates one currency before rounding instead of losing small orders', async () => {
    const entries = [0.004, 0.004, 0.004].map(amount => ({
      order: { currency: 'PKR' },
      amount,
    }));
    await expect(sumOrderAmountsInCurrency(entries, 'PKR')).resolves.toBe(0.01);
  });

  test.each([
    ['non-finite', Number.POSITIVE_INFINITY],
    ['boolean', true],
    ['blank', '   '],
    ['negative', -0.001],
    ['unsafe magnitude', Number.MAX_SAFE_INTEGER],
  ])('fails the complete report for a %s stored amount', async (_label, amount) => {
    await expect(sumOrderAmountsInCurrency([
      { order: { currency: 'USD' }, amount },
    ], 'USD')).rejects.toMatchObject({ code: 'ORDER_MONEY_INVALID', statusCode: 409 });
  });

  test('accepts an explicit numeric string zero without hiding malformed entries', async () => {
    await expect(sumOrderAmountsInCurrency([
      { order: { currency: 'USD' }, amount: '0' },
    ], 'USD')).resolves.toBe(0);
  });

  test('does not let a zero amount hide a corrupt stored order currency', async () => {
    for (const currency of ['CAD', 'pkr', ' PKR ', '']) {
      await expect(sumOrderAmountsInCurrency([
        { order: { currency }, amount: 0 },
      ], 'USD')).rejects.toMatchObject({ code: 'ORDER_CURRENCY_INVALID', statusCode: 409 });
    }
  });

  test('rounds mixed foreign-currency reporting totals once globally', async () => {
    const entries = [
      { order: { currency: 'PKR' }, amount: 1 },
      { order: { currency: 'GBP' }, amount: 0.01 },
    ];

    await expect(sumOrderAmountsInCurrency(entries, 'USD', {
      rateSnapshot: {
        rates: { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 },
        fallback: false,
      },
    })).resolves.toBe(0.02);
  });

  test('refuses fallback rates for authoritative cross-currency order totals', async () => {
    const entries = [{ order: { currency: 'USD' }, amount: 1 }];
    await expect(sumOrderAmountsInCurrency(entries, 'PKR', {
      rateSnapshot: {
        rates: { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 },
        fallback: true,
      },
    })).rejects.toMatchObject({
      statusCode: 503,
      code: 'EXCHANGE_RATES_UNAVAILABLE',
    });
  });

  test('does not charge a seller for another seller shipping snapshot', () => {
    const order = makeOrder({ shippingCost: 0.01 });
    order.sellerShipping = [
      { seller: 'seller-a', shippingMethod: { price: 0.01, name: 'standard' } },
    ];
    const sellerA = sellerOrderSummary(order, ['product-a'], 'seller-a');
    const sellerB = sellerOrderSummary(order, ['product-b'], 'seller-b');

    expect(sellerA.shippingCost).toBe(0.01);
    expect(sellerB.shippingCost).toBe(0);
    expect(sellerA.totalAmount + sellerB.totalAmount).toBe(order.orderSummary.totalAmount);
  });

  test('leaves a missing seller shipping row unallocated instead of stretching another seller snapshot', () => {
    const order = makeOrder({ shippingCost: 0.03 });
    order.sellerShipping = [
      { seller: 'seller-a', shippingMethod: { price: 0.01, name: 'standard' } },
    ];
    const allocations = buildOrderItemMoneyAllocations(order);
    const sellerA = sellerOrderSummary(order, ['product-a'], 'seller-a');
    const sellerB = sellerOrderSummary(order, ['product-b'], 'seller-b');

    expect(sellerA.shippingCost).toBe(0.01);
    expect(sellerB.shippingCost).toBe(0);
    expect(allocations.unallocatedShipping).toBe(0.02);
    expect(allocations.unallocatedTotal).toBe(0.02);
    expect(sellerA.totalAmount + sellerB.totalAmount).toBe(0.04);
    expect(order.orderSummary.totalAmount).toBe(0.06);
  });

  test('quarantines seller shipping snapshots that exceed the stored order shipping total', () => {
    const order = makeOrder({ shippingCost: 2 });
    order.sellerShipping = [
      { seller: 'seller-a', shippingMethod: { price: 2, name: 'standard' } },
      { seller: 'seller-b', shippingMethod: { price: 1, name: 'standard' } },
    ];

    expect(() => sellerOrderSummary(order, ['product-a'], 'seller-a'))
      .toThrow('Seller shipping snapshots exceed the stored order shipping total');
    expect(() => buildOrderSellerSettlement(order, { requireOrderTotal: true }))
      .toThrow('legacy multi-seller order has shipping with no durable seller owner');
  });

  test('treats explicit zero-price seller shipping rows as authoritative', () => {
    const order = makeOrder({ shippingCost: 0.03 });
    order.sellerShipping = [
      { seller: 'seller-a', shippingMethod: { price: 0, name: 'free' } },
      { seller: 'seller-b', shippingMethod: { price: 0, name: 'free' } },
    ];
    const allocations = buildOrderItemMoneyAllocations(order);
    const sellerA = sellerOrderSummary(order, ['product-a'], 'seller-a');
    const sellerB = sellerOrderSummary(order, ['product-b'], 'seller-b');

    expect([...allocations.shipping.values()].every(amount => amount === 0)).toBe(true);
    expect(allocations.unallocatedShipping).toBe(0.03);
    expect(allocations.unallocatedTotal).toBe(0.03);
    expect(sellerA.shippingCost).toBe(0);
    expect(sellerB.shippingCost).toBe(0);
  });

  test('keeps a one-cent seller coupon remainder inside its eligible tiny lines', () => {
    const order = {
      currency: 'USD',
      orderItems: [
        { _id: 'a-1', productId: 'a-1', seller: 'seller-a', price: 0.01, quantity: 1 },
        { _id: 'a-2', productId: 'a-2', seller: 'seller-a', price: 0.01, quantity: 1 },
        { _id: 'a-3', productId: 'a-3', seller: 'seller-a', price: 0.01, quantity: 1 },
        { _id: 'b-1', productId: 'b-1', seller: 'seller-b', price: 100, quantity: 1 },
      ],
      appliedCoupons: [{
        applicableProductIds: ['a-1', 'a-2', 'a-3'],
        appliedDiscountAmount: 0.01,
      }],
      orderSummary: {
        subtotal: 100.03,
        shippingCost: 0,
        tax: 0,
        couponDiscount: 0.01,
        totalAmount: 100.02,
      },
    };
    const allocations = buildOrderItemMoneyAllocations(order);
    const sellerA = sellerOrderSummary(order, ['a-1', 'a-2', 'a-3'], 'seller-a');
    const sellerB = sellerOrderSummary(order, ['b-1'], 'seller-b');

    expect(sellerA.couponDiscount).toBe(0.01);
    expect(sellerB.couponDiscount).toBe(0);
    expect([...allocations.discount.values()].reduce((sum, amount) => sum + amount, 0)).toBe(0.01);
  });

  test('conserves each coupon inside disjoint seller scopes', () => {
    const order = {
      currency: 'USD',
      orderItems: [
        { _id: 'a-1', productId: 'a-1', seller: 'seller-a', price: 0.01, quantity: 1 },
        { _id: 'a-2', productId: 'a-2', seller: 'seller-a', price: 0.01, quantity: 1 },
        { _id: 'a-3', productId: 'a-3', seller: 'seller-a', price: 0.01, quantity: 1 },
        { _id: 'b-1', productId: 'b-1', seller: 'seller-b', price: 1, quantity: 1 },
      ],
      appliedCoupons: [
        { applicableProductIds: ['a-1', 'a-2', 'a-3'], appliedDiscountAmount: 0.01 },
        { applicableProductIds: ['b-1'], appliedDiscountAmount: 0.02 },
      ],
      orderSummary: {
        subtotal: 1.03,
        shippingCost: 0,
        tax: 0,
        couponDiscount: 0.03,
        totalAmount: 1,
      },
    };

    expect(sellerOrderSummary(order, ['a-1', 'a-2', 'a-3'], 'seller-a').couponDiscount).toBe(0.01);
    expect(sellerOrderSummary(order, ['b-1'], 'seller-b').couponDiscount).toBe(0.02);
  });

  test.each([
    ['missing ids', [{ productId: 'product-a', seller: 'seller-a', price: 1, quantity: 1 }, { productId: 'product-b', seller: 'seller-b', price: 100, quantity: 1 }]],
    ['duplicate ids', [{ _id: 'same', productId: 'product-a', seller: 'seller-a', price: 1, quantity: 1 }, { _id: 'same', productId: 'product-b', seller: 'seller-b', price: 100, quantity: 1 }]],
  ])('keeps seller subsets distinct with %s', (_label, orderItems) => {
    const order = {
      currency: 'USD',
      orderItems,
      orderSummary: { subtotal: 101, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 101 },
    };

    expect(sellerOrderSummary(order, ['product-a'], 'seller-a').totalAmount).toBe(1);
    expect(sellerOrderSummary(order, ['product-b'], 'seller-b').totalAmount).toBe(100);
    expect([...buildOrderItemMoneyAllocations(order).total.values()]).toEqual([1, 100]);
  });

  test('aggregates duplicate seller shipping rows without losing or duplicating cents', () => {
    const order = makeOrder({ shippingCost: 0.03 });
    order.sellerShipping = [
      { seller: 'seller-a', shippingMethod: { price: 0.01 } },
      { seller: 'seller-a', shippingMethod: { price: 0.02 } },
      { seller: 'seller-b', shippingMethod: { price: 0 } },
    ];

    expect(sellerOrderSummary(order, ['product-a'], 'seller-a').shippingCost).toBe(0.03);
    expect(sellerOrderSummary(order, ['product-b'], 'seller-b').shippingCost).toBe(0);
    expect(buildOrderItemMoneyAllocations(order).unallocatedShipping).toBe(0);
  });

  test('never leaks a shipping snapshot across sellers when every product line is zero', () => {
    const order = {
      currency: 'USD',
      orderItems: [
        { _id: 'a-zero', productId: 'a-zero', seller: 'seller-a', price: 0, quantity: 1 },
        { _id: 'b-zero', productId: 'b-zero', seller: 'seller-b', price: 0, quantity: 1 },
      ],
      sellerShipping: [
        { seller: 'seller-a', shippingMethod: { price: 1 } },
        { seller: 'seller-b', shippingMethod: { price: 0 } },
      ],
      shippingMethod: { seller: 'seller-a', price: 1 },
      orderSummary: {
        subtotal: 0,
        shippingCost: 1,
        tax: 0,
        couponDiscount: 0,
        totalAmount: 1,
      },
    };

    const allocations = buildOrderItemMoneyAllocations(order);
    expect(sellerOrderSummary(order, ['a-zero'], 'seller-a').shippingCost).toBe(1);
    expect(sellerOrderSummary(order, ['b-zero'], 'seller-b').shippingCost).toBe(0);
    expect([...allocations.shipping.values()]).toEqual([1, 0]);
    expect(allocations.unallocatedShipping).toBe(0);
  });

  test('splits zero-subtotal shipping cents only among the owning seller lines', () => {
    const order = {
      currency: 'USD',
      orderItems: [
        { _id: 'a-zero-1', productId: 'a-zero-1', seller: 'seller-a', price: 0, quantity: 1 },
        { _id: 'a-zero-2', productId: 'a-zero-2', seller: 'seller-a', price: 0, quantity: 1 },
        { _id: 'b-zero', productId: 'b-zero', seller: 'seller-b', price: 0, quantity: 1 },
      ],
      sellerShipping: [
        { seller: 'seller-a', shippingMethod: { price: 0.03 } },
        { seller: 'seller-b', shippingMethod: { price: 0 } },
      ],
      orderSummary: {
        subtotal: 0,
        shippingCost: 0.03,
        tax: 0,
        couponDiscount: 0,
        totalAmount: 0.03,
      },
    };

    const allocations = buildOrderItemMoneyAllocations(order);
    expect([...allocations.shipping.values()]).toEqual([0.02, 0.01, 0]);
    expect(sellerOrderSummary(order, ['a-zero-1', 'a-zero-2'], 'seller-a').shippingCost).toBe(0.03);
    expect(sellerOrderSummary(order, ['b-zero'], 'seller-b').shippingCost).toBe(0);
  });

  test('uses each native order exchange-rate snapshot instead of current live rates', async () => {
    const snapshots = [
      [{ currency: 'PKR', exchangeRateSnapshot: { rates: { USD: 1, PKR: 280, EUR: 0.92, GBP: 0.79 } } }, 280],
      [{ currency: 'EUR', exchangeRateSnapshot: { rates: { USD: 1, PKR: 300, EUR: 0.92, GBP: 0.8 } } }, 0.92],
      [{ currency: 'GBP', exchangeRateSnapshot: { rates: { USD: 1, PKR: 310, EUR: 0.9, GBP: 0.79 } } }, 0.79],
    ];

    for (const [order, amount] of snapshots) {
      await expect(convertOrderAmountAtCheckout(order, amount, 'USD')).resolves.toBe(1);
    }
  });

  test('caps a negative reconciliation adjustment so no seller allocation becomes negative', () => {
    const order = {
      orderItems: [
        { _id: 'tiny', productId: 'tiny', seller: 'seller-a', price: 0.01, quantity: 1 },
        { _id: 'large', productId: 'large', seller: 'seller-b', price: 10.14, quantity: 1 },
      ],
      orderSummary: {
        subtotal: 10.15,
        shippingCost: 7.91,
        tax: 3.68,
        couponDiscount: 7.12,
        totalAmount: 0,
      },
    };
    const allocations = buildOrderItemMoneyAllocations(order);

    expect([...allocations.total.values()].every(amount => amount >= 0)).toBe(true);
    expect([...allocations.total.values()].reduce((sum, amount) => sum + amount, 0)).toBe(0);
    expect(allocations.unallocatedTotal).toBe(0);
  });

  test.each([
    ['independent rounding would over-credit', [72.86, 72.86], [26, 26]],
    ['independent rounding would under-credit', [71.37, 72.36], [25, 25]],
  ])('freezes one globally conserved USD allocation when %s', (_label, amounts, independentUsdMinor) => {
    const total = Math.round(amounts.reduce((sum, amount) => sum + amount, 0) * 100) / 100;
    const order = {
      currency: 'PKR',
      exchangeRateSnapshot: {
        rates: { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 },
        fallback: false,
      },
      orderItems: amounts.map((amount, index) => ({
        productId: `product-${index}`,
        seller: `seller-${index}`,
        price: amount,
        lineSubtotal: amount,
        quantity: 1,
      })),
      orderSummary: {
        subtotal: total,
        shippingCost: 0,
        tax: 0,
        couponDiscount: 0,
        totalAmount: total,
      },
    };
    const settlement = buildOrderSellerSettlement(order, { requireOrderTotal: true });
    const frozenUsdMinor = settlement.map(entry => entry.amountUSDMinor);

    expect(independentUsdMinor.reduce((sum, amount) => sum + amount, 0)).not.toBe(51);
    expect(frozenUsdMinor.reduce((sum, amount) => sum + amount, 0)).toBe(51);
    expect(settlement.reduce((sum, entry) => sum + entry.sourceAmountMinor, 0))
      .toBe(Math.round(total * 100));
  });

  test('fails closed instead of attributing ownerless legacy shipping across sellers', () => {
    const order = {
      currency: 'USD',
      orderItems: [
        { productId: 'a', seller: 'seller-a', price: 1, quantity: 1 },
        { productId: 'b', seller: 'seller-b', price: 1, quantity: 1 },
      ],
      shippingMethod: { price: 1 },
      orderSummary: {
        subtotal: 2,
        shippingCost: 1,
        tax: 0,
        couponDiscount: 0,
        totalAmount: 3,
      },
    };

    let failure;
    try {
      buildOrderSellerSettlement(order, { requireOrderTotal: true });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'SELLER_SETTLEMENT_SHIPPING_OWNER_MISSING' });
  });

  test('never freezes or reports a present unsupported stored order currency as USD', async () => {
    const order = makeOrder();
    order.currency = 'CAD';

    let settlementFailure;
    try {
      buildOrderSellerSettlement(order, { requireOrderTotal: true });
    } catch (error) {
      settlementFailure = error;
    }
    expect(settlementFailure).toMatchObject({ code: 'ORDER_CURRENCY_INVALID' });
    await expect(sumOrderAmountsInCurrency([{ order, amount: 0.03 }], 'USD'))
      .rejects.toMatchObject({ code: 'ORDER_CURRENCY_INVALID' });
    await expect(convertOrderAmountAtCheckout(order, 0.03, 'USD'))
      .rejects.toMatchObject({ code: 'ORDER_CURRENCY_INVALID' });
  });

  test('never substitutes a live rate for a missing historical checkout snapshot', async () => {
    await expect(convertOrderAmountAtCheckout({ currency: 'PKR' }, 277.51, 'USD'))
      .rejects.toMatchObject({ code: 'SELLER_SETTLEMENT_HISTORICAL_RATE_MISSING' });
  });

  test.each([
    ['string settlement version', { sellerSettlementVersion: '1' }],
    ['lowercase settlement currency', {
      sellerSettlementVersion: 1,
      sellerSettlement: [
        { seller: 'seller-a', sourceCurrency: 'usd', sourceAmountMinor: 1, amountUSDMinor: 1 },
        { seller: 'seller-b', sourceCurrency: 'USD', sourceAmountMinor: 2, amountUSDMinor: 2 },
      ],
    }],
    ['blank settlement currency', {
      sellerSettlementVersion: 1,
      sellerSettlement: [
        { seller: 'seller-a', sourceCurrency: '', sourceAmountMinor: 1, amountUSDMinor: 1 },
        { seller: 'seller-b', sourceCurrency: 'USD', sourceAmountMinor: 2, amountUSDMinor: 2 },
      ],
    }],
    ['string source minor units', {
      sellerSettlementVersion: 1,
      sellerSettlement: [
        { seller: 'seller-a', sourceCurrency: 'USD', sourceAmountMinor: '1', amountUSDMinor: 1 },
        { seller: 'seller-b', sourceCurrency: 'USD', sourceAmountMinor: 2, amountUSDMinor: 2 },
      ],
    }],
    ['boolean USD minor units', {
      sellerSettlementVersion: 1,
      sellerSettlement: [
        { seller: 'seller-a', sourceCurrency: 'USD', sourceAmountMinor: 1, amountUSDMinor: true },
        { seller: 'seller-b', sourceCurrency: 'USD', sourceAmountMinor: 2, amountUSDMinor: 2 },
      ],
    }],
    ['non-finite order total', { orderSummary: { totalAmount: Number.POSITIVE_INFINITY } }],
    ['sub-cent order total', { orderSummary: { totalAmount: 0.001 } }],
    ['blank order total', { orderSummary: { totalAmount: '' } }],
  ])('rejects a frozen seller settlement with a %s', (_label, override) => {
    const order = {
      ...makeOrder(),
      sellerSettlementVersion: 1,
      sellerSettlement: [
        { seller: 'seller-a', sourceCurrency: 'USD', sourceAmountMinor: 1, amountUSDMinor: 1 },
        { seller: 'seller-b', sourceCurrency: 'USD', sourceAmountMinor: 2, amountUSDMinor: 2 },
      ],
      ...override,
    };

    expect(() => getFrozenSellerSettlement(order)).toThrow();
  });

  test('rejects malformed seller shipping before freezing an entitlement', () => {
    const order = makeOrder({ shippingCost: 0.01 });
    order.sellerShipping[0].shippingMethod.price = Number.POSITIVE_INFINITY;

    expect(() => buildOrderSellerSettlement(order, { requireOrderTotal: true }))
      .toThrow('stored seller shipping line 1 is invalid');
  });

  test.each([
    ['NaN cumulative source', Number.NaN],
    ['fractional cumulative source', 1.5],
    ['unsafe cumulative source', Number.MAX_SAFE_INTEGER + 1],
    ['negative cumulative source', -1],
    ['string cumulative source', '1'],
    ['boolean cumulative source', true],
  ])('rejects %s before seller settlement ratio arithmetic', (_label, target) => {
    expect(() => sellerSettlementUsdTargetForSource({
      sourceAmountMinor: 100,
      amountUSDMinor: 1,
    }, target)).toThrow('cumulative seller settlement target is malformed');
  });

  test.each([
    ['NaN source entitlement', Number.NaN, 1],
    ['unsafe source entitlement', Number.MAX_SAFE_INTEGER + 1, 1],
    ['fractional USD entitlement', 100, 0.5],
    ['negative USD entitlement', 100, -1],
    ['string source entitlement', '100', 1],
    ['boolean USD entitlement', 100, true],
  ])('rejects %s before seller settlement ratio arithmetic', (_label, sourceAmountMinor, amountUSDMinor) => {
    expect(() => sellerSettlementUsdTargetForSource({
      sourceAmountMinor,
      amountUSDMinor,
    }, 50)).toThrow('cumulative seller settlement target is malformed');
  });

  test.each(['pkr', ' PKR ', ''])('rejects non-canonical reserved coupon currency %p', currency => {
    const order = makeOrder({ couponDiscount: 0.01 });
    order.currency = 'PKR';
    order.couponUsageVersion = 1;
    order.appliedCoupons = [{
      couponId: 'coupon-a',
      seller: 'seller-a',
      code: 'SAVE1',
      discountType: 'fixed',
      discountValue: 0.01,
      appliedDiscountAmount: 0.01,
      currency,
      sourceDiscountValue: 0.01,
      sourceCurrency: 'PKR',
      applicableProductIds: ['product-a'],
      couponTermsFingerprint: 'a'.repeat(64),
    }];

    expect(() => buildOrderItemMoneyAllocations(order))
      .toThrow('reserved coupon scope is invalid');
  });

  test('property: every supported minor-unit split reconciles exactly, including zero tax', () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 1, max: 10000 }), { minLength: 1, maxLength: 12 }),
      fc.integer({ min: 0, max: 2500 }),
      fc.integer({ min: 0, max: 2500 }),
      fc.integer({ min: 0, max: 2500 }),
      fc.integer({ min: -2500, max: 2500 }),
      (itemMinorAmounts, taxMinor, shippingMinor, rawDiscountMinor, adjustmentMinor) => {
        const orderItems = itemMinorAmounts.map((minor, index) => ({
          _id: `item-${index}`,
          productId: `product-${index}`,
          seller: `seller-${index}`,
          price: minor / 100,
          quantity: 1,
        }));
        const subtotal = itemMinorAmounts.reduce((sum, minor) => sum + minor, 0) / 100;
        const tax = taxMinor / 100;
        const shippingCost = shippingMinor / 100;
        const subtotalMinor = itemMinorAmounts.reduce((sum, minor) => sum + minor, 0);
        const discountMinor = Math.min(subtotalMinor, rawDiscountMinor);
        const storedTotalMinor = Math.max(
          0,
          subtotalMinor + taxMinor + shippingMinor - discountMinor + adjustmentMinor
        );
        const order = {
          currency: 'USD',
          orderItems,
          orderSummary: {
            subtotal,
            tax,
            shippingCost,
            couponDiscount: discountMinor / 100,
            totalAmount: storedTotalMinor / 100,
          },
          paymentMethod: 'stripe',
          isPaid: true,
          orderStatus: 'confirmed',
        };
        const allocations = buildOrderItemMoneyAllocations(order);
        const totalMinor = [...allocations.total.values()].reduce(
          (sum, amount) => sum + Math.round(amount * 100),
          0
        );
        const allocatedTaxMinor = [...allocations.tax.values()].reduce(
          (sum, amount) => sum + Math.round(amount * 100),
          0
        );
        const allocatedShippingMinor = [...allocations.shipping.values()].reduce(
          (sum, amount) => sum + Math.round(amount * 100),
          0
        );
        const allocatedDiscountMinor = [...allocations.discount.values()].reduce(
          (sum, amount) => sum + Math.round(amount * 100),
          0
        );
        const sellerTotalMinor = orderItems.reduce((sum, item) => (
          sum + Math.round(
            sellerOrderSummary(order, [item.productId], item.seller).totalAmount * 100
          )
        ), 0);

        expect(totalMinor).toBe(storedTotalMinor);
        expect(sellerTotalMinor).toBe(storedTotalMinor);
        expect(allocatedTaxMinor).toBe(taxMinor);
        expect(allocatedShippingMinor).toBe(shippingMinor);
        expect(allocatedDiscountMinor).toBe(discountMinor);
        expect(allocations.unallocatedTotal).toBe(0);
        expect([...allocations.total.values()].every(amount => amount >= 0)).toBe(true);
        if (taxMinor === 0) {
          expect([...allocations.tax.values()].every(amount => amount === 0)).toBe(true);
        }
      }
    ), { numRuns: 250 });
  });
});
