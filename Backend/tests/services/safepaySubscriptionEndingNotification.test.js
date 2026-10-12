'use strict';

// Exercise the real durable producer, source authority and lifecycle changes
// against an isolated replica set. Delivery adapters are mocked explicitly;
// this suite cannot send email, push, WhatsApp or submit a provider payment.
const mockSendEmail = jest.fn();
const mockSendPush = jest.fn();
const mockNotifySeller = jest.fn();
jest.mock('../../controllers/mailController', () => ({
  sendEmail: (...args) => mockSendEmail(...args),
}));
jest.mock('../../utils/expoPush', () => ({
  sendExpoPushStrict: (...args) => mockSendPush(...args),
}));
jest.mock('../../services/whatsapp/sellerNotificationService', () => ({
  notifySeller: (...args) => mockNotifySeller(...args),
}));
jest.mock('../../services/whatsapp/queue', () => ({
  enqueueOrderConfirmation: jest.fn(),
  enqueueGenericTextNotification: jest.fn(),
  enqueueTextNotification: jest.fn(),
  findOrderConfirmationJob: jest.fn(),
}));

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../../models/User');
const Subscription = require('../../models/SellerSubscription');
const Outbox = require('../../models/NotificationOutbox');
const Notification = require('../../models/Notification');
const { enqueueSubscriptionEndingNotification } = require('../../services/subscriptionLifecycleNotificationService');
const {
  deliverNotificationRecord,
  verifySubscriptionNotificationAuthority,
} = require('../../services/notificationOutboxDeliveryService');
const lifecycle = require('../../services/safepayBillingLifecycleService');

const fixtureEnv = {
  SAFEPAY_ENV: 'sandbox',
  SAFEPAY_SANDBOX_PUBLIC_KEY: 'sec_test-ending-warning',
  SAFEPAY_SANDBOX_SECRET_KEY: 'private-ending-warning-test-secret',
  SAFEPAY_SANDBOX_WEBHOOK_SECRET: 'private-ending-warning-webhook-secret',
  SAFEPAY_SANDBOX_WEBHOOK_SCHEME: 'sha512-raw',
};
const savedEnv = Object.fromEntries(Object.keys(fixtureEnv).map(key => [key, process.env[key]]));
let replica;
let seller;
let subscription;

beforeAll(async () => {
  Object.assign(process.env, fixtureEnv);
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await Promise.all([User, Subscription, Outbox, Notification].map(model => model.init()));
}, 120000);

afterAll(async () => {
  await mongoose.disconnect();
  await replica?.stop();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(async () => {
  await Promise.all([User, Subscription, Outbox, Notification].map(model => model.deleteMany({})));
  mockSendEmail.mockReset().mockResolvedValue({ messageId: 'isolated-email' });
  mockSendPush.mockReset().mockResolvedValue({ sentCount: 1, ticketIds: ['isolated-push'], invalidTokens: [] });
  mockNotifySeller.mockReset().mockResolvedValue({ sent: true, messageId: 'isolated-whatsapp' });
  seller = await User.create({
    username: 'Safepay Ending Warning Fixture',
    email: 'safepay-ending-warning@example.com',
    role: 'seller',
    status: 'active',
    expoPushTokens: ['ExponentPushToken[isolated-ending-fixture]'],
  });
  const now = new Date();
  subscription = await Subscription.create({
    seller: seller._id,
    status: 'active',
    plan: 'starter',
    planName: 'Rozare Starter',
    billingProvider: 'safepay',
    currentPeriodStart: new Date(now.getTime() - 29 * 86400000),
    currentPeriodEnd: new Date(now.getTime() + 86400000),
    cancelledAt: new Date(now.getTime() - 3600000),
    warningEmailSent: false,
    pendingDowngrade: { toPlan: null, scheduledAt: null },
    safepayBilling: {
      environment: 'sandbox',
      contractId: String(new mongoose.Types.ObjectId()),
      monthlyMinor: 999,
      autoRenew: false,
      nextChargeAt: null,
      version: 4,
      endedAt: null,
    },
  });
});

async function endingRows() {
  await enqueueSubscriptionEndingNotification(subscription);
  return Outbox.find({ aggregateId: String(subscription._id), eventType: 'subscription.ending_soon' }).lean();
}

test.each(['active', 'free_period'])('an %s Safepay cancellation without a Stripe ID outboxes four exact seller channels', async status => {
  subscription.status = status;
  await subscription.save();
  expect(subscription.stripeSubscriptionId).toBeUndefined();
  const rows = await endingRows();
  expect(rows.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
  for (const row of rows) {
    expect(row.financial).toBe(false);
    expect(row.money).toHaveLength(0);
    expect(row.recipient).toMatchObject({ audienceRole: 'seller', destinationPolicy: 'current_user' });
    expect(String(row.recipient.user)).toBe(String(seller._id));
    expect(row.payload.data).toMatchObject({
      billingProvider: 'safepay',
      safepayContractId: subscription.safepayBilling.contractId,
      safepayEnvironment: 'sandbox',
      cancelledAtAt: subscription.cancelledAt.toISOString(),
      currentPeriodEndAt: subscription.currentPeriodEnd.toISOString(),
    });
    expect(row.payload.data).not.toHaveProperty('stripeSubscriptionId');
    expect(row.payload.linkTo).toBe('/seller-dashboard/subscription');
    expect(await verifySubscriptionNotificationAuthority(row)).toBeNull();
  }
  expect(mockSendEmail).not.toHaveBeenCalled();
  expect(mockSendPush).not.toHaveBeenCalled();
  expect(mockNotifySeller).not.toHaveBeenCalled();
});

test('the real dispatcher authorizes all four channels without leaking to real transports', async () => {
  const rows = await endingRows();
  for (const row of rows) expect(await deliverNotificationRecord(row)).toMatchObject({ outcome: 'delivered' });
  expect(await Notification.countDocuments({ user: seller._id, eventType: 'subscription.ending_soon' })).toBe(1);
  expect(mockSendEmail).toHaveBeenCalledTimes(1);
  expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: seller.email, subject: 'Subscription ending soon' }));
  expect(mockSendPush).toHaveBeenCalledTimes(1);
  expect(mockNotifySeller).toHaveBeenCalledTimes(1);
  expect(mockNotifySeller).toHaveBeenCalledWith(seller._id, 'subscription_ending', expect.stringContaining('*Subscription ending soon*'));
});

test('replay, parallel attempts and unrelated billing-version changes share the same frozen ending event', async () => {
  const rows = await endingRows();
  const key = rows[0].eventKey;
  await Promise.all([enqueueSubscriptionEndingNotification(subscription), enqueueSubscriptionEndingNotification(subscription)]);
  subscription.safepayBilling.version += 1;
  await subscription.save();
  await enqueueSubscriptionEndingNotification(subscription);
  const replayed = await Outbox.find({ eventType: 'subscription.ending_soon' }).lean();
  expect(replayed).toHaveLength(4);
  expect(new Set(replayed.map(row => row.eventKey))).toEqual(new Set([key]));
  for (const row of replayed) expect(await verifySubscriptionNotificationAuthority(row)).toBeNull();
});

test.each([
  ['resumed', { cancelledAt: null, 'safepayBilling.autoRenew': true }],
  ['different cancellation', { cancelledAt: new Date(Date.now() - 1800000) }],
  ['replacement contract', { 'safepayBilling.contractId': 'replacement-contract' }],
  ['different environment', { 'safepayBilling.environment': 'production' }],
  ['different provider', { billingProvider: 'stripe' }],
  ['moved period', { currentPeriodEnd: new Date(Date.now() + 2 * 86400000) }],
  ['ended billing', { 'safepayBilling.endedAt': new Date() }],
  ['cancelled status', { status: 'cancelled' }],
  ['past-due status', { status: 'past_due' }],
  ['renewal enabled', { 'safepayBilling.autoRenew': true }],
  ['pending downgrade', { 'pendingDowngrade.toPlan': 'starter' }],
  ['incomplete scheduled downgrade', { 'pendingDowngrade.scheduledAt': new Date() }],
  ['expired period', { currentPeriodEnd: new Date(Date.now() - 1000) }],
])('queued warning is skipped after %s without calling any delivery transport', async (_label, patch) => {
  const rows = await endingRows();
  await Subscription.updateOne({ _id: subscription._id }, { $set: patch });
  for (const row of rows) {
    expect(await verifySubscriptionNotificationAuthority(row)).toMatchObject({ outcome: 'skipped' });
    expect(await deliverNotificationRecord(row)).toMatchObject({ outcome: 'skipped' });
  }
  expect(await Notification.countDocuments()).toBe(0);
  expect(mockSendEmail).not.toHaveBeenCalled();
  expect(mockSendPush).not.toHaveBeenCalled();
  expect(mockNotifySeller).not.toHaveBeenCalled();
});

test.each([
  ['missing contract', copy => { copy.safepayBilling.contractId = null; }],
  ['missing environment', copy => { copy.safepayBilling.environment = null; }],
  ['invalid environment', copy => { copy.safepayBilling.environment = 'unknown'; }],
  ['invalid cancellation date', copy => { copy.cancelledAt = 'invalid-date'; }],
  ['missing cancellation', copy => { copy.cancelledAt = null; }],
  ['invalid period end', copy => { copy.currentPeriodEnd = 'invalid-date'; }],
  ['missing period end', copy => { copy.currentPeriodEnd = null; }],
  ['renewal enabled', copy => { copy.safepayBilling.autoRenew = true; }],
  ['already ended', copy => { copy.safepayBilling.endedAt = new Date(); }],
  ['pending downgrade', copy => { copy.pendingDowngrade.toPlan = 'starter'; }],
  ['incomplete scheduled downgrade', copy => { copy.pendingDowngrade.scheduledAt = new Date(); }],
  ['cancelled status', copy => { copy.status = 'cancelled'; }],
])('producer rejects %s without persisting partial notification rows', async (_label, mutate) => {
  const copy = subscription.toObject();
  mutate(copy);
  await expect(enqueueSubscriptionEndingNotification(copy)).rejects.toBeInstanceOf(Error);
  expect(await Outbox.countDocuments()).toBe(0);
});

test('a stale leftover Stripe ID is neither required nor authoritative for Safepay warning', async () => {
  subscription.stripeSubscriptionId = 'sub_stale_ignored_reference';
  await subscription.save();
  const rows = await endingRows();
  await Subscription.updateOne({ _id: subscription._id }, { $unset: { stripeSubscriptionId: 1 } });
  for (const row of rows) {
    expect(row.payload.data).not.toHaveProperty('stripeSubscriptionId');
    expect(await verifySubscriptionNotificationAuthority(row)).toBeNull();
  }
});

test.each([
  ['missing provider marker', row => { delete row.payload.data.billingProvider; }],
  ['different contract', row => { row.payload.data.safepayContractId = 'another-contract'; }],
  ['missing contract', row => { delete row.payload.data.safepayContractId; }],
  ['different environment', row => { row.payload.data.safepayEnvironment = 'production'; }],
  ['missing cancellation date', row => { delete row.payload.data.cancelledAtAt; }],
  ['invalid cancellation date', row => { row.payload.data.cancelledAtAt = 'invalid-date'; }],
  ['different period end', row => { row.payload.data.currentPeriodEndAt = new Date(Date.now() + 2 * 86400000).toISOString(); }],
  ['invalid period end', row => { row.payload.data.currentPeriodEndAt = 'invalid-date'; }],
  ['different occurrence timestamp', row => { row.occurredAt = new Date(new Date(row.occurredAt).getTime() + 1).toISOString(); }],
  ['invalid occurrence timestamp', row => { row.occurredAt = 'invalid-date'; }],
  ['different metadata type', row => { row.payload.data.type = 'subscription_updated'; }],
  ['missing metadata type', row => { delete row.payload.data.type; }],
  ['different metadata subscription', row => { row.payload.data.subscriptionId = String(new mongoose.Types.ObjectId()); }],
  ['missing metadata subscription', row => { delete row.payload.data.subscriptionId; }],
  ['different seller', row => { row.recipient.user = String(new mongoose.Types.ObjectId()); }],
  ['different audience', row => { row.recipient.audienceRole = 'buyer'; }],
])('forged %s cannot pass source authority or reach a delivery adapter', async (_label, mutate) => {
  const rows = await endingRows();
  const row = JSON.parse(JSON.stringify(rows.find(record => record.channel === 'email')));
  mutate(row);
  expect(await verifySubscriptionNotificationAuthority(row)).toMatchObject({ outcome: 'skipped' });
  expect(await deliverNotificationRecord(row)).toMatchObject({ outcome: 'skipped' });
  expect(mockSendEmail).not.toHaveBeenCalled();
  expect(mockSendPush).not.toHaveBeenCalled();
  expect(mockNotifySeller).not.toHaveBeenCalled();
});

test('the exact expiry boundary and later timestamps cannot create a misleading ending-soon warning', async () => {
  for (const now of [subscription.currentPeriodEnd, new Date(subscription.currentPeriodEnd.getTime() + 1)]) {
    await expect(enqueueSubscriptionEndingNotification(subscription, { now })).rejects.toBeInstanceOf(Error);
  }
  expect(await Outbox.countDocuments()).toBe(0);
});

test('a matched-but-expired source period never delivers an ending-soon message', async () => {
  const rows = await endingRows();
  const expired = new Date(Date.now() - 1000);
  await Subscription.updateOne({ _id: subscription._id }, { $set: { currentPeriodEnd: expired } });
  for (const source of rows) {
    const row = { ...source, occurredAt: expired,
      payload: { ...source.payload, data: { ...source.payload.data, currentPeriodEndAt: expired.toISOString() } } };
    expect(await verifySubscriptionNotificationAuthority(row)).toMatchObject({ outcome: 'skipped' });
    expect(await deliverNotificationRecord(row)).toMatchObject({ outcome: 'skipped' });
  }
  expect(await Notification.countDocuments()).toBe(0);
  expect(mockSendEmail).not.toHaveBeenCalled();
  expect(mockSendPush).not.toHaveBeenCalled();
  expect(mockNotifySeller).not.toHaveBeenCalled();
});

test('Safepay resume and a fresh recancellation reset the warning receipt and supersede the old event', async () => {
  const oldRows = await endingRows();
  await Subscription.updateOne({ _id: subscription._id }, { $set: { warningEmailSent: true } });
  await lifecycle.resume(seller._id);
  let current = await Subscription.findById(subscription._id);
  expect(current.warningEmailSent).toBe(false);
  expect(current.cancelledAt).toBeNull();
  expect(current.safepayBilling.autoRenew).toBe(true);
  for (const row of oldRows) expect(await verifySubscriptionNotificationAuthority(row)).toMatchObject({ outcome: 'skipped' });

  // Exercise a fresh cancellation even if a prior receipt was unexpectedly
  // retained; the saved cancellation resets that receipt in its transaction.
  await Subscription.updateOne({ _id: subscription._id }, { $set: { warningEmailSent: true } });
  await lifecycle.cancel(seller._id);
  current = await Subscription.findById(subscription._id);
  expect(current.warningEmailSent).toBe(false);
  expect(current.safepayBilling.autoRenew).toBe(false);
  expect(current.currentPeriodEnd).toEqual(subscription.currentPeriodEnd);
  expect(current.cancelledAt).not.toEqual(subscription.cancelledAt);
  await enqueueSubscriptionEndingNotification(current);
  const allRows = await Outbox.find({ eventType: 'subscription.ending_soon' }).lean();
  expect(allRows).toHaveLength(8);
  expect(new Set(allRows.map(row => row.eventKey)).size).toBe(2);
  const freshRows = allRows.filter(row => row.eventKey !== oldRows[0].eventKey);
  for (const row of freshRows) expect(await verifySubscriptionNotificationAuthority(row)).toBeNull();
  for (const row of oldRows) expect(await verifySubscriptionNotificationAuthority(row)).toMatchObject({ outcome: 'skipped' });
  // An idempotent repeat of the same cancellation must not clear a successful
  // receipt or cause an endless cron enqueue loop.
  await Subscription.updateOne({ _id: current._id }, { $set: { warningEmailSent: true } });
  const repeated = await lifecycle.cancel(seller._id);
  expect(repeated.reused).toBe(true);
  expect((await Subscription.findById(current._id)).warningEmailSent).toBe(true);
  expect(await Outbox.countDocuments({ eventType: 'subscription.ending_soon' })).toBe(8);
  expect(mockSendEmail).not.toHaveBeenCalled();
  expect(mockSendPush).not.toHaveBeenCalled();
  expect(mockNotifySeller).not.toHaveBeenCalled();
});
