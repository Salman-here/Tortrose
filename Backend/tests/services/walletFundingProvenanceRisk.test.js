'use strict';

const mockPaymentIntentRetrieve = jest.fn();
const mockCheckoutSessionRetrieve = jest.fn();

jest.mock('../../config/stripe', () => ({
  stripe: {
    paymentIntents: { retrieve: mockPaymentIntentRetrieve },
    checkout: { sessions: { retrieve: mockCheckoutSessionRetrieve } },
  },
  STRIPE_MODE: 'test',
}));

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Order = require('../../models/Order');
const ReturnRequest = require('../../models/ReturnRequest');
const SellerBalanceTransaction = require('../../models/SellerBalanceTransaction');
const SellerPaymentRiskHold = require('../../models/SellerPaymentRiskHold');
const SellerSettlementLock = require('../../models/SellerSettlementLock');
const StripePaymentRiskMarker = require('../../models/StripePaymentRiskMarker');
const StripePaymentRiskState = require('../../models/StripePaymentRiskState');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const { flagStripePaymentRisk } = require('../../services/stripePaymentRiskService');
const {
  allocateFundingProvenanceToSellerSettlement,
  completeWalletTopUp,
  completeWalletTopUpFromPaymentIntent,
  creditWalletInSession,
  getWalletSummary,
  payOrderWithWallet,
  reconcileWalletPaymentLiability,
  runInTransaction,
} = require('../../services/walletService');
const {
  isHostedCheckoutPaymentIntent,
  resolvePaymentIntentLifecycleRoute,
} = require('../../services/stripePaymentIntentEventRoutingService');
const {
  assertWalletOrderFundingReturnable,
  attachReturnedWalletFundingProvenance,
} = require('../../services/walletOrderFundingRiskService');

let replSet;

const oid = () => new mongoose.Types.ObjectId();

const shippingInfo = {
  fullName: 'Legacy Wallet Buyer',
  email: 'legacy-wallet@example.com',
  phone: '+923001234567',
  address: '1 Legacy Street',
  city: 'Lahore',
  state: 'Punjab',
  postalCode: '54000',
  country: 'Pakistan',
};

const createHistoricalWalletOrder = async ({
  user,
  sellerAmounts,
  currency = 'USD',
}) => {
  const totalMinor = sellerAmounts.reduce(
    (sum, [, amountMinor]) => sum + amountMinor,
    0,
  );
  const total = totalMinor / 100;
  return Order.create({
    user,
    orderId: `ORD-LEGACY-WALLET-${oid()}`,
    currency,
    orderItems: sellerAmounts.map(([seller, amountMinor], index) => ({
      productId: oid(),
      seller,
      name: `Legacy funded item ${index + 1}`,
      image: 'https://example.com/legacy-wallet.jpg',
      price: amountMinor / 100,
      lineSubtotal: amountMinor / 100,
      quantity: 1,
    })),
    shippingInfo,
    shippingMethod: { name: 'standard', price: 0, estimatedDays: 5 },
    sellerFulfillment: sellerAmounts.map(([seller]) => ({
      seller,
      status: 'delivered',
      deliveredAt: new Date(),
    })),
    orderSummary: {
      subtotal: total,
      shippingCost: 0,
      tax: 0,
      couponDiscount: 0,
      totalAmount: total,
    },
    paymentMethod: 'wallet',
    awaitingPayment: false,
    inventoryCommitted: true,
    isPaid: true,
    paidAt: new Date(),
    orderStatus: 'delivered',
    isDelivered: true,
    deliveredAt: new Date(),
  });
};

const createFundedTopUp = async ({
  amountMinor = 10000,
  remainingMinor = 0,
  sellerAllocations = [],
  paymentIntentId = `pi_${oid()}`,
  orderId = oid(),
} = {}) => {
  const user = oid();
  const wallet = await Wallet.create({
    user,
    balances: { USD: remainingMinor / 100 },
    status: 'active',
  });
  const topUp = await WalletTransaction.create({
    user,
    wallet: wallet._id,
    type: 'top_up',
    direction: 'credit',
    status: 'completed',
    amount: amountMinor / 100,
    currency: 'USD',
    balanceAfter: amountMinor / 100,
    description: 'Provenance top-up',
    referenceType: 'stripe_payment_intent',
    referenceId: paymentIntentId,
    idempotencyKey: `topup:${paymentIntentId}`,
    stripePaymentIntentId: paymentIntentId,
    stripeChargeId: `ch_${paymentIntentId}`,
    stripeMode: 'test',
    paymentFlow: 'payment_sheet',
    paymentSetupState: 'complete',
    metadata: {
      availableCreditedMinor: amountMinor,
      fundingOriginalAvailableMinor: amountMinor,
      fundingRemainingMinor: remainingMinor,
    },
    completedAt: new Date(),
  });
  const spentMinor = sellerAllocations.reduce((sum, entry) => sum + entry.sourceAmountMinor, 0);
  if (spentMinor > 0) {
    await WalletTransaction.create({
      user,
      wallet: wallet._id,
      type: 'order_payment',
      direction: 'debit',
      status: 'completed',
      amount: spentMinor / 100,
      currency: 'USD',
      balanceAfter: remainingMinor / 100,
      description: 'Funded order',
      referenceType: 'order',
      referenceId: String(orderId),
      idempotencyKey: `order:${orderId}`,
      metadata: {
        fundingProvenance: [{
          sourceType: 'wallet_top_up',
          sourceTransactionId: String(topUp._id),
          amountMinor: spentMinor,
          orderId: String(orderId),
          sellerAllocations,
        }],
      },
      completedAt: new Date(),
    });
  }
  return { user, wallet, topUp, paymentIntentId, orderId };
};

const createLegacyRiskTopUp = async ({
  paymentIntentId,
  amountMinor = 10000,
  walletBalanceMinor = 0,
} = {}) => {
  const user = oid();
  const wallet = await Wallet.create({
    user,
    balances: { USD: walletBalanceMinor / 100 },
    status: 'active',
  });
  const topUp = await WalletTransaction.create({
    user,
    wallet: wallet._id,
    type: 'top_up',
    direction: 'credit',
    status: 'completed',
    amount: amountMinor / 100,
    currency: 'USD',
    balanceAfter: walletBalanceMinor / 100,
    description: 'Legacy liability source top-up',
    referenceType: 'stripe_payment_intent',
    referenceId: paymentIntentId,
    idempotencyKey: `topup:${paymentIntentId}`,
    stripePaymentIntentId: paymentIntentId,
    stripeChargeId: `ch_${paymentIntentId}`,
    stripeMode: 'test',
    paymentFlow: 'payment_sheet',
    paymentSetupState: 'complete',
    completedAt: new Date(Date.now() - 2000),
  });
  return { user, wallet, topUp, paymentIntentId };
};

const riskCharge = ({
  topUp,
  paymentIntentId,
  amountMinor = 10000,
  refundedMinor = 0,
  disputeId = null,
  disputeMinor = 0,
  disputeStatus = '',
}) => ({
  id: `ch_${paymentIntentId}`,
  amount: amountMinor,
  amount_refunded: refundedMinor,
  currency: 'usd',
  payment_intent: paymentIntentId,
  metadata: {
    type: 'wallet_top_up',
    walletTransactionId: String(topUp._id),
  },
  disputeId,
  disputeAmount: disputeMinor,
  disputeStatus,
});

const applyRisk = (fixture, details, eventId, eventType) => flagStripePaymentRisk({
  charge: riskCharge({ ...fixture, ...details }),
  eventId,
  eventType,
});

const buyerLiabilityMinor = async topUp => (await WalletTransaction.find({
  type: 'reversal',
  direction: 'debit',
  status: { $in: ['pending', 'completed'] },
  'metadata.sourcePaymentTransactionId': String(topUp._id),
}).lean()).reduce((sum, row) => (
  sum + (Number.isSafeInteger(Number(row?.metadata?.liabilityMinor))
    ? Number(row.metadata.liabilityMinor)
    : Math.round(row.amount * 100))
), 0);

const sellerLiabilityMinor = async (topUp, seller = null) => (await SellerBalanceTransaction.find({
  type: 'reversal',
  status: { $in: ['reserved', 'completed'] },
  'metadata.sourceType': 'wallet_top_up',
  'metadata.sourceReferenceId': String(topUp._id),
  ...(seller ? { seller } : {}),
}).lean()).reduce((sum, row) => (
  sum + (row.direction === 'credit' ? -1 : 1) * Math.round(row.sourceAmount * 100)
), 0);

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());
  await Promise.all([
    SellerBalanceTransaction.syncIndexes(),
    SellerPaymentRiskHold.syncIndexes(),
    SellerSettlementLock.syncIndexes(),
    StripePaymentRiskMarker.syncIndexes(),
    StripePaymentRiskState.syncIndexes(),
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
  await Promise.all([
    Order.deleteMany({}),
    ReturnRequest.deleteMany({}),
    SellerBalanceTransaction.deleteMany({}),
    SellerPaymentRiskHold.deleteMany({}),
    SellerSettlementLock.deleteMany({}),
    StripePaymentRiskMarker.deleteMany({}),
    StripePaymentRiskState.deleteMany({}),
    Wallet.deleteMany({}),
    WalletTransaction.deleteMany({}),
  ]);
});

test('one-shot transportation conserves tiny top-up rows, seller columns, and cumulative USD cents', () => {
  const sellerA = String(oid());
  const sellerB = String(oid());
  const lots = [
    { sourceTransactionId: 'lot-1', amountMinor: 1 },
    { sourceTransactionId: 'lot-2', amountMinor: 1 },
  ];
  const allocated = allocateFundingProvenanceToSellerSettlement({
    fundingProvenance: lots,
    settlementEntries: [
      { seller: sellerA, sourceAmountMinor: 1, amountUSDMinor: 1 },
      { seller: sellerB, sourceAmountMinor: 1, amountUSDMinor: 1 },
    ],
    orderId: 'order-two-cents',
  });
  expect(allocated.map(row => row.sellerAllocations)).toEqual([
    [{ seller: [sellerA, sellerB].sort()[0], sourceAmountMinor: 1, amountUSDMinor: 1 }],
    [{ seller: [sellerA, sellerB].sort()[1], sourceAmountMinor: 1, amountUSDMinor: 1 }],
  ]);
  expect(allocated.flatMap(row => row.sellerAllocations)
    .reduce((sum, row) => sum + row.sourceAmountMinor, 0)).toBe(2);

  const crossCurrencySeller = String(oid());
  const rounded = allocateFundingProvenanceToSellerSettlement({
    fundingProvenance: lots,
    settlementEntries: [{ seller: crossCurrencySeller, sourceAmountMinor: 2, amountUSDMinor: 1 }],
    orderId: 'order-rounded-usd-cent',
  });
  expect(rounded.map(row => row.sellerAllocations[0].amountUSDMinor)).toEqual([1, 0]);
});

test('legacy residual funding extends canonical seller columns instead of re-rounding residual capacity', () => {
  const sellers = [String(oid()), String(oid())].sort();
  const allocated = allocateFundingProvenanceToSellerSettlement({
    fundingProvenance: [{ sourceTransactionId: 'legacy-residual-cent', amountMinor: 1 }],
    settlementEntries: [
      {
        seller: sellers[0],
        sourceAmountMinor: 2,
        amountUSDMinor: 2,
        allocationSourceOffsetMinor: 0,
        allocationCapacityMinor: 2,
      },
      {
        seller: sellers[1],
        sourceAmountMinor: 4,
        amountUSDMinor: 4,
        allocationSourceOffsetMinor: 1,
        allocationCapacityMinor: 3,
      },
    ],
    orderId: 'legacy-residual-order',
  });
  expect(allocated[0].sellerAllocations).toEqual([{
    seller: sellers[0],
    sourceAmountMinor: 1,
    amountUSDMinor: 1,
  }]);
});

test('Wallet order payment validates strict seller settlement even when no funding provenance exists', async () => {
  const user = oid();
  const seller = oid();
  const wallet = await Wallet.create({ user, balances: { USD: 100 }, status: 'active' });
  const order = await createHistoricalWalletOrder({
    user,
    sellerAmounts: [[seller, 10000]],
  });
  await Order.collection.updateOne(
    { _id: order._id },
    {
      $set: {
        isPaid: false,
        awaitingPayment: true,
        inventoryCommitted: false,
        orderStatus: 'pending',
        currency: '',
      },
    },
  );

  await expect(payOrderWithWallet({ orderId: order._id, userId: user }))
    .rejects.toMatchObject({ code: 'ORDER_CURRENCY_INVALID' });
  expect(await Wallet.findById(wallet._id).lean()).toMatchObject({ balances: { USD: 100 } });
  expect(await WalletTransaction.countDocuments({
    wallet: wallet._id,
    type: 'order_payment',
  })).toBe(0);
  expect(await Order.findById(order._id).lean()).toMatchObject({
    isPaid: false,
    inventoryCommitted: false,
  });
});

test('reversing each one-cent top-up lot recovers its exact transported seller column', async () => {
  const user = oid();
  const sellerA = oid();
  const sellerB = oid();
  const wallet = await Wallet.create({ user, balances: { USD: 0 }, status: 'active' });
  const topUps = [];
  for (const suffix of ['one', 'two']) {
    topUps.push(await WalletTransaction.create({
      user,
      wallet: wallet._id,
      type: 'top_up',
      direction: 'credit',
      status: 'completed',
      amount: 0.01,
      currency: 'USD',
      balanceAfter: 0,
      description: `Tiny lot ${suffix}`,
      referenceType: 'stripe_payment_intent',
      referenceId: `pi_tiny_${suffix}`,
      idempotencyKey: `topup:tiny:${suffix}`,
      stripePaymentIntentId: `pi_tiny_${suffix}`,
      stripeChargeId: `ch_pi_tiny_${suffix}`,
      stripeMode: 'test',
      paymentFlow: 'payment_sheet',
      paymentSetupState: 'complete',
      metadata: {
        availableCreditedMinor: 1,
        fundingOriginalAvailableMinor: 1,
        fundingRemainingMinor: 0,
      },
      completedAt: new Date(),
    }));
  }
  const orderId = oid();
  const allocated = allocateFundingProvenanceToSellerSettlement({
    fundingProvenance: topUps.map(topUp => ({
      sourceType: 'wallet_top_up',
      sourceTransactionId: String(topUp._id),
      amountMinor: 1,
    })),
    settlementEntries: [
      { seller: String(sellerA), sourceAmountMinor: 1, amountUSDMinor: 1 },
      { seller: String(sellerB), sourceAmountMinor: 1, amountUSDMinor: 1 },
    ],
    orderId,
  });
  await WalletTransaction.create({
    user,
    wallet: wallet._id,
    type: 'order_payment',
    direction: 'debit',
    status: 'completed',
    amount: 0.02,
    currency: 'USD',
    balanceAfter: 0,
    description: 'Two tiny lots',
    referenceType: 'order',
    referenceId: String(orderId),
    idempotencyKey: 'order:two-tiny-lots',
    metadata: { fundingProvenance: allocated },
    completedAt: new Date(),
  });

  for (let index = 0; index < topUps.length; index += 1) {
    const topUp = topUps[index];
    await flagStripePaymentRisk({
      charge: {
        id: topUp.stripeChargeId,
        amount: 1,
        amount_refunded: 1,
        currency: 'usd',
        payment_intent: topUp.stripePaymentIntentId,
        metadata: {
          type: 'wallet_top_up',
          walletTransactionId: String(topUp._id),
        },
      },
      eventId: `evt_tiny_${index}`,
      eventType: 'charge.refunded',
    });
    const expectedSeller = allocated[index].sellerAllocations[0].seller;
    expect(await sellerLiabilityMinor(topUp, expectedSeller)).toBe(1);
    expect(await buyerLiabilityMinor(topUp)).toBe(0);
  }
  expect(await sellerLiabilityMinor(topUps[0]) + await sellerLiabilityMinor(topUps[1])).toBe(2);
});

test('legacy completed top-up replay attributes delivered seller revenue before reversal and conserves every cent', async () => {
  const user = oid();
  const sellers = [oid(), oid()];
  const wallet = await Wallet.create({ user, balances: { USD: 0 }, status: 'active' });
  const topUp = await WalletTransaction.create({
    user,
    wallet: wallet._id,
    type: 'top_up',
    direction: 'credit',
    status: 'completed',
    amount: 100,
    currency: 'USD',
    balanceAfter: 100,
    description: 'Historical card-funded Wallet top-up',
    referenceType: 'stripe_payment_intent',
    referenceId: 'pi_legacy_materialized',
    idempotencyKey: 'topup:legacy-materialized',
    stripePaymentIntentId: 'pi_legacy_materialized',
    stripeChargeId: 'ch_pi_legacy_materialized',
    stripeMode: 'test',
    paymentFlow: 'payment_sheet',
    paymentSetupState: 'complete',
    completedAt: new Date(Date.now() - 2000),
  });
  const order = await createHistoricalWalletOrder({
    user,
    sellerAmounts: [[sellers[0], 6000], [sellers[1], 4000]],
  });
  const debit = await WalletTransaction.create({
    user,
    wallet: wallet._id,
    type: 'order_payment',
    direction: 'debit',
    status: 'completed',
    amount: 100,
    currency: 'USD',
    balanceAfter: 0,
    description: 'Historical Wallet-funded order',
    referenceType: 'order',
    referenceId: String(order._id),
    idempotencyKey: `legacy-order:${order._id}`,
    metadata: { orderId: order.orderId, untrackedFundingMinor: 10000 },
    completedAt: new Date(Date.now() - 1000),
  });

  await applyRisk({ topUp, paymentIntentId: topUp.stripePaymentIntentId }, {
    refundedMinor: 10000,
  }, 'evt_legacy_materialized_refund', 'charge.refunded');

  const persistedTopUp = await WalletTransaction.findById(topUp._id).lean();
  expect(persistedTopUp.metadata).toMatchObject({
    availableCreditedMinor: 10000,
    fundingOriginalAvailableMinor: 10000,
    fundingRemainingMinor: 0,
    legacyFundingMaterialization: {
      version: 1,
      originalMinor: 10000,
      remainingMinor: 0,
      balanceAdjustmentMinor: 0,
      debitIds: [String(debit._id)],
    },
  });
  expect(persistedTopUp.metadata.legacyFundingMaterialization.fingerprint).toHaveLength(64);

  const provenance = (await WalletTransaction.findById(debit._id).lean())
    .metadata.fundingProvenance;
  expect(provenance).toHaveLength(1);
  expect(provenance[0]).toMatchObject({
    sourceType: 'wallet_top_up',
    sourceTransactionId: String(topUp._id),
    amountMinor: 10000,
    legacyMaterialized: true,
    orderId: String(order._id),
  });
  const sellerColumns = new Map(provenance[0].sellerAllocations.map(entry => [
    String(entry.seller), entry.sourceAmountMinor,
  ]));
  expect(sellerColumns.get(String(sellers[0]))).toBe(6000);
  expect(sellerColumns.get(String(sellers[1]))).toBe(4000);
  expect(await buyerLiabilityMinor(topUp)).toBe(0);
  expect(await sellerLiabilityMinor(topUp, sellers[0])).toBe(6000);
  expect(await sellerLiabilityMinor(topUp, sellers[1])).toBe(4000);
  expect(await SellerPaymentRiskHold.countDocuments({ status: 'pending' })).toBe(0);
});

test('legacy replay nets a historical seller-funded return back to the buyer before top-up reversal', async () => {
  const user = oid();
  const seller = oid();
  const wallet = await Wallet.create({ user, balances: { USD: 50 }, status: 'active' });
  const topUp = await WalletTransaction.create({
    user,
    wallet: wallet._id,
    type: 'top_up',
    direction: 'credit',
    status: 'completed',
    amount: 100,
    currency: 'USD',
    balanceAfter: 100,
    description: 'Historical top-up with later return',
    referenceType: 'stripe_payment_intent',
    referenceId: 'pi_legacy_historical_return',
    idempotencyKey: 'topup:legacy-historical-return',
    stripePaymentIntentId: 'pi_legacy_historical_return',
    stripeChargeId: 'ch_pi_legacy_historical_return',
    stripeMode: 'test',
    paymentFlow: 'payment_sheet',
    paymentSetupState: 'complete',
    completedAt: new Date(Date.now() - 3000),
  });
  const order = await createHistoricalWalletOrder({
    user,
    sellerAmounts: [[seller, 10000]],
  });
  await WalletTransaction.create({
    user,
    wallet: wallet._id,
    type: 'order_payment',
    direction: 'debit',
    status: 'completed',
    amount: 100,
    currency: 'USD',
    balanceAfter: 0,
    description: 'Historical order before return',
    referenceType: 'order',
    referenceId: String(order._id),
    idempotencyKey: `legacy-return-order:${order._id}`,
    metadata: { orderId: order.orderId, untrackedFundingMinor: 10000 },
    completedAt: new Date(Date.now() - 2000),
  });
  const line = order.orderItems[0];
  const request = await ReturnRequest.create({
    returnNumber: `RET-LEGACY-${oid()}`,
    order: order._id,
    orderId: order.orderId,
    buyer: user,
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
    reasonDetails: 'Historical partial return requiring provenance backfill.',
    status: 'returned',
    statusHistory: [{ status: 'returned', actorRole: 'system' }],
    eligibilityDeadline: new Date(Date.now() + 86400000),
    policySnapshot: { returnsEnabled: true, returnDuration: 30, refundType: 'full_refund' },
    refund: { itemSubtotal: 50, taxAmount: 0, shippingAmount: 0, discountAmount: 0, totalAmount: 50 },
    settlement: { fundingSource: 'seller_balance', status: 'completed', setupState: 'complete', settledAt: new Date() },
  });
  const returnCredit = await WalletTransaction.create({
    user,
    wallet: wallet._id,
    type: 'return_refund',
    direction: 'credit',
    status: 'completed',
    amount: 50,
    currency: 'USD',
    balanceAfter: 50,
    description: 'Historical seller-funded Wallet return',
    referenceType: 'return_request',
    referenceId: String(request._id),
    idempotencyKey: `return-refund:${request._id}`,
    metadata: {
      orderId: order.orderId,
      sellerId: String(seller),
      fundingProvenanceReturns: [],
      untrackedReturnedFundingMinor: 5000,
    },
    completedAt: new Date(Date.now() - 1000),
  });

  await applyRisk({ topUp, paymentIntentId: topUp.stripePaymentIntentId }, {
    refundedMinor: 10000,
  }, 'evt_legacy_historical_return_refund', 'charge.refunded');

  expect(await buyerLiabilityMinor(topUp)).toBe(5000);
  expect(await sellerLiabilityMinor(topUp, seller)).toBe(5000);
  expect((await Wallet.findById(wallet._id).lean()).balances.USD).toBe(0);
  expect(await WalletTransaction.findById(returnCredit._id).lean()).toMatchObject({
    metadata: {
      availableCreditedMinor: 5000,
      legacyFundingReturnMaterializationVersion: 1,
      fundingProvenanceReturns: [{
        sourceTransactionId: String(topUp._id),
        amountMinor: 5000,
        amountUSDMinor: 5000,
        seller: String(seller),
        orderId: String(order._id),
        availableRestoredMinor: 5000,
      }],
    },
  });
});

test('partial legacy funding counters quarantine buyer and every durable seller before reversal can fail', async () => {
  const user = oid();
  const seller = oid();
  const wallet = await Wallet.create({ user, balances: { USD: 0 }, status: 'active' });
  const topUp = await WalletTransaction.create({
    user,
    wallet: wallet._id,
    type: 'top_up',
    direction: 'credit',
    status: 'completed',
    amount: 50,
    currency: 'USD',
    balanceAfter: 50,
    description: 'Partially migrated historical top-up',
    referenceType: 'stripe_payment_intent',
    referenceId: 'pi_partial_legacy_counter',
    idempotencyKey: 'topup:partial-legacy-counter',
    stripePaymentIntentId: 'pi_partial_legacy_counter',
    stripeChargeId: 'ch_pi_partial_legacy_counter',
    stripeMode: 'test',
    paymentFlow: 'payment_sheet',
    paymentSetupState: 'complete',
    metadata: { fundingRemainingMinor: 0 },
    completedAt: new Date(Date.now() - 2000),
  });
  const order = await createHistoricalWalletOrder({
    user,
    sellerAmounts: [[seller, 5000]],
  });
  const debit = await WalletTransaction.create({
    user,
    wallet: wallet._id,
    type: 'order_payment',
    direction: 'debit',
    status: 'completed',
    amount: 50,
    currency: 'USD',
    balanceAfter: 0,
    description: 'Historical ambiguous funding',
    referenceType: 'order',
    referenceId: String(order._id),
    idempotencyKey: `legacy-partial-order:${order._id}`,
    metadata: { orderId: order.orderId, untrackedFundingMinor: 5000 },
    completedAt: new Date(Date.now() - 1000),
  });

  await expect(applyRisk({ topUp, paymentIntentId: topUp.stripePaymentIntentId }, {
    refundedMinor: 5000,
  }, 'evt_partial_legacy_counter', 'charge.refunded')).rejects.toMatchObject({
    code: 'WALLET_FUNDING_PROVENANCE_QUARANTINED',
  });

  expect(await Wallet.findById(wallet._id).lean()).toMatchObject({
    status: 'locked',
    lockSource: 'payment_risk',
  });
  expect(await SellerPaymentRiskHold.findOne({ seller, eventId: 'evt_partial_legacy_counter' }).lean())
    .toMatchObject({ status: 'pending', unknownExposure: true, riskTrackKey: 'refund' });
  expect((await WalletTransaction.findById(topUp._id).lean()).metadata).toEqual({
    fundingRemainingMinor: 0,
  });
  expect((await WalletTransaction.findById(debit._id).lean()).metadata).toMatchObject({
    untrackedFundingMinor: 5000,
  });
  expect(await SellerBalanceTransaction.countDocuments({ seller })).toBe(0);
});

test('legacy refund liability without sourceType is classified from immutable evidence and later credits settle it FIFO', async () => {
  const fixture = await createLegacyRiskTopUp({
    paymentIntentId: 'pi_legacy_refund_liability',
    walletBalanceMinor: 2500,
  });
  const legacyRow = await WalletTransaction.create({
    user: fixture.user,
    wallet: fixture.wallet._id,
    type: 'reversal',
    direction: 'debit',
    status: 'pending',
    amount: 100,
    currency: 'USD',
    balanceAfter: 25,
    description: 'Old-format Stripe refund liability',
    referenceType: 'stripe_refund',
    referenceId: 'evt_legacy_refund_liability',
    idempotencyKey: 'wallet-risk:evt_legacy_refund_liability',
    stripeChargeId: fixture.topUp.stripeChargeId,
    metadata: {
      sourceTopUpTransactionId: String(fixture.topUp._id),
      stripeEventType: 'charge.refunded',
      stripeEventId: 'evt_legacy_refund_liability',
      amountMinor: 10000,
    },
  });

  const firstSummary = await getWalletSummary(fixture.user);
  expect(firstSummary.wallet).toMatchObject({
    status: 'locked',
    balances: { USD: 0 },
    paymentRisk: { restricted: true },
  });
  expect(await WalletTransaction.findById(legacyRow._id).lean()).toMatchObject({
    status: 'completed',
    balanceAfter: 0,
    metadata: {
      sourceType: 'wallet_top_up',
      sourcePaymentTransactionId: String(fixture.topUp._id),
      riskTrack: 'refund',
      liabilityState: 'terminal',
      liabilityMinor: 10000,
      collectedMinor: 2500,
      outstandingMinor: 7500,
    },
  });

  const partialCredit = await runInTransaction(session => creditWalletInSession({
    userId: fixture.user,
    amount: 30,
    currency: 'USD',
    type: 'return_refund',
    referenceType: 'return_request',
    referenceId: 'legacy-refund-credit-30',
    idempotencyKey: 'legacy-refund-credit-30',
    description: 'Credit collected into legacy refund liability',
    allowLocked: true,
  }, session));
  expect(partialCredit).toMatchObject({
    balanceAfter: 0,
    metadata: { liabilityAppliedMinor: 3000, availableCreditedMinor: 0, remainingLiabilityMinor: 4500 },
  });
  expect((await Wallet.findById(fixture.wallet._id).lean()).status).toBe('locked');

  await runInTransaction(session => creditWalletInSession({
    userId: fixture.user,
    amount: 45,
    currency: 'USD',
    type: 'return_refund',
    referenceType: 'return_request',
    referenceId: 'legacy-refund-credit-45',
    idempotencyKey: 'legacy-refund-credit-45',
    description: 'Final credit collected into legacy refund liability',
    allowLocked: true,
  }, session));
  expect(await Wallet.findById(fixture.wallet._id).lean()).toMatchObject({
    status: 'active',
    balances: { USD: 0 },
  });
  expect(await WalletTransaction.findById(legacyRow._id).lean()).toMatchObject({
    metadata: { collectedMinor: 10000, outstandingMinor: 0 },
  });
});

test('legacy dispute liability holds later credits and a uniquely bound won event releases cash exactly once', async () => {
  const fixture = await createLegacyRiskTopUp({
    paymentIntentId: 'pi_legacy_dispute_liability',
    walletBalanceMinor: 4000,
  });
  const legacyRow = await WalletTransaction.create({
    user: fixture.user,
    wallet: fixture.wallet._id,
    type: 'reversal',
    direction: 'debit',
    status: 'pending',
    amount: 100,
    currency: 'USD',
    balanceAfter: 40,
    description: 'Old-format Stripe dispute liability',
    referenceType: 'stripe_dispute',
    referenceId: 'evt_legacy_dispute_withdrawn',
    idempotencyKey: 'wallet-risk:evt_legacy_dispute_withdrawn',
    stripeChargeId: fixture.topUp.stripeChargeId,
    metadata: {
      sourceTopUpTransactionId: String(fixture.topUp._id),
      stripeEventType: 'charge.dispute.funds_withdrawn',
      stripeEventId: 'evt_legacy_dispute_withdrawn',
      amountMinor: 10000,
    },
  });

  await getWalletSummary(fixture.user);
  expect(await WalletTransaction.findById(legacyRow._id).lean()).toMatchObject({
    status: 'pending',
    metadata: {
      liabilityState: 'provisional',
      heldMinor: 4000,
      outstandingMinor: 6000,
      requiresManualDisputeIdentity: true,
    },
  });
  await runInTransaction(session => creditWalletInSession({
    userId: fixture.user,
    amount: 20,
    currency: 'USD',
    type: 'return_refund',
    referenceType: 'return_request',
    referenceId: 'legacy-dispute-held-credit',
    idempotencyKey: 'legacy-dispute-held-credit',
    description: 'Credit held for unresolved legacy dispute',
    allowLocked: true,
  }, session));
  expect(await WalletTransaction.findById(legacyRow._id).lean()).toMatchObject({
    metadata: { heldMinor: 6000, outstandingMinor: 4000 },
  });

  const wonDetails = {
    disputeId: 'dp_legacy_dispute_bound',
    disputeMinor: 10000,
    disputeStatus: 'won',
  };
  await applyRisk(fixture, wonDetails, 'evt_legacy_dispute_won', 'charge.dispute.closed');
  await applyRisk(fixture, wonDetails, 'evt_legacy_dispute_won_retry', 'charge.dispute.closed');
  expect(await Wallet.findById(fixture.wallet._id).lean()).toMatchObject({
    status: 'active',
    balances: { USD: 60 },
  });
  expect(await WalletTransaction.findById(legacyRow._id).lean()).toMatchObject({
    status: 'reversed',
    metadata: {
      disputeId: 'dp_legacy_dispute_bound',
      requiresManualDisputeIdentity: false,
      disputeResolution: 'won',
      heldMinor: 0,
      outstandingMinor: 0,
    },
  });
  expect((await WalletTransaction.findById(fixture.topUp._id).lean()).metadata.fundingRemainingMinor)
    .toBe(6000);
});

test('full top-up refund follows spent principal to multiple sellers and conserves every cent', async () => {
  const sellerA = oid();
  const sellerB = oid();
  const fixture = await createFundedTopUp({
    remainingMinor: 2000,
    sellerAllocations: [
      { seller: String(sellerA), sourceAmountMinor: 3000, amountUSDMinor: 3000 },
      { seller: String(sellerB), sourceAmountMinor: 5000, amountUSDMinor: 5000 },
    ],
    paymentIntentId: 'pi_provenance_full_refund',
  });

  await applyRisk(fixture, { refundedMinor: 10000 }, 'evt_provenance_full_refund', 'charge.refunded');
  expect(await buyerLiabilityMinor(fixture.topUp)).toBe(2000);
  expect(await sellerLiabilityMinor(fixture.topUp, sellerA)).toBe(3000);
  expect(await sellerLiabilityMinor(fixture.topUp, sellerB)).toBe(5000);
  expect(await buyerLiabilityMinor(fixture.topUp) + await sellerLiabilityMinor(fixture.topUp)).toBe(10000);
  expect((await Wallet.findById(fixture.wallet._id)).balances.USD).toBe(0);
  expect((await WalletTransaction.findOne({ type: 'reversal' })).balanceAfter).toBe(0);
  expect(await SellerPaymentRiskHold.countDocuments({ status: 'pending' })).toBe(0);
});

test('concurrent duplicate refund delivery converges to one exact buyer/seller recovery', async () => {
  const seller = oid();
  const fixture = await createFundedTopUp({
    remainingMinor: 2500,
    sellerAllocations: [{
      seller: String(seller),
      sourceAmountMinor: 7500,
      amountUSDMinor: 7500,
    }],
    paymentIntentId: 'pi_concurrent_provenance_refund',
  });
  const event = () => applyRisk(
    fixture,
    { refundedMinor: 10000 },
    'evt_concurrent_provenance_refund',
    'charge.refunded',
  );

  await Promise.all([event(), event()]);
  await event();

  expect(await buyerLiabilityMinor(fixture.topUp)).toBe(2500);
  expect(await sellerLiabilityMinor(fixture.topUp, seller)).toBe(7500);
  expect(await WalletTransaction.countDocuments({
    type: 'reversal',
    'metadata.sourcePaymentTransactionId': String(fixture.topUp._id),
  })).toBe(1);
  expect(await SellerPaymentRiskHold.countDocuments({ status: 'pending' })).toBe(0);
});

test('refund and dispute arrival orders conserve aggregate holders and cap sellers while excess stays buyer liability', async () => {
  const seller = oid();
  const make = paymentIntentId => createFundedTopUp({
    remainingMinor: 2000,
    sellerAllocations: [{ seller: String(seller), sourceAmountMinor: 8000, amountUSDMinor: 8000 }],
    paymentIntentId,
  });
  const refundFirst = await make('pi_refund_first');
  await applyRisk(refundFirst, { refundedMinor: 2000 }, 'evt_rf_refund', 'charge.refunded');
  await applyRisk(refundFirst, {
    refundedMinor: 2000,
    disputeId: 'dp_rf',
    disputeMinor: 8000,
    disputeStatus: 'lost',
  }, 'evt_rf_dispute', 'charge.dispute.closed');

  const disputeFirst = await make('pi_dispute_first');
  await applyRisk(disputeFirst, {
    disputeId: 'dp_df',
    disputeMinor: 8000,
    disputeStatus: 'lost',
  }, 'evt_df_dispute', 'charge.dispute.closed');
  await applyRisk(disputeFirst, { refundedMinor: 2000 }, 'evt_df_refund', 'charge.refunded');

  for (const fixture of [refundFirst, disputeFirst]) {
    expect(await buyerLiabilityMinor(fixture.topUp)).toBe(2000);
    expect(await sellerLiabilityMinor(fixture.topUp)).toBe(8000);
  }

  const over = await make('pi_over_exposure');
  await applyRisk(over, { refundedMinor: 3000 }, 'evt_over_refund', 'charge.refunded');
  await applyRisk(over, {
    refundedMinor: 3000,
    disputeId: 'dp_over',
    disputeMinor: 10000,
    disputeStatus: 'lost',
  }, 'evt_over_dispute', 'charge.dispute.closed');
  expect(await buyerLiabilityMinor(over.topUp)).toBe(5000);
  expect(await sellerLiabilityMinor(over.topUp)).toBe(8000);
  expect(await buyerLiabilityMinor(over.topUp) + await sellerLiabilityMinor(over.topUp)).toBe(13000);
});

test('growing an earlier refund rebalances an active dispute and dispute-won converges without moving aggregate cents', async () => {
  const seller = oid();
  const fixture = await createFundedTopUp({
    remainingMinor: 2000,
    sellerAllocations: [{ seller: String(seller), sourceAmountMinor: 8000, amountUSDMinor: 8000 }],
    paymentIntentId: 'pi_track_rebalance',
  });
  await applyRisk(fixture, { refundedMinor: 1000 }, 'evt_rebalance_refund_10', 'charge.refunded');
  await applyRisk(fixture, {
    refundedMinor: 1000,
    disputeId: 'dp_rebalance',
    disputeMinor: 5000,
    disputeStatus: 'needs_response',
  }, 'evt_rebalance_dispute_50', 'charge.dispute.funds_withdrawn');
  await applyRisk(fixture, { refundedMinor: 3000 }, 'evt_rebalance_refund_30', 'charge.refunded');

  expect(await buyerLiabilityMinor(fixture.topUp)).toBe(2000);
  expect(await sellerLiabilityMinor(fixture.topUp, seller)).toBe(6000);
  expect(await buyerLiabilityMinor(fixture.topUp) + await sellerLiabilityMinor(fixture.topUp)).toBe(8000);
  expect((await Wallet.findById(fixture.wallet._id)).balances.USD).toBe(0);
  expect(await WalletTransaction.exists({
    type: 'reversal',
    direction: 'credit',
    'metadata.allocationAdjustment': true,
    'metadata.riskTrackKey': 'dispute:dp_rebalance',
  })).toBeTruthy();

  await applyRisk(fixture, {
    refundedMinor: 3000,
    disputeId: 'dp_rebalance',
    disputeMinor: 5000,
    disputeStatus: 'won',
  }, 'evt_rebalance_dispute_won', 'charge.dispute.closed');
  expect(await buyerLiabilityMinor(fixture.topUp)).toBe(2000);
  expect(await sellerLiabilityMinor(fixture.topUp, seller)).toBe(1000);
  expect((await Wallet.findById(fixture.wallet._id)).balances.USD).toBe(0);

  await applyRisk(fixture, {
    refundedMinor: 3000,
    disputeId: 'dp_rebalance',
    disputeMinor: 5000,
    disputeStatus: 'needs_response',
  }, 'evt_rebalance_delayed_dispute', 'charge.dispute.funds_withdrawn');
  expect(await buyerLiabilityMinor(fixture.topUp)).toBe(2000);
  expect(await sellerLiabilityMinor(fixture.topUp, seller)).toBe(1000);
});

test('later seller spend is recomputed after a terminal partial refund and included in a larger refund', async () => {
  const sellerA = oid();
  const sellerB = oid();
  const fixture = await createFundedTopUp({
    remainingMinor: 2000,
    sellerAllocations: [{ seller: String(sellerA), sourceAmountMinor: 8000, amountUSDMinor: 8000 }],
    paymentIntentId: 'pi_temporal_provenance',
  });
  await applyRisk(fixture, { refundedMinor: 1000 }, 'evt_temporal_10', 'charge.refunded');
  expect(await buyerLiabilityMinor(fixture.topUp)).toBe(1000);
  expect((await Wallet.findById(fixture.wallet._id)).status).toBe('active');

  await WalletTransaction.updateOne(
    { _id: fixture.topUp._id },
    { $set: { 'metadata.fundingRemainingMinor': 0 } },
  );
  await Wallet.updateOne({ _id: fixture.wallet._id }, { $set: { 'balances.USD': 0 } });
  await WalletTransaction.create({
    user: fixture.user,
    wallet: fixture.wallet._id,
    type: 'order_payment',
    direction: 'debit',
    status: 'completed',
    amount: 10,
    currency: 'USD',
    balanceAfter: 0,
    description: 'Later seller order',
    referenceType: 'order',
    referenceId: String(oid()),
    idempotencyKey: 'temporal-later-order',
    metadata: { fundingProvenance: [{
      sourceType: 'wallet_top_up',
      sourceTransactionId: String(fixture.topUp._id),
      amountMinor: 1000,
      orderId: String(oid()),
      sellerAllocations: [{ seller: String(sellerB), sourceAmountMinor: 1000, amountUSDMinor: 1000 }],
    }] },
    completedAt: new Date(),
  });
  await applyRisk(fixture, { refundedMinor: 10000 }, 'evt_temporal_100', 'charge.refunded');
  expect(await buyerLiabilityMinor(fixture.topUp)).toBe(1000);
  expect(await sellerLiabilityMinor(fixture.topUp, sellerA)).toBe(8000);
  expect(await sellerLiabilityMinor(fixture.topUp, sellerB)).toBe(1000);
});

test('a completed return moves top-up provenance from the original seller to buyer and a later seller without double debit', async () => {
  const sellerA = oid();
  const sellerB = oid();
  const fixture = await createFundedTopUp({
    remainingMinor: 0,
    sellerAllocations: [{ seller: String(sellerA), sourceAmountMinor: 10000, amountUSDMinor: 10000 }],
    paymentIntentId: 'pi_returned_then_reversed',
  });
  const returnRequestId = oid();
  await runInTransaction(async session => {
    await Wallet.updateOne(
      { _id: fixture.wallet._id },
      { $set: { 'balances.USD': 100 } },
      { session },
    );
    const [returnCredit] = await WalletTransaction.create([{
      user: fixture.user,
      wallet: fixture.wallet._id,
      type: 'return_refund',
      direction: 'credit',
      status: 'completed',
      amount: 100,
      currency: 'USD',
      balanceAfter: 100,
      description: 'Returned original order',
      referenceType: 'return_request',
      referenceId: String(returnRequestId),
      idempotencyKey: `return:${returnRequestId}`,
      metadata: { availableCreditedMinor: 10000 },
      completedAt: new Date(),
    }], { session });
    await attachReturnedWalletFundingProvenance({
      walletTransaction: returnCredit,
      orderId: fixture.orderId,
      sellerId: sellerA,
      returnRequestId,
      refundAmount: 100,
      currency: 'USD',
      session,
    });
  });
  expect((await WalletTransaction.findById(fixture.topUp._id)).metadata.fundingRemainingMinor).toBe(10000);

  const secondOrderId = oid();
  await runInTransaction(async session => {
    await Wallet.updateOne(
      { _id: fixture.wallet._id },
      { $set: { 'balances.USD': 60 } },
      { session },
    );
    await WalletTransaction.updateOne(
      { _id: fixture.topUp._id },
      { $set: { 'metadata.fundingRemainingMinor': 6000 } },
      { session },
    );
    await WalletTransaction.create([{
      user: fixture.user,
      wallet: fixture.wallet._id,
      type: 'order_payment',
      direction: 'debit',
      status: 'completed',
      amount: 40,
      currency: 'USD',
      balanceAfter: 60,
      description: 'Re-spent returned top-up funding',
      referenceType: 'order',
      referenceId: String(secondOrderId),
      idempotencyKey: `order:${secondOrderId}`,
      metadata: { fundingProvenance: [{
        sourceType: 'wallet_top_up',
        sourceTransactionId: String(fixture.topUp._id),
        amountMinor: 4000,
        orderId: String(secondOrderId),
        sellerAllocations: [{ seller: String(sellerB), sourceAmountMinor: 4000, amountUSDMinor: 4000 }],
      }] },
      completedAt: new Date(),
    }], { session });
  });

  await applyRisk(fixture, { refundedMinor: 10000 }, 'evt_returned_then_reversed', 'charge.refunded');
  expect(await buyerLiabilityMinor(fixture.topUp)).toBe(6000);
  expect(await sellerLiabilityMinor(fixture.topUp, sellerA)).toBe(0);
  expect(await sellerLiabilityMinor(fixture.topUp, sellerB)).toBe(4000);
  expect((await Wallet.findById(fixture.wallet._id)).balances.USD).toBe(0);
});

test('returned funding rejects coercible Mixed money metadata instead of treating it as exact minor units', async () => {
  const seller = oid();
  const fixture = await createFundedTopUp({
    remainingMinor: 0,
    sellerAllocations: [{ seller: String(seller), sourceAmountMinor: 10000, amountUSDMinor: 10000 }],
    paymentIntentId: 'pi_return_mixed_money_guard',
  });

  const makeReturnCredit = async (suffix, availableCreditedMinor) => WalletTransaction.create({
    user: fixture.user,
    wallet: fixture.wallet._id,
    type: 'return_refund',
    direction: 'credit',
    status: 'completed',
    amount: 100,
    currency: 'USD',
    balanceAfter: 100,
    description: 'Corrupt returned funding fixture',
    referenceType: 'return_request',
    referenceId: String(oid()),
    idempotencyKey: `return:mixed-money:${suffix}`,
    metadata: { availableCreditedMinor },
    completedAt: new Date(),
  });

  const stringCredit = await makeReturnCredit('string', '10000');
  await expect(runInTransaction(session => attachReturnedWalletFundingProvenance({
    walletTransaction: stringCredit,
    orderId: fixture.orderId,
    sellerId: seller,
    returnRequestId: stringCredit.referenceId,
    refundAmount: 100,
    currency: 'USD',
    session,
  }))).rejects.toMatchObject({ code: 'WALLET_FUNDING_PROVENANCE_INVALID' });

  const orderPayment = await WalletTransaction.findOne({
    type: 'order_payment',
    referenceId: String(fixture.orderId),
  });
  await WalletTransaction.collection.updateOne({ _id: orderPayment._id }, {
    $set: { 'metadata.fundingProvenance.0.sellerAllocations.0.sourceAmountMinor': true },
  });
  const booleanAllocationCredit = await makeReturnCredit('boolean-allocation', 10000);
  await expect(runInTransaction(session => attachReturnedWalletFundingProvenance({
    walletTransaction: booleanAllocationCredit,
    orderId: fixture.orderId,
    sellerId: seller,
    returnRequestId: booleanAllocationCredit.referenceId,
    refundAmount: 100,
    currency: 'USD',
    session,
  }))).rejects.toMatchObject({ code: 'WALLET_FUNDING_PROVENANCE_INVALID' });
});

test('partial PKR returns use cumulative USD deltas and fully move the seller lot back to buyer', async () => {
  const user = oid();
  const seller = oid();
  const orderId = oid();
  const wallet = await Wallet.create({ user, balances: { PKR: 0 }, status: 'active' });
  const topUp = await WalletTransaction.create({
    user,
    wallet: wallet._id,
    type: 'top_up',
    direction: 'credit',
    status: 'completed',
    amount: 0.03,
    currency: 'PKR',
    balanceAfter: 0,
    description: 'Three-cent PKR top-up',
    referenceType: 'stripe_payment_intent',
    referenceId: 'pi_pkr_return_provenance',
    idempotencyKey: 'topup:pkr-return-provenance',
    stripePaymentIntentId: 'pi_pkr_return_provenance',
    stripeChargeId: 'ch_pi_pkr_return_provenance',
    stripeMode: 'test',
    paymentFlow: 'payment_sheet',
    paymentSetupState: 'complete',
    metadata: {
      availableCreditedMinor: 3,
      fundingOriginalAvailableMinor: 3,
      fundingRemainingMinor: 0,
    },
    completedAt: new Date(),
  });
  await WalletTransaction.create({
    user,
    wallet: wallet._id,
    type: 'order_payment',
    direction: 'debit',
    status: 'completed',
    amount: 0.03,
    currency: 'PKR',
    balanceAfter: 0,
    description: 'PKR funded order',
    referenceType: 'order',
    referenceId: String(orderId),
    idempotencyKey: 'order:pkr-return-provenance',
    metadata: { fundingProvenance: [{
      sourceType: 'wallet_top_up',
      sourceTransactionId: String(topUp._id),
      amountMinor: 3,
      orderId: String(orderId),
      sellerAllocations: [{ seller: String(seller), sourceAmountMinor: 3, amountUSDMinor: 1 }],
    }] },
    completedAt: new Date(),
  });

  const usdDeltas = [];
  for (const [index, amountMinor] of [1, 2].entries()) {
    const returnRequestId = oid();
    await runInTransaction(async session => {
      const nextBalanceMinor = index === 0 ? 1 : 3;
      await Wallet.updateOne(
        { _id: wallet._id },
        { $set: { 'balances.PKR': nextBalanceMinor / 100 } },
        { session },
      );
      const [credit] = await WalletTransaction.create([{
        user,
        wallet: wallet._id,
        type: 'return_refund',
        direction: 'credit',
        status: 'completed',
        amount: amountMinor / 100,
        currency: 'PKR',
        balanceAfter: nextBalanceMinor / 100,
        description: 'Partial PKR return',
        referenceType: 'return_request',
        referenceId: String(returnRequestId),
        idempotencyKey: `return:pkr:${index}`,
        metadata: { availableCreditedMinor: amountMinor },
        completedAt: new Date(),
      }], { session });
      const movements = await attachReturnedWalletFundingProvenance({
        walletTransaction: credit,
        orderId,
        sellerId: seller,
        returnRequestId,
        refundAmount: amountMinor / 100,
        currency: 'PKR',
        session,
      });
      usdDeltas.push(movements[0].amountUSDMinor);
    });
  }
  expect(usdDeltas).toEqual([0, 1]);
  expect((await WalletTransaction.findById(topUp._id)).metadata.fundingRemainingMinor).toBe(3);

  await flagStripePaymentRisk({
    charge: {
      id: topUp.stripeChargeId,
      amount: 3,
      amount_refunded: 3,
      currency: 'pkr',
      payment_intent: topUp.stripePaymentIntentId,
      metadata: { type: 'wallet_top_up', walletTransactionId: String(topUp._id) },
    },
    eventId: 'evt_pkr_return_provenance',
    eventType: 'charge.refunded',
  });
  expect(await buyerLiabilityMinor(topUp)).toBe(3);
  expect(await sellerLiabilityMinor(topUp, seller)).toBe(0);
  expect((await Wallet.findById(wallet._id)).balances.PKR).toBe(0);
});

test('early reversal marker blocks top-up completion and grants no Wallet balance', async () => {
  const user = oid();
  const wallet = await Wallet.create({ user, balances: { USD: 0 }, status: 'active' });
  const topUp = await WalletTransaction.create({
    user,
    wallet: wallet._id,
    type: 'top_up',
    direction: 'credit',
    status: 'pending',
    amount: 100,
    currency: 'USD',
    description: 'Pending early reversal',
    referenceType: 'stripe_payment_intent',
    referenceId: 'early-risk',
    idempotencyKey: 'early-risk-topup',
    stripePaymentIntentId: 'pi_early_risk',
    stripeCustomerId: 'cus_early_risk',
    stripeMode: 'test',
    paymentFlow: 'payment_sheet',
    paymentSetupState: 'ready',
  });
  const charge = riskCharge({
    topUp,
    paymentIntentId: 'pi_early_risk',
    refundedMinor: 10000,
  });
  const blocked = await flagStripePaymentRisk({
    charge,
    eventId: 'evt_early_risk',
    eventType: 'charge.refunded',
  });
  expect(blocked.preCompletionBlocked).toBe(true);

  const unrelatedWon = await applyRisk({ topUp, paymentIntentId: 'pi_early_risk' }, {
    disputeId: 'dp_unrelated_won',
    disputeMinor: 10000,
    disputeStatus: 'won',
  }, 'evt_unrelated_early_dispute_won', 'charge.dispute.closed');
  expect(unrelatedWon).toMatchObject({
    handled: true,
    preCompletionResolved: false,
    stillBlocked: true,
  });
  expect(await StripePaymentRiskMarker.findOne({ paymentIntentId: 'pi_early_risk' }).lean())
    .toMatchObject({ refundBlocked: true, blocked: true, completionState: 'blocked' });

  const paymentIntent = {
    id: 'pi_early_risk',
    status: 'succeeded',
    amount: 10000,
    amount_received: 10000,
    currency: 'usd',
    customer: 'cus_early_risk',
    latest_charge: 'ch_pi_early_risk',
    livemode: false,
    metadata: {
      type: 'wallet_top_up',
      paymentFlow: 'payment_sheet',
      walletTransactionId: String(topUp._id),
      userId: String(user),
      amountMinor: '10000',
      currency: 'USD',
      stripeMode: 'test',
    },
  };
  await expect(completeWalletTopUpFromPaymentIntent(paymentIntent, 'evt_success_late'))
    .rejects.toMatchObject({ code: 'STRIPE_PAYMENT_REVERSED_BEFORE_COMPLETION' });
  expect((await Wallet.findById(wallet._id)).balances.USD).toBe(0);
  expect(await WalletTransaction.findById(topUp._id)).toMatchObject({
    status: 'reversed',
    paymentSetupState: 'closed',
  });
});

test('an early won dispute unblocks only its own marker and delayed financial delivery cannot reverse completed value', async () => {
  const user = oid();
  const wallet = await Wallet.create({ user, balances: { USD: 0 }, status: 'active' });
  const topUp = await WalletTransaction.create({
    user,
    wallet: wallet._id,
    type: 'top_up',
    direction: 'credit',
    status: 'pending',
    amount: 100,
    currency: 'USD',
    description: 'Pending early dispute',
    referenceType: 'stripe_payment_intent',
    referenceId: 'early-dispute',
    idempotencyKey: 'early-dispute-topup',
    stripePaymentIntentId: 'pi_early_dispute',
    stripeCustomerId: 'cus_early_dispute',
    stripeMode: 'test',
    paymentFlow: 'payment_sheet',
    paymentSetupState: 'ready',
  });
  const fixture = { topUp, paymentIntentId: 'pi_early_dispute' };
  const blocked = await applyRisk(fixture, {
    disputeId: 'dp_early_dispute',
    disputeMinor: 10000,
    disputeStatus: 'needs_response',
  }, 'evt_early_dispute_withdrawn', 'charge.dispute.funds_withdrawn');
  expect(blocked.preCompletionBlocked).toBe(true);

  const paymentIntent = {
    id: 'pi_early_dispute',
    status: 'succeeded',
    amount: 10000,
    amount_received: 10000,
    currency: 'usd',
    customer: 'cus_early_dispute',
    latest_charge: 'ch_pi_early_dispute',
    livemode: false,
    metadata: {
      type: 'wallet_top_up',
      paymentFlow: 'payment_sheet',
      walletTransactionId: String(topUp._id),
      userId: String(user),
      amountMinor: '10000',
      currency: 'USD',
      stripeMode: 'test',
    },
  };
  mockPaymentIntentRetrieve.mockResolvedValue(paymentIntent);

  const resolved = await applyRisk(fixture, {
    disputeId: 'dp_early_dispute',
    disputeMinor: 10000,
    disputeStatus: 'won',
  }, 'evt_early_dispute_won', 'charge.dispute.closed');
  expect(resolved).toMatchObject({
    handled: true,
    preCompletionResolved: true,
    stillBlocked: false,
    recovery: { recovered: true },
  });
  expect(await StripePaymentRiskMarker.findOne({ paymentIntentId: 'pi_early_dispute' }).lean())
    .toMatchObject({ blocked: false, completionState: 'completed' });
  await expect(completeWalletTopUpFromPaymentIntent(paymentIntent, 'evt_early_dispute_success'))
    .resolves.toMatchObject({ status: 'completed' });
  expect((await Wallet.findById(wallet._id)).balances.USD).toBe(100);

  const delayed = await applyRisk(fixture, {
    disputeId: 'dp_early_dispute',
    disputeMinor: 10000,
    disputeStatus: 'needs_response',
  }, 'evt_early_dispute_delayed', 'charge.dispute.funds_withdrawn');
  expect(delayed).toMatchObject({ handled: true, ignoredOutOfOrder: true });
  expect((await Wallet.findById(wallet._id)).balances.USD).toBe(100);
  expect(await WalletTransaction.countDocuments({
    type: 'reversal',
    'metadata.sourcePaymentTransactionId': String(topUp._id),
  })).toBe(0);
});

test('completion blocked by an early dispute is recovered exactly once after won, including concurrent replays', async () => {
  const user = oid();
  const wallet = await Wallet.create({ user, balances: { USD: 0 }, status: 'active' });
  const topUp = await WalletTransaction.create({
    user,
    wallet: wallet._id,
    type: 'top_up',
    direction: 'credit',
    status: 'pending',
    amount: 100,
    currency: 'USD',
    description: 'Captured top-up blocked before completion',
    referenceType: 'stripe_payment_intent',
    referenceId: 'blocked-then-won',
    idempotencyKey: 'topup:blocked-then-won',
    stripePaymentIntentId: 'pi_blocked_then_won',
    stripeCustomerId: 'cus_blocked_then_won',
    stripeMode: 'test',
    paymentFlow: 'payment_sheet',
    paymentSetupState: 'ready',
  });
  const fixture = { topUp, paymentIntentId: topUp.stripePaymentIntentId };
  await applyRisk(fixture, {
    disputeId: 'dp_blocked_then_won',
    disputeMinor: 10000,
    disputeStatus: 'needs_response',
  }, 'evt_blocked_then_won_withdrawn', 'charge.dispute.funds_withdrawn');

  const paymentIntent = {
    id: topUp.stripePaymentIntentId,
    status: 'succeeded',
    amount: 10000,
    amount_received: 10000,
    currency: 'usd',
    customer: 'cus_blocked_then_won',
    latest_charge: 'ch_pi_blocked_then_won',
    livemode: false,
    metadata: {
      type: 'wallet_top_up',
      paymentFlow: 'payment_sheet',
      walletTransactionId: String(topUp._id),
      userId: String(user),
      amountMinor: '10000',
      currency: 'USD',
      stripeMode: 'test',
    },
  };
  await expect(completeWalletTopUpFromPaymentIntent(paymentIntent, 'evt_blocked_success'))
    .rejects.toMatchObject({ code: 'STRIPE_PAYMENT_REVERSED_BEFORE_COMPLETION' });
  expect(await WalletTransaction.findById(topUp._id).lean()).toMatchObject({
    status: 'reversed',
    paymentSetupState: 'closed',
    metadata: { paymentRiskBlockedBeforeCompletion: true },
  });

  mockPaymentIntentRetrieve.mockResolvedValue(paymentIntent);
  const won = {
    disputeId: 'dp_blocked_then_won',
    disputeMinor: 10000,
    // funds_reinstated is semantically won even when the expanded dispute
    // status is absent on this delivery.
    disputeStatus: '',
  };
  const results = await Promise.all([
    applyRisk(fixture, won, 'evt_blocked_then_won_won', 'charge.dispute.funds_reinstated'),
    applyRisk(fixture, won, 'evt_blocked_then_won_won', 'charge.dispute.funds_reinstated'),
  ]);
  expect(results.every(result => result.handled && result.stillBlocked === false)).toBe(true);
  expect(await Wallet.findById(wallet._id).lean()).toMatchObject({
    status: 'active',
    balances: { USD: 100 },
  });
  expect(await WalletTransaction.findById(topUp._id).lean()).toMatchObject({
    status: 'completed',
    paymentSetupState: 'complete',
    balanceAfter: 100,
    metadata: {
      availableCreditedMinor: 10000,
      fundingOriginalAvailableMinor: 10000,
      fundingRemainingMinor: 10000,
      paymentRiskBlockedBeforeCompletionResolved: true,
    },
  });
  expect(await StripePaymentRiskMarker.findOne({ paymentIntentId: topUp.stripePaymentIntentId }).lean())
    .toMatchObject({ blocked: false, completionState: 'completed' });

  await completeWalletTopUpFromPaymentIntent(paymentIntent, 'evt_blocked_success_replay');
  expect((await Wallet.findById(wallet._id).lean()).balances.USD).toBe(100);
});

test('hosted Checkout blocked completion durably preserves both Session and PaymentIntent references', async () => {
  const user = oid();
  const wallet = await Wallet.create({ user, balances: { USD: 0 }, status: 'active' });
  const topUp = await WalletTransaction.create({
    user,
    wallet: wallet._id,
    type: 'top_up',
    direction: 'credit',
    status: 'pending',
    amount: 25,
    currency: 'USD',
    description: 'Hosted top-up blocked before completion',
    referenceType: 'stripe_checkout',
    referenceId: 'hosted-blocked',
    idempotencyKey: 'topup:hosted-blocked',
    stripeSessionId: 'cs_hosted_blocked',
    stripeCustomerId: 'cus_hosted_blocked',
    stripeMode: 'test',
    paymentFlow: 'checkout_session',
    paymentSetupState: 'ready',
  });
  await applyRisk({ topUp, paymentIntentId: 'pi_hosted_blocked' }, {
    disputeId: 'dp_hosted_blocked',
    disputeMinor: 2500,
    disputeStatus: 'needs_response',
    amountMinor: 2500,
  }, 'evt_hosted_blocked_withdrawn', 'charge.dispute.funds_withdrawn');
  const checkoutSession = {
    id: topUp.stripeSessionId,
    mode: 'payment',
    payment_status: 'paid',
    amount_total: 2500,
    currency: 'usd',
    customer: 'cus_hosted_blocked',
    payment_intent: 'pi_hosted_blocked',
    livemode: false,
    metadata: {
      type: 'wallet_top_up',
      paymentFlow: 'checkout_session',
      walletTransactionId: String(topUp._id),
      userId: String(user),
      amountMinor: '2500',
      currency: 'USD',
      stripeMode: 'test',
    },
  };
  await expect(completeWalletTopUp(checkoutSession, 'evt_hosted_blocked_success'))
    .rejects.toMatchObject({ code: 'STRIPE_PAYMENT_REVERSED_BEFORE_COMPLETION' });
  expect(await WalletTransaction.findById(topUp._id).lean()).toMatchObject({
    status: 'reversed',
    paymentFlow: 'checkout_session',
    paymentSetupState: 'closed',
    stripeSessionId: 'cs_hosted_blocked',
    stripePaymentIntentId: 'pi_hosted_blocked',
    metadata: { paymentRiskBlockedBeforeCompletion: true },
  });
  expect((await Wallet.findById(wallet._id).lean()).balances.USD).toBe(0);
});

test('hosted Checkout PaymentIntent lifecycle events are deferred for every hosted commerce type', () => {
  expect(isHostedCheckoutPaymentIntent({ metadata: {
    type: 'wallet_top_up', paymentFlow: 'checkout_session',
  } })).toBe(true);
  expect(isHostedCheckoutPaymentIntent({ metadata: {
    type: 'order_payment', paymentFlow: 'checkout_session',
  } })).toBe(true);
  expect(isHostedCheckoutPaymentIntent({ metadata: { type: 'return_settlement' } })).toBe(true);
  expect(isHostedCheckoutPaymentIntent({ metadata: {
    type: 'wallet_top_up', paymentFlow: 'payment_sheet',
  } })).toBe(false);
});

test('legacy PaymentIntent routing binds to authoritative local flow and leaves ambiguity retryable', async () => {
  const user = oid();
  const wallet = await Wallet.create({ user, balances: { USD: 0 }, status: 'active' });
  const hosted = await WalletTransaction.create({
    user,
    wallet: wallet._id,
    type: 'top_up',
    direction: 'credit',
    status: 'pending',
    amount: 25,
    currency: 'USD',
    description: 'Legacy hosted routing',
    referenceType: 'stripe_checkout',
    referenceId: 'legacy-hosted-routing',
    idempotencyKey: 'legacy-hosted-routing',
    stripeSessionId: 'cs_legacy_hosted_routing',
    stripeMode: 'test',
    paymentFlow: 'checkout_session',
    paymentSetupState: 'ready',
  });
  await expect(resolvePaymentIntentLifecycleRoute({
    id: 'pi_legacy_hosted_routing',
    metadata: {
      type: 'wallet_top_up',
      walletTransactionId: String(hosted._id),
    },
  })).resolves.toMatchObject({
    route: 'hosted_checkout',
    sourceType: 'wallet_top_up',
    inferredFromLocalRecord: true,
  });

  const native = await createFundedTopUp({ paymentIntentId: 'pi_legacy_native_routing' });
  const nativeRoute = await resolvePaymentIntentLifecycleRoute({
    id: native.paymentIntentId,
    metadata: {
      type: 'wallet_top_up',
      walletTransactionId: String(native.topUp._id),
    },
  });
  expect(nativeRoute).toMatchObject({
    route: 'payment_sheet',
    sourceType: 'wallet_top_up',
    inferredFromLocalRecord: true,
    paymentIntent: { metadata: { paymentFlow: 'payment_sheet' } },
  });
  await expect(resolvePaymentIntentLifecycleRoute({
    id: 'pi_legacy_missing_routing',
    metadata: { type: 'wallet_top_up', walletTransactionId: String(oid()) },
  })).resolves.toMatchObject({ route: 'ambiguous', sourceType: 'wallet_top_up' });
});

test('return safety and admin idempotency fail closed on reversed funding and mismatched payload replay', async () => {
  const seller = oid();
  const fixture = await createFundedTopUp({
    remainingMinor: 0,
    sellerAllocations: [{ seller: String(seller), sourceAmountMinor: 10000, amountUSDMinor: 10000 }],
    paymentIntentId: 'pi_return_guard',
  });
  await applyRisk(fixture, { refundedMinor: 10000 }, 'evt_return_guard', 'charge.refunded');
  await expect(assertWalletOrderFundingReturnable({ orderId: fixture.orderId }))
    .rejects.toMatchObject({ code: 'RETURN_EXTERNAL_FUNDING_REVERSAL', statusCode: 409 });

  const debtFixture = await createFundedTopUp({
    remainingMinor: 0,
    paymentIntentId: 'pi_admin_idempotency',
  });
  await applyRisk(debtFixture, { refundedMinor: 10000 }, 'evt_admin_debt', 'charge.refunded');
  const key = 'admin-payload-bound-key';
  const firstAudit = await reconcileWalletPaymentLiability({
    userId: debtFixture.user,
    adminId: oid(),
    amount: 10,
    currency: 'USD',
    action: 'write_off',
    idempotencyKey: key,
  });
  const exactReplay = await reconcileWalletPaymentLiability({
    userId: debtFixture.user,
    adminId: oid(),
    amount: 10,
    currency: 'usd',
    action: 'write_off',
    idempotencyKey: key,
  });
  expect(String(exactReplay._id)).toBe(String(firstAudit._id));
  expect(await WalletTransaction.countDocuments({ idempotencyKey: key })).toBe(1);
  await expect(reconcileWalletPaymentLiability({
    userId: debtFixture.user,
    adminId: oid(),
    amount: 11,
    currency: 'USD',
    action: 'write_off',
    idempotencyKey: key,
  })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 });
});
