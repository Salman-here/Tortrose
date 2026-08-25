'use strict';

jest.mock('../../controllers/mailController', () => ({
  sendEmail: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../utils/expoPush', () => ({
  sendPushToUser: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../services/whatsapp/sellerNotificationService', () => ({
  notifySeller: jest.fn(() => Promise.resolve()),
}));

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Order = require('../../models/Order');
const NotificationOutbox = require('../../models/NotificationOutbox');
const {
  confirmOrder,
  declineOrder,
  getConfirmationDetails,
} = require('../../controllers/orderConfirmationController');

let replSet;

const sellerId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();

const createOrder = ({
  suffix,
  paymentMethod = 'cash_on_delivery',
  orderStatus = 'pending',
  inventoryCommitted = true,
  confirmation = {},
}) => Order.create({
  orderId: `CONFIRM-CONTROLLER-${suffix}`,
  user: userId,
  orderItems: [{
    productId: new mongoose.Types.ObjectId(),
    seller: sellerId,
    name: 'Buyer confirmation controller fixture',
    image: 'https://example.com/confirmation.jpg',
    price: 100,
    quantity: 1,
  }],
  shippingInfo: {
    fullName: 'Confirmation Buyer',
    email: 'confirmation@example.com',
    phone: '+14155552671',
    address: '1 Confirmation Road',
    city: 'Test City',
    state: 'Test State',
    postalCode: '10000',
    country: 'United States',
  },
  shippingMethod: { name: 'Standard', price: 0, estimatedDays: 3 },
  orderSummary: { subtotal: 100, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 100 },
  sellerSettlementVersion: 1,
  sellerSettlement: [{
    seller: sellerId,
    sourceCurrency: 'USD',
    sourceAmountMinor: 10000,
    amountUSDMinor: 10000,
  }],
  currency: 'USD',
  paymentMethod,
  paymentFlow: paymentMethod === 'stripe' ? 'checkout_session' : 'checkout_session',
  paymentSetupState: paymentMethod === 'stripe' ? 'ready' : 'closed',
  awaitingPayment: paymentMethod === 'stripe',
  isPaid: false,
  orderStatus,
  inventoryCommitted,
  sellerFulfillment: [{ seller: sellerId, status: orderStatus }],
  confirmation: {
    token: `confirmation-controller-token-${suffix}-1234567890`,
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...confirmation,
  },
});

const responseDouble = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(payload => payload);
  return res;
};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await mongoose.connect(replSet.getUri());
  await NotificationOutbox.syncIndexes();
}, 60000);

afterEach(async () => {
  await Order.deleteMany({});
  await NotificationOutbox.deleteMany({});
  jest.clearAllMocks();
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 60000);

describe('email COD confirmation controller', () => {
  test('confirms the decision and all seller fulfillment in the shared transaction', async () => {
    const order = await createOrder({ suffix: 'SUCCESS' });
    const res = responseDouble();

    await confirmOrder({ params: { token: order.confirmation.token } }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ msg: 'Order confirmed' }));
    const persisted = await Order.findById(order._id).lean();
    expect(persisted).toMatchObject({
      orderStatus: 'confirmed',
      inventoryCommitted: true,
      isPaid: false,
    });
    expect(persisted.sellerFulfillment[0].status).toBe('confirmed');
    expect(persisted.confirmation.confirmedVia).toBe('email');
    expect(persisted.confirmation.decidedVia).toBe('email');
  });

  test('public confirmation payload preserves an authoritative zero line subtotal', async () => {
    const order = await createOrder({ suffix: 'ZERO-LINE-SUBTOTAL' });
    await Order.updateOne(
      { _id: order._id },
      { $set: { 'orderItems.0.lineSubtotal': 0 } },
    );
    const res = responseDouble();

    await confirmOrder({ params: { token: order.confirmation.token } }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      order: expect.objectContaining({
        orderItems: [expect.objectContaining({ lineSubtotal: 0 })],
      }),
    }));
  });

  test.each([
    ['unsupported stored currency', { currency: 'CAD' }],
    ['blank stored currency', { currency: '' }],
    ['sub-cent stored total', { 'orderSummary.totalAmount': 100.001 }],
    ['non-reconciling stored total', { 'orderSummary.totalAmount': 99.99 }],
  ])('public confirmation fails closed for %s', async (_label, mutation) => {
    const order = await createOrder({ suffix: `CORRUPT-${Date.now()}-${Math.random()}` });
    await Order.collection.updateOne({ _id: order._id }, { $set: mutation });
    const res = responseDouble();

    await getConfirmationDetails({ params: { token: order.confirmation.token } }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'ORDER_PRESENTATION_DATA_INVALID',
    }));
  });

  test('concurrent email confirmation replays notify the seller only once', async () => {
    const order = await createOrder({ suffix: 'NOTIFICATION-DEDUPE' });
    const firstResponse = responseDouble();
    const replayResponse = responseDouble();

    await Promise.all([
      confirmOrder({ params: { token: order.confirmation.token } }, firstResponse),
      confirmOrder({ params: { token: order.confirmation.token } }, replayResponse),
    ]);

    expect(firstResponse.status).toHaveBeenCalledWith(200);
    expect(replayResponse.status).toHaveBeenCalledWith(200);
    const outbox = await NotificationOutbox.find({ eventType: 'order.confirmed' }).lean();
    expect(outbox).toHaveLength(4);
    expect(new Set(outbox.map(record => record.eventKey)).size).toBe(1);
    expect(outbox.every(record => record.financial)).toBe(true);
    expect(outbox.every(record => record.money[0].amountMinor === 10000)).toBe(true);
  });

  test('does not regress an order that entered processing between notification and click', async () => {
    const order = await createOrder({ suffix: 'PROCESSING', orderStatus: 'processing' });
    const res = responseDouble();

    await confirmOrder({ params: { token: order.confirmation.token } }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'ORDER_FULFILLMENT_STARTED',
    }));
    const persisted = await Order.findById(order._id).lean();
    expect(persisted.orderStatus).toBe('processing');
    expect(persisted.sellerFulfillment[0].status).toBe('processing');
    expect(persisted.confirmation.confirmedAt).toBeNull();
    expect(persisted.isPaid).toBe(false);
  });

  test('cannot use a confirmation token to activate an unpaid Stripe order', async () => {
    const order = await createOrder({
      suffix: 'UNPAID-STRIPE',
      paymentMethod: 'stripe',
      inventoryCommitted: false,
    });
    const res = responseDouble();

    await confirmOrder({ params: { token: order.confirmation.token } }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'ORDER_CONFIRMATION_NOT_REQUIRED',
    }));
    const persisted = await Order.findById(order._id).lean();
    expect(persisted).toMatchObject({
      orderStatus: 'pending',
      awaitingPayment: true,
      inventoryCommitted: false,
      isPaid: false,
    });
    expect(persisted.confirmation.confirmedAt).toBeNull();
  });

  test('cannot decline through an expired email token', async () => {
    const order = await createOrder({
      suffix: 'EXPIRED-DECLINE',
      confirmation: {
        tokenExpiresAt: new Date(Date.now() - 1000),
      },
    });
    const res = responseDouble();

    await declineOrder({ params: { token: order.confirmation.token } }, res);

    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'ORDER_CONFIRMATION_EXPIRED',
    }));
    const persisted = await Order.findById(order._id).lean();
    expect(persisted.orderStatus).toBe('pending');
    expect(persisted.inventoryCommitted).toBe(true);
    expect(persisted.confirmation.declinedAt).toBeNull();
  });
});
