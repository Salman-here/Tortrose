'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Order = require('../../models/Order');
const OrderPublicIdCounter = require('../../models/OrderPublicIdCounter');
const {
  SHORT_ORDER_ID_PATTERN,
  nextShortOrderId,
} = require('../../services/orderPublicIdService');

describe('compact public order-id allocation', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Order.syncIndexes();
  }, 60000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  }, 60000);

  beforeEach(async () => {
    await Promise.all([
      Order.collection.deleteMany({}),
      OrderPublicIdCounter.deleteMany({}),
    ]);
  });

  test('allocates unique 13-digit ids across concurrent callers sharing one millisecond', async () => {
    const now = new Date('2026-08-30T10:00:00.123Z');
    const ids = await Promise.all(
      Array.from({ length: 100 }, () => nextShortOrderId({ now })),
    );
    expect(new Set(ids).size).toBe(100);
    expect(ids.every(id => SHORT_ORDER_ID_PATTERN.test(id))).toBe(true);
    const values = ids.map(id => Number(id.slice(4))).sort((a, b) => a - b);
    expect(values[0]).toBe(now.getTime());
    expect(values.at(-1)).toBe(now.getTime() + 99);
  });

  test('skips an existing historical id and persists version-3 uniqueness', async () => {
    const now = new Date('2026-08-30T11:00:00.000Z');
    const historicalId = `ORD-${now.getTime()}`;
    await Order.collection.insertOne({ orderId: historicalId });

    const allocated = await nextShortOrderId({ now });
    expect(allocated).toBe(`ORD-${now.getTime() + 1}`);
    await Order.collection.insertOne({ orderId: allocated, orderIdVersion: 3 });
    await expect(Order.collection.insertOne({ orderId: allocated, orderIdVersion: 3 }))
      .rejects.toMatchObject({ code: 11000 });
  });

  test('versioned model validation distinguishes long version-2 and compact version-3 ids', async () => {
    const base = {
      orderItems: [],
      shippingInfo: {
        fullName: 'Validation Buyer',
        email: 'validation@example.com',
        phone: '+14155552671',
        address: '1 Test Road',
        city: 'Test',
        state: 'Test',
        postalCode: '10000',
        country: 'United States',
      },
      shippingMethod: { name: 'Standard', price: 0, estimatedDays: 3 },
      orderSummary: { subtotal: 0, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 0 },
    };
    await expect(new Order({ ...base, orderId: 'ORD-1788027012731', orderIdVersion: 3 }).validate())
      .resolves.toBeUndefined();
    await expect(new Order({ ...base, orderId: 'ORD-1788027012731-AABBCC', orderIdVersion: 3 }).validate())
      .rejects.toThrow(/public order id format/i);
  });
});
