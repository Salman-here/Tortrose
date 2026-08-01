import {
  canCancelOrder,
  filterOrders,
  formatOrderItemOptions,
  getEstimatedDeliveryDate,
  getOrderDisplayId,
  getOrderItemCount,
  getOrderTotal,
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

  it('uses the human-facing order ID and authoritative total', () => {
    expect(getOrderDisplayId(order)).toBe('#ORD-12345');
    expect(getOrderTotal(order)).toBe(1075);
    expect(getOrderItemCount(order)).toBe(3);
  });

  it('formats selected color and options without exposing object syntax', () => {
    expect(formatOrderItemOptions(order.orderItems[0])).toBe('Color: Blue  •  Size: M');
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
