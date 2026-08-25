import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fetchCompleteBuyerReturns,
  inspectBuyerReturnEligibilityResponse,
  inspectBuyerReturnMutationResponse,
  inspectBuyerReturnOrderContext,
  inspectBuyerReturnsResponse,
} from '../src/utils/returnPresentationSafety.js';

const IDS = Object.freeze({
  order: '64b000000000000000000101',
  item: '64b000000000000000000102',
  product: '64b000000000000000000103',
  seller: '64b000000000000000000104',
  buyer: '64b000000000000000000105',
  store: '64b000000000000000000106',
  request: '64b000000000000000000107',
});

const clone = value => structuredClone(value);
const makeOrder = (overrides = {}) => ({
  _id: IDS.order,
  orderId: 'ORD-RETURN-1001',
  currency: 'PKR',
  orderItems: [{
    _id: IDS.item,
    productId: IDS.product,
    seller: IDS.seller,
    name: 'Verified shoes',
    image: '',
    quantity: 2,
    price: 50,
    lineSubtotal: 100,
  }],
  orderSummary: {
    subtotal: 100,
    shippingCost: 10,
    tax: 5,
    couponDiscount: 5,
    totalAmount: 110,
  },
  ...overrides,
});
const makeEligibility = (overrides = {}) => ({
  success: true,
  orderId: 'ORD-RETURN-1001',
  groups: [{
    seller: { _id: IDS.seller, username: 'seller' },
    store: { _id: IDS.store, storeName: 'Verified Store' },
    policy: { returnsEnabled: true, returnDuration: 14, refundType: 'full_refund' },
    policyVariants: ['full_refund'],
    policySource: 'order_snapshot',
    fulfillment: { status: 'delivered', deliveredAt: '2026-08-01T00:00:00.000Z' },
    eligibilityDeadline: '2026-08-15T00:00:00.000Z',
    eligible: true,
    reason: '',
    items: [{
      orderItemId: IDS.item,
      productId: IDS.product,
      name: 'Verified shoes',
      image: '',
      purchasedQuantity: 2,
      alreadyRequestedQuantity: 1,
      remainingReturnableQuantity: 1,
      unitPrice: 50,
      lineSubtotal: 100,
      returnPolicy: { returnsEnabled: true, returnDuration: 14, refundType: 'full_refund' },
      eligibilityDeadline: '2026-08-15T00:00:00.000Z',
      eligible: true,
      reason: '',
    }],
  }],
  ...overrides,
});
const makeRequest = (overrides = {}) => ({
  _id: IDS.request,
  returnNumber: 'RET-1001-A1B2C3',
  order: IDS.order,
  orderId: 'ORD-RETURN-1001',
  buyer: IDS.buyer,
  seller: { _id: IDS.seller, username: 'seller' },
  store: { _id: IDS.store, storeName: 'Verified Store' },
  storeName: 'Verified Store',
  currency: 'PKR',
  items: [{
    orderItemId: IDS.item,
    productId: IDS.product,
    name: 'Verified shoes',
    image: '',
    quantity: 1,
    purchasedQuantity: 2,
    unitPrice: 50,
    lineSubtotal: 50,
  }],
  reasonCategory: 'damaged',
  reasonDetails: 'The item arrived damaged.',
  status: 'requested',
  statusHistory: [{
    status: 'requested',
    note: 'The item arrived damaged.',
    changedBy: IDS.buyer,
    actorRole: 'buyer',
    changedAt: '2026-08-05T00:00:00.000Z',
  }],
  requestedAt: '2026-08-05T00:00:00.000Z',
  eligibilityDeadline: '2026-08-15T00:00:00.000Z',
  policySnapshot: { returnsEnabled: true, returnDuration: 14, refundType: 'full_refund' },
  refund: { itemSubtotal: 50, taxAmount: 2.5, shippingAmount: 10, discountAmount: 2.5, totalAmount: 60 },
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:00:00.000Z',
  ...overrides,
});
const completeReturns = (returns) => ({
  success: true,
  complete: true,
  totalReturns: returns.length,
  returns,
});

test('buyer return payloads bind exact order identity, currency, quantities, dates, and money', () => {
  for (const currency of ['USD', 'PKR', 'EUR', 'GBP']) {
    const orderContext = inspectBuyerReturnOrderContext(makeOrder({ currency }));
    const eligibility = inspectBuyerReturnEligibilityResponse(makeEligibility(), orderContext);
    const requests = inspectBuyerReturnsResponse(
      completeReturns([makeRequest({ currency })]), orderContext, eligibility,
    );
    assert.equal(orderContext.valid, true, `${currency}: ${orderContext.errors.join(',')}`);
    assert.equal(eligibility.valid, true, `${currency}: ${eligibility.errors.join(',')}`);
    assert.equal(requests.valid, true, `${currency}: ${requests.errors.join(',')}`);
    assert.equal(requests.requests[0].currency, currency);
    assert.equal(requests.requests[0].refund.totalAmount, 60);
  }
});

test('buyer return validation accepts a complete empty list before delivery without inventing actions', () => {
  const context = inspectBuyerReturnOrderContext(makeOrder());
  const payload = makeEligibility();
  const group = payload.groups[0];
  group.fulfillment = { status: 'shipped', deliveredAt: null };
  group.eligibilityDeadline = null;
  group.eligible = false;
  group.reason = 'Return requests open after this seller portion is delivered.';
  group.items[0].alreadyRequestedQuantity = 0;
  group.items[0].remainingReturnableQuantity = 2;
  group.items[0].eligibilityDeadline = null;
  group.items[0].eligible = false;
  group.items[0].reason = group.reason;
  const eligibility = inspectBuyerReturnEligibilityResponse(payload, context);
  const requests = inspectBuyerReturnsResponse(completeReturns([]), context, eligibility);
  assert.equal(eligibility.valid, true, eligibility.errors.join(','));
  assert.equal(requests.valid, true, requests.errors.join(','));
  assert.deepEqual(requests.requests, []);
});

test('buyer return validation fails closed on missing currency/total and malformed eligibility actions', () => {
  for (const overrides of [
    { currency: undefined },
    { currency: 'usd' },
    { orderSummary: { subtotal: 100, shippingCost: 10, tax: 5, couponDiscount: 5 } },
  ]) assert.equal(inspectBuyerReturnOrderContext(makeOrder(overrides)).valid, false);

  const context = inspectBuyerReturnOrderContext(makeOrder());
  const cases = [
    (value) => { value.orderId = 'OTHER-ORDER'; },
    (value) => { value.groups[0].seller._id = 'seller-action'; },
    (value) => { value.groups[0].items[0].remainingReturnableQuantity = '1'; },
    (value) => { value.groups[0].items[0].lineSubtotal = 99.99; },
    (value) => { value.groups[0].items[0].eligibilityDeadline = '2026-08-14T00:00:00.000Z'; },
    (value) => { value.groups[0].policyVariants = ['store_credit']; },
  ];
  for (const corrupt of cases) {
    const payload = clone(makeEligibility());
    corrupt(payload);
    assert.equal(inspectBuyerReturnEligibilityResponse(payload, context).valid, false);
  }
});

test('buyer return list rejects wrong order/currency, corrupt dates/IDs, and non-conserving values', () => {
  const context = inspectBuyerReturnOrderContext(makeOrder());
  const eligibility = inspectBuyerReturnEligibilityResponse(makeEligibility(), context);
  const cases = [
    (value) => { value.returns[0].order = '64b000000000000000000999'; },
    (value) => { value.returns[0].currency = 'USD'; },
    (value) => { value.returns[0]._id = IDS.request.toUpperCase(); },
    (value) => { value.returns[0].statusHistory[0].changedAt = 'August 5, 2026'; },
    (value) => { value.returns[0].refund.totalAmount = 59.99; },
    (value) => { value.returns[0].items[0].quantity = '1'; },
  ];
  for (const corrupt of cases) {
    const payload = completeReturns([makeRequest()]);
    corrupt(payload);
    assert.equal(inspectBuyerReturnsResponse(payload, context, eligibility).valid, false);
  }
  assert.equal(inspectBuyerReturnsResponse({ success: true, returns: [makeRequest()] }, context, eligibility)
    .errors.includes('returns'), true);

  const second = makeRequest({
    _id: '64b000000000000000000108',
    returnNumber: 'RET-1002-D4E5F6',
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    requestedAt: '2026-08-04T00:00:00.000Z',
    statusHistory: [{
      status: 'requested', note: 'The item arrived damaged.', changedBy: IDS.buyer,
      actorRole: 'buyer', changedAt: '2026-08-04T00:00:00.000Z',
    }],
  });
  assert.match(
    inspectBuyerReturnsResponse(completeReturns([makeRequest(), second]), context, eligibility).errors.join(','),
    /aggregateItemConservation|consumedQuantity/,
  );
});

test('buyer return pagination loads an exact 100-row first page and every continuation', async () => {
  const first = Array.from({ length: 100 }, (_, index) => ({ _id: `row-${index + 1}` }));
  const fetchPage = async (page, limit) => ({
    success: true,
    returns: page === 1 ? first : [{ _id: 'row-101' }],
    pagination: {
      page,
      limit,
      totalReturns: 101,
      totalPages: 2,
      hasMore: page === 1,
    },
  });
  const complete = await fetchCompleteBuyerReturns(fetchPage);
  assert.equal(complete.complete, true);
  assert.equal(complete.totalReturns, 101);
  assert.equal(complete.returns.length, 101);
  await assert.rejects(
    fetchCompleteBuyerReturns(async (page, limit) => ({
      success: true,
      returns: page === 1 ? first : [],
      pagination: { page, limit, totalReturns: 101, totalPages: 2, hasMore: page === 1 },
    })),
    /pagination response changed|pagination response is invalid/i,
  );
});

test('create/cancel responses must echo the exact canonical action and saved snapshot', () => {
  const context = inspectBuyerReturnOrderContext(makeOrder());
  const creation = inspectBuyerReturnMutationResponse({
    success: true,
    replayed: false,
    returnRequest: makeRequest(),
  }, context, {
    mode: 'create',
    expectedSellerId: IDS.seller,
    expectedItems: [{ orderItemId: IDS.item, quantity: 1 }],
    expectedReasonCategory: 'damaged',
    expectedReasonDetails: 'The item arrived damaged.',
  });
  assert.equal(creation.valid, true, creation.errors.join(','));

  const cancelledRequest = makeRequest({
    status: 'cancelled_by_buyer',
    updatedAt: '2026-08-06T00:00:00.000Z',
    statusHistory: [
      ...makeRequest().statusHistory,
      {
        status: 'cancelled_by_buyer', note: '', changedBy: IDS.buyer,
        actorRole: 'buyer', changedAt: '2026-08-06T00:00:00.000Z',
      },
    ],
  });
  const cancellation = inspectBuyerReturnMutationResponse({
    success: true,
    returnRequest: cancelledRequest,
  }, context, {
    mode: 'cancel',
    expectedRequestId: IDS.request,
    expectedStatus: 'cancelled_by_buyer',
  });
  assert.equal(cancellation.valid, true, cancellation.errors.join(','));

  const wrongAction = inspectBuyerReturnMutationResponse({
    success: true,
    returnRequest: makeRequest(),
  }, context, {
    mode: 'cancel',
    expectedRequestId: '64b000000000000000000999',
    expectedStatus: 'cancelled_by_buyer',
  });
  assert.equal(wrongAction.valid, false);
});

test('buyer panels clear stale rows and gate formatting/actions through verified snapshots', () => {
  const source = readFileSync(new URL('../src/components/layout/BuyerReturnsPanel.jsx', import.meta.url), 'utf8');
  assert.match(source, /inspectBuyerReturnEligibilityResponse/);
  assert.match(source, /inspectBuyerReturnsResponse/);
  assert.match(source, /inspectBuyerReturnMutationResponse/);
  assert.match(source, /loadGenerationRef/);
  assert.match(source, /setGroups\(\[\]\)/);
  assert.match(source, /setRequests\(\[\]\)/);
  assert.match(source, /server response could not be verified/);
  assert.doesNotMatch(source, /data\?\.(?:groups|returns)\s*\|\|\s*\[\]/);
  assert.doesNotMatch(source, /formatMoney\((?:item\.lineSubtotal|request\.refund)/);
  assert.doesNotMatch(source, /Number\(quantity\)/);
});
