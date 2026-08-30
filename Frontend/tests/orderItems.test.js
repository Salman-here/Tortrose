import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getOrderCurrency,
  getOrderItemQuantity,
  getOrderSellerShippingBreakdown,
  getOrderSellerGroups,
  getOrderItemLineSubtotal,
  getOrderSummaryAmount,
  getOrderTotal,
  hasExactOrderItemUnitEquation,
  inspectOrderListMoney,
} from '../src/utils/orderItems.js';

const groupedOrder = () => ({
  currency: 'PKR',
  sellerGroupingAvailable: true,
  orderItems: [
    { name: 'Option item', price: 10, lineSubtotal: 10, quantity: 1, selectedOptions: { Size: 'Large' } },
    { name: 'Second seller item', price: 20, lineSubtotal: 40, quantity: 2 },
  ],
  orderSummary: {
    subtotal: 50,
    shippingCost: 5,
    tax: 3,
    couponDiscount: 2,
    totalAmount: 56,
  },
  sellerGroups: [
    {
      sellerId: 'seller-a',
      storeName: 'Store A',
      itemIndexes: [0],
      itemCount: 1,
      units: 1,
      status: 'shipped',
      shippingMethod: { name: 'Free local', price: 0, estimatedDays: 2 },
      summary: { subtotal: 10, shippingCost: 0, tax: 1, couponDiscount: 0.4, reconciliationAdjustment: 0, totalAmount: 10.6 },
    },
    {
      sellerId: 'seller-b',
      storeName: 'Store B',
      itemIndexes: [1],
      itemCount: 1,
      units: 2,
      status: 'processing',
      shippingMethod: { name: 'Express', price: 5, estimatedDays: 5 },
      summary: { subtotal: 40, shippingCost: 5, tax: 2, couponDiscount: 1.6, reconciliationAdjustment: 0, totalAmount: 45.4 },
    },
  ],
});

test('seller shipping breakdown requires exact rows and reconciles to the order summary', () => {
  const order = {
    orderSummary: { shippingCost: 5 },
    sellerShipping: [
      { seller: 'seller-a', shippingMethod: { name: 'Standard', price: 2, estimatedDays: 4 } },
      { seller: 'seller-b', shippingMethod: { name: 'Fast', price: 3, estimatedDays: 2 } },
    ],
  };
  const sellerView = getOrderSellerShippingBreakdown(order, 'seller-a');
  assert.equal(sellerView.hasBreakdown, true);
  assert.equal(sellerView.total, 2);
  assert.equal(sellerView.entries[0].seller, 'seller-a');
  assert.equal(getOrderSellerShippingBreakdown(order).total, 5);
  for (const corrupt of [
    { ...order, sellerShipping: [{ seller: 'seller-a', shippingMethod: { name: 'Standard', price: '5', estimatedDays: 4 } }] },
    { ...order, sellerShipping: [{ seller: 'seller-a', shippingMethod: { name: 'Standard', price: 5, estimatedDays: '4' } }] },
    { ...order, sellerShipping: [{ seller: 'seller-a', shippingMethod: { name: 'Standard', price: 4, estimatedDays: 4 } }] },
  ]) {
    assert.throws(
      () => getOrderSellerShippingBreakdown(corrupt),
      error => error?.code === 'ORDER_PRESENTATION_DATA_INVALID',
    );
  }
});

test('seller order groups cover every item once and conserve all checkout money', () => {
  const groups = getOrderSellerGroups(groupedOrder());
  assert.equal(groups.length, 2);
  assert.equal(groups[0].storeName, 'Store A');
  assert.equal(groups[0].status, 'shipped');
  assert.equal(groups[0].items[0].selectedOptions.Size, 'Large');
  assert.equal(groups[1].units, 2);
  assert.equal(groups[1].summary.totalAmount, 45.4);
});

test('seller order groups fail closed on coverage, shipping, or money divergence', () => {
  const duplicateIndex = groupedOrder();
  duplicateIndex.sellerGroups[1].itemIndexes = [0];
  const wrongShipping = groupedOrder();
  wrongShipping.sellerGroups[1].shippingMethod.price = 4;
  const wrongTotal = groupedOrder();
  wrongTotal.sellerGroups[1].summary.totalAmount = 45.39;
  const missingItem = groupedOrder();
  missingItem.sellerGroups.pop();
  for (const order of [duplicateIndex, wrongShipping, wrongTotal, missingItem]) {
    assert.throws(
      () => getOrderSellerGroups(order),
      error => error?.code === 'ORDER_PRESENTATION_DATA_INVALID',
    );
  }
});

test('legacy seller grouping explicitly unavailable renders through the legacy path', () => {
  const order = groupedOrder();
  order.sellerGroupingAvailable = false;
  order.sellerGroups = [];
  assert.deepEqual(getOrderSellerGroups(order), []);
});

test('treats only missing legacy order currency metadata as USD', () => {
  assert.equal(getOrderCurrency({}), 'USD');
  assert.equal(getOrderCurrency({ currency: 'PKR' }), 'PKR');
  for (const currency of ['', 'usd', ' USD ', 'CAD', false]) {
    assert.throws(
      () => getOrderCurrency({ currency }),
      (error) => error?.code === 'ORDER_PRESENTATION_DATA_INVALID',
    );
  }
  assert.throws(
    () => getOrderCurrency({ currency: 'PKR', orderCurrency: 'USD' }),
    (error) => error?.code === 'ORDER_PRESENTATION_DATA_INVALID',
  );
});

test('rejects coercible and sub-cent order summary amounts', () => {
  assert.equal(getOrderSummaryAmount(
    { orderSummary: { tax: 1.25 } },
    ['tax'],
    'order tax',
  ), 1.25);
  for (const tax of [true, '1.25', 0.001, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => getOrderSummaryAmount({ orderSummary: { tax } }, ['tax'], 'order tax'),
      (error) => error?.code === 'ORDER_PRESENTATION_DATA_INVALID',
    );
  }
});

test('rejects conflicting aliases for the same stored summary amount', () => {
  assert.equal(getOrderSummaryAmount(
    { orderSummary: { tax: 1.25, taxAmount: 1.25 } },
    ['tax', 'taxAmount'],
    'order tax',
  ), 1.25);
  assert.throws(
    () => getOrderSummaryAmount(
      { orderSummary: { tax: 1.25, taxAmount: 1.26 } },
      ['tax', 'taxAmount'],
      'order tax',
    ),
    (error) => error?.code === 'ORDER_PRESENTATION_DATA_INVALID',
  );
});

test('keeps an exact visible quantity-by-unit equation', () => {
  const item = { price: 2.5, quantity: 3, lineSubtotal: 7.5 };
  assert.equal(hasExactOrderItemUnitEquation(item), true);
  assert.equal(getOrderItemLineSubtotal(item), 7.5);
});

test('defaults only genuinely missing legacy quantity and rejects invalid or conflicting aliases', () => {
  assert.equal(getOrderItemQuantity({}), 1);
  assert.equal(getOrderItemQuantity({ quantity: 2, qty: 2 }), 2);
  for (const item of [
    { quantity: 0 },
    { quantity: '2' },
    { quantity: 2, qty: 3 },
  ]) {
    assert.throws(
      () => getOrderItemQuantity(item),
      (error) => error?.code === 'ORDER_PRESENTATION_DATA_INVALID',
    );
  }
});

test('order-list money inspector fails closed without manufacturing USD or zero', () => {
  assert.deepEqual(inspectOrderListMoney({ currency: 'PKR', totalAmount: 200 }), {
    valid: true,
    currency: 'PKR',
    total: 200,
  });
  const invalid = inspectOrderListMoney({ currency: '', totalAmount: '200' });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.currency, null);
  assert.equal(invalid.total, null);
});

test('hides a rounded converted unit that cannot reproduce its authoritative line', () => {
  const item = { price: 0, quantity: 1000, lineSubtotal: 3.57 };
  assert.equal(hasExactOrderItemUnitEquation(item), false);
  assert.equal(getOrderItemLineSubtotal(item), 3.57);
});

test('keeps the legacy reconstructed unit equation internally consistent', () => {
  assert.equal(hasExactOrderItemUnitEquation({ price: 19.99, quantity: 3 }), true);
});

test('reconstructs only genuinely missing or null legacy line subtotals', () => {
  assert.equal(getOrderItemLineSubtotal({ price: 2.5, quantity: 2 }), 5);
  assert.equal(getOrderItemLineSubtotal({ price: 2.5, quantity: 2, lineSubtotal: null }), 5);
  for (const lineSubtotal of ['', '5.00', false, Infinity, -1, 0.001]) {
    assert.throws(
      () => getOrderItemLineSubtotal({ price: 2.5, quantity: 2, lineSubtotal }),
      (error) => error?.code === 'ORDER_PRESENTATION_DATA_INVALID',
    );
  }
});

test('reconstructs only genuinely missing or null legacy order totals', () => {
  const legacy = { orderSummary: { subtotal: 10, shippingCost: 2, tax: 1, couponDiscount: 3 } };
  assert.equal(getOrderTotal(legacy), 10);
  assert.equal(getOrderTotal({
    ...legacy,
    orderSummary: { ...legacy.orderSummary, totalAmount: null },
  }), 10);
  for (const totalAmount of ['', '10.00', false, Infinity, -1, 0.001]) {
    assert.throws(
      () => getOrderTotal({ orderSummary: { ...legacy.orderSummary, totalAmount } }),
      (error) => error?.code === 'ORDER_PRESENTATION_DATA_INVALID',
    );
  }
  assert.throws(
    () => getOrderTotal({ orderSummary: { subtotal: '10.00' } }),
    (error) => error?.code === 'ORDER_PRESENTATION_DATA_INVALID',
  );
});

test('rejects conflicting total aliases and non-reconciling persisted summaries', () => {
  assert.throws(
    () => getOrderTotal({ orderSummary: { totalAmount: 10 }, totalAmount: 11 }),
    (error) => error?.code === 'ORDER_PRESENTATION_DATA_INVALID',
  );
  assert.throws(
    () => getOrderTotal({
      orderSummary: { subtotal: 8, shippingCost: 1, totalAmount: 10 },
    }),
    (error) => error?.code === 'ORDER_PRESENTATION_DATA_INVALID',
  );
  assert.equal(getOrderTotal({
    orderSummary: {
      subtotal: 8,
      shippingCost: 1,
      totalAmount: 10,
      reconciliationAdjustment: 1,
    },
  }), 10);
  assert.throws(
    () => getOrderTotal({ orderSummary: { subtotal: 1, couponDiscount: 2 } }),
    (error) => error?.code === 'ORDER_PRESENTATION_DATA_INVALID',
  );
});
