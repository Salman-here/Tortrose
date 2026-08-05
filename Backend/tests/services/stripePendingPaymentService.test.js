const mockRetrievePaymentIntent = jest.fn();
const mockCancelPaymentIntent = jest.fn();
const mockRestoreOrderInventory = jest.fn();
const mockValidateStripeOrderPaymentIntent = jest.fn();
const mockOrderFindOneAndUpdate = jest.fn();

jest.mock('../../config/stripe', () => ({
  stripe: {
    paymentIntents: {
      retrieve: mockRetrievePaymentIntent,
      cancel: mockCancelPaymentIntent,
    },
  },
}));

jest.mock('../../models/Order', () => ({
  findOneAndUpdate: mockOrderFindOneAndUpdate,
  find: jest.fn(),
}));

jest.mock('../../models/WalletTransaction', () => ({
  find: jest.fn(),
  updateOne: jest.fn(),
}));

jest.mock('../../services/orderInventoryService', () => ({
  restoreOrderInventory: mockRestoreOrderInventory,
}));

jest.mock('../../services/stripeOrderPaymentService', () => ({
  validateStripeOrderPaymentIntent: mockValidateStripeOrderPaymentIntent,
}));

jest.mock('../../services/walletService', () => ({
  cancelWalletTopUpFromPaymentIntent: jest.fn(),
  validateWalletTopUpPaymentIntent: jest.fn(),
}));

const { closeOrderPaymentIntent } = require('../../services/stripePendingPaymentService');

const pendingOrder = (overrides = {}) => ({
  _id: 'order_db_123',
  orderId: 'ORD-123',
  paymentFlow: 'payment_sheet',
  stripePaymentIntentId: 'pi_123',
  isPaid: false,
  awaitingPayment: true,
  orderStatus: 'pending',
  paymentProcessingStartedAt: null,
  inventoryCommitted: true,
  ...overrides,
});

describe('native order PaymentIntent immediate cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRestoreOrderInventory.mockResolvedValue({ alreadyRestored: false });
    mockValidateStripeOrderPaymentIntent.mockReturnValue(undefined);
  });

  test('cancels Stripe, releases inventory, and marks the order cancelled immediately', async () => {
    const order = pendingOrder();
    const pendingIntent = { id: 'pi_123', status: 'requires_payment_method' };
    const cancelledIntent = { id: 'pi_123', status: 'canceled' };
    const closedOrder = { ...order, orderStatus: 'cancelled', inventoryCommitted: false };
    mockRetrievePaymentIntent.mockResolvedValue(pendingIntent);
    mockCancelPaymentIntent.mockResolvedValue(cancelledIntent);
    mockOrderFindOneAndUpdate.mockResolvedValue(closedOrder);

    const result = await closeOrderPaymentIntent(order, {
      status: 'cancelled',
      reason: 'PaymentSheet initialization failed.',
    });

    expect(mockCancelPaymentIntent).toHaveBeenCalledWith('pi_123', {
      cancellation_reason: 'abandoned',
    });
    expect(mockValidateStripeOrderPaymentIntent).toHaveBeenCalledWith(order, cancelledIntent);
    expect(mockRestoreOrderInventory).toHaveBeenCalledWith(order._id);
    expect(mockOrderFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: order._id,
        isPaid: false,
        awaitingPayment: true,
        stripePaymentIntentId: 'pi_123',
      }),
      { $set: expect.objectContaining({
        orderStatus: 'cancelled',
        'paymentResult.failureCode': 'PAYMENT_CANCELLED',
        'paymentResult.failureMessage': 'PaymentSheet initialization failed.',
      }) },
      { new: true },
    );
    expect(result).toEqual(expect.objectContaining({
      status: 'cancelled',
      order: closedOrder,
      paymentIntent: cancelledIntent,
    }));
  });

  test('never releases inventory when Stripe already received the payment', async () => {
    const order = pendingOrder();
    const succeededIntent = { id: 'pi_123', status: 'succeeded' };
    mockRetrievePaymentIntent.mockResolvedValue(succeededIntent);

    const result = await closeOrderPaymentIntent(order);

    expect(result.status).toBe('payment_succeeded');
    expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
    expect(mockRestoreOrderInventory).not.toHaveBeenCalled();
    expect(mockOrderFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('retries an already-cancelled PaymentIntent through idempotent inventory restoration', async () => {
    const order = pendingOrder({ orderStatus: 'cancelled' });
    const cancelledIntent = { id: 'pi_123', status: 'canceled' };
    mockRetrievePaymentIntent.mockResolvedValue(cancelledIntent);
    mockRestoreOrderInventory.mockResolvedValue({ alreadyRestored: true });
    mockOrderFindOneAndUpdate.mockResolvedValue(order);

    const result = await closeOrderPaymentIntent(order);

    expect(mockCancelPaymentIntent).not.toHaveBeenCalled();
    expect(mockRestoreOrderInventory).toHaveBeenCalledWith(order._id);
    expect(result.status).toBe('cancelled');
  });
});
