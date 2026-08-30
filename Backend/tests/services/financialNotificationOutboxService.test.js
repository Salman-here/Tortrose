'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const NotificationOutbox = require('../../models/NotificationOutbox');
const {
  enqueueCodOrderBuyerConfirmationNotification,
  enqueueCodOrderDecisionSellerNotifications,
  enqueueCodOrderSellerNotifications,
  enqueueNoChargeOrderBuyerNotifications,
  enqueueNoChargeOrderSellerNotifications,
  enqueueOrderLifecycleBuyerNotifications,
  enqueueOrderSellerFulfillmentBuyerNotifications,
  enqueueOrderStockRefundBuyerNotifications,
  enqueuePaidOrderBuyerNotifications,
  enqueuePaidOrderSellerNotifications,
  enqueueReturnSettlementNotifications,
  enqueueSubscriptionCancellationNotification,
  enqueueSubscriptionPaymentNotification,
  enqueueSubdomainPaymentNotification,
  enqueueWalletTransactionNotification,
  enqueueWithdrawalRequestedAdminNotifications,
  enqueueWithdrawalRequestedSellerNotifications,
  enqueueWithdrawalStatusSellerNotifications,
} = require('../../services/financialNotificationOutboxService');

let mongoServer;
const id = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await NotificationOutbox.syncIndexes();
}, 60000);

afterEach(async () => {
  await NotificationOutbox.deleteMany({});
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60000);

const paidMixedOrder = () => {
  const buyer = id();
  const sellerA = id();
  const sellerB = id();
  return {
    order: {
      _id: id(),
      orderId: 'ORD-MIXED-1',
      user: buyer,
      currency: 'PKR',
      orderSummary: {
        subtotal: 1880,
        shippingCost: 0,
        tax: 0,
        couponDiscount: 0,
        totalAmount: 1880,
      },
      orderItems: [
        {
          seller: sellerA,
          name: 'PKR seller item',
          price: 200,
          lineSubtotal: 200,
          quantity: 1,
        },
        {
          seller: sellerB,
          name: 'USD seller item converted at checkout',
          price: 1680,
          lineSubtotal: 1680,
          quantity: 1,
        },
      ],
      exchangeRateSnapshot: {
        rates: { USD: 1, PKR: 280, EUR: 0.92, GBP: 0.79 },
        fallback: false,
      },
      paidAt: new Date('2026-08-24T12:00:00.000Z'),
      shippingInfo: {
        email: 'buyer@example.com',
        phone: '+92 300 1234567',
      },
      sellerSettlementVersion: 1,
      sellerSettlement: [
        { seller: sellerA, sourceCurrency: 'PKR', sourceAmountMinor: 20000, amountUSDMinor: 71 },
        { seller: sellerB, sourceCurrency: 'PKR', sourceAmountMinor: 168000, amountUSDMinor: 600 },
      ],
    },
    buyer,
    sellerA,
    sellerB,
  };
};

describe('financial notification domain contracts', () => {
  test.each([
    ['USD', 12.34, '$12.34'],
    ['PKR', 280, 'Rs280.00 PKR'],
    ['EUR', 0.92, '€0.92 EUR'],
    ['GBP', 0.79, '£0.79 GBP'],
  ])('renders an exact %s order receipt consistently in every channel', async (
    currency,
    totalAmount,
    expected,
  ) => {
    const { order } = paidMixedOrder();
    order._id = id();
    order.orderId = `ORD-${currency}-CHANNELS`;
    order.currency = currency;
    order.orderSummary.totalAmount = totalAmount;

    await enqueuePaidOrderBuyerNotifications(order, {
      channels: ['inapp', 'push', 'email', 'whatsapp'],
    });

    const rows = await NotificationOutbox.find({ aggregateId: String(order._id) }).lean();
    expect(rows.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    for (const row of rows) {
      expect(row.money).toEqual([expect.objectContaining({
        currency,
        amountMinor: Math.round(totalAmount * 100),
      })]);
      const rendered = row.payload.body
        || row.payload.text
        || row.payload.html
        || row.payload.message;
      expect(rendered).toContain(expected);
    }
  });

  test('no-charge orders say no payment required and persist exact zero snapshots', async () => {
    const { order, sellerA } = paidMixedOrder();
    order.orderSummary.totalAmount = 0;
    order.paymentFulfilledAt = new Date('2026-08-24T12:00:00.000Z');
    order.sellerSettlement = [{
      seller: sellerA,
      sourceCurrency: 'PKR',
      sourceAmountMinor: 0,
      amountUSDMinor: 0,
    }];

    await enqueueNoChargeOrderBuyerNotifications(order, { channels: ['inapp'] });
    await enqueueNoChargeOrderSellerNotifications(order, sellerA, { channels: ['inapp'] });

    const records = await NotificationOutbox.find({}).sort({ eventKey: 1 }).lean();
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.eventType).toBe('order.no_charge_confirmed');
      expect(record.money[0]).toEqual(expect.objectContaining({
        amountMinor: 0,
        currency: 'PKR',
      }));
      expect(record.payload.body).toMatch(/no (buyer )?payment was required/i);
      expect(record.payload.body).not.toMatch(/payment received|paid successfully|charged total/i);
    }
  });

  test('guest no-charge receipts skip missing destinations without aborting completion', async () => {
    const { order } = paidMixedOrder();
    delete order.user;
    order.shippingInfo = {};
    order.orderSummary.totalAmount = 0;
    order.paymentFulfilledAt = new Date('2026-08-24T12:00:00.000Z');

    await expect(enqueueNoChargeOrderBuyerNotifications(order)).resolves.toEqual([]);
    expect(await NotificationOutbox.countDocuments()).toBe(0);
  });

  test('COD buyer and sellers receive exact role-scoped frozen amounts', async () => {
    const { order, sellerA, sellerB } = paidMixedOrder();
    order.paymentMethod = 'cash_on_delivery';
    order.isPaid = false;
    order.createdAt = new Date('2026-08-24T11:00:00.000Z');
    order.confirmation = { token: 'a'.repeat(64) };

    await enqueueCodOrderBuyerConfirmationNotification(order, { channels: ['email'] });
    await enqueueCodOrderSellerNotifications(order, sellerA, { channels: ['email'] });
    await enqueueCodOrderSellerNotifications(order, sellerB, { channels: ['email'] });

    const records = await NotificationOutbox.find({}).lean();
    const buyer = records.find(record => record.recipient.audienceRole === 'buyer');
    const sellerARecord = records.find(record => String(record.recipient.user) === String(sellerA));
    const sellerBRecord = records.find(record => String(record.recipient.user) === String(sellerB));
    expect(buyer.payload.html).toContain('Rs1,880.00 PKR');
    expect(sellerARecord.payload.html).toContain('Rs200.00 PKR');
    expect(sellerARecord.payload.html).not.toContain('Rs1,680.00 PKR');
    expect(sellerBRecord.payload.html).toContain('Rs1,680.00 PKR');
    expect(sellerBRecord.payload.html).not.toContain('Rs200.00 PKR');
  });

  test('COD interactive WhatsApp payload is frozen with the exact outbox total', async () => {
    const { order } = paidMixedOrder();
    order.paymentMethod = 'cash_on_delivery';
    order.isPaid = false;
    order.createdAt = new Date('2026-08-24T11:00:00.000Z');
    order.confirmation = { token: 'a'.repeat(64) };
    order.shippingInfo.fullName = 'Buyer Example';
    order.shippingInfo.city = 'Lahore';

    await enqueueCodOrderBuyerConfirmationNotification(order, { channels: ['whatsapp'] });

    const record = await NotificationOutbox.findOne({ channel: 'whatsapp' }).lean();
    expect(record.money[0]).toEqual(expect.objectContaining({
      amountMinor: 188000,
      currency: 'PKR',
    }));
    expect(record.payload.whatsappButtonsPayloadJson).toContain('Rs1,880.00 PKR');
    expect(record.payload.whatsappListPayloadJson).toContain('Rs1,880.00 PKR');
  });

  test('COD registered buyers default to every applicable account and snapshot channel', async () => {
    const { order, buyer } = paidMixedOrder();
    order.paymentMethod = 'cash_on_delivery';
    order.isPaid = false;
    order.createdAt = new Date('2026-08-24T11:00:00.000Z');
    order.confirmation = { token: 'a'.repeat(64) };

    await enqueueCodOrderBuyerConfirmationNotification(order);

    const rows = await NotificationOutbox.find({ aggregateId: String(order._id) }).lean();
    expect(rows.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(rows.every(row => (
      row.recipient.audienceRole === 'buyer'
      && String(row.recipient.user) === String(buyer)
      && row.payload.linkTo === `/orders/confirm/${'a'.repeat(64)}`
      && row.payload.data?.type === 'order_confirmation_requested'
    ))).toBe(true);
  });

  test('COD email exposes separate scanner-safe confirm and cancel intent buttons', async () => {
    const { order } = paidMixedOrder();
    order.paymentMethod = 'cash_on_delivery';
    order.isPaid = false;
    order.createdAt = new Date('2026-08-24T11:00:00.000Z');
    order.confirmation = { token: 'a'.repeat(64) };

    await enqueueCodOrderBuyerConfirmationNotification(order, { channels: ['email'] });

    const record = await NotificationOutbox.findOne({ channel: 'email' }).lean();
    expect(record.payload.html).toContain('>Confirm Order</a>');
    expect(record.payload.html).toContain('>Cancel Order</a>');
    expect(record.payload.html).toContain(`/orders/confirm/${'a'.repeat(64)}?intent=confirm`);
    expect(record.payload.html).toContain(`/orders/confirm/${'a'.repeat(64)}?intent=cancel`);
    expect(record.payload.text).toContain('Confirm Order:');
    expect(record.payload.text).toContain('Cancel Order:');
    expect(record.payload.html).not.toContain('/api/order/');
  });

  test('COD guests default only to available event-snapshot destinations', async () => {
    const { order } = paidMixedOrder();
    delete order.user;
    order.paymentMethod = 'cash_on_delivery';
    order.isPaid = false;
    order.createdAt = new Date('2026-08-24T11:00:00.000Z');
    order.confirmation = { token: 'a'.repeat(64) };

    await enqueueCodOrderBuyerConfirmationNotification(order);

    const rows = await NotificationOutbox.find({ aggregateId: String(order._id) }).lean();
    expect(rows.map(row => row.channel).sort()).toEqual(['email', 'whatsapp']);
    expect(rows.every(row => row.recipient.kind === 'guest')).toBe(true);
  });

  test('COD decision retries dedupe by the persisted transition timestamp', async () => {
    const { order, sellerA } = paidMixedOrder();
    order.paymentMethod = 'cash_on_delivery';
    order.isPaid = false;
    const transitionAt = new Date('2026-08-24T11:30:00.000Z');

    const first = await enqueueCodOrderDecisionSellerNotifications(order, sellerA, {
      decision: 'cancelled', transitionAt, channels: ['inapp'],
    });
    const replay = await enqueueCodOrderDecisionSellerNotifications(order, sellerA, {
      decision: 'cancelled', transitionAt, channels: ['inapp'],
    });

    expect(String(first[0]._id)).toBe(String(replay[0]._id));
    expect(first[0].payload.body).toContain('Rs200.00 PKR');
    expect(first[0].payload.body).toContain('No cash on delivery payment was collected');
    expect(await NotificationOutbox.countDocuments()).toBe(1);
  });

  test.each([
    ['buyer', 'Buyer cancelled order', /The buyer cancelled/i],
    ['seller', 'Seller cancelled order', /A seller cancelled/i],
    ['admin', 'Administrator cancelled order', /An administrator cancelled/i],
    ['system', 'Order cancelled automatically', /Rozare automatically cancelled/i],
  ])('COD seller cancellation copy attributes the %s actor truthfully', async (
    actorRole,
    expectedTitle,
    expectedBody,
  ) => {
    const { order, sellerA } = paidMixedOrder();
    order._id = id();
    order.paymentMethod = 'cash_on_delivery';
    order.isPaid = false;

    const [record] = await enqueueCodOrderDecisionSellerNotifications(order, sellerA, {
      decision: 'cancelled',
      actorRole,
      transitionAt: new Date(`2026-08-24T18:0${actorRole.length}:00.000Z`),
      channels: ['inapp'],
    });

    expect(record.payload.title).toBe(expectedTitle);
    expect(record.payload.body).toMatch(expectedBody);
    if (actorRole !== 'buyer') expect(record.payload.body).not.toMatch(/The buyer cancelled/i);
    expect(record.payload.data.changedByRole).toBe(actorRole);
  });

  test('buyer sees the persisted order charge while each seller sees only their frozen allocation', async () => {
    const { order, sellerA, sellerB } = paidMixedOrder();
    await enqueuePaidOrderBuyerNotifications(order, { channels: ['inapp'] });
    await enqueuePaidOrderSellerNotifications(order, sellerA, { channels: ['inapp'] });
    await enqueuePaidOrderSellerNotifications(order, sellerB, { channels: ['inapp'] });

    const records = await NotificationOutbox.find({}).sort({ eventKey: 1 }).lean();
    expect(records).toHaveLength(3);
    const buyer = records.find(record => record.recipient.audienceRole === 'buyer');
    const sellers = records.filter(record => record.recipient.audienceRole === 'seller');
    expect(buyer.payload.body).toContain('Rs1,880.00 PKR');
    expect(buyer.money[0]).toEqual(expect.objectContaining({ amountMinor: 188000, currency: 'PKR' }));
    expect(sellers.map(record => record.money[0].amountMinor).sort((a, b) => a - b))
      .toEqual([20000, 168000]);
    expect(sellers.map(record => record.payload.body).join(' ')).toContain('Rs200.00 PKR');
    expect(sellers.map(record => record.payload.body).join(' ')).toContain('Rs1,680.00 PKR');
  });

  test('seller notification renders store currency first and the buyer checkout equivalent second', async () => {
    const { order, sellerA, sellerB } = paidMixedOrder();
    order.sellerCurrencyMoneyVersion = 1;
    order.sellerCurrencyMoney = [
      {
        seller: sellerA,
        currency: 'PKR',
        buyerCurrency: 'PKR',
        subtotalMinor: 20000,
        shippingMinor: 0,
        taxMinor: 0,
        discountMinor: 0,
        adjustmentMinor: 0,
        totalMinor: 20000,
        buyerTotalMinor: 20000,
      },
      {
        seller: sellerB,
        currency: 'USD',
        buyerCurrency: 'PKR',
        subtotalMinor: 600,
        shippingMinor: 0,
        taxMinor: 0,
        discountMinor: 0,
        adjustmentMinor: 0,
        totalMinor: 600,
        buyerTotalMinor: 168000,
      },
    ];

    const [record] = await enqueuePaidOrderSellerNotifications(order, sellerB, { channels: ['inapp'] });
    expect(record.money).toEqual([
      expect.objectContaining({ key: 'seller_store_total', currency: 'USD', amountMinor: 600 }),
      expect.objectContaining({ key: 'seller_order_total', currency: 'PKR', amountMinor: 168000 }),
    ]);
    expect(record.payload.body).toContain('$6.00');
    expect(record.payload.body).toContain('Rs1,680.00 PKR');
  });

  test.each([
    ['PKR', 1880, 'Rs1,880.00 PKR', 188000],
    ['USD', 6.71, '$6.71', 671],
  ])('order lifecycle messages use the persisted %s checkout total without re-converting mixed seller lines', async (
    currency,
    totalAmount,
    renderedTotal,
    amountMinor,
  ) => {
    const { order } = paidMixedOrder();
    order._id = id();
    order.orderId = `ORD-LIFECYCLE-${currency}`;
    order.currency = currency;
    order.orderSummary.totalAmount = totalAmount;
    order.orderStatus = 'shipped';
    // These source lines deliberately use different seller currencies. A
    // lifecycle notification must not inspect or convert either one again.
    order.orderItems = [
      { seller: id(), sourceCurrency: 'PKR', sourceLineSubtotal: 200 },
      { seller: id(), sourceCurrency: 'USD', sourceLineSubtotal: 6 },
    ];
    const transitionAt = new Date('2026-08-24T16:00:00.000Z');

    const first = await enqueueOrderLifecycleBuyerNotifications(order, {
      status: 'shipped',
      previousStatus: 'processing',
      transitionAt,
      actorRole: 'seller',
      channels: ['inapp', 'push', 'email', 'whatsapp'],
    });
    const replay = await enqueueOrderLifecycleBuyerNotifications(order, {
      status: 'shipped',
      previousStatus: 'processing',
      transitionAt,
      actorRole: 'seller',
      channels: ['inapp', 'push', 'email', 'whatsapp'],
    });

    expect(replay.map(record => String(record._id)))
      .toEqual(first.map(record => String(record._id)));
    const records = await NotificationOutbox.find({ aggregateId: String(order._id) }).lean();
    expect(records).toHaveLength(4);
    expect(records.map(record => record.channel).sort())
      .toEqual(['email', 'inapp', 'push', 'whatsapp']);
    for (const record of records) {
      expect(record).toMatchObject({
        eventType: 'order.status_updated',
        financial: true,
        recipient: { audienceRole: 'buyer' },
      });
      expect(record.money).toEqual([expect.objectContaining({
        key: 'order_total',
        currency,
        amountMinor,
        sourcePath: 'orderSummary.totalAmount',
      })]);
      const rendered = record.payload.body
        || record.payload.text
        || record.payload.html
        || record.payload.message;
      expect(rendered).toContain(renderedTotal);
      expect(record.payload.data).toMatchObject({
        previousStatus: 'processing',
        status: 'shipped',
      });
    }
  });

  test('order lifecycle replay refuses changed money under the same transition identity', async () => {
    const { order } = paidMixedOrder();
    order.orderStatus = 'cancelled';
    const transitionAt = new Date('2026-08-24T16:30:00.000Z');
    const [first] = await enqueueOrderLifecycleBuyerNotifications(order, {
      status: 'cancelled',
      previousStatus: 'processing',
      transitionAt,
      actorRole: 'admin',
      channels: ['inapp'],
    });

    order.orderSummary.totalAmount = 1880.01;
    await expect(enqueueOrderLifecycleBuyerNotifications(order, {
      status: 'cancelled',
      previousStatus: 'processing',
      transitionAt,
      actorRole: 'admin',
      channels: ['inapp'],
    })).rejects.toMatchObject({ code: 'NOTIFICATION_IDEMPOTENCY_CONFLICT' });

    const persisted = await NotificationOutbox.findById(first._id).lean();
    expect(persisted.money[0]).toEqual(expect.objectContaining({
      currency: 'PKR',
      amountMinor: 188000,
    }));
    expect(persisted.payload.body).toContain('Rs1,880.00 PKR');
    expect(persisted.payload.body).toMatch(/does not by itself record or promise a refund/i);
    expect(await NotificationOutbox.countDocuments()).toBe(1);
  });

  test.each([
    ['buyer', /You cancelled this order/i],
    ['seller', /A seller cancelled your order/i],
    ['admin', /A Rozare administrator cancelled your order/i],
    ['system', /Rozare automatically cancelled your order/i],
  ])('buyer cancellation receipts attribute the %s actor across every delivery channel', async (
    actorRole,
    expectedCopy,
  ) => {
    const { order } = paidMixedOrder();
    order._id = id();
    order.orderId = `ORD-BUYER-CANCEL-${actorRole.toUpperCase()}`;
    order.orderStatus = 'cancelled';

    await enqueueOrderLifecycleBuyerNotifications(order, {
      status: 'cancelled',
      previousStatus: 'confirmed',
      transitionAt: new Date(`2026-08-24T19:0${actorRole.length}:00.000Z`),
      actorRole,
      channels: ['inapp', 'push', 'email', 'whatsapp'],
    });

    const records = await NotificationOutbox.find({ aggregateId: String(order._id) }).lean();
    expect(records).toHaveLength(4);
    for (const record of records) {
      const rendered = record.payload.body
        || record.payload.text
        || record.payload.html
        || record.payload.message;
      expect(rendered).toMatch(expectedCopy);
      expect(rendered).toMatch(/does not by itself record or promise a refund/i);
      expect(record.payload.data.changedByRole).toBe(actorRole);
    }
  });

  test('seller fulfillment update names only that store/items and uses its frozen settlement allocation', async () => {
    const { order, sellerA, sellerB } = paidMixedOrder();
    order.orderStatus = 'pending';
    order.sellerFulfillment = [
      { seller: sellerA, status: 'pending' },
      { seller: sellerB, status: 'processing' },
    ];
    order.sellerPolicies = [
      { seller: sellerA, storeName: 'PKR Store' },
      { seller: sellerB, storeName: 'USD Store' },
    ];
    order.sellerShipping = [
      { seller: sellerA, shippingMethod: { name: 'Local', price: 0, estimatedDays: 2 } },
      { seller: sellerB, shippingMethod: { name: 'International', price: 0, estimatedDays: 8 } },
    ];
    const transitionAt = new Date('2026-08-24T18:30:00.000Z');

    const first = await enqueueOrderSellerFulfillmentBuyerNotifications(order, {
      sellerId: sellerB,
      status: 'processing',
      previousStatus: 'pending',
      transitionAt,
      actorRole: 'seller',
    });
    const replay = await enqueueOrderSellerFulfillmentBuyerNotifications(order, {
      sellerId: sellerB,
      status: 'processing',
      previousStatus: 'pending',
      transitionAt,
      actorRole: 'seller',
    });

    expect(first.map(record => record.channel).sort())
      .toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(replay.map(record => String(record._id)))
      .toEqual(first.map(record => String(record._id)));
    for (const record of first) {
      expect(record).toMatchObject({
        eventType: 'order.seller_fulfillment_updated',
        financial: true,
      });
      expect(record.money).toEqual([expect.objectContaining({
        key: 'seller_order_total',
        currency: 'PKR',
        amountMinor: 168000,
      })]);
      expect(record.payload.data).toMatchObject({
        sellerId: sellerB.toString(),
        storeName: 'USD Store',
        itemNames: ['USD seller item converted at checkout'],
        status: 'processing',
      });
      const rendered = record.payload.body
        || record.payload.text
        || record.payload.html
        || record.payload.message;
      expect(rendered).toContain('Rs1,680.00 PKR');
      expect(rendered).toContain('USD Store');
      expect(rendered).not.toContain('PKR seller item');
    }
  });

  test('completed stock-loss refund receipt is exact, all-channel, and keyed by the Stripe refund', async () => {
    const { order } = paidMixedOrder();
    order.paymentMethod = 'stripe';
    order.isPaid = false;
    order.orderStatus = 'cancelled';
    order.paymentResult = {
      stockRefundId: 're_stock_loss_pkr_1',
      stockRefundStatus: 'succeeded',
      stockRefundAmountMinor: 188000,
      stockRefundCurrency: 'PKR',
      stockRefundAt: new Date('2026-08-24T19:00:00.000Z'),
    };

    const first = await enqueueOrderStockRefundBuyerNotifications(order);
    const replay = await enqueueOrderStockRefundBuyerNotifications(order);

    expect(first.map(record => record.channel).sort())
      .toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(replay.map(record => String(record._id)))
      .toEqual(first.map(record => String(record._id)));
    for (const record of first) {
      expect(record).toMatchObject({
        eventType: 'order.stock_refund_completed',
        financial: true,
        recipient: { audienceRole: 'buyer', allowBlocked: true },
      });
      expect(record.money).toEqual([expect.objectContaining({
        key: 'refund_total',
        amountMinor: 188000,
        currency: 'PKR',
        sourcePath: 'paymentResult.stockRefundAmountMinor',
      })]);
      const rendered = record.payload.body
        || record.payload.text
        || record.payload.html
        || record.payload.message;
      expect(rendered).toContain('Rs1,880.00 PKR');
      expect(rendered).toMatch(/Stripe.*completed|Stripe reports/i);
      expect(rendered).toMatch(/bank.*time/i);
    }
    expect(await NotificationOutbox.countDocuments()).toBe(4);
  });

  test('stock-loss refund receipt fails closed when provider refund and frozen order charge differ', async () => {
    const { order } = paidMixedOrder();
    order.paymentMethod = 'stripe';
    order.isPaid = false;
    order.orderStatus = 'cancelled';
    order.paymentResult = {
      stockRefundId: 're_stock_loss_mismatch_1',
      stockRefundStatus: 'succeeded',
      stockRefundAmountMinor: 187999,
      stockRefundCurrency: 'PKR',
      stockRefundAt: new Date('2026-08-24T19:05:00.000Z'),
    };

    await expect(enqueueOrderStockRefundBuyerNotifications(order, {
      channels: ['inapp'],
    })).rejects.toMatchObject({ code: 'NOTIFICATION_REFUND_MONEY_MISMATCH' });
    expect(await NotificationOutbox.countDocuments()).toBe(0);
  });

  test('withdrawal messages preserve requested and bank-payout denominations for seller and admins', async () => {
    const seller = id();
    const admins = [id(), id()];
    const withdrawal = {
      _id: id(),
      seller,
      requestedAmount: 27750,
      requestedCurrency: 'PKR',
      payoutAmount: 100,
      payoutCurrency: 'USD',
      status: 'pending',
      createdAt: new Date('2026-08-24T12:00:00.000Z'),
    };
    await enqueueWithdrawalRequestedSellerNotifications(withdrawal, { channels: ['inapp'] });
    await enqueueWithdrawalRequestedAdminNotifications(
      withdrawal,
      admins,
      'Pakistan Seller',
      { channels: ['inapp'] }
    );
    const records = await NotificationOutbox.find({}).lean();
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record.payload.body).toContain('Rs27,750.00 PKR');
      expect(record.payload.body).toContain('$100.00');
      expect(record.money).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'requested_amount', currency: 'PKR', amountMinor: 2775000 }),
        expect.objectContaining({ key: 'payout_amount', currency: 'USD', amountMinor: 10000 }),
      ]));
    }
    expect(records.filter(record => record.recipient.audienceRole === 'admin')).toHaveLength(2);
  });

  test('withdrawal transitions dedupe by durable admin operation and never reinterpret historical FX', async () => {
    const withdrawal = {
      _id: id(),
      seller: id(),
      requestedAmount: 100,
      requestedCurrency: 'EUR',
      payoutAmount: 90,
      payoutCurrency: 'GBP',
      status: 'processing',
      adminNote: 'Bank transfer initiated.',
      adminOperations: [{
        operationKey: 'admin-op-processing-attempt-1',
        fromStatus: 'approved',
        toStatus: 'processing',
        attemptId: 'payout-attempt-1',
        appliedAt: new Date('2026-08-24T12:30:00.000Z'),
      }],
    };
    const first = await enqueueWithdrawalStatusSellerNotifications(withdrawal, { channels: ['inapp'] });
    const replay = await enqueueWithdrawalStatusSellerNotifications(withdrawal, { channels: ['inapp'] });
    expect(String(first[0]._id)).toBe(String(replay[0]._id));
    expect(first[0].payload.body).toContain('€100.00 EUR');
    expect(first[0].payload.body).toContain('£90.00 GBP');
    expect(first[0].payload.body).toContain('not yet recorded as paid');

    withdrawal.adminOperations.push({
      operationKey: 'admin-op-processing-attempt-2',
      fromStatus: 'approved',
      toStatus: 'processing',
      attemptId: 'payout-attempt-2',
      appliedAt: new Date('2026-08-24T13:30:00.000Z'),
    });
    const laterRetry = await enqueueWithdrawalStatusSellerNotifications(withdrawal, { channels: ['inapp'] });
    expect(String(laterRetry[0]._id)).not.toBe(String(first[0]._id));
    expect(await NotificationOutbox.countDocuments()).toBe(2);
  });

  test.each([
    ['manual_review', 'full reservation remains held'],
    ['failed', 'reservation was released'],
    ['paid', 'administrator-supplied transfer proof'],
  ])('withdrawal %s language states its exact settlement meaning', async (status, expected) => {
    const appliedAt = new Date('2026-08-24T12:30:00.000Z');
    const withdrawal = {
      _id: id(),
      seller: id(),
      requestedAmount: 100,
      requestedCurrency: 'USD',
      payoutAmount: 27750,
      payoutCurrency: 'PKR',
      status,
      adminOperations: [{
        operationKey: `admin-op-${status}`,
        fromStatus: 'processing',
        toStatus: status,
        attemptId: 'payout-attempt-1',
        appliedAt,
      }],
    };
    const [record] = await enqueueWithdrawalStatusSellerNotifications(withdrawal, {
      channels: ['inapp'],
    });
    expect(record.payload.body).toContain(expected);
  });

  test('return settlement sends the same frozen refund to buyer and seller without role leakage', async () => {
    const buyer = id();
    const seller = id();
    const walletTransactionId = id();
    const order = {
      _id: id(),
      orderId: 'ORD-RETURN-1',
      user: buyer,
      shippingInfo: { email: 'buyer@example.com', phone: '+92 300 1234567' },
    };
    const request = {
      _id: id(),
      order: order._id,
      orderId: order.orderId,
      returnNumber: 'RET-1',
      buyer,
      seller,
      currency: 'GBP',
      status: 'returned',
      refund: { totalAmount: 12.34 },
      settlement: {
        status: 'completed',
        settledAt: new Date('2026-08-24T13:00:00.000Z'),
        walletTransaction: walletTransactionId,
      },
    };
    const result = await enqueueReturnSettlementNotifications(request, order, {
      buyerChannels: ['inapp'],
      sellerChannels: ['inapp'],
      walletTransaction: {
        _id: walletTransactionId,
        user: buyer,
        type: 'return_refund',
        direction: 'credit',
        status: 'completed',
        amount: 12.34,
        currency: 'GBP',
        referenceType: 'return_request',
        referenceId: request._id,
        metadata: {
          availableCreditedMinor: 1234,
          liabilityAppliedMinor: 0,
          remainingLiabilityMinor: 0,
        },
        completedAt: new Date('2026-08-24T13:00:00.000Z'),
      },
    });
    expect(result.buyer).toHaveLength(1);
    expect(result.seller).toHaveLength(1);
    expect(result.buyer[0].recipient.audienceRole).toBe('buyer');
    expect(result.seller[0].recipient.audienceRole).toBe('seller');
    expect(result.buyer[0].payload.body).toContain('£12.34 GBP');
    expect(result.seller[0].payload.body).toContain('£12.34 GBP');
  });

  test('return notifications disclose the exact Wallet liability allocation in every role', async () => {
    const buyer = id();
    const seller = id();
    const walletTransactionId = id();
    const order = {
      _id: id(),
      orderId: 'ORD-RETURN-LIABILITY',
      user: buyer,
      shippingInfo: { email: 'buyer@example.com', phone: '+92 300 1234567' },
    };
    const request = {
      _id: id(),
      order: order._id,
      orderId: order.orderId,
      returnNumber: 'RET-LIABILITY',
      buyer,
      seller,
      currency: 'USD',
      status: 'returned',
      refund: { totalAmount: 100 },
      settlement: {
        status: 'completed',
        settledAt: new Date('2026-08-24T13:00:00.000Z'),
        walletTransaction: walletTransactionId,
      },
    };
    const walletTransaction = {
      _id: walletTransactionId,
      user: buyer,
      type: 'return_refund',
      direction: 'credit',
      status: 'completed',
      amount: 100,
      currency: 'USD',
      referenceType: 'return_request',
      referenceId: request._id,
      metadata: {
        availableCreditedMinor: 4000,
        liabilityAppliedMinor: 6000,
        remainingLiabilityMinor: 2500,
      },
      completedAt: new Date('2026-08-24T13:00:00.000Z'),
    };
    const result = await enqueueReturnSettlementNotifications(request, order, {
      buyerChannels: ['inapp'],
      sellerChannels: ['inapp'],
      walletTransaction,
    });
    for (const record of result.buyer) {
      expect(record.payload.body).toContain('$100.00');
      expect(record.payload.body).toContain('$40.00');
      expect(record.payload.body).toContain('$60.00');
      expect(record.payload.body).toContain('$25.00');
      expect(record.money).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'refund_total', amountMinor: 10000 }),
        expect.objectContaining({ key: 'refund_wallet_available', amountMinor: 4000 }),
        expect.objectContaining({ key: 'refund_liability_applied', amountMinor: 6000 }),
        expect.objectContaining({ key: 'refund_remaining_liability', amountMinor: 2500 }),
      ]));
    }
    for (const record of result.seller) {
      expect(record.payload.body).toContain('$100.00');
      expect(record.payload.body).toContain('remain private');
      expect(record.payload.body).not.toContain('$40.00');
      expect(record.payload.body).not.toContain('$60.00');
      expect(record.payload.body).not.toContain('$25.00');
      expect(record.money).toEqual([
        expect.objectContaining({ key: 'refund_total', amountMinor: 10000 }),
      ]);
    }
  });

  test('subscription and wallet notifications render their persisted ledgers', async () => {
    const seller = id();
    const payment = {
      _id: id(),
      seller,
      currency: 'usd',
      capturedMinor: 1299,
      createdAt: new Date('2026-08-24T14:00:00.000Z'),
    };
    const wallet = {
      _id: id(),
      user: id(),
      status: 'completed',
      direction: 'credit',
      amount: 500,
      currency: 'PKR',
      referenceId: 'return:RET-1',
      metadata: {
        availableCreditedMinor: 50000,
        liabilityAppliedMinor: 0,
        remainingLiabilityMinor: 0,
      },
      completedAt: new Date('2026-08-24T14:10:00.000Z'),
    };
    await enqueueSubscriptionPaymentNotification(payment, {
      kind: 'recovered',
      planName: 'Rozare Elite',
      channels: ['inapp'],
    });
    await enqueueWalletTransactionNotification(wallet, { channels: ['inapp'] });
    const records = await NotificationOutbox.find({}).lean();
    const subscription = records.find(record => record.eventType === 'subscription.payment_recovered');
    const walletRecord = records.find(record => record.eventType === 'wallet.completed');
    expect(subscription.payload.body).toContain('$12.99');
    expect(subscription.money[0]).toEqual(expect.objectContaining({
      sourceModel: 'StripeEntitlementPayment', amountMinor: 1299, currency: 'USD',
    }));
    expect(walletRecord.payload.body).toContain('Rs500.00 PKR');
    expect(walletRecord.money[0]).toEqual(expect.objectContaining({
      sourceModel: 'WalletTransaction', amountMinor: 50000, currency: 'PKR',
    }));
    expect(walletRecord.eventKey).toBe(`wallet-transaction:${wallet._id}:completed:buyer:v1`);
  });

  test('Wallet credit notifications conserve and render available versus liability amounts', async () => {
    await enqueueWalletTransactionNotification({
      _id: id(),
      user: id(),
      status: 'completed',
      direction: 'credit',
      amount: 100,
      currency: 'USD',
      referenceId: 'top-up-liability-allocation',
      metadata: {
        availableCreditedMinor: 4000,
        liabilityAppliedMinor: 6000,
        remainingLiabilityMinor: 2500,
      },
      completedAt: new Date('2026-08-24T14:10:00.000Z'),
    }, { channels: ['inapp', 'push', 'email'] });
    const records = await NotificationOutbox.find({ eventType: 'wallet.completed' }).lean();
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record.eventKey).toMatch(/:completed:buyer:v2$/);
      const rendered = record.payload.body || record.payload.text || record.payload.html;
      expect(rendered).toContain('$100.00');
      expect(rendered).toContain('$40.00');
      expect(rendered).toContain('$60.00');
      expect(record.money).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'wallet_amount', amountMinor: 10000 }),
        expect.objectContaining({ key: 'wallet_available_credit', amountMinor: 4000 }),
        expect.objectContaining({ key: 'wallet_liability_applied', amountMinor: 6000 }),
        expect.objectContaining({ key: 'wallet_remaining_liability', amountMinor: 2500 }),
      ]));
    }
  });

  test.each([
    {},
    { availableCreditedMinor: 10000, liabilityAppliedMinor: 1, remainingLiabilityMinor: 0 },
    { availableCreditedMinor: '10000', liabilityAppliedMinor: 0, remainingLiabilityMinor: 0 },
    { availableCreditedMinor: 10000, liabilityAppliedMinor: 0, remainingLiabilityMinor: -1 },
  ])('Wallet credit notification rejects a malformed allocation %p', async metadata => {
    await expect(enqueueWalletTransactionNotification({
      _id: id(),
      user: id(),
      status: 'completed',
      direction: 'credit',
      amount: 100,
      currency: 'USD',
      referenceId: 'corrupt-wallet-allocation',
      metadata,
      completedAt: new Date('2026-08-24T14:10:00.000Z'),
    }, { channels: ['inapp'] })).rejects.toMatchObject({
      code: expect.stringMatching(/NOTIFICATION_(?:MONEY|WALLET)/),
    });
    expect(await NotificationOutbox.countDocuments()).toBe(0);
  });

  test.each([undefined, null, '', 'Credit', 'withdrawal', true])(
    'wallet notification rejects corrupt direction %p instead of mislabeling it as a debit',
    async direction => {
      await expect(enqueueWalletTransactionNotification({
        _id: id(),
        user: id(),
        status: 'completed',
        direction,
        amount: 12.34,
        currency: 'USD',
        referenceId: 'wallet-corrupt-direction',
        completedAt: new Date('2026-08-24T14:10:00.000Z'),
      }, { channels: ['inapp'] })).rejects.toMatchObject({
        code: 'NOTIFICATION_OUTBOX_INVALID',
      });
      expect(await NotificationOutbox.countDocuments()).toBe(0);
    },
  );

  test('subdomain receipt replays use the immutable payment resource and grant end', async () => {
    const seller = id();
    const storeId = id();
    const payment = {
      _id: id(),
      entitlementType: 'subdomain',
      seller,
      store: storeId,
      resourceKey: 'original-shop',
      capturedMinor: 1500,
      currency: 'usd',
      grantEnd: new Date('2029-08-24T00:00:00.000Z'),
      createdAt: new Date('2026-08-24T00:00:00.000Z'),
    };
    const mutableStore = {
      _id: storeId,
      seller,
      storeSlug: 'renamed-shop',
      subdomainPurchase: { expiresAt: new Date('2032-08-24T00:00:00.000Z') },
    };

    const first = await enqueueSubdomainPaymentNotification(payment, mutableStore, { channels: ['inapp'] });
    mutableStore.storeSlug = 'renamed-again';
    mutableStore.subdomainPurchase.expiresAt = new Date('2035-08-24T00:00:00.000Z');
    const replay = await enqueueSubdomainPaymentNotification(payment, mutableStore, { channels: ['inapp'] });

    expect(String(first[0]._id)).toBe(String(replay[0]._id));
    expect(first[0].payload.body).toContain('original-shop.rozare.com');
    expect(first[0].payload.body).toContain('2029-08-24');
    expect(first[0].payload.body).toContain('$15.00');
    expect(first[0].money[0]).toEqual(expect.objectContaining({
      amountMinor: 1500,
      currency: 'USD',
      sourcePath: 'capturedMinor',
    }));
    expect(first[0].payload.body).not.toContain('renamed');
  });

  test('subscription cancellation is keyed by the ended Stripe subscription and reaches the blocked seller', async () => {
    const seller = id();
    const subscription = {
      _id: id(),
      seller,
      plan: 'elite',
      planName: 'Rozare Elite',
      status: 'blocked',
      stripeSubscriptionId: 'sub_ended_123',
      cancellationTransition: {
        stripeSubscriptionId: 'sub_ended_123',
        cancelledAt: new Date('2026-08-24T15:00:00.000Z'),
      },
    };

    const first = await enqueueSubscriptionCancellationNotification(subscription, {
      channels: ['inapp'],
    });
    const replay = await enqueueSubscriptionCancellationNotification({
      ...subscription,
      cancellationTransition: {
        ...subscription.cancellationTransition,
        firstEventId: 'evt_duplicate_delivery',
      },
    }, { channels: ['inapp'] });

    expect(String(first[0]._id)).toBe(String(replay[0]._id));
    expect(first[0]).toMatchObject({
      eventType: 'subscription.cancelled',
      recipient: {
        audienceRole: 'seller',
        user: seller,
        allowBlocked: true,
      },
    });
    expect(first[0].payload.body).toContain('store is hidden');
    expect(await NotificationOutbox.countDocuments()).toBe(1);

    await expect(enqueueSubscriptionCancellationNotification({
      ...subscription,
      stripeSubscriptionId: 'sub_newer_checkout',
    }, { channels: ['inapp'] })).rejects.toMatchObject({
      code: 'SUBSCRIPTION_CANCELLATION_STALE',
    });
  });
});
