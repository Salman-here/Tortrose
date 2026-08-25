'use strict';

const mockStripeSessionsCreate = jest.fn();
const mockStripeSessionsRetrieve = jest.fn();
const mockStripeRefundCreate = jest.fn();
const mockStripeRefundRetrieve = jest.fn();
const mockNotifyBuyerReturnStatus = jest.fn();
const mockEnqueueReturnSafetyRefundSellerNotification = jest.fn();

jest.mock('../../models/ReturnRequest', () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  findOneAndUpdate: jest.fn(),
  findById: jest.fn(),
}));
jest.mock('../../models/Order', () => ({ findById: jest.fn() }));
jest.mock('../../models/Product', () => ({}));
jest.mock('../../models/Store', () => ({}));
jest.mock('../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../models/SellerBalanceTransaction', () => ({}));
jest.mock('../../models/SellerSettlementLock', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../../services/financialNotificationOutboxService', () => ({
  enqueueReturnSettlementNotifications: jest.fn().mockResolvedValue({ buyer: [], seller: [] }),
}));
jest.mock('../../services/returnNotificationService', () => ({
  enqueueReturnCancellationNotifications: jest.fn(),
  notifyBuyerReturnStatus: (...args) => mockNotifyBuyerReturnStatus(...args),
  notifySellerReturnRequested: jest.fn(),
}));
jest.mock('../../services/stripePaymentRiskNotificationService', () => ({
  enqueueReturnSafetyRefundSellerNotification: (...args) => (
    mockEnqueueReturnSafetyRefundSellerNotification(...args)
  ),
}));
jest.mock('../../config/stripe', () => ({
  STRIPE_MODE: 'test',
  stripe: {
    checkout: {
      sessions: {
        create: (...args) => mockStripeSessionsCreate(...args),
        retrieve: (...args) => mockStripeSessionsRetrieve(...args),
      },
    },
    refunds: {
      create: (...args) => mockStripeRefundCreate(...args),
      retrieve: (...args) => mockStripeRefundRetrieve(...args),
    },
  },
}));
jest.mock('../../services/currencyService', () => ({
  isSupportedCurrency: value => ['USD', 'PKR', 'EUR', 'GBP'].includes(String(value || '').toUpperCase()),
  normalizeCurrency: value => String(value || 'USD').toUpperCase(),
}));
jest.mock('../../services/returnPolicyService', () => ({
  normalizeReturnPolicy: jest.fn(),
  returnEligibilityDeadline: jest.fn(),
  canTransitionReturnStatus: jest.fn(),
}));
jest.mock('../../services/walletService', () => ({
  runInTransaction: jest.fn(async work => work({ id: 'mongo-session-1' })),
  creditWalletInSession: jest.fn(),
  toStripeMinorUnits: (amount) => Math.round(Number(amount) * 100),
  roundMoney: value => Math.round(Number(value) * 100) / 100,
}));
jest.mock('../../services/stripePaymentRiskMarkerService', () => ({
  claimStripePaymentCompletion: jest.fn().mockResolvedValue({}),
  markStripePaymentCompletionDone: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../services/walletOrderFundingRiskService', () => ({
  assertWalletOrderFundingReturnable: jest.fn().mockResolvedValue({ returnable: true, sourceIds: [] }),
  attachReturnedWalletFundingProvenance: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../services/orderDiscountService', () => ({
  buildOrderItemDiscountAllocations: jest.fn(),
}));
jest.mock('../../services/orderMoneyService', () => ({
  buildOrderItemMoneyAllocations: jest.fn(),
  convertOrderAmountAtCheckout: jest.fn(),
  ensureOrderExchangeRateSnapshot: jest.fn(),
  ensureOrderSellerSettlement: jest.fn().mockResolvedValue([
    { seller: 'seller-1', sourceCurrency: 'PKR', sourceAmountMinor: 28000, amountUSDMinor: 10000 },
  ]),
  getAccountingOrderCurrency: jest.fn(order => {
    const currency = order?.currency ?? 'USD';
    if (
      typeof currency !== 'string'
      || currency !== currency.trim()
      || currency !== currency.toUpperCase()
      || !['USD', 'PKR', 'EUR', 'GBP'].includes(currency)
    ) {
      throw Object.assign(new Error('stored order currency is invalid'), { code: 'ORDER_CURRENCY_INVALID' });
    }
    return currency;
  }),
  sellerSettlementEntry: jest.fn((entries, sellerId) => (
    entries.find(entry => String(entry.seller) === String(sellerId)) || null
  )),
  sellerOrderSummaryForItems: jest.fn((order, sellerId) => {
    const shipping = (order.sellerShipping || []).find(
      entry => String(entry.seller) === String(sellerId),
    )?.shippingMethod?.price || 0;
    const subtotal = (order.orderItems || [])
      .filter(item => String(item.seller) === String(sellerId))
      .reduce((sum, item) => sum + item.lineSubtotal, 0);
    return {
      shippingCost: shipping,
      totalAmount: Math.round((subtotal + shipping) * 100) / 100,
    };
  }),
}));

const ReturnRequest = require('../../models/ReturnRequest');
const Order = require('../../models/Order');
const User = require('../../models/User');
const { creditWalletInSession } = require('../../services/walletService');
const {
  claimStripePaymentCompletion,
} = require('../../services/stripePaymentRiskMarkerService');
const {
  assertWalletOrderFundingReturnable,
} = require('../../services/walletOrderFundingRiskService');
const { ensureOrderSellerSettlement } = require('../../services/orderMoneyService');
const {
  createReturnSettlementCheckout,
  completeReturnCardSettlement,
  failReturnCardSettlement,
  __private: { validateReturnSettlementSession },
} = require('../../services/returnService');

const setDotted = (target, path, value) => {
  const parts = path.split('.');
  let current = target;
  while (parts.length > 1) {
    const part = parts.shift();
    current[part] = current[part] || {};
    current = current[part];
  }
  current[parts[0]] = value;
};

const applyUpdate = (target, update) => {
  Object.entries(update.$set || {}).forEach(([path, value]) => setDotted(target, path, value));
  Object.entries(update.$inc || {}).forEach(([path, value]) => {
    const parts = path.split('.');
    const leaf = parts.pop();
    let current = target;
    parts.forEach(part => {
      current[part] = current[part] || {};
      current = current[part];
    });
    current[leaf] = Number(current[leaf] || 0) + Number(value);
  });
  if (update.$push?.statusHistory) target.statusHistory.push(update.$push.statusHistory);
  return target;
};

const makeRequest = ({ status = 'under_review', setupState = 'unknown' } = {}) => ({
  _id: 'return-1',
  returnNumber: 'RET-1',
  order: 'order-db-1',
  orderId: 'ORDER-1',
  buyer: 'buyer-1',
  seller: 'seller-1',
  currency: 'PKR',
  items: [{
    orderItemId: 'line-1',
    productId: 'product-1',
    quantity: 1,
    purchasedQuantity: 1,
    unitPrice: 280,
    lineSubtotal: 280,
  }],
  refund: {
    itemSubtotal: 280,
    taxAmount: 0,
    shippingAmount: 0,
    discountAmount: 0,
    totalAmount: 280,
  },
  status,
  settlement: {
    attempt: status === 'under_review' ? 0 : 1,
    fundingSource: status === 'under_review' ? null : 'card',
    status: status === 'under_review' ? 'not_started' : 'pending_payment',
    setupState,
    stripeMode: status === 'under_review' ? null : 'test',
    stripeSetupStartedAt: status === 'under_review' ? null : new Date('2026-08-20T12:25:00.000Z'),
    stripeExpiresAt: status === 'under_review' ? null : new Date('2026-08-20T13:00:00.000Z'),
    clientSurface: 'web',
    stripeCustomerEmail: status === 'under_review' ? '' : 'seller@example.com',
    stripeSuccessUrl: status === 'under_review' ? '' : 'https://rozare.com/return-success',
    stripeCancelUrl: status === 'under_review' ? '' : 'https://rozare.com/return-cancel',
    stripeSessionId: null,
  },
  statusHistory: [],
  save: jest.fn().mockResolvedValue(undefined),
});

const makeOrder = () => ({
  _id: 'order-db-1',
  orderId: 'ORDER-1',
  user: 'buyer-1',
  currency: 'PKR',
  orderItems: [{
    _id: 'line-1',
    productId: 'product-1',
    seller: 'seller-1',
    quantity: 1,
    price: 280,
    lineSubtotal: 280,
  }],
  sellerShipping: [{ seller: 'seller-1', shippingMethod: { price: 0 } }],
  shippingMethod: { seller: 'seller-1', price: 0 },
  orderSummary: { subtotal: 280, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 280 },
  exchangeRateSnapshot: {
    rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
    fallback: false,
  },
});

const mockQuery = value => ({
  select: jest.fn().mockReturnThis(),
  lean: jest.fn().mockReturnThis(),
  session: jest.fn().mockResolvedValue(value),
  then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
});

const sessionFromCreate = (params, id = 'cs_return_1') => ({
  id,
  mode: params.mode,
  status: 'open',
  payment_status: 'unpaid',
  url: `https://checkout.stripe.test/${id}`,
  client_reference_id: params.client_reference_id,
  amount_total: params.line_items[0].price_data.unit_amount,
  currency: params.line_items[0].price_data.currency,
  metadata: params.metadata,
  expires_at: params.expires_at,
  livemode: false,
  payment_intent: null,
});

const paidSettlementSession = (request, paymentIntentId = 'pi_return_risk_1') => ({
  ...sessionFromCreate({
    mode: 'payment',
    client_reference_id: request._id,
    line_items: [{ price_data: { unit_amount: 28000, currency: 'pkr' } }],
    metadata: {
      type: 'return_settlement',
      returnRequestId: 'return-1',
      returnNumber: 'RET-1',
      sellerId: 'seller-1',
      buyerId: 'buyer-1',
      attempt: '1',
      amountMinor: '28000',
      currency: 'PKR',
      stripeMode: 'test',
      clientSurface: 'web',
    },
    expires_at: Math.floor(request.settlement.stripeExpiresAt.getTime() / 1000),
  }),
  status: 'complete',
  payment_status: 'paid',
  payment_intent: paymentIntentId,
});

const safetyRefund = (overrides = {}) => ({
  id: 're_safety_1',
  status: 'succeeded',
  payment_intent: 'pi_return_risk_1',
  amount: 28000,
  currency: 'pkr',
  created: 1787660100,
  reason: 'requested_by_customer',
  livemode: false,
  metadata: {
    type: 'return_settlement_safety_refund',
    returnRequestId: 'return-1',
    originalOrderId: 'order-db-1',
  },
  ...overrides,
});

const externalFundingReversal = () => Object.assign(new Error('original funding reversed'), {
  code: 'RETURN_EXTERNAL_FUNDING_REVERSAL',
  statusCode: 409,
});

describe('return card settlement Stripe lifecycle', () => {
  let request;

  beforeEach(() => {
    jest.clearAllMocks();
    ensureOrderSellerSettlement.mockResolvedValue([
      { seller: 'seller-1', sourceCurrency: 'PKR', sourceAmountMinor: 28000, amountUSDMinor: 10000 },
    ]);
    request = makeRequest();
    Order.findById.mockImplementation(() => mockQuery(makeOrder()));
    ReturnRequest.findOne.mockImplementation(() => mockQuery(request));
    ReturnRequest.find.mockImplementation(() => mockQuery([request]));
    ReturnRequest.findById.mockImplementation(async () => request);
    ReturnRequest.findOneAndUpdate.mockImplementation(async (_filter, update) => applyUpdate(request, update));
    User.findById.mockReturnValue({
      select: jest.fn(() => ({
        lean: jest.fn().mockResolvedValue({ email: 'seller@example.com' }),
      })),
    });
    mockStripeSessionsCreate.mockImplementation(async params => sessionFromCreate(params));
    mockStripeSessionsRetrieve.mockImplementation(async () => {
      throw new Error('Unexpected retrieve');
    });
    mockStripeRefundCreate.mockResolvedValue({ id: 're_safety_1', status: 'succeeded' });
    mockStripeRefundRetrieve.mockImplementation(async () => {
      throw new Error('Unexpected refund retrieve');
    });
    mockEnqueueReturnSafetyRefundSellerNotification.mockResolvedValue([]);
    assertWalletOrderFundingReturnable.mockResolvedValue({ returnable: true, sourceIds: [] });
    creditWalletInSession.mockResolvedValue({ _id: 'wallet-credit-1' });
  });

  test('claims a durable setup snapshot and attaches the exact Checkout Session', async () => {
    const result = await createReturnSettlementCheckout({
      returnRequestId: request._id,
      sellerId: request.seller,
      platform: 'web',
    });

    expect(result.session.id).toBe('cs_return_1');
    expect(result.returnRequest.settlement).toMatchObject({
      setupState: 'ready',
      stripeMode: 'test',
      stripeSessionId: 'cs_return_1',
      clientSurface: 'web',
    });
    expect(mockNotifyBuyerReturnStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'accepted_pending_payment' }),
      expect.objectContaining({ _id: 'order-db-1' }),
      '',
      { session: { id: 'mongo-session-1' } }
    );
    expect(mockStripeSessionsCreate).toHaveBeenCalledTimes(1);
    const [params, options] = mockStripeSessionsCreate.mock.calls[0];
    expect(params).toMatchObject({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: 'seller@example.com',
      client_reference_id: 'return-1',
      metadata: {
        type: 'return_settlement',
        returnRequestId: 'return-1',
        sellerId: 'seller-1',
        buyerId: 'buyer-1',
        amountMinor: '28000',
        currency: 'PKR',
        stripeMode: 'test',
        attempt: '1',
      },
    });
    expect(params.payment_intent_data?.metadata).toEqual(params.metadata);
    expect(options.idempotencyKey).toBe('rozare-return-checkout:test:return-1:attempt-1');
  });

  test('includes final one-cent seller shipping in the durable Stripe amount exactly once', async () => {
    const shippingOrder = makeOrder();
    shippingOrder.sellerShipping[0].shippingMethod.price = 0.01;
    shippingOrder.shippingMethod.price = 0.01;
    shippingOrder.orderSummary.shippingCost = 0.01;
    shippingOrder.orderSummary.totalAmount = 280.01;
    Order.findById.mockImplementation(() => mockQuery(shippingOrder));
    ensureOrderSellerSettlement.mockResolvedValue([{
      seller: 'seller-1',
      sourceCurrency: 'PKR',
      sourceAmountMinor: 28001,
      amountUSDMinor: 10000,
    }]);

    const result = await createReturnSettlementCheckout({
      returnRequestId: request._id,
      sellerId: request.seller,
      platform: 'web',
    });

    expect(result.returnRequest.refund).toMatchObject({
      itemSubtotal: 280,
      shippingAmount: 0.01,
      totalAmount: 280.01,
    });
    expect(result.returnRequest.settlement.shippingAllocationVersion).toBe(1);
    expect(result.returnRequest.settlement.shippingAllocatedAt).toBeInstanceOf(Date);
    expect(result.session.amount_total).toBe(28001);
    expect(mockStripeSessionsCreate).toHaveBeenCalledTimes(1);
    expect(mockStripeSessionsCreate.mock.calls[0][0].metadata.amountMinor).toBe('28001');
  });

  test('fails before Stripe when shipping no longer matches the frozen seller entitlement', async () => {
    const shippingOrder = makeOrder();
    shippingOrder.sellerShipping[0].shippingMethod.price = 0.01;
    shippingOrder.shippingMethod.price = 0.01;
    shippingOrder.orderSummary.shippingCost = 0.01;
    shippingOrder.orderSummary.totalAmount = 280.01;
    Order.findById.mockImplementation(() => mockQuery(shippingOrder));
    // The default frozen entry remains 28000 minor, proving the order snapshot
    // and immutable seller settlement disagree by the shipping cent.

    await expect(createReturnSettlementCheckout({
      returnRequestId: request._id,
      sellerId: request.seller,
      platform: 'web',
    })).rejects.toMatchObject({
      code: 'RETURN_SELLER_SETTLEMENT_MISMATCH',
      statusCode: 409,
    });
    expect(mockStripeSessionsCreate).not.toHaveBeenCalled();
  });

  test.each([
    ['unsupported return currency', value => { value.currency = 'CAD'; }],
    ['blank return currency', value => { value.currency = ''; }],
    ['sub-cent return total', value => { value.refund.totalAmount = 280.001; }],
    ['non-finite return total', value => { value.refund.totalAmount = Number.POSITIVE_INFINITY; }],
    ['mismatched refund components', value => { value.refund.taxAmount = 1; }],
  ])('refuses card setup for %s before calling Stripe', async (_label, mutate) => {
    mutate(request);
    await expect(createReturnSettlementCheckout({
      returnRequestId: request._id,
      sellerId: request.seller,
      platform: 'web',
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(mockStripeSessionsCreate).not.toHaveBeenCalled();
  });

  test.each(['0', true, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'refuses malformed stored return attempt %p before calling Stripe',
    async attempt => {
      request.settlement.attempt = attempt;
      await expect(createReturnSettlementCheckout({
        returnRequestId: request._id,
        sellerId: request.seller,
        platform: 'web',
      })).rejects.toMatchObject({
        code: 'RETURN_SETTLEMENT_SETUP_INVALID',
        statusCode: 503,
      });
      expect(mockStripeSessionsCreate).not.toHaveBeenCalled();
    },
  );

  test('requires exact string metadata and an integer expiry in a durable Stripe session', async () => {
    const result = await createReturnSettlementCheckout({
      returnRequestId: request._id,
      sellerId: request.seller,
      platform: 'web',
    });

    expect(() => validateReturnSettlementSession(result.returnRequest, {
      ...result.session,
      metadata: { ...result.session.metadata, attempt: 1 },
    })).toThrow('snapshot metadata is invalid');
    expect(() => validateReturnSettlementSession(result.returnRequest, {
      ...result.session,
      expires_at: String(result.session.expires_at),
    })).toThrow('expiry is invalid');
  });

  test('refuses card setup when the original order currency is corrupt', async () => {
    const corruptOrder = makeOrder();
    corruptOrder.currency = 'CAD';
    Order.findById.mockImplementation(() => mockQuery(corruptOrder));

    await expect(createReturnSettlementCheckout({
      returnRequestId: request._id,
      sellerId: request.seller,
      platform: 'web',
    })).rejects.toMatchObject({ code: 'ORDER_CURRENCY_INVALID' });
    expect(mockStripeSessionsCreate).not.toHaveBeenCalled();
  });

  test('replays identical Stripe parameters after the first reference write is ambiguous', async () => {
    let attachCalls = 0;
    ReturnRequest.findOneAndUpdate.mockImplementation(async (filter, update) => {
      if (update.$set?.['settlement.stripeSessionId']) {
        attachCalls += 1;
        if (attachCalls === 1) throw new Error('Mongo response was lost');
      }
      return applyUpdate(request, update);
    });

    await expect(createReturnSettlementCheckout({
      returnRequestId: request._id,
      sellerId: request.seller,
      platform: 'web',
    })).rejects.toMatchObject({
      statusCode: 503,
      code: 'RETURN_SETTLEMENT_RECOVERY_PENDING',
    });
    expect(request.status).toBe('accepted_pending_payment');
    expect(request.settlement.setupState).toBe('creating');
    expect(request.settlement.stripeSessionId).toBeNull();

    await expect(createReturnSettlementCheckout({
      returnRequestId: request._id,
      sellerId: request.seller,
      platform: 'mobile',
    })).resolves.toMatchObject({ session: { id: 'cs_return_1' } });

    expect(mockStripeSessionsCreate).toHaveBeenCalledTimes(2);
    expect(mockStripeSessionsCreate.mock.calls[1]).toEqual(mockStripeSessionsCreate.mock.calls[0]);
    expect(request.settlement.setupState).toBe('ready');
    expect(request.settlement.clientSurface).toBe('web');
  });

  test('keeps a replayed creating state closed to cleanup on later Stripe authentication errors', async () => {
    request = makeRequest({ status: 'accepted_pending_payment', setupState: 'creating' });
    ReturnRequest.findOne.mockResolvedValue(request);
    const authError = Object.assign(new Error('bad Stripe key'), {
      type: 'StripeAuthenticationError',
      statusCode: 401,
    });
    mockStripeSessionsCreate.mockRejectedValue(authError);

    await expect(createReturnSettlementCheckout({
      returnRequestId: request._id,
      sellerId: request.seller,
    })).rejects.toMatchObject({
      statusCode: 503,
      code: 'RETURN_SETTLEMENT_RECOVERY_PENDING',
    });
    expect(ReturnRequest.findOneAndUpdate).not.toHaveBeenCalled();
    expect(request.status).toBe('accepted_pending_payment');
    expect(request.settlement.setupState).toBe('creating');
  });

  test('releases a same-key replay only after Stripe authoritatively rejects it within retention', async () => {
    request = makeRequest({ status: 'accepted_pending_payment', setupState: 'creating' });
    request.settlement.stripeSetupStartedAt = new Date(Date.now() - 60 * 1000);
    ReturnRequest.findOne.mockResolvedValue(request);
    const invalidRequest = Object.assign(new Error('expired checkout parameter'), {
      type: 'StripeInvalidRequestError',
      statusCode: 400,
    });
    mockStripeSessionsCreate.mockRejectedValue(invalidRequest);

    await expect(createReturnSettlementCheckout({
      returnRequestId: request._id,
      sellerId: request.seller,
    })).rejects.toBe(invalidRequest);

    expect(request.status).toBe('under_review');
    expect(request.settlement.status).toBe('failed');
    expect(request.settlement.setupState).toBe('closed');
  });

  test('fails closed when the same invalid-request replay is outside Stripe retention', async () => {
    request = makeRequest({ status: 'accepted_pending_payment', setupState: 'creating' });
    request.settlement.stripeSetupStartedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    ReturnRequest.findOne.mockResolvedValue(request);
    mockStripeSessionsCreate.mockRejectedValue(Object.assign(new Error('old key was rejected'), {
      type: 'StripeInvalidRequestError',
      statusCode: 400,
    }));

    await expect(createReturnSettlementCheckout({
      returnRequestId: request._id,
      sellerId: request.seller,
    })).rejects.toMatchObject({
      statusCode: 503,
      code: 'RETURN_SETTLEMENT_RECOVERY_PENDING',
    });

    expect(ReturnRequest.findOneAndUpdate).not.toHaveBeenCalled();
    expect(request.status).toBe('accepted_pending_payment');
    expect(request.settlement.setupState).toBe('creating');
  });

  test('releases a freshly claimed attempt after an authoritative invalid-request rejection', async () => {
    const invalidRequest = Object.assign(new Error('unsupported parameter'), {
      type: 'StripeInvalidRequestError',
      statusCode: 400,
    });
    mockStripeSessionsCreate.mockRejectedValue(invalidRequest);

    await expect(createReturnSettlementCheckout({
      returnRequestId: request._id,
      sellerId: request.seller,
    })).rejects.toBe(invalidRequest);

    expect(request.status).toBe('under_review');
    expect(request.settlement.status).toBe('failed');
    expect(request.settlement.setupState).toBe('closed');
    expect(request.settlement.stripeSessionId).toBeNull();
  });

  test('a signed paid event attaches a lost reference and credits the buyer once', async () => {
    request = makeRequest({ status: 'accepted_pending_payment', setupState: 'creating' });
    const paidSession = {
      ...sessionFromCreate({
        mode: 'payment',
        client_reference_id: request._id,
        line_items: [{ price_data: { unit_amount: 28000, currency: 'pkr' } }],
        metadata: {
          type: 'return_settlement',
          returnRequestId: 'return-1',
          returnNumber: 'RET-1',
          sellerId: 'seller-1',
          buyerId: 'buyer-1',
          attempt: '1',
          amountMinor: '28000',
          currency: 'PKR',
          stripeMode: 'test',
          clientSurface: 'web',
        },
        expires_at: Math.floor(request.settlement.stripeExpiresAt.getTime() / 1000),
      }),
      status: 'complete',
      payment_status: 'paid',
      payment_intent: 'pi_return_1',
    };
    let findByIdCalls = 0;
    ReturnRequest.findById.mockImplementation(() => {
      findByIdCalls += 1;
      if (findByIdCalls === 1) return Promise.resolve(request);
      return { session: jest.fn().mockResolvedValue(request) };
    });

    const completed = await completeReturnCardSettlement(paidSession);

    expect(completed.status).toBe('returned');
    expect(completed.settlement).toMatchObject({
      status: 'completed',
      setupState: 'complete',
      stripeSessionId: 'cs_return_1',
      stripePaymentIntentId: 'pi_return_1',
      walletTransaction: 'wallet-credit-1',
    });
    expect(creditWalletInSession).toHaveBeenCalledTimes(1);
    expect(request.save).toHaveBeenCalledWith({ session: { id: 'mongo-session-1' } });
  });

  test('refunds a captured seller card payment and never credits Wallet when original top-up funding was reversed', async () => {
    request = makeRequest({ status: 'accepted_pending_payment', setupState: 'creating' });
    const paidSession = {
      ...sessionFromCreate({
        mode: 'payment',
        client_reference_id: request._id,
        line_items: [{ price_data: { unit_amount: 28000, currency: 'pkr' } }],
        metadata: {
          type: 'return_settlement',
          returnRequestId: 'return-1',
          returnNumber: 'RET-1',
          sellerId: 'seller-1',
          buyerId: 'buyer-1',
          attempt: '1',
          amountMinor: '28000',
          currency: 'PKR',
          stripeMode: 'test',
          clientSurface: 'web',
        },
        expires_at: Math.floor(request.settlement.stripeExpiresAt.getTime() / 1000),
      }),
      status: 'complete',
      payment_status: 'paid',
      payment_intent: 'pi_return_risk_1',
    };
    const fundingRisk = Object.assign(new Error('original funding reversed'), {
      code: 'RETURN_EXTERNAL_FUNDING_REVERSAL',
      statusCode: 409,
    });
    assertWalletOrderFundingReturnable.mockRejectedValue(fundingRisk);
    mockStripeRefundCreate.mockResolvedValue({
      id: 're_safety_1',
      status: 'succeeded',
      payment_intent: 'pi_return_risk_1',
      amount: 28000,
      currency: 'pkr',
      created: 1787660100,
      reason: 'requested_by_customer',
      livemode: false,
      metadata: {
        type: 'return_settlement_safety_refund',
        returnRequestId: 'return-1',
        originalOrderId: 'order-db-1',
      },
    });

    const closed = await completeReturnCardSettlement(paidSession);

    expect(mockStripeRefundCreate).toHaveBeenCalledWith({
      payment_intent: 'pi_return_risk_1',
      reason: 'requested_by_customer',
      metadata: {
        type: 'return_settlement_safety_refund',
        returnRequestId: 'return-1',
        originalOrderId: 'order-db-1',
      },
    }, {
      idempotencyKey: 'return-settlement-risk-refund:return-1:pi_return_risk_1',
    });
    expect(closed.settlement).toMatchObject({
      status: 'failed',
      setupState: 'closed',
      stripePaymentIntentId: 'pi_return_risk_1',
      riskRefundId: 're_safety_1',
      riskRefundStatus: 'succeeded',
    });
    expect(creditWalletInSession).not.toHaveBeenCalled();
    expect(mockEnqueueReturnSafetyRefundSellerNotification).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['amount', { amount: 27999 }],
    ['currency', { currency: 'usd' }],
    ['PaymentIntent', { payment_intent: 'pi_return_other' }],
    ['metadata', {
      metadata: {
        type: 'return_settlement_safety_refund',
        returnRequestId: 'return-other',
        originalOrderId: 'order-db-1',
      },
    }],
    ['Stripe mode', { livemode: true }],
    ['provider timestamp', { created: Number.MAX_SAFE_INTEGER }],
    ['refund reason', { reason: null }],
  ])('fails closed when Stripe safety-refund %s mismatches the frozen return', async (_label, override) => {
    request = makeRequest({ status: 'accepted_pending_payment', setupState: 'creating' });
    const paidSession = paidSettlementSession(request);
    assertWalletOrderFundingReturnable.mockRejectedValue(externalFundingReversal());
    mockStripeRefundCreate.mockResolvedValue(safetyRefund(override));

    await expect(completeReturnCardSettlement(paidSession)).rejects.toMatchObject({
      code: 'RETURN_SETTLEMENT_RISK_REFUND_MISMATCH',
      statusCode: 503,
    });

    expect(request.settlement).toMatchObject({
      status: 'failed',
      setupState: 'closed',
      stripePaymentIntentId: 'pi_return_risk_1',
    });
    expect(creditWalletInSession).not.toHaveBeenCalled();
    expect(mockEnqueueReturnSafetyRefundSellerNotification).not.toHaveBeenCalled();
  });

  test('reconciles one pending safety refund to succeeded without a second refund or Wallet credit', async () => {
    request = makeRequest({ status: 'accepted_pending_payment', setupState: 'creating' });
    const paidSession = paidSettlementSession(request);
    assertWalletOrderFundingReturnable.mockRejectedValue(externalFundingReversal());
    mockStripeRefundCreate.mockResolvedValue(safetyRefund({ status: 'pending' }));

    await expect(completeReturnCardSettlement(paidSession)).rejects.toMatchObject({
      code: 'RETURN_SETTLEMENT_RISK_REFUND_PENDING',
      statusCode: 503,
    });
    expect(request.settlement).toMatchObject({
      status: 'failed',
      setupState: 'closed',
      stripePaymentIntentId: 'pi_return_risk_1',
      riskRefundId: 're_safety_1',
      riskRefundStatus: 'pending',
      riskRefundAmountMinor: 28000,
      riskRefundCurrency: 'PKR',
    });
    expect(creditWalletInSession).not.toHaveBeenCalled();
    expect(mockEnqueueReturnSafetyRefundSellerNotification).not.toHaveBeenCalled();

    mockStripeRefundRetrieve.mockResolvedValue(safetyRefund({ status: 'succeeded' }));
    const recovered = await completeReturnCardSettlement(paidSession);

    expect(recovered.settlement).toMatchObject({
      status: 'failed',
      setupState: 'closed',
      riskRefundId: 're_safety_1',
      riskRefundStatus: 'succeeded',
      riskRefundAmountMinor: 28000,
      riskRefundCurrency: 'PKR',
    });
    expect(mockStripeRefundCreate).toHaveBeenCalledTimes(1);
    expect(mockStripeRefundRetrieve).toHaveBeenCalledTimes(1);
    expect(creditWalletInSession).not.toHaveBeenCalled();
    expect(mockEnqueueReturnSafetyRefundSellerNotification).toHaveBeenCalledTimes(1);
  });

  test('replays an ambiguous Stripe safety-refund call with the same idempotency key and no Wallet credit', async () => {
    request = makeRequest({ status: 'accepted_pending_payment', setupState: 'creating' });
    const paidSession = paidSettlementSession(request);
    const ambiguousStripeError = new Error('Stripe response was lost after refund submission');
    assertWalletOrderFundingReturnable.mockRejectedValue(externalFundingReversal());
    mockStripeRefundCreate
      .mockRejectedValueOnce(ambiguousStripeError)
      .mockResolvedValueOnce(safetyRefund());

    await expect(completeReturnCardSettlement(paidSession)).rejects.toBe(ambiguousStripeError);
    expect(request.settlement).toMatchObject({
      status: 'failed',
      setupState: 'closed',
      stripePaymentIntentId: 'pi_return_risk_1',
    });
    expect(request.settlement.riskRefundId).toBeFalsy();
    expect(creditWalletInSession).not.toHaveBeenCalled();
    expect(mockEnqueueReturnSafetyRefundSellerNotification).not.toHaveBeenCalled();

    const recovered = await completeReturnCardSettlement(paidSession);

    expect(recovered.settlement).toMatchObject({
      status: 'failed',
      setupState: 'closed',
      riskRefundId: 're_safety_1',
      riskRefundStatus: 'succeeded',
    });
    expect(mockStripeRefundCreate).toHaveBeenCalledTimes(2);
    expect(mockStripeRefundCreate.mock.calls[1]).toEqual(mockStripeRefundCreate.mock.calls[0]);
    expect(mockStripeRefundRetrieve).not.toHaveBeenCalled();
    expect(creditWalletInSession).not.toHaveBeenCalled();
    expect(mockEnqueueReturnSafetyRefundSellerNotification).toHaveBeenCalledTimes(1);
  });

  test('never creates a second refund when Stripe reports the persisted safety refund failed', async () => {
    request = makeRequest({ status: 'accepted_pending_payment', setupState: 'creating' });
    const paidSession = paidSettlementSession(request);
    assertWalletOrderFundingReturnable.mockRejectedValue(externalFundingReversal());
    mockStripeRefundCreate.mockResolvedValue(safetyRefund({ status: 'failed' }));

    await expect(completeReturnCardSettlement(paidSession)).rejects.toMatchObject({
      code: 'RETURN_SETTLEMENT_RISK_REFUND_FAILED',
      statusCode: 503,
    });
    expect(request.settlement).toMatchObject({
      status: 'failed',
      setupState: 'closed',
      riskRefundId: 're_safety_1',
      riskRefundStatus: 'failed',
    });

    mockStripeRefundRetrieve.mockResolvedValue(safetyRefund({ status: 'failed' }));
    await expect(completeReturnCardSettlement(paidSession)).rejects.toMatchObject({
      code: 'RETURN_SETTLEMENT_RISK_REFUND_FAILED',
      statusCode: 503,
    });

    expect(mockStripeRefundCreate).toHaveBeenCalledTimes(1);
    expect(mockStripeRefundRetrieve).toHaveBeenCalledTimes(1);
    expect(mockStripeRefundRetrieve).toHaveBeenCalledWith('re_safety_1');
    expect(creditWalletInSession).not.toHaveBeenCalled();
    expect(mockEnqueueReturnSafetyRefundSellerNotification).not.toHaveBeenCalled();
  });

  test('a concurrent Wallet completion that wins the safety-refund claim prevents any Stripe refund', async () => {
    request = makeRequest({ status: 'accepted_pending_payment', setupState: 'creating' });
    const paidSession = paidSettlementSession(request);
    assertWalletOrderFundingReturnable.mockRejectedValue(externalFundingReversal());
    ReturnRequest.findOneAndUpdate.mockImplementation(async (_filter, update) => {
      if (String(update.$set?.['settlement.failureReason'] || '').includes('requires a Stripe safety refund')) {
        request.status = 'returned';
        request.settlement.status = 'completed';
        request.settlement.setupState = 'complete';
        request.settlement.walletTransaction = 'wallet-credit-won-race';
        return null;
      }
      return applyUpdate(request, update);
    });

    await expect(completeReturnCardSettlement(paidSession)).rejects.toMatchObject({
      code: 'RETURN_SETTLEMENT_RISK_REFUND_CONFLICT',
      statusCode: 409,
    });

    expect(mockStripeRefundCreate).not.toHaveBeenCalled();
    expect(mockStripeRefundRetrieve).not.toHaveBeenCalled();
    expect(creditWalletInSession).not.toHaveBeenCalled();
    expect(mockEnqueueReturnSafetyRefundSellerNotification).not.toHaveBeenCalled();
  });

  test('a late original-funding reversal never safety-refunds an already completed Wallet settlement', async () => {
    request = makeRequest({ status: 'accepted_pending_payment', setupState: 'complete' });
    request.status = 'returned';
    request.settlement.status = 'completed';
    request.settlement.stripeSessionId = 'cs_return_1';
    request.settlement.stripePaymentIntentId = 'pi_return_risk_1';
    request.settlement.walletTransaction = 'wallet-credit-1';
    request.settlement.settledAt = new Date('2026-08-25T10:00:00.000Z');
    ReturnRequest.findById.mockImplementation(() => mockQuery(request));
    const paidSession = paidSettlementSession(request);
    assertWalletOrderFundingReturnable.mockRejectedValue(externalFundingReversal());

    const replay = await completeReturnCardSettlement(paidSession);

    expect(replay).toBe(request);
    expect(assertWalletOrderFundingReturnable).not.toHaveBeenCalled();
    expect(mockStripeRefundCreate).not.toHaveBeenCalled();
    expect(mockStripeRefundRetrieve).not.toHaveBeenCalled();
    expect(creditWalletInSession).not.toHaveBeenCalled();
  });

  test('an early reversal of the seller card payment closes the return without buyer Wallet credit', async () => {
    request = makeRequest({ status: 'accepted_pending_payment', setupState: 'creating' });
    const paidSession = {
      ...sessionFromCreate({
        mode: 'payment',
        client_reference_id: request._id,
        line_items: [{ price_data: { unit_amount: 28000, currency: 'pkr' } }],
        metadata: {
          type: 'return_settlement',
          returnRequestId: 'return-1',
          returnNumber: 'RET-1',
          sellerId: 'seller-1',
          buyerId: 'buyer-1',
          attempt: '1',
          amountMinor: '28000',
          currency: 'PKR',
          stripeMode: 'test',
          clientSurface: 'web',
        },
        expires_at: Math.floor(request.settlement.stripeExpiresAt.getTime() / 1000),
      }),
      status: 'complete',
      payment_status: 'paid',
      payment_intent: 'pi_return_early_reversal',
    };
    let findByIdCalls = 0;
    ReturnRequest.findById.mockImplementation(() => {
      findByIdCalls += 1;
      if (findByIdCalls === 1) return Promise.resolve(request);
      return { session: jest.fn().mockResolvedValue(request) };
    });
    claimStripePaymentCompletion.mockRejectedValueOnce(Object.assign(
      new Error('reversed before completion'),
      { code: 'STRIPE_PAYMENT_REVERSED_BEFORE_COMPLETION' },
    ));

    const closed = await completeReturnCardSettlement(paidSession);

    expect(closed.settlement).toMatchObject({
      status: 'failed',
      setupState: 'closed',
      stripePaymentIntentId: 'pi_return_early_reversal',
    });
    expect(creditWalletInSession).not.toHaveBeenCalled();
  });

  test('an expiry event attaches the lost reference before reopening the return', async () => {
    request = makeRequest({ status: 'accepted_pending_payment', setupState: 'creating' });
    const expiredSession = {
      ...sessionFromCreate({
        mode: 'payment',
        client_reference_id: request._id,
        line_items: [{ price_data: { unit_amount: 28000, currency: 'pkr' } }],
        metadata: {
          type: 'return_settlement',
          returnRequestId: 'return-1',
          returnNumber: 'RET-1',
          sellerId: 'seller-1',
          buyerId: 'buyer-1',
          attempt: '1',
          amountMinor: '28000',
          currency: 'PKR',
          stripeMode: 'test',
          clientSurface: 'web',
        },
        expires_at: Math.floor(request.settlement.stripeExpiresAt.getTime() / 1000),
      }),
      status: 'expired',
    };

    const failed = await failReturnCardSettlement(expiredSession, 'Expired safely.');

    expect(failed.status).toBe('under_review');
    expect(failed.settlement).toMatchObject({
      status: 'failed',
      setupState: 'closed',
      stripeSessionId: 'cs_return_1',
      failureReason: 'Expired safely.',
    });
    expect(creditWalletInSession).not.toHaveBeenCalled();
  });

  test('keeps a pre-snapshot settlement with a stored Stripe ID safely completable', async () => {
    request = makeRequest({ status: 'accepted_pending_payment', setupState: 'unknown' });
    request.settlement.stripeMode = null;
    request.settlement.stripeExpiresAt = null;
    request.settlement.stripeSessionId = 'cs_legacy_return';
    const legacyPaidSession = {
      id: 'cs_legacy_return',
      mode: 'payment',
      status: 'complete',
      payment_status: 'paid',
      client_reference_id: request._id,
      amount_total: 28000,
      currency: 'pkr',
      metadata: {
        type: 'return_settlement',
        returnRequestId: 'return-1',
        returnNumber: 'RET-1',
        sellerId: 'seller-1',
        buyerId: 'buyer-1',
      },
      livemode: false,
      payment_intent: 'pi_legacy_return',
    };
    let findByIdCalls = 0;
    ReturnRequest.findById.mockImplementation(() => {
      findByIdCalls += 1;
      if (findByIdCalls === 1) return Promise.resolve(request);
      return { session: jest.fn().mockResolvedValue(request) };
    });

    await expect(completeReturnCardSettlement(legacyPaidSession)).resolves.toMatchObject({
      status: 'returned',
      settlement: {
        status: 'completed',
        setupState: 'complete',
        stripeSessionId: 'cs_legacy_return',
      },
    });
    expect(creditWalletInSession).toHaveBeenCalledTimes(1);
  });
});
