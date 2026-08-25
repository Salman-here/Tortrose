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
  getOrderItemQuantity,
  getOrderSummaryAmount,
  getOrderTotal,
  hasExactOrderItemUnitEquation,
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
});
