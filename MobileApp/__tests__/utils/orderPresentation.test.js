import {
  assertOrderDetailPresentation,
  canCancelOrder,
  filterOrders,
  formatOrderItemOptions,
  getEstimatedDeliveryDate,
  getOrderCurrency,
  getOrderDisplayId,
  getOrderItemCount,
  getOrderItemLineSubtotal,
  getOrderItemOptionPairs,
  getOrderItemQuantity,
  getOrderSellerGroups,
  getOrderSummaryAmount,
  getOrderTotal,
  getSellerCurrencyMoney,
  hasExactOrderItemUnitEquation,
  inspectOrderListMoney,
  inspectSellerOrderListMoney,
} from '../../src/utils/orderPresentation';

describe('order presentation helpers', () => {
  const order = {
    _id: 'mongo-id',
    orderId: 'ORD-12345',
    orderStatus: 'confirmed',
    isPaid: false,
    createdAt: '2026-07-01T00:00:00.000Z',
    currency: 'PKR',
    orderItems: [
      { name: 'Blue Bag', quantity: 2, selectedColor: 'Blue', selectedOptions: { Size: 'M' } },
      { name: 'Shoes', quantity: 1 },
    ],
    orderSummary: { subtotal: 1000, shippingCost: 100, tax: 50, couponDiscount: 75, totalAmount: 1075 },
    shippingMethod: { estimatedDays: 5 },
  };

  it('treats only missing legacy order currency metadata as USD', () => {
    expect(getOrderCurrency({})).toBe('USD');
    expect(getOrderCurrency({ currency: 'PKR' })).toBe('PKR');
    ['', 'usd', ' USD ', 'CAD', false].forEach((currency) => {
      expect(() => getOrderCurrency({ currency })).toThrow();
    });
    expect(() => getOrderCurrency({ currency: 'PKR', orderCurrency: 'USD' })).toThrow();
  });

  it('rejects coercible and sub-cent order summary amounts', () => {
    expect(getOrderSummaryAmount(
      { orderSummary: { tax: 1.25 } },
      ['tax'],
      'order tax',
    )).toBe(1.25);
    [true, '1.25', 0.001, Number.POSITIVE_INFINITY].forEach((tax) => {
      expect(() => getOrderSummaryAmount({ orderSummary: { tax } }, ['tax'], 'order tax')).toThrow();
    });
  });

  it('rejects conflicting aliases for the same stored summary amount', () => {
    expect(getOrderSummaryAmount(
      { orderSummary: { tax: 1.25, taxAmount: 1.25 } },
      ['tax', 'taxAmount'],
      'order tax',
    )).toBe(1.25);
    expect(() => getOrderSummaryAmount(
      { orderSummary: { tax: 1.25, taxAmount: 1.26 } },
      ['tax', 'taxAmount'],
      'order tax',
    )).toThrow(expect.objectContaining({ code: 'ORDER_PRESENTATION_DATA_INVALID' }));
  });

  it('uses the human-facing order ID and authoritative total', () => {
    expect(getOrderDisplayId(order)).toBe('#ORD-12345');
    expect(getOrderTotal(order)).toBe(1075);
    expect(getOrderItemCount(order)).toBe(3);
  });

  it('preserves only the genuinely missing legacy quantity default', () => {
    expect(getOrderItemQuantity({})).toBe(1);
    expect(getOrderItemQuantity({ quantity: null })).toBe(1);
    expect(getOrderItemQuantity({ quantity: 2, qty: 2 })).toBe(2);
    [0, -1, 1.5, '2', true, Infinity].forEach((quantity) => {
      expect(() => getOrderItemQuantity({ quantity })).toThrow(
        expect.objectContaining({ code: 'ORDER_PRESENTATION_DATA_INVALID' }),
      );
    });
    expect(() => getOrderItemQuantity({ quantity: 1, qty: 2 })).toThrow(
      expect.objectContaining({ code: 'ORDER_PRESENTATION_DATA_INVALID' }),
    );
  });

  it('validates the complete order snapshot before exposing detail actions', () => {
    const presentable = {
      ...order,
      orderItems: order.orderItems.map((item, index) => ({
        ...item,
        price: index === 0 ? 400 : 200,
        lineSubtotal: index === 0 ? 800 : 200,
      })),
      paymentMethod: 'stripe',
      isPaid: true,
    };
    expect(assertOrderDetailPresentation(presentable)).toBe(presentable);

    expect(() => assertOrderDetailPresentation({
      ...presentable,
      orderItems: [{ ...presentable.orderItems[0], quantity: '2' }],
    })).toThrow(expect.objectContaining({ code: 'ORDER_PRESENTATION_DATA_INVALID' }));
    expect(() => assertOrderDetailPresentation({
      ...presentable,
      orderSummary: { ...presentable.orderSummary, tax: undefined },
    })).toThrow(expect.objectContaining({ code: 'ORDER_PRESENTATION_DATA_INVALID' }));
    expect(() => assertOrderDetailPresentation({
      ...presentable,
      isPaid: 'true',
    })).toThrow(expect.objectContaining({ code: 'ORDER_PRESENTATION_DATA_INVALID' }));
    expect(() => assertOrderDetailPresentation({
      ...presentable,
      appliedCoupons: [{ discountType: 'fixed', appliedDiscountAmount: 74 }],
    })).toThrow(expect.objectContaining({ code: 'ORDER_PRESENTATION_DATA_INVALID' }));
    expect(assertOrderDetailPresentation({
      ...presentable,
      appliedCoupons: [{ discountType: 'fixed', appliedDiscountAmount: 75 }],
    })).toBeTruthy();
  });

  it('keeps a legitimate free total and reconstructs only legacy summaries in cents', () => {
    expect(getOrderTotal({
      orderSummary: { subtotal: 10, couponDiscount: 10, totalAmount: 0 },
      totalAmount: 0,
    })).toBe(0);
    expect(getOrderTotal({
      orderSummary: {
        subtotal: 0.1,
        shippingCost: 0.2,
        tax: 0.3,
        couponDiscount: 0.1,
        reconciliationAdjustment: 0.01,
      },
    })).toBe(0.51);
    expect(getOrderTotal({ totalAmount: 12.34 })).toBe(12.34);
    expect(getOrderTotal({
      orderSummary: {
        subtotal: 10,
        shippingFee: 2,
        taxAmount: 1,
        discountAmount: 3,
      },
    })).toBe(10);
    expect(getOrderTotal({ orderSummary: { total: 8.75 }, totalAmount: 8.75 })).toBe(8.75);
  });

  it('rejects conflicting total aliases and non-reconciling persisted summaries', () => {
    expect(() => getOrderTotal({
      orderSummary: { totalAmount: 10 },
      totalAmount: 11,
    })).toThrow(expect.objectContaining({ code: 'ORDER_PRESENTATION_DATA_INVALID' }));
    expect(() => getOrderTotal({
      orderSummary: { subtotal: 8, shippingCost: 1, totalAmount: 10 },
    })).toThrow(expect.objectContaining({ code: 'ORDER_PRESENTATION_DATA_INVALID' }));
    expect(getOrderTotal({
      orderSummary: {
        subtotal: 8,
        shippingCost: 1,
        totalAmount: 10,
        reconciliationAdjustment: 1,
      },
    })).toBe(10);
    expect(() => getOrderTotal({
      orderSummary: { subtotal: 1, couponDiscount: 2 },
    })).toThrow(expect.objectContaining({ code: 'ORDER_PRESENTATION_DATA_INVALID' }));
  });

  it('formats selected color and options without exposing object syntax', () => {
    expect(formatOrderItemOptions(order.orderItems[0])).toBe('Color: Blue  •  Size: M');
    expect(getOrderItemOptionPairs({
      selectedColor: 'Blue',
      selectedOptions: { Color: 'Navy', Size: 'L' },
    })).toEqual([
      { name: 'Color', value: 'Navy' },
      { name: 'Size', value: 'L' },
    ]);
  });

  it('validates complete buyer seller groups and exact checkout conservation', () => {
    const groupedOrder = {
      currency: 'USD',
      orderItems: [
        { productId: 'product-a', name: 'A', price: 7, lineSubtotal: 7, quantity: 1 },
        { productId: 'product-b', name: 'B', price: 3, lineSubtotal: 3, quantity: 1 },
      ],
      orderSummary: {
        subtotal: 10,
        shippingCost: 1.5,
        tax: 0.5,
        couponDiscount: 0.25,
        reconciliationAdjustment: 0,
        totalAmount: 11.75,
      },
      sellerGroups: [
        {
          sellerId: 'seller-a',
          storeName: 'Store A',
          storeLogo: 'https://example.com/store-a-logo.png',
          status: 'shipped',
          itemIndexes: [0],
          itemCount: 1,
          units: 1,
          shippingMethod: { name: 'Express', estimatedDays: 2, price: 1 },
          summary: {
            subtotal: 7,
            shippingCost: 1,
            tax: 0.35,
            couponDiscount: 0.15,
            reconciliationAdjustment: 0,
            totalAmount: 8.2,
          },
        },
        {
          sellerId: 'seller-b',
          storeName: 'Store B',
          status: 'confirmed',
          itemIndexes: [1],
          itemCount: 1,
          units: 1,
          shippingMethod: { name: 'Standard', estimatedDays: 5, price: 0.5 },
          summary: {
            subtotal: 3,
            shippingCost: 0.5,
            tax: 0.15,
            couponDiscount: 0.1,
            reconciliationAdjustment: 0,
            totalAmount: 3.55,
          },
        },
      ],
    };

    const groups = getOrderSellerGroups(groupedOrder);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      sellerId: 'seller-a',
      storeName: 'Store A',
      storeLogo: 'https://example.com/store-a-logo.png',
      status: 'shipped',
      items: [groupedOrder.orderItems[0]],
      units: 1,
    });
    expect(groups.map(group => group.summary.totalAmount)).toEqual([8.2, 3.55]);

    const malformedLogo = JSON.parse(JSON.stringify(groupedOrder));
    malformedLogo.sellerGroups[0].storeLogo = { unsafe: true };
    expect(getOrderSellerGroups(malformedLogo)[0].storeLogo).toBe('');

    const duplicateItem = JSON.parse(JSON.stringify(groupedOrder));
    duplicateItem.sellerGroups[1].itemIndexes = [0];
    expect(() => getOrderSellerGroups(duplicateItem)).toThrow('seller order item indexes');

    const missingMoney = JSON.parse(JSON.stringify(groupedOrder));
    missingMoney.sellerGroups[1].summary.totalAmount = 3.54;
    expect(() => getOrderSellerGroups(missingMoney)).toThrow('seller summary total');
  });

  it('prefers the persisted line subtotal and keeps a legacy unit-price fallback', () => {
    expect(getOrderItemLineSubtotal({ price: 0, quantity: 1000, lineSubtotal: 3.57 })).toBe(3.57);
    expect(getOrderItemLineSubtotal({ price: 19.99, quantity: 3 })).toBe(59.97);
    expect(getOrderItemLineSubtotal({ price: 10, quantity: 2, lineSubtotal: 0 })).toBe(0);
  });

  it('reconstructs only genuinely missing or null legacy money fields', () => {
    expect(getOrderItemLineSubtotal({ price: 10, quantity: 2, lineSubtotal: null })).toBe(20);
    expect(getOrderTotal({
      orderSummary: { subtotal: 10, shippingCost: 2, totalAmount: null },
    })).toBe(12);

    ['', '20.00', false, Infinity, -1, 0.001].forEach((lineSubtotal) => {
      expect(() => getOrderItemLineSubtotal({
        price: 10,
        quantity: 2,
        lineSubtotal,
      })).toThrow(expect.objectContaining({ code: 'ORDER_PRESENTATION_DATA_INVALID' }));
    });
    ['', '12.00', false, Infinity, -1, 0.001].forEach((totalAmount) => {
      expect(() => getOrderTotal({
        orderSummary: { subtotal: 10, shippingCost: 2, totalAmount },
      })).toThrow(expect.objectContaining({ code: 'ORDER_PRESENTATION_DATA_INVALID' }));
    });
    expect(() => getOrderTotal({
      orderSummary: { subtotal: '10.00' },
    })).toThrow(expect.objectContaining({ code: 'ORDER_PRESENTATION_DATA_INVALID' }));
  });

  it('shows a unit equation only when rounded units reproduce the stored line total', () => {
    expect(hasExactOrderItemUnitEquation({ price: 2.5, quantity: 3, lineSubtotal: 7.5 })).toBe(true);
    expect(hasExactOrderItemUnitEquation({ price: 0, quantity: 1000, lineSubtotal: 3.57 })).toBe(false);
    expect(hasExactOrderItemUnitEquation({ price: 19.99, quantity: 3 })).toBe(true);
  });

  it('uses the longest seller estimate for a multi-store order', () => {
    const estimate = getEstimatedDeliveryDate({
      ...order,
      sellerShipping: [
        { shippingMethod: { estimatedDays: 2 } },
        { shippingMethod: { estimatedDays: 8 } },
      ],
    });
    expect(estimate.toISOString().slice(0, 10)).toBe('2026-07-09');
  });

  it('matches search, aggregate active status, and payment filters', () => {
    expect(filterOrders([order], { search: 'blue bag', status: 'active', payment: 'unpaid' })).toEqual([order]);
    expect(filterOrders([order], { search: 'missing', status: 'all', payment: 'all' })).toEqual([]);
    expect(filterOrders([order], { status: 'delivered' })).toEqual([]);
  });

  it('allows cancellation only before payment and fulfillment', () => {
    expect(canCancelOrder(order)).toBe(true);
    expect(canCancelOrder({ ...order, isPaid: true })).toBe(false);
    expect(canCancelOrder({ ...order, sellerFulfillment: [{ status: 'shipped' }] })).toBe(false);
    expect(canCancelOrder({ ...order, orderStatus: 'delivered' })).toBe(false);
  });

  it('keeps seller-native and buyer-checkout totals as two validated frozen values', () => {
    const sellerOrder = {
      currency: 'PKR',
      orderItems: [{ price: 8196.87, lineSubtotal: 8196.87, quantity: 1 }],
      orderSummary: { subtotal: 8196.87, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 8196.87 },
      sellerCurrencyMoney: {
        version: 1,
        currency: 'USD',
        buyerCurrency: 'PKR',
        summary: { subtotal: 29.5, shippingCost: 0, tax: 0, couponDiscount: 0, reconciliationAdjustment: 0, totalAmount: 29.5 },
        buyerSummary: { subtotal: 8196.87, shippingCost: 0, tax: 0, couponDiscount: 0, reconciliationAdjustment: 0, totalAmount: 8196.87 },
        exchangeRate: { from: 'USD', to: 'PKR', rate: 277.86, frozen: true },
        itemMoney: [{
          sellerItemIndex: 0,
          currency: 'USD',
          lineSubtotal: 29.5,
          buyerCurrency: 'PKR',
          buyerLineSubtotal: 8196.87,
          originalCurrency: 'USD',
          originalLineSubtotal: 29.5,
          originalUnitPrice: 29.5,
        }],
      },
    };
    const money = getSellerCurrencyMoney(sellerOrder);
    expect(money.summary.totalAmount).toBe(29.5);
    expect(money.buyerSummary.totalAmount).toBe(8196.87);
    expect(inspectOrderListMoney(sellerOrder)).toMatchObject({
      valid: true,
      currency: 'PKR',
      total: 8196.87,
    });
    expect(inspectSellerOrderListMoney(sellerOrder)).toMatchObject({
      valid: true,
      currency: 'USD',
      total: 29.5,
      buyerCurrency: 'PKR',
      buyerTotal: 8196.87,
    });

    const tampered = JSON.parse(JSON.stringify(sellerOrder));
    tampered.sellerCurrencyMoney.itemMoney[0].lineSubtotal = 29.49;
    expect(() => getSellerCurrencyMoney(tampered)).toThrow('seller item subtotal');

    const invalidSameCurrencyRate = JSON.parse(JSON.stringify(sellerOrder));
    invalidSameCurrencyRate.currency = 'USD';
    invalidSameCurrencyRate.sellerCurrencyMoney.buyerCurrency = 'USD';
    invalidSameCurrencyRate.sellerCurrencyMoney.exchangeRate = {
      from: 'USD', to: 'USD', rate: 2, frozen: true,
    };
    invalidSameCurrencyRate.sellerCurrencyMoney.itemMoney[0].buyerCurrency = 'USD';
    expect(() => getSellerCurrencyMoney(invalidSameCurrencyRate)).toThrow('seller exchange rate');
  });
});
