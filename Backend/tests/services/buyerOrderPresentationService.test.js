'use strict';

const mongoose = require('mongoose');
const { buildBuyerOrderView } = require('../../services/buyerOrderPresentationService');
const { sumMoney } = require('../../services/moneyMath');

const sellerA = new mongoose.Types.ObjectId();
const sellerB = new mongoose.Types.ObjectId();

const mixedSellerOrder = () => ({
  _id: new mongoose.Types.ObjectId(),
  orderId: 'ORD-1788027012731',
  currency: 'PKR',
  orderStatus: 'pending',
  orderItems: [
    {
      seller: sellerA,
      productId: new mongoose.Types.ObjectId(),
      name: 'Configurable PKR item',
      price: 10,
      lineSubtotal: 10,
      quantity: 1,
      selectedOptions: { Size: 'Large' },
    },
    {
      seller: sellerB,
      productId: new mongoose.Types.ObjectId(),
      name: 'USD item converted at checkout',
      price: 10,
      lineSubtotal: 20,
      quantity: 2,
      sourcePrice: 0.04,
      sourceCurrency: 'USD',
    },
  ],
  sellerShipping: [
    { seller: sellerA, shippingMethod: { name: 'Free local', price: 0, estimatedDays: 2 } },
    { seller: sellerB, shippingMethod: { name: 'International', price: 5, estimatedDays: 8 } },
  ],
  sellerFulfillment: [
    { seller: sellerA, status: 'shipped', updatedAt: new Date('2026-08-30T10:00:00.000Z') },
    { seller: sellerB, status: 'processing', updatedAt: new Date('2026-08-30T11:00:00.000Z') },
  ],
  sellerPolicies: [
    { seller: sellerA, storeName: 'Pakistan Store' },
    { seller: sellerB, storeName: 'USD Store' },
  ],
  orderSummary: {
    subtotal: 30,
    shippingCost: 5,
    tax: 3,
    couponDiscount: 2,
    totalAmount: 36,
  },
});

describe('buyer seller-group order presentation', () => {
  test('groups every item once and conserves all exact order-summary money', () => {
    const view = buildBuyerOrderView(mixedSellerOrder());
    expect(view).toMatchObject({
      buyerPresentationVersion: 1,
      sellerGroupingAvailable: true,
      sellerGroupingReason: null,
    });
    expect(view.sellerGroups).toHaveLength(2);
    expect(view.sellerGroups[0]).toMatchObject({
      sellerId: sellerA.toString(),
      storeName: 'Pakistan Store',
      itemIndexes: [0],
      itemCount: 1,
      units: 1,
      status: 'shipped',
      shippingMethod: { name: 'Free local', price: 0, estimatedDays: 2 },
    });
    expect(view.sellerGroups[1]).toMatchObject({
      sellerId: sellerB.toString(),
      storeName: 'USD Store',
      itemIndexes: [1],
      itemCount: 1,
      units: 2,
      status: 'processing',
      shippingMethod: { name: 'International', price: 5, estimatedDays: 8 },
    });

    for (const key of ['subtotal', 'shippingCost', 'tax', 'couponDiscount', 'totalAmount']) {
      expect(sumMoney(view.sellerGroups.map(group => group.summary[key])))
        .toBe(view.orderSummary[key]);
    }
    expect(sumMoney(view.sellerGroups.map(group => group.summary.reconciliationAdjustment)))
      .toBe(0);
    for (const group of view.sellerGroups) {
      expect(sumMoney([
        group.summary.subtotal,
        group.summary.shippingCost,
        group.summary.tax,
        -group.summary.couponDiscount,
        group.summary.reconciliationAdjustment,
      ])).toBe(group.summary.totalAmount);
    }
  });

  test('marks legacy orders unavailable instead of guessing missing seller ownership', () => {
    const order = mixedSellerOrder();
    order.orderItems[1].seller = null;
    const view = buildBuyerOrderView(order);
    expect(view).toMatchObject({
      sellerGroupingAvailable: false,
      sellerGroupingReason: 'legacy_missing_seller_snapshot',
      sellerGroups: [],
    });
  });

  test('fails closed on duplicate seller fulfillment rows', () => {
    const order = mixedSellerOrder();
    order.sellerFulfillment.push({ seller: sellerA, status: 'processing' });
    expect(() => buildBuyerOrderView(order)).toThrow(expect.objectContaining({
      code: 'BUYER_ORDER_PRESENTATION_INVALID',
      statusCode: 409,
    }));
  });
});
