'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Payment = require('../../models/SafepayPayment');
const User = require('../../models/User');
const Outbox = require('../../models/NotificationOutbox');
const { submit } = require('../../services/safepaySafetyRefundService');
const { verifySafepayNotificationAuthority } = require('../../services/safepayNotificationAuthority');
let replica, admin;
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await Promise.all([Payment.init(), User.init(), Outbox.init()]);
}, 120000);
afterAll(async () => { await mongoose.disconnect(); await replica?.stop(); });
beforeEach(async () => {
  await Promise.all([Payment.deleteMany({}), User.deleteMany({}), Outbox.deleteMany({})]);
  admin = await User.create({ username: 'Refund review fixture', email: 'review@example.com', role: 'admin', status: 'active' });
});
async function enqueuedReview({ rail = 'raast', afterPost = false, unknownOutcome = true, preflightError = null, capturedMinor = 10000 } = {}) {
  const ref = new mongoose.Types.ObjectId();
  const payment = await Payment.create({ environment: 'sandbox', purpose: 'order', reference: `review:${ref}`, requestKey: `review:${ref}`,
    fingerprint: 'a'.repeat(64), amountMinor: 10000, currency: 'PKR', tracker: `track_review-${ref}`,
    paymentRail: rail, providerIntent: rail === 'card' ? 'CYBERSOURCE' : rail === 'raast' ? 'RAAST' : '',
    status: 'refund_pending', paidAt: new Date(), capturedMinor, appliedAt: null,
    safetyRefund: { requestedAt: new Date(), reasonCode: 'ORDER_STOCK_CHANGED' } });
  const client = { getTracker: jest.fn(async () => ({ intent: rail === 'card' ? 'CYBERSOURCE' : rail === 'raast' ? 'RAAST' : '',
    state: 'TRACKER_ENDED', mode: 'payment', purchase_totals: { quote_amount: { amount: 10000, currency: 'PKR' } } })),
    refundRemainingPayment: jest.fn(async () => {
      if (afterPost) throw Object.assign(new Error('Fixture provider refund response.'), { outcomeUnknown: unknownOutcome });
    }) };
  if (preflightError) client.getTracker.mockRejectedValueOnce(preflightError);
  // This uses the real immutable enqueue/serialization path in an isolated
  // database. No delivery adapter or real provider is called.
  await submit(payment, client);
  const records = await Outbox.find({ aggregateId: String(payment._id), eventType: 'payment.refund_review_required' }).lean();
  expect(records).toHaveLength(2);
  return { payment: await Payment.findById(payment._id), client, records };
}

test.each(['raast', 'unknown'])('real enqueued unsubmitted %s refund review is authorized for both admin channels', async rail => {
  const { payment, records, client } = await enqueuedReview({ rail });
  expect(payment.status).toBe('manual_review'); expect(payment.safetyRefund.submitStartedAt).toBeNull();
  expect(client.refundRemainingPayment).not.toHaveBeenCalled();
  for (const record of records) {
    expect(String(record.recipient.user)).toBe(String(admin._id));
    expect(new Date(record.occurredAt)).toEqual(payment.safetyRefund.requestedAt);
    expect(await verifySafepayNotificationAuthority(record)).toBeNull();
  }
});

test.each([true, false])('existing post-POST %s outcome retains exact submission-time authority', async unknownOutcome => {
  const { payment, records, client } = await enqueuedReview({ rail: 'card', afterPost: true, unknownOutcome });
  expect(payment.status).toBe('refund_pending'); expect(client.refundRemainingPayment).toHaveBeenCalledTimes(1);
  for (const record of records) {
    expect(new Date(record.occurredAt)).toEqual(payment.safetyRefund.submitStartedAt);
    expect(await verifySafepayNotificationAuthority(record)).toBeNull();
  }
});

test.each(['SAFEPAY_TRACKER_MISMATCH', 'SAFEPAY_PAYMENT_MISMATCH', 'SAFEPAY_ORDER_BINDING_INVALID', 'SAFEPAY_PAYMENT_RAIL_CHANGED'])('wrong-owner/rail preflight %s cannot authorize an owed-money claim', async code => {
  const { records, client } = await enqueuedReview({ rail: 'card', preflightError: Object.assign(new Error('Unverified ownership.'), { code, statusCode: 409 }) });
  expect(client.refundRemainingPayment).not.toHaveBeenCalled();
  for (const record of records) expect(await verifySafepayNotificationAuthority(record)).toMatchObject({ outcome: 'skipped' });
});

test('a preflight without a captured principal cannot authorize an owed-money notification', async () => {
  const { records, client } = await enqueuedReview({ capturedMinor: 0 });
  expect(client.refundRemainingPayment).not.toHaveBeenCalled();
  for (const record of records) expect(await verifySafepayNotificationAuthority(record)).toMatchObject({ outcome: 'skipped' });
});

test.each([
  { status: 'refunded', refundedMinor: 10000 }, { 'safetyRefund.outcome': 'confirmed' },
  { appliedAt: new Date() }, { 'safetyRefund.submitStartedAt': new Date() },
  { 'safetyRefund.outcome': 'unknown' }, { lastErrorCode: '' }, { capturedMinor: 0 },
  { refundedMinor: 10000 }, { walletRefundMinor: 10000 }, { paidAt: null },
])('real review becomes unactionable after its authoritative marker changes %j', async patch => {
  const { payment, records } = await enqueuedReview();
  await Payment.updateOne({ _id: payment._id }, { $set: patch });
  for (const record of records) expect(await verifySafepayNotificationAuthority(record)).toMatchObject({ outcome: 'skipped' });
});

test('wrong event, recipient, amount, date, source and context never authorize a review', async () => {
  const { records } = await enqueuedReview();
  const source = JSON.parse(JSON.stringify(records.find(record => record.channel === 'inapp')));
  expect(await verifySafepayNotificationAuthority(source)).toBeNull();
  for (const mutate of [
    row => { row.eventType = 'order.payment_refund_completed'; },
    row => { row.eventKey += ':forged'; },
    row => { row.channel = 'push'; },
    row => { row.recipient.audienceRole = 'buyer'; },
    row => { row.recipient.destinationPolicy = 'event_snapshot'; },
    row => { row.recipient.user = String(new mongoose.Types.ObjectId()); },
    row => { row.money[0].amountMinor = 9999; },
    row => { row.money[0].amountMinor = '10000'; },
    row => { row.money[0].currency = 'USD'; },
    row => { row.money[0].sourcePath = 'capturedMinor'; },
    row => { row.money[0].sourceDocumentId = String(new mongoose.Types.ObjectId()); },
    row => { row.occurredAt = new Date(new Date(row.occurredAt).getTime() + 1).toISOString(); },
    row => { row.payload.data.type = 'another_review'; },
    row => { row.payload.data.paymentId = String(new mongoose.Types.ObjectId()); },
    row => { row.financial = false; },
  ]) {
    const changed = JSON.parse(JSON.stringify(source)); mutate(changed);
    expect(await verifySafepayNotificationAuthority(changed)).toMatchObject({ outcome: 'skipped' });
  }
});

test('a post-POST review cannot substitute the earlier request timestamp', async () => {
  const { payment, records } = await enqueuedReview({ rail: 'card', afterPost: true });
  await Payment.updateOne({ _id: payment._id }, { $set: { 'safetyRefund.requestedAt': new Date(payment.safetyRefund.submitStartedAt.getTime() - 1000) } });
  for (const record of records) {
    const forged = { ...record, occurredAt: new Date(payment.safetyRefund.submitStartedAt.getTime() - 1000) };
    expect(await verifySafepayNotificationAuthority(forged)).toMatchObject({ outcome: 'skipped' });
    expect(await verifySafepayNotificationAuthority(record)).toBeNull();
  }
});
