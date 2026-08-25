'use strict';

const mockStripeSessionsCreate = jest.fn();
const mockStripeSessionsRetrieve = jest.fn();

jest.mock('../../config/stripe', () => ({
  STRIPE_MODE: 'test',
  stripe: {
    checkout: {
      sessions: {
        create: (...args) => mockStripeSessionsCreate(...args),
        retrieve: (...args) => mockStripeSessionsRetrieve(...args),
      },
    },
  },
}));

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Order = require('../../models/Order');
const ReturnRequest = require('../../models/ReturnRequest');
const SellerBalanceTransaction = require('../../models/SellerBalanceTransaction');
const SellerSettlementLock = require('../../models/SellerSettlementLock');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const { buildSellerPaymentSummary } = require('../../controllers/PaymentController');
const { buildOrderSellerSettlement, SELLER_SETTLEMENT_VERSION } = require('../../services/orderMoneyService');
const {
  completeReturnCardSettlement,
  createReturnSettlementCheckout,
  failReturnCardSettlement,
  settleFromSellerBalance,
} = require('../../services/returnService');

let replSet;

const rates = {
  base: 'USD',
  rates: { USD: 1, PKR: 300, EUR: 0.9, GBP: 0.8 },
  capturedAt: new Date('2026-08-24T00:00:00.000Z'),
  source: 'return-conservation-test',
  fallback: false,
};

const stripeSessionFromParams = (params, id = `cs_return_${new mongoose.Types.ObjectId()}`) => ({
  id,
  mode: params.mode,
  status: 'open',
  payment_status: 'unpaid',
  url: `https://checkout.stripe.test/${id}`,
  client_reference_id: params.client_reference_id,
  amount_total: params.line_items[0].price_data.unit_amount,
  currency: params.line_items[0].price_data.currency,
  metadata: params.metadata,
  expires_at: params.expires_at,
  livemode: false,
  payment_intent: null,
});

const createFixture = async ({ shippingPrice = 0 } = {}) => {
  const seller = new mongoose.Types.ObjectId();
  const buyer = new mongoose.Types.ObjectId();
  const productId = new mongoose.Types.ObjectId();
  const order = new Order({
    user: buyer,
    currency: 'PKR',
    exchangeRateSnapshot: rates,
    orderId: `ORD-RETURN-CONSERVE-${new mongoose.Types.ObjectId()}`,
    orderItems: [{
      productId,
      seller,
      name: 'Four rupee item',
      image: 'https://example.com/four-rupee.jpg',
      price: 2,
      lineSubtotal: 4,
      quantity: 2,
    }],
    shippingInfo: {
      fullName: 'Return Buyer',
      email: 'return-buyer@example.com',
      phone: '+923001234567',
      address: '1 Return Street',
      city: 'Lahore',
      state: 'Punjab',
      postalCode: '54000',
      country: 'Pakistan',
    },
    shippingMethod: { name: 'shipping', price: shippingPrice, estimatedDays: 1, seller },
    sellerShipping: [{ seller, shippingMethod: { name: 'shipping', price: shippingPrice, estimatedDays: 1 } }],
    sellerFulfillment: [{ seller, status: 'delivered', deliveredAt: new Date() }],
    orderSummary: {
      subtotal: 4,
      shippingCost: shippingPrice,
      tax: 0,
      couponDiscount: 0,
      totalAmount: 4 + shippingPrice,
    },
    paymentMethod: 'stripe',
    awaitingPayment: false,
    inventoryCommitted: true,
    isPaid: true,
    paidAt: new Date(),
    orderStatus: 'delivered',
    isDelivered: true,
    deliveredAt: new Date(),
  });
  order.sellerSettlementVersion = SELLER_SETTLEMENT_VERSION;
  order.sellerSettlement = buildOrderSellerSettlement(order, { requireOrderTotal: true });
  await order.save();

  const createReturn = (suffix, amount) => ReturnRequest.create({
    returnNumber: `RET-CONSERVE-${suffix}-${new mongoose.Types.ObjectId()}`,
    order: order._id,
    orderId: order.orderId,
    buyer,
    seller,
    currency: 'PKR',
    items: [{
      orderItemId: order.orderItems[0]._id,
      productId,
      name: 'Four rupee item',
      image: 'https://example.com/four-rupee.jpg',
      quantity: 1,
      purchasedQuantity: 2,
      unitPrice: amount,
      lineSubtotal: amount,
    }],
    reasonCategory: 'defective',
    reasonDetails: 'The item is defective and needs a refund.',
    status: 'under_review',
    statusHistory: [{ status: 'under_review', actorRole: 'seller' }],
    eligibilityDeadline: new Date(Date.now() + 86400000),
    policySnapshot: { returnsEnabled: true, returnDuration: 30, refundType: 'full_refund' },
    refund: {
      itemSubtotal: amount,
      taxAmount: 0,
      shippingAmount: 0,
      discountAmount: 0,
      totalAmount: amount,
    },
  });
  return { seller, buyer, order, createReturn };
};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());
  await Promise.all([
    SellerBalanceTransaction.syncIndexes(),
    ReturnRequest.syncIndexes(),
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
  mockStripeSessionsCreate.mockImplementation(async params => stripeSessionFromParams(params));
  mockStripeSessionsRetrieve.mockImplementation(async () => {
    throw new Error('Unexpected Stripe session retrieval');
  });
  await Promise.all([
    Order.deleteMany({}),
    ReturnRequest.deleteMany({}),
    SellerBalanceTransaction.deleteMany({}),
    SellerSettlementLock.deleteMany({}),
    Wallet.deleteMany({}),
    WalletTransaction.deleteMany({}),
  ]);
});

test('sequential PKR seller-balance returns exactly zero the frozen USD credit, including a zero-USD source row', async () => {
  const fixture = await createFixture();
  const first = await fixture.createReturn('first', 2);
  const second = await fixture.createReturn('second', 2);

  await settleFromSellerBalance({ returnRequestId: first._id, sellerId: fixture.seller });
  await settleFromSellerBalance({ returnRequestId: second._id, sellerId: fixture.seller });
  await settleFromSellerBalance({ returnRequestId: second._id, sellerId: fixture.seller });

  const debits = await SellerBalanceTransaction.find({
    seller: fixture.seller,
    type: 'return_refund',
    status: 'completed',
  }).sort({ createdAt: 1 }).lean();
  expect(debits).toHaveLength(2);
  expect(debits.map(row => Math.round(row.amountUSD * 100))).toEqual([1, 0]);
  expect(debits.map(row => Math.round(row.sourceAmount * 100))).toEqual([200, 200]);
  expect(debits.reduce((sum, row) => sum + Math.round(row.amountUSD * 100), 0)).toBe(
    fixture.order.sellerSettlement[0].amountUSDMinor
  );
  expect(debits.reduce((sum, row) => sum + Math.round(row.sourceAmount * 100), 0)).toBe(400);

  const summary = await buildSellerPaymentSummary(fixture.seller, {
    displayCurrency: 'USD',
    rateSnapshot: rates,
  });
  expect(summary.revenue.onlineDeliveredRevenue).toBe(0.01);
  expect(summary.revenue.returnRefundDebits).toBe(0.01);
  expect(summary.revenue.withdrawableBalance).toBe(0);
  expect((await Wallet.findOne({ user: fixture.buyer }).lean()).balances.PKR).toBe(4);
});

test('out-of-order split settlements allocate one-cent seller shipping exactly once at final settlement', async () => {
  const fixture = await createFixture({ shippingPrice: 0.01 });
  const first = await fixture.createReturn('first-shipping', 2);
  const second = await fixture.createReturn('second-shipping', 2);

  // Settle the later-created request first. Pending quantity on `first` must
  // not unlock shipping because it has not actually returned yet.
  await settleFromSellerBalance({ returnRequestId: second._id, sellerId: fixture.seller });
  let storedSecond = await ReturnRequest.findById(second._id).lean();
  expect(storedSecond.refund).toMatchObject({ shippingAmount: 0, totalAmount: 2 });

  // The remaining request now completes the seller's actually returned
  // quantity and atomically absorbs the original one-cent shipping charge.
  await settleFromSellerBalance({ returnRequestId: first._id, sellerId: fixture.seller });
  await settleFromSellerBalance({ returnRequestId: first._id, sellerId: fixture.seller });

  const stored = await ReturnRequest.find({ order: fixture.order._id }).sort({ returnNumber: 1 }).lean();
  const shippingOwners = stored.filter(entry => entry.refund.shippingAmount > 0);
  expect(shippingOwners).toHaveLength(1);
  expect(shippingOwners[0].refund).toMatchObject({ shippingAmount: 0.01, totalAmount: 2.01 });
  expect(shippingOwners[0].settlement).toMatchObject({
    shippingAllocationVersion: 1,
    status: 'completed',
  });
  expect(shippingOwners[0].settlement.shippingAllocatedAt).toBeInstanceOf(Date);

  const debits = await SellerBalanceTransaction.find({
    seller: fixture.seller,
    type: 'return_refund',
    status: 'completed',
  }).lean();
  expect(debits).toHaveLength(2);
  expect(debits.reduce((sum, row) => sum + Math.round(row.sourceAmount * 100), 0)).toBe(401);
  expect((await Wallet.findOne({ user: fixture.buyer }).lean()).balances.PKR).toBe(4.01);
  storedSecond = await ReturnRequest.findById(second._id).lean();
  expect(storedSecond.refund.shippingAmount).toBe(0);
});

test('concurrent final settlements serialize on the seller fence and never double-refund shipping', async () => {
  const fixture = await createFixture({ shippingPrice: 0.01 });
  const first = await fixture.createReturn('concurrent-first', 2);
  const second = await fixture.createReturn('concurrent-second', 2);
  // Avoid testing the separate unique-upsert race: this test targets the
  // existing seller fence's transactional serialization semantics.
  await SellerSettlementLock.create({ seller: fixture.seller });

  await Promise.all([
    settleFromSellerBalance({ returnRequestId: first._id, sellerId: fixture.seller }),
    settleFromSellerBalance({ returnRequestId: second._id, sellerId: fixture.seller }),
  ]);

  const stored = await ReturnRequest.find({ order: fixture.order._id, status: 'returned' }).lean();
  expect(stored).toHaveLength(2);
  expect(stored.filter(entry => entry.refund.shippingAmount === 0.01)).toHaveLength(1);
  expect(stored.reduce((sum, entry) => sum + Math.round(entry.refund.totalAmount * 100), 0)).toBe(401);
  expect((await Wallet.findOne({ user: fixture.buyer }).lean()).balances.PKR).toBe(4.01);
});

test('an in-flight partial card settlement reserves sibling balance settlement until completion', async () => {
  const fixture = await createFixture({ shippingPrice: 0.01 });
  const cardReturn = await fixture.createReturn('card-reservation', 2);
  const balanceReturn = await fixture.createReturn('balance-after-card', 2);

  const checkout = await createReturnSettlementCheckout({
    returnRequestId: cardReturn._id,
    sellerId: fixture.seller,
    platform: 'web',
  });
  await expect(settleFromSellerBalance({
    returnRequestId: balanceReturn._id,
    sellerId: fixture.seller,
  })).rejects.toMatchObject({
    code: 'RETURN_SELLER_SETTLEMENT_RESERVED',
    reservedByReturnRequestId: String(cardReturn._id),
  });

  await completeReturnCardSettlement({
    ...checkout.session,
    status: 'complete',
    payment_status: 'paid',
    payment_intent: `pi_return_${new mongoose.Types.ObjectId()}`,
  });
  await settleFromSellerBalance({
    returnRequestId: balanceReturn._id,
    sellerId: fixture.seller,
  });

  const stored = await ReturnRequest.find({ order: fixture.order._id, status: 'returned' }).lean();
  expect(stored).toHaveLength(2);
  expect(stored.filter(entry => entry.refund.shippingAmount === 0.01)).toHaveLength(1);
  expect(stored.reduce((sum, entry) => sum + Math.round(entry.refund.totalAmount * 100), 0)).toBe(401);
  expect((await Wallet.findOne({ user: fixture.buyer }).lean()).balances.PKR).toBe(4.01);
});

test('a legacy ambiguous card state with setup metadata and reference unset still reserves every sibling settlement', async () => {
  const fixture = await createFixture({ shippingPrice: 0.01 });
  const legacyCard = await fixture.createReturn('legacy-card-reservation', 2);
  const sibling = await fixture.createReturn('legacy-card-sibling', 2);
  await ReturnRequest.collection.updateOne(
    { _id: legacyCard._id },
    {
      $set: {
        status: 'accepted_pending_payment',
        'settlement.fundingSource': 'card',
        'settlement.status': 'pending_payment',
        'settlement.attempt': 1,
      },
      $unset: {
        'settlement.setupState': '',
        'settlement.stripeSessionId': '',
      },
    },
  );
  const storedLegacy = await ReturnRequest.collection.findOne({ _id: legacyCard._id });
  expect(storedLegacy.settlement.setupState).toBeUndefined();
  expect(storedLegacy.settlement.stripeSessionId).toBeUndefined();

  await expect(settleFromSellerBalance({
    returnRequestId: sibling._id,
    sellerId: fixture.seller,
  })).rejects.toMatchObject({
    code: 'RETURN_SELLER_SETTLEMENT_RESERVED',
    reservedByReturnRequestId: String(legacyCard._id),
  });
  await expect(createReturnSettlementCheckout({
    returnRequestId: sibling._id,
    sellerId: fixture.seller,
    platform: 'web',
  })).rejects.toMatchObject({ code: 'RETURN_SELLER_SETTLEMENT_RESERVED' });
  expect(mockStripeSessionsCreate).not.toHaveBeenCalled();

  // The ambiguous request itself remains explicitly quarantined for recovery;
  // siblings must not guess that an external object was never created.
  await expect(createReturnSettlementCheckout({
    returnRequestId: legacyCard._id,
    sellerId: fixture.seller,
    platform: 'web',
  })).rejects.toMatchObject({ code: 'RETURN_SETTLEMENT_RECOVERY_REQUIRED' });
  expect(mockStripeSessionsCreate).not.toHaveBeenCalled();
});

test('concurrent sibling card setups create one external attempt; same-request replay is idempotent and expiry releases the fence', async () => {
  const fixture = await createFixture({ shippingPrice: 0.01 });
  const first = await fixture.createReturn('card-concurrent-first', 2);
  const second = await fixture.createReturn('card-concurrent-second', 2);

  const attempts = await Promise.allSettled([
    createReturnSettlementCheckout({ returnRequestId: first._id, sellerId: fixture.seller, platform: 'web' }),
    createReturnSettlementCheckout({ returnRequestId: second._id, sellerId: fixture.seller, platform: 'mobile' }),
  ]);
  const fulfilled = attempts.filter(result => result.status === 'fulfilled');
  const rejected = attempts.filter(result => result.status === 'rejected');
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0].reason).toMatchObject({ code: 'RETURN_SELLER_SETTLEMENT_RESERVED' });
  expect(mockStripeSessionsCreate).toHaveBeenCalledTimes(1);

  const winner = fulfilled[0].value;
  mockStripeSessionsRetrieve.mockResolvedValue(winner.session);
  const replay = await createReturnSettlementCheckout({
    returnRequestId: winner.returnRequest._id,
    sellerId: fixture.seller,
    platform: 'mobile',
  });
  expect(replay.session.id).toBe(winner.session.id);
  expect(mockStripeSessionsCreate).toHaveBeenCalledTimes(1);

  await failReturnCardSettlement({
    ...winner.session,
    status: 'expired',
    payment_status: 'unpaid',
  }, 'Expired safely.');
  const loserId = String(winner.returnRequest._id) === String(first._id) ? second._id : first._id;
  const afterExpiry = await createReturnSettlementCheckout({
    returnRequestId: loserId,
    sellerId: fixture.seller,
    platform: 'web',
  });
  expect(afterExpiry.returnRequest.status).toBe('accepted_pending_payment');
  expect(mockStripeSessionsCreate).toHaveBeenCalledTimes(2);
});

test('a definitive external setup rejection reopens its request and releases the sibling reservation', async () => {
  const fixture = await createFixture({ shippingPrice: 0.01 });
  const rejectedReturn = await fixture.createReturn('card-definitive-failure', 2);
  const siblingReturn = await fixture.createReturn('card-after-definitive-failure', 2);
  const invalidRequest = Object.assign(new Error('Stripe rejected the request before creating a session.'), {
    type: 'StripeInvalidRequestError',
    statusCode: 400,
    code: 'parameter_unknown',
  });
  mockStripeSessionsCreate.mockRejectedValueOnce(invalidRequest);

  await expect(createReturnSettlementCheckout({
    returnRequestId: rejectedReturn._id,
    sellerId: fixture.seller,
    platform: 'web',
  })).rejects.toBe(invalidRequest);
  expect(await ReturnRequest.findById(rejectedReturn._id).lean()).toMatchObject({
    status: 'under_review',
    settlement: { status: 'failed', setupState: 'closed' },
  });

  const siblingCheckout = await createReturnSettlementCheckout({
    returnRequestId: siblingReturn._id,
    sellerId: fixture.seller,
    platform: 'web',
  });
  expect(siblingCheckout.returnRequest.status).toBe('accepted_pending_payment');
  expect(mockStripeSessionsCreate).toHaveBeenCalledTimes(2);
});

test('shipping settlement is seller-isolated and ignores rejected quantities before a re-request', async () => {
  const sellerA = new mongoose.Types.ObjectId();
  const sellerB = new mongoose.Types.ObjectId();
  const buyer = new mongoose.Types.ObjectId();
  const productA = new mongoose.Types.ObjectId();
  const productB = new mongoose.Types.ObjectId();
  const order = new Order({
    user: buyer,
    currency: 'PKR',
    exchangeRateSnapshot: rates,
    orderId: `ORD-RETURN-ISOLATED-${new mongoose.Types.ObjectId()}`,
    orderItems: [
      {
        productId: productA,
        seller: sellerA,
        name: 'Seller A item',
        image: 'https://example.com/seller-a.jpg',
        price: 2,
        lineSubtotal: 4,
        quantity: 2,
      },
      {
        productId: productB,
        seller: sellerB,
        name: 'Seller B item',
        image: 'https://example.com/seller-b.jpg',
        price: 3,
        lineSubtotal: 3,
        quantity: 1,
      },
    ],
    shippingInfo: {
      fullName: 'Return Buyer',
      email: 'return-buyer@example.com',
      phone: '+923001234567',
      address: '1 Return Street',
      city: 'Lahore',
      state: 'Punjab',
      postalCode: '54000',
      country: 'Pakistan',
    },
    shippingMethod: { name: 'Seller A shipping', price: 0.01, estimatedDays: 1, seller: sellerA },
    sellerShipping: [
      { seller: sellerA, shippingMethod: { name: 'Seller A shipping', price: 0.01, estimatedDays: 1 } },
      { seller: sellerB, shippingMethod: { name: 'Seller B shipping', price: 0.02, estimatedDays: 1 } },
    ],
    sellerFulfillment: [
      { seller: sellerA, status: 'delivered', deliveredAt: new Date() },
      { seller: sellerB, status: 'delivered', deliveredAt: new Date() },
    ],
    orderSummary: { subtotal: 7, shippingCost: 0.03, tax: 0, couponDiscount: 0, totalAmount: 7.03 },
    paymentMethod: 'stripe',
    awaitingPayment: false,
    inventoryCommitted: true,
    isPaid: true,
    paidAt: new Date(),
    orderStatus: 'delivered',
    isDelivered: true,
    deliveredAt: new Date(),
  });
  order.sellerSettlementVersion = SELLER_SETTLEMENT_VERSION;
  order.sellerSettlement = buildOrderSellerSettlement(order, { requireOrderTotal: true });
  await order.save();

  const createReturn = ({ suffix, seller, item, productId, quantity, purchasedQuantity, amount, status = 'under_review' }) => (
    ReturnRequest.create({
      returnNumber: `RET-ISOLATED-${suffix}-${new mongoose.Types.ObjectId()}`,
      order: order._id,
      orderId: order.orderId,
      buyer,
      seller,
      currency: 'PKR',
      items: [{
        orderItemId: item._id,
        productId,
        name: item.name,
        image: item.image,
        quantity,
        purchasedQuantity,
        unitPrice: amount / quantity,
        lineSubtotal: amount,
      }],
      reasonCategory: 'defective',
      reasonDetails: 'The item is defective and needs a refund.',
      status,
      statusHistory: [{ status, actorRole: 'seller' }],
      eligibilityDeadline: new Date(Date.now() + 86400000),
      policySnapshot: { returnsEnabled: true, returnDuration: 30, refundType: 'full_refund' },
      refund: {
        itemSubtotal: amount,
        taxAmount: 0,
        shippingAmount: 0,
        discountAmount: 0,
        totalAmount: amount,
      },
    })
  );

  // A rejected quantity must be fully reusable and must not help unlock A's
  // shipping. Seller B's full return independently owns only B's shipping.
  await createReturn({
    suffix: 'a-rejected',
    seller: sellerA,
    item: order.orderItems[0],
    productId: productA,
    quantity: 1,
    purchasedQuantity: 2,
    amount: 2,
    status: 'rejected',
  });
  const aFirst = await createReturn({
    suffix: 'a-first', seller: sellerA, item: order.orderItems[0], productId: productA,
    quantity: 1, purchasedQuantity: 2, amount: 2,
  });
  const bOnly = await createReturn({
    suffix: 'b-only', seller: sellerB, item: order.orderItems[1], productId: productB,
    quantity: 1, purchasedQuantity: 1, amount: 3,
  });
  await settleFromSellerBalance({ returnRequestId: aFirst._id, sellerId: sellerA });
  await settleFromSellerBalance({ returnRequestId: bOnly._id, sellerId: sellerB });

  expect((await ReturnRequest.findById(aFirst._id).lean()).refund.shippingAmount).toBe(0);
  expect((await ReturnRequest.findById(bOnly._id).lean()).refund).toMatchObject({
    shippingAmount: 0.02,
    totalAmount: 3.02,
  });

  const aReplacement = await createReturn({
    suffix: 'a-replacement', seller: sellerA, item: order.orderItems[0], productId: productA,
    quantity: 1, purchasedQuantity: 2, amount: 2,
  });
  await settleFromSellerBalance({ returnRequestId: aReplacement._id, sellerId: sellerA });
  await settleFromSellerBalance({ returnRequestId: aReplacement._id, sellerId: sellerA });

  expect((await ReturnRequest.findById(aReplacement._id).lean()).refund).toMatchObject({
    shippingAmount: 0.01,
    totalAmount: 2.01,
  });
  const refunded = await ReturnRequest.find({
    order: order._id,
    status: 'returned',
  }).lean();
  expect(refunded.filter(entry => entry.refund.shippingAmount > 0)).toHaveLength(2);
  expect(refunded.reduce((sum, entry) => sum + Math.round(entry.refund.totalAmount * 100), 0)).toBe(703);
  expect((await Wallet.findOne({ user: buyer }).lean()).balances.PKR).toBe(7.03);
});
