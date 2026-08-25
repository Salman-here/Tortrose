'use strict';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const NotificationOutbox = require('../../models/NotificationOutbox');
const Order = require('../../models/Order');
const ReturnRequest = require('../../models/ReturnRequest');
const {
  approveReplacement,
  cancelReturnRequest,
  updateReturnStatus,
} = require('../../services/returnService');
const {
  enqueueReturnCancellationNotifications,
} = require('../../services/returnNotificationService');

let replSet;

const createFixture = async () => {
  const buyer = new mongoose.Types.ObjectId();
  const seller = new mongoose.Types.ObjectId();
  const orderId = new mongoose.Types.ObjectId();
  const orderItemId = new mongoose.Types.ObjectId();
  const productId = new mongoose.Types.ObjectId();
  await Order.collection.insertOne({
    _id: orderId,
    orderId: `ORD-CANCEL-${orderId}`,
    user: buyer,
    shippingInfo: {
      fullName: 'Cancellation Buyer',
      email: 'cancellation-buyer@example.com',
      phone: '+92 300 1234567',
    },
  });
  const request = await ReturnRequest.create({
    returnNumber: `RET-CANCEL-${new mongoose.Types.ObjectId()}`,
    order: orderId,
    orderId: `ORD-CANCEL-${orderId}`,
    buyer,
    seller,
    currency: 'PKR',
    items: [{
      orderItemId,
      productId,
      name: 'Cancelled return item',
      quantity: 1,
      purchasedQuantity: 1,
      unitPrice: 1880,
      lineSubtotal: 1880,
    }],
    reasonCategory: 'damaged',
    reasonDetails: 'The delivered item arrived with visible damage.',
    status: 'requested',
    statusHistory: [{
      status: 'requested',
      actorRole: 'buyer',
      changedBy: buyer,
      changedAt: new Date('2026-08-24T10:00:00.000Z'),
    }],
    eligibilityDeadline: new Date('2026-09-24T10:00:00.000Z'),
    policySnapshot: {
      returnsEnabled: true,
      returnDuration: 30,
      refundType: 'full_refund',
    },
    refund: {
      itemSubtotal: 1880,
      taxAmount: 0,
      shippingAmount: 0,
      discountAmount: 0,
      totalAmount: 1880,
    },
  });
  return {
    buyer,
    seller,
    order: await Order.findById(orderId).lean(),
    request,
  };
};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());
  await Promise.all([
    NotificationOutbox.init(),
    ReturnRequest.init(),
  ]);
}, 120000);

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all([
    NotificationOutbox.deleteMany({}),
    Order.deleteMany({}),
    ReturnRequest.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 120000);

describe('buyer cancellation notification transaction', () => {
  test('an outbox failure rolls back cancellation, then a retry commits every channel once', async () => {
    const { buyer, request, order } = await createFixture();
    jest.spyOn(NotificationOutbox.collection, 'findOneAndUpdate')
      .mockRejectedValueOnce(new Error('simulated outbox write failure'));

    await expect(cancelReturnRequest({
      returnRequestId: request._id,
      buyerId: buyer,
      note: 'I no longer need to return this item.',
    })).rejects.toThrow('simulated outbox write failure');

    let stored = await ReturnRequest.findById(request._id).lean();
    expect(stored.status).toBe('requested');
    expect(stored.statusHistory).toHaveLength(1);
    expect(await NotificationOutbox.countDocuments()).toBe(0);

    jest.restoreAllMocks();
    const cancelled = await cancelReturnRequest({
      returnRequestId: request._id,
      buyerId: buyer,
      note: 'I no longer need to return this item.',
    });
    expect(cancelled.status).toBe('cancelled_by_buyer');
    stored = await ReturnRequest.findById(request._id).lean();
    expect(stored.status).toBe('cancelled_by_buyer');
    expect(stored.statusHistory).toHaveLength(2);

    const rows = await NotificationOutbox.find({})
      .select('+recipient.email +recipient.phone')
      .sort({ 'recipient.audienceRole': 1, channel: 1 })
      .lean();
    expect(rows).toHaveLength(8);
    const buyerRows = rows.filter(row => row.recipient.audienceRole === 'buyer');
    const sellerRows = rows.filter(row => row.recipient.audienceRole === 'seller');
    expect(buyerRows.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(sellerRows.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(buyerRows.every(row => row.recipient.user.equals(buyer))).toBe(true);
    expect(sellerRows.every(row => row.recipient.user.equals(request.seller))).toBe(true);
    expect(buyerRows.every(row => row.recipient.destinationPolicy === 'event_snapshot')).toBe(true);
    expect(sellerRows.every(row => row.recipient.destinationPolicy === 'current_user')).toBe(true);
    for (const row of rows) {
      expect(row.eventType).toBe('return.cancelled');
      expect(row.financial).toBe(false);
      expect(row.money).toEqual([]);
      expect(JSON.stringify(row.payload)).not.toContain('1880');
    }
    expect(buyerRows.find(row => row.channel === 'email').recipient.email)
      .toBe('cancellation-buyer@example.com');
    expect(buyerRows.find(row => row.channel === 'whatsapp').recipient.phone)
      .toBe('923001234567');

    const firstIds = rows.map(row => String(row._id)).sort();
    await enqueueReturnCancellationNotifications(cancelled, order);
    const replayRows = await NotificationOutbox.find({}).lean();
    expect(replayRows).toHaveLength(8);
    expect(replayRows.map(row => String(row._id)).sort()).toEqual(firstIds);
  });

  test('preserves the existing conflict semantics after a cancellation commits', async () => {
    const { buyer, request } = await createFixture();
    await cancelReturnRequest({
      returnRequestId: request._id,
      buyerId: buyer,
      note: '',
    });

    await expect(cancelReturnRequest({
      returnRequestId: request._id,
      buyerId: buyer,
      note: '',
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(await NotificationOutbox.countDocuments()).toBe(8);
  });
});

describe('seller return-status notification transaction', () => {
  test('rolls a status transition back when its buyer notification cannot be persisted', async () => {
    const { seller, request } = await createFixture();
    jest.spyOn(NotificationOutbox.collection, 'findOneAndUpdate')
      .mockRejectedValueOnce(new Error('simulated status outbox failure'));

    await expect(updateReturnStatus({
      returnRequestId: request._id,
      actor: { id: seller, role: 'seller' },
      nextStatus: 'approved',
      note: 'The request is approved.',
    })).rejects.toThrow('simulated status outbox failure');
    let stored = await ReturnRequest.findById(request._id).lean();
    expect(stored.status).toBe('requested');
    expect(stored.statusHistory).toHaveLength(1);
    expect(await NotificationOutbox.countDocuments()).toBe(0);

    jest.restoreAllMocks();
    const approved = await updateReturnStatus({
      returnRequestId: request._id,
      actor: { id: seller, role: 'seller' },
      nextStatus: 'approved',
      note: 'The request is approved.',
    });
    expect(approved.status).toBe('approved');
    stored = await ReturnRequest.findById(request._id).lean();
    expect(stored.status).toBe('approved');
    const rows = await NotificationOutbox.find({}).lean();
    expect(rows).toHaveLength(4);
    expect(rows.every(row => row.recipient.audienceRole === 'buyer')).toBe(true);
    expect(rows.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(rows.every(row => row.financial === false && row.money.length === 0)).toBe(true);
  });

  test('replacement approval and its buyer channels commit together', async () => {
    const { seller, request } = await createFixture();
    request.status = 'under_review';
    request.statusHistory.push({
      status: 'under_review',
      actorRole: 'seller',
      changedBy: seller,
    });
    await request.save();

    const approved = await approveReplacement({
      returnRequestId: request._id,
      sellerId: seller,
    });
    expect(approved.status).toBe('replacement_approved');
    const rows = await NotificationOutbox.find({}).lean();
    expect(rows).toHaveLength(4);
    expect(rows.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(rows.every(row => row.eventType === 'return.status_updated')).toBe(true);
    expect(rows.every(row => JSON.stringify(row.payload).includes('1880') === false)).toBe(true);
  });
});
