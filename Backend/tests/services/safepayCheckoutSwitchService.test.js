'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Payment = require('../../models/SafepayPayment');
const Order = require('../../models/Order');
const { createCheckoutSwitchService } = require('../../services/safepayCheckoutSwitchService');
let replica, payment, buyer, order, client, cancel, retire, reconcile;
beforeAll(async () => { replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(replica.getUri()); await Payment.init(); }, 60000);
afterAll(async () => { await mongoose.disconnect(); await replica?.stop(); });
beforeEach(async () => {
  await Payment.deleteMany({}); await Order.deleteMany({});
  buyer = new mongoose.Types.ObjectId(); order = new mongoose.Types.ObjectId();
  payment = await Payment.create({ user: buyer, environment: 'sandbox', purpose: 'order', order,
    reference: `order:${order}`, requestKey: 'switch-fixture-request', fingerprint: 'a'.repeat(64), amountMinor: 10000, currency: 'PKR',
    providerMode: 'payment', tracker: 'track_switch-fixture', status: 'ready', terms: { settlementPolicy: 'revalidate-on-payment-v1' } });
  await Order.collection.insertOne({ _id: order, user: buyer, safepayPaymentId: payment._id, paymentMethod: 'safepay', isPaid: false, orderStatus: 'processing' });
  client = { getTracker: jest.fn(async () => ({ state: 'TRACKER_STARTED', intent: 'CYBERSOURCE', next_actions: { CYBERSOURCE: { kind: 'GENERATE_CAPTURE_CONTEXT' } } })) };
  reconcile = jest.fn(id => Payment.findById(id));
  cancel = jest.fn(async () => { await Payment.updateOne({ _id: payment._id }, { $set: { localCancelledAt: new Date() } });
    await Order.updateOne({ _id: order }, { $set: { orderStatus: 'cancelled' } }); });
  retire = createCheckoutSwitchService({ configFor: () => ({ environment: 'sandbox' }), clientFor: () => client, reconcile, cancel });
});
test.each([false, true])('an idle %s saved-card checkout can be retired without changing its tracker, amount or card', async saved => {
  if (saved) {
    await Payment.updateOne({ _id: payment._id }, { $set: { providerEntryMode: 'tms', customerId: 'cus_switch-fixture', cardId: 'pm_switch-fixture' } }, { overwriteImmutable: true });
    client.getTracker.mockResolvedValue({ state: 'TRACKER_STARTED', intent: 'CYBERSOURCE', next_actions: { CYBERSOURCE: { kind: 'PAYER_AUTH_SETUP' } } });
  }
  const result = await retire(String(payment._id), String(buyer));
  expect(result).toMatchObject({ paymentId: String(payment._id), checkoutRetired: true, status: 'pending', isPaid: false, amountMinor: 10000 });
  const same = await Payment.findById(payment._id).select('+cardId');
  expect(same.tracker).toBe(payment.tracker); expect(same.amountMinor).toBe(10000); expect(same.capturedMinor).toBe(0);
  if (saved) expect(same.cardId).toBe('pm_switch-fixture');
  expect(same.savedCardAuthentication.operationToken).toBeUndefined(); // secret field remains excluded
  expect(await Payment.countDocuments()).toBe(1); expect(cancel).toHaveBeenCalledTimes(1);
  expect((await retire(String(payment._id), String(buyer))).checkoutRetired).toBe(true);
  expect(cancel).toHaveBeenCalledTimes(1);
});
test('an already completed payment is confirmed instead of cancelled or replaced', async () => {
  await Payment.updateOne({ _id: payment._id }, { $set: { status: 'paid', appliedAt: new Date(), capturedMinor: 10000 } });
  expect(await retire(String(payment._id), String(buyer))).toMatchObject({ status: 'paid', isPaid: true, checkoutRetired: false });
  expect(client.getTracker).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
});
test.each([
  { state: 'TRACKER_ENROLLED', intent: 'CYBERSOURCE' }, { state: 'TRACKER_AUTHORIZED', intent: 'CYBERSOURCE' },
  { state: 'TRACKER_STARTED', intent: 'RAAST' },
  { state: 'TRACKER_STARTED', intent: 'CYBERSOURCE', charge: { token: 'charge_fixture' } },
  { state: 'TRACKER_STARTED', intent: 'CYBERSOURCE', next_actions: { CYBERSOURCE: { kind: 'PAYER_AUTH_ENROLLMENT' } } },
])('bank approval, charge or Raast request is never retired as idle: %j', async tracker => {
  client.getTracker.mockResolvedValue(tracker);
  await expect(retire(String(payment._id), String(buyer))).rejects.toMatchObject({ code: 'SAFEPAY_PAYMENT_METHOD_CHANGE_PENDING' });
  expect(cancel).not.toHaveBeenCalled(); expect((await Payment.findById(payment._id)).localCancelledAt).toBeNull();
});
test.each([
  { 'savedCardAuthentication.setupStartedAt': new Date() }, { 'savedCardAuthentication.encryptedContext': 'private-bank-context' },
  { 'savedCardAuthentication.resetStartedAt': new Date() }, { 'checkoutCard.approvalStartedAt': new Date() },
  { 'savedCardAuthentication.operationLeaseUntil': new Date('2099-01-01') },
])('an existing bank operation holds its fence: %j', async patch => {
  await Payment.updateOne({ _id: payment._id }, { $set: patch });
  await expect(retire(String(payment._id), String(buyer))).rejects.toMatchObject({ code: 'SAFEPAY_PAYMENT_METHOD_CHANGE_PENDING' });
  expect(cancel).not.toHaveBeenCalled(); expect(client.getTracker).not.toHaveBeenCalled();
});
test('unverified provider failures release only this operation fence, never the purchase or amount', async () => {
  client.getTracker.mockRejectedValue(Object.assign(new Error('Provider unavailable'), { code: 'SAFEPAY_REQUEST_UNCERTAIN' }));
  await expect(retire(String(payment._id), String(buyer))).rejects.toMatchObject({ code: 'SAFEPAY_REQUEST_UNCERTAIN' });
  expect(cancel).not.toHaveBeenCalled();
  const same = await Payment.findById(payment._id); expect(same.localCancelledAt).toBeNull(); expect(same.savedCardAuthentication.operationLeaseUntil).toBeNull();
});
test('a competing request cannot retire a purchase while its first change operation is open', async () => {
  let release;
  client.getTracker.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const first = retire(String(payment._id), String(buyer));
  for (let i = 0; i < 50 && !release; i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(release).toBeDefined();
  await expect(retire(String(payment._id), String(buyer))).rejects.toMatchObject({ code: 'SAFEPAY_PAYMENT_METHOD_CHANGE_PENDING' });
  release({ state: 'TRACKER_STARTED', intent: 'CYBERSOURCE', next_actions: { CYBERSOURCE: { kind: 'GENERATE_CAPTURE_CONTEXT' } } });
  expect((await first).checkoutRetired).toBe(true); expect(cancel).toHaveBeenCalledTimes(1);
});
test('owner, environment and purpose are checked before any provider request or cancellation', async () => {
  await expect(retire(String(payment._id), String(new mongoose.Types.ObjectId()))).rejects.toMatchObject({ statusCode: 404 });
  await Payment.updateOne({ _id: payment._id }, { $set: { environment: 'production' } }, { overwriteImmutable: true });
  await expect(retire(String(payment._id), String(buyer))).rejects.toMatchObject({ statusCode: 404 });
  expect(reconcile).not.toHaveBeenCalled(); expect(client.getTracker).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
});
test('card setup and wallet top-ups are not order checkouts that this endpoint can retire', async () => {
  for (const purpose of ['card_setup', 'wallet_top_up', 'subscription']) {
    await Payment.updateOne({ _id: payment._id }, { $set: { purpose } }, { overwriteImmutable: true });
    await expect(retire(String(payment._id), String(buyer))).rejects.toMatchObject({ statusCode: 404 });
  }
  expect(cancel).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled();
});
test('the retirement controller rejects card data, amounts and alternative payment IDs', async () => {
  const handler = require('../../controllers/safepayController').retireCheckout;
  const res = { set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
  await handler({ body: { clientSurface: 'mobile', amount: 1, card_number: 'not-forwarded' }, user: { id: String(buyer) }, params: { paymentId: String(payment._id) } }, res);
  expect(res.status).toHaveBeenCalledWith(400); expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SAFEPAY_CARD_SELECTION_INVALID' }));
  expect(cancel).not.toHaveBeenCalled();
});
test('the HTTP retirement endpoint requires the normal app login, not a copied checkout reference', async () => {
  const app = require('express')(); app.use(require('express').json()); app.use('/api/safepay', require('../../routes/safepayRoutes'));
  const response = await require('supertest')(app).post(`/api/safepay/payments/${payment._id}/retire-checkout`).send({ clientSurface: 'mobile' });
  expect(response.status).toBe(401); expect(response.body.code).toBe('AUTH_REQUIRED'); expect(cancel).not.toHaveBeenCalled();
});
