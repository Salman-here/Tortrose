const mockPaymentIntentRetrieve = jest.fn();
const mockCheckoutSessionRetrieve = jest.fn();
const mockPaymentIntentCreate = jest.fn();
const mockCheckoutSessionCreate = jest.fn();
const mockCheckoutSessionExpire = jest.fn();
const mockRestoreOrderInventory = jest.fn();
const mockCommitOrderInventory = jest.fn();
const mockCloseOrderPaymentIntent = jest.fn();
const mockFulfillStripeOrder = jest.fn();
const mockFulfillStripeOrderPaymentIntent = jest.fn();
const mockDeleteUnpaidOrderAndReleaseCoupons = jest.fn();
const mockOrderFindOneAndUpdate = jest.fn();
const mockOrderFindById = jest.fn();
const mockResolveOrderReference = jest.fn();
const mockEnsureStripeCustomerForUser = jest.fn();
const mockRemoveFulfilledOrderItemsFromCart = jest.fn().mockResolvedValue({ removed: true });

jest.mock('../../config/stripe', () => ({
  stripe: {
    paymentIntents: {
      retrieve: mockPaymentIntentRetrieve,
      cancel: jest.fn(),
      create: mockPaymentIntentCreate,
    },
    checkout: {
      sessions: {
        retrieve: mockCheckoutSessionRetrieve,
        create: mockCheckoutSessionCreate,
        expire: mockCheckoutSessionExpire,
      },
    },
    coupons: { create: jest.fn() },
  },
  STRIPE_MODE: 'test',
}));

jest.mock('../../services/stripeCustomerService', () => ({
  ensureStripeCustomerForUser: mockEnsureStripeCustomerForUser,
  createMobileCustomerAccess: jest.fn().mockResolvedValue({
    customerAccessMode: 'customer_session',
    customerSessionClientSecret: 'cuss_secret_recovered',
  }),
  getStripeMobileConfig: jest.fn().mockReturnValue({
    publishableKey: 'pk_test_recovery',
    merchantCountryCode: 'PK',
  }),
}));

jest.mock('../../models/Order', () => ({
  findOneAndUpdate: mockOrderFindOneAndUpdate,
  findById: mockOrderFindById,
}));

jest.mock('../../services/orderReferenceService', () => ({
  resolveOrderReference: mockResolveOrderReference,
}));

jest.mock('../../services/couponUsageService', () => ({
  reserveOrderCoupons: jest.fn(),
  consumeOrderCoupons: jest.fn(),
  deleteUnpaidOrderAndReleaseCoupons: mockDeleteUnpaidOrderAndReleaseCoupons,
}));

jest.mock('../../services/orderInventoryService', () => ({
  commitOrderInventory: mockCommitOrderInventory,
  restoreOrderInventory: mockRestoreOrderInventory,
}));

jest.mock('../../services/cartFulfillmentService', () => ({
  removeFulfilledOrderItemsFromCart: mockRemoveFulfilledOrderItemsFromCart,
}));

jest.mock('../../services/stripePendingPaymentService', () => ({
  createPaymentExpiry: jest.fn(),
  closeOrderPaymentIntent: mockCloseOrderPaymentIntent,
}));

jest.mock('../../services/stripeOrderPaymentService', () => ({
  ...jest.requireActual('../../services/stripeOrderPaymentService'),
  fulfillStripeOrder: mockFulfillStripeOrder,
  fulfillStripeOrderPaymentIntent: mockFulfillStripeOrderPaymentIntent,
}));

const {
  _respondWithExistingCheckout,
  getPaymentStatus,
} = require('../../controllers/orderController');

const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

const pendingOrder = (paymentFlow) => ({
  _id: 'order_mongo_123',
  orderId: 'ORDER-123',
  user: 'user_123',
  paymentMethod: 'stripe',
  paymentFlow,
  clientSurface: paymentFlow === 'payment_sheet' ? 'mobile' : 'web',
  awaitingPayment: true,
  isPaid: false,
  inventoryCommitted: true,
  stripeCustomerId: 'cus_123',
  stripeMode: 'test',
  stripePaymentIntentId: paymentFlow === 'payment_sheet' ? 'pi_123' : null,
  stripeSessionId: paymentFlow === 'checkout_session' ? 'cs_123' : null,
  paymentSetupState: 'ready',
  createdAt: new Date(),
  paymentSetupStartedAt: new Date(),
  stripeCheckoutSuccessUrl: 'https://rozare.example/success?session_id={CHECKOUT_SESSION_ID}&orderId=ORDER-123',
  stripeCheckoutCancelUrl: 'https://rozare.example/checkout',
  paymentExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
  orderItems: [{
    name: 'Recovered payable item',
    price: 10,
    lineSubtotal: 10,
    sourcePrice: 10,
    sourceLineSubtotal: 10,
    sourceCurrency: 'USD',
    quantity: 1,
  }],
  shippingMethod: { name: 'standard', price: 0, estimatedDays: 3 },
  sellerShipping: [],
  orderSummary: { subtotal: 10, totalAmount: 10, shippingCost: 0, tax: 0, couponDiscount: 0 },
  currency: 'USD',
  shippingInfo: { email: 'buyer@example.com' },
  tracking: {},
  save: jest.fn().mockResolvedValue(undefined),
});

const recoveredPaymentIntent = order => ({
  id: 'pi_recovered',
  client_secret: 'pi_recovered_secret',
  status: 'requires_payment_method',
  amount: 1000,
  amount_received: 0,
  currency: 'usd',
  customer: order.stripeCustomerId,
  livemode: false,
  metadata: {
    type: 'order_payment',
    paymentFlow: 'payment_sheet',
    orderId: order.orderId,
    mongoOrderId: String(order._id),
    userId: String(order.user),
    amountMinor: '1000',
    currency: order.currency,
    stripeMode: order.stripeMode,
  },
});

const recoveredCheckoutSession = order => ({
  id: 'cs_recovered',
  url: 'https://checkout.stripe.test/recovered',
  status: 'open',
  payment_status: 'unpaid',
  mode: 'payment',
  amount_total: 1000,
  currency: 'usd',
  customer: order.stripeCustomerId,
  livemode: false,
  metadata: {
    type: 'order_payment',
    paymentFlow: 'checkout_session',
    orderId: order.orderId,
    mongoOrderId: String(order._id),
    userId: String(order.user),
    amountMinor: '1000',
    currency: order.currency,
    stripeMode: order.stripeMode,
  },
});

describe('Stripe checkout idempotency recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCommitOrderInventory.mockResolvedValue(undefined);
    mockRestoreOrderInventory.mockResolvedValue({});
    mockDeleteUnpaidOrderAndReleaseCoupons.mockResolvedValue({ deleted: true, released: 1 });
  });

  test.each([
    ['PaymentIntent', 'payment_sheet', mockPaymentIntentRetrieve],
    ['Checkout Session', 'checkout_session', mockCheckoutSessionRetrieve],
  ])('closes a reserved order when its Stripe %s is definitively missing', async (_label, flow, retrieve) => {
    retrieve.mockRejectedValue(Object.assign(new Error('No such Stripe resource'), {
      code: 'resource_missing',
      type: 'StripeInvalidRequestError',
      statusCode: 404,
    }));
    const res = response();

    await _respondWithExistingCheckout(res, pendingOrder(flow));

    expect(mockRestoreOrderInventory).not.toHaveBeenCalled();
    expect(mockDeleteUnpaidOrderAndReleaseCoupons).toHaveBeenCalledWith({
      orderId: 'order_mongo_123',
      reason: 'Checkout closed before payment.',
      match: {
        awaitingPayment: true,
        orderStatus: { $ne: 'cancelled' },
      },
    });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'CHECKOUT_ATTEMPT_EXPIRED',
    }));
  });

  test.each([
    ['PaymentIntent', 'payment_sheet', mockPaymentIntentRetrieve],
    ['Checkout Session', 'checkout_session', mockCheckoutSessionRetrieve],
  ])('payment-status polling preserves a %s reservation for a misleading resource_missing error', async (
    _label,
    flow,
    retrieve,
  ) => {
    const order = pendingOrder(flow);
    mockResolveOrderReference.mockResolvedValue(order);
    retrieve.mockRejectedValue(Object.assign(new Error('Wrong Stripe credentials'), {
      code: 'resource_missing',
      type: 'StripeAuthenticationError',
      statusCode: 401,
    }));
    const res = response();

    await getPaymentStatus({
      params: { orderId: order.orderId },
      query: {},
      user: { id: order.user, role: 'user' },
    }, res);

    expect(mockDeleteUnpaidOrderAndReleaseCoupons).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PAYMENT_STATUS_UNAVAILABLE',
      status: 'pending',
    }));
  });

  test.each([
    ['PaymentIntent', 'payment_sheet', mockPaymentIntentRetrieve],
    ['Checkout Session', 'checkout_session', mockCheckoutSessionRetrieve],
  ])('payment-status polling releases a %s reservation only for an authoritative missing resource', async (
    _label,
    flow,
    retrieve,
  ) => {
    const order = pendingOrder(flow);
    mockResolveOrderReference.mockResolvedValue(order);
    retrieve.mockRejectedValue(Object.assign(new Error('No such Stripe resource'), {
      code: 'resource_missing',
      type: 'StripeInvalidRequestError',
      statusCode: 404,
    }));
    const res = response();

    await getPaymentStatus({
      params: { orderId: order.orderId },
      query: {},
      user: { id: order.user, role: 'user' },
    }, res);

    expect(mockDeleteUnpaidOrderAndReleaseCoupons).toHaveBeenCalledWith({
      orderId: order._id,
      reason: 'Checkout closed before payment.',
      match: {
        awaitingPayment: true,
        orderStatus: { $ne: 'cancelled' },
      },
    });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'CHECKOUT_ATTEMPT_EXPIRED',
      status: 'expired',
    }));
  });

  test.each([
    ['PaymentIntent', 'payment_sheet', mockPaymentIntentRetrieve],
    ['Checkout Session', 'checkout_session', mockCheckoutSessionRetrieve],
  ])('preserves the reserved order for a transient %s retrieval failure', async (_label, flow, retrieve) => {
    retrieve.mockRejectedValue(Object.assign(new Error('Stripe temporarily unavailable'), {
      statusCode: 503,
    }));
    const res = response();

    await _respondWithExistingCheckout(res, pendingOrder(flow));

    expect(mockRestoreOrderInventory).not.toHaveBeenCalled();
    expect(mockDeleteUnpaidOrderAndReleaseCoupons).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING',
    }));
  });

  test.each([
    ['PaymentIntent', 'payment_sheet', mockPaymentIntentRetrieve],
    ['Checkout Session', 'checkout_session', mockCheckoutSessionRetrieve],
  ])('does not release a %s reservation for a misleading non-404 resource_missing error', async (
    _label,
    flow,
    retrieve,
  ) => {
    retrieve.mockRejectedValue(Object.assign(new Error('Wrong Stripe credentials'), {
      code: 'resource_missing',
      type: 'StripeAuthenticationError',
      statusCode: 401,
    }));
    const res = response();

    await _respondWithExistingCheckout(res, pendingOrder(flow));

    expect(mockDeleteUnpaidOrderAndReleaseCoupons).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING',
    }));
  });

  test('replays the deterministic PaymentIntent request after create succeeded but its ID was not saved', async () => {
    const order = pendingOrder('payment_sheet');
    order.paymentSetupState = 'creating';
    order.stripePaymentIntentId = null;
    const paymentIntent = recoveredPaymentIntent(order);
    mockPaymentIntentCreate.mockResolvedValue(paymentIntent);
    mockOrderFindOneAndUpdate.mockImplementation(async (_query, update) => {
      Object.assign(order, update.$set);
      return order;
    });
    const res = response();

    await _respondWithExistingCheckout(res, order);

    expect(mockPaymentIntentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: order.stripeCustomerId,
        metadata: expect.objectContaining({ mongoOrderId: String(order._id) }),
      }),
      { idempotencyKey: `rozare-order-pi:test:${order._id}` },
    );
    expect(order.stripePaymentIntentId).toBe(paymentIntent.id);
    expect(order.paymentSetupState).toBe('ready');
    expect(mockOrderFindOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(mockDeleteUnpaidOrderAndReleaseCoupons).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      idempotentReplay: true,
      paymentIntentId: paymentIntent.id,
    }));
  });

  test('replays the deterministic hosted Session request after create succeeded but its ID was not saved', async () => {
    const order = pendingOrder('checkout_session');
    order.paymentSetupState = 'creating';
    order.stripeSessionId = null;
    const checkoutSession = recoveredCheckoutSession(order);
    mockCheckoutSessionCreate.mockResolvedValue(checkoutSession);
    mockCheckoutSessionRetrieve.mockResolvedValue(checkoutSession);
    mockOrderFindOneAndUpdate.mockImplementation(async (_query, update) => {
      Object.assign(order, update.$set);
      return order;
    });
    const res = response();

    await _respondWithExistingCheckout(res, order);

    expect(mockCheckoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_method_types: ['card'],
        customer: order.stripeCustomerId,
        metadata: expect.objectContaining({ mongoOrderId: String(order._id) }),
      }),
      { idempotencyKey: `rozare-order-checkout:test:${order._id}` },
    );
    expect(order.stripeSessionId).toBe(checkoutSession.id);
    expect(order.paymentSetupState).toBe('ready');
    expect(mockOrderFindOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(mockDeleteUnpaidOrderAndReleaseCoupons).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      idempotentReplay: true,
      id: checkoutSession.id,
      url: checkoutSession.url,
    }));
  });

  test('never starts Stripe when cancellation wins the atomic setup claim after inventory reservation', async () => {
    const order = pendingOrder('payment_sheet');
    order.paymentSetupState = 'not_started';
    order.stripePaymentIntentId = null;
    mockOrderFindOneAndUpdate.mockResolvedValue(null);
    mockOrderFindById.mockResolvedValue({
      ...order,
      orderStatus: 'cancelled',
      inventoryCommitted: false,
      paymentSetupState: 'closed',
    });
    const res = response();

    await expect(_respondWithExistingCheckout(res, order)).rejects.toMatchObject({
      code: 'CHECKOUT_ATTEMPT_EXPIRED',
      statusCode: 409,
    });

    expect(mockPaymentIntentCreate).not.toHaveBeenCalled();
    expect(mockDeleteUnpaidOrderAndReleaseCoupons).not.toHaveBeenCalled();
  });

  test('never deletes locally when native provider cleanup remains ambiguous after an inventory failure', async () => {
    const order = pendingOrder('payment_sheet');
    order.inventoryCommitted = false;
    mockPaymentIntentRetrieve.mockResolvedValue(recoveredPaymentIntent(order));
    mockCommitOrderInventory.mockRejectedValue(Object.assign(new Error('stock changed'), {
      code: 'ORDER_STOCK_CHANGED',
      statusCode: 409,
    }));
    mockCloseOrderPaymentIntent.mockRejectedValue(new Error('Stripe cancel timed out'));
    const res = response();

    await _respondWithExistingCheckout(res, order);

    expect(mockDeleteUnpaidOrderAndReleaseCoupons).not.toHaveBeenCalled();
    expect(mockFulfillStripeOrderPaymentIntent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING',
    }));
  });

  test('routes a native cancel race that reveals captured payment through stock-refund fulfillment', async () => {
    const order = pendingOrder('payment_sheet');
    order.inventoryCommitted = false;
    const pendingIntent = recoveredPaymentIntent(order);
    const succeededIntent = {
      ...pendingIntent,
      status: 'succeeded',
      amount_received: pendingIntent.amount,
    };
    mockPaymentIntentRetrieve.mockResolvedValue(pendingIntent);
    mockCommitOrderInventory.mockRejectedValue(Object.assign(new Error('stock changed'), {
      code: 'ORDER_STOCK_CHANGED',
      statusCode: 409,
    }));
    mockCloseOrderPaymentIntent.mockResolvedValue({
      status: 'payment_succeeded',
      paymentIntent: succeededIntent,
    });
    mockFulfillStripeOrderPaymentIntent.mockResolvedValue({ paymentRefunded: true });
    const res = response();

    await _respondWithExistingCheckout(res, order);

    expect(mockFulfillStripeOrderPaymentIntent).toHaveBeenCalledWith({
      order,
      paymentIntent: succeededIntent,
      eventId: `inventory-recovery:${succeededIntent.id}`,
    });
    expect(mockDeleteUnpaidOrderAndReleaseCoupons).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'ORDER_STOCK_CHANGED_AFTER_CAPTURE',
      paymentRefunded: true,
    }));
  });

  test('re-reads a hosted expire race and fulfills/refunds when Stripe became paid', async () => {
    const order = pendingOrder('checkout_session');
    order.inventoryCommitted = false;
    const open = { ...recoveredCheckoutSession(order), id: order.stripeSessionId };
    const paid = {
      ...open,
      status: 'complete',
      payment_status: 'paid',
      payment_intent: 'pi_hosted_paid',
    };
    mockCommitOrderInventory.mockRejectedValue(Object.assign(new Error('stock changed'), {
      code: 'ORDER_STOCK_CHANGED',
      statusCode: 409,
    }));
    mockCheckoutSessionRetrieve.mockResolvedValueOnce(open).mockResolvedValueOnce(paid);
    mockCheckoutSessionExpire.mockRejectedValue(new Error('expire raced payment'));
    mockFulfillStripeOrder.mockResolvedValue({ paymentRefunded: true });
    const res = response();

    await _respondWithExistingCheckout(res, order);

    expect(mockFulfillStripeOrder).toHaveBeenCalledWith({
      order,
      stripeSession: paid,
      eventId: `inventory-recovery:${paid.id}`,
    });
    expect(mockDeleteUnpaidOrderAndReleaseCoupons).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'ORDER_STOCK_CHANGED_AFTER_CAPTURE',
      paymentRefunded: true,
    }));
  });

  test('keeps local reservations when hosted expiration remains unresolved', async () => {
    const order = pendingOrder('checkout_session');
    order.inventoryCommitted = false;
    const open = { ...recoveredCheckoutSession(order), id: order.stripeSessionId };
    mockCommitOrderInventory.mockRejectedValue(Object.assign(new Error('stock changed'), {
      code: 'ORDER_STOCK_CHANGED',
      statusCode: 409,
    }));
    mockCheckoutSessionRetrieve.mockResolvedValue(open);
    mockCheckoutSessionExpire.mockRejectedValue(new Error('Stripe unavailable'));
    const res = response();

    await _respondWithExistingCheckout(res, order);

    expect(mockDeleteUnpaidOrderAndReleaseCoupons).not.toHaveBeenCalled();
    expect(mockFulfillStripeOrder).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING',
    }));
  });

  test('replays an already-completed no-charge card order without a Stripe customer or payment object', async () => {
    const order = pendingOrder('payment_sheet');
    order.isPaid = true;
    order.awaitingPayment = false;
    order.paymentSetupState = 'complete';
    order.paymentFulfilledAt = new Date();
    order.stripePaymentIntentId = null;
    order.orderSummary = { subtotal: 10, totalAmount: 0, shippingCost: 0, tax: 0, couponDiscount: 10 };
    const res = response();

    await _respondWithExistingCheckout(res, order);

    expect(mockEnsureStripeCustomerForUser).not.toHaveBeenCalled();
    expect(mockPaymentIntentCreate).not.toHaveBeenCalled();
    expect(mockPaymentIntentRetrieve).not.toHaveBeenCalled();
    expect(mockCheckoutSessionCreate).not.toHaveBeenCalled();
    expect(mockDeleteUnpaidOrderAndReleaseCoupons).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      isPaid: true,
      completed: true,
      noPaymentRequired: true,
      idempotentReplay: true,
      paymentMethod: 'stripe',
      orderId: order.orderId,
    }));
  });

  test.each([
    ['PaymentIntent', 'payment_sheet', mockPaymentIntentCreate],
    ['Checkout Session', 'checkout_session', mockCheckoutSessionCreate],
  ])('maps Stripe %s amount_too_small to 400 only after exact local cleanup', async (_label, flow, create) => {
    const order = pendingOrder(flow);
    order.paymentSetupState = 'creating';
    order.stripePaymentIntentId = null;
    order.stripeSessionId = null;
    order.orderItems = [{
      name: 'Small payable item',
      price: 0.1,
      lineSubtotal: 0.1,
      sourcePrice: 0.1,
      sourceLineSubtotal: 0.1,
      sourceCurrency: 'USD',
      quantity: 1,
    }];
    order.orderSummary = { subtotal: 0.1, totalAmount: 0.1, shippingCost: 0, tax: 0, couponDiscount: 0 };
    mockOrderFindOneAndUpdate.mockResolvedValue(order);
    create.mockRejectedValue(Object.assign(new Error('Amount is below the provider minimum'), {
      type: 'StripeInvalidRequestError',
      statusCode: 400,
      code: 'amount_too_small',
      param: flow === 'payment_sheet' ? 'amount' : 'line_items',
    }));
    const res = response();

    await _respondWithExistingCheckout(res, order);

    expect(mockDeleteUnpaidOrderAndReleaseCoupons).toHaveBeenCalledWith({
      orderId: order._id,
      reason: 'Stripe rejected the positive order total as below the account minimum.',
      match: {
        awaitingPayment: true,
        orderStatus: { $ne: 'cancelled' },
        paymentSetupState: 'creating',
        stripePaymentIntentId: null,
        stripeSessionId: null,
      },
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PAYMENT_AMOUNT_TOO_SMALL',
      currency: order.currency,
      totalAmount: order.orderSummary.totalAmount,
    }));
  });

  test.each([
    ['a generic invalid request', {
      type: 'StripeInvalidRequestError', statusCode: 400, code: 'parameter_invalid_integer', param: 'amount',
    }],
    ['an unrelated parameter rejection carrying the same code', {
      type: 'StripeInvalidRequestError', statusCode: 400, code: 'amount_too_small', param: 'customer',
    }],
    ['a code-only rejection without an amount parameter', {
      type: 'StripeInvalidRequestError', statusCode: 400, code: 'amount_too_small',
    }],
  ])('does not misclassify %s and closes the authoritatively rejected same-key replay', async (
    _label,
    errorFields,
  ) => {
    const order = pendingOrder('payment_sheet');
    order.paymentSetupState = 'creating';
    order.stripePaymentIntentId = null;
    mockOrderFindOneAndUpdate.mockResolvedValue(order);
    mockPaymentIntentCreate.mockRejectedValue(Object.assign(new Error('Stripe rejected setup'), errorFields));
    const res = response();

    await _respondWithExistingCheckout(res, order);

    expect(mockDeleteUnpaidOrderAndReleaseCoupons).toHaveBeenCalledWith({
      orderId: order._id,
      reason: 'Stripe definitively rejected the payment setup.',
      match: {
        awaitingPayment: true,
        orderStatus: { $ne: 'cancelled' },
        paymentSetupState: 'creating',
        stripePaymentIntentId: null,
        stripeSessionId: null,
      },
    });
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PAYMENT_ATTEMPT_REJECTED',
    }));
  });

  test.each([
    ['authentication', {
      type: 'StripeAuthenticationError', statusCode: 401, code: 'invalid_api_key',
    }],
    ['connection', {
      type: 'StripeConnectionError', code: 'ECONNRESET',
    }],
    ['API', {
      type: 'StripeAPIError', statusCode: 500,
    }],
    ['idempotency', {
      type: 'StripeIdempotencyError', statusCode: 400,
    }],
  ])('keeps the reservation and deterministic key after an ambiguous %s replay error', async (
    _label,
    errorFields,
  ) => {
    const order = pendingOrder('payment_sheet');
    order.paymentSetupState = 'creating';
    order.stripePaymentIntentId = null;
    mockOrderFindOneAndUpdate.mockResolvedValue(order);
    mockPaymentIntentCreate.mockRejectedValue(Object.assign(new Error('Stripe replay is unresolved'), errorFields));
    const res = response();

    await _respondWithExistingCheckout(res, order);

    expect(mockDeleteUnpaidOrderAndReleaseCoupons).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING',
      orderId: order.orderId,
    }));
  });

  test('does not trust a stale amount-too-small replay after Stripe may have pruned the idempotency key', async () => {
    const order = pendingOrder('payment_sheet');
    order.paymentSetupStartedAt = new Date(Date.now() - (24 * 60 * 60 * 1000));
    order.paymentSetupState = 'creating';
    order.stripePaymentIntentId = null;
    mockOrderFindOneAndUpdate.mockResolvedValue(order);
    const res = response();

    await _respondWithExistingCheckout(res, order);

    expect(mockDeleteUnpaidOrderAndReleaseCoupons).not.toHaveBeenCalled();
    expect(mockPaymentIntentCreate).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PAYMENT_SETUP_RECOVERY_REQUIRED',
    }));
  });
});
