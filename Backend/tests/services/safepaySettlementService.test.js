'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Payment = require('../../models/SafepayPayment');
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const User = require('../../models/User');
const Store = require('../../models/Store');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const NotificationOutbox = require('../../models/NotificationOutbox');
const SellerPaymentRiskHold = require('../../models/SellerPaymentRiskHold');
const SellerSettlementLock = require('../../models/SellerSettlementLock');
const SellerBalanceTransaction = require('../../models/SellerBalanceTransaction');
const RefundEvent = require('../../models/SafepayRefundEvent');
const { computeNativeSellerAccounting } = require('../../services/sellerNativeAccountingService');
const { createSafepayPaymentService } = require('../../services/safepayPaymentService');
const { commitOrderInventory } = require('../../services/orderInventoryService');
const { buildOrderSellerSettlement, buildOrderSellerCurrencyMoney } = require('../../services/orderMoneyService');
const { getWalletSummary } = require('../../services/walletService');
let replica;
let service;
let providerState;
let clock;
let providerCharge;
let refundRequest;
const config = { environment: 'sandbox' };
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await Promise.all([Payment.init(), Order.init(), Wallet.init(), WalletTransaction.init(), NotificationOutbox.init(), SellerPaymentRiskHold.init(), SellerSettlementLock.init()]);
  await Promise.all([SellerBalanceTransaction.init(), RefundEvent.init()]);
}, 120000);
afterAll(async () => { await mongoose.disconnect(); await replica?.stop(); });
beforeEach(async () => {
  for (const model of [Payment, Order, Product, Wallet, WalletTransaction, NotificationOutbox, SellerPaymentRiskHold, SellerSettlementLock]) await model.deleteMany({});
  for (const model of [SellerBalanceTransaction, RefundEvent]) await model.deleteMany({});
  for (const model of [User, Store]) await model.deleteMany({});
  clock = new Date();
  providerState = 'TRACKER_ENDED';
  providerCharge = undefined;
  refundRequest = jest.fn(async () => {});
  service = createSafepayPaymentService({ configFor: () => config, now: () => clock,
    clientFor: () => ({ getTracker: async () => ({ state: providerState, charge: providerCharge }), refundRemainingPayment: refundRequest }) });
});

async function makeOrder({ deferred = false } = {}) {
  const buyer = new mongoose.Types.ObjectId(), seller = new mongoose.Types.ObjectId();
  if (deferred) {
    await User.create({ _id: seller, username: 'Late Payment Seller', email: 'late-seller@example.com', role: 'seller', status: 'active' });
    await Store.create({ seller, storeName: 'Late Payment Test', storeSlug: 'late-payment-test', isActive: true,
      productCurrency: 'PKR', productCurrencyStatus: 'active', moderationStatus: 'approved', visibility: { mode: 'global' } });
  }
  const product = await Product.create({ name: 'Safepay Test Mug', description: 'Sandbox fixture', price: 2800, priceCurrency: 'PKR',
    currency: 'PKR', category: 'Test', brand: 'Test', stock: 5, seller, image: 'https://example.com/mug.png', images: [{ url: 'https://example.com/mug.png' }] });
  const order = new Order({ user: buyer, orderId: `ORD-SAFEPAY-${new mongoose.Types.ObjectId()}`, currency: 'USD',
    orderItems: [{ productId: product._id, seller, name: product.name, image: product.image, quantity: 1, price: 10, lineSubtotal: 10,
      sourcePrice: 2800, sourceLineSubtotal: 2800, sourceCurrency: 'PKR' }],
    orderSummary: { subtotal: 10, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 10 },
    shippingInfo: { fullName: 'Sandbox Buyer', email: 'sandbox@example.com', phone: '+923001234567', address: 'Test Street', city: 'Lahore', state: 'Punjab', postalCode: '54000', country: 'Pakistan' },
    shippingMethod: { name: 'free', price: 0, estimatedDays: 3, seller },
    sellerShipping: [{ seller, shippingMethod: { name: 'free', price: 0, estimatedDays: 3, sourceCost: 0, sourceCurrency: 'PKR' } }],
    sellerPolicies: [{ seller, productCurrency: 'PKR' }], sellerFulfillment: [{ seller, status: 'pending' }],
    exchangeRateSnapshot: { base: 'USD', rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 }, capturedAt: clock, source: 'test-historical', fallback: false },
    paymentMethod: 'safepay', paymentFlow: 'safepay_hosted', safepayEnvironment: 'sandbox', awaitingPayment: true, paymentSetupState: 'ready' });
  order.sellerSettlementVersion = 1;
  order.sellerSettlement = buildOrderSellerSettlement(order, { requireOrderTotal: true });
  order.sellerCurrencyMoneyVersion = 1;
  order.sellerCurrencyMoney = buildOrderSellerCurrencyMoney(order);
  const payment = await service.ensurePayment({ user: buyer, purpose: 'order', reference: `order:${order._id}`, requestKey: `checkout:${order._id}`, amountMinor: 1000, currency: 'USD', order: order._id,
    ...(deferred ? { terms: { settlementPolicy: 'revalidate-on-payment-v1' } } : {}) });
  payment.status = 'ready'; payment.tracker = 'track_owned-sandbox-order'; await payment.save();
  order.safepayPaymentId = payment._id; order.safepayTrackerId = payment.tracker;
  await order.save();
  if (!deferred) await commitOrderInventory(order._id);
  return { payment, order, buyer, seller, product };
}

test('actual order completion preserves native seller money, inventory and notifications exactly once', async () => {
  const f = await makeOrder();
  const nativeBefore = JSON.stringify((await Order.findById(f.order._id)).sellerCurrencyMoney);
  await service.reconcilePayment(f.payment._id);
  const firstNotifications = await NotificationOutbox.countDocuments();
  await service.reconcilePayment(f.payment._id);
  const result = await Order.findById(f.order._id);
  expect(result.isPaid).toBe(true); expect(result.awaitingPayment).toBe(false);
  expect(result.confirmation.confirmedVia).toBe('safepay_payment');
  expect(result.orderStatus).toBe('confirmed');
  expect(JSON.stringify(result.sellerCurrencyMoney)).toBe(nativeBefore);
  expect((await Product.findById(f.product._id)).stock).toBe(4);
  expect(firstNotifications).toBeGreaterThan(0);
  expect(await NotificationOutbox.countDocuments()).toBe(firstNotifications);
});

test('verified cancellation releases the single stock reservation without marking paid', async () => {
  const f = await makeOrder();
  providerState = 'TRACKER_CANCELLED';
  await service.reconcilePayment(f.payment._id);
  await service.reconcilePayment(f.payment._id);
  const result = await Order.findById(f.order._id);
  expect(result.isPaid).toBe(false); expect(result.orderStatus).toBe('cancelled');
  expect((await Product.findById(f.product._id)).stock).toBe(5);
});

test.each(['PKR', 'USD', 'EUR', 'GBP'])('Wallet top-up credits only its exact %s bucket and persists spendable provenance', async currency => {
  const buyer = new mongoose.Types.ObjectId();
  const payment = await service.ensurePayment({ user: buyer, purpose: 'wallet_top_up', reference: `wallet:${buyer}`, requestKey: `topup:${buyer}`, amountMinor: 12345, currency });
  payment.status = 'ready'; payment.tracker = 'track_owned-sandbox-wallet'; await payment.save();
  await service.reconcilePayment(payment._id);
  await service.reconcilePayment(payment._id);
  const wallet = await Wallet.findOne({ user: buyer });
  expect(wallet.balances[currency]).toBe(123.45);
  for (const other of ['PKR', 'USD', 'EUR', 'GBP'].filter(code => code !== currency)) expect(wallet.balances[other]).toBe(0);
  const rows = await WalletTransaction.find({ user: buyer });
  expect(rows).toHaveLength(1);
  expect(rows[0].metadata.fundingRemainingMinor).toBe(12345);
  expect(rows[0].metadata.fundingOriginalAvailableMinor).toBe(12345);
  expect(rows[0].safepayEnvironment).toBe('sandbox');
  const summary = await getWalletSummary(buyer);
  expect(summary.wallet.balances[currency]).toBe(123.45);
});

test('a verified refund/dispute creates a withdrawal hold instead of silently leaving money available', async () => {
  const f = await makeOrder();
  await service.reconcilePayment(f.payment._id);
  providerState = 'TRACKER_DISPUTED';
  await service.reconcilePayment(f.payment._id);
  const hold = await SellerPaymentRiskHold.findOne({ seller: f.seller });
  expect(hold.provider).toBe('safepay'); expect(hold.status).toBe('pending');
  expect((await Payment.findById(f.payment._id)).riskPending).toBe(true);
});

test('recovering a previously credited payment never replenishes an already-spent Wallet funding lot', async () => {
  const buyer = new mongoose.Types.ObjectId();
  const payment = await service.ensurePayment({ user: buyer, purpose: 'wallet_top_up', reference: `wallet:${buyer}`, requestKey: `topup:${buyer}`, amountMinor: 10000, currency: 'PKR' });
  payment.status = 'ready'; payment.tracker = 'track_recovered-wallet-funding'; await payment.save();
  await service.reconcilePayment(payment._id);
  await WalletTransaction.updateOne({ safepayPaymentId: payment._id }, { $set: { 'metadata.fundingRemainingMinor': 7000 } });
  // Simulate a restored payment checkpoint with the financial ledger intact.
  await Payment.updateOne({ _id: payment._id }, { $set: { status: 'ready', appliedAt: null } });
  await service.reconcilePayment(payment._id);
  expect((await WalletTransaction.findOne({ safepayPaymentId: payment._id })).metadata.fundingRemainingMinor).toBe(7000);
  expect((await Wallet.findOne({ user: buyer })).balances.PKR).toBe(100);
});

function refundCharge(payment, amounts) {
  const amount = amounts.reduce((a, b) => a + b, 0);
  providerState = amount === payment.amountMinor ? 'TRACKER_REFUNDED' : 'TRACKER_PARTIAL_REFUND';
  providerCharge = { token: 'ch_sandbox-refund', tracker: payment.tracker,
    amount: { currency: payment.currency, amount: payment.amountMinor },
    capture: { totals: { currency: payment.currency, amount: payment.amountMinor } },
    balance: { currency: payment.currency, amount: payment.amountMinor - amount },
    cybersource_refunds: amounts.map((value, index) => ({ token: `refund_sandbox-${index}`, tracker: payment.tracker,
      totals: { currency: payment.currency, amount: value }, created_at: { seconds: Math.floor(clock.getTime() / 1000) + index } })) };
}

test('partial then full USD refunds cancel exact native PKR seller revenue with no duplicate debit', async () => {
  const f = await makeOrder(); await service.reconcilePayment(f.payment._id);
  await Order.updateOne({ _id: f.order._id }, { $set: { orderStatus: 'delivered', isDelivered: true,
    'sellerFulfillment.0.status': 'delivered', 'sellerFulfillment.0.deliveredAt': clock } });
  refundCharge(f.payment, [251]); await service.reconcilePayment(f.payment._id);
  const beforeReplay = await NotificationOutbox.countDocuments();
  await service.reconcilePayment(f.payment._id);
  expect(await NotificationOutbox.countDocuments()).toBe(beforeReplay);
  let rows = await SellerBalanceTransaction.find({ seller: f.seller }).lean();
  expect(rows).toHaveLength(1); expect(rows[0].sourceAmount).toBe(2.51);
  expect(rows[0].referenceType).toBe('safepay_payment'); expect(rows[0].stripePaymentIntentId).toBeNull();
  refundCharge(f.payment, [251, 749]); await service.reconcilePayment(f.payment._id);
  rows = await SellerBalanceTransaction.find({ seller: f.seller }).lean();
  expect(rows.reduce((sum, row) => sum + Math.round(row.sourceAmount * 100), 0)).toBe(1000);
  const order = await Order.findById(f.order._id).lean();
  const summary = computeNativeSellerAccounting({ sellerId: f.seller, orders: [order], transactions: rows, reportingCurrency: 'PKR' });
  expect(summary.balanceByCurrency.PKR.paymentReversalDebits).toBe(2800);
  expect(summary.balanceByCurrency.PKR.withdrawableBalance).toBe(0);
  expect((await Payment.findById(f.payment._id)).status).toBe('refunded');
  expect(await RefundEvent.countDocuments()).toBe(2);
});

test('refunds expressed in the settlement currency instead of original payment currency remain on hold', async () => {
  const f = await makeOrder(); await service.reconcilePayment(f.payment._id);
  refundCharge(f.payment, [1000]); providerCharge.cybersource_refunds[0].totals.currency = 'PKR';
  await service.reconcilePayment(f.payment._id);
  expect((await Payment.findById(f.payment._id)).status).toBe('manual_review');
  expect(await SellerBalanceTransaction.countDocuments()).toBe(0);
  expect(await SellerPaymentRiskHold.countDocuments({ seller: f.seller, status: 'pending' })).toBe(1);
});

test('a complete refund arriving before fulfillment releases stock without granting seller revenue', async () => {
  const f = await makeOrder(); refundCharge(f.payment, [1000]);
  await service.reconcilePayment(f.payment._id);
  expect((await Payment.findById(f.payment._id)).status).toBe('refunded');
  expect((await Order.findById(f.order._id)).orderStatus).toBe('cancelled');
  expect((await Product.findById(f.product._id)).stock).toBe(5);
  expect(await SellerBalanceTransaction.countDocuments()).toBe(0);
});

test('a deferred valid order reserves stock exactly once when late payment arrives', async () => {
  const f = await makeOrder({ deferred: true });
  expect((await Product.findById(f.product._id)).stock).toBe(5);
  await service.reconcilePayment(f.payment._id);
  await service.reconcilePayment(f.payment._id);
  expect((await Order.findById(f.order._id)).isPaid).toBe(true);
  expect((await Product.findById(f.product._id)).stock).toBe(4);
  expect(refundRequest).not.toHaveBeenCalled();
});

test('sold-out stock schedules one safety refund and never grants an order', async () => {
  const f = await makeOrder({ deferred: true });
  await Product.updateOne({ _id: f.product._id }, { $set: { stock: 0 } });
  expect((await service.reconcilePayment(f.payment._id)).status).toBe('refund_pending');
  await service.reconcilePayment(f.payment._id);
  expect(refundRequest).toHaveBeenCalledTimes(1);
  expect((await Order.findById(f.order._id)).isPaid).toBe(false);
  expect((await Product.findById(f.product._id)).stock).toBe(0);
  refundCharge(f.payment, [1000]);
  expect((await service.reconcilePayment(f.payment._id)).status).toBe('refunded');
  expect((await Payment.findById(f.payment._id)).safetyRefund.outcome).toBe('confirmed');
});

test('an uncertain safety-refund response is polled, not submitted again', async () => {
  const f = await makeOrder({ deferred: true });
  await Product.updateOne({ _id: f.product._id }, { $set: { price: 2900 } });
  refundRequest.mockRejectedValue(Object.assign(new Error('timeout'), { outcomeUnknown: true }));
  await service.reconcilePayment(f.payment._id);
  await service.reconcilePayment(f.payment._id);
  expect(refundRequest).toHaveBeenCalledTimes(1);
  expect((await Payment.findById(f.payment._id)).safetyRefund.outcome).toBe('unknown');
  expect((await Order.findById(f.order._id)).orderSummary.totalAmount).toBe(10);
});

test('an explicit buyer cancellation stays cancelled if the old link is later paid', async () => {
  const f = await makeOrder({ deferred: true });
  await require('../../services/orderCancellationService').cancelOrderSafely({ orderId: f.order._id, cancellationActorRole: 'buyer', reason: 'Buyer cancelled.' });
  await service.reconcilePayment(f.payment._id);
  expect((await Order.findById(f.order._id)).orderStatus).toBe('cancelled');
  expect((await Payment.findById(f.payment._id)).status).toBe('refund_pending');
  expect(refundRequest).toHaveBeenCalledTimes(1);
});
