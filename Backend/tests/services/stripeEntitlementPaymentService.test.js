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
const SellerCheckoutClaim = require('../../models/SellerCheckoutClaim');
const StripeEntitlementPayment = require('../../models/StripeEntitlementPayment');
const NotificationOutbox = require('../../models/NotificationOutbox');
const {
  flagStripeEntitlementPaymentRisk,
  recomputeSubscriptionEntitlement,
  recordSubdomainCheckoutPayment,
  recordSubscriptionInvoiceFailure,
  recordSubscriptionInvoicePayment,
} = require('../../services/stripeEntitlementPaymentService');
const { addUtcCalendarYears } = require('../../services/utcCalendarService');
const { flagStripePaymentRisk } = require('../../services/stripePaymentRiskService');
const { buildPlanPricing } = require('../../services/subscriptionPricingService');

let mongoServer;

const DAY_MS = 24 * 60 * 60 * 1000;
const LEGACY_SUBDOMAIN_GRANT_MS = 3 * 365 * DAY_MS;
const seconds = date => Math.floor(date.getTime() / 1000);
const stripePrecisionDate = value => new Date(Math.floor(value / 1000) * 1000);

const sellerAndStore = async suffix => {
  const seller = await User.create({
    username: `entitlement-${suffix}`,
    email: `entitlement-${suffix}@example.com`,
    role: 'seller',
    isVerified: true,
  });
  const store = await Store.create({
    seller: seller._id,
    storeName: `Entitlement ${suffix}`,
    storeSlug: `entitlement-${suffix}`,
    isActive: true,
  });
  return { seller, store };
};

const subdomainSession = ({ seller, store, paymentIntentId, renewal = false }) => ({
  id: `cs_${paymentIntentId}`,
  mode: 'payment',
  payment_status: 'paid',
  amount_total: 1500,
  currency: 'usd',
  payment_intent: paymentIntentId,
  metadata: {
    type: 'subdomain_purchase',
    sellerId: seller._id.toString(),
    storeId: store._id.toString(),
    storeSlug: store.storeSlug,
    isRenewal: renewal ? 'true' : 'false',
  },
});

const paidInvoice = ({
  id,
  subscriptionId,
  customer,
  paymentIntentId,
  chargeId,
  amount = 3000,
  start,
  end,
  billingReason = 'subscription_cycle',
  linePeriods,
  unitAmountMinor = 999,
}) => ({
  id,
  customer: customer || String(subscriptionId).replace(/^sub_/, 'cus_'),
  subscription: subscriptionId,
  payment_intent: paymentIntentId || `pi_${id}`,
  charge: chargeId || `ch_${id}`,
  amount_paid: amount,
  amount_remaining: 0,
  currency: 'usd',
  status: 'paid',
  billing_reason: billingReason,
  period_start: seconds(start),
  period_end: seconds(end),
  lines: {
    has_more: false,
    data: (linePeriods || [{ start, end, amount }]).map((line, index) => ({
      id: `il_${id}_${index}`,
      amount: line.amount,
      currency: 'usd',
      quantity: 1,
      parent: {
        type: 'subscription_item_details',
        subscription_item_details: {
          subscription: subscriptionId,
          subscription_item: `si_${subscriptionId}`,
          proration: Boolean(line.proration),
        },
      },
      pricing: {
        type: 'price_details',
        unit_amount_decimal: String(line.unitAmountMinor || unitAmountMinor),
        price_details: {
          price: line.priceId || `price_${subscriptionId}_${line.unitAmountMinor || unitAmountMinor}`,
          product: `prod_${subscriptionId}`,
        },
      },
      period: { start: seconds(line.start), end: seconds(line.end) },
    })),
  },
  payments: {
    object: 'list',
    has_more: false,
    data: [{
      id: `inpay_${id}`,
      object: 'invoice_payment',
      amount_paid: amount,
      amount_requested: amount,
      currency: 'usd',
      invoice: id,
      status: 'paid',
      created: seconds(start),
      status_transitions: { paid_at: seconds(start), canceled_at: null },
      payment: {
        type: 'payment_intent',
        payment_intent: paymentIntentId || `pi_${id}`,
      },
    }],
  },
});

const riskCharge = ({
  paymentIntentId,
  chargeId,
  amount = 3000,
  customer = null,
  refunded = 0,
  disputeId = '',
  disputeAmount = 0,
  disputeStatus = '',
  invoice = null,
}) => ({
  id: chargeId,
  payment_intent: paymentIntentId,
  amount,
  customer,
  amount_refunded: refunded,
  disputeId,
  disputeAmount,
  disputeStatus,
  currency: 'usd',
  invoice,
  metadata: {},
});

const appliedSubscriptionUpdateResponse = (id, params) => ({
  id,
  metadata: params.metadata,
  discounts: [],
  items: {
    has_more: false,
    data: (params.items || []).filter(item => !item.deleted).map(item => ({
      id: item.id,
      price: item.price,
      quantity: item.quantity,
      discounts: [],
    })),
  },
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await SellerCheckoutClaim.init();
  await StripeEntitlementPayment.init();
  await NotificationOutbox.init();
});

beforeEach(() => {
  stripe.subscriptions.update.mockReset().mockImplementation(async (id, params) => (
    appliedSubscriptionUpdateResponse(id, params)
  ));
  stripe.subscriptions.retrieve.mockReset().mockImplementation(async id => ({ id, status: 'active' }));
  stripe.invoices.retrieve.mockReset();
  stripe.invoices.listLineItems.mockReset().mockResolvedValue({ data: [], has_more: false });
  stripe.invoicePayments.list.mockReset().mockResolvedValue({ data: [], has_more: false });
});

afterEach(async () => {
  await Promise.all([
    StripeEntitlementPayment.deleteMany({}),
    NotificationOutbox.deleteMany({}),
    SellerCheckoutClaim.deleteMany({}),
    SellerSubscription.deleteMany({}),
    Store.deleteMany({}),
    User.deleteMany({}),
  ]);
  jest.clearAllMocks();
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

describe('subdomain payment contributions', () => {
  test.each([
    ['an unpaid Checkout', 'unpaid', { payment_status: 'unpaid' }, 'SUBDOMAIN_PAYMENT_MISMATCH'],
    ['a different currency', 'currency', { currency: 'pkr' }, 'SUBDOMAIN_PAYMENT_MISMATCH'],
    ['a different amount', 'amount', { amount_total: 1499 }, 'SUBDOMAIN_PAYMENT_MISMATCH'],
    ['a boolean amount', 'boolean-amount', { amount_total: true }, 'STRIPE_ENTITLEMENT_AMOUNT_INVALID'],
    ['a missing PaymentIntent', 'intent', { payment_intent: null }, 'SUBDOMAIN_CHECKOUT_METADATA_INVALID'],
  ])('rejects %s without granting ownership', async (_label, suffix, override, code) => {
    const { seller, store } = await sellerAndStore(`invalid-${suffix}`);
    const session = {
      ...subdomainSession({ seller, store, paymentIntentId: `pi_invalid_${code}` }),
      ...override,
    };

    await expect(recordSubdomainCheckoutPayment(session)).rejects.toMatchObject({ code });
    await expect(StripeEntitlementPayment.countDocuments({ store: store._id })).resolves.toBe(0);
    const unchanged = await Store.findById(store._id);
    expect(unchanged.subdomainPurchase?.isPurchased).not.toBe(true);
  });

  test('subdomain payment receipt freezes provider time and recovers concurrent or post-outbox replay once', async () => {
    const { seller, store } = await sellerAndStore('subdomain-receipt-replay');
    const providerCreated = 1_787_650_000;
    const session = {
      ...subdomainSession({ seller, store, paymentIntentId: 'pi_subdomain_receipt_replay' }),
      created: providerCreated,
    };

    const [first, concurrentReplay] = await Promise.all([
      recordSubdomainCheckoutPayment(session),
      recordSubdomainCheckoutPayment(session),
    ]);
    let payment = await StripeEntitlementPayment.findById(first.payment._id);
    let rows = await NotificationOutbox.find({ aggregateId: String(payment._id) }).lean();
    expect([first.created, concurrentReplay.created].sort()).toEqual([false, true]);
    expect(payment.paymentNotification.kind).toBe('received');
    expect(payment.paymentNotification.occurredAt).toEqual(new Date(providerCreated * 1000));
    expect(payment.paymentNotification.outboxEnqueuedAt).toBeInstanceOf(Date);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map(row => row.eventType))).toEqual(new Set(['subdomain.payment_received']));
    expect(rows.every(row => row.money[0].amountMinor === 1500)).toBe(true);

    // Simulate a crash after all four idempotent rows were inserted but before
    // the durable payment marker was written. A Stripe replay must reconstruct
    // the same marker and must not create or reinterpret another receipt.
    await StripeEntitlementPayment.updateOne({ _id: payment._id }, {
      $set: {
        'paymentNotification.kind': null,
        'paymentNotification.occurredAt': null,
        'paymentNotification.outboxEnqueuedAt': null,
      },
    });
    await recordSubdomainCheckoutPayment(session);
    payment = await StripeEntitlementPayment.findById(payment._id);
    rows = await NotificationOutbox.find({ aggregateId: String(payment._id) }).lean();
    expect(payment.paymentNotification.kind).toBe('received');
    expect(payment.paymentNotification.occurredAt).toEqual(new Date(providerCreated * 1000));
    expect(payment.paymentNotification.outboxEnqueuedAt).toBeInstanceOf(Date);
    expect(rows).toHaveLength(4);
  });

  test('records each renewal once and a partial refund shortens only that fixed contribution', async () => {
    const { seller, store } = await sellerAndStore('renewals');
    const first = subdomainSession({ seller, store, paymentIntentId: 'pi_sub_first' });
    const renewal = subdomainSession({ seller, store, paymentIntentId: 'pi_sub_renewal', renewal: true });

    await recordSubdomainCheckoutPayment(first);
    const afterFirst = await Store.findById(store._id);
    await recordSubdomainCheckoutPayment(renewal);
    await recordSubdomainCheckoutPayment(renewal);
    const beforeRefund = await Store.findById(store._id);
    const paymentsBeforeRefund = await StripeEntitlementPayment.find({ store: store._id })
      .sort({ grantStart: 1 });
    const firstGrantMs = paymentsBeforeRefund[0].grantEnd - paymentsBeforeRefund[0].grantStart;
    const renewalGrantMs = paymentsBeforeRefund[1].grantEnd - paymentsBeforeRefund[1].grantStart;

    expect(await StripeEntitlementPayment.countDocuments({ store: store._id })).toBe(2);
    expect(beforeRefund.subdomainPurchase.expiresAt.getTime() - afterFirst.subdomainPurchase.expiresAt.getTime())
      .toBe(renewalGrantMs);

    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_sub_first',
        chargeId: 'ch_sub_first',
        refunded: 750,
      }),
      eventId: 'evt_sub_half_refund',
      eventType: 'charge.refunded',
    });
    const afterRefund = await Store.findById(store._id);
    expect(beforeRefund.subdomainPurchase.expiresAt.getTime() - afterRefund.subdomainPurchase.expiresAt.getTime())
      .toBe(Number((BigInt(firstGrantMs) * 750n) / 1500n));
    expect(afterRefund.subdomainPurchase.isPurchased).toBe(true);
  });

  test.each([
    ['jan-31', '2027-01-31T10:15:30.000Z', '2030-01-31T10:15:30.000Z'],
    ['leap-day', '2028-02-29T10:15:30.000Z', '2031-02-28T10:15:30.000Z'],
  ])(
    'renewal from %s preserves the prior grant end and adds three clamped calendar years',
    async (suffix, priorEndIso, expectedEndIso) => {
      const { seller, store } = await sellerAndStore(`calendar-${suffix}`);
      const priorEnd = new Date(priorEndIso);
      const priorStart = addUtcCalendarYears(priorEnd, -3);
      await StripeEntitlementPayment.create({
        entitlementType: 'subdomain',
        sourceKey: `subdomain:pi_calendar_prior_${suffix}`,
        seller: seller._id,
        store: store._id,
        resourceKey: store.storeSlug,
        paymentIntentId: `pi_calendar_prior_${suffix}`,
        currency: 'usd',
        capturedMinor: 1500,
        grantStart: priorStart,
        grantEnd: priorEnd,
        effectiveGrantEnd: priorEnd,
      });
      await Store.updateOne({ _id: store._id }, {
        $set: {
          'subdomainPurchase.isPurchased': true,
          'subdomainPurchase.purchasedAt': priorStart,
          'subdomainPurchase.expiresAt': priorEnd,
          'subdomainPurchase.stripePaymentId': `pi_calendar_prior_${suffix}`,
          'subdomainPurchase.processedPaymentIds': [`pi_calendar_prior_${suffix}`],
        },
      });

      await recordSubdomainCheckoutPayment(subdomainSession({
        seller,
        store,
        paymentIntentId: `pi_calendar_renewal_${suffix}`,
        renewal: true,
      }));

      const renewal = await StripeEntitlementPayment.findOne({
        paymentIntentId: `pi_calendar_renewal_${suffix}`,
      });
      const updated = await Store.findById(store._id);
      expect(renewal.grantStart.toISOString()).toBe(priorEndIso);
      expect(renewal.grantEnd.toISOString()).toBe(expectedEndIso);
      expect(updated.subdomainPurchase.expiresAt.toISOString()).toBe(expectedEndIso);
    },
  );

  test('refund and full lost dispute do not double-revoke a renewal contribution', async () => {
    const { seller, store } = await sellerAndStore('double-risk');
    await recordSubdomainCheckoutPayment(subdomainSession({ seller, store, paymentIntentId: 'pi_sub_risk_1' }));
    await recordSubdomainCheckoutPayment(subdomainSession({ seller, store, paymentIntentId: 'pi_sub_risk_2', renewal: true }));

    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({ paymentIntentId: 'pi_sub_risk_1', chargeId: 'ch_sub_risk', refunded: 750 }),
      eventId: 'evt_sub_refund',
      eventType: 'charge.refunded',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_sub_risk_1',
        chargeId: 'ch_sub_risk',
        refunded: 750,
        disputeId: 'dp_sub_lost',
        disputeAmount: 1500,
        disputeStatus: 'lost',
      }),
      eventId: 'evt_sub_lost',
      eventType: 'charge.dispute.closed',
    });

    const payments = await StripeEntitlementPayment.find({ store: store._id }).sort({ grantStart: 1 });
    const updated = await Store.findById(store._id);
    const renewalGrantMs = payments[1].grantEnd - payments[1].grantStart;
    expect(payments[0].effectiveGrantEnd.getTime()).toBe(payments[0].grantStart.getTime());
    expect(payments[1].effectiveGrantEnd.getTime() - payments[1].grantStart.getTime())
      .toBe(renewalGrantMs);
    expect(updated.subdomainPurchase.expiresAt.getTime() - payments[0].grantStart.getTime())
      .toBe(renewalGrantMs);
  });

  test('adds independent refund and lost-dispute exposure, while a won dispute releases only its track', async () => {
    const lostFixture = await sellerAndStore('additive-lost');
    await recordSubdomainCheckoutPayment(subdomainSession({
      ...lostFixture,
      paymentIntentId: 'pi_sub_additive_lost',
    }));
    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_sub_additive_lost',
        chargeId: 'ch_sub_additive_lost',
        refunded: 500,
      }),
      eventId: 'evt_sub_additive_refund',
      eventType: 'charge.refunded',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_sub_additive_lost',
        chargeId: 'ch_sub_additive_lost',
        refunded: 500,
        disputeId: 'dp_sub_additive_lost',
        disputeAmount: 1000,
        disputeStatus: 'lost',
      }),
      eventId: 'evt_sub_additive_lost',
      eventType: 'charge.dispute.closed',
    });
    const lostPayment = await StripeEntitlementPayment.findOne({
      paymentIntentId: 'pi_sub_additive_lost',
    });
    expect(lostPayment.effectiveGrantEnd).toEqual(lostPayment.grantStart);

    const wonFixture = await sellerAndStore('additive-won');
    await recordSubdomainCheckoutPayment(subdomainSession({
      ...wonFixture,
      paymentIntentId: 'pi_sub_additive_won',
    }));
    const wonBase = riskCharge({
      paymentIntentId: 'pi_sub_additive_won',
      chargeId: 'ch_sub_additive_won',
      refunded: 500,
      disputeId: 'dp_sub_additive_won',
      disputeAmount: 1000,
      disputeStatus: 'needs_response',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: { ...wonBase, disputeId: '', disputeAmount: 0, disputeStatus: '' },
      eventId: 'evt_sub_won_refund',
      eventType: 'charge.refunded',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: wonBase,
      eventId: 'evt_sub_won_open',
      eventType: 'charge.dispute.funds_withdrawn',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: { ...wonBase, disputeStatus: 'won' },
      eventId: 'evt_sub_won_terminal',
      eventType: 'charge.dispute.closed',
    });
    const wonPayment = await StripeEntitlementPayment.findOne({
      paymentIntentId: 'pi_sub_additive_won',
    });
    const originalDurationMs = wonPayment.grantEnd - wonPayment.grantStart;
    expect(wonPayment.effectiveGrantEnd.getTime() - wonPayment.grantStart.getTime())
      .toBe(Number((BigInt(originalDurationMs) * 1000n) / 1500n));
  });

  test('provisional dispute freezes without shortening, and won restores exactly despite a delayed event', async () => {
    const { seller, store } = await sellerAndStore('won');
    await recordSubdomainCheckoutPayment(subdomainSession({ seller, store, paymentIntentId: 'pi_sub_won' }));
    const original = await Store.findById(store._id);
    const openCharge = riskCharge({
      paymentIntentId: 'pi_sub_won',
      chargeId: 'ch_sub_won',
      disputeId: 'dp_sub_won',
      disputeAmount: 1500,
      disputeStatus: 'needs_response',
    });

    await flagStripeEntitlementPaymentRisk({
      charge: openCharge,
      eventId: 'evt_sub_open',
      eventType: 'charge.dispute.funds_withdrawn',
    });
    let disputed = await Store.findById(store._id);
    expect(disputed.subdomainPurchase.paymentRiskState).toBe('open');
    expect(disputed.subdomainPurchase.expiresAt.getTime()).toBe(original.subdomainPurchase.expiresAt.getTime());

    await flagStripeEntitlementPaymentRisk({
      charge: { ...openCharge, disputeStatus: 'won' },
      eventId: 'evt_sub_won',
      eventType: 'charge.dispute.closed',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: openCharge,
      eventId: 'evt_sub_delayed_open',
      eventType: 'charge.dispute.funds_withdrawn',
    });
    disputed = await Store.findById(store._id);
    expect(disputed.subdomainPurchase.paymentRiskState).toBe('none');
    expect(disputed.subdomainPurchase.expiresAt.getTime()).toBe(original.subdomainPurchase.expiresAt.getTime());
  });

  test('resolves an old metadata-less charge from the stored PaymentIntent', async () => {
    const { store } = await sellerAndStore('historical');
    const purchasedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const expiresAt = new Date(purchasedAt.getTime() + LEGACY_SUBDOMAIN_GRANT_MS);
    store.subdomainPurchase = {
      isPurchased: true,
      purchasedAt,
      expiresAt,
      stripePaymentId: 'pi_historical_subdomain',
      processedPaymentIds: ['pi_historical_subdomain'],
    };
    await store.save();

    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_historical_subdomain',
        chargeId: 'ch_historical_subdomain',
        refunded: 1500,
      }),
      eventId: 'evt_historical_subdomain_refund',
      eventType: 'charge.refunded',
    });
    const updated = await Store.findById(store._id);
    expect(updated.subdomainPurchase.isPurchased).toBe(false);
    expect(await StripeEntitlementPayment.countDocuments({ paymentIntentId: 'pi_historical_subdomain' })).toBe(1);
  });

  test('a blocked store gets a fresh removal grace period when its paid protection is fully reversed', async () => {
    const { seller, store } = await sellerAndStore('reversal-removal');
    await recordSubdomainCheckoutPayment(subdomainSession({
      seller,
      store,
      paymentIntentId: 'pi_subdomain_reversal_removal',
    }));
    await Store.updateOne({ _id: store._id }, {
      $set: {
        isActive: false,
        blockedAt: new Date(Date.now() - 30 * DAY_MS),
      },
    });
    const before = Date.now();

    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_subdomain_reversal_removal',
        chargeId: 'ch_subdomain_reversal_removal',
        refunded: 1500,
      }),
      eventId: 'evt_subdomain_reversal_removal',
      eventType: 'charge.refunded',
    });

    const updated = await Store.findById(store._id);
    expect(updated.subdomainPurchase.isPurchased).toBe(false);
    expect(updated.subdomainPurchase.removalScheduledAt.getTime()).toBeGreaterThanOrEqual(before + 7 * DAY_MS);
    expect(updated.subdomainPurchase.removalScheduledAt.getTime()).toBeLessThanOrEqual(Date.now() + 7 * DAY_MS);
  });
});

describe('subscription invoice contributions and reversals', () => {
  const setupSubscription = async suffix => {
    const { seller, store } = await sellerAndStore(suffix);
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'past_due',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: `cus_${suffix}`,
      stripeSubscriptionId: `sub_${suffix}`,
      stripePriceId: `price_sub_${suffix}_999`,
      stripeProductId: `prod_sub_${suffix}`,
      hasUsedFreePeriod: true,
    });
    return { seller, store, subscription };
  };

  const paidStarterThenPendingUpgrade = async suffix => {
    const fixture = await setupSubscription(suffix);
    let { subscription } = fixture;
    const now = Date.now();
    subscription.status = 'past_due';
    subscription.bonusFeaturesActive = true;
    subscription.bonusExpiryDate = new Date(now + 90 * DAY_MS);
    subscription.bonusFeaturesExpiredPermanently = false;
    subscription.starterBonusPeriodUsed = true;
    await subscription.save();

    const baseStart = stripePrecisionDate(now - DAY_MS);
    const baseEnd = new Date(baseStart.getTime() + 30 * DAY_MS);
    const baseInvoice = paidInvoice({
      id: `in_${suffix}_starter_base`,
      subscriptionId: subscription.stripeSubscriptionId,
      customer: subscription.stripeCustomerId,
      paymentIntentId: `pi_${suffix}_starter_base`,
      chargeId: `ch_${suffix}_starter_base`,
      amount: 999,
      start: baseStart,
      end: baseEnd,
    });
    await recordSubscriptionInvoicePayment({
      invoice: baseInvoice,
      eventId: `evt_${suffix}_starter_base`,
      eventCreated: 100,
    });

    subscription = await SellerSubscription.findById(subscription._id);
    const targetAmount = buildPlanPricing('elite').unitAmount;
    const targetPriceId = `price_${suffix}_elite_target`;
    const targetProductId = `prod_${suffix}_elite_target`;
    const targetInvoiceId = `in_${suffix}_elite_upgrade`;
    const current = await SellerSubscription.findById(subscription._id);
    current.planChangeAttempt = {
      idempotencyToken: `token_${suffix}_elite_upgrade`,
      requestFingerprint: `fingerprint_${suffix}_elite_upgrade`,
      changeKind: 'upgrade',
      stripeSubscriptionId: current.stripeSubscriptionId,
      stripeSubscriptionItemId: `si_${current.stripeSubscriptionId}`,
      stripeProductId: targetProductId,
      stripePriceId: targetPriceId,
      stripeInvoiceId: targetInvoiceId,
      sourcePlan: 'starter',
      sourcePlanName: 'Rozare Starter',
      sourceIncludeMetaAds: false,
      sourceUnitAmountMinor: 999,
      sourceStripeProductId: subscription.stripeProductId,
      sourceStripePriceId: subscription.stripePriceId,
      sourceBonusFeaturesActive: true,
      sourceBonusExpiryDate: subscription.bonusExpiryDate,
      sourceBonusFeaturesExpiredPermanently: false,
      sourceBonusGraceDeadline: null,
      targetPlan: 'elite',
      targetPlanName: 'Rozare Elite',
      targetIncludeMetaAds: false,
      targetUnitAmountMinor: targetAmount,
      state: 'pending_payment',
    };
    await current.save();

    const targetStart = stripePrecisionDate(now - 1000);
    const targetEnd = new Date(targetStart.getTime() + 30 * DAY_MS);
    const targetInvoice = paidInvoice({
      id: targetInvoiceId,
      subscriptionId: subscription.stripeSubscriptionId,
      customer: subscription.stripeCustomerId,
      paymentIntentId: `pi_${suffix}_elite_upgrade`,
      chargeId: `ch_${suffix}_elite_upgrade`,
      amount: 400,
      unitAmountMinor: targetAmount,
      start: targetStart,
      end: targetEnd,
      billingReason: 'subscription_update',
    });
    targetInvoice.lines.data[0].pricing.price_details.price = targetPriceId;
    targetInvoice.lines.data[0].pricing.price_details.product = targetProductId;
    // Stripe pending-update metadata is staged on subscription.pending_update;
    // the associated invoice can legitimately snapshot the predecessor plan.
    targetInvoice.parent = {
      subscription_details: {
        subscription: subscription.stripeSubscriptionId,
        metadata: {
          sellerId: subscription.seller.toString(),
          plan: 'starter',
        },
      },
    };
    await recordSubscriptionInvoicePayment({
      invoice: targetInvoice,
      eventId: `evt_${suffix}_elite_upgrade_paid`,
      eventCreated: 200,
    });

    subscription = await SellerSubscription.findById(subscription._id);
    subscription.plan = 'elite';
    subscription.planName = 'Rozare Elite';
    subscription.metaAdsIncluded = false;
    subscription.stripePriceId = targetPriceId;
    subscription.stripeProductId = targetProductId;
    subscription.bonusFeaturesActive = true;
    subscription.bonusExpiryDate = null;
    subscription.bonusFeaturesExpiredPermanently = false;
    subscription.planChangeAttempt.state = 'applied';
    await subscription.save();

    return {
      ...fixture,
      subscription,
      baseInvoice,
      targetInvoice,
      targetStart,
      targetEnd,
      targetPriceId,
      targetProductId,
    };
  };

  const addPaidMetaDelta = async (fixture, suffix) => {
    let subscription = await SellerSubscription.findById(fixture.subscription._id);
    const targetAmount = buildPlanPricing('elite', true).unitAmount;
    const targetPriceId = `price_${suffix}_meta_target`;
    const targetProductId = `prod_${suffix}_meta_target`;
    const invoiceId = `in_${suffix}_meta_addition`;
    subscription.planChangeAttempt = {
      idempotencyToken: `token_${suffix}_meta_addition`,
      requestFingerprint: `fingerprint_${suffix}_meta_addition`,
      changeKind: 'meta_addition',
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      stripeSubscriptionItemId: `si_${subscription.stripeSubscriptionId}`,
      stripeProductId: targetProductId,
      stripePriceId: targetPriceId,
      stripeInvoiceId: invoiceId,
      sourcePlan: 'elite',
      sourcePlanName: 'Rozare Elite',
      sourceIncludeMetaAds: false,
      sourceUnitAmountMinor: 2165,
      sourceStripeProductId: fixture.targetProductId,
      sourceStripePriceId: fixture.targetPriceId,
      sourceBonusFeaturesActive: true,
      sourceBonusExpiryDate: null,
      sourceBonusFeaturesExpiredPermanently: false,
      sourceBonusGraceDeadline: null,
      targetPlan: 'elite',
      targetPlanName: 'Rozare Elite + Meta Ads',
      targetIncludeMetaAds: true,
      targetUnitAmountMinor: targetAmount,
      state: 'pending_payment',
    };
    await subscription.save();

    const start = stripePrecisionDate(Date.now());
    const end = new Date(start.getTime() + 30 * DAY_MS);
    const invoice = paidInvoice({
      id: invoiceId,
      subscriptionId: subscription.stripeSubscriptionId,
      customer: subscription.stripeCustomerId,
      paymentIntentId: `pi_${suffix}_meta_addition`,
      chargeId: `ch_${suffix}_meta_addition`,
      amount: 100,
      unitAmountMinor: targetAmount,
      start,
      end,
      billingReason: 'subscription_update',
    });
    invoice.lines.data[0].pricing.price_details.price = targetPriceId;
    invoice.lines.data[0].pricing.price_details.product = targetProductId;
    invoice.parent = {
      subscription_details: {
        subscription: subscription.stripeSubscriptionId,
        metadata: {
          sellerId: subscription.seller.toString(),
          plan: 'elite',
          includeMetaAds: 'false',
        },
      },
    };
    await recordSubscriptionInvoicePayment({
      invoice,
      eventId: `evt_${suffix}_meta_addition_paid`,
      eventCreated: 300,
    });

    subscription = await SellerSubscription.findById(subscription._id);
    subscription.plan = 'elite';
    subscription.planName = 'Rozare Elite + Meta Ads';
    subscription.metaAdsIncluded = true;
    subscription.stripePriceId = targetPriceId;
    subscription.stripeProductId = targetProductId;
    subscription.planChangeAttempt.state = 'applied';
    await subscription.save();
    return {
      ...fixture,
      subscription,
      metaInvoice: invoice,
      metaStart: start,
      metaEnd: end,
      metaPriceId: targetPriceId,
      metaProductId: targetProductId,
    };
  };

  test('a positive current subscription-cycle payment ends an expired free period', async () => {
    const { seller } = await sellerAndStore('free-period-cycle');
    const now = Date.now();
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'free_period',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_free_period_cycle',
      stripeSubscriptionId: 'sub_free_period_cycle',
      freePeriodEndDate: new Date(now - DAY_MS),
      hasUsedFreePeriod: true,
    });
    const start = stripePrecisionDate(now - 1000);

    const result = await recordSubscriptionInvoicePayment({
      invoice: paidInvoice({
        id: 'in_free_period_paid_cycle',
        subscriptionId: subscription.stripeSubscriptionId,
        customer: subscription.stripeCustomerId,
        amount: 999,
        start,
        end: new Date(start.getTime() + 30 * DAY_MS),
        billingReason: 'subscription_cycle',
      }),
      eventId: 'evt_free_period_paid_cycle',
      eventCreated: 100,
    });

    expect(result.subscription.status).toBe('active');
    expect(result.subscription.currentPeriodStart).toEqual(start);
    expect(result.subscription.currentPeriodEnd.getTime()).toBeGreaterThan(now + 29 * DAY_MS);
    expect(result.subscription.stripePriceId).toBe('price_sub_free_period_cycle_999');
    expect(result.subscription.stripeProductId).toBe('prod_sub_free_period_cycle');
    const receiptRows = await NotificationOutbox.find({
      aggregateId: String(result.payment._id),
    }).lean();
    expect(receiptRows).toHaveLength(4);
    expect(new Set(receiptRows.map(row => row.eventType)))
      .toEqual(new Set(['subscription.payment_received']));
    for (const row of receiptRows) {
      expect(row.money[0]).toEqual(expect.objectContaining({
        amountMinor: 999,
        currency: 'USD',
      }));
      expect([
        row.payload.body,
        row.payload.text,
        row.payload.html,
        row.payload.message,
      ].join(' ')).toContain('$9.99');
    }
  });

  test('payment recovery is routed once through exact-amount outbox channels', async () => {
    const { subscription } = await setupSubscription('recovery-outbox');
    const start = stripePrecisionDate(Date.now() - 1000);
    const invoice = paidInvoice({
      id: 'in_recovery_outbox',
      subscriptionId: subscription.stripeSubscriptionId,
      customer: subscription.stripeCustomerId,
      amount: 999,
      start,
      end: new Date(start.getTime() + 30 * DAY_MS),
      billingReason: 'subscription_cycle',
    });
    await recordSubscriptionInvoiceFailure({
      invoice: { ...invoice, status: 'open', amount_remaining: 999 },
      eventId: 'evt_recovery_outbox_failed',
      eventCreated: 100,
    });

    const first = await recordSubscriptionInvoicePayment({
      invoice,
      eventId: 'evt_recovery_outbox_paid',
      eventCreated: 200,
    });
    const replay = await recordSubscriptionInvoicePayment({
      invoice,
      eventId: 'evt_recovery_outbox_paid_replay',
      eventCreated: 200,
    });

    const [payment, rows] = await Promise.all([
      StripeEntitlementPayment.findById(first.payment._id),
      NotificationOutbox.find({ aggregateId: String(first.payment._id) }).lean(),
    ]);
    expect(first.subscription.status).toBe('active');
    expect(first.notificationIntent).toBeNull();
    expect(replay.notificationIntent).toBeNull();
    expect(payment.paymentNotification.kind).toBe('recovered');
    expect(payment.paymentNotification.outboxEnqueuedAt).toBeInstanceOf(Date);
    expect(payment.recoveryNotification.state).toBe('outboxed');
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map(row => row.eventType)))
      .toEqual(new Set(['subscription.payment_recovered']));
    expect(rows.every(row => row.money[0].amountMinor === 999)).toBe(true);
  });

  test('enforces the seller exact locked Price, Product, and founder-specific recurring rate', async () => {
    const standard = await setupSubscription('exact-standard-rate');
    const start = stripePrecisionDate(Date.now() - 1000);
    const underpriced = paidInvoice({
      id: 'in_exact_standard_underpriced',
      subscriptionId: standard.subscription.stripeSubscriptionId,
      customer: standard.subscription.stripeCustomerId,
      amount: 599,
      unitAmountMinor: 599,
      start,
      end: new Date(start.getTime() + 30 * DAY_MS),
    });
    underpriced.lines.data[0].pricing.price_details.price = standard.subscription.stripePriceId;
    await expect(recordSubscriptionInvoicePayment({
      invoice: underpriced,
      eventId: 'evt_exact_standard_underpriced',
    })).rejects.toMatchObject({ code: 'STRIPE_SUBSCRIPTION_PRICE_INVALID' });

    const wrongPrice = paidInvoice({
      id: 'in_exact_standard_wrong_price',
      subscriptionId: standard.subscription.stripeSubscriptionId,
      customer: standard.subscription.stripeCustomerId,
      amount: 999,
      start,
      end: new Date(start.getTime() + 30 * DAY_MS),
    });
    wrongPrice.lines.data[0].pricing.price_details.price = 'price_other_seller_same_amount';
    await expect(recordSubscriptionInvoicePayment({
      invoice: wrongPrice,
      eventId: 'evt_exact_standard_wrong_price',
    })).rejects.toMatchObject({ code: 'STRIPE_SUBSCRIPTION_PRICE_INVALID' });

    const founder = await setupSubscription('exact-founder-rate');
    founder.subscription.founderOffer = {
      active: true,
      code: 'FIRST100',
      discountPercent: 40,
      claimedAt: new Date(),
      source: 'coupon',
    };
    founder.subscription.stripePriceId = 'price_exact_founder_599';
    founder.subscription.stripeProductId = 'prod_exact_founder';
    await founder.subscription.save();
    const founderInvoice = paidInvoice({
      id: 'in_exact_founder_rate',
      subscriptionId: founder.subscription.stripeSubscriptionId,
      customer: founder.subscription.stripeCustomerId,
      amount: 599,
      unitAmountMinor: 599,
      start,
      end: new Date(start.getTime() + 30 * DAY_MS),
    });
    founderInvoice.lines.data[0].pricing.price_details.price = founder.subscription.stripePriceId;
    founderInvoice.lines.data[0].pricing.price_details.product = founder.subscription.stripeProductId;
    await expect(recordSubscriptionInvoicePayment({
      invoice: founderInvoice,
      eventId: 'evt_exact_founder_rate',
    })).resolves.toMatchObject({ handled: true, created: true });
  });

  test('replays a settled Starter invoice from its immutable ledger after the seller changes to Elite', async () => {
    const { subscription } = await setupSubscription('old-plan-replay');
    const start = stripePrecisionDate(Date.now() - DAY_MS);
    const invoice = paidInvoice({
      id: 'in_old_plan_replay',
      subscriptionId: subscription.stripeSubscriptionId,
      customer: subscription.stripeCustomerId,
      amount: 999,
      start,
      end: new Date(start.getTime() + 30 * DAY_MS),
    });
    await recordSubscriptionInvoicePayment({
      invoice,
      eventId: 'evt_old_plan_original',
      eventCreated: 100,
    });
    // Simulate a pre-snapshot ledger row. Replays may repair it only from the
    // immutable Stripe Price evidence, never from the seller's later plan.
    await StripeEntitlementPayment.updateOne({ invoiceId: invoice.id }, {
      $unset: { fundedPlan: 1, fundedPlanName: 1 },
    });
    await SellerSubscription.updateOne({ _id: subscription._id }, {
      $set: {
        plan: 'elite',
        planName: 'Rozare Elite + Meta Ads',
        metaAdsIncluded: true,
        stripePriceId: 'price_old_plan_new_elite',
        stripeProductId: 'prod_old_plan_new_elite',
      },
    });

    const replay = await recordSubscriptionInvoicePayment({
      invoice,
      eventId: 'evt_old_plan_replay',
      eventCreated: 200,
    });
    const [unchanged, payment] = await Promise.all([
      SellerSubscription.findById(subscription._id),
      StripeEntitlementPayment.findOne({ invoiceId: invoice.id }),
    ]);
    expect(replay.created).toBe(false);
    expect(unchanged).toMatchObject({ plan: 'elite', metaAdsIncluded: true });
    expect(unchanged.stripePriceId).toBe('price_old_plan_new_elite');
    expect(payment.fundedPlan).toBe('starter');
    expect(payment.fundedPlanName).toBe('Rozare Starter');
    expect(payment.fundedPlanName).not.toContain('Elite');
    expect(payment.stripeEventCreated).toBe(200);
    expect(payment.completionEventIds).toEqual(expect.arrayContaining([
      'evt_old_plan_original',
      'evt_old_plan_replay',
    ]));
  });

  test('positive prorations and zero trial invoices do not end a live free period', async () => {
    const { seller } = await sellerAndStore('live-free-period');
    const now = Date.now();
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'free_period',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_live_free_period',
      stripeSubscriptionId: 'sub_live_free_period',
      freePeriodEndDate: new Date(now + 10 * DAY_MS),
      hasUsedFreePeriod: true,
    });
    const start = stripePrecisionDate(now - 1000);

    await recordSubscriptionInvoicePayment({
      invoice: paidInvoice({
        id: 'in_live_free_proration',
        subscriptionId: subscription.stripeSubscriptionId,
        customer: subscription.stripeCustomerId,
        amount: 400,
        start,
        end: new Date(start.getTime() + 10 * DAY_MS),
        billingReason: 'subscription_update',
      }),
      eventId: 'evt_live_free_proration',
      eventCreated: 100,
    });
    const zeroResult = await recordSubscriptionInvoicePayment({
      invoice: paidInvoice({
        id: 'in_live_free_zero_cycle',
        subscriptionId: subscription.stripeSubscriptionId,
        customer: subscription.stripeCustomerId,
        amount: 0,
        start,
        end: new Date(start.getTime() + 30 * DAY_MS),
        billingReason: 'subscription_cycle',
      }),
      eventId: 'evt_live_free_zero_cycle',
      eventCreated: 101,
    });

    const unchanged = await SellerSubscription.findById(subscription._id);
    expect(zeroResult.zeroAmount).toBe(true);
    expect(unchanged.status).toBe('free_period');
    expect(await StripeEntitlementPayment.countDocuments({ seller: seller._id })).toBe(1);
  });

  test('uses Stripe periods, handles prorations, and never duplicates an invoice contribution', async () => {
    const { subscription } = await setupSubscription('period');
    const start = new Date('2026-08-01T00:00:00.000Z');
    const end = new Date('2026-09-01T00:00:00.000Z');
    const invoice = paidInvoice({
      id: 'in_period',
      subscriptionId: subscription.stripeSubscriptionId,
      amount: 2165,
      start,
      end,
      linePeriods: [
        { start: new Date('2026-08-15T00:00:00.000Z'), end, amount: 665, proration: true },
        { start, end, amount: 1500 },
      ],
    });

    await recordSubscriptionInvoicePayment({ invoice, eventId: 'evt_period_1', eventCreated: 100 });
    await recordSubscriptionInvoicePayment({ invoice, eventId: 'evt_period_retry', eventCreated: 100 });
    const updated = await SellerSubscription.findById(subscription._id);
    const payment = await StripeEntitlementPayment.findOne({ invoiceId: invoice.id });
    expect(await StripeEntitlementPayment.countDocuments({ invoiceId: invoice.id })).toBe(1);
    expect(payment.grantStart).toEqual(start);
    expect(payment.grantEnd).toEqual(end);
    expect(updated.currentPeriodStart).toEqual(start);
    expect(updated.currentPeriodEnd).toEqual(end);
  });

  test('a richer retry backfills both missing PaymentIntent and Charge identities', async () => {
    const { subscription } = await setupSubscription('identity-backfill');
    const start = new Date('2026-08-01T00:00:00.000Z');
    const end = new Date('2026-09-01T00:00:00.000Z');
    const invoice = paidInvoice({
      id: 'in_identity_backfill',
      subscriptionId: subscription.stripeSubscriptionId,
      start,
      end,
    });
    const paymentIntentId = invoice.payment_intent;
    const chargeId = invoice.charge;
    delete invoice.payment_intent;
    delete invoice.charge;

    await recordSubscriptionInvoicePayment({ invoice, eventId: 'evt_identity_sparse', eventCreated: 100 });
    invoice.payment_intent = paymentIntentId;
    invoice.charge = chargeId;
    await recordSubscriptionInvoicePayment({ invoice, eventId: 'evt_identity_rich', eventCreated: 101 });

    const payment = await StripeEntitlementPayment.findOne({ invoiceId: invoice.id });
    expect(payment.paymentIntentId).toBe(paymentIntentId);
    expect(payment.chargeIds).toContain(chargeId);
    expect(payment.completionEventIds).toEqual(expect.arrayContaining([
      'evt_identity_sparse',
      'evt_identity_rich',
    ]));
  });

  test('ignores an invoice from a prior Stripe subscription and a stale prior-period recovery', async () => {
    const { subscription } = await setupSubscription('current');
    const augustStart = new Date('2026-08-01T00:00:00.000Z');
    const septemberStart = new Date('2026-09-01T00:00:00.000Z');
    const octoberStart = new Date('2026-10-01T00:00:00.000Z');

    const oldSub = paidInvoice({
      id: 'in_old_subscription',
      subscriptionId: 'sub_replaced',
      start: augustStart,
      end: septemberStart,
    });
    await expect(recordSubscriptionInvoicePayment({ invoice: oldSub, eventId: 'evt_old_sub' }))
      .resolves.toMatchObject({ handled: false, stale: true });

    await recordSubscriptionInvoiceFailure({
      invoice: {
        ...paidInvoice({
        id: 'in_new_failure',
        subscriptionId: subscription.stripeSubscriptionId,
        start: septemberStart,
        end: octoberStart,
        }),
        status: 'open',
        amount_remaining: 999,
      },
      eventId: 'evt_new_failure',
      eventCreated: 200,
    });
    await recordSubscriptionInvoicePayment({
      invoice: paidInvoice({
        id: 'in_stale_success',
        subscriptionId: subscription.stripeSubscriptionId,
        start: augustStart,
        end: septemberStart,
      }),
      eventId: 'evt_stale_success',
      eventCreated: 300,
    });
    const updated = await SellerSubscription.findById(subscription._id);
    expect(updated.status).toBe('past_due');
    expect(updated.paymentRisk.latestFailureInvoiceId).toBe('in_new_failure');
  });

  test.each([
    [
      'a mismatched customer',
      invoice => { invoice.customer = 'cus_different_seller'; },
      'STRIPE_SUBSCRIPTION_INVOICE_OWNERSHIP_MISMATCH',
    ],
    [
      'mismatched seller metadata',
      invoice => {
        invoice.parent = {
          subscription_details: {
            subscription: invoice.subscription,
            metadata: { sellerId: new mongoose.Types.ObjectId().toString() },
          },
        };
      },
      'STRIPE_SUBSCRIPTION_INVOICE_OWNERSHIP_MISMATCH',
    ],
    [
      'a non-subscription billing reason',
      invoice => { invoice.billing_reason = 'manual'; },
      'STRIPE_SUBSCRIPTION_BILLING_REASON_INVALID',
    ],
    [
      'a paid status',
      invoice => { invoice.status = 'paid'; },
      'STRIPE_SUBSCRIPTION_FAILURE_MONEY_INVALID',
    ],
    [
      'a boolean outstanding amount',
      invoice => { invoice.amount_remaining = true; },
      'STRIPE_ENTITLEMENT_AMOUNT_INVALID',
    ],
    [
      'an overflowing outstanding amount',
      invoice => { invoice.amount_remaining = Number.MAX_SAFE_INTEGER + 1; },
      'STRIPE_ENTITLEMENT_AMOUNT_INVALID',
    ],
    [
      'a string line amount',
      invoice => { invoice.lines.data[0].amount = '999'; },
      'STRIPE_SUBSCRIPTION_FAILURE_EVIDENCE_INVALID',
    ],
    [
      'a PKR line on a USD invoice',
      invoice => { invoice.lines.data[0].currency = 'pkr'; },
      'STRIPE_SUBSCRIPTION_FAILURE_MONEY_INVALID',
    ],
    [
      'a line owned by a different subscription',
      invoice => {
        invoice.lines.data[0].parent.subscription_item_details.subscription = 'sub_other_owner';
      },
      'STRIPE_SUBSCRIPTION_INVOICE_OWNERSHIP_MISMATCH',
    ],
    [
      'a coercible boolean period timestamp',
      invoice => { invoice.lines.data[0].period.start = true; },
      'STRIPE_SUBSCRIPTION_PERIOD_INVALID',
    ],
    [
      'an overflowing period timestamp',
      invoice => { invoice.lines.data[0].period.end = Number.MAX_SAFE_INTEGER; },
      'STRIPE_SUBSCRIPTION_PERIOD_INVALID',
    ],
    [
      'a service period longer than the monthly Price',
      invoice => {
        invoice.lines.data[0].period.end = invoice.lines.data[0].period.start + (33 * 24 * 60 * 60);
      },
      'STRIPE_SUBSCRIPTION_PERIOD_INVALID',
    ],
    [
      'no positive subscription line',
      invoice => { invoice.lines.data[0].amount = 0; },
      'STRIPE_SUBSCRIPTION_FAILURE_EVIDENCE_INVALID',
    ],
  ])('rejects failed-invoice evidence with %s before suspending or notifying', async (
    _label,
    mutate,
    code,
  ) => {
    const { store, subscription } = await setupSubscription(
      `invalid-failure-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
    );
    const start = stripePrecisionDate(Date.now() - DAY_MS);
    const invoice = {
      ...paidInvoice({
        id: `in_invalid_failure_${new mongoose.Types.ObjectId()}`,
        subscriptionId: subscription.stripeSubscriptionId,
        customer: subscription.stripeCustomerId,
        amount: 999,
        start,
        end: new Date(start.getTime() + 30 * DAY_MS),
      }),
      status: 'open',
      amount_remaining: 999,
    };
    mutate(invoice);

    await expect(recordSubscriptionInvoiceFailure({
      invoice,
      eventId: 'evt_invalid_failure_evidence',
      eventCreated: 100,
    })).rejects.toMatchObject({ code });

    const [unchanged, unchangedStore, outboxCount] = await Promise.all([
      SellerSubscription.findById(subscription._id),
      Store.findById(store._id),
      NotificationOutbox.countDocuments({ recipientId: String(subscription.seller) }),
    ]);
    expect(unchanged.paymentRisk.suspended).toBe(false);
    expect(unchanged.paymentRisk.latestFailureInvoiceId).toBe('');
    expect(unchanged.paymentRisk.failureNotification.state).toBeNull();
    expect(unchangedStore.isActive).toBe(true);
    expect(outboxCount).toBe(0);
  });

  test('marks an out-of-order failure stale against the already-settled invoice and emits no failure truth', async () => {
    const { store, subscription } = await setupSubscription('late-failure-after-paid');
    const start = stripePrecisionDate(Date.now() - DAY_MS);
    const invoice = paidInvoice({
      id: 'in_late_failure_after_paid',
      subscriptionId: subscription.stripeSubscriptionId,
      customer: subscription.stripeCustomerId,
      amount: 999,
      start,
      end: new Date(start.getTime() + 30 * DAY_MS),
    });
    await recordSubscriptionInvoicePayment({
      invoice,
      eventId: 'evt_late_failure_paid',
      eventCreated: 200,
    });

    const result = await recordSubscriptionInvoiceFailure({
      invoice: { ...invoice, status: 'open', amount_remaining: 999 },
      eventId: 'evt_late_failure_delayed',
      eventCreated: 100,
    });
    const [unchanged, unchangedStore] = await Promise.all([
      SellerSubscription.findById(subscription._id),
      Store.findById(store._id),
    ]);
    expect(result).toMatchObject({ handled: true, stale: true, duplicate: false });
    expect(result.notificationIntent).toBeUndefined();
    expect(unchanged.status).toBe('active');
    expect(unchanged.paymentRisk.suspended).toBe(false);
    expect(unchanged.paymentRisk.latestFailureInvoiceId).toBe('');
    expect(unchanged.paymentRisk.failureNotification.state).toBeNull();
    expect(unchangedStore.isActive).toBe(true);
  });

  test('a failed exact pending-update invoice preserves paid base coverage and suppresses suspension messaging', async () => {
    const { store, subscription, targetInvoice } = await paidStarterThenPendingUpgrade('pending-failure-base');
    // Simulate a still-pending local attempt; the helper applied it only to
    // exercise other risk tests.
    await SellerSubscription.updateOne({ _id: subscription._id }, {
      $set: {
        plan: 'starter',
        planName: 'Rozare Starter',
        metaAdsIncluded: false,
        stripePriceId: subscription.planChangeAttempt.sourceStripePriceId,
        stripeProductId: subscription.planChangeAttempt.sourceStripeProductId,
        'planChangeAttempt.state': 'pending_payment',
        status: 'past_due',
        'paymentRisk.suspended': true,
        'paymentRisk.reason': 'Stripe subscription payment failed.',
        'paymentRisk.previousStatus': 'active',
        'paymentRisk.stripeSubscriptionId': subscription.stripeSubscriptionId,
        'paymentRisk.latestFailureInvoiceId': targetInvoice.id,
        'paymentRisk.latestFailurePeriodStart': new Date(targetInvoice.period_start * 1000),
        'paymentRisk.latestFailureEventCreated': 250,
      },
    });
    const falseBlockedAt = new Date();
    await Store.updateOne({ _id: store._id }, {
      $set: {
        isActive: false,
        blockedAt: falseBlockedAt,
        subscriptionPaymentRiskLock: {
          stripeSubscriptionId: subscription.stripeSubscriptionId,
          lockedAt: falseBlockedAt,
        },
      },
    });
    const result = await recordSubscriptionInvoiceFailure({
      invoice: { ...targetInvoice, status: 'open', amount_remaining: 400 },
      eventId: 'evt_pending_failure_base',
      eventCreated: 300,
    });
    const [unchanged, unchangedStore] = await Promise.all([
      SellerSubscription.findById(subscription._id),
      Store.findById(store._id),
    ]);
    expect(result).toMatchObject({
      handled: true,
      stale: true,
      nonRenewalFailure: true,
      repaired: true,
    });
    expect(result.notificationIntent).toBeUndefined();
    expect(unchanged.status).toBe('active');
    expect(unchanged.paymentRisk.suspended).toBe(false);
    expect(unchanged.paymentRisk.failureNotification.state).toBeNull();
    expect(unchangedStore.isActive).toBe(true);
  });

  test('does not broadly ignore a non-matching subscription-update failure', async () => {
    const { store, subscription } = await setupSubscription('nonmatching-update-failure');
    const start = stripePrecisionDate(Date.now() - DAY_MS);
    const base = paidInvoice({
      id: 'in_nonmatching_update_base',
      subscriptionId: subscription.stripeSubscriptionId,
      customer: subscription.stripeCustomerId,
      amount: 999,
      start,
      end: new Date(start.getTime() + 30 * DAY_MS),
    });
    await recordSubscriptionInvoicePayment({ invoice: base, eventCreated: 100 });
    const current = await SellerSubscription.findById(subscription._id);
    current.planChangeAttempt = {
      idempotencyToken: 'token_nonmatching_update',
      requestFingerprint: 'fingerprint_nonmatching_update',
      changeKind: 'upgrade',
      stripeSubscriptionId: current.stripeSubscriptionId,
      stripeSubscriptionItemId: `si_${current.stripeSubscriptionId}`,
      stripeProductId: 'prod_nonmatching_update_target',
      stripePriceId: 'price_nonmatching_update_target',
      stripeInvoiceId: 'in_different_pending_generation',
      targetPlan: 'elite',
      targetPlanName: 'Rozare Elite',
      targetIncludeMetaAds: false,
      targetUnitAmountMinor: 2165,
      state: 'pending_payment',
    };
    await current.save();
    const failed = paidInvoice({
      id: 'in_nonmatching_update_failed',
      subscriptionId: subscription.stripeSubscriptionId,
      customer: subscription.stripeCustomerId,
      amount: 400,
      start: new Date(start.getTime() + DAY_MS),
      end: new Date(start.getTime() + 31 * DAY_MS),
      billingReason: 'subscription_update',
    });
    const result = await recordSubscriptionInvoiceFailure({
      invoice: { ...failed, status: 'open', amount_remaining: 400 },
      eventId: 'evt_nonmatching_update_failed',
      eventCreated: 200,
    });
    const [updated, updatedStore] = await Promise.all([
      SellerSubscription.findById(subscription._id),
      Store.findById(store._id),
    ]);
    expect(result.stale).toBe(false);
    expect(updated.status).toBe('past_due');
    expect(updated.paymentRisk.suspended).toBe(true);
    expect(updatedStore.isActive).toBe(false);
  });

  test('retries the Store projection when a duplicate failed-invoice delivery follows a transient Store write error', async () => {
    const { store, subscription } = await setupSubscription('failure-store-retry');
    const start = stripePrecisionDate(Date.now() - 2 * DAY_MS);
    await recordSubscriptionInvoicePayment({
      invoice: paidInvoice({
        id: 'in_failure_store_retry_paid',
        subscriptionId: subscription.stripeSubscriptionId,
        customer: subscription.stripeCustomerId,
        amount: 999,
        start,
        end: new Date(start.getTime() + 30 * DAY_MS),
      }),
      eventCreated: 100,
    });
    const failureStart = new Date(start.getTime() + DAY_MS);
    const failure = paidInvoice({
      id: 'in_failure_store_retry_failed',
      subscriptionId: subscription.stripeSubscriptionId,
      customer: subscription.stripeCustomerId,
      amount: 999,
      start: failureStart,
      end: new Date(failureStart.getTime() + 30 * DAY_MS),
      billingReason: 'subscription_cycle',
    });
    const projectionFailure = jest.spyOn(Store, 'findOneAndUpdate')
      .mockRejectedValueOnce(new Error('simulated Store outage'));
    await expect(recordSubscriptionInvoiceFailure({
      invoice: { ...failure, status: 'open', amount_remaining: 999 },
      eventId: 'evt_failure_store_retry_first',
      eventCreated: 200,
    })).rejects.toThrow('simulated Store outage');
    projectionFailure.mockRestore();
    expect((await Store.findById(store._id)).isActive).toBe(true);

    const retry = await recordSubscriptionInvoiceFailure({
      invoice: { ...failure, status: 'open', amount_remaining: 999 },
      eventId: 'evt_failure_store_retry_duplicate',
      eventCreated: 200,
    });
    const [updated, updatedStore] = await Promise.all([
      SellerSubscription.findById(subscription._id),
      Store.findById(store._id),
    ]);
    expect(retry).toMatchObject({ handled: true, duplicate: true, stale: false });
    expect(updated.paymentRisk.suspended).toBe(true);
    expect(updatedStore.isActive).toBe(false);
    expect(updatedStore.subscriptionPaymentRiskLock.stripeSubscriptionId)
      .toBe(subscription.stripeSubscriptionId);
  });

  test('retries a new Checkout invoice while its subscription binding is pending, but ignores it after the claim is gone', async () => {
    const { seller, subscription } = await setupSubscription('binding-order');
    const token = 'claim_binding_order';
    await SellerCheckoutClaim.create({
      seller: seller._id,
      flow: 'subscription',
      requestFingerprint: 'binding-order-fingerprint',
      token,
      sessionId: 'cs_binding_order',
      sessionUrl: 'https://checkout.stripe.com/cs_binding_order',
      expiresAt: new Date(Date.now() + DAY_MS),
    });
    const start = stripePrecisionDate(Date.now() - DAY_MS);
    const invoice = paidInvoice({
      id: 'in_binding_order',
      subscriptionId: 'sub_binding_order_new',
      customer: subscription.stripeCustomerId,
      start,
      end: new Date(start.getTime() + 30 * DAY_MS),
    });
    invoice.parent = {
      subscription_details: {
        subscription: 'sub_binding_order_new',
        metadata: {
          sellerId: seller._id.toString(),
          checkoutClaimToken: token,
        },
      },
    };
    delete invoice.subscription;

    await expect(recordSubscriptionInvoicePayment({ invoice, eventId: 'evt_binding_pending' }))
      .rejects.toMatchObject({ code: 'STRIPE_SUBSCRIPTION_BINDING_PENDING', statusCode: 503 });

    await SellerCheckoutClaim.deleteMany({ seller: seller._id });
    await expect(recordSubscriptionInvoicePayment({ invoice, eventId: 'evt_binding_stale' }))
      .resolves.toMatchObject({ handled: false, stale: true, reason: 'subscription_not_current' });

    await SellerSubscription.updateOne({ _id: subscription._id }, {
      $set: {
        'pendingDowngrade.toPlan': 'starter',
        'pendingDowngrade.processingToken': 'transition_binding_token',
        'pendingDowngrade.processingStartedAt': new Date(),
      },
    });
    const transitionInvoice = paidInvoice({
      id: 'in_transition_binding_order',
      subscriptionId: 'sub_transition_binding_new',
      customer: subscription.stripeCustomerId,
      start,
      end: new Date(start.getTime() + 30 * DAY_MS),
    });
    transitionInvoice.parent = {
      subscription_details: {
        subscription: 'sub_transition_binding_new',
        metadata: {
          sellerId: seller._id.toString(),
          transitionFromSubscriptionId: subscription.stripeSubscriptionId,
        },
      },
    };
    delete transitionInvoice.subscription;
    await expect(recordSubscriptionInvoiceFailure({
      invoice: transitionInvoice,
      eventId: 'evt_transition_binding_pending',
    })).rejects.toMatchObject({ code: 'STRIPE_SUBSCRIPTION_BINDING_PENDING', statusCode: 503 });
  });

  test('monotonically backfills invoice event time so a later success outranks an earlier failure', async () => {
    const { subscription } = await setupSubscription('event-created-backfill');
    const start = stripePrecisionDate(Date.now() - DAY_MS);
    const invoice = paidInvoice({
      id: 'in_event_created_backfill',
      subscriptionId: subscription.stripeSubscriptionId,
      start,
      end: new Date(start.getTime() + 30 * DAY_MS),
    });

    await recordSubscriptionInvoicePayment({ invoice, eventCreated: 0 });
    await recordSubscriptionInvoiceFailure({
      invoice: { ...invoice, status: 'open', amount_remaining: 999 },
      eventId: 'evt_event_created_failure',
      eventCreated: 100,
    });
    await recordSubscriptionInvoicePayment({
      invoice,
      eventId: 'evt_event_created_success',
      eventCreated: 200,
    });

    const [updated, payment] = await Promise.all([
      SellerSubscription.findById(subscription._id),
      StripeEntitlementPayment.findOne({ invoiceId: invoice.id }),
    ]);
    expect(payment.stripeEventCreated).toBe(200);
    expect(updated.status).toBe('active');
    expect(updated.paymentRisk.suspended).toBe(false);
  });

  test('future-dated ledger coverage cannot activate or keep a subscription active early', async () => {
    const { store, subscription } = await setupSubscription('future-only-coverage');
    subscription.status = 'active';
    await subscription.save();
    const futureStart = stripePrecisionDate(Date.now() + 10 * DAY_MS);
    await StripeEntitlementPayment.create({
      entitlementType: 'subscription',
      sourceKey: 'subscription:in_future_only_coverage',
      seller: subscription.seller,
      invoiceId: 'in_future_only_coverage',
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      currency: 'usd',
      capturedMinor: 999,
      grantStart: futureStart,
      grantEnd: new Date(futureStart.getTime() + 30 * DAY_MS),
      effectiveGrantEnd: new Date(futureStart.getTime() + 30 * DAY_MS),
      billingReason: 'subscription_cycle',
      fundedPlan: 'starter',
      fundedPlanName: 'Rozare Starter',
      fundedMetaAdsIncluded: false,
      fundedStripePriceId: subscription.stripePriceId,
      fundedStripeProductId: subscription.stripeProductId,
      fundedSubscriptionItemId: `si_${subscription.stripeSubscriptionId}`,
      fundedUnitAmountMinor: 999,
      completionState: 'confirmed',
    });

    const recomputed = await recomputeSubscriptionEntitlement(subscription._id, { allowRestore: true });
    const updatedStore = await Store.findById(store._id);
    expect(recomputed.status).not.toBe('active');
    expect(recomputed.paymentRisk.suspended).toBe(true);
    expect(updatedStore.isActive).toBe(false);
  });

  test('a partial plan-change refund immediately rolls back only the upgrade and the next Starter cycle remains valid', async () => {
    const fixture = await paidStarterThenPendingUpgrade('upgrade-partial-refund');
    const sourcePriceId = fixture.subscription.planChangeAttempt.sourceStripePriceId;
    const sourceProductId = fixture.subscription.planChangeAttempt.sourceStripeProductId;
    const sourceBonusExpiry = fixture.subscription.planChangeAttempt.sourceBonusExpiryDate;

    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: fixture.targetInvoice.payment_intent,
        chargeId: fixture.targetInvoice.charge,
        amount: 400,
        refunded: 100,
      }),
      eventId: 'evt_upgrade_partial_refund',
      eventType: 'charge.refunded',
    });

    let [rolledBack, rolledBackStore, targetPayment] = await Promise.all([
      SellerSubscription.findById(fixture.subscription._id),
      Store.findById(fixture.store._id),
      StripeEntitlementPayment.findOne({ invoiceId: fixture.targetInvoice.id }),
    ]);
    expect(targetPayment.effectiveGrantEnd.getTime()).toBeGreaterThan(Date.now() + 20 * DAY_MS);
    expect(rolledBack).toMatchObject({
      status: 'active',
      plan: 'starter',
      metaAdsIncluded: false,
      stripePriceId: sourcePriceId,
      stripeProductId: sourceProductId,
      bonusFeaturesActive: true,
    });
    expect(rolledBack.planChangeAttempt.state).toBeNull();
    expect(rolledBack.bonusExpiryDate).toEqual(sourceBonusExpiry);
    expect(rolledBackStore.isActive).toBe(true);
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscription.stripeSubscriptionId,
      expect.objectContaining({
        items: [{
          id: `si_${fixture.subscription.stripeSubscriptionId}`,
          price: sourcePriceId,
          quantity: 1,
          discounts: '',
        }],
        discounts: '',
        proration_behavior: 'none',
      }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining(sourcePriceId) }),
    );

    const renewalStart = stripePrecisionDate(Date.now() - 500);
    const renewal = paidInvoice({
      id: 'in_upgrade_partial_refund_next_starter_cycle',
      subscriptionId: rolledBack.stripeSubscriptionId,
      customer: rolledBack.stripeCustomerId,
      paymentIntentId: 'pi_upgrade_partial_refund_next_starter_cycle',
      chargeId: 'ch_upgrade_partial_refund_next_starter_cycle',
      amount: 999,
      start: renewalStart,
      end: new Date(renewalStart.getTime() + 30 * DAY_MS),
    });
    renewal.lines.data[0].pricing.price_details.price = sourcePriceId;
    renewal.lines.data[0].pricing.price_details.product = sourceProductId;
    await expect(recordSubscriptionInvoicePayment({
      invoice: renewal,
      eventId: 'evt_upgrade_partial_refund_next_starter_cycle',
      eventCreated: 400,
    })).resolves.toMatchObject({ handled: true, created: true });
    rolledBack = await SellerSubscription.findById(fixture.subscription._id);
    expect(rolledBack).toMatchObject({ status: 'active', plan: 'starter' });
  });

  test('lost upgrade funds roll back to overlapping Starter coverage and a late win restores the exact Elite target', async () => {
    const fixture = await paidStarterThenPendingUpgrade('upgrade-lost-won');
    const sourcePriceId = fixture.subscription.planChangeAttempt.sourceStripePriceId;
    const dispute = riskCharge({
      paymentIntentId: fixture.targetInvoice.payment_intent,
      chargeId: fixture.targetInvoice.charge,
      amount: 400,
      disputeId: 'dp_upgrade_lost_won',
      disputeAmount: 400,
      disputeStatus: 'needs_response',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: dispute,
      eventId: 'evt_upgrade_lost_won_open',
      eventType: 'charge.dispute.funds_withdrawn',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: { ...dispute, disputeStatus: 'lost' },
      eventId: 'evt_upgrade_lost_won_lost',
      eventType: 'charge.dispute.closed',
    });
    let rolledBack = await SellerSubscription.findById(fixture.subscription._id);
    expect(rolledBack).toMatchObject({ status: 'active', plan: 'starter' });
    expect(rolledBack.stripePriceId).toBe(sourcePriceId);
    expect(rolledBack.planChangeAttempt.state).toBeNull();

    stripe.subscriptions.update.mockReset()
      .mockRejectedValueOnce(Object.assign(
        new Error('Connection closed after restoring funds.'),
        { type: 'StripeConnectionError', code: 'ECONNRESET' },
      ))
      .mockImplementationOnce(async (id, params) => appliedSubscriptionUpdateResponse(id, params));
    await expect(flagStripeEntitlementPaymentRisk({
      charge: { ...dispute, disputeStatus: 'won' },
      eventId: 'evt_upgrade_lost_won_reinstated',
      eventType: 'charge.dispute.funds_reinstated',
    })).rejects.toMatchObject({ planSyncOutcomeIndeterminate: true });
    const stillRestricted = await SellerSubscription.findById(fixture.subscription._id);
    expect(stillRestricted).toMatchObject({ status: 'active', plan: 'starter' });

    await flagStripeEntitlementPaymentRisk({
      charge: { ...dispute, disputeStatus: 'won' },
      eventId: 'evt_upgrade_lost_won_reinstated',
      eventType: 'charge.dispute.funds_reinstated',
    });
    const [restored, targetPayment] = await Promise.all([
      SellerSubscription.findById(fixture.subscription._id),
      StripeEntitlementPayment.findOne({ invoiceId: fixture.targetInvoice.id }),
    ]);
    expect(restored).toMatchObject({
      status: 'active',
      plan: 'elite',
      stripePriceId: fixture.targetPriceId,
      stripeProductId: fixture.targetProductId,
    });
    expect(restored.planChangeAttempt.state).toBe('applied');
    expect(targetPayment.disputeState).toBe('won');
    expect(targetPayment.effectiveGrantEnd).toEqual(fixture.targetEnd);
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscription.stripeSubscriptionId,
      expect.objectContaining({
        items: [{
          id: `si_${fixture.subscription.stripeSubscriptionId}`,
          price: fixture.targetPriceId,
          quantity: 1,
          discounts: '',
        }],
        discounts: '',
      }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining(fixture.targetPriceId) }),
    );
  });

  test('a late win from a superseded plan-change token cannot overwrite the newer billing intent', async () => {
    const fixture = await paidStarterThenPendingUpgrade('upgrade-superseded-late-win');
    const dispute = riskCharge({
      paymentIntentId: fixture.targetInvoice.payment_intent,
      chargeId: fixture.targetInvoice.charge,
      amount: 400,
      disputeId: 'dp_upgrade_superseded_late_win',
      disputeAmount: 400,
      disputeStatus: 'lost',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: dispute,
      eventId: 'evt_upgrade_superseded_lost',
      eventType: 'charge.dispute.closed',
    });
    await SellerSubscription.updateOne({ _id: fixture.subscription._id }, {
      $set: {
        'planChangeAttempt.idempotencyToken': 'token_newer_plan_change',
        'planChangeAttempt.requestFingerprint': 'fingerprint_newer_plan_change',
        'planChangeAttempt.state': 'processing',
      },
    });
    stripe.subscriptions.update.mockClear();

    await flagStripeEntitlementPaymentRisk({
      charge: { ...dispute, disputeStatus: 'won' },
      eventId: 'evt_upgrade_superseded_late_win',
      eventType: 'charge.dispute.funds_reinstated',
    });
    const unchanged = await SellerSubscription.findById(fixture.subscription._id);
    expect(unchanged).toMatchObject({ plan: 'starter', status: 'active' });
    expect(unchanged.planChangeAttempt.idempotencyToken).toBe('token_newer_plan_change');
    expect(stripe.subscriptions.update.mock.calls.some(([, params]) => (
      params?.items?.some(item => item.price === fixture.targetPriceId)
    ))).toBe(false);
  });

  test('a newer plan token injected during Stripe reconciliation cannot be overwritten remotely or locally', async () => {
    const fixture = await paidStarterThenPendingUpgrade('upgrade-reconcile-token-race');
    const newerToken = 'token_upgrade_reconcile_new_generation';
    const newerProcessingToken = 'processing_upgrade_reconcile_new_generation';
    const newerPriceId = 'price_upgrade_reconcile_new_generation';
    const newerProductId = 'prod_upgrade_reconcile_new_generation';
    let injected = false;
    stripe.subscriptions.retrieve.mockImplementationOnce(async id => {
      // Simulate a generation change during the external Stripe read. The
      // service must re-check durable ownership before issuing its rollback.
      await SellerSubscription.updateOne({ _id: fixture.subscription._id }, {
        $set: {
          'planChangeAttempt.idempotencyToken': newerToken,
          'planChangeAttempt.requestFingerprint': 'fingerprint_upgrade_reconcile_new_generation',
          'planChangeAttempt.changeKind': 'meta_addition',
          'planChangeAttempt.state': 'processing',
          'planChangeAttempt.processingToken': newerProcessingToken,
          'planChangeAttempt.targetPlan': 'elite',
          'planChangeAttempt.targetIncludeMetaAds': true,
          'planChangeAttempt.stripePriceId': newerPriceId,
          'planChangeAttempt.stripeProductId': newerProductId,
        },
      });
      injected = true;
      return {
        id,
        customer: fixture.subscription.stripeCustomerId,
        status: 'active',
        metadata: {
          sellerId: fixture.subscription.seller.toString(),
          plan: 'elite',
          includeMetaAds: 'true',
        },
        items: {
          data: [{
            id: `si_${fixture.subscription.stripeSubscriptionId}`,
            price: newerPriceId,
          }],
        },
      };
    });
    stripe.subscriptions.update.mockClear();

    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: fixture.targetInvoice.payment_intent,
        chargeId: fixture.targetInvoice.charge,
        amount: 400,
        refunded: 400,
      }),
      eventId: 'evt_upgrade_reconcile_token_race',
      eventType: 'charge.refunded',
    });

    const current = await SellerSubscription.findById(fixture.subscription._id);
    expect(injected).toBe(true);
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(current).toMatchObject({
      plan: 'elite',
      metaAdsIncluded: false,
      stripePriceId: fixture.targetPriceId,
      stripeProductId: fixture.targetProductId,
    });
    expect(current.planChangeAttempt).toMatchObject({
      idempotencyToken: newerToken,
      processingToken: newerProcessingToken,
      state: 'processing',
      targetPlan: 'elite',
      targetIncludeMetaAds: true,
      stripePriceId: newerPriceId,
      stripeProductId: newerProductId,
    });
  });

  test('a duplicate risk delivery reclaims a stale crashed entitlement reconciliation lease', async () => {
    const fixture = await paidStarterThenPendingUpgrade('upgrade-reconcile-crash-retry');
    const eventId = 'evt_upgrade_reconcile_crash_retry';
    const refund = riskCharge({
      paymentIntentId: fixture.targetInvoice.payment_intent,
      chargeId: fixture.targetInvoice.charge,
      amount: 400,
      refunded: 400,
    });
    stripe.subscriptions.update.mockReset()
      .mockImplementationOnce(async () => {
        const error = new Error('Process lost the Stripe response before local persistence.');
        error.type = 'StripeConnectionError';
        error.code = 'ECONNRESET';
        throw error;
      })
      .mockImplementationOnce(async (id, params) => appliedSubscriptionUpdateResponse(id, params));
    await expect(flagStripeEntitlementPaymentRisk({
      charge: refund,
      eventId,
      eventType: 'charge.refunded',
    })).rejects.toMatchObject({ planSyncOutcomeIndeterminate: true });

    const crashed = await SellerSubscription.findById(fixture.subscription._id);
    const tokenParts = crashed.planChangeAttempt.processingToken.split(':');
    const crashedAt = Date.now() - 11 * 60 * 1000;
    tokenParts[3] = String(crashedAt);
    const crashedLease = tokenParts.join(':');
    await SellerSubscription.updateOne({ _id: fixture.subscription._id }, {
      $set: {
        'planChangeAttempt.processingToken': crashedLease,
        'planChangeAttempt.fundedPlanSync.leaseToken': crashedLease,
      },
    });

    await flagStripeEntitlementPaymentRisk({
      charge: refund,
      eventId,
      eventType: 'charge.refunded',
    });

    const recovered = await SellerSubscription.findById(fixture.subscription._id);
    expect(recovered).toMatchObject({
      status: 'active',
      plan: 'starter',
      stripePriceId: fixture.subscription.planChangeAttempt.sourceStripePriceId,
      stripeProductId: fixture.subscription.planChangeAttempt.sourceStripeProductId,
    });
    expect(recovered.planChangeAttempt.idempotencyToken)
      .toBe(fixture.subscription.planChangeAttempt.idempotencyToken);
    expect(recovered.planChangeAttempt.state).toBeNull();
    expect(recovered.planChangeAttempt.processingToken).toBeNull();
    expect(recovered.planChangeAttempt.fundedPlanSync.leaseToken).toBeNull();
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscription.stripeSubscriptionId,
      expect.objectContaining({
        items: [{
          id: `si_${fixture.subscription.stripeSubscriptionId}`,
          price: fixture.subscription.planChangeAttempt.sourceStripePriceId,
          quantity: 1,
          discounts: '',
        }],
        discounts: '',
      }),
      expect.any(Object),
    );
  });

  test('an indeterminate Stripe update keeps the fresh lease and replays the identical mutation on retry', async () => {
    const fixture = await paidStarterThenPendingUpgrade('upgrade-reconcile-connection-loss');
    const eventId = 'evt_upgrade_reconcile_connection_loss';
    let appliedButResponseLost = null;
    stripe.subscriptions.update.mockReset()
      .mockImplementationOnce(async (...args) => {
        // Stripe may have committed this request before the connection failed.
        // Persist the exact observed request so the retry must be identical.
        appliedButResponseLost = args;
        const error = new Error('Connection closed after the Stripe request was sent.');
        error.type = 'StripeConnectionError';
        error.code = 'ECONNRESET';
        throw error;
      })
      .mockImplementationOnce(async (id, params) => appliedSubscriptionUpdateResponse(id, params));
    const refund = riskCharge({
      paymentIntentId: fixture.targetInvoice.payment_intent,
      chargeId: fixture.targetInvoice.charge,
      amount: 400,
      refunded: 400,
    });

    await expect(flagStripeEntitlementPaymentRisk({
      charge: refund,
      eventId,
      eventType: 'charge.refunded',
    })).rejects.toMatchObject({
      type: 'StripeConnectionError',
      planSyncOutcomeIndeterminate: true,
    });

    let current = await SellerSubscription.findById(fixture.subscription._id);
    const retainedLease = current.planChangeAttempt.processingToken;
    expect(current).toMatchObject({
      status: 'active',
      plan: 'starter',
      stripePriceId: fixture.subscription.planChangeAttempt.sourceStripePriceId,
      stripeProductId: fixture.subscription.planChangeAttempt.sourceStripeProductId,
    });
    expect((await Store.findById(fixture.store._id)).isActive).toBe(true);
    expect(current.planChangeAttempt.state).toBe('processing');
    expect(retainedLease).toMatch(/^entitlement-plan-sync:v1:applied:\d+:/);

    // This is the controller's ownership shape for replacing an applied
    // generation. The fresh service lease must make that claim fail.
    const newerClaim = await SellerSubscription.findOneAndUpdate({
      _id: current._id,
      'planChangeAttempt.idempotencyToken': current.planChangeAttempt.idempotencyToken,
      'planChangeAttempt.state': 'applied',
    }, {
      $set: {
        'planChangeAttempt.idempotencyToken': 'token_connection_loss_new_generation',
      },
    }, { new: true });
    expect(newerClaim).toBeNull();

    const retry = await flagStripeEntitlementPaymentRisk({
      charge: refund,
      eventId,
      eventType: 'charge.refunded',
    });
    expect(retry.handled).toBe(true);
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(2);
    expect(stripe.subscriptions.update.mock.calls[1]).toEqual(appliedButResponseLost);

    current = await SellerSubscription.findById(fixture.subscription._id);
    expect(current).toMatchObject({
      status: 'active',
      plan: 'starter',
      stripePriceId: fixture.subscription.planChangeAttempt.sourceStripePriceId,
      stripeProductId: fixture.subscription.planChangeAttempt.sourceStripeProductId,
    });
    expect(current.planChangeAttempt.state).toBeNull();
    expect(current.planChangeAttempt.processingToken).toBeNull();
  });

  test('a first-attempt Stripe idempotency 400 retains and replays the exact funded-plan mutation', async () => {
    const fixture = await paidStarterThenPendingUpgrade('upgrade-reconcile-idempotency-conflict');
    const eventId = 'evt_upgrade_reconcile_idempotency_conflict';
    const mutationCalls = [];
    stripe.subscriptions.update.mockReset().mockImplementation(async (...args) => {
      mutationCalls.push(args);
      if (mutationCalls.length === 1) {
        const error = new Error('An identical request with this idempotency key is still executing.');
        error.type = 'StripeIdempotencyError';
        error.code = 'idempotency_key_in_use';
        error.statusCode = 400;
        throw error;
      }
      return appliedSubscriptionUpdateResponse(args[0], args[1]);
    });
    const refund = riskCharge({
      paymentIntentId: fixture.targetInvoice.payment_intent,
      chargeId: fixture.targetInvoice.charge,
      amount: 400,
      refunded: 400,
    });

    await expect(flagStripeEntitlementPaymentRisk({
      charge: refund,
      eventId,
      eventType: 'charge.refunded',
    })).rejects.toMatchObject({
      type: 'StripeIdempotencyError',
      statusCode: 400,
      planSyncOutcomeIndeterminate: true,
    });

    let retained = await SellerSubscription.findById(fixture.subscription._id);
    expect(retained.planChangeAttempt).toMatchObject({
      state: 'processing',
      processingToken: retained.planChangeAttempt.fundedPlanSync.leaseToken,
    });
    await flagStripeEntitlementPaymentRisk({
      charge: refund,
      eventId,
      eventType: 'charge.refunded',
    });
    expect(mutationCalls).toHaveLength(2);
    expect(mutationCalls[1]).toEqual(mutationCalls[0]);

    retained = await SellerSubscription.findById(fixture.subscription._id);
    expect(retained).toMatchObject({
      plan: 'starter',
      stripePriceId: fixture.subscription.planChangeAttempt.sourceStripePriceId,
      stripeProductId: fixture.subscription.planChangeAttempt.sourceStripeProductId,
    });
    expect(retained.planChangeAttempt.state).toBeNull();
    expect(retained.planChangeAttempt.processingToken).toBeNull();
  });

  test('a lost-to-won race resolves the bound rollback key before serially restoring the newer funded Price', async () => {
    const fixture = await paidStarterThenPendingUpgrade('upgrade-reconcile-lost-won-drift');
    const dispute = riskCharge({
      paymentIntentId: fixture.targetInvoice.payment_intent,
      chargeId: fixture.targetInvoice.charge,
      amount: 400,
      disputeId: 'dp_upgrade_reconcile_lost_won_drift',
      disputeAmount: 400,
      disputeStatus: 'lost',
    });
    const itemMutations = [];
    stripe.subscriptions.update.mockReset().mockImplementation(async (...args) => {
      const [, params] = args;
      if (!params.items) return {};
      itemMutations.push(args);
      if (itemMutations.length === 1) {
        const error = new Error('The rollback may have committed before the response was lost.');
        error.type = 'StripeConnectionError';
        error.code = 'ECONNRESET';
        throw error;
      }
      return appliedSubscriptionUpdateResponse(args[0], params);
    });

    await expect(flagStripeEntitlementPaymentRisk({
      charge: dispute,
      eventId: 'evt_upgrade_reconcile_lost_timeout',
      eventType: 'charge.dispute.closed',
    })).rejects.toMatchObject({ planSyncOutcomeIndeterminate: true });

    let retained = await SellerSubscription.findById(fixture.subscription._id);
    const boundRollback = retained.planChangeAttempt.fundedPlanSync;
    expect(boundRollback).toMatchObject({
      leaseToken: retained.planChangeAttempt.processingToken,
      planChangeToken: fixture.subscription.planChangeAttempt.idempotencyToken,
      stripeSubscriptionItemId: `si_${fixture.subscription.stripeSubscriptionId}`,
      stripePriceId: fixture.subscription.planChangeAttempt.sourceStripePriceId,
      stripeProductId: fixture.subscription.planChangeAttempt.sourceStripeProductId,
      plan: 'starter',
      includeMetaAds: false,
      direction: 'predecessor',
    });
    expect(boundRollback.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(boundRollback.idempotencyKey).toBe(itemMutations[0][2].idempotencyKey);

    await flagStripeEntitlementPaymentRisk({
      charge: { ...dispute, disputeStatus: 'won' },
      eventId: 'evt_upgrade_reconcile_won_during_timeout',
      eventType: 'charge.dispute.funds_reinstated',
    });

    expect(itemMutations).toHaveLength(3);
    expect(itemMutations[1]).toEqual(itemMutations[0]);
    expect(itemMutations[0][1].items[0].price)
      .toBe(fixture.subscription.planChangeAttempt.sourceStripePriceId);
    expect(itemMutations[2][1].items[0].price).toBe(fixture.targetPriceId);
    expect(itemMutations[2][2].idempotencyKey).not.toBe(itemMutations[0][2].idempotencyKey);

    retained = await SellerSubscription.findById(fixture.subscription._id);
    expect(retained).toMatchObject({
      status: 'active',
      plan: 'elite',
      metaAdsIncluded: false,
      stripePriceId: fixture.targetPriceId,
      stripeProductId: fixture.targetProductId,
    });
    expect(retained.planChangeAttempt.state).toBe('applied');
    expect(retained.planChangeAttempt.processingToken).toBeNull();
    expect(retained.planChangeAttempt.fundedPlanSync.leaseToken).toBeNull();
  });

  test('a retry-time 403 cannot release an earlier indeterminate funded-plan mutation', async () => {
    const fixture = await paidStarterThenPendingUpgrade('upgrade-reconcile-retained-403');
    const eventId = 'evt_upgrade_reconcile_retained_403';
    const refund = riskCharge({
      paymentIntentId: fixture.targetInvoice.payment_intent,
      chargeId: fixture.targetInvoice.charge,
      amount: 400,
      refunded: 400,
    });
    const itemMutations = [];
    stripe.subscriptions.update.mockReset().mockImplementation(async (...args) => {
      itemMutations.push(args);
      if (itemMutations.length === 1) {
        const error = new Error('Stripe response was lost.');
        error.type = 'StripeConnectionError';
        error.code = 'ECONNRESET';
        throw error;
      }
      return appliedSubscriptionUpdateResponse(args[0], args[1]);
    });

    await expect(flagStripeEntitlementPaymentRisk({
      charge: refund,
      eventId,
      eventType: 'charge.refunded',
    })).rejects.toMatchObject({ planSyncOutcomeIndeterminate: true });
    let retained = await SellerSubscription.findById(fixture.subscription._id);
    const leaseToken = retained.planChangeAttempt.processingToken;
    const snapshotHash = retained.planChangeAttempt.fundedPlanSync.snapshotHash;

    stripe.subscriptions.retrieve.mockRejectedValueOnce(Object.assign(
      new Error('Forbidden while checking the retained Stripe mutation.'),
      { type: 'StripeInvalidRequestError', statusCode: 403 },
    ));
    await expect(flagStripeEntitlementPaymentRisk({
      charge: refund,
      eventId,
      eventType: 'charge.refunded',
    })).rejects.toMatchObject({
      statusCode: 403,
      planSyncOutcomeIndeterminate: true,
    });

    retained = await SellerSubscription.findById(fixture.subscription._id);
    expect(retained.planChangeAttempt).toMatchObject({
      state: 'processing',
      processingToken: leaseToken,
    });
    expect(retained.planChangeAttempt.fundedPlanSync).toMatchObject({
      leaseToken,
      snapshotHash,
    });
    expect(itemMutations).toHaveLength(1);

    await flagStripeEntitlementPaymentRisk({
      charge: refund,
      eventId,
      eventType: 'charge.refunded',
    });
    expect(itemMutations).toHaveLength(2);
    expect(itemMutations[1]).toEqual(itemMutations[0]);
    retained = await SellerSubscription.findById(fixture.subscription._id);
    expect(retained.planChangeAttempt.state).toBeNull();
    expect(retained.planChangeAttempt.processingToken).toBeNull();
  });

  test('rejects a multi-item Stripe subscription before issuing a new funded-plan mutation', async () => {
    const fixture = await paidStarterThenPendingUpgrade('upgrade-reconcile-extra-item');
    const refund = riskCharge({
      paymentIntentId: fixture.targetInvoice.payment_intent,
      chargeId: fixture.targetInvoice.charge,
      amount: 400,
      refunded: 400,
    });
    stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.subscription.stripeSubscriptionId,
      customer: fixture.subscription.stripeCustomerId,
      status: 'active',
      metadata: {
        sellerId: fixture.subscription.seller.toString(),
        plan: 'elite',
        includeMetaAds: 'false',
      },
      items: {
        data: [
          {
            id: `si_${fixture.subscription.stripeSubscriptionId}`,
            price: fixture.targetPriceId,
            quantity: 1,
            discounts: [],
          },
          {
            id: `si_unapproved_${fixture.subscription.stripeSubscriptionId}`,
            price: 'price_unapproved_extra_item',
            quantity: 1,
            discounts: [],
          },
        ],
      },
      discounts: [],
    });

    await expect(flagStripeEntitlementPaymentRisk({
      charge: refund,
      eventId: 'evt_upgrade_reconcile_extra_item',
      eventType: 'charge.refunded',
    })).rejects.toMatchObject({
      code: 'STRIPE_SUBSCRIPTION_PLAN_ROLLBACK_UNAVAILABLE',
    });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();

    const retained = await SellerSubscription.findById(fixture.subscription._id);
    expect(retained).toMatchObject({
      status: 'active',
      plan: 'starter',
      stripePriceId: fixture.subscription.planChangeAttempt.sourceStripePriceId,
      stripeProductId: fixture.subscription.planChangeAttempt.sourceStripeProductId,
    });
    expect((await Store.findById(fixture.store._id)).isActive).toBe(true);
    expect(retained.planChangeAttempt.state).toBe('applied');
    expect(retained.planChangeAttempt.processingToken).toBeNull();
  });

  test('funded-plan reconciliation resets quantity and subscription/item discounts exactly', async () => {
    const fixture = await paidStarterThenPendingUpgrade('upgrade-reconcile-shape-repair');
    const itemId = `si_${fixture.subscription.stripeSubscriptionId}`;
    stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.subscription.stripeSubscriptionId,
      customer: fixture.subscription.stripeCustomerId,
      status: 'active',
      metadata: {
        sellerId: fixture.subscription.seller.toString(),
        plan: 'elite',
        includeMetaAds: 'false',
      },
      items: {
        data: [{
          id: itemId,
          price: fixture.targetPriceId,
          quantity: 3,
          discounts: ['di_unapproved_item'],
        }],
      },
      discounts: ['di_unapproved_subscription'],
    });
    stripe.subscriptions.update.mockImplementation(async (id, params) => ({
      id,
      metadata: params.metadata,
      discounts: [],
      items: {
        has_more: false,
        data: [{
          id: itemId,
          price: {
            id: params.items[0].price,
            product: fixture.subscription.planChangeAttempt.sourceStripeProductId,
          },
          quantity: params.items[0].quantity,
          discounts: [],
        }],
      },
    }));

    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: fixture.targetInvoice.payment_intent,
        chargeId: fixture.targetInvoice.charge,
        amount: 400,
        refunded: 400,
      }),
      eventId: 'evt_upgrade_reconcile_shape_repair',
      eventType: 'charge.refunded',
    });

    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscription.stripeSubscriptionId,
      expect.objectContaining({
        items: [{
          id: itemId,
          price: fixture.subscription.planChangeAttempt.sourceStripePriceId,
          quantity: 1,
          discounts: '',
        }],
        discounts: '',
        proration_behavior: 'none',
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    const repaired = await SellerSubscription.findById(fixture.subscription._id);
    expect(repaired).toMatchObject({
      plan: 'starter',
      stripePriceId: fixture.subscription.planChangeAttempt.sourceStripePriceId,
      stripeProductId: fixture.subscription.planChangeAttempt.sourceStripeProductId,
    });
  });

  test.each([
    ['boolean', true],
    ['string', '1'],
  ])('repairs a present %s Stripe quantity instead of coercing it to one', async (suffix, quantity) => {
    const fixture = await paidStarterThenPendingUpgrade(`upgrade-reconcile-${suffix}-quantity`);
    const itemId = `si_${fixture.subscription.stripeSubscriptionId}`;
    const sourcePriceId = fixture.subscription.planChangeAttempt.sourceStripePriceId;
    const sourceProductId = fixture.subscription.planChangeAttempt.sourceStripeProductId;
    stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.subscription.stripeSubscriptionId,
      customer: fixture.subscription.stripeCustomerId,
      status: 'active',
      metadata: {
        sellerId: fixture.subscription.seller.toString(),
        plan: 'starter',
        includeMetaAds: 'false',
        entitlementPriceId: sourcePriceId,
        entitlementProductId: sourceProductId,
      },
      items: {
        has_more: false,
        data: [{
          id: itemId,
          price: sourcePriceId,
          quantity,
          discounts: [],
        }],
      },
      discounts: [],
    });

    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: fixture.targetInvoice.payment_intent,
        chargeId: fixture.targetInvoice.charge,
        amount: 400,
        refunded: 400,
      }),
      eventId: `evt_upgrade_reconcile_${suffix}_quantity`,
      eventType: 'charge.refunded',
    });

    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscription.stripeSubscriptionId,
      expect.objectContaining({
        items: [expect.objectContaining({ id: itemId, quantity: 1 })],
      }),
      expect.any(Object),
    );
  });

  test('rejects a truncated Stripe item page before a new funded-plan mutation', async () => {
    const fixture = await paidStarterThenPendingUpgrade('upgrade-reconcile-truncated-items');
    stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.subscription.stripeSubscriptionId,
      customer: fixture.subscription.stripeCustomerId,
      status: 'active',
      items: {
        has_more: true,
        data: [{
          id: `si_${fixture.subscription.stripeSubscriptionId}`,
          price: fixture.targetPriceId,
          quantity: 1,
          discounts: [],
        }],
      },
      discounts: [],
    });

    await expect(flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: fixture.targetInvoice.payment_intent,
        chargeId: fixture.targetInvoice.charge,
        amount: 400,
        refunded: 400,
      }),
      eventId: 'evt_upgrade_reconcile_truncated_items',
      eventType: 'charge.refunded',
    })).rejects.toMatchObject({ code: 'STRIPE_SUBSCRIPTION_PLAN_ROLLBACK_UNAVAILABLE' });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    const released = await SellerSubscription.findById(fixture.subscription._id);
    expect(released).toMatchObject({
      status: 'active',
      plan: 'starter',
      stripePriceId: fixture.subscription.planChangeAttempt.sourceStripePriceId,
    });
    expect(released.planChangeAttempt.state).toBe('applied');
    expect(released.planChangeAttempt.processingToken).toBeNull();
  });

  test('an incomplete Stripe update response retains the exact lease while committing restrictive local state', async () => {
    const fixture = await paidStarterThenPendingUpgrade('upgrade-reconcile-incomplete-response');
    stripe.subscriptions.update.mockResolvedValue({});
    await expect(flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: fixture.targetInvoice.payment_intent,
        chargeId: fixture.targetInvoice.charge,
        amount: 400,
        refunded: 400,
      }),
      eventId: 'evt_upgrade_reconcile_incomplete_response',
      eventType: 'charge.refunded',
    })).rejects.toMatchObject({
      code: 'STRIPE_SUBSCRIPTION_PLAN_ROLLBACK_UNAVAILABLE',
      planSyncOutcomeIndeterminate: true,
    });
    const retained = await SellerSubscription.findById(fixture.subscription._id);
    expect(retained).toMatchObject({
      status: 'active',
      plan: 'starter',
      stripePriceId: fixture.subscription.planChangeAttempt.sourceStripePriceId,
    });
    expect(retained.planChangeAttempt.state).toBe('processing');
    expect(retained.planChangeAttempt.processingToken)
      .toBe(retained.planChangeAttempt.fundedPlanSync.leaseToken);
  });

  test('an expired retained target resolves first, then serially converges to active baseline coverage', async () => {
    const fixture = await paidStarterThenPendingUpgrade('reconcile-expired-target');
    const dispute = riskCharge({
      paymentIntentId: fixture.targetInvoice.payment_intent,
      chargeId: fixture.targetInvoice.charge,
      amount: 400,
      disputeId: 'dp_upgrade_reconcile_expired_retained_target',
      disputeAmount: 400,
      disputeStatus: 'lost',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: dispute,
      eventId: 'evt_upgrade_reconcile_expired_target_lost',
      eventType: 'charge.dispute.closed',
    });

    const targetMutations = [];
    stripe.subscriptions.update.mockReset().mockImplementation(async (...args) => {
      if (!args[1]?.items) return {};
      targetMutations.push(args);
      if (targetMutations.length === 1) {
        const error = new Error('Elite restore may have committed before its response was lost.');
        error.type = 'StripeConnectionError';
        error.code = 'ECONNRESET';
        throw error;
      }
      return appliedSubscriptionUpdateResponse(args[0], args[1]);
    });
    const won = { ...dispute, disputeStatus: 'won' };
    await expect(flagStripeEntitlementPaymentRisk({
      charge: won,
      eventId: 'evt_upgrade_reconcile_expired_target_won_timeout',
      eventType: 'charge.dispute.funds_reinstated',
    })).rejects.toMatchObject({ planSyncOutcomeIndeterminate: true });

    const expiredAt = new Date(Date.now() - 1000);
    await StripeEntitlementPayment.updateOne({ invoiceId: fixture.targetInvoice.id }, {
      $set: { grantEnd: expiredAt, effectiveGrantEnd: expiredAt },
    });
    await flagStripeEntitlementPaymentRisk({
      charge: won,
      eventId: 'evt_upgrade_reconcile_expired_target_won_timeout',
      eventType: 'charge.dispute.funds_reinstated',
    });

    expect(targetMutations).toHaveLength(3);
    expect(targetMutations[1]).toEqual(targetMutations[0]);
    expect(targetMutations[0][1].items[0].price).toBe(fixture.targetPriceId);
    expect(targetMutations[2][1].items[0].price)
      .toBe(fixture.subscription.planChangeAttempt.sourceStripePriceId);
    expect(targetMutations[2][2].idempotencyKey)
      .not.toBe(targetMutations[0][2].idempotencyKey);
    const converged = await SellerSubscription.findById(fixture.subscription._id);
    expect(converged).toMatchObject({
      status: 'active',
      plan: 'starter',
      stripePriceId: fixture.subscription.planChangeAttempt.sourceStripePriceId,
      stripeProductId: fixture.subscription.planChangeAttempt.sourceStripeProductId,
    });
    expect(converged.planChangeAttempt.state).toBeNull();
    expect(converged.planChangeAttempt.processingToken).toBeNull();
  });

  test('a refunded Meta delta falls back to its still-funded Elite predecessor', async () => {
    const upgraded = await paidStarterThenPendingUpgrade('chain-meta-refund');
    const fixture = await addPaidMetaDelta(upgraded, 'chain-meta-refund');
    // Price-only equality is insufficient: a manual/retried remote correction
    // can leave Stripe metadata at the revoked Meta target. The reconciliation
    // must repair metadata so the next invoice snapshot matches local funding.
    stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.subscription.stripeSubscriptionId,
      customer: fixture.subscription.stripeCustomerId,
      status: 'active',
      metadata: {
        sellerId: fixture.subscription.seller.toString(),
        plan: 'elite',
        includeMetaAds: 'true',
      },
      items: {
        data: [{
          id: `si_${fixture.subscription.stripeSubscriptionId}`,
          price: fixture.targetPriceId,
        }],
      },
    });
    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: fixture.metaInvoice.payment_intent,
        chargeId: fixture.metaInvoice.charge,
        amount: 100,
        refunded: 100,
      }),
      eventId: 'evt_chain_meta_refund',
      eventType: 'charge.refunded',
    });

    const rolledBack = await SellerSubscription.findById(fixture.subscription._id);
    expect(rolledBack).toMatchObject({
      status: 'active',
      plan: 'elite',
      metaAdsIncluded: false,
      stripePriceId: fixture.targetPriceId,
      stripeProductId: fixture.targetProductId,
    });
    expect(rolledBack.planChangeAttempt.state).toBeNull();
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      rolledBack.stripeSubscriptionId,
      expect.objectContaining({
        items: [{
          id: `si_${rolledBack.stripeSubscriptionId}`,
          price: fixture.targetPriceId,
          quantity: 1,
          discounts: '',
        }],
        discounts: '',
      }),
      expect.any(Object),
    );
  });

  test('a lost Elite delta invalidates its paid dependent Meta delta, and a win restores the full chain', async () => {
    const upgraded = await paidStarterThenPendingUpgrade('chain-elite-loss');
    const fixture = await addPaidMetaDelta(upgraded, 'chain-elite-loss');
    const dispute = riskCharge({
      paymentIntentId: fixture.targetInvoice.payment_intent,
      chargeId: fixture.targetInvoice.charge,
      amount: 400,
      disputeId: 'dp_chain_elite_loss',
      disputeAmount: 400,
      disputeStatus: 'lost',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: dispute,
      eventId: 'evt_chain_elite_loss_lost',
      eventType: 'charge.dispute.closed',
    });
    let rolledBack = await SellerSubscription.findById(fixture.subscription._id);
    expect(rolledBack).toMatchObject({
      status: 'active',
      plan: 'starter',
      metaAdsIncluded: false,
      stripePriceId: upgraded.subscription.planChangeAttempt.sourceStripePriceId,
      stripeProductId: upgraded.subscription.planChangeAttempt.sourceStripeProductId,
    });
    expect(rolledBack.planChangeAttempt.idempotencyToken)
      .toBe(`token_chain-elite-loss_meta_addition`);
    expect(rolledBack.planChangeAttempt.state).toBeNull();

    await flagStripeEntitlementPaymentRisk({
      charge: { ...dispute, disputeStatus: 'won' },
      eventId: 'evt_chain_elite_loss_won',
      eventType: 'charge.dispute.funds_reinstated',
    });
    rolledBack = await SellerSubscription.findById(fixture.subscription._id);
    expect(rolledBack).toMatchObject({
      status: 'active',
      plan: 'elite',
      metaAdsIncluded: true,
      stripePriceId: fixture.metaPriceId,
      stripeProductId: fixture.metaProductId,
    });
    expect(rolledBack.planChangeAttempt.state).toBe('applied');
  });

  test('a won dispute releases only its own share; a remaining refund cannot regrant Elite', async () => {
    const fixture = await paidStarterThenPendingUpgrade('upgrade-refund-plus-dispute');
    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: fixture.targetInvoice.payment_intent,
        chargeId: fixture.targetInvoice.charge,
        amount: 400,
        refunded: 100,
      }),
      eventId: 'evt_upgrade_refund_share',
      eventType: 'charge.refunded',
    });
    const dispute = riskCharge({
      paymentIntentId: fixture.targetInvoice.payment_intent,
      chargeId: fixture.targetInvoice.charge,
      amount: 400,
      refunded: 100,
      disputeId: 'dp_upgrade_remaining_share',
      disputeAmount: 300,
      disputeStatus: 'lost',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: dispute,
      eventId: 'evt_upgrade_remaining_share_lost',
      eventType: 'charge.dispute.closed',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: { ...dispute, disputeStatus: 'won' },
      eventId: 'evt_upgrade_remaining_share_won',
      eventType: 'charge.dispute.funds_reinstated',
    });

    const [stillStarter, payment] = await Promise.all([
      SellerSubscription.findById(fixture.subscription._id),
      StripeEntitlementPayment.findOne({ invoiceId: fixture.targetInvoice.id }),
    ]);
    expect(stillStarter).toMatchObject({ status: 'active', plan: 'starter' });
    expect(stillStarter.planChangeAttempt.state).toBeNull();
    expect(payment.refundedMinor).toBe(100);
    expect(payment.disputeState).toBe('won');
    expect(payment.effectiveGrantEnd.getTime()).toBe(
      fixture.targetStart.getTime() + Number((BigInt(30 * DAY_MS) * 300n) / 400n),
    );
  });

  test('partial refund shortens exact period; full refund terminally blocks but permits a fresh Checkout', async () => {
    const { store, subscription } = await setupSubscription('refund');
    const start = stripePrecisionDate(Date.now() - 2 * DAY_MS);
    const end = new Date(start.getTime() + 30 * DAY_MS);
    const invoice = paidInvoice({
      id: 'in_refund',
      subscriptionId: subscription.stripeSubscriptionId,
      paymentIntentId: 'pi_subscription_refund',
      chargeId: 'ch_subscription_refund',
      amount: 3000,
      start,
      end,
    });
    await recordSubscriptionInvoicePayment({ invoice, eventId: 'evt_invoice_paid', eventCreated: 100 });

    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_subscription_refund',
        chargeId: 'ch_subscription_refund',
        refunded: 1000,
      }),
      eventId: 'evt_invoice_partial_refund',
      eventType: 'charge.refunded',
    });
    let payment = await StripeEntitlementPayment.findOne({ invoiceId: invoice.id });
    expect(payment.effectiveGrantEnd.getTime() - start.getTime()).toBe(20 * DAY_MS);

    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_subscription_refund',
        chargeId: 'ch_subscription_refund',
        refunded: 3000,
      }),
      eventId: 'evt_invoice_full_refund',
      eventType: 'charge.refunded',
    });
    const updatedSubscription = await SellerSubscription.findById(subscription._id);
    const updatedStore = await Store.findById(store._id);
    payment = await StripeEntitlementPayment.findOne({ invoiceId: invoice.id });
    expect(payment.effectiveGrantEnd).toEqual(start);
    expect(updatedSubscription.status).toBe('blocked');
    expect(updatedSubscription.paymentRisk.suspended).toBe(false);
    expect(updatedSubscription.blockedReason).toMatch(/^Stripe payment reversal/);
    expect(updatedStore.isActive).toBe(false);
    expect(updatedStore.subscriptionPaymentRiskLock?.stripeSubscriptionId || '').toBe('');
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      subscription.stripeSubscriptionId,
      { pause_collection: { behavior: 'void' } },
    );
  });

  test('won dispute restores the exact paid interval and ignores delayed financial delivery', async () => {
    const { subscription } = await setupSubscription('won');
    stripe.subscriptions.retrieve.mockResolvedValue({ id: subscription.stripeSubscriptionId, status: 'active' });
    const start = stripePrecisionDate(Date.now() - DAY_MS);
    const end = new Date(start.getTime() + 30 * DAY_MS);
    const invoice = paidInvoice({
      id: 'in_won',
      subscriptionId: subscription.stripeSubscriptionId,
      paymentIntentId: 'pi_subscription_won',
      chargeId: 'ch_subscription_won',
      start,
      end,
    });
    await recordSubscriptionInvoicePayment({ invoice, eventId: 'evt_won_paid', eventCreated: 100 });
    const disputedCharge = riskCharge({
      paymentIntentId: 'pi_subscription_won',
      chargeId: 'ch_subscription_won',
      disputeId: 'dp_subscription_won',
      disputeAmount: 3000,
      disputeStatus: 'needs_response',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: disputedCharge,
      eventId: 'evt_won_open',
      eventType: 'charge.dispute.funds_withdrawn',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: { ...disputedCharge, disputeStatus: 'won' },
      eventId: 'evt_won_closed',
      eventType: 'charge.dispute.closed',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: disputedCharge,
      eventId: 'evt_won_delayed',
      eventType: 'charge.dispute.funds_withdrawn',
    });

    const updated = await SellerSubscription.findById(subscription._id);
    const payment = await StripeEntitlementPayment.findOne({ invoiceId: invoice.id });
    expect(updated.status).toBe('active');
    expect(updated.paymentRisk.suspended).toBe(false);
    expect(updated.currentPeriodEnd).toEqual(end);
    expect(payment.disputeState).toBe('won');
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      subscription.stripeSubscriptionId,
      { pause_collection: '' },
    );
  });

  test('a full lost dispute permits fresh Checkout and a Stripe late win restores only the exact owned block', async () => {
    const { store, subscription } = await setupSubscription('lost-terminal');
    stripe.subscriptions.retrieve.mockResolvedValue({ id: subscription.stripeSubscriptionId, status: 'active' });
    const start = stripePrecisionDate(Date.now() - DAY_MS);
    const end = new Date(start.getTime() + 30 * DAY_MS);
    const invoice = paidInvoice({
      id: 'in_lost_terminal',
      subscriptionId: subscription.stripeSubscriptionId,
      paymentIntentId: 'pi_lost_terminal',
      chargeId: 'ch_lost_terminal',
      start,
      end,
    });
    await recordSubscriptionInvoicePayment({ invoice, eventCreated: 100 });
    const dispute = riskCharge({
      paymentIntentId: 'pi_lost_terminal',
      chargeId: 'ch_lost_terminal',
      disputeId: 'dp_lost_terminal',
      disputeAmount: 3000,
      disputeStatus: 'needs_response',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: dispute,
      eventId: 'evt_lost_terminal_open',
      eventType: 'charge.dispute.funds_withdrawn',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: { ...dispute, disputeStatus: 'lost' },
      eventId: 'evt_lost_terminal_closed',
      eventType: 'charge.dispute.closed',
    });

    const [updated, updatedStore] = await Promise.all([
      SellerSubscription.findById(subscription._id),
      Store.findById(store._id),
    ]);
    expect(updated.status).toBe('blocked');
    expect(updated.paymentRisk.suspended).toBe(false);
    expect(updatedStore.isActive).toBe(false);
    expect(updatedStore.subscriptionPaymentRiskLock?.stripeSubscriptionId || '').toBe('');

    await flagStripeEntitlementPaymentRisk({
      charge: { ...dispute, disputeStatus: 'won' },
      eventId: 'evt_lost_terminal_late_win',
      eventType: 'charge.dispute.funds_reinstated',
    });
    const [restored, restoredStore] = await Promise.all([
      SellerSubscription.findById(subscription._id),
      Store.findById(store._id),
    ]);
    expect(restored.status).toBe('active');
    expect(restored.paymentRisk.suspended).toBe(false);
    expect(restored.currentPeriodEnd).toEqual(end);
    expect(restoredStore.isActive).toBe(true);
    expect(restoredStore.blockedAt).toBeNull();
    expect(stripe.subscriptions.update).toHaveBeenLastCalledWith(
      subscription.stripeSubscriptionId,
      { pause_collection: '' },
    );
  });

  test('winning one dispute releases the transient lock when another terminal loss still removes all coverage', async () => {
    const { store, subscription } = await setupSubscription('lost-behind-open');
    stripe.subscriptions.retrieve.mockResolvedValue({ id: subscription.stripeSubscriptionId, status: 'active' });
    const start = stripePrecisionDate(Date.now() - DAY_MS);
    const invoice = paidInvoice({
      id: 'in_lost_behind_open',
      subscriptionId: subscription.stripeSubscriptionId,
      paymentIntentId: 'pi_lost_behind_open',
      chargeId: 'ch_lost_behind_open',
      start,
      end: new Date(start.getTime() + 30 * DAY_MS),
    });
    await recordSubscriptionInvoicePayment({ invoice, eventCreated: 100 });

    const firstDispute = riskCharge({
      paymentIntentId: 'pi_lost_behind_open',
      chargeId: 'ch_lost_behind_open',
      disputeId: 'dp_terminal_loss',
      disputeAmount: 3000,
      disputeStatus: 'needs_response',
    });
    const secondDispute = {
      ...firstDispute,
      disputeId: 'dp_eventually_won',
    };
    await flagStripeEntitlementPaymentRisk({
      charge: firstDispute,
      eventId: 'evt_first_dispute_open',
      eventType: 'charge.dispute.funds_withdrawn',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: secondDispute,
      eventId: 'evt_second_dispute_open',
      eventType: 'charge.dispute.funds_withdrawn',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: { ...firstDispute, disputeStatus: 'lost' },
      eventId: 'evt_first_dispute_lost',
      eventType: 'charge.dispute.closed',
    });

    let stillOpen = await SellerSubscription.findById(subscription._id);
    expect(stillOpen.status).toBe('past_due');
    expect(stillOpen.paymentRisk.suspended).toBe(true);

    await flagStripeEntitlementPaymentRisk({
      charge: { ...secondDispute, disputeStatus: 'won' },
      eventId: 'evt_second_dispute_won',
      eventType: 'charge.dispute.closed',
    });

    const [updated, updatedStore] = await Promise.all([
      SellerSubscription.findById(subscription._id),
      Store.findById(store._id),
    ]);
    expect(updated.status).toBe('blocked');
    expect(updated.paymentRisk.suspended).toBe(false);
    expect(updated.blockedReason).toMatch(/^Stripe payment reversal/);
    expect(updatedStore.isActive).toBe(false);
    expect(updatedStore.subscriptionPaymentRiskLock?.stripeSubscriptionId || '').toBe('');
  });

  test('won dispute never reactivates a store that was independently blocked after the risk lock', async () => {
    const { store, subscription } = await setupSubscription('won-independent-block');
    stripe.subscriptions.retrieve.mockResolvedValue({ id: subscription.stripeSubscriptionId, status: 'active' });
    const start = stripePrecisionDate(Date.now() - DAY_MS);
    const invoice = paidInvoice({
      id: 'in_won_independent_block',
      subscriptionId: subscription.stripeSubscriptionId,
      paymentIntentId: 'pi_won_independent_block',
      chargeId: 'ch_won_independent_block',
      start,
      end: new Date(start.getTime() + 30 * DAY_MS),
    });
    await recordSubscriptionInvoicePayment({ invoice, eventCreated: 100 });
    const dispute = riskCharge({
      paymentIntentId: 'pi_won_independent_block',
      chargeId: 'ch_won_independent_block',
      disputeId: 'dp_won_independent_block',
      disputeAmount: 3000,
      disputeStatus: 'needs_response',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: dispute,
      eventId: 'evt_won_independent_open',
      eventType: 'charge.dispute.funds_withdrawn',
    });
    const independentBlockAt = new Date(Date.now() + 1000);
    await Store.updateOne({ _id: store._id }, { $set: { isActive: false, blockedAt: independentBlockAt } });
    await flagStripeEntitlementPaymentRisk({
      charge: { ...dispute, disputeStatus: 'won' },
      eventId: 'evt_won_independent_closed',
      eventType: 'charge.dispute.closed',
    });

    const updatedStore = await Store.findById(store._id);
    expect(updatedStore.isActive).toBe(false);
    expect(updatedStore.blockedAt).toEqual(independentBlockAt);
    expect(updatedStore.subscriptionPaymentRiskLock?.stripeSubscriptionId || '').toBe('');
  });

  test('resolves a historical metadata-less Charge through its invoice and current subscription', async () => {
    const { seller, subscription } = await setupSubscription('historical-invoice');
    const start = stripePrecisionDate(Date.now() - DAY_MS);
    const end = new Date(start.getTime() + 30 * DAY_MS);
    const invoice = paidInvoice({
      id: 'in_historical_charge',
      subscriptionId: subscription.stripeSubscriptionId,
      paymentIntentId: 'pi_historical_invoice',
      chargeId: 'ch_historical_invoice',
      start,
      end,
    });
    invoice.parent = {
      subscription_details: {
        subscription: subscription.stripeSubscriptionId,
        metadata: { sellerId: seller._id.toString() },
      },
    };
    delete invoice.subscription;
    stripe.invoices.retrieve.mockResolvedValue(invoice);

    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_historical_invoice',
        chargeId: 'ch_historical_invoice',
        refunded: 3000,
        invoice: invoice.id,
      }),
      eventId: 'evt_historical_invoice_refund',
      eventType: 'charge.refunded',
    });

    expect(stripe.invoices.retrieve).toHaveBeenCalledWith(invoice.id, {
      expand: ['parent.subscription_details.subscription', 'lines.data'],
    });
    const payment = await StripeEntitlementPayment.findOne({ invoiceId: invoice.id });
    expect(payment.refundedMinor).toBe(3000);
  });

  test('resolves a Basil metadata-less Charge through Invoice Payments when Charge.invoice is absent', async () => {
    const { seller, subscription } = await setupSubscription('basil-association');
    const start = stripePrecisionDate(Date.now() - DAY_MS);
    const invoice = paidInvoice({
      id: 'in_basil_association',
      subscriptionId: subscription.stripeSubscriptionId,
      customer: subscription.stripeCustomerId,
      paymentIntentId: 'pi_basil_association',
      amount: 999,
      start,
      end: new Date(start.getTime() + 30 * DAY_MS),
    });
    invoice.parent = {
      subscription_details: {
        subscription: subscription.stripeSubscriptionId,
        metadata: { sellerId: seller._id.toString(), plan: 'starter' },
      },
    };
    delete invoice.subscription;
    delete invoice.payment_intent;
    delete invoice.charge;
    stripe.invoicePayments.list
      .mockResolvedValueOnce({
        data: [invoice.payments.data[0]],
        has_more: false,
      })
      .mockResolvedValueOnce({
        data: invoice.payments.data,
        has_more: false,
      });
    stripe.invoices.retrieve.mockResolvedValue(invoice);

    const result = await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_basil_association',
        chargeId: 'ch_basil_association',
        refunded: 999,
      }),
      eventId: 'evt_basil_association_refund',
      eventType: 'charge.refunded',
    });

    expect(result).toMatchObject({ handled: true, sourceType: 'subscription_invoice' });
    expect(stripe.invoicePayments.list).toHaveBeenCalledWith({
      payment: { type: 'payment_intent', payment_intent: 'pi_basil_association' },
      status: 'paid',
      limit: 100,
    });
    expect(stripe.invoicePayments.list).toHaveBeenCalledWith({
      invoice: invoice.id,
      status: 'paid',
      limit: 100,
    });
    expect(stripe.invoices.retrieve).toHaveBeenCalledWith(invoice.id, {
      expand: ['parent.subscription_details.subscription', 'lines.data'],
    });
    const payment = await StripeEntitlementPayment.findOne({ invoiceId: invoice.id });
    expect(payment.refundedMinor).toBe(999);
    expect(payment.chargeTracks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        invoicePaymentId: `inpay_${invoice.id}`,
        paymentIntentId: 'pi_basil_association',
        chargeId: 'ch_basil_association',
        capturedMinor: 999,
        refundedMinor: 999,
      }),
    ]));
  });

  test('propagates transient Invoice Payment association failures, but safely ignores an authoritative empty lookup', async () => {
    const lookupFailure = new Error('temporary Stripe network failure');
    stripe.invoicePayments.list.mockRejectedValueOnce(lookupFailure);
    await expect(flagStripePaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_lookup_transient',
        chargeId: 'ch_lookup_transient',
        refunded: 100,
      }),
      eventId: 'evt_lookup_transient',
      eventType: 'charge.refunded',
    })).rejects.toBe(lookupFailure);

    stripe.invoicePayments.list.mockResolvedValueOnce({ data: [], has_more: false });
    await expect(flagStripePaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_genuinely_unrelated',
        chargeId: 'ch_genuinely_unrelated',
        refunded: 100,
      }),
      eventId: 'evt_genuinely_unrelated',
      eventType: 'charge.refunded',
    })).resolves.toBeNull();
  });

  test('retries a credible local Invoice Payment whose subscription identity is incomplete, but ignores a verified unrelated invoice', async () => {
    const { subscription } = await setupSubscription('credible-incomplete-association');
    const start = stripePrecisionDate(Date.now() - DAY_MS);
    stripe.invoicePayments.list.mockResolvedValueOnce({ data: [], has_more: false });
    await expect(flagStripePaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_local_customer_unresolved',
        chargeId: 'ch_local_customer_unresolved',
        customer: subscription.stripeCustomerId,
        refunded: 999,
      }),
      eventId: 'evt_local_customer_unresolved',
      eventType: 'charge.refunded',
    })).rejects.toMatchObject({
      code: 'STRIPE_SUBSCRIPTION_ASSOCIATION_UNRESOLVED',
      statusCode: 503,
    });

    const localInvoice = paidInvoice({
      id: 'in_credible_incomplete_association',
      subscriptionId: subscription.stripeSubscriptionId,
      customer: subscription.stripeCustomerId,
      paymentIntentId: 'pi_credible_incomplete_association',
      amount: 999,
      start,
      end: new Date(start.getTime() + 30 * DAY_MS),
    });
    delete localInvoice.subscription;
    delete localInvoice.parent;
    stripe.invoicePayments.list
      .mockResolvedValueOnce({ data: localInvoice.payments.data, has_more: false })
      .mockResolvedValueOnce({ data: localInvoice.payments.data, has_more: false });
    stripe.invoices.retrieve.mockResolvedValueOnce(localInvoice);

    await expect(flagStripePaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_credible_incomplete_association',
        chargeId: 'ch_credible_incomplete_association',
        refunded: 999,
      }),
      eventId: 'evt_credible_incomplete_association',
      eventType: 'charge.refunded',
    })).rejects.toMatchObject({
      code: 'STRIPE_SUBSCRIPTION_ASSOCIATION_UNRESOLVED',
      statusCode: 503,
    });

    const unrelatedInvoice = {
      ...localInvoice,
      id: 'in_verified_unrelated',
      customer: 'cus_verified_unrelated',
    };
    unrelatedInvoice.payments = {
      ...localInvoice.payments,
      data: localInvoice.payments.data.map(row => ({
        ...row,
        id: 'inpay_verified_unrelated',
        invoice: unrelatedInvoice.id,
        payment: { type: 'payment_intent', payment_intent: 'pi_verified_unrelated' },
      })),
    };
    stripe.invoicePayments.list
      .mockResolvedValueOnce({ data: unrelatedInvoice.payments.data, has_more: false })
      .mockResolvedValueOnce({ data: unrelatedInvoice.payments.data, has_more: false });
    stripe.invoices.retrieve.mockResolvedValueOnce(unrelatedInvoice);
    await expect(flagStripePaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_verified_unrelated',
        chargeId: 'ch_verified_unrelated',
        refunded: 999,
      }),
      eventId: 'evt_verified_unrelated',
      eventType: 'charge.refunded',
    })).resolves.toBeNull();
  });

  test('tracks multiple Invoice Payments independently and caps reverse-order refund plus dispute exposure per Charge', async () => {
    const { subscription } = await setupSubscription('multiple-payments');
    const start = stripePrecisionDate(Date.now() - DAY_MS);
    const end = new Date(start.getTime() + 30 * DAY_MS);
    const invoice = paidInvoice({
      id: 'in_multiple_payments',
      subscriptionId: subscription.stripeSubscriptionId,
      customer: subscription.stripeCustomerId,
      amount: 1000,
      start,
      end,
    });
    invoice.payments.data = [
      {
        ...invoice.payments.data[0],
        id: 'inpay_multiple_a',
        amount_paid: 600,
        amount_requested: 600,
        payment: { type: 'payment_intent', payment_intent: 'pi_multiple_a' },
      },
      {
        ...invoice.payments.data[0],
        id: 'inpay_multiple_b',
        amount_paid: 400,
        amount_requested: 400,
        payment: { type: 'payment_intent', payment_intent: 'pi_multiple_b' },
      },
    ];
    delete invoice.payment_intent;
    delete invoice.charge;

    await recordSubscriptionInvoicePayment({ invoice, eventId: 'evt_multiple_paid' });
    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_multiple_a',
        chargeId: 'ch_multiple_a',
        refunded: 500,
      }),
      eventId: 'evt_multiple_refund_high',
      eventType: 'charge.refunded',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_multiple_a',
        chargeId: 'ch_multiple_a',
        refunded: 200,
      }),
      eventId: 'evt_multiple_refund_stale',
      eventType: 'charge.refunded',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_multiple_a',
        chargeId: 'ch_multiple_a',
        refunded: 500,
        disputeId: 'dp_multiple_a',
        disputeAmount: 600,
        disputeStatus: 'lost',
      }),
      eventId: 'evt_multiple_dispute_lost',
      eventType: 'charge.dispute.closed',
    });

    const payment = await StripeEntitlementPayment.findOne({ invoiceId: invoice.id });
    const firstTrack = payment.chargeTracks.find(track => track.invoicePaymentId === 'inpay_multiple_a');
    const secondTrack = payment.chargeTracks.find(track => track.invoicePaymentId === 'inpay_multiple_b');
    expect(payment.capturedMinor).toBe(1000);
    expect(payment.refundedMinor).toBe(500);
    expect(firstTrack).toMatchObject({
      chargeId: 'ch_multiple_a',
      capturedMinor: 600,
      refundedMinor: 500,
    });
    expect(secondTrack).toMatchObject({ capturedMinor: 400, refundedMinor: 0 });
    expect(payment.disputes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        disputeId: 'dp_multiple_a',
        chargeId: 'ch_multiple_a',
        amountMinor: 600,
        state: 'lost',
      }),
    ]));
    expect(payment.effectiveGrantEnd.getTime() - start.getTime()).toBe(12 * DAY_MS);
  });

  test('counts one Charge dispute once when its PaymentIntent funds multiple Invoice Payment rows', async () => {
    const { subscription } = await setupSubscription('split-payment-intent');
    const start = stripePrecisionDate(Date.now() - DAY_MS);
    const end = new Date(start.getTime() + 30 * DAY_MS);
    const invoice = paidInvoice({
      id: 'in_split_payment_intent',
      subscriptionId: subscription.stripeSubscriptionId,
      customer: subscription.stripeCustomerId,
      amount: 1000,
      start,
      end,
    });
    invoice.payments.data = [
      {
        ...invoice.payments.data[0],
        id: 'inpay_split_a',
        amount_paid: 600,
        amount_requested: 600,
        payment: { type: 'payment_intent', payment_intent: 'pi_split' },
      },
      {
        ...invoice.payments.data[0],
        id: 'inpay_split_b',
        amount_paid: 400,
        amount_requested: 400,
        payment: { type: 'payment_intent', payment_intent: 'pi_split' },
      },
    ];
    delete invoice.payment_intent;
    delete invoice.charge;

    await recordSubscriptionInvoicePayment({ invoice, eventId: 'evt_split_paid' });
    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_split',
        chargeId: 'ch_split',
        refunded: 100,
      }),
      eventId: 'evt_split_refund',
      eventType: 'charge.refunded',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_split',
        chargeId: 'ch_split',
        refunded: 50,
      }),
      eventId: 'evt_split_stale_refund',
      eventType: 'charge.refunded',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_split',
        chargeId: 'ch_split',
        disputeId: 'dp_split',
        disputeAmount: 300,
        disputeStatus: 'lost',
      }),
      eventId: 'evt_split_lost',
      eventType: 'charge.dispute.closed',
    });
    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_split',
        chargeId: 'ch_split',
        disputeId: 'dp_split',
        disputeAmount: 300,
        disputeStatus: 'under_review',
      }),
      eventId: 'evt_split_stale_open',
      eventType: 'charge.dispute.created',
    });

    let payment = await StripeEntitlementPayment.findOne({ invoiceId: invoice.id });
    expect(payment.refundedMinor).toBe(100);
    expect(payment.chargeTracks).toHaveLength(2);
    expect(payment.chargeTracks.every(track => track.chargeId === 'ch_split')).toBe(true);
    expect(payment.disputes).toEqual(expect.arrayContaining([
      expect.objectContaining({ disputeId: 'dp_split', amountMinor: 300, state: 'lost' }),
    ]));
    expect(payment.effectiveGrantEnd.getTime() - start.getTime()).toBe(18 * DAY_MS);

    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_split',
        chargeId: 'ch_split',
        disputeId: 'dp_split',
        disputeAmount: 300,
        disputeStatus: 'won',
      }),
      eventId: 'evt_split_won',
      eventType: 'charge.dispute.funds_reinstated',
    });
    payment = await StripeEntitlementPayment.findOne({ invoiceId: invoice.id });
    expect(payment.effectiveGrantEnd.getTime() - start.getTime()).toBe(27 * DAY_MS);
    expect(payment.effectiveGrantEnd.getTime()).toBeLessThanOrEqual(end.getTime());
  });

  test('backfills one legacy aggregate refund into a per-Charge track without decreasing it', async () => {
    const { subscription } = await setupSubscription('legacy-track-backfill');
    const start = stripePrecisionDate(Date.now() - DAY_MS);
    const end = new Date(start.getTime() + 30 * DAY_MS);
    const invoice = paidInvoice({
      id: 'in_legacy_track_backfill',
      subscriptionId: subscription.stripeSubscriptionId,
      customer: subscription.stripeCustomerId,
      paymentIntentId: 'pi_legacy_track_backfill',
      amount: 999,
      start,
      end,
    });
    await StripeEntitlementPayment.create({
      entitlementType: 'subscription',
      sourceKey: `subscription:${invoice.id}`,
      seller: subscription.seller,
      invoiceId: invoice.id,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      paymentIntentId: 'pi_legacy_track_backfill',
      capturedMinor: 999,
      refundedMinor: 200,
      currency: 'usd',
      grantStart: start,
      grantEnd: end,
      effectiveGrantEnd: new Date(start.getTime() + Number((BigInt(30 * DAY_MS) * 799n) / 999n)),
    });

    await recordSubscriptionInvoicePayment({ invoice, eventId: 'evt_legacy_track_richer' });
    await flagStripeEntitlementPaymentRisk({
      charge: riskCharge({
        paymentIntentId: 'pi_legacy_track_backfill',
        chargeId: 'ch_legacy_track_backfill',
        refunded: 100,
      }),
      eventId: 'evt_legacy_track_stale_refund',
      eventType: 'charge.refunded',
    });
    const payment = await StripeEntitlementPayment.findOne({ invoiceId: invoice.id });
    expect(payment.refundedMinor).toBe(200);
    expect(payment.chargeTracks).toHaveLength(1);
    expect(payment.chargeTracks[0]).toMatchObject({
      paymentIntentId: 'pi_legacy_track_backfill',
      chargeId: 'ch_legacy_track_backfill',
      capturedMinor: 999,
      refundedMinor: 200,
    });
  });

  test('rejects a duplicate invoice delivery whose immutable Invoice Payment identity changed', async () => {
    const { subscription } = await setupSubscription('immutable-payment-association');
    const start = stripePrecisionDate(Date.now() - DAY_MS);
    const invoice = paidInvoice({
      id: 'in_immutable_payment_association',
      subscriptionId: subscription.stripeSubscriptionId,
      customer: subscription.stripeCustomerId,
      amount: 999,
      start,
      end: new Date(start.getTime() + 30 * DAY_MS),
    });
    await recordSubscriptionInvoicePayment({ invoice, eventId: 'evt_immutable_original' });

    const conflicting = {
      ...invoice,
      payments: {
        ...invoice.payments,
        data: invoice.payments.data.map(row => ({
          ...row,
          id: 'inpay_immutable_replacement',
        })),
      },
    };
    await expect(recordSubscriptionInvoicePayment({
      invoice: conflicting,
      eventId: 'evt_immutable_conflict',
    })).rejects.toMatchObject({ code: 'STRIPE_INVOICE_PAYMENT_ASSOCIATION_INVALID' });

    const conflictingPrice = {
      ...invoice,
      lines: {
        ...invoice.lines,
        data: invoice.lines.data.map(line => ({
          ...line,
          pricing: {
            ...line.pricing,
            price_details: {
              ...line.pricing.price_details,
              price: 'price_immutable_replacement',
            },
          },
        })),
      },
    };
    await expect(recordSubscriptionInvoicePayment({
      invoice: conflictingPrice,
      eventId: 'evt_immutable_price_conflict',
    })).rejects.toMatchObject({ code: 'STRIPE_SUBSCRIPTION_PRICE_SNAPSHOT_CHANGED' });

    const payment = await StripeEntitlementPayment.findOne({ invoiceId: invoice.id });
    expect(payment.chargeTracks).toHaveLength(1);
    expect(payment.chargeTracks[0].invoicePaymentId).toBe(`inpay_${invoice.id}`);
    expect(payment.capturedMinor).toBe(999);
  });

  test.each([
    ['unsettled', invoice => { invoice.status = 'open'; }, 'STRIPE_SUBSCRIPTION_INVOICE_NOT_SETTLED'],
    ['wrong customer', invoice => { invoice.customer = 'cus_other'; }, 'STRIPE_SUBSCRIPTION_INVOICE_OWNERSHIP_MISMATCH'],
    ['manual billing', invoice => { invoice.billing_reason = 'manual'; }, 'STRIPE_SUBSCRIPTION_BILLING_REASON_INVALID'],
    ['unapproved price', invoice => {
      invoice.lines.data[0].pricing.unit_amount_decimal = '777';
    }, 'STRIPE_SUBSCRIPTION_PRICE_INVALID'],
    ['boolean line amount', invoice => {
      invoice.lines.data[0].amount = true;
    }, 'STRIPE_SUBSCRIPTION_PRICE_INVALID'],
    ['overlong monthly period', invoice => {
      invoice.lines.data[0].period.end = invoice.lines.data[0].period.start + (33 * 24 * 60 * 60);
    }, 'STRIPE_SUBSCRIPTION_PERIOD_INVALID'],
  ])('fails closed for a %s invoice', async (suffix, mutate, code) => {
    const { subscription } = await setupSubscription(`invalid-${suffix.replace(/\s/g, '-')}`);
    const start = stripePrecisionDate(Date.now() - DAY_MS);
    const invoice = paidInvoice({
      id: `in_invalid_${suffix.replace(/\s/g, '_')}`,
      subscriptionId: subscription.stripeSubscriptionId,
      customer: subscription.stripeCustomerId,
      amount: 999,
      start,
      end: new Date(start.getTime() + 30 * DAY_MS),
    });
    mutate(invoice);
    await expect(recordSubscriptionInvoicePayment({ invoice, eventId: `evt_invalid_${suffix}` }))
      .rejects.toMatchObject({ code });
    await expect(StripeEntitlementPayment.countDocuments({ invoiceId: invoice.id })).resolves.toBe(0);
  });

  test('accepts a validated positive plan proration with a linked historical-price credit', async () => {
    const { subscription } = await setupSubscription('valid-proration-credit');
    subscription.stripePriceId = 'price_starter_current';
    await subscription.save();
    const start = stripePrecisionDate(Date.now() - DAY_MS);
    const end = new Date(start.getTime() + 30 * DAY_MS);
    const invoice = paidInvoice({
      id: 'in_valid_proration_credit',
      subscriptionId: subscription.stripeSubscriptionId,
      customer: subscription.stripeCustomerId,
      amount: 400,
      start,
      end,
      billingReason: 'subscription_update',
      linePeriods: [
        { start, end, amount: 500, proration: true, unitAmountMinor: 999, priceId: 'price_starter_current' },
        { start, end, amount: -100, proration: true, unitAmountMinor: 1299, priceId: 'price_elite_credit' },
      ],
    });
    const authoritativeLines = invoice.lines.data;
    invoice.lines = {
      ...invoice.lines,
      data: [authoritativeLines[0]],
      has_more: true,
    };
    stripe.invoices.listLineItems.mockResolvedValueOnce({
      data: authoritativeLines,
      has_more: false,
    });
    const result = await recordSubscriptionInvoicePayment({ invoice, eventId: 'evt_valid_proration_credit' });
    expect(result).toMatchObject({ handled: true, created: true });
    expect(stripe.invoices.listLineItems).toHaveBeenCalledWith(invoice.id, { limit: 100 });
    const payment = await StripeEntitlementPayment.findOne({ invoiceId: invoice.id });
    expect(payment.priceIds).toEqual(expect.arrayContaining(['price_starter_current', 'price_elite_credit']));
    expect(payment.unitAmountMinorSnapshots).toEqual([999, 1299]);
  });

  test.each([
    ['subscription item', invoice => {
      invoice.lines.data[0].parent.subscription_item_details.subscription_item = 'si_other_item';
    }, 'STRIPE_SUBSCRIPTION_PRICE_INVALID'],
    ['Price', invoice => {
      invoice.lines.data[0].pricing.price_details.price = 'price_other_target';
    }, 'STRIPE_SUBSCRIPTION_PRICE_INVALID'],
    ['Product', invoice => {
      invoice.lines.data[0].pricing.price_details.product = 'prod_other_target';
    }, 'STRIPE_SUBSCRIPTION_PRICE_INVALID'],
    ['invoice', (invoice, attempt) => {
      attempt.stripeInvoiceId = 'in_other_plan_change';
    }, 'STRIPE_SUBSCRIPTION_PLAN_MISMATCH'],
  ])('rejects a pending plan-change invoice with the wrong durable %s', async (
    suffix,
    mutate,
    code,
  ) => {
    const { subscription } = await setupSubscription(`pending-binding-${suffix.replace(/\s/g, '-')}`);
    const start = stripePrecisionDate(Date.now() - 1000);
    const targetAmount = buildPlanPricing('elite').unitAmount;
    const invoiceId = `in_pending_binding_${suffix.replace(/\s/g, '_')}`;
    const itemId = `si_${subscription.stripeSubscriptionId}`;
    const priceId = `price_${subscription.stripeSubscriptionId}_${targetAmount}`;
    const attempt = {
      idempotencyToken: `token-${suffix}`,
      requestFingerprint: `fingerprint-${suffix}`,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      stripeSubscriptionItemId: itemId,
      stripeProductId: `prod_${subscription.stripeSubscriptionId}`,
      stripePriceId: priceId,
      stripeInvoiceId: invoiceId,
      targetPlan: 'elite',
      targetPlanName: 'Rozare Elite',
      targetIncludeMetaAds: false,
      targetUnitAmountMinor: targetAmount,
      state: 'pending_payment',
    };
    subscription.planChangeAttempt = attempt;
    await subscription.save();
    const invoice = paidInvoice({
      id: invoiceId,
      subscriptionId: subscription.stripeSubscriptionId,
      customer: subscription.stripeCustomerId,
      amount: 400,
      unitAmountMinor: targetAmount,
      start,
      end: new Date(start.getTime() + 30 * DAY_MS),
      billingReason: 'subscription_update',
    });
    invoice.parent = {
      subscription_details: {
        subscription: subscription.stripeSubscriptionId,
        metadata: {
          sellerId: subscription.seller.toString(),
          planChangeToken: attempt.idempotencyToken,
          plan: 'elite',
          includeMetaAds: 'false',
        },
      },
    };
    mutate(invoice, attempt);
    if (attempt.stripeInvoiceId !== invoiceId) {
      subscription.planChangeAttempt.stripeInvoiceId = attempt.stripeInvoiceId;
      await subscription.save();
    }

    await expect(recordSubscriptionInvoicePayment({ invoice, eventId: `evt_${invoiceId}` }))
      .rejects.toMatchObject({ code });
    expect(await StripeEntitlementPayment.countDocuments({ seller: subscription.seller })).toBe(0);
  });

  test('validates but does not ledger a zero-due invoice for one exact pending plan-change Price', async () => {
    const { subscription } = await setupSubscription('pending-zero-due');
    const start = stripePrecisionDate(Date.now() - 1000);
    const targetAmount = buildPlanPricing('elite').unitAmount;
    const invoiceId = 'in_pending_zero_due';
    const itemId = `si_${subscription.stripeSubscriptionId}`;
    const priceId = `price_${subscription.stripeSubscriptionId}_${targetAmount}`;
    subscription.planChangeAttempt = {
      idempotencyToken: 'token-pending-zero-due',
      requestFingerprint: 'fingerprint-pending-zero-due',
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      stripeSubscriptionItemId: itemId,
      stripeProductId: `prod_${subscription.stripeSubscriptionId}`,
      stripePriceId: priceId,
      stripeInvoiceId: invoiceId,
      targetPlan: 'elite',
      targetPlanName: 'Rozare Elite',
      targetIncludeMetaAds: false,
      targetUnitAmountMinor: targetAmount,
      state: 'pending_payment',
    };
    await subscription.save();
    const invoice = paidInvoice({
      id: invoiceId,
      subscriptionId: subscription.stripeSubscriptionId,
      customer: subscription.stripeCustomerId,
      amount: 0,
      unitAmountMinor: targetAmount,
      start,
      end: new Date(start.getTime() + 30 * DAY_MS),
      billingReason: 'subscription_update',
    });
    invoice.parent = {
      subscription_details: {
        subscription: subscription.stripeSubscriptionId,
        metadata: {
          sellerId: subscription.seller.toString(),
          planChangeToken: subscription.planChangeAttempt.idempotencyToken,
          plan: 'elite',
          includeMetaAds: 'false',
        },
      },
    };

    const result = await recordSubscriptionInvoicePayment({
      invoice,
      eventId: 'evt_pending_zero_due',
    });
    expect(result).toMatchObject({
      handled: true,
      zeroAmount: true,
      planChangeAuthorized: true,
    });
    expect(await StripeEntitlementPayment.countDocuments({ seller: subscription.seller })).toBe(0);
    expect((await SellerSubscription.findById(subscription._id)).status).toBe('past_due');
  });
});
