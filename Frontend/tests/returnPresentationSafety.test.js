import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectReturnPresentationSnapshot } from '../src/utils/returnPresentationSafety.js';
import {
  inspectProductPagination,
  inspectSellerProductPresentation,
  sellerInventoryOverviewIsValid,
} from '../src/utils/productCardSafety.js';

const RETURN_ID = '64b000000000000000000001';
const ITEM_A_ID = '64b000000000000000000002';
const ITEM_B_ID = '64b000000000000000000003';

const makeReturn = (overrides = {}) => ({
  _id: RETURN_ID,
  status: 'under_review',
  currency: 'PKR',
  policySnapshot: {
    returnsEnabled: true,
    returnDuration: 14,
    refundType: 'full_refund',
  },
  items: [
    {
      orderItemId: ITEM_A_ID,
      quantity: 2,
      purchasedQuantity: 3,
      unitPrice: 100.005,
      lineSubtotal: 200,
    },
    {
      orderItemId: ITEM_B_ID,
      quantity: 1,
      purchasedQuantity: 1,
      unitPrice: 50,
      lineSubtotal: 50,
    },
  ],
  refund: {
    itemSubtotal: 250,
    taxAmount: 17.5,
    shippingAmount: 20,
    discountAmount: 7.5,
    totalAmount: 280,
  },
  ...overrides,
});

const cloneReturn = () => structuredClone(makeReturn());

test('return presentation accepts reconciled snapshots in every canonical currency', () => {
  for (const currency of ['USD', 'PKR', 'EUR', 'GBP']) {
    const result = inspectReturnPresentationSnapshot(makeReturn({ currency }));
    assert.equal(result.valid, true, `${currency}: ${result.errors.join(', ')}`);
    assert.equal(result.currency, currency);
    assert.equal(result.itemCount, 3);
    assert.equal(result.refund.totalAmount, 280);
  }
});

test('return presentation preserves fractional informational unit prices but requires exact JSON line/refund money', () => {
  assert.equal(inspectReturnPresentationSnapshot(makeReturn()).valid, true);

  const invalidMoney = [undefined, null, '', '200', true, Number.NaN, Number.POSITIVE_INFINITY, 200.001, Number.MAX_SAFE_INTEGER];
  for (const value of invalidMoney) {
    const lineSnapshot = cloneReturn();
    lineSnapshot.items[0].lineSubtotal = value;
    assert.equal(inspectReturnPresentationSnapshot(lineSnapshot).valid, false, `line ${String(value)}`);

    const refundSnapshot = cloneReturn();
    refundSnapshot.refund.itemSubtotal = value;
    assert.equal(inspectReturnPresentationSnapshot(refundSnapshot).valid, false, `refund ${String(value)}`);
  }

  for (const value of [undefined, null, '', '100.005', true, Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const snapshot = cloneReturn();
    snapshot.items[0].unitPrice = value;
    assert.equal(inspectReturnPresentationSnapshot(snapshot).valid, false, `unit price ${String(value)}`);
  }
});

test('return presentation rejects unsafe quantities and ambiguous item identities', () => {
  for (const value of [undefined, null, '', '2', true, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const quantitySnapshot = cloneReturn();
    quantitySnapshot.items[0].quantity = value;
    assert.equal(inspectReturnPresentationSnapshot(quantitySnapshot).valid, false, `quantity ${String(value)}`);

    const purchasedSnapshot = cloneReturn();
    purchasedSnapshot.items[0].purchasedQuantity = value;
    assert.equal(inspectReturnPresentationSnapshot(purchasedSnapshot).valid, false, `purchased ${String(value)}`);
  }

  const overReturned = cloneReturn();
  overReturned.items[0].quantity = 4;
  assert.equal(inspectReturnPresentationSnapshot(overReturned).valid, false);

  const duplicate = cloneReturn();
  duplicate.items[1].orderItemId = ITEM_A_ID.toUpperCase();
  assert.equal(inspectReturnPresentationSnapshot(duplicate).valid, false);

  const invalidIdentity = cloneReturn();
  invalidIdentity._id = 'return-1';
  invalidIdentity.items[0].orderItemId = 'item-1';
  assert.equal(inspectReturnPresentationSnapshot(invalidIdentity).valid, false);

  const unsafeCount = cloneReturn();
  unsafeCount.items[0].quantity = Number.MAX_SAFE_INTEGER;
  unsafeCount.items[0].purchasedQuantity = Number.MAX_SAFE_INTEGER;
  unsafeCount.items[1].quantity = 1;
  assert.equal(inspectReturnPresentationSnapshot(unsafeCount).valid, false);
});

test('return presentation requires canonical currencies, statuses, policies, and exact reconciliation', () => {
  for (const currency of [undefined, null, '', 'usd', ' USD ', 'CAD']) {
    assert.equal(inspectReturnPresentationSnapshot(makeReturn({ currency })).valid, false);
  }
  assert.equal(inspectReturnPresentationSnapshot(makeReturn({ status: 'paid' })).valid, false);
  assert.equal(inspectReturnPresentationSnapshot(makeReturn({ policySnapshot: null })).valid, false);
  assert.equal(inspectReturnPresentationSnapshot(makeReturn({
    policySnapshot: { returnsEnabled: false, returnDuration: 14, refundType: 'full_refund' },
  })).valid, false);
  assert.equal(inspectReturnPresentationSnapshot(makeReturn({
    policySnapshot: { returnsEnabled: true, returnDuration: 366, refundType: 'full_refund' },
  })).valid, false);
  assert.match(inspectReturnPresentationSnapshot(makeReturn({
    status: 'accepted_pending_payment',
    policySnapshot: { returnsEnabled: true, returnDuration: 14, refundType: 'replacement_only' },
  })).errors.join(','), /statusResolution/);
  assert.match(inspectReturnPresentationSnapshot(makeReturn({ status: 'replacement_approved' })).errors.join(','), /statusResolution/);

  const zeroRefund = cloneReturn();
  zeroRefund.items.forEach(item => { item.lineSubtotal = 0; });
  zeroRefund.refund = { itemSubtotal: 0, taxAmount: 0, shippingAmount: 0, discountAmount: 0, totalAmount: 0 };
  assert.match(inspectReturnPresentationSnapshot(zeroRefund).errors.join(','), /totalAmountPositive/);
  zeroRefund.policySnapshot.refundType = 'replacement_only';
  assert.equal(inspectReturnPresentationSnapshot(zeroRefund).valid, true);

  const lineMismatch = cloneReturn();
  lineMismatch.refund.itemSubtotal = 249.99;
  lineMismatch.refund.totalAmount = 279.99;
  assert.match(inspectReturnPresentationSnapshot(lineMismatch).errors.join(','), /itemSubtotalReconciliation/);

  const totalMismatch = cloneReturn();
  totalMismatch.refund.totalAmount = 279.99;
  assert.match(inspectReturnPresentationSnapshot(totalMismatch).errors.join(','), /totalAmountReconciliation/);

  const excessiveDiscount = cloneReturn();
  excessiveDiscount.refund.discountAmount = 300;
  excessiveDiscount.refund.totalAmount = 0;
  assert.match(inspectReturnPresentationSnapshot(excessiveDiscount).errors.join(','), /discountAmountReconciliation/);
});

const makeProduct = (overrides = {}) => ({
  _id: '64b000000000000000000010',
  price: 200,
  discountedPrice: 150,
  currency: 'PKR',
  priceCurrency: 'PKR',
  discountedPriceCurrency: 'PKR',
  stock: 0,
  rating: 4.5,
  numReviews: 12,
  ...overrides,
});

test('seller product resolver exposes strict native money, optional discounts, and safe inventory', () => {
  for (const currency of ['USD', 'PKR', 'EUR', 'GBP']) {
    const result = inspectSellerProductPresentation(makeProduct({
      currency,
      priceCurrency: currency,
      discountedPriceCurrency: currency,
    }));
    assert.equal(result.valid, true, `${currency}: ${result.errors.join(', ')}`);
    assert.equal(result.currency, currency);
  }

  const discounted = inspectSellerProductPresentation(makeProduct());
  assert.deepEqual({
    valid: discounted.valid,
    moneyValid: discounted.moneyValid,
    currency: discounted.currency,
    price: discounted.price,
    discountedPrice: discounted.discountedPrice,
    hasDiscount: discounted.hasDiscount,
    discountPercent: discounted.discountPercent,
    stock: discounted.stock,
  }, {
    valid: true,
    moneyValid: true,
    currency: 'PKR',
    price: 200,
    discountedPrice: 150,
    hasDiscount: true,
    discountPercent: 25,
    stock: 0,
  });

  const noDiscount = inspectSellerProductPresentation(makeProduct({ price: 0, discountedPrice: 0 }));
  assert.equal(noDiscount.valid, true);
  assert.equal(noDiscount.hasDiscount, false);
  assert.equal(noDiscount.discountedPrice, null);
  assert.equal(noDiscount.discountPercent, 0);

  const exactRoundedBadge = inspectSellerProductPresentation(makeProduct({ price: 8, discountedPrice: 1 }));
  assert.equal(exactRoundedBadge.discountPercent, 88);
});

test('seller product resolver never relabels or zero-coerces corrupt price, currency, or stock', () => {
  for (const value of [undefined, null, '', '200', true, Number.NaN, Number.POSITIVE_INFINITY, 200.001, Number.MAX_SAFE_INTEGER]) {
    const result = inspectSellerProductPresentation(makeProduct({ price: value }));
    assert.equal(result.moneyValid, false, `price ${String(value)}`);
    assert.equal(result.price, null);
    assert.equal(result.currency, null);
  }

  for (const value of [undefined, null, '', '150', true, Number.NaN, 150.001, 200, 201]) {
    assert.equal(inspectSellerProductPresentation(makeProduct({ discountedPrice: value })).moneyValid, false, `discount ${String(value)}`);
  }

  for (const overrides of [
    { currency: undefined },
    { discountedPriceCurrency: undefined },
    { currency: 'usd', priceCurrency: 'usd', discountedPriceCurrency: 'usd' },
    { currency: 'USD', priceCurrency: 'PKR', discountedPriceCurrency: 'USD' },
    { currency: 'CAD', priceCurrency: 'CAD', discountedPriceCurrency: 'CAD' },
  ]) {
    const result = inspectSellerProductPresentation(makeProduct(overrides));
    assert.equal(result.moneyValid, false);
    assert.equal(result.currency, null);
  }

  for (const stock of [undefined, null, '', '0', true, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const result = inspectSellerProductPresentation(makeProduct({ stock }));
    assert.equal(result.stockValid, false, `stock ${String(stock)}`);
    assert.equal(result.stock, null);
    assert.equal(result.valid, false);
  }

  assert.equal(inspectSellerProductPresentation(makeProduct({ _id: 'product-1' })).managementSafe, false);
  assert.equal(inspectSellerProductPresentation(makeProduct()).managementSafe, true);
});

test('seller inventory overview requires exact counts and fully valid preview products', () => {
  const inventory = {
    totalProducts: 2,
    outOfStock: 1,
    lowStock: 1,
    featuredProducts: 1,
    categories: [{ category: 'Shoes', count: 2 }],
    recentProducts: [makeProduct()],
    topRatedProducts: [makeProduct()],
  };
  assert.equal(sellerInventoryOverviewIsValid(inventory), true);
  for (const invalid of [
    { ...inventory, totalProducts: '2' },
    { ...inventory, outOfStock: 2, lowStock: 1 },
    { ...inventory, categories: [{ category: 'Shoes', count: '2' }] },
    { ...inventory, recentProducts: [makeProduct({ price: '200' })] },
    { ...inventory, topRatedProducts: [makeProduct({ rating: '4.5' })] },
  ]) {
    assert.equal(sellerInventoryOverviewIsValid(invalid), false);
  }
});

test('seller product pagination rejects fabricated, inconsistent, or string counts', () => {
  const pagination = { page: 2, limit: 12, totalProducts: 20, totalPages: 2, hasMore: false };
  assert.deepEqual(inspectProductPagination(pagination, {
    productCount: 8,
    expectedPage: 2,
    expectedLimit: 12,
  }), { valid: true, ...pagination });
  for (const invalid of [
    { ...pagination, page: '2' },
    { ...pagination, totalProducts: 0 },
    { ...pagination, totalPages: 3 },
    { ...pagination, hasMore: true },
  ]) {
    assert.equal(inspectProductPagination(invalid, {
      productCount: 8,
      expectedPage: 2,
      expectedLimit: 12,
    }).valid, false);
  }
});

test('seller return and product components route formatters/actions through strict inspectors', () => {
  const returnsSource = readFileSync(new URL('../src/components/layout/ReturnOrdersPanel.jsx', import.meta.url), 'utf8');
  assert.match(returnsSource, /inspectReturnPresentationSnapshot/);
  assert.match(returnsSource, /Financial snapshot unavailable/);
  assert.match(returnsSource, /const transitions = snapshot\.valid/);
  assert.doesNotMatch(returnsSource, /Number\(.*(?:refund|lineSubtotal|quantity)/);
  assert.doesNotMatch(returnsSource, /(?:refund|lineSubtotal|quantity)[^\n]*(?:\|\||\?\?)\s*0/);

  const productSource = readFileSync(new URL('../src/components/layout/ProductCard.jsx', import.meta.url), 'utf8');
  assert.match(productSource, /inspectSellerProductPresentation/);
  assert.match(productSource, /Price unavailable/);
  assert.match(productSource, /Stock unavailable/);
  assert.match(productSource, /canEdit = presentation\.managementSafe && presentation\.valid/);
  assert.doesNotMatch(productSource, /Number\(safeProduct\.(?:price|discountedPrice|stock)/);
  assert.doesNotMatch(productSource, /(?:price|discountedPrice|stock)[^\n]*(?:\|\||\?\?)\s*0/);
});
