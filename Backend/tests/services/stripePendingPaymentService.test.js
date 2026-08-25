'use strict';

const mockRetrievePaymentIntent = jest.fn();
const mockCancelPaymentIntent = jest.fn();
const mockRetrieveCheckoutSession = jest.fn();
const mockExpireCheckoutSession = jest.fn();
const mockValidateStripeOrderPaymentIntent = jest.fn();
const mockValidateStripeOrderSession = jest.fn();
const mockFulfillStripeOrder = jest.fn();
const mockFulfillStripeOrderPaymentIntent = jest.fn();
const mockAttachStripeOrderReference = jest.fn();
const mockCreateNativeOrderPaymentIntent = jest.fn();
const mockCreateHostedOrderCheckoutSession = jest.fn();
const mockIsAuthoritativeStripeIdempotentReplayRejection = jest.fn();
const mockIsDefinitiveStripeCreationError = jest.fn();
const mockIsStripeIdempotentReplayWithinAuthorityWindow = jest.fn();
const mockCancelUnpaidOrderLocally = jest.fn();
const mockDeleteUnpaidOrderAndReleaseCoupons = jest.fn();
const mockOrderFind = jest.fn();
const mockWalletTransactionFind = jest.fn();

jest.mock('../../config/stripe', () => ({
  stripe: {
    paymentIntents: {
      retrieve: mockRetrievePaymentIntent,
      cancel: mockCancelPaymentIntent,
    },
    checkout: {
      sessions: {
        retrieve: mockRetrieveCheckoutSession,
        expire: mockExpireCheckoutSession,
      },
    },
  },
}));

jest.mock('../../models/Order', () => ({
  find: mockOrderFind,
}));

jest.mock('../../models/WalletTransaction', () => ({
  find: mockWalletTransactionFind,
  updateOne: jest.fn(),
}));

jest.mock('../../services/stripeOrderPaymentService', () => ({
  attachStripeOrderReference: mockAttachStripeOrderReference,
  fulfillStripeOrder: mockFulfillStripeOrder,
  fulfillStripeOrderPaymentIntent: mockFulfillStripeOrderPaymentIntent,
  validateStripeOrderPaymentIntent: mockValidateStripeOrderPaymentIntent,
  validateStripeOrderSession: mockValidateStripeOrderSession,
}));

jest.mock('../../services/stripeOrderSetupService', () => ({
  createNativeOrderPaymentIntent: mockCreateNativeOrderPaymentIntent,
  createHostedOrderCheckoutSession: mockCreateHostedOrderCheckoutSession,
}));

jest.mock('../../services/stripePaymentIntentFactory', () => ({
  isAuthoritativeStripeIdempotentReplayRejection: mockIsAuthoritativeStripeIdempotentReplayRejection,
  isDefinitiveStripeCreationError: mockIsDefinitiveStripeCreationError,
  isStripeIdempotentReplayWithinAuthorityWindow: mockIsStripeIdempotentReplayWithinAuthorityWindow,
}));

jest.mock('../../services/orderCancellationService', () => ({
  cancelUnpaidOrderLocally: mockCancelUnpaidOrderLocally,
}));

jest.mock('../../services/walletService', () => ({
  cancelWalletTopUpFromPaymentIntent: jest.fn(),
  validateWalletTopUpPaymentIntent: jest.fn(),
}));

jest.mock('../../services/couponUsageService', () => ({
  deleteUnpaidOrderAndReleaseCoupons: mockDeleteUnpaidOrderAndReleaseCoupons,
}));

const {
  closeOrderPaymentIntent,
  cleanupStaleStripePaymentIntents,
} = require('../../services/stripePendingPaymentService');

const pendingOrder = (overrides = {}) => ({
  _id: 'order_db_123',
  orderId: 'ORD-123',
  paymentMethod: 'stripe',
  paymentFlow: 'payment_sheet',
  paymentSetupState: 'ready',
  paymentSetupStartedAt: new Date(Date.now() - (10 * 60 * 1000)),
  stripePaymentIntentId: 'pi_123',
  stripeSessionId: null,
  isPaid: false,
  awaitingPayment: true,
  orderStatus: 'pending',
  paymentProcessingStartedAt: null,
  inventoryCommitted: true,
  createdAt: new Date(Date.now() - (10 * 60 * 1000)),
  paymentExpiresAt: new Date(Date.now() - 60_000),
  ...overrides,
});

const setCleanupQueries = (orders = [], walletTopUps = []) => {
  mockOrderFind.mockReturnValue({
    sort: jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue(orders),
    }),
  });
  mockWalletTransactionFind.mockReturnValue({
    limit: jest.fn().mockResolvedValue(walletTopUps),
  });
};

describe('native order PaymentIntent immediate cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateStripeOrderPaymentIntent.mockReturnValue(undefined);
    mockCancelUnpaidOrderLocally.mockImplementation(async ({ orderId }) => ({
      order: { ...pendingOrder(), _id: orderId, orderStatus: 'cancelled', inventoryCommitted: false },
      releasedCoupons: 1,
    }));
  });

  test('closes Stripe first, then delegates local money, inventory, and coupon writes to one atomic transition', async () => {
    const order = pendingOrder({ appliedCoupons: [{ couponId: 'coupon_123' }] });
    const pendingIntent = { id: 'pi_123', status: 'requires_payment_method' };
    const cancelledIntent = { id: 'pi_123', status: 'canceled' };
    mockRetrievePaymentIntent.mockResolvedValue(pendingIntent);
    mockCancelPaymentIntent.mockResolvedValue(cancelledIntent);

    const result = await closeOrderPaymentIntent(order, {
      status: 'cancelled',
      reason: 'PaymentSheet initialization failed.',
    });

    expect(mockCancelPaymentIntent).toHaveBeenCalledWith('pi_123', {
      cancellation_reason: 'abandoned',
    });
    expect(mockValidateStripeOrderPaymentIntent).toHaveBeenCalledWith(order, cancelledIntent);
    expect(mockCancelUnpaidOrderLocally).toHaveBeenCalledWith(expect.objectContaining({
      orderId: order._id,
      reason: 'PaymentSheet initialization failed.',
      externalPaymentClosed: true,
      paymentFailure: expect.objectContaining({
        code: 'PAYMENT_CANCELLED',
        message: 'PaymentSheet initialization failed.',
      }),
    }));
    expect(result).toEqual(expect.objectContaining({
      status: 'cancelled',
      order: expect.objectContaining({ orderStatus: 'cancelled', inventoryCommitted: false }),
      paymentIntent: cancelledIntent,
    }));
  });

  test('never performs local cancellation when Stripe already received payment', async () => {
    const order = pendingOrder();
    const succeededIntent = { id: 'pi_123', status: 'succeeded' };
    mockRetrievePaymentIntent.mockResolvedValue(succeededIntent);

    const result = await closeOrderPaymentIntent(order);

    expect(result.status).toBe('payment_succeeded');
    expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
    expect(mockCancelUnpaidOrderLocally).not.toHaveBeenCalled();
  });

  test('retries an already-cancelled PaymentIntent through the same idempotent local transition', async () => {
    const order = pendingOrder({ orderStatus: 'cancelled' });
    const cancelledIntent = { id: 'pi_123', status: 'canceled' };
    mockRetrievePaymentIntent.mockResolvedValue(cancelledIntent);
    mockCancelUnpaidOrderLocally.mockResolvedValue({ order, releasedCoupons: 0, alreadyCancelled: true });

    const result = await closeOrderPaymentIntent(order);

    expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
    expect(mockCancelUnpaidOrderLocally).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('cancelled');
  });
});

describe('scheduled Stripe order reconciliation', () => {
  let consoleError;

  beforeEach(() => {
    jest.clearAllMocks();
    setCleanupQueries();
    mockValidateStripeOrderSession.mockReturnValue(undefined);
    mockDeleteUnpaidOrderAndReleaseCoupons.mockResolvedValue({ deleted: true, released: 1 });
    mockFulfillStripeOrder.mockResolvedValue({ newlyFulfilled: true });
    mockFulfillStripeOrderPaymentIntent.mockResolvedValue({ newlyFulfilled: true });
    mockAttachStripeOrderReference.mockImplementation(async ({ order, stripeObject, paymentFlow }) => ({
      ...order,
      paymentSetupState: 'ready',
      ...(paymentFlow === 'payment_sheet'
        ? { stripePaymentIntentId: stripeObject.id }
        : { stripeSessionId: stripeObject.id }),
    }));
    mockIsAuthoritativeStripeIdempotentReplayRejection.mockImplementation(
      error => error?.authoritative === true,
    );
    mockIsDefinitiveStripeCreationError.mockImplementation(error => error?.definitive === true);
    mockIsStripeIdempotentReplayWithinAuthorityWindow.mockReturnValue(true);
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  test('treats complete and unpaid as safely closed for card-only hosted Checkout', async () => {
    const order = pendingOrder({
      paymentFlow: 'checkout_session',
      stripePaymentIntentId: null,
      stripeSessionId: 'cs_complete_unpaid',
    });
    const checkoutSession = {
      id: 'cs_complete_unpaid',
      status: 'complete',
      payment_status: 'unpaid',
    };
    setCleanupQueries([order]);
    mockRetrieveCheckoutSession.mockResolvedValue(checkoutSession);

    const result = await cleanupStaleStripePaymentIntents();

    expect(mockExpireCheckoutSession).not.toHaveBeenCalled();
    expect(mockDeleteUnpaidOrderAndReleaseCoupons).toHaveBeenCalledWith({
      orderId: order._id,
      requireAwaitingPayment: true,
      reason: 'The secure card-payment window expired.',
    });
    expect(result.orders).toBe(1);
  });

  test('re-reads an expire race and accepts complete/unpaid as the authoritative closed result', async () => {
    const order = pendingOrder({
      paymentFlow: 'checkout_session',
      stripePaymentIntentId: null,
      stripeSessionId: 'cs_expire_race',
    });
    const open = { id: 'cs_expire_race', status: 'open', payment_status: 'unpaid' };
    const closed = { id: 'cs_expire_race', status: 'complete', payment_status: 'unpaid' };
    setCleanupQueries([order]);
    mockRetrieveCheckoutSession.mockResolvedValueOnce(open).mockResolvedValueOnce(closed);
    mockExpireCheckoutSession.mockRejectedValue(new Error('session changed'));

    const result = await cleanupStaleStripePaymentIntents();

    expect(mockDeleteUnpaidOrderAndReleaseCoupons).toHaveBeenCalledTimes(1);
    expect(result.orders).toBe(1);
  });

  test('fulfills a hosted order when scheduled recovery discovers captured payment', async () => {
    const order = pendingOrder({
      paymentFlow: 'checkout_session',
      stripePaymentIntentId: null,
      stripeSessionId: 'cs_paid',
    });
    const checkoutSession = { id: 'cs_paid', status: 'complete', payment_status: 'paid' };
    setCleanupQueries([order]);
    mockRetrieveCheckoutSession.mockResolvedValue(checkoutSession);

    const result = await cleanupStaleStripePaymentIntents();

    expect(mockFulfillStripeOrder).toHaveBeenCalledWith({
      order,
      stripeSession: checkoutSession,
      eventId: 'scheduled-recovery:cs_paid',
    });
    expect(mockDeleteUnpaidOrderAndReleaseCoupons).not.toHaveBeenCalled();
    expect(result.orders).toBe(0);
  });

  test('replays and closes a deterministic native setup whose ID save was lost', async () => {
    const order = pendingOrder({
      paymentSetupState: 'creating',
      stripePaymentIntentId: null,
      stripeSessionId: null,
    });
    const pendingIntent = { id: 'pi_recovered_cleanup', status: 'requires_payment_method' };
    const cancelledIntent = { id: 'pi_recovered_cleanup', status: 'canceled' };
    setCleanupQueries([order]);
    mockCreateNativeOrderPaymentIntent.mockResolvedValue(pendingIntent);
    mockRetrievePaymentIntent.mockResolvedValue(pendingIntent);
    mockCancelPaymentIntent.mockResolvedValue(cancelledIntent);
    mockCancelUnpaidOrderLocally.mockResolvedValue({
      order: { ...order, orderStatus: 'cancelled', inventoryCommitted: false },
    });

    const result = await cleanupStaleStripePaymentIntents();

    expect(mockCreateNativeOrderPaymentIntent).toHaveBeenCalledWith(order);
    expect(mockAttachStripeOrderReference).toHaveBeenCalledWith({
      order,
      stripeObject: pendingIntent,
      paymentFlow: 'payment_sheet',
    });
    expect(mockDeleteUnpaidOrderAndReleaseCoupons).not.toHaveBeenCalled();
    expect(result.orders).toBe(1);
  });

  test('fulfills captured native payment discovered during lost-ID recovery', async () => {
    const order = pendingOrder({
      paymentSetupState: 'creating',
      stripePaymentIntentId: null,
      stripeSessionId: null,
    });
    const succeededIntent = { id: 'pi_recovered_paid', status: 'succeeded' };
    setCleanupQueries([order]);
    mockCreateNativeOrderPaymentIntent.mockResolvedValue(succeededIntent);
    mockRetrievePaymentIntent.mockResolvedValue(succeededIntent);

    const result = await cleanupStaleStripePaymentIntents();

    expect(mockFulfillStripeOrderPaymentIntent).toHaveBeenCalledWith(expect.objectContaining({
      paymentIntent: succeededIntent,
      eventId: 'scheduled-recovery:pi_recovered_paid',
    }));
    expect(mockDeleteUnpaidOrderAndReleaseCoupons).not.toHaveBeenCalled();
    expect(result.orders).toBe(0);
  });

  test('replays and reconciles a deterministic hosted setup whose ID save was lost', async () => {
    const order = pendingOrder({
      paymentFlow: 'checkout_session',
      paymentSetupState: 'creating',
      stripePaymentIntentId: null,
      stripeSessionId: null,
    });
    const expiredSession = {
      id: 'cs_recovered_cleanup',
      status: 'expired',
      payment_status: 'unpaid',
    };
    setCleanupQueries([order]);
    mockCreateHostedOrderCheckoutSession.mockResolvedValue(expiredSession);
    mockRetrieveCheckoutSession.mockResolvedValue(expiredSession);

    const result = await cleanupStaleStripePaymentIntents();

    expect(mockCreateHostedOrderCheckoutSession).toHaveBeenCalledWith(order);
    expect(mockAttachStripeOrderReference).toHaveBeenCalledWith({
      order,
      stripeObject: expiredSession,
      paymentFlow: 'checkout_session',
    });
    expect(mockDeleteUnpaidOrderAndReleaseCoupons).toHaveBeenCalledTimes(1);
    expect(result.orders).toBe(1);
  });

  test('releases reservations only after an authoritative same-key replay rejection', async () => {
    const order = pendingOrder({
      paymentSetupState: 'creating',
      stripePaymentIntentId: null,
      stripeSessionId: null,
    });
    setCleanupQueries([order]);
    mockCreateNativeOrderPaymentIntent.mockRejectedValue(Object.assign(
      new Error('invalid setup request'),
      { authoritative: true },
    ));

    const result = await cleanupStaleStripePaymentIntents();

    expect(mockAttachStripeOrderReference).not.toHaveBeenCalled();
    expect(mockIsAuthoritativeStripeIdempotentReplayRejection).toHaveBeenCalledWith(
      expect.objectContaining({ authoritative: true }),
      { createdAt: order.createdAt, now: expect.any(Date) },
    );
    expect(mockDeleteUnpaidOrderAndReleaseCoupons).toHaveBeenCalledWith({
      orderId: order._id,
      requireAwaitingPayment: true,
      reason: 'Stripe definitively rejected recovery of the payment setup.',
      match: {
        orderStatus: { $ne: 'cancelled' },
        paymentSetupState: 'creating',
        stripePaymentIntentId: null,
        stripeSessionId: null,
      },
    });
    expect(result.orders).toBe(1);
  });

  test('keeps reservations when recovery is rejected before idempotency can be checked', async () => {
    const order = pendingOrder({
      paymentSetupState: 'creating',
      stripePaymentIntentId: null,
      stripeSessionId: null,
    });
    setCleanupQueries([order]);
    mockCreateNativeOrderPaymentIntent.mockRejectedValue(Object.assign(
      new Error('invalid API credentials'),
      { type: 'StripeAuthenticationError' },
    ));

    const result = await cleanupStaleStripePaymentIntents();

    expect(mockAttachStripeOrderReference).not.toHaveBeenCalled();
    expect(mockDeleteUnpaidOrderAndReleaseCoupons).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('[stripe-cleanup] order'),
      'invalid API credentials',
    );
    expect(result.orders).toBe(0);
  });

  test('keeps reservations and retries later when deterministic recovery is ambiguous', async () => {
    const order = pendingOrder({
      paymentSetupState: 'creating',
      stripePaymentIntentId: null,
      stripeSessionId: null,
    });
    setCleanupQueries([order]);
    mockCreateNativeOrderPaymentIntent.mockRejectedValue(new Error('network reset'));

    const result = await cleanupStaleStripePaymentIntents();

    expect(mockAttachStripeOrderReference).not.toHaveBeenCalled();
    expect(mockDeleteUnpaidOrderAndReleaseCoupons).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('[stripe-cleanup] order'),
      'network reset',
    );
    expect(result.orders).toBe(0);
  });

  test('never reuses a no-reference order key after the conservative Stripe replay window', async () => {
    const order = pendingOrder({
      paymentSetupState: 'creating',
      paymentSetupStartedAt: new Date(Date.now() - (24 * 60 * 60 * 1000)),
      stripePaymentIntentId: null,
      stripeSessionId: null,
    });
    setCleanupQueries([order]);
    mockIsStripeIdempotentReplayWithinAuthorityWindow.mockReturnValue(false);

    const result = await cleanupStaleStripePaymentIntents();

    expect(mockCreateNativeOrderPaymentIntent).not.toHaveBeenCalled();
    expect(mockCreateHostedOrderCheckoutSession).not.toHaveBeenCalled();
    expect(mockAttachStripeOrderReference).not.toHaveBeenCalled();
    expect(mockDeleteUnpaidOrderAndReleaseCoupons).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('[stripe-cleanup] order'),
      expect.stringContaining('too old for safe automatic replay'),
    );
    expect(result.orders).toBe(0);
  });

  test('deletes a no-reference Stripe checkout only when durable state proves setup never started', async () => {
    const order = pendingOrder({
      paymentSetupState: 'not_started',
      stripePaymentIntentId: null,
      stripeSessionId: null,
    });
    setCleanupQueries([order]);

    const result = await cleanupStaleStripePaymentIntents();

    expect(mockDeleteUnpaidOrderAndReleaseCoupons).toHaveBeenCalledTimes(1);
    expect(result.orders).toBe(1);
  });
});
