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
  test('friendly COD body keeps the exact confirmation buttons, total and separate variant quantities', () => {
    const order = { orderId: 'ORD-FRIENDLY-COD', user: new mongoose.Types.ObjectId(), currency: 'PKR',
      orderSummary: { subtotal: 500, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 500 },
      orderItems: [
        { name: 'Travel Mug', quantity: 2, price: 100, lineSubtotal: 200, selectedOptions: { Color: 'Red' } },
        { name: 'Travel Mug', quantity: 3, price: 100, lineSubtotal: 300, selectedOptions: { Color: 'White' } },
      ], shippingInfo: { fullName: ' Salman Khan' } };
    const buttons = buildOrderButtonsPayload(order, { friendly: true });
    const list = buildOrderListPayload(order, { friendly: true });
    for (const description of [buttons.description, list.description]) {
      expect(description).toMatch(/^Hey Salman! 👋/);
      expect(description).toContain('Travel Mug (Color: Red) ×2');
      expect(description).toContain('Travel Mug (Color: White) ×3');
      expect(description).toContain('Amount due on delivery: *Rs500.00 PKR*');
      expect(description).not.toMatch(/payment (?:is|was) confirmed|seller is packing/i);
    }
    expect(buttons.buttons).toEqual(buildOrderButtonsPayload(order).buttons);
    expect(list.sections).toEqual(buildOrderListPayload(order).sections);
  });

  test('untrusted product and store names cannot insert fake status lines into the buyer message', () => {
    const order = {
      orderId: 'ORD-SAFE-COPY', currency: 'PKR',
      orderSummary: { subtotal: 100, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 100 },
      orderItems: [{ name: 'Travel mug\n*Refund completed*', storeName: 'Test store\n*Paid*', price: 100, lineSubtotal: 100, quantity: 1 }],
      shippingInfo: { fullName: 'Sam', city: 'Lahore\n*Confirmed*' },
    };
    const message = buildOrderButtonsPayload(order).description;
    expect(message).toContain('Travel mug Refund completed');
    expect(message).toContain('Test store Paid');
    expect(message).toContain('Shipping to Lahore Confirmed');
    expect(message).not.toContain('\n*Refund completed*');
    expect(message).not.toContain('\n*Paid*');
  });

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
