const mockPaymentIntentRetrieve = jest.fn();
const mockCheckoutSessionRetrieve = jest.fn();
const mockRestoreOrderInventory = jest.fn();
const mockOrderDeleteOne = jest.fn();

jest.mock('../../config/stripe', () => ({
  stripe: {
    paymentIntents: {
      retrieve: mockPaymentIntentRetrieve,
      cancel: jest.fn(),
      create: jest.fn(),
    },
    checkout: {
      sessions: {
        retrieve: mockCheckoutSessionRetrieve,
        create: jest.fn(),
        expire: jest.fn(),
      },
    },
    coupons: { create: jest.fn() },
  },
  STRIPE_MODE: 'test',
}));

jest.mock('../../models/Order', () => ({
  deleteOne: mockOrderDeleteOne,
}));

jest.mock('../../services/orderInventoryService', () => ({
  commitOrderInventory: jest.fn(),
  restoreOrderInventory: mockRestoreOrderInventory,
}));

jest.mock('../../services/stripePendingPaymentService', () => ({
  createPaymentExpiry: jest.fn(),
  closeOrderPaymentIntent: jest.fn(),
}));

const { _respondWithExistingCheckout } = require('../../controllers/orderController');

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
  awaitingPayment: true,
  isPaid: false,
  inventoryCommitted: true,
  stripeCustomerId: 'cus_123',
  stripeMode: 'test',
  stripePaymentIntentId: paymentFlow === 'payment_sheet' ? 'pi_123' : null,
  stripeSessionId: paymentFlow === 'checkout_session' ? 'cs_123' : null,
  orderItems: [],
  orderSummary: { totalAmount: 10, shippingCost: 0, tax: 0 },
  currency: 'USD',
});

describe('Stripe checkout idempotency recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRestoreOrderInventory.mockResolvedValue({});
    mockOrderDeleteOne.mockResolvedValue({ deletedCount: 1 });
  });

  test.each([
    ['PaymentIntent', 'payment_sheet', mockPaymentIntentRetrieve],
    ['Checkout Session', 'checkout_session', mockCheckoutSessionRetrieve],
  ])('closes a reserved order when its Stripe %s is definitively missing', async (_label, flow, retrieve) => {
    retrieve.mockRejectedValue(Object.assign(new Error('No such Stripe resource'), {
      code: 'resource_missing',
    }));
    const res = response();

    await _respondWithExistingCheckout(res, pendingOrder(flow));

    expect(mockRestoreOrderInventory).toHaveBeenCalledWith('order_mongo_123');
    expect(mockOrderDeleteOne).toHaveBeenCalledWith({
      _id: 'order_mongo_123',
      isPaid: false,
      awaitingPayment: true,
    });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'CHECKOUT_ATTEMPT_EXPIRED',
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
    expect(mockOrderDeleteOne).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING',
    }));
  });
});
