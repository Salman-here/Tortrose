'use strict';
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../../models/User');
const Order = require('../../models/Order');
const Payment = require('../../models/SafepayPayment');
const WalletTransaction = require('../../models/WalletTransaction');
const Cancellation = require('../../models/OrderCancellation');
const ReturnRequest = require('../../models/ReturnRequest');
const RiskHold = require('../../models/SellerPaymentRiskHold');
const verifyToken = require('../../middleware/authMiddleware');
const { getOrderReceipt } = require('../../controllers/orderReceiptController');
let replica, buyer, other, app;
const previousSecret = process.env.JWT_SECRET;
const token = user => jwt.sign({ id: String(user._id), role: user.role }, process.env.JWT_SECRET);
const get = (user, ref, query = '') => request(app).get(`/api/order/receipt/${ref}${query}`).set('Authorization', `Bearer ${token(user)}`);
beforeAll(async () => {
  process.env.JWT_SECRET = 'order-receipt-test-secret-only';
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(replica.getUri());
  await Promise.all([User, Order, Payment, WalletTransaction, Cancellation, ReturnRequest, RiskHold].map(model => model.init()));
  app = express(); app.get('/api/order/receipt/:reference', verifyToken, getOrderReceipt);
}, 120000);
afterAll(async () => { await mongoose.disconnect(); await replica?.stop(); if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret; });
beforeEach(async () => {
  await Promise.all([User, Order, Payment, WalletTransaction, Cancellation, ReturnRequest, RiskHold].map(model => model.deleteMany({})));
  buyer = await User.create({ username: 'Receipt buyer', email: 'receipt-buyer@example.com', role: 'user', status: 'active' });
  other = await User.create({ username: 'Other buyer', email: 'receipt-other@example.com', role: 'user', status: 'active' });
});
async function fixture({ method = 'cash_on_delivery', paid = false, rail = 'card', zero = false, owner = buyer, pending = false } = {}) {
  const seller = new mongoose.Types.ObjectId(), ref = new mongoose.Types.ObjectId(), at = new Date();
  const order = await Order.create({ user: owner._id, orderId: `ORD-${ref}`, currency: 'PKR',
    orderItems: [{ productId: new mongoose.Types.ObjectId(), seller, name: 'Receipt fixture', quantity: 1, price: 100,
      lineSubtotal: 100, sourcePrice: 100, sourceLineSubtotal: 100, sourceCurrency: 'PKR' }],
    orderSummary: { subtotal: 100, shippingCost: 0, tax: 0, couponDiscount: zero ? 100 : 0, totalAmount: zero ? 0 : 100 },
    shippingInfo: { fullName: 'Buyer fixture', email: owner.email, phone: '+923001234567', address: 'Fixture Street', city: 'Lahore', state: 'Punjab', postalCode: '54000', country: 'Pakistan' },
    shippingMethod: { name: 'free', price: 0, estimatedDays: 3, seller }, sellerFulfillment: [{ seller, status: paid ? 'confirmed' : 'pending' }],
    paymentMethod: method, paymentFlow: method === 'safepay' ? 'safepay_hosted' : 'checkout_session',
    isPaid: paid, awaitingPayment: pending, inventoryCommitted: !pending,
    paymentSetupState: method === 'wallet' && !zero ? 'closed' : paid ? 'complete' : 'ready',
    ...(method === 'safepay' && !zero ? { safepayEnvironment: 'sandbox' } : {}),
    ...(paid ? { paidAt: at, paymentFulfilledAt: at, orderStatus: 'confirmed', confirmation: { confirmedAt: at, confirmedVia: 'wallet_payment' } } : {}) });
  let payment, debit;
  if (method === 'safepay' && !zero) {
    payment = await Payment.create({ user: owner._id, order: order._id, environment: 'sandbox', purpose: 'order',
      reference: `order:${order._id}`, requestKey: `receipt:${order._id}`, fingerprint: 'a'.repeat(64), amountMinor: 10000,
      currency: 'PKR', status: paid ? 'paid' : 'ready', paymentRail: rail, providerIntent: rail === 'raast' ? 'RAAST' : 'CYBERSOURCE',
      tracker: `track_receipt-${order._id}`, capturedMinor: paid ? 10000 : 0, ...(paid ? { appliedAt: at, paidAt: at } : {}) });
    order.safepayPaymentId = payment._id; order.safepayTrackerId = payment.tracker; await order.save();
  }
  if (method === 'wallet' && paid && !zero) {
    debit = await WalletTransaction.create({ user: owner._id, type: 'order_payment', amount: 100, currency: 'PKR', direction: 'debit',
      status: 'completed', referenceType: 'order', referenceId: String(order._id), idempotencyKey: `wallet-order:${order._id}`,
      metadata: { fundingProvenance: [], untrackedFundingMinor: 10000 } });
    order.paymentResult.walletTransactionId = debit._id; await order.save();
  }
  return { order, payment, debit, seller };
}

test('COD placement is buyer-owned unpaid confirmation rather than a paid claim, regardless of query flags', async () => {
  const f = await fixture();
  const response = await get(buyer, f.order.orderId, '?payment=safepay&success=true');
  expect(response.status).toBe(200); expect(response.headers['cache-control']).toMatch(/no-store/);
  expect(response.body).toMatchObject({ version: 1, buyerId: String(buyer._id), mongoOrderId: String(f.order._id), orderId: f.order.orderId,
    paymentMethod: 'cash_on_delivery', paymentRail: 'unknown', currency: 'PKR', totalMinor: 10000,
    orderStatus: 'pending', paymentStatus: 'unpaid', orderPlaced: true, isPaid: false, confirmationRequired: true,
    noPaymentRequired: false, hasCancelledItems: false });
  expect(response.body.placedAt).toBe(new Date(f.order.createdAt).toISOString());
  expect(response.body.shippingInfo).toBeUndefined(); expect(response.body.user).toBeUndefined();
});

test.each(['wallet', 'safepay'])('verified %s receipt resolves the Mongo id and survives repeat GETs without mutations', async method => {
  const f = await fixture({ method, paid: true, rail: 'raast' });
  const before = await Promise.all([Order.findById(f.order._id).lean(), Payment.find({}).lean(), WalletTransaction.find({}).lean()]);
  for (let i = 0; i < 2; i++) {
    const response = await get(buyer, f.order._id);
    expect(response.status).toBe(200); expect(response.body).toMatchObject({ orderPlaced: true, isPaid: true, paymentStatus: 'paid', totalMinor: 10000 });
  }
  const after = await Promise.all([Order.findById(f.order._id).lean(), Payment.find({}).lean(), WalletTransaction.find({}).lean()]);
  expect(JSON.stringify(after)).toBe(JSON.stringify(before));
});

test.each(['wallet', 'safepay'])('a persisted unverified %s invoice is pending and cannot prove placement', async method => {
  const f = await fixture({ method, pending: true });
  const response = await get(buyer, f.order._id);
  expect(response.status).toBe(200); expect(response.body).toMatchObject({ orderPlaced: false, isPaid: false, paymentStatus: 'pending', confirmationRequired: false });
});

test.each(['user', 'seller', 'admin'])('%s role cannot view another purchaser’s receipt', async role => {
  const f = await fixture(); await User.updateOne({ _id: other._id }, { $set: { role } });
  for (const ref of [f.order.orderId, f.order._id]) {
    const response = await get(other, ref, `?buyerId=${buyer._id}`);
    expect(response.status).toBe(404); expect(response.body).toEqual({ msg: 'Order not found.', code: 'ORDER_NOT_FOUND' });
  }
  const unknown = await get(other, new mongoose.Types.ObjectId());
  expect(unknown.body).toEqual((await get(other, f.order._id)).body);
});

test.each(['seller', 'admin'])('%s can read purchases owned by that same account', async role => {
  await User.updateOne({ _id: other._id }, { $set: { role } });
  const f = await fixture({ owner: other }); expect((await get(other, f.order.orderId)).status).toBe(200);
});

test('authentication and exact references are required; missing/duplicate public ids fail closed', async () => {
  expect((await request(app).get('/api/order/receipt/ORD-valid')).status).toBe(401);
  for (const ref of ['true', '12345', 'ORD-', 'not-an-order', '%7B%22%24ne%22%3Anull%7D']) expect((await get(buyer, ref)).status).toBe(400);
  expect((await get(buyer, 'ORD-not-found')).status).toBe(404);
  const a = await fixture(), b = await fixture(); await Order.updateOne({ _id: b.order._id }, { $set: { orderId: a.order.orderId } });
  expect((await get(buyer, a.order.orderId)).status).toBe(409);
});

test('missing capture, wrong payment ownership, bad Raast currency and financial risk cannot turn into paid receipts', async () => {
  const f = await fixture({ method: 'safepay', paid: true, rail: 'raast' });
  for (const patch of [{ capturedMinor: 0 }, { user: other._id }, { riskPending: true }, { status: 'manual_review' }]) {
    const original = await Payment.findById(f.payment._id).lean();
    await Payment.collection.updateOne({ _id: f.payment._id }, { $set: patch });
    const response = await get(buyer, f.order._id);
    expect(response.body).toMatchObject({ orderPlaced: false, isPaid: false, paymentStatus: 'review_required' });
    await Payment.collection.replaceOne({ _id: f.payment._id }, original);
  }
  await Order.collection.updateOne({ _id: f.order._id }, { $set: { currency: 'USD' } });
  await Payment.collection.updateOne({ _id: f.payment._id }, { $set: { currency: 'USD' } });
  expect((await get(buyer, f.order._id)).body).toMatchObject({ orderPlaced: false, isPaid: false, paymentStatus: 'review_required', paymentRail: 'unknown' });
});

test('a related seller payment risk hold blocks a healthy-looking confirmation', async () => {
  const f = await fixture({ method: 'safepay', paid: true });
  await RiskHold.create({ seller: f.seller, sourceType: 'order_payment', sourceReferenceId: String(f.order._id), provider: 'safepay',
    providerPaymentId: f.payment.tracker, providerEnvironment: 'sandbox', eventId: 'receipt-risk-fixture', eventType: 'TRACKER_DISPUTED',
    riskTrack: 'dispute', riskTrackKey: 'receipt-risk-fixture', unknownExposure: true });
  expect((await get(buyer, f.order._id)).body).toMatchObject({ orderPlaced: false, isPaid: false, paymentStatus: 'review_required' });
});

test('cancelled and fully refunded orders retain their truthful lifecycle instead of green success', async () => {
  const f = await fixture({ method: 'safepay', paid: true });
  await Order.updateOne({ _id: f.order._id }, { $set: { orderStatus: 'cancelled', 'sellerFulfillment.0.status': 'cancelled' } });
  expect((await get(buyer, f.order._id)).body).toMatchObject({ orderStatus: 'cancelled', paymentStatus: 'cancelled', orderPlaced: false, hasCancelledItems: true });
  await Payment.updateOne({ _id: f.payment._id }, { $set: { walletRefundMinor: 10000 } });
  expect((await get(buyer, f.order._id)).body).toMatchObject({ orderStatus: 'cancelled', paymentStatus: 'refunded', orderPlaced: false, isPaid: false });
});

test('mixed seller cancellation stays visible before its payment refund completes', async () => {
  const f = await fixture({ method: 'safepay', paid: true });
  await Order.updateOne({ _id: f.order._id }, { $push: { sellerFulfillment: { seller: new mongoose.Types.ObjectId(), status: 'cancelled' } } });
  expect((await get(buyer, f.order._id)).body).toMatchObject({ hasCancelledItems: true, totalMinor: 10000, paymentStatus: 'paid' });
});

test.each(['safepay', 'wallet', 'stripe'])('authoritatively completed zero-total %s orders need no payment ledger', async method => {
  const f = await fixture({ method, paid: true, zero: true });
  expect((await get(buyer, f.order._id)).body).toMatchObject({ totalMinor: 0, noPaymentRequired: true, orderPlaced: true, isPaid: true, paymentStatus: 'not_required' });
});

test('zero COD still follows COD confirmation, and malformed stored status fails safely', async () => {
  const f = await fixture({ zero: true });
  expect((await get(buyer, f.order._id)).body).toMatchObject({ noPaymentRequired: false, orderPlaced: true, isPaid: false, confirmationRequired: true });
  await Order.collection.updateOne({ _id: f.order._id }, { $set: { orderStatus: 'invented-status' } });
  expect((await get(buyer, f.order._id)).status).toBe(503);
});

test('completed native Wallet returns use their exact owned credit before reporting refund status', async () => {
  const f = await fixture({ method: 'wallet', paid: true }), returnId = new mongoose.Types.ObjectId();
  const credit = await WalletTransaction.create({ user: buyer._id, type: 'return_refund', amount: 40, currency: 'PKR', direction: 'credit',
    status: 'completed', referenceType: 'return_request', referenceId: String(returnId), idempotencyKey: `return-refund:${returnId}` });
  await ReturnRequest.collection.insertOne({ _id: returnId, order: f.order._id, buyer: buyer._id, seller: f.seller, currency: 'PKR',
    status: 'returned', refund: { totalAmount: 40 }, settlement: { status: 'completed', walletTransaction: credit._id } });
  expect((await get(buyer, f.order._id)).body).toMatchObject({ paymentStatus: 'partially_refunded', orderPlaced: false, totalMinor: 10000 });
  await WalletTransaction.collection.updateOne({ _id: credit._id }, { $set: { user: other._id } });
  expect((await get(buyer, f.order._id)).body).toMatchObject({ paymentStatus: 'review_required', orderPlaced: false, isPaid: false });
});

test('a full Wallet cancellation refund stays verifiable after inventory has been released', async () => {
  const f = await fixture({ method: 'wallet', paid: true }), cancellationId = new mongoose.Types.ObjectId();
  const credit = await WalletTransaction.create({ user: buyer._id, type: 'return_refund', amount: 100, currency: 'PKR', direction: 'credit',
    status: 'completed', referenceType: 'order_cancellation', referenceId: String(cancellationId), idempotencyKey: `order-cancellation:${cancellationId}:wallet` });
  await Cancellation.create({ _id: cancellationId, order: f.order._id, buyer: buyer._id, seller: f.seller, paymentMethod: 'wallet',
    currency: 'PKR', amountMinor: 10000, sellerCurrency: 'PKR', sellerAmountMinor: 10000, refundStatus: 'refunded',
    refundDestination: 'wallet', requestedAt: new Date(), refundedAt: new Date(), walletTransaction: credit._id });
  await Order.updateOne({ _id: f.order._id }, { $set: { orderStatus: 'cancelled', inventoryCommitted: false, 'sellerFulfillment.0.status': 'cancelled' } });
  expect((await get(buyer, f.order._id)).body).toMatchObject({ orderStatus: 'cancelled', paymentStatus: 'refunded',
    hasCancelledItems: true, isPaid: false, orderPlaced: false });
});

test('COD confirmation is no longer requested after the persisted decision, while incomplete inventory cannot prove placement', async () => {
  const f = await fixture();
  await Order.updateOne({ _id: f.order._id }, { $set: { orderStatus: 'confirmed', 'confirmation.confirmedAt': new Date() } });
  expect((await get(buyer, f.order._id)).body).toMatchObject({ orderPlaced: true, isPaid: false, paymentStatus: 'unpaid', confirmationRequired: false });
  await Order.updateOne({ _id: f.order._id }, { $set: { inventoryCommitted: false } });
  expect((await get(buyer, f.order._id)).body).toMatchObject({ orderPlaced: false, isPaid: false });
});

test('pending zero-total checkout cannot become a successful free receipt from its total alone', async () => {
  const f = await fixture({ method: 'safepay', zero: true, pending: true });
  expect((await get(buyer, f.order._id)).body).toMatchObject({ noPaymentRequired: true, paymentStatus: 'pending', orderPlaced: false, isPaid: false });
});

test('a net card cancellation refund keeps cancelled lifecycle and original total rather than implying active remaining items', async () => {
  const f = await fixture({ method: 'safepay', paid: true });
  await Order.updateOne({ _id: f.order._id }, { $set: { orderStatus: 'cancelled', inventoryCommitted: false, 'sellerFulfillment.0.status': 'cancelled' } });
  await Payment.updateOne({ _id: f.payment._id }, { $set: { refundedMinor: 9000 } });
  expect((await get(buyer, f.order._id)).body).toMatchObject({ orderStatus: 'cancelled', hasCancelledItems: true, paymentStatus: 'partially_refunded',
    totalMinor: 10000, orderPlaced: false, isPaid: false });
});

test('captured but unfulfilled review and unadapted historic Stripe do not claim successful placement', async () => {
  const f = await fixture({ method: 'safepay', pending: true, rail: 'raast' });
  await Payment.updateOne({ _id: f.payment._id }, { $set: { status: 'manual_review', capturedMinor: 10000, paidAt: new Date(), riskPending: true } });
  expect((await get(buyer, f.order._id)).body).toMatchObject({ paymentStatus: 'review_required', orderPlaced: false, isPaid: false });
  const legacy = await fixture({ method: 'stripe', paid: true });
  expect((await get(buyer, legacy.order._id)).body).toMatchObject({ paymentStatus: 'review_required', orderPlaced: false, isPaid: false });
});

test('delivered COD with uncommitted inventory returns coherent review state rather than paid plus isPaid false', async () => {
  const f = await fixture({ paid: true });
  await Order.updateOne({ _id: f.order._id }, { $set: { orderStatus: 'delivered', inventoryCommitted: false } });
  const response = await get(buyer, f.order._id);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ orderStatus: 'delivered', paymentStatus: 'review_required', orderPlaced: false, isPaid: false,
    confirmationRequired: false, reviewReason: expect.any(String) });
  expect(response.body.reviewReason.length).toBeGreaterThan(0);
  expect((await Order.findById(f.order._id)).isPaid).toBe(true);
});

test('a malformed zero Wallet order with external refs cannot bypass the authoritative no-charge path', async () => {
  const f = await fixture({ method: 'wallet', zero: true, paid: true });
  const debitId = new mongoose.Types.ObjectId();
  // Corrupted legacy storage, deliberately bypassing today's positive-amount
  // schema, must not turn an inconsistent free order into a paid confirmation.
  await WalletTransaction.collection.insertOne({ _id: debitId, user: buyer._id, type: 'order_payment', amount: 0, currency: 'PKR', direction: 'debit',
    status: 'completed', referenceType: 'order', referenceId: String(f.order._id), idempotencyKey: `wallet-order:${f.order._id}` });
  await Order.updateOne({ _id: f.order._id }, { $set: { safepayTrackerId: 'track_inconsistent-zero-order', 'paymentResult.walletTransactionId': debitId } });
  expect((await get(buyer, f.order._id)).body).toMatchObject({ totalMinor: 0, noPaymentRequired: false,
    paymentStatus: 'review_required', orderPlaced: false, isPaid: false });
});
