'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
jest.mock('../../services/notificationOutboxService', () => ({ enqueueNotificationEvent: jest.fn(async () => {}) }));
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const Cancellation = require('../../models/OrderCancellation');
const Payment = require('../../models/SafepayPayment');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const { buildOrderSellerSettlement, buildOrderSellerCurrencyMoney } = require('../../services/orderMoneyService');
const { cancelBuyerOrder, chooseCancellationSellers } = require('../../services/buyerCancellationService');
const { enqueueNotificationEvent } = require('../../services/notificationOutboxService');
let replica;
beforeAll(async () => { replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(replica.getUri());
  await Promise.all([Order, Product, Cancellation, Payment, Wallet, WalletTransaction, require('../../models/SellerSettlementLock')].map(model => model.init())); }, 60000);
afterAll(async () => { await mongoose.disconnect(); if (replica) await replica.stop(); }, 60000);
afterEach(async () => { await Promise.all(Object.values(mongoose.models).map(model => model.deleteMany({}))); jest.clearAllMocks(); });
async function fixture(method = 'wallet', statusB = 'confirmed') {
  const buyer = new mongoose.Types.ObjectId(), sellers = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  const products = await Product.create(sellers.map((seller, index) => ({ seller, name: `Cup ${index}`, description: 'Reusable cup',
    price: index ? 20 : 10, currency: 'USD', priceCurrency: 'USD', stock: 4, totalSales: 1,
    category: 'Home', brand: 'Test', image: 'https://example.com/cup.png' })));
  const raw = { user: buyer, currency: 'USD', orderId: `ORD-QA-${new mongoose.Types.ObjectId()}`,
    orderItems: products.map((product, index) => ({ productId: product._id, seller: product.seller, name: product.name,
      price: index ? 20 : 10, lineSubtotal: index ? 20 : 10, sourcePrice: index ? 20 : 10,
      sourceLineSubtotal: index ? 20 : 10, sourceCurrency: 'USD', quantity: 1, returnPolicySnapshotVersion: 1,
      returnPolicy: { returnsEnabled: false, returnDuration: 0, refundType: 'none' } })),
    sellerPolicies: sellers.map((seller, index) => ({ seller, productCurrency: 'USD', storeName: `Store ${index}` })),
    sellerShipping: sellers.map(seller => ({ seller, shippingMethod: { name: 'standard', price: 2, sourceCost: 2, sourceCurrency: 'USD', estimatedDays: 3 } })),
    shippingMethod: { name: 'standard', price: 4, estimatedDays: 3 },
    sellerFulfillment: sellers.map((seller, index) => ({ seller, status: index ? statusB : 'confirmed' })),
    orderSummary: { subtotal: 30, shippingCost: 4, tax: 0, couponDiscount: 0, totalAmount: 34 },
    shippingInfo: { fullName: 'QA Buyer', email: 'qa@example.com', phone: '+923001234567', address: 'QA Street', city: 'Lahore', state: 'Punjab', postalCode: '54000', country: 'Pakistan' },
    paymentMethod: method, isPaid: method !== 'cash_on_delivery', inventoryCommitted: true, awaitingPayment: false, orderStatus: 'confirmed',
    exchangeRateSnapshot: { base: 'USD', rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 }, capturedAt: new Date(), source: 'test', fallback: false },
  };
  raw.sellerSettlementVersion = 1; raw.sellerSettlement = buildOrderSellerSettlement(raw, { requireOrderTotal: true });
  raw.sellerCurrencyMoneyVersion = 1; raw.sellerCurrencyMoney = buildOrderSellerCurrencyMoney(raw);
  if (method === 'safepay') { raw.safepayPaymentId = new mongoose.Types.ObjectId(); raw.safepayEnvironment = 'sandbox'; }
  const order = await Order.create(raw);
  const result = { buyer, sellers, products, order };
  if (method === 'safepay') await cardPayment(result);
  return result;
}
test('Wallet cancellation refunds only the selected unshipped seller, including its shipping', async () => {
  const f = await fixture('wallet', 'shipped');
  const cancelled = await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer, sellerIds: [String(f.sellers[0])] });
  expect(cancelled.sellerFulfillment.map(row => row.status)).toEqual(['cancelled', 'shipped']);
  expect(cancelled.orderSummary.totalAmount).toBe(34);
  expect((await Wallet.findOne({ user: f.buyer })).balances.USD).toBe(12);
  expect((await Product.findById(f.products[0]._id)).stock).toBe(5);
  expect((await Product.findById(f.products[1]._id)).stock).toBe(4);
  expect(await Cancellation.countDocuments()).toBe(1);
  expect(enqueueNotificationEvent).toHaveBeenCalledTimes(2);
});
test('parallel repeated cancellations refund and restore stock exactly once', async () => {
  const f = await fixture();
  await require('../../models/SellerSettlementLock').create({ seller: f.sellers[0], version: 0 });
  await Promise.all([1, 2].map(() => cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer, sellerIds: [String(f.sellers[0])] })));
  expect(await Cancellation.countDocuments()).toBe(1);
  expect(await WalletTransaction.countDocuments()).toBe(1);
  expect((await Wallet.findOne({ user: f.buyer })).balances.USD).toBe(12);
  expect((await Product.findById(f.products[0]._id)).stock).toBe(5);
});
test('whole-order cancellation is refused when any seller has shipped', async () => {
  const f = await fixture('wallet', 'shipped');
  await expect(cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer })).rejects.toMatchObject({ code: 'ORDER_FULFILLMENT_STARTED' });
  expect(await Cancellation.countDocuments()).toBe(0);
  expect(await Wallet.countDocuments()).toBe(0);
});
test('all unshipped Wallet portions cancel and refund exactly the frozen checkout total', async () => {
  const f = await fixture();
  const order = await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer });
  expect(order.orderStatus).toBe('cancelled'); expect(order.inventoryCommitted).toBe(false);
  expect((await Wallet.findOne({ user: f.buyer })).balances.USD).toBe(34);
  expect(await WalletTransaction.countDocuments()).toBe(2);
});
test('COD cancellation makes no Wallet credit or provider payment', async () => {
  const f = await fixture('cash_on_delivery');
  await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer });
  expect(await WalletTransaction.countDocuments()).toBe(0);
  expect((await Cancellation.find({})).every(row => row.refundStatus === 'not_required')).toBe(true);
});
test('Safepay cancellation records a durable original-card refund, not a Wallet credit', async () => {
  const f = await fixture('safepay', 'shipped');
  await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer, sellerIds: [String(f.sellers[0])] });
  const row = await Cancellation.findOne({});
  expect(row).toMatchObject({ amountMinor: 1200, refundStatus: 'pending', refundDestination: 'original_card' });
  expect(await WalletTransaction.countDocuments()).toBe(0);
});
test('a different buyer cannot cancel the order', async () => {
  const f = await fixture();
  await expect(cancelBuyerOrder({ orderId: f.order._id, buyerId: new mongoose.Types.ObjectId() })).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
  expect(await Cancellation.countDocuments()).toBe(0);
});
test('later whole-order cleanup does not restore a previously cancelled portion twice', async () => {
  const f = await fixture('cash_on_delivery');
  await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer, sellerIds: [String(f.sellers[0])] });
  await require('../../services/orderInventoryService').restoreOrderInventory(f.order._id);
  expect((await Product.findById(f.products[0]._id)).stock).toBe(5);
  expect((await Product.findById(f.products[1]._id)).stock).toBe(5);
});
test('a later COD confirmation cannot resurrect a cancelled seller portion', async () => {
  const f = await fixture('cash_on_delivery');
  const order = await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer, sellerIds: [String(f.sellers[0])] });
  require('../../services/orderFulfillmentService').setAllSellerFulfillmentStatus(order, 'confirmed');
  expect(order.sellerFulfillment.map(row => row.status)).toEqual(['cancelled', 'confirmed']);
});
test('invalid/duplicate seller scope and shipped scope fail closed', () => {
  const order = { sellerFulfillment: [{ seller: 'A', status: 'processing' }, { seller: 'B', status: 'delivered' }] };
  expect(chooseCancellationSellers(order, ['A'])).toEqual(['A']);
  expect(() => chooseCancellationSellers(order, ['B'])).toThrow();
  expect(() => chooseCancellationSellers(order, ['A', 'A'])).toThrow();
  expect(() => chooseCancellationSellers(order, ['C'])).toThrow();
});

async function cardPayment(f) {
  const existing = await Payment.findById(f.order.safepayPaymentId);
  if (existing) return existing;
  return Payment.create({ _id: f.order.safepayPaymentId, user: f.buyer, order: f.order._id, environment: 'sandbox', purpose: 'order',
    reference: `order:${f.order._id}`, requestKey: 'qa-cancellation-key', fingerprint: 'a'.repeat(64),
    amountMinor: 3400, currency: 'USD', tracker: `track_${new mongoose.Types.ObjectId()}`, status: 'paid',
    capturedMinor: 3400, appliedAt: new Date(), paidAt: new Date() });
}
function trackerRefund(payment, amount = 1200) {
  return { token: payment.tracker, state: amount === 3400 ? 'TRACKER_REFUNDED' : 'TRACKER_PARTIAL_REFUND',
    charge: { token: 'charge_qa', tracker: payment.tracker, amount: { currency: 'USD', amount: 3400 },
      capture: { totals: { currency: 'USD', amount: 3400 } }, balance: { currency: 'USD', amount: 3400 - amount },
      cybersource_refunds: [{ token: 'refund_qa-cancellation', tracker: payment.tracker, totals: { currency: 'USD', amount }, created_at: { seconds: Math.floor(Date.now() / 1000) } }] } };
}
test('a scoped Safepay refund cannot debit the shipped seller', async () => {
  const f = await fixture('safepay', 'shipped'), payment = await cardPayment(f);
  await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer, sellerIds: [String(f.sellers[0])] });
  await Cancellation.updateOne({ order: f.order._id }, { $set: { refundStatus: 'processing', submitStartedAt: new Date(), refundBaselineMinor: 0, refundTargetMinor: 1200 } });
  const tracker = trackerRefund(payment);
  const evidence = require('../../services/safepayRefundService').refundEvidence(tracker, payment);
  await mongoose.connection.transaction(session => require('../../services/cancellationRefundService').reconcileCancellationRefund(payment, tracker, session, evidence));
  expect((await Cancellation.findOne({})).refundStatus).toBe('refunded');
  const event = await require('../../models/SafepayRefundEvent').findOne({});
  expect(event.sellerAllocations).toHaveLength(1); expect(String(event.sellerAllocations[0].seller)).toBe(String(f.sellers[0]));
  expect((await Order.findById(f.order._id)).sellerFulfillment[1].status).toBe('shipped');
  expect(await require('../../models/SellerBalanceTransaction').countDocuments()).toBe(0);
});
test('provider refunds with the wrong amount cannot be attributed or marked completed', async () => {
  const f = await fixture('safepay'), payment = await cardPayment(f);
  await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer, sellerIds: [String(f.sellers[0])] });
  await Cancellation.updateOne({ order: f.order._id }, { $set: { refundStatus: 'processing', submitStartedAt: new Date(), refundBaselineMinor: 0, refundTargetMinor: 1200 } });
  const tracker = trackerRefund(payment, 1199), evidence = require('../../services/safepayRefundService').refundEvidence(tracker, payment);
  await expect(mongoose.connection.transaction(session => require('../../services/cancellationRefundService').reconcileCancellationRefund(payment, tracker, session, evidence)))
    .resolves.toMatchObject({ resolved: false, status: 'manual_review' });
  expect((await Cancellation.findOne({})).refundStatus).toBe('manual_review');
  expect(await require('../../models/SellerPaymentRiskHold').countDocuments({ status: 'pending' })).toBe(2);
  expect(await require('../../models/SafepayRefundEvent').countDocuments()).toBe(0);
});
test('an ambiguous refund response is recovered read-only and never POSTed twice', async () => {
  const f = await fixture('safepay'), payment = await cardPayment(f);
  await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer, sellerIds: [String(f.sellers[0])] });
  const config = jest.spyOn(require('../../config/safepay'), 'readSafepayConfig').mockReturnValue({ environment: 'sandbox' });
  const refund = jest.fn(async () => { throw Object.assign(new Error('Response lost'), { outcomeUnknown: true }); });
  const tracker = { token: payment.tracker, state: 'TRACKER_ENDED', charge: { cybersource_refunds: [] } };
  const client = { getTracker: jest.fn().mockResolvedValueOnce(tracker).mockResolvedValue(trackerRefund(payment)), refundPaymentAmount: refund };
  const factory = jest.spyOn(require('../../services/safepayClient'), 'createSafepayClient').mockReturnValue(client);
  try {
    const { processCancellationRefund } = require('../../services/cancellationRefundService');
    await processCancellationRefund(payment._id); await processCancellationRefund(payment._id); await processCancellationRefund(payment._id);
    expect(refund).toHaveBeenCalledTimes(1);
    expect((await Cancellation.findOne({})).refundStatus).toBe('refunded');
    expect((await Payment.findById(payment._id)).refundedMinor).toBe(1200);
  } finally { config.mockRestore(); factory.mockRestore(); }
});
