'use strict';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Order = require('../../models/Order');
const NotificationOutbox = require('../../models/NotificationOutbox');
const Product = require('../../models/Product');
const { cancelOrderSafely } = require('../../services/orderCancellationService');
const {
  confirmCodOrderByBuyer,
  transitionOrderFulfillment,
} = require('../../services/orderStatusTransitionService');
const {
  applyFirstOrderDecision,
} = require('../../services/whatsapp/webhookHandler').__private;

let replSet;

const sellerId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();

const createProduct = suffix => Product.create({
  seller: sellerId,
  name: `Status race product ${suffix}`,
  description: 'Transactional fulfillment race fixture.',
  price: 100,
  currency: 'USD',
  category: 'Test',
  brand: 'Test',
  stock: 9,
  totalSales: 1,
  image: 'https://example.com/status-race.jpg',
  images: [{ url: 'https://example.com/status-race.jpg' }],
});

const createOrder = async ({
  suffix,
  product,
  paymentMethod = 'cash_on_delivery',
  awaitingPayment = false,
  isPaid = false,
  orderStatus = 'pending',
  inventoryCommitted = true,
  confirmation = null,
  currency = 'USD',
  totalAmount = 100,
}) => Order.create({
  orderId: `STATUS-RACE-${suffix}`,
  user: userId,
  orderItems: [{
    productId: product._id,
    seller: sellerId,
    name: product.name,
    image: product.image,
    price: totalAmount,
    quantity: 1,
  }],
  shippingInfo: {
    fullName: 'Status Race Buyer',
    email: 'status-race@example.com',
    phone: '+14155552671',
    address: '1 Transaction Way',
    city: 'Test City',
    state: 'Test State',
    postalCode: '10000',
    country: 'United States',
  },
  shippingMethod: { name: 'Standard', price: 0, estimatedDays: 3 },
  sellerShipping: [{
    seller: sellerId,
    shippingMethod: { name: 'Standard', price: 0, estimatedDays: 3 },
  }],
  orderSummary: {
    subtotal: totalAmount,
    shippingCost: 0,
    tax: 0,
    couponDiscount: 0,
    totalAmount,
  },
  currency,
  paymentMethod,
  paymentFlow: paymentMethod === 'stripe' ? 'payment_sheet' : 'checkout_session',
  paymentSetupState: paymentMethod === 'stripe' ? 'ready' : 'closed',
  stripePaymentIntentId: paymentMethod === 'stripe' ? `pi_status_${suffix}` : null,
  awaitingPayment,
  isPaid,
  orderStatus,
  inventoryCommitted,
  sellerFulfillment: [{ seller: sellerId, status: orderStatus }],
  sellerPolicies: [{ seller: sellerId, storeName: 'Status Race Store' }],
  confirmation: confirmation || {
    token: `confirmation-token-${suffix}`,
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  },
});

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await mongoose.connect(replSet.getUri());
  await NotificationOutbox.syncIndexes();
}, 60000);

afterEach(async () => {
  await Promise.all([
    NotificationOutbox.deleteMany({}),
    Order.deleteMany({}),
    Product.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 60000);

describe('transactional order fulfillment transitions', () => {
  test('cannot manufacture payment by delivering an awaiting unpaid Stripe order', async () => {
    const product = await createProduct('unpaid-stripe');
    const order = await createOrder({
      suffix: 'UNPAID-STRIPE',
      product,
      paymentMethod: 'stripe',
      awaitingPayment: true,
      isPaid: false,
    });

    await expect(transitionOrderFulfillment({
      orderId: order._id,
      actorRole: 'admin',
      sellerIds: [sellerId],
      newStatus: 'delivered',
    })).rejects.toMatchObject({
      code: 'ORDER_PAYMENT_NOT_CONFIRMED',
      currentStatus: 'pending',
    });

    const persisted = await Order.findById(order._id).lean();
    expect(persisted).toMatchObject({
      orderStatus: 'pending',
      awaitingPayment: true,
      isPaid: false,
      inventoryCommitted: true,
    });
  });

  test('cannot fulfill an order whose inventory reservation was never committed', async () => {
    const product = await createProduct('uncommitted-inventory');
    const order = await createOrder({
      suffix: 'UNCOMMITTED-INVENTORY',
      product,
      inventoryCommitted: false,
    });

    await expect(transitionOrderFulfillment({
      orderId: order._id,
      actorRole: 'admin',
      sellerIds: [sellerId],
      newStatus: 'processing',
    })).rejects.toMatchObject({
      code: 'ORDER_INVENTORY_NOT_COMMITTED',
      currentStatus: 'pending',
    });

    const persisted = await Order.findById(order._id).lean();
    expect(persisted).toMatchObject({
      orderStatus: 'pending',
      inventoryCommitted: false,
      isPaid: false,
    });
    expect(persisted.sellerFulfillment[0].status).toBe('pending');
  });

  test('does not trust caller seller hints as fulfillment authorization', async () => {
    const product = await createProduct('forged-seller-hint');
    const order = await createOrder({ suffix: 'FORGED-SELLER-HINT', product });
    const unrelatedSeller = new mongoose.Types.ObjectId();

    await expect(transitionOrderFulfillment({
      orderId: order._id,
      actorRole: 'seller',
      actorId: unrelatedSeller,
      sellerIds: [unrelatedSeller],
      newStatus: 'processing',
    })).rejects.toMatchObject({
      code: 'SELLER_FULFILLMENT_NOT_FOUND',
      statusCode: 403,
    });

    const persisted = await Order.findById(order._id).lean();
    expect(persisted.orderStatus).toBe('pending');
    expect(persisted.sellerFulfillment).toHaveLength(1);
    expect(persisted.sellerFulfillment[0].seller.toString()).toBe(sellerId.toString());
  });

  test('does not treat a stale fulfillment row as ownership over an item seller snapshot', async () => {
    const product = await createProduct('stale-fulfillment-owner');
    const order = await createOrder({ suffix: 'STALE-FULFILLMENT-OWNER', product });
    const staleSeller = new mongoose.Types.ObjectId();
    await Order.updateOne({ _id: order._id }, {
      $push: {
        sellerFulfillment: {
          seller: staleSeller,
          status: 'pending',
          updatedAt: new Date(),
        },
      },
    });

    await expect(transitionOrderFulfillment({
      orderId: order._id,
      actorRole: 'seller',
      actorId: staleSeller,
      newStatus: 'delivered',
    })).rejects.toMatchObject({
      code: 'SELLER_FULFILLMENT_NOT_FOUND',
      statusCode: 403,
    });

    const persisted = await Order.findById(order._id).lean();
    expect(persisted.orderStatus).toBe('pending');
    expect(persisted.sellerFulfillment.map(entry => entry.status))
      .toEqual(['pending', 'pending']);
    expect(persisted.isPaid).toBe(false);
  });

  test('recognizes payment on aggregate delivery only for COD', async () => {
    const product = await createProduct('cod-delivery');
    const order = await createOrder({ suffix: 'COD-DELIVERY', product });

    await transitionOrderFulfillment({
      orderId: order._id,
      actorRole: 'admin',
      sellerIds: [sellerId],
      newStatus: 'delivered',
    });

    const persisted = await Order.findById(order._id).lean();
    expect(persisted.orderStatus).toBe('delivered');
    expect(persisted.isDelivered).toBe(true);
    expect(persisted.isPaid).toBe(true);
    expect(persisted.paidAt).toBeInstanceOf(Date);
  });

  test('a paid Wallet order can advance without rewriting its payment timestamp', async () => {
    const product = await createProduct('wallet-delivery');
    const paidAt = new Date(Date.now() - 60_000);
    const order = await createOrder({
      suffix: 'WALLET-DELIVERY',
      product,
      paymentMethod: 'wallet',
      isPaid: true,
    });
    await Order.updateOne({ _id: order._id }, { $set: { paidAt } });

    await transitionOrderFulfillment({
      orderId: order._id,
      actorRole: 'admin',
      sellerIds: [sellerId],
      newStatus: 'delivered',
    });

    const persisted = await Order.findById(order._id).lean();
    expect(persisted).toMatchObject({
      orderStatus: 'delivered',
      isDelivered: true,
      isPaid: true,
      inventoryCommitted: true,
    });
    expect(persisted.paidAt.getTime()).toBe(paidAt.getTime());
  });

  test('reports authoritative transition metadata so same-status replays are notification-idempotent', async () => {
    const product = await createProduct('transition-metadata');
    const order = await createOrder({ suffix: 'TRANSITION-METADATA', product });

    const first = await transitionOrderFulfillment({
      orderId: order._id,
      actorRole: 'admin',
      newStatus: 'processing',
    });
    const replay = await transitionOrderFulfillment({
      orderId: order._id,
      actorRole: 'admin',
      newStatus: 'processing',
    });

    expect(first.transition).toMatchObject({
      actorStatusChanged: true,
      aggregateStatusChanged: true,
      previousAggregateStatus: 'pending',
      currentAggregateStatus: 'processing',
    });
    expect(replay.transition).toMatchObject({
      actorStatusChanged: false,
      aggregateStatusChanged: false,
      previousAggregateStatus: 'processing',
      currentAggregateStatus: 'processing',
    });
  });

  test('commits one replay-safe seller-scoped all-channel buyer event with the frozen PKR checkout total', async () => {
    const product = await createProduct('pkr-notification-outbox');
    const order = await createOrder({
      suffix: 'PKR-NOTIFICATION-OUTBOX',
      product,
      currency: 'PKR',
      totalAmount: 1880,
    });
    const transitionAt = new Date('2026-08-24T17:00:00.000Z');

    const first = await transitionOrderFulfillment({
      orderId: order._id,
      actorRole: 'admin',
      newStatus: 'shipped',
      at: transitionAt,
    });
    const replay = await transitionOrderFulfillment({
      orderId: order._id,
      actorRole: 'admin',
      newStatus: 'shipped',
      at: new Date('2026-08-24T17:05:00.000Z'),
    });

    expect(first.transition.aggregateStatusChanged).toBe(true);
    expect(replay.transition.aggregateStatusChanged).toBe(false);
    const records = await NotificationOutbox.find({
      aggregateId: String(order._id),
      eventType: 'order.seller_fulfillment_updated',
    }).lean();
    expect(records.map(record => record.channel).sort())
      .toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(new Set(records.map(record => record.eventKey)).size).toBe(1);
    for (const record of records) {
      expect(record.occurredAt).toEqual(transitionAt);
      expect(record.money).toEqual([expect.objectContaining({
        amountMinor: 188000,
        currency: 'PKR',
        sourcePath: `computedSellerSummary[${sellerId}].totalAmount`,
      })]);
      expect(record.payload.data).toMatchObject({
        type: 'seller_fulfillment_updated',
        sellerId: sellerId.toString(),
        storeName: 'Status Race Store',
        previousStatus: 'pending',
        status: 'shipped',
      });
      const rendered = record.payload.body
        || record.payload.text
        || record.payload.html
        || record.payload.message;
      expect(rendered).toContain('Rs1,880.00 PKR');
    }
  });

  test('notifies for only the seller portion that advanced even when aggregate status stays pending', async () => {
    const sellerB = new mongoose.Types.ObjectId();
    const productA = await createProduct('multi-seller-a');
    const productB = await Product.create({
      seller: sellerB,
      name: 'Status race product multi-seller-b',
      description: 'Second transactional fulfillment fixture.',
      price: 100,
      currency: 'USD',
      category: 'Test',
      brand: 'Test',
      stock: 9,
      totalSales: 1,
      image: 'https://example.com/status-race-b.jpg',
      images: [{ url: 'https://example.com/status-race-b.jpg' }],
    });
    const order = await createOrder({
      suffix: 'MULTI-SELLER-INDEPENDENT-STATUS',
      product: productA,
      currency: 'PKR',
      totalAmount: 200,
    });
    await Order.updateOne({ _id: order._id }, {
      $set: {
        'orderItems.0.price': 100,
        'orderItems.0.lineSubtotal': 100,
        'orderSummary.subtotal': 200,
        'orderSummary.totalAmount': 200,
      },
    });
    await Order.updateOne({ _id: order._id }, {
      $push: {
        orderItems: {
          productId: productB._id,
          seller: sellerB,
          name: productB.name,
          image: productB.image,
          price: 100,
          lineSubtotal: 100,
          quantity: 1,
        },
        sellerShipping: {
          seller: sellerB,
          shippingMethod: { name: 'International', price: 0, estimatedDays: 8 },
        },
        sellerFulfillment: { seller: sellerB, status: 'pending' },
        sellerPolicies: { seller: sellerB, storeName: 'Second Status Store' },
      },
    });
    const transitionAt = new Date('2026-08-24T18:00:00.000Z');

    const first = await transitionOrderFulfillment({
      orderId: order._id,
      actorRole: 'seller',
      actorId: sellerB,
      newStatus: 'processing',
      at: transitionAt,
    });
    const replay = await transitionOrderFulfillment({
      orderId: order._id,
      actorRole: 'seller',
      actorId: sellerB,
      newStatus: 'processing',
      at: new Date('2026-08-24T18:05:00.000Z'),
    });

    expect(first.transition).toMatchObject({
      actorStatusChanged: true,
      aggregateStatusChanged: false,
      previousAggregateStatus: 'pending',
      currentAggregateStatus: 'pending',
      sellerTransitions: [{
        sellerId: sellerB.toString(),
        previousStatus: 'pending',
        status: 'processing',
      }],
    });
    expect(replay.transition).toMatchObject({
      actorStatusChanged: false,
      aggregateStatusChanged: false,
      sellerTransitions: [],
    });
    const records = await NotificationOutbox.find({
      aggregateId: String(order._id),
      eventType: 'order.seller_fulfillment_updated',
    }).lean();
    expect(records.map(record => record.channel).sort())
      .toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(new Set(records.map(record => record.eventKey)).size).toBe(1);
    for (const record of records) {
      expect(record.occurredAt).toEqual(transitionAt);
      expect(record.payload.data).toMatchObject({
        sellerId: sellerB.toString(),
        storeName: 'Second Status Store',
        itemNames: [productB.name],
        previousStatus: 'pending',
        status: 'processing',
      });
      expect(record.payload.data.itemNames).not.toContain(productA.name);
      expect(record.money).toEqual([expect.objectContaining({
        amountMinor: 10000,
        currency: 'PKR',
      })]);
    }
  });

  test('cancellation and its retry preserve one buyer event and never claim that a refund occurred', async () => {
    const product = await createProduct('pkr-cancellation-outbox');
    const order = await createOrder({
      suffix: 'PKR-CANCELLATION-OUTBOX',
      product,
      currency: 'PKR',
      totalAmount: 1880,
    });
    const cancelledAt = new Date('2026-08-24T17:30:00.000Z');

    const first = await cancelOrderSafely({
      orderId: order._id,
      reason: 'Buyer cancelled before fulfillment.',
      cancellationActorRole: 'buyer',
      at: cancelledAt,
    });
    const replay = await cancelOrderSafely({
      orderId: order._id,
      reason: 'Administrator replayed cancellation.',
      cancellationActorRole: 'admin',
      at: new Date('2026-08-24T17:35:00.000Z'),
    });

    expect(first).toMatchObject({ status: 'cancelled', alreadyCancelled: false });
    expect(replay).toMatchObject({ status: 'cancelled', alreadyCancelled: true });
    expect(await Order.findById(order._id).lean()).toMatchObject({
      confirmation: {
        cancelledAt,
        cancelledByRole: 'buyer',
        cancelledVia: 'dashboard',
      },
    });
    const records = await NotificationOutbox.find({
      aggregateId: String(order._id),
      eventType: 'order.status_updated',
      'recipient.audienceRole': 'buyer',
    }).lean();
    expect(records.map(record => record.channel).sort())
      .toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(new Set(records.map(record => record.eventKey)).size).toBe(1);
    for (const record of records) {
      expect(record.occurredAt).toEqual(cancelledAt);
      expect(record.money).toEqual([expect.objectContaining({
        amountMinor: 188000,
        currency: 'PKR',
      })]);
      expect(record.payload.data.changedByRole).toBe('buyer');
      const rendered = record.payload.body
        || record.payload.text
        || record.payload.html
        || record.payload.message;
      expect(rendered).toContain('Rs1,880.00 PKR');
      expect(rendered).toMatch(/does not by itself record or promise a refund/i);
      expect(rendered).not.toMatch(/refunded|refund (was|has been)|credited/i);
    }
  });

  test('fails closed instead of regressing an inconsistent higher aggregate status', async () => {
    const product = await createProduct('aggregate-regression-guard');
    const order = await createOrder({
      suffix: 'AGGREGATE-REGRESSION-GUARD',
      product,
      orderStatus: 'processing',
    });
    await Order.updateOne(
      { _id: order._id },
      { $set: { 'sellerFulfillment.0.status': 'confirmed' } },
    );

    await expect(transitionOrderFulfillment({
      orderId: order._id,
      actorRole: 'seller',
      actorId: sellerId,
      newStatus: 'confirmed',
    })).rejects.toMatchObject({
      code: 'ORDER_STATUS_TRANSITION_INVALID',
      currentStatus: 'confirmed',
    });

    const persisted = await Order.findById(order._id).lean();
    expect(persisted.orderStatus).toBe('processing');
    expect(persisted.sellerFulfillment[0].status).toBe('confirmed');
  });

  test('delivered and cancelled orders are terminal in the generic fulfillment state machine', async () => {
    const deliveredProduct = await createProduct('terminal-delivered');
    const cancelledProduct = await createProduct('terminal-cancelled');
    const delivered = await createOrder({
      suffix: 'TERMINAL-DELIVERED',
      product: deliveredProduct,
      orderStatus: 'delivered',
      isPaid: true,
    });
    const cancelled = await createOrder({
      suffix: 'TERMINAL-CANCELLED',
      product: cancelledProduct,
      orderStatus: 'cancelled',
      inventoryCommitted: false,
    });

    await expect(transitionOrderFulfillment({
      orderId: delivered._id,
      actorRole: 'admin',
      sellerIds: [sellerId],
      newStatus: 'processing',
    })).rejects.toMatchObject({
      code: 'ORDER_STATUS_TRANSITION_INVALID',
      currentStatus: 'delivered',
    });
    await expect(transitionOrderFulfillment({
      orderId: cancelled._id,
      actorRole: 'admin',
      sellerIds: [sellerId],
      newStatus: 'confirmed',
    })).rejects.toMatchObject({
      code: 'ORDER_STATUS_TRANSITION_INVALID',
      currentStatus: 'cancelled',
    });

    const [persistedDelivered, persistedCancelled] = await Promise.all([
      Order.findById(delivered._id).lean(),
      Order.findById(cancelled._id).lean(),
    ]);
    expect(persistedDelivered.orderStatus).toBe('delivered');
    expect(persistedDelivered.isPaid).toBe(true);
    expect(persistedCancelled.orderStatus).toBe('cancelled');
    expect(persistedCancelled.inventoryCommitted).toBe(false);
  });

  test('concurrent cancellation and delivery have one invariant-preserving winner', async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const product = await createProduct(`concurrent-${attempt}`);
      const order = await createOrder({ suffix: `CONCURRENT-${attempt}`, product });

      const results = await Promise.allSettled([
        transitionOrderFulfillment({
          orderId: order._id,
          actorRole: 'admin',
          sellerIds: [sellerId],
          newStatus: 'delivered',
        }),
        cancelOrderSafely({
          orderId: order._id,
          reason: 'Concurrent cancellation race test.',
        }),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);

      const [persisted, persistedProduct] = await Promise.all([
        Order.findById(order._id).lean(),
        Product.findById(product._id).lean(),
      ]);
      if (persisted.orderStatus === 'cancelled') {
        expect(persisted).toMatchObject({
          isPaid: false,
          isDelivered: false,
          inventoryCommitted: false,
        });
        expect(persisted.sellerFulfillment[0].status).toBe('cancelled');
        expect(persistedProduct.stock).toBe(10);
        expect(persistedProduct.totalSales).toBe(0);
      } else {
        expect(persisted).toMatchObject({
          orderStatus: 'delivered',
          isPaid: true,
          isDelivered: true,
          inventoryCommitted: true,
        });
        expect(persisted.sellerFulfillment[0].status).toBe('delivered');
        expect(persistedProduct.stock).toBe(9);
        expect(persistedProduct.totalSales).toBe(1);
      }
    }
  });

  test('buyer COD confirmation persists decision and fulfillment without manufacturing payment', async () => {
    const product = await createProduct('buyer-confirmation');
    const order = await createOrder({ suffix: 'BUYER-CONFIRMATION', product });

    const result = await confirmCodOrderByBuyer({
      orderId: order._id,
      token: order.confirmation.token,
      channel: 'email',
      sellerIds: [sellerId],
    });

    expect(result).toMatchObject({ status: 'confirmed', newlyConfirmed: true });
    const persisted = await Order.findById(order._id).lean();
    expect(persisted).toMatchObject({
      orderStatus: 'confirmed',
      inventoryCommitted: true,
      isPaid: false,
      isDelivered: false,
    });
    expect(persisted.sellerFulfillment[0].status).toBe('confirmed');
    expect(persisted.confirmation.confirmedVia).toBe('email');
    expect(persisted.confirmation.decidedVia).toBe('email');
    expect(persisted.confirmation.confirmedAt).toBeInstanceOf(Date);
  });

  test('buyer confirmation does not regress fulfillment that already started', async () => {
    const product = await createProduct('buyer-confirmation-started');
    const order = await createOrder({
      suffix: 'BUYER-CONFIRMATION-STARTED',
      product,
      orderStatus: 'processing',
    });

    const result = await confirmCodOrderByBuyer({
      orderId: order._id,
      channel: 'whatsapp',
      sellerIds: [sellerId],
      allowedExistingDecisionChannels: ['manual', 'admin'],
    });

    expect(result).toMatchObject({ status: 'fulfillment_started', newlyConfirmed: false });
    const persisted = await Order.findById(order._id).lean();
    expect(persisted.orderStatus).toBe('processing');
    expect(persisted.sellerFulfillment[0].status).toBe('processing');
    expect(persisted.confirmation.confirmedAt).toBeNull();
    expect(persisted.isPaid).toBe(false);
  });

  test('WhatsApp override of an early manual COD cancellation re-reserves stock exactly once', async () => {
    const product = await createProduct('buyer-reconfirm-manual');
    await Product.updateOne(
      { _id: product._id },
      { $set: { stock: 10, totalSales: 0 } },
    );
    const cancelledAt = new Date(Date.now() - 1000);
    const order = await createOrder({
      suffix: 'BUYER-RECONFIRM-MANUAL',
      product,
      orderStatus: 'cancelled',
      inventoryCommitted: false,
      confirmation: {
        token: 'manual-cancellation-confirmation-token',
        tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        declinedAt: cancelledAt,
        confirmedVia: 'manual',
        decidedAt: cancelledAt,
        decidedVia: 'manual',
      },
    });

    const first = await confirmCodOrderByBuyer({
      orderId: order._id,
      channel: 'whatsapp',
      sellerIds: [sellerId],
      allowedExistingDecisionChannels: ['manual', 'admin'],
    });
    const replay = await confirmCodOrderByBuyer({
      orderId: order._id,
      channel: 'whatsapp',
      sellerIds: [sellerId],
      allowedExistingDecisionChannels: ['manual', 'admin'],
    });

    expect(first).toMatchObject({ status: 'confirmed', newlyConfirmed: true, reconfirmed: true });
    expect(replay).toMatchObject({ status: 'already_confirmed', newlyConfirmed: false });
    const [persisted, persistedProduct] = await Promise.all([
      Order.findById(order._id).lean(),
      Product.findById(product._id).lean(),
    ]);
    expect(persisted).toMatchObject({
      orderStatus: 'confirmed',
      inventoryCommitted: true,
      isPaid: false,
    });
    expect(persisted.sellerFulfillment[0].status).toBe('confirmed');
    expect(persisted.confirmation.confirmedVia).toBe('whatsapp');
    expect(persisted.confirmation.decidedVia).toBe('whatsapp');
    expect(persisted.confirmation.declinedAt).toBeNull();
    expect(persistedProduct.stock).toBe(9);
    expect(persistedProduct.totalSales).toBe(1);
  });

  test('confirmation of a legacy uncommitted COD order rolls back when stock is unavailable', async () => {
    const product = await createProduct('buyer-confirmation-no-stock');
    await Product.updateOne(
      { _id: product._id },
      { $set: { stock: 0, totalSales: 0 } },
    );
    const order = await createOrder({
      suffix: 'BUYER-CONFIRMATION-NO-STOCK',
      product,
      inventoryCommitted: false,
    });

    await expect(confirmCodOrderByBuyer({
      orderId: order._id,
      channel: 'email',
      sellerIds: [sellerId],
    })).rejects.toMatchObject({ code: 'ORDER_STOCK_CHANGED' });

    const persisted = await Order.findById(order._id).lean();
    expect(persisted.orderStatus).toBe('pending');
    expect(persisted.inventoryCommitted).toBe(false);
    expect(persisted.sellerFulfillment[0].status).toBe('pending');
    expect(persisted.confirmation.confirmedAt).toBeNull();
  });

  test('concurrent email confirmation and cancellation cannot resurrect restored inventory', async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const product = await createProduct(`confirm-cancel-${attempt}`);
      const order = await createOrder({ suffix: `CONFIRM-CANCEL-${attempt}`, product });

      const results = await Promise.allSettled([
        confirmCodOrderByBuyer({
          orderId: order._id,
          token: order.confirmation.token,
          channel: 'email',
          sellerIds: [sellerId],
        }),
        cancelOrderSafely({
          orderId: order._id,
          reason: 'Concurrent buyer-confirmation cancellation race test.',
        }),
      ]);
      expect(results.every(result => result.status === 'fulfilled')).toBe(true);

      const [persisted, persistedProduct] = await Promise.all([
        Order.findById(order._id).lean(),
        Product.findById(product._id).lean(),
      ]);
      expect(persisted).toMatchObject({
        orderStatus: 'cancelled',
        inventoryCommitted: false,
        isPaid: false,
        isDelivered: false,
      });
      expect(persisted.sellerFulfillment[0].status).toBe('cancelled');
      expect(persistedProduct.stock).toBe(10);
      expect(persistedProduct.totalSales).toBe(0);
    }
  });

  test('concurrent WhatsApp confirm/cancel buttons have one durable decision winner', async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const product = await createProduct(`whatsapp-decision-${attempt}`);
      const order = await createOrder({ suffix: `WHATSAPP-DECISION-${attempt}`, product });

      const decisions = await Promise.all([
        applyFirstOrderDecision({ order, isYes: true }),
        applyFirstOrderDecision({ order, isYes: false }),
      ]);
      expect(decisions.filter(Boolean)).toHaveLength(1);

      const [persisted, persistedProduct] = await Promise.all([
        Order.findById(order._id).lean(),
        Product.findById(product._id).lean(),
      ]);
      if (persisted.orderStatus === 'cancelled') {
        expect(persisted).toMatchObject({
          inventoryCommitted: false,
          isPaid: false,
          isDelivered: false,
        });
        expect(persisted.confirmation.declinedAt).toBeInstanceOf(Date);
        expect(persisted.confirmation.decidedVia).toBe('whatsapp');
        expect(persistedProduct).toMatchObject({ stock: 10, totalSales: 0 });
      } else {
        expect(persisted).toMatchObject({
          orderStatus: 'confirmed',
          inventoryCommitted: true,
          isPaid: false,
          isDelivered: false,
        });
        expect(persisted.confirmation.confirmedAt).toBeInstanceOf(Date);
        expect(persisted.confirmation.decidedVia).toBe('whatsapp');
        expect(persistedProduct).toMatchObject({ stock: 9, totalSales: 1 });
      }
    }
  });

  test('a WhatsApp decline records one buyer override of an early manual cancellation', async () => {
    const product = await createProduct('whatsapp-manual-cancel-override');
    await Product.updateOne(
      { _id: product._id },
      { $set: { stock: 10, totalSales: 0 } },
    );
    const manualAt = new Date(Date.now() - 60_000);
    const order = await createOrder({
      suffix: 'WHATSAPP-MANUAL-CANCEL-OVERRIDE',
      product,
      orderStatus: 'cancelled',
      inventoryCommitted: false,
      confirmation: {
        token: 'whatsapp-manual-cancel-override-token',
        tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        declinedAt: manualAt,
        confirmedVia: 'manual',
        decidedAt: manualAt,
        decidedVia: 'manual',
      },
    });

    const first = await applyFirstOrderDecision({ order, isYes: false });
    const replay = await applyFirstOrderDecision({ order, isYes: false });

    expect(first?.order).toBeTruthy();
    expect(replay).toBeNull();
    const [persisted, persistedProduct] = await Promise.all([
      Order.findById(order._id).lean(),
      Product.findById(product._id).lean(),
    ]);
    expect(persisted).toMatchObject({
      orderStatus: 'cancelled',
      inventoryCommitted: false,
      isPaid: false,
    });
    expect(persisted.confirmation.confirmedVia).toBe('whatsapp');
    expect(persisted.confirmation.decidedVia).toBe('whatsapp');
    expect(persisted.confirmation.declinedAt.getTime()).toBeGreaterThan(manualAt.getTime());
    expect(persistedProduct).toMatchObject({ stock: 10, totalSales: 0 });
  });
});
