'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const WhatsAppPendingMessage = require('../../models/WhatsAppPendingMessage');
const {
  buildOrderButtonsPayload,
  buildOrderListPayload,
} = require('../../services/whatsapp/messageBuilder');
const { enqueueOrderConfirmation } = require('../../services/whatsapp/queue');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await WhatsAppPendingMessage.init();
}, 60000);

afterEach(async () => {
  await WhatsAppPendingMessage.deleteMany({});
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60000);

describe('interactive COD WhatsApp queue snapshots', () => {
  test('queue retries keep the first frozen financial payload after Order mutation', async () => {
    const order = {
      _id: new mongoose.Types.ObjectId(),
      orderId: 'ORD-FROZEN-WA',
      currency: 'PKR',
      orderSummary: {
        subtotal: 1880,
        shippingCost: 0,
        tax: 0,
        couponDiscount: 0,
        totalAmount: 1880,
      },
      orderItems: [{
        name: 'Frozen item',
        price: 1880,
        lineSubtotal: 1880,
        quantity: 1,
      }],
      shippingInfo: {
        phone: '+92 300 1234567',
        fullName: 'Snapshot Buyer',
        city: 'Lahore',
      },
      confirmation: { token: 'a'.repeat(64) },
    };
    const firstButtons = JSON.stringify(buildOrderButtonsPayload(order));
    const firstList = JSON.stringify(buildOrderListPayload(order));
    const first = await enqueueOrderConfirmation(order, {
      buttonsPayloadJson: firstButtons,
      listPayloadJson: firstList,
    });

    order.orderSummary.totalAmount = 9999;
    expect(() => buildOrderButtonsPayload(order)).toThrow(expect.objectContaining({
      code: 'ORDER_PRESENTATION_DATA_INVALID',
      statusCode: 409,
    }));
    const replay = await enqueueOrderConfirmation(order, {
      // Delivery retries replay the already-frozen outbox snapshot; they must
      // never regenerate financial copy from a subsequently changed Order.
      buttonsPayloadJson: firstButtons,
      listPayloadJson: firstList,
    });

    expect(String(replay._id)).toBe(String(first._id));
    const stored = await WhatsAppPendingMessage.findById(first._id).lean();
    expect(stored.interactiveButtonsPayloadJson).toContain('Rs1,880.00 PKR');
    expect(stored.interactiveListPayloadJson).toContain('Rs1,880.00 PKR');
    expect(stored.interactiveButtonsPayloadJson).not.toContain('Rs9,999.00 PKR');
    expect(stored.interactiveListPayloadJson).not.toContain('Rs9,999.00 PKR');
  });
});
