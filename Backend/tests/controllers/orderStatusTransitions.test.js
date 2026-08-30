'use strict';

const mockOrderFindOne = jest.fn();
const mockOrderFindById = jest.fn();
const mockProductFind = jest.fn();
const mockCancelOrderSafely = jest.fn();
const mockTransitionOrderFulfillment = jest.fn();
const mockSendEmail = jest.fn();
const mockEnqueueTextNotification = jest.fn();

jest.mock('../../models/Order', () => ({
  findOne: mockOrderFindOne,
  findById: mockOrderFindById,
}));

jest.mock('../../models/Product', () => ({
  find: mockProductFind,
}));

jest.mock('../../services/orderCancellationService', () => ({
  cancelOrderSafely: mockCancelOrderSafely,
}));

jest.mock('../../services/orderStatusTransitionService', () => ({
  transitionOrderFulfillment: mockTransitionOrderFulfillment,
}));

jest.mock('../../controllers/mailController', () => ({
  sendEmail: mockSendEmail,
}));

jest.mock('../../services/whatsapp/queue', () => ({
  enqueueOrderConfirmation: jest.fn(),
  enqueueOrderPlacedInfo: jest.fn(),
  enqueueTextNotification: mockEnqueueTextNotification,
}));

jest.mock('../../utils/emailTemplates', () => ({
  orderConfirmationEmail: jest.fn(),
  orderStatusUpdateEmail: jest.fn().mockReturnValue({ subject: 'Status', text: 'Status changed' }),
  newOrderSellerEmail: jest.fn(),
  buyerOrderConfirmationRequestEmail: jest.fn(),
}));

const { cancelOrder, updateStatus } = require('../../controllers/orderController');

const sellerId = '64b000000000000000000001';
const otherSellerId = '64b000000000000000000002';

const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

const orderFixture = ({
  orderStatus = 'pending',
  paymentMethod = 'cash_on_delivery',
  awaitingPayment = false,
  isPaid = false,
  sellers = [sellerId],
} = {}) => {
  const order = {
    _id: '64c000000000000000000001',
    orderId: 'ORD-STATUS-1',
    orderStatus,
    paymentMethod,
    paymentFlow: paymentMethod === 'stripe' ? 'payment_sheet' : 'checkout_session',
    paymentSetupState: paymentMethod === 'stripe' ? 'ready' : 'closed',
    stripePaymentIntentId: paymentMethod === 'stripe' ? 'pi_status' : null,
    awaitingPayment,
    isPaid,
    isDelivered: orderStatus === 'delivered',
    inventoryCommitted: true,
    orderItems: sellers.map((seller, index) => ({
      productId: `64d00000000000000000000${index + 1}`,
      seller,
      name: `Seller ${index + 1} item`,
      quantity: 1,
      price: 10,
    })),
    sellerFulfillment: sellers.map(seller => ({
      seller,
      status: orderStatus,
      updatedAt: new Date(),
    })),
    confirmation: {},
    shippingInfo: { email: 'buyer@example.com' },
    save: jest.fn().mockResolvedValue(undefined),
  };
  return order;
};

const sellerProductsQuery = products => ({
  select: jest.fn().mockResolvedValue(products),
});

describe('order fulfillment transition boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendEmail.mockResolvedValue(undefined);
    mockEnqueueTextNotification.mockResolvedValue(undefined);
    mockProductFind.mockReturnValue(sellerProductsQuery([{ _id: '64d000000000000000000001' }]));
  });

  test('routes a single-seller seller cancellation through the shared atomic cancellation service', async () => {
    const order = orderFixture();
    const cancelledOrder = {
      ...order,
      orderStatus: 'cancelled',
      inventoryCommitted: false,
      sellerFulfillment: order.sellerFulfillment.map(entry => ({ ...entry, status: 'cancelled' })),
    };
    mockOrderFindOne.mockResolvedValue(order);
    mockCancelOrderSafely.mockResolvedValue({ status: 'cancelled', order: cancelledOrder });
    const res = response();

    await updateStatus({
      params: { id: order._id },
      body: { newStatus: 'cancelled' },
      user: { role: 'seller', id: sellerId },
    }, res);

    expect(mockCancelOrderSafely).toHaveBeenCalledWith(expect.objectContaining({
      orderId: order._id,
      reason: expect.stringContaining('Single-seller'),
    }));
    expect(order.save).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      orderStatus: 'cancelled',
      aggregateOrderStatus: 'cancelled',
    }));
  });

  test('an idempotent cancellation replay does not duplicate buyer notifications', async () => {
    const order = orderFixture();
    const cancelledOrder = {
      ...order,
      orderStatus: 'cancelled',
      inventoryCommitted: false,
      sellerFulfillment: order.sellerFulfillment.map(entry => ({ ...entry, status: 'cancelled' })),
    };
    mockOrderFindOne.mockResolvedValue(order);
    mockCancelOrderSafely.mockResolvedValue({
      status: 'cancelled',
      order: cancelledOrder,
      alreadyCancelled: true,
    });
    const res = response();

    await updateStatus({
      params: { id: order._id },
      body: { newStatus: 'cancelled' },
      user: { role: 'seller', id: sellerId },
    }, res);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockEnqueueTextNotification).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('the buyer/admin cancellation endpoint is also notification-idempotent', async () => {
    const order = orderFixture({ orderStatus: 'cancelled' });
    const cancelledOrder = {
      ...order,
      orderStatus: 'cancelled',
      inventoryCommitted: false,
      sellerFulfillment: order.sellerFulfillment.map(entry => ({ ...entry, status: 'cancelled' })),
    };
    mockOrderFindById.mockResolvedValue(order);
    mockCancelOrderSafely.mockResolvedValue({
      status: 'cancelled',
      order: cancelledOrder,
      alreadyCancelled: true,
    });
    const res = response();

    await cancelOrder({
      params: { id: order._id },
      user: { role: 'admin', id: 'admin_1' },
    }, res);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockEnqueueTextNotification).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      msg: 'Order was already cancelled.',
    }));
  });

  test('admin cancellation after email confirmation records the administrator instead of the buyer', async () => {
    const order = orderFixture({ orderStatus: 'confirmed' });
    order.confirmation = {
      confirmedAt: new Date('2026-08-30T10:00:00.000Z'),
      confirmedVia: 'email',
      decidedAt: new Date('2026-08-30T10:00:00.000Z'),
      decidedVia: 'email',
    };
    mockOrderFindById.mockResolvedValue(order);
    mockCancelOrderSafely.mockResolvedValue({
      status: 'cancelled',
      order: { ...order, orderStatus: 'cancelled' },
      alreadyCancelled: false,
    });
    const res = response();

    await cancelOrder({
      params: { id: order._id },
      user: { role: 'admin', id: 'admin_1' },
    }, res);

    expect(mockCancelOrderSafely).toHaveBeenCalledWith(expect.objectContaining({
      cancellationActorRole: 'admin',
      confirmationFields: expect.objectContaining({
        cancelledVia: 'admin',
        cancelledFromDashboardNote: expect.stringContaining('administrator'),
      }),
    }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('rejects partial seller cancellation of a multi-seller order before any mutation', async () => {
    const order = orderFixture({ sellers: [sellerId, otherSellerId] });
    mockOrderFindOne.mockResolvedValue(order);
    const res = response();

    await updateStatus({
      params: { id: order._id },
      body: { newStatus: 'cancelled' },
      user: { role: 'seller', id: sellerId },
    }, res);

    expect(mockCancelOrderSafely).not.toHaveBeenCalled();
    expect(order.save).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PARTIAL_ORDER_CANCELLATION_UNSUPPORTED',
      currentStatus: 'pending',
    }));
  });

  test('routes admin cancellation of an awaiting Stripe order through Stripe-safe cancellation and surfaces captured payment', async () => {
    const order = orderFixture({ paymentMethod: 'stripe', awaitingPayment: true });
    mockOrderFindOne.mockResolvedValue(order);
    mockCancelOrderSafely.mockResolvedValue({ status: 'payment_succeeded', order });
    const res = response();

    await updateStatus({
      params: { id: order._id },
      body: { newStatus: 'cancelled' },
      user: { role: 'admin', id: 'admin_1' },
    }, res);

    expect(mockCancelOrderSafely).toHaveBeenCalledTimes(1);
    expect(order.save).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PAYMENT_ALREADY_SUCCEEDED',
      currentStatus: 'pending',
    }));
  });

  test('does not allow a delivered order to regress and rewrite delivery-based revenue state', async () => {
    const order = orderFixture({ orderStatus: 'delivered', isPaid: true });
    mockOrderFindOne.mockResolvedValue(order);
    mockTransitionOrderFulfillment.mockRejectedValue(Object.assign(
      new Error('Order status cannot move from delivered to processing.'),
      {
        statusCode: 409,
        code: 'ORDER_STATUS_TRANSITION_INVALID',
        currentStatus: 'delivered',
      },
    ));
    const res = response();

    await updateStatus({
      params: { id: order._id },
      body: { newStatus: 'processing' },
      user: { role: 'admin', id: 'admin_1' },
    }, res);

    expect(order.save).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'ORDER_STATUS_TRANSITION_INVALID',
      currentStatus: 'delivered',
    }));
  });

  test('does not resurrect a cancelled order through the generic status endpoint', async () => {
    const order = orderFixture({ orderStatus: 'cancelled' });
    mockOrderFindOne.mockResolvedValue(order);
    mockTransitionOrderFulfillment.mockRejectedValue(Object.assign(
      new Error('Order status cannot move from cancelled to confirmed.'),
      {
        statusCode: 409,
        code: 'ORDER_STATUS_TRANSITION_INVALID',
        currentStatus: 'cancelled',
      },
    ));
    const res = response();

    await updateStatus({
      params: { id: order._id },
      body: { newStatus: 'confirmed' },
      user: { role: 'admin', id: 'admin_1' },
    }, res);

    expect(mockCancelOrderSafely).not.toHaveBeenCalled();
    expect(order.save).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'ORDER_STATUS_TRANSITION_INVALID',
      currentStatus: 'cancelled',
    }));
  });

  test('keeps forward skipped transitions available for existing fulfillment UI flows', async () => {
    const order = orderFixture({ orderStatus: 'pending' });
    mockOrderFindOne.mockResolvedValue(order);
    const transitioned = {
      ...order,
      orderStatus: 'shipped',
      sellerFulfillment: order.sellerFulfillment.map(entry => ({ ...entry, status: 'shipped' })),
    };
    mockTransitionOrderFulfillment.mockResolvedValue({
      order: transitioned,
      transition: {
        actorStatusChanged: true,
        aggregateStatusChanged: true,
      },
    });
    const res = response();

    await updateStatus({
      params: { id: order._id },
      body: { newStatus: 'shipped' },
      user: { role: 'admin', id: 'admin_1' },
    }, res);

    expect(order.save).not.toHaveBeenCalled();
    expect(mockTransitionOrderFulfillment).toHaveBeenCalledWith({
      orderId: order._id,
      actorRole: 'admin',
      actorId: 'admin_1',
      sellerIds: [sellerId],
      newStatus: 'shipped',
    });
    // The transaction service owns the durable all-channel event. The HTTP
    // controller must not perform a second lossy provider fan-out.
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockEnqueueTextNotification).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('an idempotent fulfillment replay does not resend buyer status notifications', async () => {
    const order = orderFixture({ orderStatus: 'processing' });
    mockOrderFindOne.mockResolvedValue(order);
    mockTransitionOrderFulfillment.mockResolvedValue({
      order,
      transition: {
        actorStatusChanged: false,
        aggregateStatusChanged: false,
      },
    });
    const res = response();

    await updateStatus({
      params: { id: order._id },
      body: { newStatus: 'processing' },
      user: { role: 'admin', id: 'admin_1' },
    }, res);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockEnqueueTextNotification).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('cannot advance an awaiting unpaid Stripe order through the admin endpoint', async () => {
    const order = orderFixture({ paymentMethod: 'stripe', awaitingPayment: true, isPaid: false });
    mockOrderFindOne.mockResolvedValue(order);
    mockTransitionOrderFulfillment.mockRejectedValue(Object.assign(
      new Error('Payment must be confirmed before this order can enter fulfillment.'),
      {
        statusCode: 409,
        code: 'ORDER_PAYMENT_NOT_CONFIRMED',
        currentStatus: 'pending',
      },
    ));
    const res = response();

    await updateStatus({
      params: { id: order._id },
      body: { newStatus: 'delivered' },
      user: { role: 'admin', id: 'admin_1' },
    }, res);

    expect(order.save).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'ORDER_PAYMENT_NOT_CONFIRMED',
      currentStatus: 'pending',
    }));
  });
});
