'use strict';

// These are integration tests of the actual checkout snapshots, accounting,
// settlement, cancellation and fulfillment services. External provider HTTP
// and explicitly named failure injection are replaced; all normal monetary/
// authorization writes use a replica set.
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const User = require('../../models/User');
const Store = require('../../models/Store');
const Payment = require('../../models/SafepayPayment');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const SellerLock = require('../../models/SellerSettlementLock');
const RiskHold = require('../../models/SellerPaymentRiskHold');
const SellerBalanceTransaction = require('../../models/SellerBalanceTransaction');
const Cancellation = require('../../models/OrderCancellation');
const RefundEvent = require('../../models/SafepayRefundEvent');
const NotificationOutbox = require('../../models/NotificationOutbox');
const AIActionReceipt = require('../../models/AIActionReceipt');
const { executeToolCall } = require('../../services/aiActionExecutor');
const { transitionOrderFulfillment } = require('../../services/orderStatusTransitionService');
const { priceSellerNativeCheckout } = require('../../services/sellerCheckoutRoundingService');
const { buildOrderSellerSettlement } = require('../../services/orderMoneyService');
const { buildOnlineOrderFee } = require('../../services/onlineOrderFeeService');
const { convertMoneyByRates } = require('../../services/moneyMath');
const { createSafepayPaymentService } = require('../../services/safepayPaymentService');
const { quarantineSafepayPayment } = require('../../services/safepaySettlementService');
const { commitOrderInventory } = require('../../services/orderInventoryService');
const { completeNoChargeOrder } = require('../../services/orderNoChargeService');
const { payOrderWithWallet, creditWalletInSession } = require('../../services/walletService');
const { cancelBuyerOrder, previewBuyerCancellation } = require('../../services/buyerCancellationService');

const oid = () => new mongoose.Types.ObjectId();
const rates = { USD: 1, PKR: 300, EUR: 0.9, GBP: 0.8 };
const models = [Order, Product, User, Store, Payment, Wallet, WalletTransaction, SellerLock,
  RiskHold, SellerBalanceTransaction, Cancellation, RefundEvent, NotificationOutbox, AIActionReceipt];
const sandboxFixtureEnv = {
  SAFEPAY_ENV: 'sandbox',
  SAFEPAY_SANDBOX_PUBLIC_KEY: 'sec_funding-authority-fixture',
  SAFEPAY_SANDBOX_SECRET_KEY: 'funding-authority-fixture-secret-only',
  SAFEPAY_SANDBOX_WEBHOOK_SECRET: 'funding-authority-fixture-webhook-only',
  SAFEPAY_SANDBOX_WEBHOOK_SCHEME: 'sha512-data',
};
const previousSafepayEnv = Object.fromEntries(Object.keys(sandboxFixtureEnv).map(key => [key, process.env[key]]));
const reporterFixtures = new Map();
let replica;

beforeAll(async () => {
  Object.assign(process.env, sandboxFixtureEnv);
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await Promise.all(models.map(model => model.init()));
}, 120000);

beforeEach(() => {
  reporterFixtures.clear();
  // Cancellation preview now re-reads the owned provider tracker. That read
  // uses the same fixture as capture/refund reconciliation, never real HTTP.
  jest.spyOn(require('../../services/safepayClient'), 'createSafepayClient').mockReturnValue({
    getTracker: jest.fn(async trackerId => {
      const read = reporterFixtures.get(trackerId);
      if (!read) throw new Error('Unexpected provider tracker read in the funding fixture.');
      return read();
    }),
  });
});
afterEach(async () => {
  await Promise.all(models.map(model => model.deleteMany({})));
  jest.restoreAllMocks();
});
afterAll(async () => {
  await mongoose.disconnect(); await replica?.stop();
  for (const [key, value] of Object.entries(previousSafepayEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}, 60000);

function provider() {
  let tracker = { state: 'TRACKER_ENDED', intent: 'CYBERSOURCE', mode: 'payment' };
  const service = createSafepayPaymentService({
    configFor: () => ({ environment: 'sandbox' }),
    clientFor: () => ({ getTracker: async trackerId => {
      reporterFixtures.set(trackerId, () => tracker);
      return tracker;
    } }),
  });
  return { service, getTracker: () => tracker, setState: state => { tracker = { state, intent: 'CYBERSOURCE', mode: 'payment' }; },
    refund(payment, amounts) {
      const total = amounts.reduce((sum, value) => sum + value, 0);
      tracker = {
        state: total === payment.amountMinor ? 'TRACKER_REFUNDED' : 'TRACKER_PARTIAL_REFUND',
        intent: 'CYBERSOURCE', mode: 'payment',
        charge: {
          token: `ch_funding-${payment._id}`, tracker: payment.tracker,
          amount: { currency: payment.currency, amount: payment.amountMinor },
          capture: { totals: { currency: payment.currency, amount: payment.amountMinor } },
          balance: { currency: payment.currency, amount: payment.amountMinor - total },
          cybersource_refunds: amounts.map((amount, index) => ({
            token: `refund_funding-${payment._id}-${index}`, tracker: payment.tracker,
            totals: { currency: payment.currency, amount },
            created_at: { seconds: Math.floor(Date.now() / 1000) + index },
          })),
        },
      };
    },
  };
}

async function quotedOrder({ method = 'safepay', sellers = [oid()], amounts = [1000],
  buyer = oid(), currency = 'PKR', nativeCurrency = 'PKR', noCharge = false } = {}) {
  await User.create(sellers.map(seller => ({ _id: seller, username: `Funding Seller ${seller}`,
    email: `funding-seller-${seller}@example.com`, role: 'seller', status: 'active' })));
  await Store.create(sellers.map((seller, index) => ({ seller,
    storeName: `Funding Store ${index + 1}`, storeSlug: `funding-${seller}`,
    productCurrency: nativeCurrency, productCurrencyStatus: 'active',
    moderationStatus: 'approved', isActive: true, visibility: { mode: 'global' } })));
  const products = await Product.create(sellers.map((seller, index) => ({
    seller, name: `Funding authority cup ${index + 1}`, description: 'Integration QA cup.',
    price: amounts[index], currency: nativeCurrency, priceCurrency: nativeCurrency,
    category: 'Home', brand: 'QA', stock: 5, totalSales: 0,
    image: 'https://example.com/funding-cup.png',
  })));
  const buyerPrices = amounts.map(amount => convertMoneyByRates(amount, rates[nativeCurrency], rates[currency]));
  const buyerSubtotal = buyerPrices.reduce((sum, amount) => sum + amount, 0);
  const raw = {
    user: buyer, orderId: `ORD-FUNDING-${oid()}`, currency,
    orderItems: products.map((product, index) => ({
      productId: product._id, seller: sellers[index], name: product.name, image: product.image,
      price: buyerPrices[index], lineSubtotal: buyerPrices[index], quantity: 1,
      sourcePrice: amounts[index], sourceLineSubtotal: amounts[index], sourceCurrency: nativeCurrency,
      returnPolicySnapshotVersion: 1,
      returnPolicy: { returnsEnabled: false, returnDuration: 0, refundType: 'none' },
    })),
    shippingInfo: { fullName: 'QA Funding Buyer', email: 'funding-authority@example.com',
      phone: '+923001234567', address: 'QA Street', city: 'Lahore', state: 'Punjab',
      postalCode: '54000', country: 'Pakistan' },
    shippingMethod: { name: 'free', price: 0, estimatedDays: 3 },
    sellerShipping: sellers.map(seller => ({ seller, shippingMethod: { name: 'free',
      price: 0, sourceCost: 0, sourceCurrency: nativeCurrency, estimatedDays: 3 } })),
    sellerPolicies: sellers.map((seller, index) => ({ seller, productCurrency: nativeCurrency,
      storeName: `Funding Store ${index + 1}` })),
    sellerFulfillment: sellers.map(seller => ({ seller, status: 'pending' })),
    orderSummary: { subtotal: buyerSubtotal,
      shippingCost: 0, tax: 0, couponDiscount: 0,
      totalAmount: buyerSubtotal },
    exchangeRateSnapshot: { base: 'USD', rates, capturedAt: new Date(), source: 'integration-fixture', fallback: false },
    paymentMethod: method, paymentFlow: method === 'safepay' ? 'safepay_hosted' : 'checkout_session',
    paymentSetupState: noCharge ? 'not_started' : 'ready',
    safepayEnvironment: method === 'safepay' ? 'sandbox' : null,
    awaitingPayment: method !== 'cash_on_delivery', isPaid: false,
    inventoryCommitted: false, orderStatus: 'pending',
  };
  Object.assign(raw, priceSellerNativeCheckout(raw));
  raw.sellerCurrencyMoneyVersion = 2;
  raw.sellerSettlementVersion = 1;
  raw.sellerSettlement = buildOrderSellerSettlement(raw, { requireOrderTotal: true });
  if (method !== 'cash_on_delivery') raw.onlineFeeSnapshot = buildOnlineOrderFee(raw);
  const order = await Order.create(raw);
  return { order, products, sellers, buyer };
}

async function capturedOrder(options = {}) {
  const fixture = await quotedOrder(options);
  const remote = provider();
  const payment = await remote.service.ensurePayment({
    user: fixture.buyer, purpose: 'order', order: fixture.order._id,
    reference: `order:${fixture.order._id}`, requestKey: `funding:${fixture.order._id}`,
    currency: fixture.order.currency, amountMinor: Math.round(fixture.order.orderSummary.totalAmount * 100),
    terms: { settlementPolicy: 'revalidate-on-payment-v1' },
  });
  payment.status = 'ready'; payment.tracker = `track_funding-${payment._id}`; await payment.save();
  fixture.order.safepayPaymentId = payment._id; fixture.order.safepayTrackerId = payment.tracker;
  await fixture.order.save();
  expect((await Product.findById(fixture.products[0]._id)).stock).toBe(5);
  await remote.service.reconcilePayment(payment._id);
  const stored = await Order.findById(fixture.order._id);
  expect(stored.sellerCurrencyMoneyVersion).toBe(2);
  expect(stored.onlineFeeSnapshot.version).toBe(1);
  expect(stored.isPaid).toBe(true);
  expect(stored.inventoryCommitted).toBe(true);
  expect((await Product.findById(fixture.products[0]._id)).stock).toBe(4);
  expect((await Payment.findById(payment._id)).status).toBe('paid');
  return { ...fixture, remote, payment };
}

async function walletOrder({ tracked = true, ...options } = {}) {
  const fixture = await quotedOrder({ ...options, method: 'wallet' });
  const remote = provider();
  let payment = null;
  if (tracked) {
    payment = await remote.service.ensurePayment({ user: fixture.buyer, purpose: 'wallet_top_up',
      reference: `wallet:${fixture.buyer}`, requestKey: `funding-topup:${oid()}`,
      amountMinor: Math.round(fixture.order.orderSummary.totalAmount * 100), currency: fixture.order.currency });
    payment.status = 'ready'; payment.tracker = `track_topup-${payment._id}`; await payment.save();
    await remote.service.reconcilePayment(payment._id);
  } else {
    await mongoose.connection.transaction(session => creditWalletInSession({
      userId: fixture.buyer, amount: fixture.order.orderSummary.totalAmount, currency: fixture.order.currency,
      type: 'admin_adjustment', referenceType: 'admin', referenceId: String(oid()),
      idempotencyKey: `funding-admin-credit:${oid()}`, description: 'QA approved Wallet credit',
    }, session));
  }
  await payOrderWithWallet({ orderId: fixture.order._id, userId: fixture.buyer });
  const order = await Order.findById(fixture.order._id);
  const debit = await WalletTransaction.findById(order.paymentResult.walletTransactionId);
  expect(debit.referenceId).toBe(String(order._id));
  expect(debit.status).toBe('completed');
  if (tracked) expect(debit.metadata.fundingProvenance).toHaveLength(1);
  return { ...fixture, remote, payment, debit };
}

async function forward(fixture, status = 'shipped', sellerIndex = 0, actorRole = 'seller') {
  return transitionOrderFulfillment({ orderId: fixture.order._id, actorRole,
    actorId: actorRole === 'seller' ? fixture.sellers[sellerIndex] : null, newStatus: status });
}

async function expectBlocked(fixture, status = 'shipped', { sellerIndex = 0, actorRole = 'seller' } = {}) {
  const before = await Order.findById(fixture.order._id).lean();
  const notifications = await NotificationOutbox.countDocuments();
  const outcome = await forward(fixture, status, sellerIndex, actorRole).then(
    () => ({ accepted: true }), error => ({ accepted: false, error }),
  );
  expect(outcome.accepted).toBe(false);
  expect(outcome.error).toBeInstanceOf(Error);
  expect(['ORDER_FUNDING_UNVERIFIED', 'ORDER_FUNDING_REVERSED', 'ORDER_STATUS_TRANSITION_INVALID'])
    .toContain(outcome.error.code);
  expect(outcome.error.statusCode).toBe(409);
  if (outcome.error.code.startsWith('ORDER_FUNDING_')) expect(outcome.error.definitiveNoMutation).toBe(true);
  const after = await Order.findById(fixture.order._id).lean();
  expect(after.orderStatus).toBe(before.orderStatus);
  expect(after.sellerFulfillment.map(row => row.status)).toEqual(before.sellerFulfillment.map(row => row.status));
  expect(after.isDelivered).toBe(before.isDelivered);
  expect(await NotificationOutbox.countDocuments()).toBe(notifications);
}

describe('provider refund/reversal is fulfillment authority, not the historic paid flag', () => {
  test.each(['confirmed', 'processing', 'shipped', 'delivered'])('full external refund blocks seller forward transition %s', async status => {
    const fixture = await capturedOrder();
    fixture.remote.refund(fixture.payment, [fixture.payment.amountMinor]);
    await fixture.remote.service.reconcilePayment(fixture.payment._id);
    expect((await Payment.findById(fixture.payment._id)).status).toBe('refunded');
    expect((await Order.findById(fixture.order._id)).isPaid).toBe(true);
    await expectBlocked(fixture, status);
  });

  test('full external refund blocks an admin aggregate shipment as well', async () => {
    const fixture = await capturedOrder({ sellers: [oid(), oid()], amounts: [1000, 2000] });
    fixture.remote.refund(fixture.payment, [fixture.payment.amountMinor]);
    await fixture.remote.service.reconcilePayment(fixture.payment._id);
    await expectBlocked(fixture, 'shipped', { actorRole: 'admin' });
  });

  test.each(['TRACKER_DISPUTED', 'TRACKER_REVERSED', 'TRACKER_VOIDED'])('%s blocks seller shipment after capture', async state => {
    const fixture = await capturedOrder();
    fixture.remote.setState(state);
    await fixture.remote.service.reconcilePayment(fixture.payment._id);
    expect((await Payment.findById(fixture.payment._id)).riskPending).toBe(true);
    expect(await RiskHold.countDocuments({ seller: fixture.sellers[0], status: 'pending' })).toBe(1);
    await expectBlocked(fixture);
  });

  test('an external partial refund without seller-cancellation attribution blocks both seller portions', async () => {
    const fixture = await capturedOrder({ sellers: [oid(), oid()], amounts: [1000, 2000] });
    fixture.remote.refund(fixture.payment, [10000]);
    await fixture.remote.service.reconcilePayment(fixture.payment._id);
    const payment = await Payment.findById(fixture.payment._id);
    expect(payment.status).toBe('paid');
    expect(payment.refundedMinor).toBe(10000);
    expect(payment.riskPending).toBe(false);
    // The generic reversal ledger may reconcile every cent while still not
    // proving which physical goods remain funded. "paid" alone is insufficient.
    expect(await SellerBalanceTransaction.countDocuments({ type: 'reversal' })).toBeGreaterThan(0);
    await expectBlocked(fixture, 'shipped');
    await expectBlocked(fixture, 'shipped', { sellerIndex: 1 });
  });

  test.each(['TRACKER_REFUNDED', 'TRACKER_DISPUTED', 'TRACKER_REVERSED'])('Wallet-paid order blocks shipment when source top-up becomes %s', async state => {
    const fixture = await walletOrder();
    if (state === 'TRACKER_REFUNDED') fixture.remote.refund(fixture.payment, [fixture.payment.amountMinor]);
    else fixture.remote.setState(state);
    await fixture.remote.service.reconcilePayment(fixture.payment._id);
    expect((await Wallet.findOne({ user: fixture.buyer })).status).toBe('locked');
    expect((await Payment.findById(fixture.payment._id)).riskPending).toBe(true);
    await expectBlocked(fixture);
  });

  test.each(['TRACKER_DISPUTED', 'TRACKER_REVERSED'])('a cancelled-card Wallet credit spent on a new order follows original %s risk', async state => {
    const original = await capturedOrder();
    const quote = await previewBuyerCancellation({ orderId: original.order._id, buyerId: original.buyer });
    await cancelBuyerOrder({ orderId: original.order._id, buyerId: original.buyer,
      refundDestination: 'wallet', quoteId: quote.quoteId });
    const credit = await WalletTransaction.findOne({ user: original.buyer, type: 'return_refund' });
    expect(credit.metadata.cardRefundFunding).toBe(true);
    expect(String(credit.safepayPaymentId)).toBe(String(original.payment._id));
    const next = await quotedOrder({ method: 'wallet', buyer: original.buyer });
    await payOrderWithWallet({ orderId: next.order._id, userId: next.buyer });
    const debit = await WalletTransaction.findOne({ referenceId: String(next.order._id), type: 'order_payment' });
    expect(debit.metadata.fundingProvenance[0].sourceTransactionId).toBe(String(credit._id));
    original.remote.setState(state);
    await original.remote.service.reconcilePayment(original.payment._id);
    expect(await RiskHold.countDocuments({ seller: next.sellers[0], status: 'pending' })).toBe(1);
    await expectBlocked(next);
  });
});

describe('legitimate funding remains usable without allowing ownership substitutions', () => {
  test('captured card payment still permits seller shipment with immutable native prices/fees intact', async () => {
    const fixture = await capturedOrder({ currency: 'USD', amounts: [301.2] });
    const before = await Order.findById(fixture.order._id).lean();
    await forward(fixture);
    const after = await Order.findById(fixture.order._id).lean();
    expect(after.sellerFulfillment[0].status).toBe('shipped');
    expect(after.sellerCurrencyMoney).toEqual(before.sellerCurrencyMoney);
    expect(after.onlineFeeSnapshot).toEqual(before.onlineFeeSnapshot);
    expect(after.orderSummary.totalAmount).toBe(1.01);
  });

  test.each([true, false])('actual Wallet debit permits shipment with tracked-card principal=%s', async tracked => {
    const fixture = await walletOrder({ tracked });
    await forward(fixture);
    expect((await Order.findById(fixture.order._id)).sellerFulfillment[0].status).toBe('shipped');
    expect((await Wallet.findOne({ user: fixture.buyer })).balances.PKR).toBe(0);
  });

  test('COD requires stock but no captured card or Wallet debit for shipment', async () => {
    const fixture = await quotedOrder({ method: 'cash_on_delivery' });
    await commitOrderInventory(fixture.order._id);
    await forward(fixture);
    expect((await Order.findById(fixture.order._id)).sellerFulfillment[0].status).toBe('shipped');
    expect(await Payment.countDocuments()).toBe(0);
    expect(await WalletTransaction.countDocuments()).toBe(0);
  });

  test.each(['safepay', 'wallet'])('genuinely zero %s checkout completes and ships without external funding', async method => {
    const fixture = await quotedOrder({ method, amounts: [0], noCharge: true });
    await mongoose.connection.transaction(session => completeNoChargeOrder({ orderId: fixture.order._id, session }));
    await forward(fixture);
    expect((await Order.findById(fixture.order._id)).sellerFulfillment[0].status).toBe('shipped');
    expect(await Payment.countDocuments()).toBe(0);
    expect(await WalletTransaction.countDocuments()).toBe(0);
  });

  test('a forged paid flag without a direct-card authority record fails closed', async () => {
    const fixture = await capturedOrder();
    await Payment.deleteOne({ _id: fixture.payment._id });
    await expectBlocked(fixture);
  });

  test.each([
    ['authorized-only', { status: 'authorized', capturedMinor: 0 }],
    ['not-applied', { appliedAt: null }],
    ['short-capture', { capturedMinor: 99999 }],
    ['unsettled', { status: 'ready' }],
  ])('historically paid order cannot substitute %s provider authority for a captured payment', async (_label, change) => {
    const fixture = await capturedOrder();
    await Payment.collection.updateOne({ _id: fixture.payment._id }, { $set: change });
    await expectBlocked(fixture);
  });

  test.each(['user', 'order', 'currency', 'environment', 'tracker', 'amountMinor'])('mismatched immutable payment %s fails closed', async field => {
    const fixture = await capturedOrder();
    const value = ['user', 'order'].includes(field) ? oid()
      : field === 'currency' ? 'USD' : field === 'environment' ? 'production'
        : field === 'tracker' ? `track_different-${oid()}` : fixture.payment.amountMinor + 1;
    // collection write deliberately models invalid old/admin/corrupted data;
    // ordinary Mongoose updates correctly cannot change immutable identity.
    await Payment.collection.updateOne({ _id: fixture.payment._id }, { $set: { [field]: value } });
    await expectBlocked(fixture);
  });

  test('Wallet paid flag without its completed immutable debit fails closed', async () => {
    const fixture = await walletOrder();
    await WalletTransaction.deleteOne({ _id: fixture.debit._id });
    await expectBlocked(fixture);
  });

  test.each(['user', 'referenceId', 'amount', 'currency', 'direction', 'status'])('mismatched Wallet debit %s fails closed', async field => {
    const fixture = await walletOrder();
    const value = field === 'user' ? oid() : field === 'referenceId' ? String(oid())
      : field === 'amount' ? fixture.debit.amount + 1 : field === 'currency' ? 'USD'
        : field === 'direction' ? 'credit' : 'failed';
    await WalletTransaction.collection.updateOne({ _id: fixture.debit._id }, { $set: { [field]: value } });
    await expectBlocked(fixture);
  });

  test('a missing tracked top-up source cannot silently become untracked Wallet principal', async () => {
    const fixture = await walletOrder();
    const sourceId = fixture.debit.metadata.fundingProvenance[0].sourceTransactionId;
    await WalletTransaction.deleteOne({ _id: sourceId });
    await expectBlocked(fixture);
  });

  test('a tracked Wallet source must belong to the same buyer as the order debit', async () => {
    const fixture = await walletOrder();
    const sourceId = fixture.debit.metadata.fundingProvenance[0].sourceTransactionId;
    await WalletTransaction.collection.updateOne({ _id: new mongoose.Types.ObjectId(sourceId) }, { $set: { user: oid() } });
    await expectBlocked(fixture);
  });

  test('a malformed Wallet principal allocation fails closed instead of skipping its risk source', async () => {
    const fixture = await walletOrder();
    await WalletTransaction.collection.updateOne({ _id: fixture.debit._id }, {
      $set: { 'metadata.fundingProvenance.0.sourceTransactionId': '',
        'metadata.fundingProvenance.0.amountMinor': -1 },
    });
    await expectBlocked(fixture);
  });

  test('a known Safepay funding credit cannot lose its provider reference and masquerade as legacy funding', async () => {
    const fixture = await walletOrder();
    const sourceId = fixture.debit.metadata.fundingProvenance[0].sourceTransactionId;
    await WalletTransaction.collection.updateOne({ _id: new mongoose.Types.ObjectId(sourceId) }, {
      $unset: { safepayPaymentId: '' },
    });
    fixture.remote.setState('TRACKER_REVERSED');
    await fixture.remote.service.reconcilePayment(fixture.payment._id);
    expect((await Payment.findById(fixture.payment._id)).riskPending).toBe(true);
    await expectBlocked(fixture);
  });

  test('a seller cannot substitute a stale fulfillment row for ownership', async () => {
    const fixture = await capturedOrder();
    const intruder = oid();
    await Order.updateOne({ _id: fixture.order._id }, { $push: { sellerFulfillment: { seller: intruder, status: 'confirmed' } } });
    await expect(transitionOrderFulfillment({ orderId: fixture.order._id, actorRole: 'seller', actorId: intruder, newStatus: 'shipped' }))
      .rejects.toMatchObject({ code: 'SELLER_FULFILLMENT_NOT_FOUND', statusCode: 403 });
  });
});

describe('scoped buyer cancellation and funding fences', () => {
  test('parallel same-status taps create the first seller fence without duplicate financial/lifecycle effects', async () => {
    const fixture = await capturedOrder();
    expect(await SellerLock.countDocuments()).toBe(0);
    const outcomes = await Promise.allSettled([forward(fixture), forward(fixture)]);
    expect(outcomes.map(row => row.status)).toEqual(['fulfilled', 'fulfilled']);
    const order = await Order.findById(fixture.order._id);
    expect(order.sellerFulfillment[0].status).toBe('shipped');
    const events = await NotificationOutbox.find({ aggregateId: String(order._id), eventType: 'order.seller_fulfillment_updated' }).lean();
    expect(events.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(new Set(events.map(row => row.eventKey)).size).toBe(1);
    expect(await SellerBalanceTransaction.countDocuments()).toBe(0);
  });

  test('two independently funded seller portions can ship concurrently without a lost sibling transition', async () => {
    const fixture = await capturedOrder({ sellers: [oid(), oid()], amounts: [1000, 2000] });
    const outcomes = await Promise.allSettled([forward(fixture), forward(fixture, 'shipped', 1)]);
    expect(outcomes.map(row => row.status)).toEqual(['fulfilled', 'fulfilled']);
    const order = await Order.findById(fixture.order._id);
    expect(order.orderStatus).toBe('shipped');
    expect(order.sellerFulfillment.map(row => row.status)).toEqual(['shipped', 'shipped']);
  });

  test.each(['wallet', 'original_card'])('card cancellation to %s leaves the other seller portion shippable', async destination => {
    const fixture = await capturedOrder({ sellers: [oid(), oid()], amounts: [1000, 2000] });
    const quote = await previewBuyerCancellation({ orderId: fixture.order._id, buyerId: fixture.buyer,
      sellerIds: [String(fixture.sellers[0])] });
    await cancelBuyerOrder({ orderId: fixture.order._id, buyerId: fixture.buyer,
      sellerIds: [String(fixture.sellers[0])], refundDestination: destination,
      quoteId: quote.quoteId, acceptDeduction: true });
    if (destination === 'original_card') {
      const row = await Cancellation.findOne({ order: fixture.order._id, seller: fixture.sellers[0] });
      // Local worker's durable mutation boundary; POST success isn't assumed.
      // The normal reconciler below independently confirms provider evidence.
      row.refundStatus = 'processing'; row.submitStartedAt = new Date();
      row.refundBaselineMinor = 0; row.refundTargetMinor = row.refundAmountMinor;
      await row.save();
      fixture.remote.refund(fixture.payment, [row.refundAmountMinor]);
      await fixture.remote.service.reconcilePayment(fixture.payment._id);
      expect((await Cancellation.findById(row._id)).refundStatus).toBe('refunded');
    }
    await forward(fixture, 'shipped', 1);
    const result = await Order.findById(fixture.order._id);
    expect(result.sellerFulfillment.map(row => row.status)).toEqual(['cancelled', 'shipped']);
    await expectBlocked(fixture, 'shipped');
  });

  test('Wallet cancellation leaves the other funded seller portion shippable', async () => {
    const fixture = await walletOrder({ sellers: [oid(), oid()], amounts: [1000, 2000] });
    await cancelBuyerOrder({ orderId: fixture.order._id, buyerId: fixture.buyer,
      sellerIds: [String(fixture.sellers[0])], refundDestination: 'wallet' });
    await forward(fixture, 'shipped', 1);
    expect((await Order.findById(fixture.order._id)).sellerFulfillment.map(row => row.status))
      .toEqual(['cancelled', 'shipped']);
  });

  test('a reconciliation holding the shared seller fence must win before shipment can commit', async () => {
    const fixture = await capturedOrder();
    // Existing fence avoids an unrelated first-upsert duplicate-key race.
    await SellerLock.updateOne({ seller: fixture.sellers[0] }, { $setOnInsert: { version: 0 } }, { upsert: true });
    let signal, release;
    const reached = new Promise(resolve => { signal = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const remote = createSafepayPaymentService({
      configFor: () => ({ environment: 'sandbox' }),
      clientFor: () => ({ getTracker: async () => ({ state: 'TRACKER_DISPUTED' }) }),
      quarantine: async (...args) => {
        const result = await quarantineSafepayPayment(...args);
        signal();
        await gate;
        return result;
      },
    });
    const reconciliation = remote.reconcilePayment(fixture.payment._id);
    await reached;
    let dispatchFinished = false;
    const dispatch = forward(fixture).then(
      value => { dispatchFinished = true; return { value }; },
      error => { dispatchFinished = true; return { error }; },
    );
    await new Promise(resolve => setTimeout(resolve, 100));
    const finishedBeforeReconciliation = dispatchFinished;
    release();
    await reconciliation;
    const result = await dispatch;
    expect(finishedBeforeReconciliation).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.code).toBe('ORDER_FUNDING_REVERSED');
    expect((await Order.findById(fixture.order._id)).sellerFulfillment[0].status).toBe('confirmed');
    expect((await Payment.findById(fixture.payment._id)).riskPending).toBe(true);
  });

  test('the consumed top-up payment write fence prevents stale-funded shipment before a seller hold exists', async () => {
    const fixture = await walletOrder();
    await SellerLock.updateOne({ seller: fixture.sellers[0] }, { $setOnInsert: { version: 0 } }, { upsert: true });
    let signal, release;
    const reached = new Promise(resolve => { signal = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    // Model the authoritative provider record becoming risky while its
    // derived hold has not been written. That source may have funded several
    // later orders/sellers, so a seller-local lock alone is not enough.
    const sourceChange = mongoose.connection.transaction(async session => {
      await Payment.updateOne({ _id: fixture.payment._id }, { $set: {
        status: 'manual_review', riskPending: true, providerState: 'TRACKER_REVERSED',
      }, $inc: { __v: 1 } }, { session });
      signal();
      await gate;
    });
    await reached;
    let dispatchFinished = false;
    const dispatch = forward(fixture).then(
      value => { dispatchFinished = true; return { value }; },
      error => { dispatchFinished = true; return { error }; },
    );
    await new Promise(resolve => setTimeout(resolve, 100));
    const finishedBeforeSourceCommit = dispatchFinished;
    release();
    await sourceChange;
    const result = await dispatch;
    expect(finishedBeforeSourceCommit).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.code).toBe('ORDER_FUNDING_REVERSED');
    expect((await Order.findById(fixture.order._id)).sellerFulfillment[0].status).toBe('confirmed');
    expect(await RiskHold.countDocuments()).toBe(0);
  });
});

describe('active AI execution receipts preserve definitive funding rejections', () => {
  test('refunded v2 order rejects active AI shipment definitively and replays its completed rejection without mutation', async () => {
    const fixture = await capturedOrder();
    fixture.remote.refund(fixture.payment, [fixture.payment.amountMinor]);
    await fixture.remote.service.reconcilePayment(fixture.payment._id);
    const before = await Order.findById(fixture.order._id).lean();
    const notificationCount = await NotificationOutbox.countDocuments();
    const args = { orderId: String(fixture.order._id), newStatus: 'shipped',
      _chatRequestKey: `ai-funding-rejected:${oid()}`, _chatToolOrdinal: 0 };
    const actor = { _id: fixture.sellers[0], role: 'seller', currency: 'PKR' };
    const first = await executeToolCall('update_order_status', args, actor);
    expect(first).toMatchObject({ success: false, code: 'ORDER_FUNDING_REVERSED' });
    expect(first.code).not.toBe('AI_ACTION_PENDING');
    const receipt = await AIActionReceipt.findOne({ user: actor._id, requestKey: args._chatRequestKey, toolOrdinal: 0 }).lean();
    expect(receipt).toMatchObject({ action: 'update_order_status', status: 'completed', result: first });
    const replay = await executeToolCall('update_order_status', args, actor);
    expect(replay).toEqual(first);
    expect(await AIActionReceipt.countDocuments()).toBe(1);
    const after = await Order.findById(fixture.order._id).lean();
    expect(after.orderStatus).toBe(before.orderStatus);
    expect(after.sellerFulfillment.map(row => row.status)).toEqual(before.sellerFulfillment.map(row => row.status));
    expect(await NotificationOutbox.countDocuments()).toBe(notificationCount);
  });

  test('failed rejection-receipt finalization returns controlled pending and retains the original execution claim', async () => {
    const fixture = await capturedOrder();
    fixture.remote.refund(fixture.payment, [fixture.payment.amountMinor]);
    await fixture.remote.service.reconcilePayment(fixture.payment._id);
    const args = { orderId: String(fixture.order._id), newStatus: 'shipped',
      _chatRequestKey: `ai-funding-receipt-failure:${oid()}`, _chatToolOrdinal: 0 };
    const actor = { _id: fixture.sellers[0], role: 'seller', currency: 'PKR' };
    const notificationCount = await NotificationOutbox.countDocuments();
    const writeReceipt = AIActionReceipt.updateOne.bind(AIActionReceipt);
    const receiptFailure = jest.spyOn(AIActionReceipt, 'updateOne').mockImplementation((filter, update, ...rest) => {
      if (filter.requestKey === args._chatRequestKey && update.$set?.status === 'completed'
          && update.$set?.result?.code === 'ORDER_FUNDING_REVERSED') {
        return Promise.reject(new Error('Simulated definitive rejection receipt write outage'));
      }
      return writeReceipt(filter, update, ...rest);
    });
    const first = await executeToolCall('update_order_status', args, actor)
      .then(result => ({ result }), error => ({ unhandledError: error }));
    receiptFailure.mockRestore();
    const receipt = await AIActionReceipt.findOne({ user: actor._id, requestKey: args._chatRequestKey, toolOrdinal: 0 }).lean();
    const retry = await executeToolCall('update_order_status', args, actor);
    expect(receipt).toMatchObject({ action: 'update_order_status', status: 'processing', result: null });
    expect(retry).toMatchObject({ success: false, code: 'AI_ACTION_PENDING' });
    expect(first.unhandledError).toBeUndefined();
    expect(first.result).toMatchObject({ success: false, code: 'AI_ACTION_PENDING' });
    const after = await Order.findById(fixture.order._id).lean();
    expect(after.orderStatus).toBe('confirmed');
    expect(after.sellerFulfillment[0].status).toBe('confirmed');
    expect(await NotificationOutbox.countDocuments()).toBe(notificationCount);
  });
});
