'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../../models/User');
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const Cancellation = require('../../models/OrderCancellation');
const Payment = require('../../models/SafepayPayment');
const Outbox = require('../../models/NotificationOutbox');
const Notification = require('../../models/Notification');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const { buildOrderSellerSettlement, buildOrderSellerCurrencyMoney } = require('../../services/orderMoneyService');
const { cancelBuyerOrder, notifyCancellation } = require('../../services/buyerCancellationService');
const { deliverNotificationRecord } = require('../../services/notificationOutboxDeliveryService');
let replica;
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await Promise.all([User, Order, Product, Cancellation, Payment, Outbox, Notification, Wallet, WalletTransaction,
    require('../../models/SellerSettlementLock')].map(model => model.init()));
}, 60000);
afterAll(async () => { await mongoose.disconnect(); if (replica) await replica.stop(); }, 60000);
afterEach(async () => { await Promise.all(Object.values(mongoose.models).map(model => model.deleteMany({}))); });

async function fixture(method, longNames = false) {
  const users = await User.create(['user', 'seller', 'seller'].map((role, index) => ({
    username: `notification-${index}`, email: `notification-${index}@example.com`, password: 'test-only-password', role,
  })));
  const [buyer, ...sellers] = users;
  const products = await Product.create(sellers.map((seller, index) => ({ seller: seller._id,
    name: longNames ? `Travel Mug ${'detail '.repeat(38)}` : `Cup ${index}`, description: 'A reusable cup',
    price: index ? 20 : 10, stock: 4, totalSales: 1, currency: 'USD', priceCurrency: 'USD',
    category: 'Home', brand: 'QA', image: 'https://example.com/cup.png' })));
  const raw = {
    user: buyer._id, currency: 'USD', orderId: `ORD-NOTIFY-${new mongoose.Types.ObjectId()}`,
    orderItems: products.map((product, index) => ({ productId: product._id, seller: product.seller,
      name: product.name, image: product.image, quantity: 1, price: index ? 20 : 10,
      lineSubtotal: index ? 20 : 10, sourcePrice: index ? 20 : 10, sourceLineSubtotal: index ? 20 : 10,
      sourceCurrency: 'USD', selectedOptions: { Color: longNames ? 'Green '.repeat(60) : 'Green' } })),
    sellerPolicies: sellers.map((seller, index) => ({ seller: seller._id, productCurrency: 'USD', storeName: `Store ${index}` })),
    sellerShipping: sellers.map(seller => ({ seller: seller._id, shippingMethod: {
      name: 'standard', price: 2, sourceCost: 2, sourceCurrency: 'USD', estimatedDays: 3 } })),
    shippingMethod: { name: 'standard', price: 4, estimatedDays: 3 },
    sellerFulfillment: sellers.map((seller, index) => ({ seller: seller._id, status: index ? 'shipped' : 'confirmed' })),
    shippingInfo: { fullName: 'Notification Buyer', email: buyer.email, phone: '+12025550121', address: 'QA Street',
      city: 'Lahore', state: 'Punjab', postalCode: '54000', country: 'Pakistan' },
    orderSummary: { subtotal: 30, shippingCost: 4, tax: 0, couponDiscount: 0, totalAmount: 34 },
    paymentMethod: method, isPaid: method !== 'cash_on_delivery', awaitingPayment: false,
    inventoryCommitted: true, orderStatus: 'confirmed', exchangeRateSnapshot: {
      base: 'USD', rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 }, capturedAt: new Date(), source: 'test', fallback: false },
  };
  raw.sellerSettlementVersion = 1; raw.sellerSettlement = buildOrderSellerSettlement(raw, { requireOrderTotal: true });
  raw.sellerCurrencyMoneyVersion = 1; raw.sellerCurrencyMoney = buildOrderSellerCurrencyMoney(raw);
  if (method === 'safepay') { raw.safepayPaymentId = new mongoose.Types.ObjectId(); raw.safepayEnvironment = 'sandbox'; }
  const order = await Order.create(raw);
  if (method === 'safepay') await Payment.create({ _id: order.safepayPaymentId, user: buyer._id, order: order._id,
    purpose: 'order', environment: 'sandbox', status: 'paid', providerState: 'TRACKER_ENDED',
    amountMinor: 3400, capturedMinor: 3400, currency: 'USD', appliedAt: new Date(), paidAt: new Date(),
    tracker: `track_${new mongoose.Types.ObjectId()}`, reference: `order:${order._id}`, requestKey: `test:${order._id}`,
    fingerprint: 'a'.repeat(64), termsHash: 'test-notification', terms: {}, riskPending: false } );
  return { buyer, sellers, products, order };
}

test.each(['cash_on_delivery', 'wallet', 'safepay'])('%s cancellation commits with all real notification envelopes and replays once', async method => {
  const f = await fixture(method);
  const result = await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer._id, sellerIds: [String(f.sellers[0]._id)] });
  expect(result.sellerFulfillment.map(row => row.status)).toEqual(['cancelled', 'shipped']);
  const records = await Outbox.find({ aggregateType: 'OrderCancellation' }).select('+dedupeKey').lean();
  expect(records).toHaveLength(8);
  expect(records.filter(record => record.recipient.audienceRole === 'buyer').every(record => record.payload.channelId === 'orders')).toBe(true);
  expect(records.every(record => record.payload.body?.length <= 1000)).toBe(true);
  expect(records.filter(record => record.recipient.audienceRole === 'seller').every(record => record.recipient.allowBlocked)).toBe(true);
  for (const record of records.filter(row => row.channel === 'inapp')) {
    expect((await deliverNotificationRecord(record)).outcome).toBe('delivered');
  }
  expect(await Notification.countDocuments()).toBe(2);
  await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer._id, sellerIds: [String(f.sellers[0]._id)] });
  expect(await Outbox.countDocuments()).toBe(8);
  expect((await Product.findById(f.products[0]._id)).stock).toBe(5);
  expect((await Product.findById(f.products[1]._id)).stock).toBe(4);
  expect(await WalletTransaction.countDocuments()).toBe(method === 'wallet' ? 1 : 0);
});

test('large option descriptions keep the refund amount in the bounded push/inapp preview', async () => {
  const f = await fixture('wallet', true);
  await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer._id, sellerIds: [String(f.sellers[0]._id)] });
  const records = await Outbox.find({ channel: { $in: ['inapp', 'push'] } }).lean();
  expect(records).toHaveLength(4);
  for (const record of records) { expect(record.payload.body.length).toBeLessThanOrEqual(1000); expect(record.payload.body).toContain('$12.00 USD'); }
});

test('a cancelled store in a live mixed order is not described as awaiting delivery for returns', async () => {
  const f = await fixture('wallet');
  const order = await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer._id, sellerIds: [String(f.sellers[0]._id)] });
  const { buildOrderReturnEligibility } = require('../../services/returnService');
  const groups = await buildOrderReturnEligibility(order);
  const cancelled = groups.find(group => String(group.seller._id) === String(f.sellers[0]._id));
  expect(cancelled.eligible).toBe(false);
  expect(cancelled.reason).toBe('Cancelled store items cannot be returned.');
});

test('verified card-refund notifications reach a blocked seller without granting buyer access', async () => {
  const f = await fixture('safepay');
  const order = await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer._id, sellerIds: [String(f.sellers[0]._id)] });
  const row = await Cancellation.findOne({ order: order._id });
  row.refundStatus = 'refunded'; row.refundedAt = new Date(); await row.save();
  await User.updateOne({ _id: f.sellers[0]._id }, { $set: { status: 'blocked' } });
  await notifyCancellation(row, order, { completed: true });
  const record = await Outbox.findOne({ eventType: 'order.cancellation_refund_completed', channel: 'inapp',
    'recipient.audienceRole': 'seller' }).select('+dedupeKey').lean();
  expect((await deliverNotificationRecord(record)).outcome).toBe('delivered');
  expect(record.payload.body).toContain('$12.00 USD');
  const { blockedRecipientEventAllowed } = require('../../services/notificationOutboxService');
  expect(blockedRecipientEventAllowed('order.cancellation_refund_completed', 'buyer')).toBe(false);
});
