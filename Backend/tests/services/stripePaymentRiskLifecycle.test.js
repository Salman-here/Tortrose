'use strict';

const mockGetExchangeRateSnapshot = jest.fn();

jest.mock('../../services/currencyService', () => {
  const actual = jest.requireActual('../../services/currencyService');
  return {
    ...actual,
    getExchangeRateSnapshot: mockGetExchangeRateSnapshot,
  };
});

jest.mock('../../config/stripe', () => ({
  stripe: null,
  STRIPE_MODE: 'test',
}));

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const NotificationOutbox = require('../../models/NotificationOutbox');
const Order = require('../../models/Order');
const ReturnRequest = require('../../models/ReturnRequest');
const SellerBalanceTransaction = require('../../models/SellerBalanceTransaction');
const SellerPaymentRiskHold = require('../../models/SellerPaymentRiskHold');
const SellerSettlementLock = require('../../models/SellerSettlementLock');
const StripePaymentRiskEvent = require('../../models/StripePaymentRiskEvent');
const StripePaymentRiskReview = require('../../models/StripePaymentRiskReview');
const StripePaymentRiskState = require('../../models/StripePaymentRiskState');
const User = require('../../models/User');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const { buildSellerPaymentSummary } = require('../../controllers/PaymentController');
const {
  flagStripePaymentRisk,
  recordFailedStripePaymentRiskReview,
} = require('../../services/stripePaymentRiskService');
const {
  persistStripeOrderRiskEvent,
  persistStripeSourceDisputeEvent,
  reconcileStripeSourceRefundEvidence,
} = require('../../services/stripePaymentRiskNotificationService');
const {
  createSellerPaymentRiskHolds,
  resolveSellerPaymentRiskHolds,
} = require('../../services/sellerPaymentRiskHoldService');
const {
  creditWalletInSession,
  getWalletSummary,
  reconcileWalletPaymentLiability,
  runInTransaction,
} = require('../../services/walletService');

let replSet;

const trustedRates = {
  base: 'USD',
  rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
  capturedAt: new Date('2026-08-22T00:00:00.000Z'),
  source: 'risk-test',
  fallback: false,
};

const shippingInfo = {
  fullName: 'Risk Buyer',
  email: 'risk-buyer@example.com',
  phone: '+923001234567',
  address: '1 Risk Street',
  city: 'Lahore',
  state: 'Punjab',
  postalCode: '54000',
  country: 'Pakistan',
};

const createPaidOrder = async ({
  sellerAmounts = [[new mongoose.Types.ObjectId(), 100]],
  buyer = new mongoose.Types.ObjectId(),
  currency = 'USD',
  paymentIntentId = `pi_order_${new mongoose.Types.ObjectId()}`,
  withSnapshot = true,
  rateSnapshot = trustedRates,
} = {}) => {
  const total = sellerAmounts.reduce(
    (sumMinor, [, amount]) => sumMinor + Math.round(amount * 100),
    0,
  ) / 100;
  const order = await Order.create({
    user: buyer,
    orderId: `ORD-RISK-${new mongoose.Types.ObjectId()}`,
    currency,
    ...(withSnapshot ? { exchangeRateSnapshot: rateSnapshot } : {}),
    orderItems: sellerAmounts.map(([seller, amount], index) => ({
      productId: new mongoose.Types.ObjectId(),
      seller,
      name: `Risk item ${index + 1}`,
      image: 'https://example.com/risk.jpg',
      price: amount,
      lineSubtotal: amount,
      quantity: 1,
    })),
    shippingInfo,
    shippingMethod: { name: 'standard', price: 0, estimatedDays: 5 },
    sellerFulfillment: sellerAmounts.map(([seller]) => ({
      seller,
      status: 'delivered',
      deliveredAt: new Date(),
    })),
    orderSummary: { subtotal: total, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: total },
    paymentMethod: 'stripe',
    paymentFlow: 'payment_sheet',
    paymentSetupState: 'complete',
    stripeMode: 'test',
    stripeCustomerId: 'cus_risk',
    stripePaymentIntentId: paymentIntentId,
    paymentResult: { paymentIntentId },
    awaitingPayment: false,
    inventoryCommitted: true,
    isPaid: true,
    paidAt: new Date(),
    orderStatus: 'delivered',
    isDelivered: true,
    deliveredAt: new Date(),
  });
  return { order, buyer, sellerIds: sellerAmounts.map(([seller]) => seller), total, paymentIntentId };
};

const charge = ({
  type,
  paymentIntentId,
  amount,
  amountRefunded = 0,
  currency = 'usd',
  chargeId = `ch_${paymentIntentId}`,
  disputeId = null,
  disputeAmount = 0,
  disputeStatus = '',
  refunds,
}) => ({
  id: chargeId,
  amount,
  amount_refunded: amountRefunded,
  currency,
  payment_intent: paymentIntentId,
  metadata: { type },
  disputeId,
  disputeAmount,
  disputeStatus,
  ...(refunds ? { refunds } : {}),
});

const applyRisk = (riskCharge, eventId, eventType) => flagStripePaymentRisk({
  charge: riskCharge,
  eventId,
  eventType,
});

const succeededRefund = ({
  id,
  amount,
  currency,
  chargeId,
  paymentIntentId,
  created,
  metadata = {},
}) => ({
  id,
  amount,
  currency,
  charge: chargeId,
  payment_intent: paymentIntentId,
  created,
  status: 'succeeded',
  metadata,
});

const completeRefundList = refunds => ({
  object: 'list',
  data: refunds,
  has_more: false,
});

const expectPendingSellerRiskHold = async ({ sourceType, paymentIntentId, seller }) => {
  expect(await SellerPaymentRiskHold.countDocuments({
    sourceType,
    paymentIntentId,
    seller,
    status: 'pending',
  })).toBe(1);
  expect(await SellerBalanceTransaction.countDocuments({
    stripePaymentIntentId: paymentIntentId,
  })).toBe(0);
};

const sellerLedgerMinor = async seller => {
  const rows = await SellerBalanceTransaction.find({
    seller,
    status: { $in: ['reserved', 'completed'] },
  }).lean();
  return rows.reduce((sum, row) => (
    sum + (row.direction === 'credit' ? -1 : 1) * Math.round(row.sourceAmount * 100)
  ), 0);
};

const sellerLedgerUsdMinor = async seller => {
  const rows = await SellerBalanceTransaction.find({
    seller,
    status: { $in: ['reserved', 'completed'] },
  }).lean();
  return rows.reduce((sum, row) => (
    sum + (row.direction === 'credit' ? -1 : 1) * Math.round(row.amountUSD * 100)
  ), 0);
};

const createWalletTopUp = async ({
  amount = 100,
  balance = amount,
  paymentIntentId,
  sellerAllocations = [],
} = {}) => {
  const user = new mongoose.Types.ObjectId();
  const wallet = await Wallet.create({ user, balances: { USD: balance }, status: 'active' });
  const amountMinor = Math.round(amount * 100);
  const balanceMinor = Math.round(balance * 100);
  const spentMinor = sellerAllocations.reduce(
    (sum, allocation) => sum + allocation.sourceAmountMinor,
    0,
  );
  const transaction = await WalletTransaction.create({
    user,
    wallet: wallet._id,
    type: 'top_up',
    direction: 'credit',
    status: 'completed',
    amount,
    currency: 'USD',
    balanceAfter: balance,
    description: 'Risk test top-up',
    referenceType: 'stripe_payment_intent',
    referenceId: paymentIntentId,
    idempotencyKey: `topup:${paymentIntentId}`,
    stripePaymentIntentId: paymentIntentId,
    stripeChargeId: `ch_${paymentIntentId}`,
    paymentSetupState: 'complete',
    ...(sellerAllocations.length ? {
      metadata: {
        availableCreditedMinor: amountMinor,
        fundingOriginalAvailableMinor: amountMinor,
        fundingRemainingMinor: balanceMinor,
      },
    } : {}),
    completedAt: new Date(),
  });
  if (sellerAllocations.length) {
    if (spentMinor + balanceMinor !== amountMinor) throw new Error('Wallet fixture does not conserve cents.');
    const orderId = new mongoose.Types.ObjectId();
    await WalletTransaction.create({
      user,
      wallet: wallet._id,
      type: 'order_payment',
      direction: 'debit',
      status: 'completed',
      amount: spentMinor / 100,
      currency: 'USD',
      balanceAfter: balance,
      description: 'Wallet-funded seller allocation',
      referenceType: 'order',
      referenceId: String(orderId),
      idempotencyKey: `wallet-funded-order:${orderId}`,
      metadata: {
        fundingProvenance: [{
          sourceType: 'wallet_top_up',
          sourceTransactionId: String(transaction._id),
          amountMinor: spentMinor,
          orderId: String(orderId),
          sellerAllocations,
        }],
      },
      completedAt: new Date(),
    });
  }
  return { user, wallet, transaction, paymentIntentId, sellerAllocations };
};

const createReturnSettlement = async ({
  seller = new mongoose.Types.ObjectId(),
  buyer = new mongoose.Types.ObjectId(),
  amount = 50,
  currency = 'USD',
  paymentIntentId = `pi_return_${new mongoose.Types.ObjectId()}`,
  withSnapshot = true,
} = {}) => {
  const { order } = await createPaidOrder({
    sellerAmounts: [[seller, amount]],
    buyer,
    currency,
    paymentIntentId: `pi_original_${paymentIntentId}`,
    withSnapshot,
  });
  const wallet = await Wallet.create({
    user: buyer,
    balances: { [currency]: amount },
    status: 'active',
  });
  const buyerCredit = await WalletTransaction.create({
    user: buyer,
    wallet: wallet._id,
    type: 'return_refund',
    direction: 'credit',
    status: 'completed',
    amount,
    currency,
    balanceAfter: amount,
    description: 'Completed return refund',
    referenceType: 'return_request',
    referenceId: `credit-${paymentIntentId}`,
    idempotencyKey: `credit-${paymentIntentId}`,
    completedAt: new Date(),
  });
  const line = order.orderItems[0];
  const request = await ReturnRequest.create({
    returnNumber: `RET-${new mongoose.Types.ObjectId()}`,
    order: order._id,
    orderId: order.orderId,
    buyer,
    seller,
    currency,
    items: [{
      orderItemId: line._id,
      productId: line.productId,
      name: line.name,
      image: line.image,
      quantity: 1,
      purchasedQuantity: 1,
      unitPrice: amount,
      lineSubtotal: amount,
    }],
    reasonCategory: 'defective',
    reasonDetails: 'The item was defective and was returned.',
    status: 'returned',
    statusHistory: [{ status: 'returned', actorRole: 'system' }],
    eligibilityDeadline: new Date(Date.now() + 86400000),
    policySnapshot: { returnsEnabled: true, returnDuration: 30, refundType: 'full_refund' },
    refund: { itemSubtotal: amount, taxAmount: 0, shippingAmount: 0, discountAmount: 0, totalAmount: amount },
    settlement: {
      fundingSource: 'card',
      status: 'completed',
      setupState: 'complete',
      stripePaymentIntentId: paymentIntentId,
      walletTransaction: buyerCredit._id,
      settledAt: new Date(),
    },
  });
  return { seller, buyer, order, wallet, buyerCredit, request, amount, currency, paymentIntentId };
};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());
  await Promise.all([
    SellerBalanceTransaction.syncIndexes(),
    SellerPaymentRiskHold.syncIndexes(),
    StripePaymentRiskEvent.syncIndexes(),
    StripePaymentRiskReview.syncIndexes(),
    StripePaymentRiskState.syncIndexes(),
    NotificationOutbox.syncIndexes(),
    Wallet.syncIndexes(),
    WalletTransaction.syncIndexes(),
  ]);
}, 120000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 120000);

beforeEach(async () => {
  jest.clearAllMocks();
  mockGetExchangeRateSnapshot.mockResolvedValue(trustedRates);
  await Promise.all([
    Order.deleteMany({}),
    ReturnRequest.deleteMany({}),
    SellerBalanceTransaction.deleteMany({}),
    SellerPaymentRiskHold.deleteMany({}),
    SellerSettlementLock.deleteMany({}),
    StripePaymentRiskEvent.deleteMany({}),
    StripePaymentRiskReview.deleteMany({}),
    StripePaymentRiskState.deleteMany({}),
    NotificationOutbox.deleteMany({}),
    User.deleteMany({}),
    Wallet.deleteMany({}),
    WalletTransaction.deleteMany({}),
  ]);
});

describe('seller payment-risk hold fences', () => {
  test('an older refund-30 resolver cannot clear a newer refund-80 hold and altered replays fail closed', async () => {
    const seller = new mongoose.Types.ObjectId();
    const sourceReferenceId = new mongoose.Types.ObjectId();
    const common = {
      sellerIds: [seller],
      sourceType: 'order_payment',
      sourceReferenceId,
      paymentIntentId: 'pi_hold_generation_fence',
      chargeId: 'ch_hold_generation_fence',
      eventType: 'charge.refunded',
      riskTrack: 'refund',
    };
    const older = await createSellerPaymentRiskHolds({
      ...common,
      eventId: 'evt_hold_refund_30',
      exposureMinor: 3000,
    });
    const exactReplay = await createSellerPaymentRiskHolds({
      ...common,
      eventId: 'evt_hold_refund_30',
      exposureMinor: 3000,
    });
    expect(String(exactReplay[0]._id)).toBe(String(older[0]._id));
    expect(exactReplay[0].exposureFingerprint).toBe(older[0].exposureFingerprint);

    await expect(createSellerPaymentRiskHolds({
      ...common,
      eventId: 'evt_hold_refund_30',
      exposureMinor: 3001,
    })).rejects.toMatchObject({ code: 'SELLER_PAYMENT_RISK_EVENT_MISMATCH' });

    const newer = await createSellerPaymentRiskHolds({
      ...common,
      eventId: 'evt_hold_refund_80',
      exposureMinor: 8000,
    });
    expect(newer[0].exposureGeneration).toBeGreaterThan(older[0].exposureGeneration);

    await expect(resolveSellerPaymentRiskHolds({
      holds: older,
      sourceType: common.sourceType,
      sourceReferenceId,
      paymentIntentId: common.paymentIntentId,
      chargeId: common.chargeId,
      riskTrack: 'refund',
      coveredExposureMinor: 3000,
      resolutionEventId: 'evt_hold_refund_30_applied',
    })).resolves.toBe(1);

    expect(await SellerPaymentRiskHold.findById(older[0]._id).lean()).toMatchObject({
      status: 'resolved',
      resolvedByEventId: 'evt_hold_refund_30_applied',
      resolvedExposureMinor: 3000,
    });
    expect(await SellerPaymentRiskHold.findById(newer[0]._id).lean()).toMatchObject({
      status: 'pending',
      exposureMinor: 8000,
    });
  });
});

describe('seller Stripe reversal accounting', () => {
  test('notifies each exact provider refund delta once in PKR and freezes buyer and seller money snapshots', async () => {
    const sellers = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    const fixture = await createPaidOrder({
      sellerAmounts: [[sellers[0], 200], [sellers[1], 1680]],
      currency: 'PKR',
      paymentIntentId: 'pi_order_exact_pkr_refunds',
    });
    const chargeId = 'ch_order_exact_pkr_refunds';
    const firstCreated = 1787356800;
    const secondCreated = 1787356860;
    const firstRefund = succeededRefund({
      id: 're_order_exact_pkr_first',
      amount: 30000,
      currency: 'pkr',
      chargeId,
      paymentIntentId: fixture.paymentIntentId,
      created: firstCreated,
      metadata: { type: 'manual_order_refund', mongoOrderId: String(fixture.order._id) },
    });
    const secondRefund = succeededRefund({
      id: 're_order_exact_pkr_second',
      amount: 20000,
      currency: 'pkr',
      chargeId,
      paymentIntentId: fixture.paymentIntentId,
      created: secondCreated,
      metadata: { type: 'manual_order_refund', mongoOrderId: String(fixture.order._id) },
    });

    const first = await flagStripePaymentRisk({
      charge: charge({
        type: 'order_payment',
        paymentIntentId: fixture.paymentIntentId,
        chargeId,
        amount: 188000,
        amountRefunded: 30000,
        currency: 'pkr',
        refunds: completeRefundList([firstRefund]),
      }),
      eventId: 'evt_order_exact_pkr_first',
      eventType: 'charge.refunded',
      eventCreatedAt: firstCreated,
    });
    expect(first.refundNotifications.notified).toBe(true);

    const second = await flagStripePaymentRisk({
      charge: charge({
        type: 'order_payment',
        paymentIntentId: fixture.paymentIntentId,
        chargeId,
        amount: 188000,
        amountRefunded: 50000,
        currency: 'pkr',
        refunds: completeRefundList([firstRefund, secondRefund]),
      }),
      eventId: 'evt_order_exact_pkr_second',
      eventType: 'charge.refunded',
      eventCreatedAt: secondCreated,
    });
    expect(second.refundNotifications.notified).toBe(true);

    const events = await StripePaymentRiskEvent.find({ order: fixture.order._id })
      .sort({ occurredAt: 1 })
      .lean();
    expect(events).toHaveLength(2);
    expect(events.map(event => ({
      currency: event.currency,
      refundExposureMinor: event.refundExposureMinor,
      refundDeltaMinor: event.refundDeltaMinor,
      refundIds: event.refunds.map(refund => refund.refundId),
      sellerSourceMinor: event.sellerImpacts.reduce((sum, impact) => sum + impact.sourceAmountMinor, 0),
    }))).toEqual([
      {
        currency: 'PKR',
        refundExposureMinor: 30000,
        refundDeltaMinor: 30000,
        refundIds: ['re_order_exact_pkr_first'],
        sellerSourceMinor: 30000,
      },
      {
        currency: 'PKR',
        refundExposureMinor: 50000,
        refundDeltaMinor: 20000,
        refundIds: ['re_order_exact_pkr_second'],
        sellerSourceMinor: 20000,
      },
    ]);

    const buyerRows = await NotificationOutbox.find({
      eventType: 'order.payment_refund_completed',
      'recipient.audienceRole': 'buyer',
    }).sort({ occurredAt: 1, channel: 1 }).select('+recipient.phone').lean();
    expect(buyerRows).toHaveLength(8);
    expect(new Set(buyerRows.slice(0, 4).map(row => row.money[0].amountMinor))).toEqual(new Set([30000]));
    expect(new Set(buyerRows.slice(4).map(row => row.money[0].amountMinor))).toEqual(new Set([20000]));
    expect(buyerRows.every(row => row.money[0].currency === 'PKR')).toBe(true);
    expect(buyerRows.find(row => row.channel === 'whatsapp').recipient.phone).toBe('923001234567');
    expect(buyerRows.some(row => row.payload.body.includes('Rs300.00 PKR'))).toBe(true);
    expect(buyerRows.some(row => row.payload.body.includes('Rs200.00 PKR'))).toBe(true);

    const sellerRows = await NotificationOutbox.find({
      eventType: 'order.payment_refund_completed',
      'recipient.audienceRole': 'seller',
    }).lean();
    expect(sellerRows).toHaveLength(16);
    expect(sellerRows.every(row => row.money[0].currency === 'PKR')).toBe(true);
    const sellerImpactByEvent = new Map();
    for (const row of sellerRows.filter(entry => entry.channel === 'inapp')) {
      const riskEventId = row.payload.data.riskEventId;
      sellerImpactByEvent.set(
        riskEventId,
        (sellerImpactByEvent.get(riskEventId) || 0) + row.money[0].amountMinor,
      );
    }
    expect([...sellerImpactByEvent.values()].sort((a, b) => a - b)).toEqual([20000, 30000]);

    await flagStripePaymentRisk({
      charge: charge({
        type: 'order_payment',
        paymentIntentId: fixture.paymentIntentId,
        chargeId,
        amount: 188000,
        amountRefunded: 50000,
        currency: 'pkr',
        refunds: completeRefundList([firstRefund, secondRefund]),
      }),
      eventId: 'evt_order_exact_pkr_second',
      eventType: 'charge.refunded',
      eventCreatedAt: secondCreated,
    });
    expect(await NotificationOutbox.countDocuments({
      eventType: 'order.payment_refund_completed',
    })).toBe(24);
  });

  test('quarantines an unprovable refund delta to durable active-admin review without buyer or seller outcome copy', async () => {
    const admin = await User.create({
      username: 'risk-review-admin',
      email: 'risk-review-admin@example.com',
      role: 'admin',
      status: 'active',
    });
    const fixture = await createPaidOrder({ paymentIntentId: 'pi_order_unprovable_refund' });
    const result = await flagStripePaymentRisk({
      charge: charge({
        type: 'order_payment',
        paymentIntentId: fixture.paymentIntentId,
        chargeId: 'ch_order_unprovable_refund',
        amount: 10000,
        amountRefunded: 2500,
        currency: 'usd',
      }),
      eventId: 'evt_order_unprovable_refund',
      eventType: 'charge.refunded',
      eventCreatedAt: 1787357000,
    });

    expect(result.refundNotifications).toMatchObject({ notified: false });
    const review = await StripePaymentRiskReview.findOne({
      stripeEventId: 'evt_order_unprovable_refund',
    }).lean();
    expect(review).toMatchObject({
      status: 'open',
      sourceType: 'order_payment',
      sourceReferenceId: String(fixture.order._id),
      reasonCode: 'STRIPE_REFUND_OBJECTS_MISSING',
      currency: 'USD',
      chargeAmountMinor: 10000,
      refundExposureMinor: 2500,
    });
    expect(await NotificationOutbox.countDocuments({
      eventType: 'payment.risk_review_required',
      'recipient.audienceRole': 'admin',
      'recipient.user': admin._id,
    })).toBe(4);
    expect(await NotificationOutbox.countDocuments({
      eventType: 'order.payment_refund_completed',
    })).toBe(0);
    const adminRows = await NotificationOutbox.find({
      eventType: 'payment.risk_review_required',
    }).lean();
    expect(adminRows.every(row => row.financial === false && row.money.length === 0)).toBe(true);
    expect(adminRows.every(row => /no customer or seller outcome notification was inferred/i.test(
      row.payload.body || row.payload.text || row.payload.message || '',
    ))).toBe(true);
  });

  test('failed-review recovery follows a durable order PaymentIntent even when legacy metadata is wrong', async () => {
    const admin = await User.create({
      username: 'risk-owner-review-admin',
      email: 'risk-owner-review-admin@example.com',
      role: 'admin',
      status: 'active',
    });
    const fixture = await createPaidOrder({ paymentIntentId: 'pi_order_review_wrong_metadata' });
    const riskCharge = charge({
      type: 'mistyped_external_label',
      paymentIntentId: fixture.paymentIntentId,
      chargeId: 'ch_order_review_wrong_metadata',
      amount: 10000,
      amountRefunded: 1000,
      currency: 'cad',
    });
    let failure;
    try {
      await flagStripePaymentRisk({
        charge: riskCharge,
        eventId: 'evt_order_review_wrong_metadata',
        eventType: 'charge.refunded',
        eventCreatedAt: 1787357050,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'STRIPE_PAYMENT_RISK_CURRENCY_INVALID' });

    await recordFailedStripePaymentRiskReview({
      charge: riskCharge,
      eventId: 'evt_order_review_wrong_metadata',
      eventType: 'charge.refunded',
      eventCreatedAt: 1787357050,
      error: failure,
    });
    const review = await StripePaymentRiskReview.findOne({
      stripeEventId: 'evt_order_review_wrong_metadata',
    }).lean();
    expect(review).toMatchObject({
      sourceType: 'order_payment',
      sourceReferenceId: String(fixture.order._id),
      reasonCode: 'STRIPE_PAYMENT_RISK_CURRENCY_INVALID',
      status: 'open',
    });
    expect(await NotificationOutbox.countDocuments({
      eventType: 'payment.risk_review_required',
      'recipient.user': admin._id,
    })).toBe(4);

    const unrelated = await recordFailedStripePaymentRiskReview({
      charge: charge({
        type: 'unrelated_integration',
        paymentIntentId: 'pi_not_owned_by_rozare',
        chargeId: 'ch_not_owned_by_rozare',
        amount: 10000,
        amountRefunded: 1000,
        currency: 'cad',
      }),
      eventId: 'evt_not_owned_by_rozare',
      eventType: 'charge.refunded',
      eventCreatedAt: 1787357060,
      error: failure,
    });
    expect(unrelated).toBeNull();
    expect(await StripePaymentRiskReview.countDocuments()).toBe(1);
  });

  test('an authoritative retry resolves its temporary admin review before queued delivery', async () => {
    const admin = await User.create({
      username: 'risk-retry-resolution-admin',
      email: 'risk-retry-resolution-admin@example.com',
      role: 'admin',
      status: 'active',
    });
    const fixture = await createPaidOrder({ paymentIntentId: 'pi_order_review_retry_resolution' });
    const eventId = 'evt_order_review_retry_resolution';
    const eventCreatedAt = 1787357065;
    const chargeId = 'ch_order_review_retry_resolution';
    const refund = succeededRefund({
      id: 're_order_review_retry_resolution',
      amount: 1000,
      currency: 'usd',
      chargeId,
      paymentIntentId: fixture.paymentIntentId,
      created: eventCreatedAt,
    });
    const riskCharge = charge({
      type: 'order_payment',
      paymentIntentId: fixture.paymentIntentId,
      chargeId,
      amount: 10000,
      amountRefunded: 1000,
      currency: 'usd',
      refunds: completeRefundList([refund]),
    });
    await recordFailedStripePaymentRiskReview({
      charge: riskCharge,
      eventId,
      eventType: 'charge.refunded',
      eventCreatedAt,
      error: Object.assign(new Error('Stripe Refund listing was temporarily unavailable.'), {
        code: 'STRIPE_REFUND_EVIDENCE_PROVIDER_UNAVAILABLE',
      }),
    });
    expect(await StripePaymentRiskReview.findOne({ stripeEventId: eventId }).lean())
      .toMatchObject({ status: 'open' });
    expect(await NotificationOutbox.countDocuments({
      eventType: 'payment.risk_review_required',
      'recipient.user': admin._id,
    })).toBe(4);

    const result = await flagStripePaymentRisk({
      charge: riskCharge,
      eventId,
      eventType: 'charge.refunded',
      eventCreatedAt,
    });
    expect(result).toMatchObject({ handled: true, refundNotifications: { notified: true } });
    expect(await StripePaymentRiskReview.findOne({ stripeEventId: eventId }).lean())
      .toMatchObject({
        status: 'resolved',
        resolvedAt: expect.any(Date),
        resolutionNote: expect.stringMatching(/authoritative evidence/i),
      });
    expect(await NotificationOutbox.countDocuments({
      eventType: 'order.payment_refund_completed',
    })).toBeGreaterThan(0);
  });

  test('quarantines a metadata-less PaymentIntent with two durable local owners before mutating either ledger', async () => {
    const admin = await User.create({
      username: 'risk-ambiguous-owner-admin',
      email: 'risk-ambiguous-owner-admin@example.com',
      role: 'admin',
      status: 'active',
    });
    const paymentIntentId = 'pi_ambiguous_order_wallet_owner';
    const orderFixture = await createPaidOrder({ paymentIntentId });
    const walletFixture = await createWalletTopUp({ amount: 100, paymentIntentId });
    const refund = succeededRefund({
      id: 're_ambiguous_order_wallet_owner',
      amount: 1000,
      currency: 'usd',
      chargeId: 'ch_ambiguous_order_wallet_owner',
      paymentIntentId,
      created: 1787357080,
    });
    const result = await flagStripePaymentRisk({
      charge: charge({
        type: '',
        paymentIntentId,
        chargeId: 'ch_ambiguous_order_wallet_owner',
        amount: 10000,
        amountRefunded: 1000,
        currency: 'usd',
        refunds: completeRefundList([refund]),
      }),
      eventId: 'evt_ambiguous_order_wallet_owner',
      eventType: 'charge.refunded',
      eventCreatedAt: 1787357080,
    });

    expect(result).toMatchObject({
      handled: true,
      sourceType: 'ambiguous_local_payment',
      manualReview: { reasonCode: 'STRIPE_PAYMENT_RISK_OWNER_AMBIGUOUS' },
    });
    expect(await StripePaymentRiskEvent.countDocuments()).toBe(0);
    expect(await SellerBalanceTransaction.countDocuments()).toBe(0);
    expect((await Wallet.findById(walletFixture.wallet._id).lean()).balances.USD).toBe(100);
    expect(await StripePaymentRiskReview.countDocuments({
      stripeEventId: 'evt_ambiguous_order_wallet_owner',
      sourceType: 'ambiguous_local_payment',
    })).toBe(1);
    expect(await NotificationOutbox.countDocuments({
      eventType: 'payment.risk_review_required',
      'recipient.user': admin._id,
    })).toBe(4);
    expect(await NotificationOutbox.countDocuments({
      eventType: 'order.payment_refund_completed',
    })).toBe(0);
    expect(await NotificationOutbox.countDocuments({
      eventType: 'wallet.payment_refund_completed',
    })).toBe(0);
    expect(orderFixture.order.isPaid).toBe(true);
  });

  test('quarantines domain-only metadata when one PaymentIntent matches two paid orders', async () => {
    const admin = await User.create({
      username: 'risk-duplicate-order-owner-admin',
      email: 'risk-duplicate-order-owner-admin@example.com',
      role: 'admin',
      status: 'active',
    });
    const paymentIntentId = 'pi_duplicate_order_owner';
    const first = await createPaidOrder({ paymentIntentId });
    const second = await createPaidOrder({ paymentIntentId: 'pi_duplicate_order_owner_secondary' });
    // Reproduce a legacy/corrupt dual-reference collision that bypasses the
    // current top-level PaymentIntent uniqueness index.
    await Order.collection.updateOne(
      { _id: second.order._id },
      { $set: { 'paymentResult.paymentIntentId': paymentIntentId } },
    );
    const refund = succeededRefund({
      id: 're_duplicate_order_owner',
      amount: 1000,
      currency: 'usd',
      chargeId: 'ch_duplicate_order_owner',
      paymentIntentId,
      created: 1787357085,
    });

    const result = await flagStripePaymentRisk({
      charge: charge({
        type: 'order_payment',
        paymentIntentId,
        chargeId: 'ch_duplicate_order_owner',
        amount: 10000,
        amountRefunded: 1000,
        currency: 'usd',
        refunds: completeRefundList([refund]),
      }),
      eventId: 'evt_duplicate_order_owner',
      eventType: 'charge.refunded',
      eventCreatedAt: 1787357085,
    });

    expect(result).toMatchObject({
      handled: true,
      sourceType: 'ambiguous_local_payment',
      manualReview: { reasonCode: 'STRIPE_PAYMENT_RISK_OWNER_AMBIGUOUS' },
    });
    expect(await Order.countDocuments({
      _id: { $in: [first.order._id, second.order._id] },
      isPaid: true,
    })).toBe(2);
    expect(await SellerBalanceTransaction.countDocuments()).toBe(0);
    expect(await StripePaymentRiskEvent.countDocuments()).toBe(0);
    expect(await StripePaymentRiskReview.countDocuments({
      stripeEventId: 'evt_duplicate_order_owner',
      sourceType: 'ambiguous_local_payment',
    })).toBe(1);
    expect(await NotificationOutbox.countDocuments({
      eventType: 'payment.risk_review_required',
      'recipient.user': admin._id,
    })).toBe(4);
  });

  test('quarantines a signed source reference that conflicts with the durable PaymentIntent owner', async () => {
    const admin = await User.create({
      username: 'risk-conflicting-owner-admin',
      email: 'risk-conflicting-owner-admin@example.com',
      role: 'admin',
      status: 'active',
    });
    const fixture = await createPaidOrder({ paymentIntentId: 'pi_conflicting_order_reference' });
    const refund = succeededRefund({
      id: 're_conflicting_order_reference',
      amount: 1000,
      currency: 'usd',
      chargeId: 'ch_conflicting_order_reference',
      paymentIntentId: fixture.paymentIntentId,
      created: 1787357090,
      metadata: { type: 'manual_order_refund', mongoOrderId: String(fixture.order._id) },
    });
    const riskCharge = charge({
      type: 'order_payment',
      paymentIntentId: fixture.paymentIntentId,
      chargeId: 'ch_conflicting_order_reference',
      amount: 10000,
      amountRefunded: 1000,
      currency: 'usd',
      refunds: completeRefundList([refund]),
    });
    riskCharge.metadata.mongoOrderId = String(new mongoose.Types.ObjectId());

    const result = await flagStripePaymentRisk({
      charge: riskCharge,
      eventId: 'evt_conflicting_order_reference',
      eventType: 'charge.refunded',
      eventCreatedAt: 1787357090,
    });
    expect(result).toMatchObject({
      handled: true,
      sourceType: 'conflicting_payment_metadata',
      manualReview: { reasonCode: 'STRIPE_PAYMENT_RISK_OWNER_MISMATCH' },
    });
    expect(await SellerBalanceTransaction.countDocuments()).toBe(0);
    expect(await StripePaymentRiskEvent.countDocuments()).toBe(0);
    expect(await NotificationOutbox.countDocuments({
      eventType: 'payment.risk_review_required',
      'recipient.user': admin._id,
    })).toBe(4);
  });

  test('explicit entitlement metadata cannot override an ordinary durable PaymentIntent owner', async () => {
    const admin = await User.create({
      username: 'risk-entitlement-owner-collision-admin',
      email: 'risk-entitlement-owner-collision-admin@example.com',
      role: 'admin',
      status: 'active',
    });
    const fixture = await createPaidOrder({
      paymentIntentId: 'pi_entitlement_metadata_order_collision',
    });
    const refund = succeededRefund({
      id: 're_entitlement_metadata_order_collision',
      amount: 1000,
      currency: 'usd',
      chargeId: 'ch_entitlement_metadata_order_collision',
      paymentIntentId: fixture.paymentIntentId,
      created: 1787357095,
    });
    const riskCharge = charge({
      type: 'subscription_invoice',
      paymentIntentId: fixture.paymentIntentId,
      chargeId: 'ch_entitlement_metadata_order_collision',
      amount: 10000,
      amountRefunded: 1000,
      currency: 'usd',
      refunds: completeRefundList([refund]),
    });
    riskCharge.metadata.invoiceId = 'in_entitlement_metadata_order_collision';

    const result = await flagStripePaymentRisk({
      charge: riskCharge,
      eventId: 'evt_entitlement_metadata_order_collision',
      eventType: 'charge.refunded',
      eventCreatedAt: 1787357095,
    });

    expect(result).toMatchObject({
      handled: true,
      sourceType: 'conflicting_payment_metadata',
      manualReview: { reasonCode: 'STRIPE_PAYMENT_RISK_OWNER_MISMATCH' },
    });
    expect((await Order.findById(fixture.order._id).lean()).isPaid).toBe(true);
    expect(await SellerBalanceTransaction.countDocuments()).toBe(0);
    expect(await StripePaymentRiskEvent.countDocuments()).toBe(0);
    expect(await StripePaymentRiskReview.countDocuments({
      stripeEventId: 'evt_entitlement_metadata_order_collision',
      sourceType: 'conflicting_payment_metadata',
    })).toBe(1);
    expect(await NotificationOutbox.countDocuments({
      eventType: 'payment.risk_review_required',
      'recipient.user': admin._id,
    })).toBe(4);
  });

  test('dispute opened, won, and lost notifications describe only exact seller-ledger state transitions', async () => {
    const sellers = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    const wonFixture = await createPaidOrder({
      sellerAmounts: [[sellers[0], 40], [sellers[1], 60]],
      paymentIntentId: 'pi_order_dispute_copy_won',
    });
    const disputed = charge({
      type: 'order_payment',
      paymentIntentId: wonFixture.paymentIntentId,
      chargeId: 'ch_order_dispute_copy_won',
      amount: 10000,
      currency: 'usd',
      disputeId: 'dp_order_dispute_copy_won',
      disputeAmount: 5000,
      disputeStatus: 'needs_response',
    });
    await flagStripePaymentRisk({
      charge: disputed,
      eventId: 'evt_order_dispute_copy_opened',
      eventType: 'charge.dispute.created',
      eventCreatedAt: 1787357100,
    });
    await flagStripePaymentRisk({
      charge: { ...disputed, disputeStatus: 'won' },
      eventId: 'evt_order_dispute_copy_won',
      eventType: 'charge.dispute.closed',
      eventCreatedAt: 1787357200,
    });

    const openedEvent = await StripePaymentRiskEvent.findOne({
      classification: 'order_dispute_opened',
      order: wonFixture.order._id,
    }).lean();
    const wonEvent = await StripePaymentRiskEvent.findOne({
      classification: 'order_dispute_won',
      order: wonFixture.order._id,
    }).lean();
    expect(openedEvent.sellerImpacts.reduce((sum, impact) => sum + impact.sourceAmountMinor, 0)).toBe(5000);
    expect(wonEvent.sellerImpacts.reduce((sum, impact) => sum + impact.sourceAmountMinor, 0)).toBe(5000);

    const openedRows = await NotificationOutbox.find({
      eventType: 'order.payment_dispute_opened',
      channel: 'inapp',
    }).lean();
    const wonRows = await NotificationOutbox.find({
      eventType: 'order.payment_dispute_won',
      channel: 'inapp',
    }).lean();
    expect(openedRows).toHaveLength(2);
    expect(openedRows.every(row => /No final outcome has been decided/.test(row.payload.body))).toBe(true);
    expect(openedRows.every(row => !/refund (?:was|has been) completed/i.test(row.payload.body))).toBe(true);
    expect(wonRows).toHaveLength(2);
    expect(wonRows.every(row => /does not record a new payment or refund/i.test(row.payload.body))).toBe(true);
    expect(await NotificationOutbox.countDocuments({
      eventType: { $in: ['order.payment_dispute_opened', 'order.payment_dispute_won'] },
      'recipient.audienceRole': 'buyer',
    })).toBe(0);

    const lostFixture = await createPaidOrder({ paymentIntentId: 'pi_order_dispute_copy_lost' });
    await flagStripePaymentRisk({
      charge: charge({
        type: 'order_payment',
        paymentIntentId: lostFixture.paymentIntentId,
        chargeId: 'ch_order_dispute_copy_lost',
        amount: 10000,
        currency: 'usd',
        disputeId: 'dp_order_dispute_copy_lost',
        disputeAmount: 10000,
        disputeStatus: 'lost',
      }),
      eventId: 'evt_order_dispute_copy_lost',
      eventType: 'charge.dispute.closed',
      eventCreatedAt: 1787357300,
    });
    const lostRow = await NotificationOutbox.findOne({
      eventType: 'order.payment_dispute_lost',
      channel: 'inapp',
    }).lean();
    expect(lostRow.payload.body).toMatch(/completed seller-ledger reversal/i);
    expect(lostRow.payload.body).toMatch(/not a new refund/i);
  });

  test('quarantines non-conserving refund and dispute recipient allocations instead of guessing outcomes', async () => {
    const admin = await User.create({
      username: 'risk-allocation-review-admin',
      email: 'risk-allocation-review-admin@example.com',
      role: 'admin',
      status: 'active',
    });
    const fixture = await createPaidOrder({ paymentIntentId: 'pi_order_bad_risk_allocation' });
    const refundPayload = {
      eventId: 'evt_order_bad_refund_allocation',
      eventType: 'charge.refunded',
      eventOccurredAt: new Date('2026-08-24T12:10:00.000Z'),
      paymentIntentId: fixture.paymentIntentId,
      chargeId: 'ch_order_bad_risk_allocation',
      currency: 'USD',
      chargeAmountMinor: 10000,
      refundExposureMinor: 5000,
      disputeExposureMinor: 0,
      refundEvidence: {
        complete: true,
        refunds: [{
          refundId: 're_order_bad_refund_allocation',
          amountMinor: 5000,
          currency: 'USD',
          createdAt: new Date('2026-08-24T12:09:00.000Z'),
          metadataType: 'manual_order_refund',
          metadataOrderId: String(fixture.order._id),
          metadataWalletTransactionId: '',
          metadataReturnRequestId: '',
        }],
      },
    };
    const refund = await runInTransaction(session => reconcileStripeSourceRefundEvidence({
      session,
      payload: refundPayload,
      sourceType: 'order_payment',
      sourceDocument: fixture.order,
      sourceCurrency: 'USD',
      classification: 'order_refund',
      eventKeyPrefix: `order:${fixture.order._id}`,
      refundDeltaMinor: 5000,
      sellerImpacts: [{
        sellerId: fixture.sellerIds[0],
        action: 'refund_debited',
        direction: 'debit',
        sourceAmountMinor: 4999,
        sourceCurrency: 'USD',
        amountUSDMinor: 4999,
      }],
    }));
    expect(refund).toMatchObject({
      notified: false,
      manualReview: { review: { reasonCode: 'STRIPE_REFUND_INTERNAL_ALLOCATION_MISMATCH' } },
    });

    const disputePayload = {
      ...refundPayload,
      eventId: 'evt_order_missing_dispute_allocation',
      eventType: 'charge.dispute.created',
      eventOccurredAt: new Date('2026-08-24T12:20:00.000Z'),
      refundExposureMinor: 0,
      disputeId: 'dp_order_missing_dispute_allocation',
      disputeStatus: 'needs_response',
      disputeExposureMinor: 5000,
      refundEvidence: undefined,
    };
    const dispute = await runInTransaction(session => persistStripeSourceDisputeEvent({
      session,
      payload: disputePayload,
      sourceType: 'order_payment',
      sourceDocument: fixture.order,
      sourceCurrency: 'USD',
      classification: 'order_dispute_opened',
      eventKeyPrefix: `order:${fixture.order._id}`,
      sellerImpacts: [],
    }));
    expect(dispute).toMatchObject({
      notified: false,
      manualReview: { review: { reasonCode: 'STRIPE_DISPUTE_INTERNAL_ALLOCATION_MISMATCH' } },
    });
    expect(await StripePaymentRiskEvent.countDocuments({ order: fixture.order._id })).toBe(0);
    expect(await StripePaymentRiskReview.countDocuments({
      sourceType: 'order_payment',
      sourceReferenceId: String(fixture.order._id),
    })).toBe(2);
    expect(await NotificationOutbox.countDocuments({
      eventType: 'payment.risk_review_required',
      'recipient.user': admin._id,
    })).toBe(8);
    expect(await NotificationOutbox.countDocuments({
      eventType: { $regex: '^order\\.payment_' },
    })).toBe(0);
  });

  test('immutable provider-risk event replay is transaction-safe and rejects altered evidence', async () => {
    const fixture = await createPaidOrder({ paymentIntentId: 'pi_order_risk_event_replay' });
    const payload = {
      eventKey: `order:${fixture.order._id}:refund:replay-proof`,
      stripeEventId: 'evt_order_risk_event_replay',
      stripeEventType: 'charge.refunded',
      occurredAt: new Date('2026-08-24T12:00:00.000Z'),
      classification: 'order_refund',
      order: fixture.order,
      paymentIntentId: fixture.paymentIntentId,
      chargeId: 'ch_order_risk_event_replay',
      currency: 'USD',
      chargeAmountMinor: 10000,
      refundExposureMinor: 1000,
      refundDeltaMinor: 1000,
      refunds: [{
        refundId: 're_order_risk_event_replay',
        amountMinor: 1000,
        currency: 'USD',
        createdAt: new Date('2026-08-24T12:00:00.000Z'),
      }],
      sellerImpacts: [{
        sellerId: fixture.sellerIds[0],
        action: 'refund_debited',
        sourceAmountMinor: 1000,
        sourceCurrency: 'USD',
        amountUSDMinor: 1000,
      }],
    };
    await runInTransaction(async session => {
      const first = await persistStripeOrderRiskEvent(payload, { session });
      const replay = await persistStripeOrderRiskEvent(payload, { session });
      expect(first.created).toBe(true);
      expect(replay.created).toBe(false);
      expect(String(replay.event._id)).toBe(String(first.event._id));
    });
    expect(await StripePaymentRiskEvent.countDocuments({ eventKey: payload.eventKey })).toBe(1);

    await expect(runInTransaction(session => persistStripeOrderRiskEvent({
      ...payload,
      refundExposureMinor: 1001,
    }, { session }))).rejects.toMatchObject({
      code: 'STRIPE_RISK_NOTIFICATION_IDEMPOTENCY_CONFLICT',
    });

    await expect(new StripePaymentRiskEvent({
      ...payload,
      sellerImpacts: [{
        ...payload.sellerImpacts[0],
        sourceAmountMinor: 999,
      }],
      contentHash: 'test',
    }).validate()).rejects.toThrow(/exactly conserve the provider refund delta/i);
  });

  test('clears a failed financial-dispute hold after a durable win and again after a delayed retry', async () => {
    const fixture = await createPaidOrder({ paymentIntentId: 'pi_order_failed_then_won' });
    const disputed = charge({
      type: 'order_payment',
      paymentIntentId: fixture.paymentIntentId,
      amount: 10000,
      chargeId: 'ch_order_failed_then_won',
      disputeId: 'dp_order_failed_then_won',
      disputeAmount: 10000,
      disputeStatus: 'needs_response',
    });
    const createSpy = jest.spyOn(SellerBalanceTransaction, 'create')
      .mockRejectedValueOnce(new Error('simulated seller-ledger write failure'));
    try {
      await expect(applyRisk(
        disputed,
        'evt_order_financial_failed',
        'charge.dispute.funds_withdrawn',
      )).rejects.toThrow('simulated seller-ledger write failure');
    } finally {
      createSpy.mockRestore();
    }

    expect(await StripePaymentRiskState.countDocuments({ disputeId: disputed.disputeId })).toBe(0);
    expect(await SellerPaymentRiskHold.countDocuments({
      seller: fixture.sellerIds[0],
      disputeId: disputed.disputeId,
      status: 'pending',
    })).toBe(1);

    await applyRisk(
      { ...disputed, disputeStatus: 'won' },
      'evt_order_won_after_failure',
      'charge.dispute.closed',
    );
    expect(await StripePaymentRiskState.findOne({ disputeId: disputed.disputeId }).lean())
      .toMatchObject({ terminal: true, status: 'won' });
    expect(await SellerPaymentRiskHold.countDocuments({
      seller: fixture.sellerIds[0],
      disputeId: disputed.disputeId,
      status: 'pending',
    })).toBe(0);

    await applyRisk(
      disputed,
      'evt_order_delayed_financial_after_won',
      'charge.dispute.funds_withdrawn',
    );
    expect(await SellerPaymentRiskHold.countDocuments({
      seller: fixture.sellerIds[0],
      disputeId: disputed.disputeId,
      status: 'pending',
    })).toBe(0);
    expect(await SellerPaymentRiskHold.countDocuments({
      seller: fixture.sellerIds[0],
      disputeId: disputed.disputeId,
      status: 'resolved',
    })).toBe(2);
    expect(await SellerBalanceTransaction.countDocuments({ seller: fixture.sellerIds[0] })).toBe(0);
  });

  test.each([
    ['unsupported', 'cad'],
    ['blank', ''],
    ['whitespace-padded', ' usd '],
  ])('rejects %s Stripe event currency and retains the order seller hold', async (_label, eventCurrency) => {
    const fixture = await createPaidOrder({ paymentIntentId: `pi_order_event_currency_${_label}` });
    await expect(applyRisk(charge({
      type: 'order_payment',
      paymentIntentId: fixture.paymentIntentId,
      amount: 10000,
      amountRefunded: 10000,
      currency: eventCurrency,
      chargeId: `ch_order_event_currency_${_label}`,
    }), `evt_order_event_currency_${_label}`, 'charge.refunded')).rejects.toMatchObject({
      code: 'STRIPE_PAYMENT_RISK_CURRENCY_INVALID',
    });
    await expectPendingSellerRiskHold({
      sourceType: 'order_payment',
      paymentIntentId: fixture.paymentIntentId,
      seller: fixture.sellerIds[0],
    });
  });

  test.each([
    ['boolean charge amount', true, 10000],
    ['blank charge amount', '', 10000],
    ['whitespace charge amount', ' 10000 ', 10000],
    ['boolean refund amount', 10000, true],
    ['blank refund amount', 10000, ''],
    ['whitespace refund amount', 10000, ' 10000 '],
  ])('rejects a %s without coercing Stripe money', async (_label, amount, amountRefunded) => {
    const fixture = await createPaidOrder({ paymentIntentId: `pi_order_event_amount_${_label.replaceAll(' ', '_')}` });
    await expect(applyRisk(charge({
      type: 'order_payment',
      paymentIntentId: fixture.paymentIntentId,
      amount,
      amountRefunded,
      chargeId: `ch_order_event_amount_${_label.replaceAll(' ', '_')}`,
    }), `evt_order_event_amount_${_label.replaceAll(' ', '_')}`, 'charge.refunded')).rejects.toMatchObject({
      code: 'STRIPE_PAYMENT_RISK_AMOUNT_INVALID',
    });
    expect(await SellerPaymentRiskHold.countDocuments({
      paymentIntentId: fixture.paymentIntentId,
    })).toBe(0);
    expect(await SellerBalanceTransaction.countDocuments({
      stripePaymentIntentId: fixture.paymentIntentId,
    })).toBe(0);
  });

  test.each([
    ['unsupported', 'CAD'],
    ['lowercase', 'usd'],
    ['blank', ''],
  ])('rejects %s stored order currency and retains the seller hold', async (_label, storedCurrency) => {
    const fixture = await createPaidOrder({ paymentIntentId: `pi_order_stored_currency_${_label}` });
    await Order.collection.updateOne(
      { _id: fixture.order._id },
      { $set: { currency: storedCurrency } },
    );
    await expect(applyRisk(charge({
      type: 'order_payment',
      paymentIntentId: fixture.paymentIntentId,
      amount: 10000,
      amountRefunded: 10000,
      chargeId: `ch_order_stored_currency_${_label}`,
    }), `evt_order_stored_currency_${_label}`, 'charge.refunded')).rejects.toMatchObject({
      code: 'ORDER_CURRENCY_INVALID',
    });
    await expectPendingSellerRiskHold({
      sourceType: 'order_payment',
      paymentIntentId: fixture.paymentIntentId,
      seller: fixture.sellerIds[0],
    });
  });

  test.each([
    ['boolean', true, 'ORDER_MONEY_INVALID'],
    ['blank', '', 'ORDER_MONEY_INVALID'],
    ['NaN', Number.NaN, 'ORDER_MONEY_INVALID'],
    ['infinite', Number.POSITIVE_INFINITY, 'ORDER_MONEY_INVALID'],
    ['sub-cent', 1.001, 'ORDER_MONEY_INVALID'],
    ['component-mismatched', 2, 'ORDER_TOTAL_MISMATCH'],
  ])('rejects a %s stored order total and retains the seller hold', async (_label, storedTotal, code) => {
    const seller = new mongoose.Types.ObjectId();
    const fixture = await createPaidOrder({
      sellerAmounts: [[seller, 1]],
      paymentIntentId: `pi_order_stored_total_${_label}`,
    });
    await Order.collection.updateOne(
      { _id: fixture.order._id },
      { $set: { 'orderSummary.totalAmount': storedTotal } },
    );
    await expect(applyRisk(charge({
      type: 'order_payment',
      paymentIntentId: fixture.paymentIntentId,
      amount: 100,
      amountRefunded: 100,
      chargeId: `ch_order_stored_total_${_label}`,
    }), `evt_order_stored_total_${_label}`, 'charge.refunded')).rejects.toMatchObject({ code });
    await expectPendingSellerRiskHold({
      sourceType: 'order_payment',
      paymentIntentId: fixture.paymentIntentId,
      seller,
    });
  });

  test('books cumulative refunds and distinct dispute exposure without global under-cap, then won converges under retries', async () => {
    const fixture = await createPaidOrder({ paymentIntentId: 'pi_order_combined' });
    const base = {
      type: 'order_payment',
      paymentIntentId: fixture.paymentIntentId,
      amount: 10000,
      chargeId: 'ch_order_combined',
    };

    await applyRisk(charge({ ...base, amountRefunded: 3000 }), 'evt_refund_30', 'charge.refunded');
    await applyRisk(charge({ ...base, amountRefunded: 3000 }), 'evt_refund_30', 'charge.refunded');
    expect(await sellerLedgerMinor(fixture.sellerIds[0])).toBe(3000);

    const dispute = charge({
      ...base,
      amountRefunded: 3000,
      disputeId: 'dp_full',
      disputeAmount: 10000,
      disputeStatus: 'needs_response',
    });
    await applyRisk(dispute, 'evt_dispute_full', 'charge.dispute.funds_withdrawn');
    await applyRisk(dispute, 'evt_dispute_full', 'charge.dispute.funds_withdrawn');
    expect(await sellerLedgerMinor(fixture.sellerIds[0])).toBe(13000);
    expect(await SellerBalanceTransaction.countDocuments({ seller: fixture.sellerIds[0] })).toBe(2);

    const exposedSummary = await buildSellerPaymentSummary(fixture.sellerIds[0], {
      displayCurrency: 'USD',
      rateSnapshot: trustedRates,
    });
    expect(exposedSummary.revenue).toMatchObject({
      onlineDeliveredRevenue: 100,
      paymentReversalDebits: 130,
      withdrawableBalance: 0,
    });

    const won = charge({
      ...base,
      amountRefunded: 3000,
      disputeId: 'dp_full',
      disputeAmount: 10000,
      disputeStatus: 'won',
    });
    await applyRisk(won, 'evt_dispute_won', 'charge.dispute.closed');
    await applyRisk(won, 'evt_dispute_won_retry', 'charge.dispute.closed');
    expect(await sellerLedgerMinor(fixture.sellerIds[0])).toBe(3000);

    await applyRisk(dispute, 'evt_dispute_delayed', 'charge.dispute.funds_withdrawn');
    expect(await sellerLedgerMinor(fixture.sellerIds[0])).toBe(3000);
    expect(await StripePaymentRiskState.findOne({ disputeId: 'dp_full' }).lean()).toMatchObject({
      terminal: true,
      status: 'won',
    });
  });

  test('keeps staged seller allocations monotonic, path-independent, capped, and exact at full reversal', async () => {
    const sellers = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    const fixture = await createPaidOrder({
      sellerAmounts: [[sellers[0], 1], [sellers[1], 3], [sellers[2], 3]],
      paymentIntentId: 'pi_alabama',
    });
    const base = {
      type: 'order_payment',
      paymentIntentId: fixture.paymentIntentId,
      amount: 700,
      chargeId: 'ch_alabama',
    };
    await applyRisk(charge({ ...base, amountRefunded: 52 }), 'evt_alabama_52', 'charge.refunded');
    const at52 = await Promise.all(sellers.map(sellerLedgerMinor));
    expect(at52).toEqual([7, 23, 22]);

    await applyRisk(charge({ ...base, amountRefunded: 53 }), 'evt_alabama_53', 'charge.refunded');
    const staged53 = await Promise.all(sellers.map(sellerLedgerMinor));
    expect(staged53.reduce((sum, value) => sum + value, 0)).toBe(53);
    expect(staged53.every((value, index) => value >= at52[index])).toBe(true);
    expect(staged53).toEqual([7, 23, 23]);

    const direct = await createPaidOrder({
      // Reverse the order lines to prove canonical seller-id ordering, not
      // request/item order, controls deterministic tie breaks.
      sellerAmounts: [[sellers[2], 3], [sellers[0], 1], [sellers[1], 3]],
      paymentIntentId: 'pi_alabama_direct',
    });
    await applyRisk(charge({
      type: 'order_payment',
      paymentIntentId: direct.paymentIntentId,
      amount: 700,
      amountRefunded: 53,
      chargeId: 'ch_alabama_direct',
    }), 'evt_alabama_direct_53', 'charge.refunded');
    const direct53 = await Promise.all(sellers.map(async seller => {
      const rows = await SellerBalanceTransaction.find({
        seller,
        order: direct.order._id,
        status: { $in: ['reserved', 'completed'] },
      }).lean();
      return rows.reduce((sum, row) => sum + Math.round(row.sourceAmount * 100), 0);
    }));
    expect(direct53).toEqual(staged53);

    await applyRisk(charge({ ...base, amountRefunded: 700 }), 'evt_alabama_full', 'charge.refunded');
    const fullSource = await Promise.all(sellers.map(async seller => {
      const rows = await SellerBalanceTransaction.find({ seller, order: fixture.order._id }).lean();
      return rows.reduce((sum, row) => sum + Math.round(row.sourceAmount * 100), 0);
    }));
    const fullUsd = await Promise.all(sellers.map(async seller => {
      const rows = await SellerBalanceTransaction.find({ seller, order: fixture.order._id }).lean();
      return rows.reduce((sum, row) => sum + Math.round(row.amountUSD * 100), 0);
    }));
    expect(fullSource).toEqual([100, 300, 300]);
    expect(fullUsd).toEqual([100, 300, 300]);
    const rowCount = await SellerBalanceTransaction.countDocuments({ order: fixture.order._id });
    await applyRisk(charge({ ...base, amountRefunded: 700 }), 'evt_alabama_full', 'charge.refunded');
    expect(await SellerBalanceTransaction.countDocuments({ order: fixture.order._id })).toBe(rowCount);
    expect(await SellerBalanceTransaction.countDocuments({
      order: fixture.order._id,
      direction: 'credit',
    })).toBe(0);
  });

  test.each([
    ['over-rounding inputs', [72.86, 72.86]],
    ['under-rounding inputs', [71.37, 72.36]],
  ])('full PKR reversal cancels the globally frozen seller USD cents for %s', async (_label, amounts) => {
    const sellers = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    const rateSnapshot = {
      ...trustedRates,
      rates: { ...trustedRates.rates, PKR: 284.6 },
    };
    const fixture = await createPaidOrder({
      sellerAmounts: [[sellers[0], amounts[0]], [sellers[1], amounts[1]]],
      currency: 'PKR',
      paymentIntentId: `pi_pkr_conservation_${amounts[0]}`,
      rateSnapshot,
    });
    const chargeMinor = Math.round(fixture.total * 100);
    await applyRisk(charge({
      type: 'order_payment',
      paymentIntentId: fixture.paymentIntentId,
      amount: chargeMinor,
      amountRefunded: chargeMinor,
      currency: 'pkr',
      chargeId: `ch_${fixture.paymentIntentId}`,
    }), `evt_${fixture.paymentIntentId}`, 'charge.refunded');

    const persisted = await Order.findById(fixture.order._id).lean();
    const creditedUsd = persisted.sellerSettlement.reduce(
      (sum, entry) => sum + entry.amountUSDMinor,
      0,
    );
    const debitedUsd = (await Promise.all(sellers.map(sellerLedgerUsdMinor)))
      .reduce((sum, amount) => sum + amount, 0);
    expect(creditedUsd).toBe(51);
    expect(debitedUsd).toBe(creditedUsd);
    for (const seller of sellers) {
      const entry = persisted.sellerSettlement.find(row => String(row.seller) === String(seller));
      expect(await sellerLedgerUsdMinor(seller)).toBe(entry.amountUSDMinor);
      const summary = await buildSellerPaymentSummary(seller, {
        displayCurrency: 'USD',
        rateSnapshot,
      });
      expect(Math.round(summary.revenue.onlineDeliveredRevenue * 100)).toBe(entry.amountUSDMinor);
      expect(Math.round(summary.revenue.paymentReversalDebits * 100)).toBe(entry.amountUSDMinor);
      expect(summary.revenue.withdrawableBalance).toBe(0);
    }
  });

  test('keeps refund allocation independent when a prior dispute is later won', async () => {
    const sellers = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    const fixture = await createPaidOrder({
      sellerAmounts: [[sellers[0], 1], [sellers[1], 3], [sellers[2], 3]],
      paymentIntentId: 'pi_track_independence',
    });
    const base = {
      type: 'order_payment',
      paymentIntentId: fixture.paymentIntentId,
      amount: 700,
      chargeId: 'ch_track_independence',
      disputeId: 'dp_track_independence',
      disputeAmount: 52,
      disputeStatus: 'needs_response',
    };
    await applyRisk(charge(base), 'evt_track_dispute_52', 'charge.dispute.funds_withdrawn');
    await applyRisk(charge({ ...base, amountRefunded: 1 }), 'evt_track_refund_1', 'charge.refunded');
    expect((await Promise.all(sellers.map(sellerLedgerMinor))).reduce((sum, value) => sum + value, 0)).toBe(53);

    await applyRisk(charge({
      ...base,
      amountRefunded: 1,
      disputeStatus: 'won',
    }), 'evt_track_won', 'charge.dispute.closed');
    const remaining = await Promise.all(sellers.map(sellerLedgerMinor));
    expect(remaining.reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(remaining).toEqual([0, 1, 0]);
    expect(await SellerBalanceTransaction.countDocuments({
      status: { $in: ['reserved', 'completed'] },
      'metadata.riskTrack': 'dispute',
      'metadata.disputeId': 'dp_track_independence',
    })).toBe(0);
  });

  test('materializes lost-first liability as completed and ignores delayed financial events', async () => {
    const fixture = await createPaidOrder({ paymentIntentId: 'pi_lost_first' });
    const lost = charge({
      type: 'order_payment',
      paymentIntentId: fixture.paymentIntentId,
      amount: 10000,
      chargeId: 'ch_lost_first',
      disputeId: 'dp_lost_first',
      disputeAmount: 10000,
      disputeStatus: 'lost',
    });
    await applyRisk(lost, 'evt_lost_first', 'charge.dispute.closed');
    expect(await sellerLedgerMinor(fixture.sellerIds[0])).toBe(10000);
    expect(await SellerBalanceTransaction.findOne({ seller: fixture.sellerIds[0] }).lean())
      .toMatchObject({ status: 'completed', direction: 'debit' });

    const delayed = { ...lost, disputeStatus: 'needs_response' };
    await applyRisk(delayed, 'evt_lost_delayed_withdrawn', 'charge.dispute.funds_withdrawn');
    await applyRisk(delayed, 'evt_lost_delayed_created', 'charge.dispute.created');
    expect(await sellerLedgerMinor(fixture.sellerIds[0])).toBe(10000);
    expect(await SellerBalanceTransaction.countDocuments({ seller: fixture.sellerIds[0] })).toBe(1);
  });

  test('does not reserve seller funds for a warning inquiry', async () => {
    const fixture = await createPaidOrder({ paymentIntentId: 'pi_inquiry' });
    await applyRisk(charge({
      type: 'order_payment',
      paymentIntentId: fixture.paymentIntentId,
      amount: 10000,
      chargeId: 'ch_inquiry',
      disputeId: 'dp_inquiry',
      disputeAmount: 10000,
      disputeStatus: 'warning_needs_response',
    }), 'evt_inquiry', 'charge.dispute.created');
    expect(await SellerBalanceTransaction.countDocuments({})).toBe(0);
  });

  test('quarantines legacy PKR reversal accounting instead of freezing first-event live rates', async () => {
    const legacy = await createPaidOrder({
      sellerAmounts: [[new mongoose.Types.ObjectId(), 280]],
      currency: 'PKR',
      paymentIntentId: 'pi_pkr_legacy',
      withSnapshot: false,
    });
    await expect(applyRisk(charge({
      type: 'order_payment',
      paymentIntentId: legacy.paymentIntentId,
      amount: 28000,
      amountRefunded: 28000,
      currency: 'pkr',
      chargeId: 'ch_pkr_legacy',
    }), 'evt_pkr_legacy', 'charge.refunded')).rejects.toMatchObject({
      code: 'STRIPE_PAYMENT_RISK_HISTORICAL_RATE_MISSING',
    });
    expect(await SellerBalanceTransaction.countDocuments({ seller: legacy.sellerIds[0] })).toBe(0);
    expect(await SellerPaymentRiskHold.countDocuments({ seller: legacy.sellerIds[0], status: 'pending' })).toBe(1);
    const persisted = await Order.findById(legacy.order._id).lean();
    expect(persisted.exchangeRateSnapshot?.rates?.PKR).toBeNull();
    expect(persisted.sellerSettlementVersion).toBe(0);
  });
});

describe('Wallet Stripe liability lifecycle', () => {
  test('freezes one exact provider refund delta across the buyer Wallet and funded seller, then replays without duplicates', async () => {
    const seller = new mongoose.Types.ObjectId();
    const fixture = await createWalletTopUp({
      amount: 100,
      balance: 40,
      paymentIntentId: 'pi_wallet_exact_refund_notice',
      sellerAllocations: [{
        seller: String(seller),
        sourceAmountMinor: 6000,
        amountUSDMinor: 6000,
      }],
    });
    const created = 1787443200;
    const refund = succeededRefund({
      id: 're_wallet_exact_refund_notice',
      amount: 5000,
      currency: 'usd',
      chargeId: 'ch_wallet_exact_refund_notice',
      paymentIntentId: fixture.paymentIntentId,
      created,
      metadata: { type: 'wallet_top_up' },
    });
    const refundCharge = charge({
      type: 'wallet_top_up',
      paymentIntentId: fixture.paymentIntentId,
      amount: 10000,
      amountRefunded: 5000,
      chargeId: 'ch_wallet_exact_refund_notice',
      refunds: completeRefundList([refund]),
    });
    const first = await flagStripePaymentRisk({
      charge: refundCharge,
      eventId: 'evt_wallet_exact_refund_notice',
      eventType: 'charge.refunded',
      eventCreatedAt: created,
    });
    expect(first.riskNotifications.refund.notified).toBe(true);

    const event = await StripePaymentRiskEvent.findOne({ walletTopUp: fixture.transaction._id }).lean();
    expect(event).toMatchObject({
      sourceType: 'wallet_top_up',
      classification: 'wallet_refund',
      currency: 'USD',
      refundDeltaMinor: 5000,
      refundExposureMinor: 5000,
      accountImpact: {
        user: fixture.user,
        action: 'refund_debited',
        direction: 'debit',
        sourceAmountMinor: 4000,
        sourceCurrency: 'USD',
      },
      sellerImpacts: [{
        seller,
        action: 'refund_debited',
        direction: 'debit',
        sourceAmountMinor: 1000,
        sourceCurrency: 'USD',
        amountUSDMinor: 1000,
      }],
    });
    expect(event.accountImpact.sourceAmountMinor
      + event.sellerImpacts.reduce((sum, impact) => sum + impact.sourceAmountMinor, 0)).toBe(5000);
    expect(await NotificationOutbox.countDocuments({
      eventType: 'wallet.payment_refund_completed',
      'recipient.audienceRole': 'buyer',
    })).toBe(4);
    expect(await NotificationOutbox.countDocuments({
      eventType: 'wallet.payment_refund_completed',
      'recipient.audienceRole': 'seller',
      'recipient.user': seller,
    })).toBe(4);
    const buyerInApp = await NotificationOutbox.findOne({
      eventType: 'wallet.payment_refund_completed',
      channel: 'inapp',
      'recipient.audienceRole': 'buyer',
    }).lean();
    expect(buyerInApp.money).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'provider_amount', amountMinor: 5000, currency: 'USD' }),
      expect.objectContaining({ key: 'account_impact', amountMinor: 4000, currency: 'USD' }),
    ]));
    expect(buyerInApp.payload.body).toContain('$50.00');
    expect(buyerInApp.payload.body).toContain('$40.00');

    await flagStripePaymentRisk({
      charge: refundCharge,
      eventId: 'evt_wallet_exact_refund_notice',
      eventType: 'charge.refunded',
      eventCreatedAt: created,
    });
    expect(await StripePaymentRiskEvent.countDocuments({ walletTopUp: fixture.transaction._id })).toBe(1);
    expect(await NotificationOutbox.countDocuments({
      eventType: 'wallet.payment_refund_completed',
    })).toBe(8);

    const secondCreated = created + 60;
    const secondRefund = succeededRefund({
      id: 're_wallet_exact_refund_notice_second',
      amount: 2000,
      currency: 'usd',
      chargeId: 'ch_wallet_exact_refund_notice',
      paymentIntentId: fixture.paymentIntentId,
      created: secondCreated,
      metadata: { type: 'wallet_top_up' },
    });
    const second = await flagStripePaymentRisk({
      charge: charge({
        type: 'wallet_top_up',
        paymentIntentId: fixture.paymentIntentId,
        amount: 10000,
        amountRefunded: 7000,
        chargeId: 'ch_wallet_exact_refund_notice',
        refunds: completeRefundList([refund, secondRefund]),
      }),
      eventId: 'evt_wallet_exact_refund_notice_second',
      eventType: 'charge.refunded',
      eventCreatedAt: secondCreated,
    });
    expect(second.riskNotifications.refund.notified).toBe(true);
    const secondEvent = await StripePaymentRiskEvent.findOne({
      walletTopUp: fixture.transaction._id,
      stripeEventId: 'evt_wallet_exact_refund_notice_second',
    }).lean();
    expect(secondEvent).toMatchObject({
      refundDeltaMinor: 2000,
      refundExposureMinor: 7000,
      accountImpact: null,
      sellerImpacts: [{ seller, sourceAmountMinor: 2000, direction: 'debit' }],
    });
    const secondBuyer = await NotificationOutbox.findOne({
      aggregateId: String(secondEvent._id),
      channel: 'inapp',
      'recipient.audienceRole': 'buyer',
    }).lean();
    expect(secondBuyer.money).toEqual([
      expect.objectContaining({ key: 'provider_amount', amountMinor: 2000, currency: 'USD' }),
    ]);
    expect(secondBuyer.payload.body).toContain('$20.00');
    expect(secondBuyer.payload.body).not.toContain('$70.00');
    expect(await StripePaymentRiskEvent.countDocuments({ walletTopUp: fixture.transaction._id })).toBe(2);
    expect(await NotificationOutbox.countDocuments({
      eventType: 'wallet.payment_refund_completed',
    })).toBe(16);
  });

  test('concurrent exact Wallet refund delivery converges to one immutable event and one channel set', async () => {
    const fixture = await createWalletTopUp({
      amount: 10,
      balance: 10,
      paymentIntentId: 'pi_wallet_concurrent_refund_notice',
    });
    const created = 1787443250;
    const refund = succeededRefund({
      id: 're_wallet_concurrent_refund_notice',
      amount: 1000,
      currency: 'usd',
      chargeId: 'ch_wallet_concurrent_refund_notice',
      paymentIntentId: fixture.paymentIntentId,
      created,
      metadata: { type: 'wallet_top_up' },
    });
    const input = {
      charge: charge({
        type: 'wallet_top_up',
        paymentIntentId: fixture.paymentIntentId,
        amount: 1000,
        amountRefunded: 1000,
        chargeId: 'ch_wallet_concurrent_refund_notice',
        refunds: completeRefundList([refund]),
      }),
      eventId: 'evt_wallet_concurrent_refund_notice',
      eventType: 'charge.refunded',
      eventCreatedAt: created,
    };
    await Promise.all([flagStripePaymentRisk(input), flagStripePaymentRisk(input)]);
    expect(await StripePaymentRiskEvent.countDocuments({ walletTopUp: fixture.transaction._id })).toBe(1);
    expect(await NotificationOutbox.countDocuments({
      eventType: 'wallet.payment_refund_completed',
    })).toBe(4);
    expect(await WalletTransaction.countDocuments({
      type: 'reversal',
      direction: 'debit',
      'metadata.sourcePaymentTransactionId': String(fixture.transaction._id),
    })).toBe(1);
  });

  test('routes exact Wallet dispute open and won states without describing either as a refund or new payment', async () => {
    const seller = new mongoose.Types.ObjectId();
    const fixture = await createWalletTopUp({
      amount: 100,
      balance: 40,
      paymentIntentId: 'pi_wallet_exact_dispute_notice',
      sellerAllocations: [{
        seller: String(seller), sourceAmountMinor: 6000, amountUSDMinor: 6000,
      }],
    });
    const base = charge({
      type: 'wallet_top_up',
      paymentIntentId: fixture.paymentIntentId,
      amount: 10000,
      chargeId: 'ch_wallet_exact_dispute_notice',
      disputeId: 'dp_wallet_exact_dispute_notice',
      disputeAmount: 10000,
      disputeStatus: 'needs_response',
    });
    const opened = await flagStripePaymentRisk({
      charge: base,
      eventId: 'evt_wallet_exact_dispute_opened',
      eventType: 'charge.dispute.funds_withdrawn',
      eventCreatedAt: 1787443300,
    });
    expect(opened.riskNotifications.disputes).toHaveLength(1);
    const openEvent = await StripePaymentRiskEvent.findOne({
      walletTopUp: fixture.transaction._id,
      classification: 'wallet_dispute_opened',
    }).lean();
    expect(openEvent.accountImpact.sourceAmountMinor).toBe(4000);
    expect(openEvent.sellerImpacts[0].sourceAmountMinor).toBe(6000);
    expect(openEvent.accountImpact.sourceAmountMinor + openEvent.sellerImpacts[0].sourceAmountMinor)
      .toBe(openEvent.disputeExposureMinor);
    const openedCopies = await NotificationOutbox.find({
      eventType: 'wallet.payment_dispute_opened', channel: 'inapp',
    }).select('payload.body').lean();
    expect(openedCopies).toHaveLength(2);
    expect(openedCopies.every(row => /not a refund/i.test(row.payload.body))).toBe(true);
    expect(openedCopies.every(row => /no final outcome/i.test(row.payload.body))).toBe(true);

    const won = await flagStripePaymentRisk({
      charge: { ...base, disputeStatus: 'won' },
      eventId: 'evt_wallet_exact_dispute_won',
      eventType: 'charge.dispute.closed',
      eventCreatedAt: 1787443400,
    });
    expect(won.riskNotifications.disputes).toHaveLength(1);
    const wonEvent = await StripePaymentRiskEvent.findOne({
      walletTopUp: fixture.transaction._id,
      classification: 'wallet_dispute_won',
    }).lean();
    expect(wonEvent.accountImpact).toMatchObject({ direction: 'credit', sourceAmountMinor: 4000 });
    expect(wonEvent.sellerImpacts[0]).toMatchObject({ direction: 'credit', sourceAmountMinor: 6000 });
    const wonCopies = await NotificationOutbox.find({
      eventType: 'wallet.payment_dispute_won', channel: 'inapp',
    }).select('payload.body').lean();
    expect(wonCopies).toHaveLength(2);
    expect(wonCopies.every(row => /not a new payment or refund/i.test(row.payload.body))).toBe(true);
  });

  test('quarantines a Wallet refund with incomplete provider evidence to four-channel admin review only', async () => {
    const admin = await User.create({
      username: 'wallet-risk-review-admin',
      email: 'wallet-risk-review-admin@example.com',
      phone: '+923001234568',
      password: 'not-used',
      role: 'admin',
      status: 'active',
    });
    const fixture = await createWalletTopUp({
      amount: 100,
      balance: 100,
      paymentIntentId: 'pi_wallet_incomplete_refund_notice',
    });
    await flagStripePaymentRisk({
      charge: charge({
        type: 'wallet_top_up',
        paymentIntentId: fixture.paymentIntentId,
        amount: 10000,
        amountRefunded: 1000,
        chargeId: 'ch_wallet_incomplete_refund_notice',
      }),
      eventId: 'evt_wallet_incomplete_refund_notice',
      eventType: 'charge.refunded',
      eventCreatedAt: 1787443500,
    });
    expect(await StripePaymentRiskEvent.countDocuments({ walletTopUp: fixture.transaction._id })).toBe(0);
    expect(await StripePaymentRiskReview.findOne({
      stripeEventId: 'evt_wallet_incomplete_refund_notice',
    }).lean()).toMatchObject({
      sourceType: 'wallet_top_up',
      sourceReferenceId: String(fixture.transaction._id),
      reasonCode: 'STRIPE_REFUND_OBJECTS_MISSING',
    });
    expect(await NotificationOutbox.countDocuments({
      eventType: 'payment.risk_review_required',
      'recipient.user': admin._id,
    })).toBe(4);
    expect(await NotificationOutbox.countDocuments({
      eventType: 'wallet.payment_refund_completed',
    })).toBe(0);
  });

  test('collects available balance, carries terminal shortfall, and nets future credits before unlocking', async () => {
    const fixture = await createWalletTopUp({ amount: 100, balance: 60, paymentIntentId: 'pi_wallet_refund' });
    await applyRisk(charge({
      type: 'wallet_top_up',
      paymentIntentId: fixture.paymentIntentId,
      amount: 10000,
      amountRefunded: 10000,
      chargeId: 'ch_pi_wallet_refund',
    }), 'evt_wallet_refund', 'charge.refunded');

    let summary = await getWalletSummary(fixture.user);
    expect(summary.wallet).toMatchObject({ status: 'locked', balances: { USD: 0 } });
    expect(summary.wallet.paymentRisk.byCurrency.USD).toMatchObject({
      outstanding: 40,
      held: 0,
    });

    const firstCredit = await runInTransaction(session => creditWalletInSession({
      userId: fixture.user,
      amount: 25,
      currency: 'USD',
      type: 'return_refund',
      referenceType: 'system',
      referenceId: 'future-credit-25',
      idempotencyKey: 'future-credit-25',
      description: 'Future credit',
      allowLocked: true,
    }, session));
    expect(firstCredit.metadata).toMatchObject({
      liabilityAppliedMinor: 2500,
      availableCreditedMinor: 0,
      remainingLiabilityMinor: 1500,
    });

    await runInTransaction(session => creditWalletInSession({
      userId: fixture.user,
      amount: 15,
      currency: 'USD',
      type: 'return_refund',
      referenceType: 'system',
      referenceId: 'future-credit-15',
      idempotencyKey: 'future-credit-15',
      description: 'Future credit',
      allowLocked: true,
    }, session));
    summary = await getWalletSummary(fixture.user);
    expect(summary.wallet).toMatchObject({ status: 'active', balances: { USD: 0 } });
    expect(summary.wallet.paymentRisk.restricted).toBe(false);
  });

  test('holds a provisional dispute, restores held money on won, and ignores delayed financial delivery', async () => {
    const fixture = await createWalletTopUp({ amount: 100, balance: 100, paymentIntentId: 'pi_wallet_won' });
    const disputed = charge({
      type: 'wallet_top_up',
      paymentIntentId: fixture.paymentIntentId,
      amount: 10000,
      chargeId: 'ch_pi_wallet_won',
      disputeId: 'dp_wallet_won',
      disputeAmount: 10000,
      disputeStatus: 'needs_response',
    });
    await applyRisk(disputed, 'evt_wallet_disputed', 'charge.dispute.funds_withdrawn');
    let summary = await getWalletSummary(fixture.user);
    expect(summary.wallet).toMatchObject({ status: 'locked', balances: { USD: 0 } });
    expect(summary.wallet.paymentRisk.byCurrency.USD.held).toBe(100);

    await applyRisk({ ...disputed, disputeStatus: 'won' }, 'evt_wallet_won', 'charge.dispute.closed');
    summary = await getWalletSummary(fixture.user);
    expect(summary.wallet).toMatchObject({ status: 'active', balances: { USD: 100 } });
    expect(summary.wallet.paymentRisk.restricted).toBe(false);

    await applyRisk(disputed, 'evt_wallet_delayed', 'charge.dispute.funds_withdrawn');
    summary = await getWalletSummary(fixture.user);
    expect(summary.wallet).toMatchObject({ status: 'active', balances: { USD: 100 } });
    expect(await WalletTransaction.countDocuments({ type: 'reversal' })).toBe(1);
  });

  test('never overwrites or clears an independent Wallet security lock', async () => {
    const fixture = await createWalletTopUp({ amount: 100, balance: 100, paymentIntentId: 'pi_wallet_manual_lock' });
    await Wallet.findByIdAndUpdate(fixture.wallet._id, {
      $set: {
        status: 'locked',
        lockedReason: 'Suspected fraud - manual review required.',
        lockSource: 'manual',
      },
    });
    const disputed = charge({
      type: 'wallet_top_up',
      paymentIntentId: fixture.paymentIntentId,
      amount: 10000,
      chargeId: 'ch_pi_wallet_manual_lock',
      disputeId: 'dp_wallet_manual_lock',
      disputeAmount: 10000,
      disputeStatus: 'needs_response',
    });

    await applyRisk(disputed, 'evt_wallet_manual_disputed', 'charge.dispute.funds_withdrawn');
    let wallet = await Wallet.findById(fixture.wallet._id).lean();
    expect(wallet).toMatchObject({
      status: 'locked',
      lockedReason: 'Suspected fraud - manual review required.',
      lockSource: 'manual',
    });
    let summary = await getWalletSummary(fixture.user);
    expect(summary.wallet.paymentRisk.canTopUpForSettlement).toBe(false);

    await applyRisk({ ...disputed, disputeStatus: 'won' }, 'evt_wallet_manual_won', 'charge.dispute.closed');
    wallet = await Wallet.findById(fixture.wallet._id).lean();
    expect(wallet).toMatchObject({
      status: 'locked',
      lockedReason: 'Suspected fraud - manual review required.',
      lockSource: 'manual',
      balances: { USD: 100 },
    });
    summary = await getWalletSummary(fixture.user);
    expect(summary.wallet.paymentRisk.restricted).toBe(false);
    expect(summary.wallet.paymentRisk.canTopUpForSettlement).toBe(false);
  });

  test('lost-first creates terminal Wallet debt and delayed events cannot reopen it', async () => {
    const fixture = await createWalletTopUp({ amount: 100, balance: 30, paymentIntentId: 'pi_wallet_lost' });
    const lost = charge({
      type: 'wallet_top_up',
      paymentIntentId: fixture.paymentIntentId,
      amount: 10000,
      chargeId: 'ch_pi_wallet_lost',
      disputeId: 'dp_wallet_lost',
      disputeAmount: 10000,
      disputeStatus: 'lost',
    });
    await applyRisk(lost, 'evt_wallet_lost', 'charge.dispute.closed');
    let summary = await getWalletSummary(fixture.user);
    expect(summary.wallet).toMatchObject({ status: 'locked', balances: { USD: 0 } });
    expect(summary.wallet.paymentRisk.byCurrency.USD.outstanding).toBe(70);
    expect(await WalletTransaction.findOne({ type: 'reversal' }).lean()).toMatchObject({ status: 'completed' });

    const delayed = { ...lost, disputeStatus: 'needs_response' };
    await applyRisk(delayed, 'evt_wallet_lost_delayed', 'charge.dispute.funds_withdrawn');
    expect(await WalletTransaction.countDocuments({ type: 'reversal' })).toBe(1);
    summary = await getWalletSummary(fixture.user);
    expect(summary.wallet.paymentRisk.byCurrency.USD.outstanding).toBe(70);
  });

  test('supports exposure above the original credit and audited admin reconciliation', async () => {
    const fixture = await createWalletTopUp({ amount: 100, balance: 100, paymentIntentId: 'pi_wallet_over' });
    const base = {
      type: 'wallet_top_up',
      paymentIntentId: fixture.paymentIntentId,
      amount: 10000,
      chargeId: 'ch_pi_wallet_over',
    };
    await applyRisk(charge({ ...base, amountRefunded: 3000 }), 'evt_wallet_refund_30', 'charge.refunded');
    await applyRisk(charge({
      ...base,
      amountRefunded: 3000,
      disputeId: 'dp_wallet_over',
      disputeAmount: 10000,
      disputeStatus: 'lost',
    }), 'evt_wallet_dispute_100', 'charge.dispute.closed');
    let summary = await getWalletSummary(fixture.user);
    expect(summary.wallet.balances.USD).toBe(0);
    expect(summary.wallet.paymentRisk.byCurrency.USD.outstanding).toBe(30);
    const liabilityRows = await WalletTransaction.find({ type: 'reversal' }).lean();
    expect(liabilityRows.reduce((sum, row) => sum + Math.round(row.amount * 100), 0)).toBe(13000);

    const audit = await reconcileWalletPaymentLiability({
      userId: fixture.user,
      adminId: new mongoose.Types.ObjectId(),
      amount: 30,
      currency: 'USD',
      action: 'external_collection',
      note: 'Collected outside Wallet',
      idempotencyKey: 'admin-wallet-risk-1',
    });
    expect(audit).toMatchObject({ type: 'admin_adjustment', status: 'completed' });
    summary = await getWalletSummary(fixture.user);
    expect(summary.wallet.status).toBe('active');
    expect(summary.wallet.paymentRisk.restricted).toBe(false);
  });

  test('warning inquiry has no Wallet financial effect', async () => {
    const fixture = await createWalletTopUp({ amount: 100, balance: 100, paymentIntentId: 'pi_wallet_inquiry' });
    await applyRisk(charge({
      type: 'wallet_top_up',
      paymentIntentId: fixture.paymentIntentId,
      amount: 10000,
      chargeId: 'ch_pi_wallet_inquiry',
      disputeId: 'dp_wallet_inquiry',
      disputeAmount: 10000,
      disputeStatus: 'warning_under_review',
    }), 'evt_wallet_inquiry', 'charge.dispute.created');
    const summary = await getWalletSummary(fixture.user);
    expect(summary.wallet).toMatchObject({ status: 'active', balances: { USD: 100 } });
    expect(await WalletTransaction.countDocuments({ type: 'reversal' })).toBe(0);
  });
});

describe('seller-funded return settlement reversal', () => {
  test('notifies only the seller/cardholder for an exact provider-confirmed return-settlement refund', async () => {
    const fixture = await createReturnSettlement({
      paymentIntentId: 'pi_return_exact_refund_notice',
    });
    const created = 1787529600;
    const refund = succeededRefund({
      id: 're_return_exact_refund_notice',
      amount: 5000,
      currency: 'usd',
      chargeId: 'ch_return_exact_refund_notice',
      paymentIntentId: fixture.paymentIntentId,
      created,
      metadata: {
        type: 'return_settlement',
        returnRequestId: String(fixture.request._id),
      },
    });
    const refundCharge = charge({
      type: 'return_settlement',
      paymentIntentId: fixture.paymentIntentId,
      amount: 5000,
      amountRefunded: 5000,
      chargeId: 'ch_return_exact_refund_notice',
      refunds: completeRefundList([refund]),
    });
    const first = await flagStripePaymentRisk({
      charge: refundCharge,
      eventId: 'evt_return_exact_refund_notice',
      eventType: 'charge.refunded',
      eventCreatedAt: created,
    });
    expect(first.riskNotifications.refund.notified).toBe(true);
    const event = await StripePaymentRiskEvent.findOne({ returnRequest: fixture.request._id }).lean();
    expect(event).toMatchObject({
      sourceType: 'return_settlement',
      classification: 'return_refund',
      refundDeltaMinor: 5000,
      sellerImpacts: [{
        seller: fixture.seller,
        action: 'refund_debited',
        direction: 'debit',
        sourceAmountMinor: 5000,
        sourceCurrency: 'USD',
      }],
    });
    expect(await NotificationOutbox.countDocuments({
      eventType: 'return.payment_refund_completed',
      'recipient.audienceRole': 'seller',
      'recipient.user': fixture.seller,
    })).toBe(4);
    expect(await NotificationOutbox.countDocuments({
      eventType: 'return.payment_refund_completed',
      'recipient.audienceRole': 'buyer',
    })).toBe(0);
    const sellerCopy = await NotificationOutbox.findOne({
      eventType: 'return.payment_refund_completed', channel: 'inapp',
    }).lean();
    expect(sellerCopy.payload.body).toContain('$50.00');
    expect(sellerCopy.payload.body).toMatch(/original card|card refund/i);

    await flagStripePaymentRisk({
      charge: refundCharge,
      eventId: 'evt_return_exact_refund_notice',
      eventType: 'charge.refunded',
      eventCreatedAt: created,
    });
    expect(await StripePaymentRiskEvent.countDocuments({ returnRequest: fixture.request._id })).toBe(1);
    expect(await NotificationOutbox.countDocuments({
      eventType: 'return.payment_refund_completed',
    })).toBe(4);
  });

  test('sends exact return-settlement dispute open and lost states to the seller, never the buyer', async () => {
    const fixture = await createReturnSettlement({
      paymentIntentId: 'pi_return_exact_dispute_notice',
    });
    const base = charge({
      type: 'return_settlement',
      paymentIntentId: fixture.paymentIntentId,
      amount: 5000,
      chargeId: 'ch_return_exact_dispute_notice',
      disputeId: 'dp_return_exact_dispute_notice',
      disputeAmount: 5000,
      disputeStatus: 'needs_response',
    });
    const opened = await flagStripePaymentRisk({
      charge: base,
      eventId: 'evt_return_exact_dispute_opened',
      eventType: 'charge.dispute.funds_withdrawn',
      eventCreatedAt: 1787529700,
    });
    expect(opened.riskNotifications.disputes).toHaveLength(1);
    const openEvent = await StripePaymentRiskEvent.findOne({
      returnRequest: fixture.request._id,
      classification: 'return_dispute_opened',
    }).lean();
    expect(openEvent.sellerImpacts[0]).toMatchObject({
      seller: fixture.seller,
      direction: 'debit',
      sourceAmountMinor: 5000,
    });
    const openCopy = await NotificationOutbox.findOne({
      eventType: 'return.payment_dispute_opened', channel: 'inapp',
    }).lean();
    expect(openCopy.payload.body).toMatch(/not a refund/i);
    expect(openCopy.payload.body).toMatch(/no final outcome/i);

    const lost = await flagStripePaymentRisk({
      charge: { ...base, disputeStatus: 'lost' },
      eventId: 'evt_return_exact_dispute_lost',
      eventType: 'charge.dispute.closed',
      eventCreatedAt: 1787529800,
    });
    expect(lost.riskNotifications.disputes).toHaveLength(1);
    const lostEvent = await StripePaymentRiskEvent.findOne({
      returnRequest: fixture.request._id,
      classification: 'return_dispute_lost',
    }).lean();
    expect(lostEvent.sellerImpacts[0]).toMatchObject({
      direction: 'none',
      sourceAmountMinor: 5000,
    });
    const lostCopy = await NotificationOutbox.findOne({
      eventType: 'return.payment_dispute_lost', channel: 'inapp',
    }).lean();
    expect(lostCopy.payload.body).toMatch(/dispute result, not a separate refund/i);
    expect(await NotificationOutbox.countDocuments({
      eventType: { $in: ['return.payment_dispute_opened', 'return.payment_dispute_lost'] },
      'recipient.audienceRole': 'buyer',
    })).toBe(0);
  });

  test('clears a failed return-dispute hold after a durable win and after a delayed retry', async () => {
    const fixture = await createReturnSettlement({
      paymentIntentId: 'pi_return_failed_then_won',
    });
    const disputed = charge({
      type: 'return_settlement',
      paymentIntentId: fixture.paymentIntentId,
      amount: 5000,
      chargeId: 'ch_return_failed_then_won',
      disputeId: 'dp_return_failed_then_won',
      disputeAmount: 5000,
      disputeStatus: 'needs_response',
    });
    const createSpy = jest.spyOn(SellerBalanceTransaction, 'create')
      .mockRejectedValueOnce(new Error('simulated return-ledger write failure'));
    try {
      await expect(applyRisk(
        disputed,
        'evt_return_financial_failed',
        'charge.dispute.funds_withdrawn',
      )).rejects.toThrow('simulated return-ledger write failure');
    } finally {
      createSpy.mockRestore();
    }

    expect(await StripePaymentRiskState.countDocuments({ disputeId: disputed.disputeId })).toBe(0);
    expect(await SellerPaymentRiskHold.countDocuments({
      seller: fixture.seller,
      disputeId: disputed.disputeId,
      status: 'pending',
    })).toBe(1);

    await applyRisk(
      { ...disputed, disputeStatus: 'won' },
      'evt_return_won_after_failure',
      'charge.dispute.closed',
    );
    expect(await StripePaymentRiskState.findOne({ disputeId: disputed.disputeId }).lean())
      .toMatchObject({ terminal: true, status: 'won' });
    expect(await SellerPaymentRiskHold.countDocuments({
      seller: fixture.seller,
      disputeId: disputed.disputeId,
      status: 'pending',
    })).toBe(0);

    await applyRisk(
      disputed,
      'evt_return_delayed_financial_after_won',
      'charge.dispute.funds_withdrawn',
    );
    expect(await SellerPaymentRiskHold.countDocuments({
      seller: fixture.seller,
      disputeId: disputed.disputeId,
      status: 'pending',
    })).toBe(0);
    expect(await SellerPaymentRiskHold.countDocuments({
      seller: fixture.seller,
      disputeId: disputed.disputeId,
      status: 'resolved',
    })).toBe(2);
    expect(await SellerBalanceTransaction.countDocuments({ seller: fixture.seller })).toBe(0);
  });

  test.each([
    ['unsupported', 'cad'],
    ['blank', ''],
    ['whitespace-padded', ' usd '],
  ])('rejects %s Stripe event currency and retains the return seller hold', async (_label, eventCurrency) => {
    const fixture = await createReturnSettlement({
      paymentIntentId: `pi_return_event_currency_${_label}`,
    });
    await expect(applyRisk(charge({
      type: 'return_settlement',
      paymentIntentId: fixture.paymentIntentId,
      amount: 5000,
      amountRefunded: 5000,
      currency: eventCurrency,
      chargeId: `ch_return_event_currency_${_label}`,
    }), `evt_return_event_currency_${_label}`, 'charge.refunded')).rejects.toMatchObject({
      code: 'RETURN_PAYMENT_RISK_CURRENCY_INVALID',
    });
    await expectPendingSellerRiskHold({
      sourceType: 'return_settlement',
      paymentIntentId: fixture.paymentIntentId,
      seller: fixture.seller,
    });
  });

  test.each([
    ['unsupported', 'CAD'],
    ['lowercase', 'usd'],
    ['blank', ''],
  ])('rejects %s stored return currency and retains the seller hold', async (_label, storedCurrency) => {
    const fixture = await createReturnSettlement({
      paymentIntentId: `pi_return_stored_currency_${_label}`,
    });
    await ReturnRequest.collection.updateOne(
      { _id: fixture.request._id },
      { $set: { currency: storedCurrency } },
    );
    await expect(applyRisk(charge({
      type: 'return_settlement',
      paymentIntentId: fixture.paymentIntentId,
      amount: 5000,
      amountRefunded: 5000,
      chargeId: `ch_return_stored_currency_${_label}`,
    }), `evt_return_stored_currency_${_label}`, 'charge.refunded')).rejects.toMatchObject({
      code: 'RETURN_PAYMENT_RISK_CURRENCY_INVALID',
    });
    await expectPendingSellerRiskHold({
      sourceType: 'return_settlement',
      paymentIntentId: fixture.paymentIntentId,
      seller: fixture.seller,
    });
  });

  test.each([
    ['boolean', true, 'RETURN_PAYMENT_RISK_AMOUNT_INVALID'],
    ['blank', '', 'RETURN_PAYMENT_RISK_AMOUNT_INVALID'],
    ['NaN', Number.NaN, 'RETURN_PAYMENT_RISK_AMOUNT_INVALID'],
    ['infinite', Number.POSITIVE_INFINITY, 'RETURN_PAYMENT_RISK_AMOUNT_INVALID'],
    ['sub-cent', 1.001, 'RETURN_PAYMENT_RISK_AMOUNT_INVALID'],
    ['charge-mismatched', 2, 'RETURN_PAYMENT_RISK_CHARGE_MISMATCH'],
  ])('rejects a %s stored return total and retains the seller hold', async (_label, storedTotal, code) => {
    const fixture = await createReturnSettlement({
      amount: 1,
      paymentIntentId: `pi_return_stored_total_${_label}`,
    });
    await ReturnRequest.collection.updateOne(
      { _id: fixture.request._id },
      { $set: { 'refund.totalAmount': storedTotal } },
    );
    await expect(applyRisk(charge({
      type: 'return_settlement',
      paymentIntentId: fixture.paymentIntentId,
      amount: 100,
      amountRefunded: 100,
      chargeId: `ch_return_stored_total_${_label}`,
    }), `evt_return_stored_total_${_label}`, 'charge.refunded')).rejects.toMatchObject({ code });
    await expectPendingSellerRiskHold({
      sourceType: 'return_settlement',
      paymentIntentId: fixture.paymentIntentId,
      seller: fixture.seller,
    });
  });

  test('rejects a return whose stored order identity was changed and retains the seller hold', async () => {
    const fixture = await createReturnSettlement({ paymentIntentId: 'pi_return_order_identity_mismatch' });
    await ReturnRequest.collection.updateOne(
      { _id: fixture.request._id },
      { $set: { orderId: 'ORD-TAMPERED-RETURN-RISK' } },
    );
    await expect(applyRisk(charge({
      type: 'return_settlement',
      paymentIntentId: fixture.paymentIntentId,
      amount: 5000,
      amountRefunded: 5000,
      chargeId: 'ch_return_order_identity_mismatch',
    }), 'evt_return_order_identity_mismatch', 'charge.refunded')).rejects.toMatchObject({
      code: 'RETURN_PAYMENT_RISK_ORDER_MISMATCH',
    });
    await expectPendingSellerRiskHold({
      sourceType: 'return_settlement',
      paymentIntentId: fixture.paymentIntentId,
      seller: fixture.seller,
    });
  });

  test('rejects a return whose currency no longer matches its original order and retains the seller hold', async () => {
    const fixture = await createReturnSettlement({ paymentIntentId: 'pi_return_order_currency_mismatch' });
    await Order.collection.updateOne(
      { _id: fixture.order._id },
      { $set: { currency: 'PKR' } },
    );
    await expect(applyRisk(charge({
      type: 'return_settlement',
      paymentIntentId: fixture.paymentIntentId,
      amount: 5000,
      amountRefunded: 5000,
      chargeId: 'ch_return_order_currency_mismatch',
    }), 'evt_return_order_currency_mismatch', 'charge.refunded')).rejects.toMatchObject({
      code: 'RETURN_PAYMENT_RISK_ORDER_MISMATCH',
    });
    await expectPendingSellerRiskHold({
      sourceType: 'return_settlement',
      paymentIntentId: fixture.paymentIntentId,
      seller: fixture.seller,
    });
  });

  test('charges seller liability without locking or debiting the innocent buyer Wallet', async () => {
    const seller = new mongoose.Types.ObjectId();
    const { order, buyer } = await createPaidOrder({
      sellerAmounts: [[seller, 50]],
      paymentIntentId: 'pi_original_return_order',
    });
    const wallet = await Wallet.create({ user: buyer, balances: { USD: 50 }, status: 'active' });
    const buyerCredit = await WalletTransaction.create({
      user: buyer,
      wallet: wallet._id,
      type: 'return_refund',
      direction: 'credit',
      status: 'completed',
      amount: 50,
      currency: 'USD',
      balanceAfter: 50,
      description: 'Completed return refund',
      referenceType: 'return_request',
      referenceId: 'return-credit',
      idempotencyKey: 'return-credit',
      completedAt: new Date(),
    });
    const line = order.orderItems[0];
    const request = await ReturnRequest.create({
      returnNumber: 'RET-RISK-1',
      order: order._id,
      orderId: order.orderId,
      buyer,
      seller,
      currency: 'USD',
      items: [{
        orderItemId: line._id,
        productId: line.productId,
        name: line.name,
        image: line.image,
        quantity: 1,
        purchasedQuantity: 1,
        unitPrice: 50,
        lineSubtotal: 50,
      }],
      reasonCategory: 'defective',
      reasonDetails: 'The item was defective and was returned.',
      status: 'returned',
      statusHistory: [{ status: 'returned', actorRole: 'system' }],
      eligibilityDeadline: new Date(Date.now() + 86400000),
      policySnapshot: { returnsEnabled: true, returnDuration: 30, refundType: 'full_refund' },
      refund: { itemSubtotal: 50, taxAmount: 0, shippingAmount: 0, discountAmount: 0, totalAmount: 50 },
      settlement: {
        fundingSource: 'card',
        status: 'completed',
        setupState: 'complete',
        stripePaymentIntentId: 'pi_return_settlement',
        walletTransaction: buyerCredit._id,
        settledAt: new Date(),
      },
    });

    await applyRisk(charge({
      type: 'return_settlement',
      paymentIntentId: 'pi_return_settlement',
      amount: 5000,
      amountRefunded: 5000,
      chargeId: 'ch_return_settlement',
    }), 'evt_return_refund', 'charge.refunded');

    expect(await sellerLedgerMinor(seller)).toBe(5000);
    expect(await SellerBalanceTransaction.findOne({ seller }).lean()).toMatchObject({
      referenceType: 'stripe_payment',
      metadata: { sourceType: 'return_settlement', sourceReferenceId: String(request._id) },
    });
    expect(await Wallet.findById(wallet._id).lean()).toMatchObject({
      status: 'active',
      balances: { USD: 50 },
    });
    expect(await WalletTransaction.countDocuments({ wallet: wallet._id, type: 'reversal' })).toBe(0);
  });
});
