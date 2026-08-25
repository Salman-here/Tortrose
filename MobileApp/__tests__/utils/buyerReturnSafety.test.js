import { readFileSync } from 'fs';
import {
  fetchCompleteBuyerReturns,
  inspectBuyerReturnEligibilityResponse,
  inspectBuyerReturnMutationResponse,
  inspectBuyerReturnOrderContext,
  inspectBuyerReturnsResponse,
} from '../../src/utils/returnPresentationSafety';

const IDS = Object.freeze({
  order: '64b000000000000000000101',
  item: '64b000000000000000000102',
  product: '64b000000000000000000103',
  seller: '64b000000000000000000104',
  buyer: '64b000000000000000000105',
  store: '64b000000000000000000106',
  request: '64b000000000000000000107',
});
const clone = value => JSON.parse(JSON.stringify(value));
const makeOrder = (overrides = {}) => ({
  _id: IDS.order,
  orderId: 'ORD-RETURN-1001',
  currency: 'PKR',
  orderItems: [{
    _id: IDS.item, productId: IDS.product, seller: IDS.seller,
    name: 'Verified shoes', image: '', quantity: 2, price: 50, lineSubtotal: 100,
  }],
  orderSummary: { subtotal: 100, shippingCost: 10, tax: 5, couponDiscount: 5, totalAmount: 110 },
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
    orderItemId: IDS.item, productId: IDS.product, name: 'Verified shoes', image: '',
    quantity: 1, purchasedQuantity: 2, unitPrice: 50, lineSubtotal: 50,
  }],
  reasonCategory: 'damaged',
  reasonDetails: 'The item arrived damaged.',
  status: 'requested',
  statusHistory: [{
    status: 'requested', note: 'The item arrived damaged.', changedBy: IDS.buyer,
    actorRole: 'buyer', changedAt: '2026-08-05T00:00:00.000Z',
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

describe('buyer return presentation safety', () => {
  test('binds list and eligibility to exact order identity, currency, quantities, dates, and money', () => {
    ['USD', 'PKR', 'EUR', 'GBP'].forEach((currency) => {
      const context = inspectBuyerReturnOrderContext(makeOrder({ currency }));
      const eligibility = inspectBuyerReturnEligibilityResponse(makeEligibility(), context);
      const requests = inspectBuyerReturnsResponse(
        completeReturns([makeRequest({ currency })]), context, eligibility,
      );
      expect(context.valid).toBe(true);
      expect(eligibility.valid).toBe(true);
      expect(requests.valid).toBe(true);
      expect(requests.requests[0].currency).toBe(currency);
      expect(requests.requests[0].refund.totalAmount).toBe(60);
    });
  });

  test('accepts a complete empty list before delivery without inventing actions', () => {
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
    expect(eligibility.valid).toBe(true);
    expect(requests.valid).toBe(true);
    expect(requests.requests).toEqual([]);
  });

  test('fails closed on missing money sources and malformed eligibility actions', () => {
    [
      { currency: undefined },
      { currency: 'usd' },
      { orderSummary: { subtotal: 100, shippingCost: 10, tax: 5, couponDiscount: 5 } },
    ].forEach(overrides => expect(inspectBuyerReturnOrderContext(makeOrder(overrides)).valid).toBe(false));

    const context = inspectBuyerReturnOrderContext(makeOrder());
    [
      value => { value.orderId = 'OTHER-ORDER'; },
      value => { value.groups[0].seller._id = 'seller-action'; },
      value => { value.groups[0].items[0].remainingReturnableQuantity = '1'; },
      value => { value.groups[0].items[0].lineSubtotal = 99.99; },
      value => { value.groups[0].items[0].eligibilityDeadline = '2026-08-14T00:00:00.000Z'; },
    ].forEach((corrupt) => {
      const payload = clone(makeEligibility());
      corrupt(payload);
      expect(inspectBuyerReturnEligibilityResponse(payload, context).valid).toBe(false);
    });
  });

  test('rejects wrong return identity/currency, corrupt dates/counts, and wrong mutation actions', () => {
    const context = inspectBuyerReturnOrderContext(makeOrder());
    const eligibility = inspectBuyerReturnEligibilityResponse(makeEligibility(), context);
    [
      value => { value.returns[0].order = '64b000000000000000000999'; },
      value => { value.returns[0].currency = 'USD'; },
      value => { value.returns[0]._id = IDS.request.toUpperCase(); },
      value => { value.returns[0].statusHistory[0].changedAt = 'August 5, 2026'; },
      value => { value.returns[0].refund.totalAmount = 59.99; },
      value => { value.returns[0].items[0].quantity = '1'; },
    ].forEach((corrupt) => {
      const payload = completeReturns([makeRequest()]);
      corrupt(payload);
      expect(inspectBuyerReturnsResponse(payload, context, eligibility).valid).toBe(false);
    });
    expect(inspectBuyerReturnsResponse({ success: true, returns: [makeRequest()] }, context, eligibility)
      .errors).toContain('returns');

    const create = inspectBuyerReturnMutationResponse({
      success: true, replayed: false, returnRequest: makeRequest(),
    }, context, {
      mode: 'create',
      expectedSellerId: IDS.seller,
      expectedItems: [{ orderItemId: IDS.item, quantity: 1 }],
      expectedReasonCategory: 'damaged',
      expectedReasonDetails: 'The item arrived damaged.',
    });
    expect(create.valid).toBe(true);
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
    expect(inspectBuyerReturnMutationResponse({
      success: true, returnRequest: cancelledRequest,
    }, context, {
      mode: 'cancel', expectedRequestId: IDS.request, expectedStatus: 'cancelled_by_buyer',
    }).valid).toBe(true);
    expect(inspectBuyerReturnMutationResponse({
      success: true, returnRequest: makeRequest(),
    }, context, {
      mode: 'cancel', expectedRequestId: '64b000000000000000000999', expectedStatus: 'cancelled_by_buyer',
    }).valid).toBe(false);
  });

  test('loads an exact 100-row page plus every verified continuation page', async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({ _id: `row-${index + 1}` }));
    const fetchPage = jest.fn(async (page, limit) => ({
      success: true,
      returns: page === 1 ? first : [{ _id: 'row-101' }],
      pagination: {
        page,
        limit,
        totalReturns: 101,
        totalPages: 2,
        hasMore: page === 1,
      },
    }));
    await expect(fetchCompleteBuyerReturns(fetchPage)).resolves.toMatchObject({
      complete: true,
      totalReturns: 101,
      returns: expect.arrayContaining([{ _id: 'row-101' }]),
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    await expect(fetchCompleteBuyerReturns(async (page, limit) => ({
      success: true,
      returns: page === 1 ? first : [],
      pagination: { page, limit, totalReturns: 101, totalPages: 2, hasMore: page === 1 },
    }))).rejects.toThrow(/pagination response changed|pagination response is invalid/i);
  });

  test('mobile panel clears stale rows and gates formatting/actions through inspectors', () => {
    const source = readFileSync(require.resolve('../../src/components/BuyerReturnsSection.js'), 'utf8');
    expect(source).toMatch(/inspectBuyerReturnEligibilityResponse/);
    expect(source).toMatch(/inspectBuyerReturnsResponse/);
    expect(source).toMatch(/inspectBuyerReturnMutationResponse/);
    expect(source).toMatch(/loadGenerationRef/);
    expect(source).toMatch(/setGroups\(\[\]\)/);
    expect(source).toMatch(/setRequests\(\[\]\)/);
    expect(source).not.toMatch(/data\?\.(?:groups|returns)\s*\|\|\s*\[\]/);
    expect(source).not.toMatch(/formatMoney\((?:item\.lineSubtotal|request\.refund)/);
    expect(source).not.toMatch(/Number\(quantities/);
  });
});
