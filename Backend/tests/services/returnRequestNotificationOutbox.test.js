'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const NotificationOutbox = require('../../models/NotificationOutbox');
const WhatsAppPendingMessage = require('../../models/WhatsAppPendingMessage');
const {
  notifyBuyerReturnStatus,
  notifySellerReturnRequested,
} = require('../../services/returnNotificationService');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([
    NotificationOutbox.init(),
    WhatsAppPendingMessage.init(),
  ]);
}, 60000);

afterEach(async () => {
  await Promise.all([
    NotificationOutbox.deleteMany({}),
    WhatsAppPendingMessage.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60000);

describe('seller return-request notifications', () => {
  test('persists one replay-safe seller event for email, in-app, push, and seller WhatsApp', async () => {
    const seller = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    const returnId = new mongoose.Types.ObjectId();
    const requestedAt = new Date('2026-08-24T10:00:00.000Z');
    const request = {
      _id: returnId,
      seller,
      order: orderId,
      returnNumber: 'RET-1001',
      orderId: 'ORD-1001',
      reasonDetails: 'The delivered product was damaged.',
      requestedAt,
    };
    const order = {
      _id: orderId,
      shippingInfo: { fullName: 'Buyer One' },
    };

    await expect(notifySellerReturnRequested(request, order)).resolves.toBe(true);
    const first = await NotificationOutbox.find({})
      .select('+recipient.email +recipient.phone')
      .sort({ channel: 1 })
      .lean();
    expect(first).toHaveLength(4);
    expect(first.map(record => record.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    for (const record of first) {
      expect(record).toEqual(expect.objectContaining({
        eventType: 'return.requested',
        aggregateType: 'ReturnRequest',
        aggregateId: String(returnId),
        occurredAt: requestedAt,
        financial: false,
      }));
      expect(record.recipient).toEqual(expect.objectContaining({
        kind: 'user',
        audienceRole: 'seller',
        user: seller,
        destinationPolicy: 'current_user',
      }));
      expect(record.payload.data).toEqual({
        type: 'return_requested',
        returnRequestId: String(returnId),
        orderId: String(orderId),
      });
    }
    const whatsapp = first.find(record => record.channel === 'whatsapp');
    expect(whatsapp.payload.whatsappCategory).toBe('return_request');
    expect(whatsapp.payload.message).toContain('Return: #RET-1001');
    expect(whatsapp.payload.message).toContain('Buyer reason: The delivered product was damaged.');
    const email = first.find(record => record.channel === 'email');
    expect(email.payload.subject).toBe('New return request for order #ORD-1001');
    expect(email.payload.text).toContain('The delivered product was damaged.');
    expect(await WhatsAppPendingMessage.countDocuments()).toBe(0);

    await expect(notifySellerReturnRequested(request, order)).resolves.toBe(true);
    const replay = await NotificationOutbox.find({})
      .select('+recipient.email +recipient.phone')
      .sort({ channel: 1 })
      .lean();
    expect(replay).toHaveLength(4);
    expect(replay.map(record => String(record._id)))
      .toEqual(first.map(record => String(record._id)));
  });
});

describe('buyer return-status notifications', () => {
  test('persists one replay-safe non-financial event for email, in-app, push, and buyer WhatsApp', async () => {
    const buyer = new mongoose.Types.ObjectId();
    const seller = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    const returnId = new mongoose.Types.ObjectId();
    const changedAt = new Date('2026-08-24T11:00:00.000Z');
    const request = {
      _id: returnId,
      buyer,
      seller,
      order: orderId,
      returnNumber: 'RET-2001',
      orderId: 'ORD-2001',
      status: 'approved',
      statusHistory: [{ status: 'approved', changedAt }],
      // Non-settlement status notifications must not render this amount.
      currency: 'PKR',
      refund: { totalAmount: 1880 },
      createdAt: new Date('2026-08-24T10:00:00.000Z'),
    };
    const order = {
      _id: orderId,
      user: buyer,
      shippingInfo: {
        phone: '+92 300 1234567',
        email: 'buyer-return@example.com',
      },
    };

    await expect(notifyBuyerReturnStatus(request, order, 'Send the item back.'))
      .resolves.toBe(true);
    const first = await NotificationOutbox.find({})
      .select('+recipient.email +recipient.phone')
      .sort({ channel: 1 })
      .lean();
    expect(first).toHaveLength(4);
    expect(first.map(record => record.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    for (const record of first) {
      expect(record).toEqual(expect.objectContaining({
        eventType: 'return.status_updated',
        aggregateType: 'ReturnRequest',
        aggregateId: String(returnId),
        occurredAt: changedAt,
        financial: false,
      }));
      expect(record.recipient).toEqual(expect.objectContaining({
        kind: 'user',
        audienceRole: 'buyer',
        user: buyer,
        destinationPolicy: 'event_snapshot',
        email: 'buyer-return@example.com',
        phone: '923001234567',
      }));
      expect(record.money).toEqual([]);
      expect(JSON.stringify(record.payload)).not.toContain('1880');
      expect(record.payload.relatedOrder).toEqual(orderId);
      expect(record.payload.data).toEqual({
        type: 'return_status_update',
        returnRequestId: String(returnId),
        orderId: String(orderId),
        status: 'approved',
      });
    }
    expect(first.find(record => record.channel === 'whatsapp').payload.message)
      .toContain('Note: Send the item back.');

    await expect(notifyBuyerReturnStatus(request, order, 'Send the item back.'))
      .resolves.toBe(true);
    const replay = await NotificationOutbox.find({})
      .select('+recipient.email +recipient.phone')
      .sort({ channel: 1 })
      .lean();
    expect(replay).toHaveLength(4);
    expect(replay.map(record => String(record._id)))
      .toEqual(first.map(record => String(record._id)));
  });

  test('keeps in-app and push durable when the order has no valid WhatsApp snapshot', async () => {
    const buyer = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    const request = {
      _id: new mongoose.Types.ObjectId(),
      buyer,
      order: orderId,
      returnNumber: 'RET-2002',
      orderId: 'ORD-2002',
      status: 'in_transit',
      statusHistory: [{
        status: 'in_transit',
        changedAt: new Date('2026-08-24T12:00:00.000Z'),
      }],
      createdAt: new Date('2026-08-24T10:00:00.000Z'),
    };

    await expect(notifyBuyerReturnStatus(request, {
      _id: orderId,
      user: buyer,
      shippingInfo: { phone: 'invalid' },
    })).resolves.toBe(true);
    const rows = await NotificationOutbox.find({}).lean();
    expect(rows.map(row => row.channel).sort()).toEqual(['inapp', 'push']);
  });
});
