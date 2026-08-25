const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../config/stripe', () => ({
  stripe: {
    invoices: { retrieve: jest.fn(), listLineItems: jest.fn() },
    invoicePayments: { list: jest.fn() },
    subscriptions: { retrieve: jest.fn(), update: jest.fn() },
  },
}));

const { stripe } = require('../../config/stripe');
const User = require('../../models/User');
const Store = require('../../models/Store');
const SellerSubscription = require('../../models/SellerSubscription');
const StripeEntitlementPayment = require('../../models/StripeEntitlementPayment');
const StripePaymentRiskReview = require('../../models/StripePaymentRiskReview');
const NotificationOutbox = require('../../models/NotificationOutbox');
const {
  flagStripePaymentRisk,
  recordFailedStripePaymentRiskReview,
} = require('../../services/stripePaymentRiskService');
const {
  verifyEntitlementRiskNotificationAuthority,
} = require('../../services/notificationOutboxDeliveryService');

let mongoServer;

const DAY_MS = 24 * 60 * 60 * 1000;
const eventSeconds = 1_780_000_000;

const createSellerStore = async suffix => {
  const seller = await User.create({
    username: `risk-notify-${suffix}`,
    email: `risk-notify-${suffix}@example.com`,
    role: 'seller',
    status: 'active',
    isVerified: true,
  });
  const store = await Store.create({
    seller: seller._id,
    storeName: `Risk Notify ${suffix}`,
    storeSlug: `risk-notify-${suffix}`,
    isActive: true,
  });
  return { seller, store };
};

const createSubdomainPayment = async suffix => {
  const { seller, store } = await createSellerStore(suffix);
  const grantStart = new Date(Date.now() - DAY_MS);
  const grantEnd = new Date(grantStart.getTime() + (3 * 365 * DAY_MS));
  const payment = await StripeEntitlementPayment.create({
    entitlementType: 'subdomain',
    sourceKey: `subdomain:pi_${suffix}`,
    seller: seller._id,
    store: store._id,
    resourceKey: store.storeSlug,
    paymentIntentId: `pi_${suffix}`,
    currency: 'usd',
    capturedMinor: 1500,
    grantStart,
    grantEnd,
    effectiveGrantEnd: grantEnd,
  });
  await Store.updateOne({ _id: store._id }, {
    $set: {
      'subdomainPurchase.isPurchased': true,
      'subdomainPurchase.purchasedAt': grantStart,
      'subdomainPurchase.expiresAt': grantEnd,
      'subdomainPurchase.stripePaymentId': payment.paymentIntentId,
      'subdomainPurchase.processedPaymentIds': [payment.paymentIntentId],
    },
  });
  return { seller, store, payment };
};

const createSubscriptionPayment = async suffix => {
  const { seller, store } = await createSellerStore(suffix);
  const subscription = await SellerSubscription.create({
    seller: seller._id,
    status: 'active',
    plan: 'starter',
    planName: 'Rozare Starter',
    stripeCustomerId: `cus_${suffix}`,
    stripeSubscriptionId: `sub_${suffix}`,
    stripePriceId: `price_${suffix}_999`,
    stripeProductId: `prod_${suffix}`,
    hasUsedFreePeriod: true,
  });
  const grantStart = new Date(Date.now() - DAY_MS);
  const grantEnd = new Date(grantStart.getTime() + (30 * DAY_MS));
  const payment = await StripeEntitlementPayment.create({
    entitlementType: 'subscription',
    sourceKey: `subscription:in_${suffix}`,
    seller: seller._id,
    invoiceId: `in_${suffix}`,
    stripeSubscriptionId: subscription.stripeSubscriptionId,
    paymentIntentId: `pi_${suffix}`,
    currency: 'usd',
    capturedMinor: 999,
    grantStart,
    grantEnd,
    effectiveGrantEnd: grantEnd,
    billingReason: 'subscription_cycle',
    fundedPlan: 'starter',
    fundedPlanName: 'Rozare Starter',
    fundedMetaAdsIncluded: false,
    fundedStripePriceId: subscription.stripePriceId,
    fundedStripeProductId: subscription.stripeProductId,
    fundedSubscriptionItemId: `si_${suffix}`,
    fundedUnitAmountMinor: 999,
  });
  return { seller, store, subscription, payment };
};

const refundObject = ({ id, chargeId, paymentIntentId, amount, created }) => ({
  id,
  status: 'succeeded',
  charge: chargeId,
  payment_intent: paymentIntentId,
  amount,
  currency: 'usd',
  created,
  metadata: {},
});

const refundCharge = ({
  fixture,
  suffix,
  amount,
  amountRefunded,
  refunds,
  sourceType,
}) => ({
  id: `ch_${suffix}`,
  payment_intent: fixture.payment.paymentIntentId,
  amount,
  amount_refunded: amountRefunded,
  currency: 'usd',
  created: eventSeconds,
  refunds: { data: refunds, has_more: false },
  metadata: {
    type: sourceType,
    sellerId: fixture.seller._id.toString(),
    ...(sourceType === 'subdomain_purchase'
      ? { storeId: fixture.store._id.toString() }
      : {}),
  },
});

const disputeCharge = ({ fixture, suffix, disputeId, disputeAmount, disputeStatus }) => ({
  id: `ch_${suffix}`,
  payment_intent: fixture.payment.paymentIntentId,
  amount: fixture.payment.capturedMinor,
  amount_refunded: 0,
  currency: 'usd',
  created: eventSeconds,
  disputeId,
  disputeAmount,
  disputeStatus,
  metadata: {
    type: 'subscription_invoice',
    sellerId: fixture.seller._id.toString(),
  },
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([
    StripeEntitlementPayment.init(),
    StripePaymentRiskReview.init(),
    NotificationOutbox.init(),
  ]);
});

beforeEach(() => {
  stripe.subscriptions.retrieve.mockReset().mockImplementation(async id => ({ id, status: 'active' }));
  stripe.subscriptions.update.mockReset().mockImplementation(async (id, params) => ({ id, ...params }));
  stripe.invoices.retrieve.mockReset();
  stripe.invoices.listLineItems.mockReset().mockResolvedValue({ data: [], has_more: false });
  stripe.invoicePayments.list.mockReset().mockResolvedValue({ data: [], has_more: false });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all([
    NotificationOutbox.deleteMany({}),
    StripePaymentRiskReview.deleteMany({}),
    StripeEntitlementPayment.deleteMany({}),
    SellerSubscription.deleteMany({}),
    Store.deleteMany({}),
    User.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

test('subdomain refund receipts use exact provider-backed deltas and reject changed event evidence', async () => {
  const fixture = await createSubdomainPayment('refund-delta');
  const chargeId = 'ch_refund-delta';
  const firstRefund = refundObject({
    id: 're_entitlement_first',
    chargeId,
    paymentIntentId: fixture.payment.paymentIntentId,
    amount: 750,
    created: eventSeconds - 20,
  });
  const firstCharge = refundCharge({
    fixture,
    suffix: 'refund-delta',
    amount: 1500,
    amountRefunded: 750,
    refunds: [firstRefund],
    sourceType: 'subdomain_purchase',
  });

  await flagStripePaymentRisk({
    charge: firstCharge,
    eventId: 'evt_entitlement_refund_first',
    eventType: 'charge.refunded',
    eventCreatedAt: eventSeconds,
  });
  await flagStripePaymentRisk({
    charge: firstCharge,
    eventId: 'evt_entitlement_refund_first',
    eventType: 'charge.refunded',
    eventCreatedAt: eventSeconds,
  });

  let rows = await NotificationOutbox.find({ eventType: 'subdomain.refund_confirmed' }).lean();
  expect(rows).toHaveLength(4);
  expect(new Set(rows.map(row => row.channel))).toEqual(new Set(['inapp', 'push', 'email', 'whatsapp']));
  expect(rows.every(row => row.money[0].amountMinor === 750 && row.money[0].currency === 'USD')).toBe(true);
  expect(rows.every(row => JSON.stringify(row.payload).includes('$7.50'))).toBe(true);

  const rewrittenFirstRefund = refundObject({
    id: 're_entitlement_first',
    chargeId,
    paymentIntentId: fixture.payment.paymentIntentId,
    amount: 700,
    created: eventSeconds - 20,
  });
  const inventedBalanceRefund = refundObject({
    id: 're_entitlement_invented_balance',
    chargeId,
    paymentIntentId: fixture.payment.paymentIntentId,
    amount: 50,
    created: eventSeconds - 15,
  });
  await expect(flagStripePaymentRisk({
    charge: refundCharge({
      fixture,
      suffix: 'refund-delta',
      amount: 1500,
      amountRefunded: 750,
      refunds: [rewrittenFirstRefund, inventedBalanceRefund],
      sourceType: 'subdomain_purchase',
    }),
    eventId: 'evt_entitlement_refund_rewritten_provider_object',
    eventType: 'charge.refunded',
    eventCreatedAt: eventSeconds + 1,
  })).rejects.toMatchObject({ code: 'STRIPE_ENTITLEMENT_REFUND_EVIDENCE_CONFLICT' });

  const secondRefund = refundObject({
    id: 're_entitlement_second',
    chargeId,
    paymentIntentId: fixture.payment.paymentIntentId,
    amount: 250,
    created: eventSeconds - 10,
  });
  const secondCharge = refundCharge({
    fixture,
    suffix: 'refund-delta',
    amount: 1500,
    amountRefunded: 1000,
    refunds: [firstRefund, secondRefund],
    sourceType: 'subdomain_purchase',
  });

  await expect(flagStripePaymentRisk({
    charge: secondCharge,
    eventId: 'evt_entitlement_refund_first',
    eventType: 'charge.refunded',
    eventCreatedAt: eventSeconds,
  })).rejects.toMatchObject({ code: 'STRIPE_ENTITLEMENT_RISK_IDEMPOTENCY_CONFLICT' });

  await flagStripePaymentRisk({
    charge: secondCharge,
    eventId: 'evt_entitlement_refund_second',
    eventType: 'charge.refunded',
    eventCreatedAt: eventSeconds + 2,
  });
  rows = await NotificationOutbox.find({ eventType: 'subdomain.refund_confirmed' })
    .sort({ occurredAt: 1 })
    .lean();
  expect(rows).toHaveLength(8);
  const secondRows = rows.filter(row => row.eventKey.includes(
    fixture.payment._id.toString(),
  ) && row.money[0].amountMinor === 250);
  expect(secondRows).toHaveLength(4);
  expect(secondRows.every(row => JSON.stringify(row.payload).includes('$2.50'))).toBe(true);
  expect(secondRows.every(row => row.payload.data.providerReferences.join(',') === 're_entitlement_second')).toBe(true);

  const payment = await StripeEntitlementPayment.findById(fixture.payment._id);
  expect(payment.refundedMinor).toBe(1000);
  expect(payment.riskNotificationIntents).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'refund', amountMinor: 750, state: 'outboxed' }),
    expect.objectContaining({ kind: 'refund', amountMinor: 250, state: 'outboxed' }),
  ]));
  for (const row of rows) {
    await expect(verifyEntitlementRiskNotificationAuthority(row)).resolves.toBeNull();
  }
});

test('subscription inquiry, financial open, won, and lost outcomes are exact and replay-safe across four channels', async () => {
  const fixture = await createSubscriptionPayment('dispute-lifecycle');
  const inquiry = disputeCharge({
    fixture,
    suffix: 'dispute-lifecycle',
    disputeId: 'dp_entitlement_primary',
    disputeAmount: 999,
    disputeStatus: 'warning_needs_response',
  });

  const concurrentRisk = await Promise.allSettled([
    flagStripePaymentRisk({
      charge: inquiry,
      eventId: 'evt_entitlement_inquiry',
      eventType: 'charge.dispute.created',
      eventCreatedAt: eventSeconds,
    }),
    flagStripePaymentRisk({
      charge: inquiry,
      eventId: 'evt_entitlement_inquiry',
      eventType: 'charge.dispute.created',
      eventCreatedAt: eventSeconds,
    }),
  ]);
  expect(concurrentRisk.some(result => result.status === 'fulfilled')).toBe(true);
  expect(concurrentRisk.filter(result => result.status === 'rejected').every(
    result => result.reason?.name === 'VersionError',
  )).toBe(true);
  // Any concurrent projection loser is retryable; the atomic risk intent
  // winner makes this replay converge the same four channel rows.
  await flagStripePaymentRisk({
    charge: inquiry,
    eventId: 'evt_entitlement_inquiry',
    eventType: 'charge.dispute.created',
    eventCreatedAt: eventSeconds,
  });
  await flagStripePaymentRisk({
    charge: { ...inquiry, disputeStatus: 'needs_response' },
    eventId: 'evt_entitlement_open',
    eventType: 'charge.dispute.funds_withdrawn',
    eventCreatedAt: eventSeconds + 1,
  });
  await expect(flagStripePaymentRisk({
    charge: { ...inquiry, disputeAmount: 998, disputeStatus: 'under_review' },
    eventId: 'evt_entitlement_changed_dispute_amount',
    eventType: 'charge.dispute.created',
    eventCreatedAt: eventSeconds + 2,
  })).rejects.toMatchObject({ code: 'STRIPE_ENTITLEMENT_DISPUTE_AMOUNT_CHANGED' });
  await flagStripePaymentRisk({
    charge: { ...inquiry, disputeStatus: 'won' },
    eventId: 'evt_entitlement_won',
    eventType: 'charge.dispute.funds_reinstated',
    eventCreatedAt: eventSeconds + 3,
  });
  await flagStripePaymentRisk({
    charge: disputeCharge({
      fixture,
      suffix: 'dispute-lifecycle',
      disputeId: 'dp_entitlement_second',
      disputeAmount: 400,
      disputeStatus: 'lost',
    }),
    eventId: 'evt_entitlement_lost',
    eventType: 'charge.dispute.closed',
    eventCreatedAt: eventSeconds + 4,
  });

  const rows = await NotificationOutbox.find({
    eventType: {
      $in: [
        'subscription.dispute_opened',
        'subscription.dispute_won',
        'subscription.dispute_lost',
      ],
    },
  }).lean();
  expect(rows).toHaveLength(16);
  expect(rows.filter(row => row.eventType === 'subscription.dispute_opened')).toHaveLength(8);
  expect(rows.filter(row => row.eventType === 'subscription.dispute_won')).toHaveLength(4);
  expect(rows.filter(row => row.eventType === 'subscription.dispute_lost')).toHaveLength(4);
  expect(rows.filter(row => row.eventType !== 'subscription.dispute_lost')
    .every(row => row.money[0].amountMinor === 999)).toBe(true);
  expect(rows.filter(row => row.eventType === 'subscription.dispute_lost')
    .every(row => row.money[0].amountMinor === 400)).toBe(true);
  const wonText = rows.filter(row => row.eventType === 'subscription.dispute_won')
    .map(row => JSON.stringify(row.payload)).join(' ');
  expect(wonText).toContain('not a new payment or refund');
  const lostText = rows.filter(row => row.eventType === 'subscription.dispute_lost')
    .map(row => JSON.stringify(row.payload)).join(' ');
  expect(lostText).toContain('not a separate refund');
  for (const row of rows.filter(candidate => candidate.eventType !== 'subscription.dispute_opened')) {
    await expect(verifyEntitlementRiskNotificationAuthority(row)).resolves.toBeNull();
  }
  for (const row of rows.filter(candidate => candidate.eventType === 'subscription.dispute_opened')) {
    await expect(verifyEntitlementRiskNotificationAuthority(row)).resolves.toEqual(
      expect.objectContaining({ outcome: 'skipped', code: 'NOTIFICATION_NO_LONGER_ACTIONABLE' }),
    );
  }
});

test('a notification-outbox outage leaves a durable pending intent that an identical webhook replay completes once', async () => {
  const fixture = await createSubscriptionPayment('outbox-recovery');
  const chargeId = 'ch_outbox-recovery';
  const refund = refundObject({
    id: 're_entitlement_recovery',
    chargeId,
    paymentIntentId: fixture.payment.paymentIntentId,
    amount: 300,
    created: eventSeconds - 1,
  });
  const charge = refundCharge({
    fixture,
    suffix: 'outbox-recovery',
    amount: 999,
    amountRefunded: 300,
    refunds: [refund],
    sourceType: 'subscription_invoice',
  });
  const originalFindOneAndUpdate = NotificationOutbox.findOneAndUpdate.bind(NotificationOutbox);
  const outage = new Error('Notification database temporarily unavailable.');
  outage.code = 'ECONNRESET';
  const spy = jest.spyOn(NotificationOutbox, 'findOneAndUpdate')
    .mockImplementationOnce(() => ({ select: () => Promise.reject(outage) }))
    .mockImplementation((...args) => originalFindOneAndUpdate(...args));

  await expect(flagStripePaymentRisk({
    charge,
    eventId: 'evt_entitlement_outbox_recovery',
    eventType: 'charge.refunded',
    eventCreatedAt: eventSeconds,
  })).rejects.toBe(outage);
  spy.mockRestore();

  let payment = await StripeEntitlementPayment.findById(fixture.payment._id);
  expect(payment.refundedMinor).toBe(300);
  expect(payment.riskNotificationIntents).toEqual([
    expect.objectContaining({ kind: 'refund', amountMinor: 300, state: 'pending', outboxEnqueuedAt: null }),
  ]);
  expect(await NotificationOutbox.countDocuments({ eventType: 'subscription.refund_confirmed' })).toBe(0);

  await flagStripePaymentRisk({
    charge,
    eventId: 'evt_entitlement_outbox_recovery',
    eventType: 'charge.refunded',
    eventCreatedAt: eventSeconds,
  });
  await flagStripePaymentRisk({
    charge,
    eventId: 'evt_entitlement_outbox_recovery',
    eventType: 'charge.refunded',
    eventCreatedAt: eventSeconds,
  });
  payment = await StripeEntitlementPayment.findById(fixture.payment._id);
  expect(payment.riskNotificationIntents[0]).toMatchObject({ state: 'outboxed' });
  expect(payment.riskNotificationIntents[0].outboxEnqueuedAt).toBeInstanceOf(Date);
  expect(await NotificationOutbox.countDocuments({ eventType: 'subscription.refund_confirmed' })).toBe(4);
});

test('incomplete aggregate refund evidence reverses access but quarantines seller copy for durable four-channel admin review', async () => {
  const fixture = await createSubscriptionPayment('refund-review');
  const admin = await User.create({
    username: 'risk-review-admin',
    email: 'risk-review-admin@example.com',
    role: 'admin',
    status: 'active',
    isVerified: true,
  });
  const charge = {
    id: 'ch_refund-review',
    payment_intent: fixture.payment.paymentIntentId,
    amount: 999,
    amount_refunded: 400,
    currency: 'usd',
    created: eventSeconds,
    metadata: {
      type: 'subscription_invoice',
      sellerId: fixture.seller._id.toString(),
    },
    // Missing Charge.refunds is intentionally not enough evidence to tell the
    // seller that a specific new provider refund completed.
  };

  const first = await flagStripePaymentRisk({
    charge,
    eventId: 'evt_entitlement_refund_review',
    eventType: 'charge.refunded',
    eventCreatedAt: eventSeconds,
  });
  const second = await flagStripePaymentRisk({
    charge,
    eventId: 'evt_entitlement_refund_review',
    eventType: 'charge.refunded',
    eventCreatedAt: eventSeconds,
  });
  expect(first.manualReview).toBeTruthy();
  expect(second.manualReview._id.toString()).toBe(first.manualReview._id.toString());

  const payment = await StripeEntitlementPayment.findById(fixture.payment._id);
  expect(payment.refundedMinor).toBe(400);
  expect(payment.riskNotificationIntents).toHaveLength(0);
  expect(await NotificationOutbox.countDocuments({ eventType: 'subscription.refund_confirmed' })).toBe(0);
  const review = await StripePaymentRiskReview.findOne({
    stripeEventId: 'evt_entitlement_refund_review',
  });
  expect(review).toMatchObject({
    status: 'open',
    sourceType: 'subscription_invoice',
    sourceReferenceId: fixture.payment._id.toString(),
    reasonCode: 'STRIPE_REFUND_OBJECTS_MISSING',
    refundExposureMinor: 400,
  });
  const adminRows = await NotificationOutbox.find({
    eventType: 'payment.risk_review_required',
    'recipient.user': admin._id,
  }).lean();
  expect(adminRows).toHaveLength(4);
  expect(new Set(adminRows.map(row => row.channel))).toEqual(new Set(['inapp', 'push', 'email', 'whatsapp']));
});

test('failed legacy entitlement processing resolves durable ledger ownership and replays one admin review', async () => {
  const fixture = await createSubdomainPayment('legacy-review-owner');
  const admin = await User.create({
    username: 'legacy-risk-review-admin',
    email: 'legacy-risk-review-admin@example.com',
    role: 'admin',
    status: 'active',
    isVerified: true,
  });
  const providerCharge = {
    id: 'ch_legacy-review-owner',
    payment_intent: fixture.payment.paymentIntentId,
    amount: fixture.payment.capturedMinor,
    amount_refunded: 0,
    currency: 'usd',
    created: eventSeconds,
    metadata: { type: 'legacy_entitlement_label' },
  };
  const processingError = Object.assign(
    new Error('The signed entitlement event could not be reconciled automatically.'),
    { code: 'STRIPE_ENTITLEMENT_OWNER_AMBIGUOUS' },
  );

  const first = await recordFailedStripePaymentRiskReview({
    charge: providerCharge,
    eventId: 'evt_legacy_entitlement_review',
    eventType: 'charge.dispute.created',
    eventCreatedAt: eventSeconds,
    error: processingError,
  });
  const replay = await recordFailedStripePaymentRiskReview({
    charge: providerCharge,
    eventId: 'evt_legacy_entitlement_review',
    eventType: 'charge.dispute.created',
    eventCreatedAt: eventSeconds,
    error: processingError,
  });

  expect(first.review._id.toString()).toBe(replay.review._id.toString());
  expect(await StripePaymentRiskReview.findOne({
    stripeEventId: 'evt_legacy_entitlement_review',
  }).lean()).toMatchObject({
    status: 'open',
    sourceType: 'subdomain_purchase',
    sourceReferenceId: fixture.payment._id.toString(),
    reasonCode: 'STRIPE_ENTITLEMENT_OWNER_AMBIGUOUS',
  });
  const adminRows = await NotificationOutbox.find({
    eventType: 'payment.risk_review_required',
    'recipient.user': admin._id,
  }).lean();
  expect(adminRows).toHaveLength(4);
  expect(new Set(adminRows.map(row => row.channel))).toEqual(new Set(['inapp', 'push', 'email', 'whatsapp']));
  expect(await NotificationOutbox.countDocuments({
    eventType: { $regex: /^subdomain\.(refund|dispute)_/ },
  })).toBe(0);
});
