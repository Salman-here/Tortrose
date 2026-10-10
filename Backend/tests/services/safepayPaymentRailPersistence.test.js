'use strict';
jest.mock('../../services/safepayClient', () => ({ ...jest.requireActual('../../services/safepayClient'), createSafepayClient: jest.fn() }));
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Payment = require('../../models/SafepayPayment');
const Order = require('../../models/Order');
const RefundEvent = require('../../models/SafepayRefundEvent');
const User = require('../../models/User');
const { createSafepayClient, requireTracker } = require('../../services/safepayClient');
const { createSafepayPaymentService } = require('../../services/safepayPaymentService');
const { refreshOwnedSafepayOrderRail } = require('../../services/safepayPaymentRailService');
let replica, service, client, provider, settle, quarantine;
const config = { environment: 'sandbox', publicKey: 'sec_owned-rail-fixture', secretKey: 'test-private-secret-only',
  webhookSecret: 'test-webhook-secret-only', webhookScheme: 'sha512-data' };
const envNames = ['SAFEPAY_ENV', 'SAFEPAY_SANDBOX_PUBLIC_KEY', 'SAFEPAY_SANDBOX_SECRET_KEY', 'SAFEPAY_SANDBOX_WEBHOOK_SECRET', 'SAFEPAY_SANDBOX_WEBHOOK_SCHEME'];
const savedEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
beforeAll(async () => {
  Object.assign(process.env, { SAFEPAY_ENV: 'sandbox', SAFEPAY_SANDBOX_PUBLIC_KEY: config.publicKey,
    SAFEPAY_SANDBOX_SECRET_KEY: config.secretKey, SAFEPAY_SANDBOX_WEBHOOK_SECRET: config.webhookSecret, SAFEPAY_SANDBOX_WEBHOOK_SCHEME: config.webhookScheme });
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await Promise.all([Payment.init(), Order.init(), RefundEvent.init()]);
}, 120000);
afterAll(async () => {
  await mongoose.disconnect(); await replica?.stop();
  for (const name of envNames) if (savedEnv[name] === undefined) delete process.env[name]; else process.env[name] = savedEnv[name];
});
beforeEach(async () => {
  await Promise.all([Payment.deleteMany({}), Order.deleteMany({}), RefundEvent.deleteMany({}), User.deleteMany({})]);
  provider = { intent: 'RAAST', state: 'TRACKER_ENDED' };
  client = { getTracker: jest.fn(async (token, expected) => requireTracker({ token, environment: 'sandbox', client: config.publicKey,
    mode: expected.providerMode, metadata: { order_id: expected.reference },
    purchase_totals: { quote_amount: { amount: expected.amountMinor, currency: expected.currency } }, ...provider }, expected, config)),
  refundRemainingPayment: jest.fn() };
  createSafepayClient.mockImplementation(() => client);
  settle = jest.fn(async (payment, tracker, session) => {
    await Order.updateOne({ _id: payment.order }, { $set: { isPaid: true, awaitingPayment: false, orderStatus: 'confirmed' } }, { session });
  });
  quarantine = jest.fn(async () => {});
  service = createSafepayPaymentService({ configFor: () => config, clientFor: () => client, settle, quarantine });
});
async function fixture({ paid = false, paymentRail = 'unknown' } = {}) {
  const buyer = new mongoose.Types.ObjectId(), seller = new mongoose.Types.ObjectId();
  const order = await Order.create({ user: buyer, orderId: `ORD-RAIL-${new mongoose.Types.ObjectId()}`,
    orderItems: [{ productId: new mongoose.Types.ObjectId(), seller, name: 'Rail fixture', quantity: 1, price: 100, lineSubtotal: 100,
      sourcePrice: 100, sourceLineSubtotal: 100, sourceCurrency: 'PKR' }],
    shippingInfo: { fullName: 'Fixture Buyer', email: 'rail@example.com', phone: '+923001234567', address: 'Fixture Street', city: 'Lahore', state: 'Punjab', postalCode: '54000', country: 'Pakistan' },
    shippingMethod: { name: 'free', price: 0, estimatedDays: 3, seller },
    sellerShipping: [{ seller, shippingMethod: { name: 'free', price: 0, estimatedDays: 3, sourceCost: 0, sourceCurrency: 'PKR' } }],
    sellerPolicies: [{ seller, productCurrency: 'PKR' }], sellerFulfillment: [{ seller, status: 'pending' }],
    orderSummary: { subtotal: 100, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 100 }, currency: 'PKR',
    exchangeRateSnapshot: { base: 'USD', rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 }, capturedAt: new Date(), source: 'fixture', fallback: false },
    paymentMethod: 'safepay', paymentFlow: 'safepay_hosted', safepayEnvironment: 'sandbox', isPaid: paid, awaitingPayment: !paid,
    paymentSetupState: 'ready' });
  const payment = await service.ensurePayment({ user: buyer, purpose: 'order', order: order._id,
    reference: `order:${order._id}`, requestKey: `checkout:${order._id}`, amountMinor: 10000, currency: 'PKR' });
  payment.tracker = `track_rail-${payment._id}`; payment.status = paid ? 'paid' : 'ready'; payment.paymentRail = paymentRail;
  if (paid) { payment.appliedAt = new Date(); payment.paidAt = new Date(); payment.capturedMinor = 10000; }
  await payment.save();
  order.safepayPaymentId = payment._id; order.safepayTrackerId = payment.tracker; await order.save();
  return { order, payment };
}

test('trusted Raast settles once and failed QR attempt stays resumable/pending', async () => {
  const f = await fixture(); provider.state = 'TRACKER_STARTED'; provider.raast_payment = { status: 'FAILED' };
  const pending = await service.reconcilePayment(f.payment._id);
  expect(pending).toMatchObject({ status: 'ready', paymentRail: 'raast', raastAttemptStatus: 'FAILED', capturedMinor: 0 });
  expect(settle).not.toHaveBeenCalled();
  provider = { intent: 'RAAST', state: 'TRACKER_ENDED' };
  await service.reconcilePayment(f.payment._id); await service.reconcilePayment(f.payment._id);
  expect(settle).toHaveBeenCalledTimes(1);
  expect((await Order.findById(f.order._id)).safepayPaymentRail).toBe('raast');
  expect((await Payment.findById(f.payment._id)).raastAttemptStatus).toBeNull();
});

test('an unsettled hosted card choice can switch to Raast without rotating the owned attempt', async () => {
  const f = await fixture(); provider = { intent: 'CYBERSOURCE', state: 'TRACKER_STARTED' };
  await service.reconcilePayment(f.payment._id);
  expect((await Payment.findById(f.payment._id)).paymentRail).toBe('card');
  expect((await Payment.findById(f.payment._id)).paymentRailCapturedAt).toBeNull();
  provider = { intent: 'RAAST', state: 'TRACKER_ENDED' };
  await service.reconcilePayment(f.payment._id);
  const payment = await Payment.findById(f.payment._id);
  expect(payment.paymentRail).toBe('raast'); expect(String(payment.order)).toBe(String(f.order._id));
  expect(payment.paymentRailCapturedAt).toBeInstanceOf(Date);
  expect(payment.amountMinor).toBe(10000);
});

test('provider rail evidence survives a financial rollback and prevents a false fulfilled-order claim', async () => {
  const f = await fixture();
  settle.mockImplementationOnce(async (payment, tracker, session) => {
    await Order.updateOne({ _id: payment.order }, { $set: { isPaid: true } }, { session });
    throw Object.assign(new Error('Stock changed.'), { code: 'ORDER_STOCK_CHANGED', statusCode: 409 });
  });
  await service.reconcilePayment(f.payment._id);
  const payment = await Payment.findById(f.payment._id), order = await Order.findById(f.order._id);
  expect(payment.paymentRail).toBe('raast'); expect(payment.providerIntent).toBe('RAAST');
  expect(payment.paymentRailObservedAt).toBeInstanceOf(Date);
  expect(payment.paymentRailCapturedAt).toBeInstanceOf(Date);
  expect(payment.appliedAt).toBeNull(); expect(order.isPaid).toBe(false);
});

test('legacy paid rail is refreshed with exact order binding while invoice amounts stay unchanged', async () => {
  const f = await fixture({ paid: true });
  const before = JSON.stringify(f.order.orderSummary);
  const context = await refreshOwnedSafepayOrderRail(f.order);
  expect(context).toMatchObject({ paymentId: String(f.payment._id), paymentRail: 'raast', providerIntent: 'RAAST', raastAttemptStatus: null });
  expect((await Order.findById(f.order._id)).safepayPaymentRail).toBe('raast');
  expect(JSON.stringify((await Order.findById(f.order._id)).orderSummary)).toBe(before);
  expect((await Payment.findById(f.payment._id)).processingToken).toBeUndefined();
  expect((await Payment.findById(f.payment._id)).leaseUntil).toBeNull();
});

test('a trusted conflicting post-settlement rail is quarantined, never rewritten', async () => {
  const f = await fixture({ paid: true, paymentRail: 'card' });
  const result = await service.reconcilePayment(f.payment._id);
  expect(result).toMatchObject({ paymentRail: 'card', status: 'manual_review', riskPending: true, lastErrorCode: 'SAFEPAY_PAYMENT_RAIL_CHANGED' });
  expect(quarantine).toHaveBeenCalledTimes(1); expect(quarantine.mock.calls[0][3]).toEqual({ skipRefundReconciliation: true });
  expect(settle).not.toHaveBeenCalled();
  expect((await Order.findById(f.order._id)).orderSummary.totalAmount).toBe(100);
});

test('quote refresh rejects a busy lease or mismatched ownership before fetching the provider', async () => {
  const f = await fixture({ paid: true });
  await Payment.updateOne({ _id: f.payment._id }, { $set: { processingToken: 'another-worker', leaseUntil: new Date(Date.now() + 60000) } });
  await expect(refreshOwnedSafepayOrderRail(f.order)).rejects.toMatchObject({ statusCode: 503 });
  expect(client.getTracker).not.toHaveBeenCalled();
  await Payment.updateOne({ _id: f.payment._id }, { $set: { processingToken: '', leaseUntil: null } });
  f.order.user = new mongoose.Types.ObjectId();
  await expect(refreshOwnedSafepayOrderRail(f.order)).rejects.toMatchObject({ code: 'SAFEPAY_PAYMENT_NEEDS_RECONCILIATION' });
  expect(client.getTracker).not.toHaveBeenCalled();
});

test('unknown or non-paid provider evidence cannot invent a card refund capability', async () => {
  const f = await fixture({ paid: true }); provider = { state: 'TRACKER_ENDED' };
  await expect(refreshOwnedSafepayOrderRail(f.order)).rejects.toMatchObject({ code: 'SAFEPAY_PAYMENT_NEEDS_RECONCILIATION' });
  provider.state = 'TRACKER_STARTED';
  await expect(refreshOwnedSafepayOrderRail(f.order)).rejects.toMatchObject({ code: 'SAFEPAY_PAYMENT_NEEDS_RECONCILIATION' });
});

test('a sparse fresh refund read rejects quote context even when a captured card label stays pinned', async () => {
  const f = await fixture({ paid: true, paymentRail: 'card' }); provider = { state: 'TRACKER_ENDED' };
  await expect(refreshOwnedSafepayOrderRail(f.order)).rejects.toMatchObject({ code: 'SAFEPAY_PAYMENT_NEEDS_RECONCILIATION' });
  expect((await Payment.findById(f.payment._id)).paymentRail).toBe('card');
  expect((await Order.findById(f.order._id)).safepayPaymentRail).toBe('unknown');
});

test.each([{ capturedMinor: 0 }, { capturedMinor: 9999 }, { paidAt: null }, { appliedAt: null }])('corrupt paid capture ledger %j cannot supply a refund quote', async patch => {
  const f = await fixture({ paid: true }); await Payment.updateOne({ _id: f.payment._id }, { $set: patch });
  await expect(refreshOwnedSafepayOrderRail(f.order)).rejects.toMatchObject({ code: 'SAFEPAY_PAYMENT_NEEDS_RECONCILIATION' });
  expect(client.getTracker).not.toHaveBeenCalled();
  expect((await Order.findById(f.order._id)).orderSummary.totalAmount).toBe(100);
});

test('pretransaction capture marker survives a writer failure and rejects a later conflicting rail while unapplied', async () => {
  const f = await fixture();
  settle.mockRejectedValueOnce(Object.assign(new Error('Writer crashed.'), { code: 'SIMULATED_WRITER_CRASH' }));
  await expect(service.reconcilePayment(f.payment._id)).rejects.toMatchObject({ code: 'SIMULATED_WRITER_CRASH' });
  const captured = await Payment.findById(f.payment._id);
  expect(captured).toMatchObject({ paymentRail: 'raast', status: 'ready', capturedMinor: 0 });
  expect(captured.appliedAt).toBeNull(); expect(captured.paymentRailCapturedAt).toBeInstanceOf(Date);
  provider = { intent: 'CYBERSOURCE', state: 'TRACKER_ENDED' };
  const reviewed = await service.reconcilePayment(f.payment._id);
  expect(reviewed).toMatchObject({ paymentRail: 'raast', status: 'manual_review', riskPending: true, lastErrorCode: 'SAFEPAY_PAYMENT_RAIL_CHANGED' });
  expect(settle).toHaveBeenCalledTimes(1); expect(client.refundRemainingPayment).not.toHaveBeenCalled();
  expect((await Order.findById(f.order._id)).isPaid).toBe(false);
});

test('a sparse post-capture GET preserves unapplied safety refund rail and the explicit review reason', async () => {
  const f = await fixture(), capturedAt = new Date();
  await Payment.updateOne({ _id: f.payment._id }, { $set: { paymentRail: 'raast', providerIntent: 'RAAST',
    paymentRailCapturedAt: capturedAt, paymentRailObservedAt: capturedAt, status: 'manual_review', capturedMinor: 10000,
    paidAt: capturedAt, lastErrorCode: 'SAFEPAY_EXTERNAL_REFUND_UNSUPPORTED',
    'safetyRefund.requestedAt': capturedAt, 'safetyRefund.outcome': 'failed' } });
  provider = { state: 'TRACKER_ENDED' };
  const result = await service.reconcilePayment(f.payment._id);
  expect(result).toMatchObject({ paymentRail: 'raast', providerIntent: 'RAAST', status: 'manual_review', lastErrorCode: 'SAFEPAY_EXTERNAL_REFUND_UNSUPPORTED' });
  expect(result.paymentRailCapturedAt).toEqual(capturedAt); expect(result.appliedAt).toBeNull();
  expect(settle).not.toHaveBeenCalled(); expect(client.refundRemainingPayment).not.toHaveBeenCalled();
});

test('quote refresh permits only already-accounted partial card refunds and preserves their money', async () => {
  const f = await fixture({ paid: true, paymentRail: 'card' });
  await Payment.updateOne({ _id: f.payment._id }, { $set: { refundedMinor: 1000 } });
  const charge = amount => ({ token: 'ch_owned-rail', tracker: f.payment.tracker,
    amount: { amount: 10000, currency: 'PKR' }, capture: { totals: { amount: 10000, currency: 'PKR' } },
    balance: { amount: 10000 - amount, currency: 'PKR' }, cybersource_refunds: [{ token: 'refund_owned-rail-1',
      tracker: f.payment.tracker, totals: { amount, currency: 'PKR' }, created_at: { seconds: Math.floor(Date.now() / 1000) } }] });
  provider = { intent: 'CYBERSOURCE', state: 'TRACKER_PARTIAL_REFUND', charge: charge(1000) };
  expect((await refreshOwnedSafepayOrderRail(f.order)).paymentRail).toBe('card');
  expect((await Payment.findById(f.payment._id)).refundedMinor).toBe(1000);
  provider.charge = charge(1001);
  await expect(refreshOwnedSafepayOrderRail(f.order)).rejects.toMatchObject({ code: 'SAFEPAY_PAYMENT_NEEDS_RECONCILIATION' });
  expect((await Payment.findById(f.payment._id)).refundedMinor).toBe(1000);
});
