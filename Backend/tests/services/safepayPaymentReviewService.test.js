'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Payment = require('../../models/SafepayPayment');
const Review = require('../../models/SafepayPaymentReview');
const Order = require('../../models/Order');
const User = require('../../models/User');
const Hold = require('../../models/SellerPaymentRiskHold');
const SellerLock = require('../../models/SellerSettlementLock');
const Balance = require('../../models/SellerBalanceTransaction');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const ReturnRequest = require('../../models/ReturnRequest');
const Cancellation = require('../../models/OrderCancellation');
const { buildOrderSellerSettlement, buildOrderSellerCurrencyMoney } = require('../../services/orderMoneyService');
const { buildOnlineOrderFee } = require('../../services/onlineOrderFeeService');
const { computeNativeSellerAccounting } = require('../../services/sellerNativeAccountingService');
const { observeBankReview, createSafepayPaymentReviewService } = require('../../services/safepayPaymentReviewService');
const { runInTransaction } = require('../../services/walletService');
let replica;
let admin, actor, fixture, tracker, resolver;
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await Promise.all([Payment, Review, Order, User, Hold, SellerLock, Balance, Wallet, WalletTransaction, ReturnRequest, Cancellation].map(model => model.init()));
}, 120000);
afterAll(async () => { await mongoose.disconnect(); await replica?.stop(); });
beforeEach(async () => {
  for (const model of [Payment, Review, Order, User, Hold, SellerLock, Balance, Wallet, WalletTransaction, ReturnRequest, Cancellation]) await model.deleteMany({});
  admin = await User.create({ username: 'Review Admin', email: 'review-admin@example.com', role: 'admin', status: 'active' });
  actor = await User.create({ username: 'Review Buyer', email: 'review-buyer@example.com', role: 'user', status: 'active' });
  resolver = createSafepayPaymentReviewService({ configFor: () => ({ environment: 'sandbox', publicKey: 'sec_owned-review-merchant' }),
    clientFor: () => ({ getTracker: jest.fn(async () => structuredClone(tracker)) }) });
});

async function makeFixture(currency = 'PKR', amounts = [1000], { nativeCurrency = currency } = {}) {
  const rates = { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 };
  const total = amounts.reduce((sum, value) => sum + value, 0);
  const sellers = amounts.map(() => new mongoose.Types.ObjectId());
  const order = new Order({ user: actor._id, orderId: `ORD-REVIEW-${new mongoose.Types.ObjectId()}`, currency,
    orderItems: amounts.map((price, index) => ({ productId: new mongoose.Types.ObjectId(), seller: sellers[index],
      name: `Review item ${index}`, image: 'https://example.com/item.png', quantity: 1, price,
      lineSubtotal: price, sourcePrice: price * rates[nativeCurrency] / rates[currency],
      sourceLineSubtotal: price * rates[nativeCurrency] / rates[currency], sourceCurrency: nativeCurrency })),
    orderSummary: { subtotal: total, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: total },
    shippingInfo: { fullName: 'Review Buyer', email: 'review-buyer@example.com', phone: '+923001234567',
      address: 'Test address', city: 'Lahore', state: 'Punjab', postalCode: '54000', country: 'Pakistan' },
    shippingMethod: { name: 'free', price: 0, estimatedDays: 3 },
    sellerShipping: sellers.map(seller => ({ seller, shippingMethod: { name: 'free', price: 0, estimatedDays: 3,
      sourceCost: 0, sourceCurrency: nativeCurrency } })),
    sellerPolicies: sellers.map(seller => ({ seller, productCurrency: nativeCurrency, returnsEnabled: false })),
    sellerFulfillment: sellers.map(seller => ({ seller, status: 'delivered', deliveredAt: new Date('2026-01-01') })),
    exchangeRateSnapshot: { base: 'USD', rates, capturedAt: new Date('2026-01-01'), source: 'test-frozen', fallback: false },
    paymentMethod: 'safepay', safepayEnvironment: 'sandbox', paymentFlow: 'safepay_hosted', isPaid: true,
    paidAt: new Date('2026-01-01'), paymentFulfilledAt: new Date('2026-01-01'), awaitingPayment: false,
    orderStatus: 'delivered', isDelivered: true, deliveredAt: new Date('2026-01-01'), inventoryCommitted: true });
  order.sellerSettlementVersion = 1; order.sellerSettlement = buildOrderSellerSettlement(order, { requireOrderTotal: true });
  order.sellerCurrencyMoneyVersion = 1; order.sellerCurrencyMoney = buildOrderSellerCurrencyMoney(order);
  order.onlineFeeSnapshot = buildOnlineOrderFee(order);
  const payment = await Payment.create({ user: actor._id, environment: 'sandbox', purpose: 'order', reference: `order:${order._id}`,
    order: order._id, requestKey: `review:${order._id}`, fingerprint: 'a'.repeat(64), currency,
    amountMinor: Math.round(total * 100), capturedMinor: Math.round(total * 100), status: 'manual_review', riskPending: true,
    tracker: `track_review-${new mongoose.Types.ObjectId()}`, paidAt: new Date('2026-01-01'), appliedAt: new Date('2026-01-01') });
  order.safepayPaymentId = payment._id; order.safepayTrackerId = payment.tracker; await order.save();
  tracker = { token: payment.tracker, environment: 'sandbox', intent: 'CYBERSOURCE', state: 'TRACKER_DISPUTED',
    client: 'sec_owned-review-merchant', mode: 'payment', metadata: { order_id: payment.reference },
    purchase_totals: { quote_amount: { currency, amount: payment.amountMinor } },
    charge: { token: 'ch_owned-review-fixture', tracker: payment.tracker,
      amount: { currency, amount: payment.amountMinor },
      capture: { token: 'cap_owned-review-fixture', tracker: payment.tracker, totals: { currency, amount: payment.amountMinor } },
      balance: { currency, amount: payment.amountMinor } } };
  const result = await runInTransaction(session => observeBankReview(payment, tracker, { orders: [order], sellers, session }));
  return { payment, order, sellers, review: await Review.findById(result.review._id) };
}
const input = (review, outcome = 'lost', overrides = {}) => ({ outcome,
  bankReportedPrincipalMinor: outcome === 'lost' ? review.originalAmountMinor : 0,
  expectedRevision: review.revision, expectedProviderFingerprint: review.providerFingerprint,
  operationKey: `review-resolution-${review._id}`, providerCaseReference: `CASE-${review._id}`,
  evidenceText: 'SIMULATED SANDBOX ONLY: final bank decision reviewed for this exact owned payment; no real bank dispute occurred.',
  confirmedProviderDecision: true, ...overrides });

test('won review releases only its holds and creates no deduction', async () => {
  fixture = await makeFixture();
  const unrelated = await Hold.create({ seller: fixture.sellers[0], provider: 'safepay', providerPaymentId: 'track_unrelated-owned-payment',
    providerEnvironment: 'sandbox', sourceType: 'order_payment', sourceReferenceId: 'unrelated', eventId: 'other-review',
    eventType: 'TRACKER_DISPUTED', riskTrack: 'dispute', riskTrackKey: 'other-dispute', unknownExposure: true });
  await resolver.resolveReview(String(fixture.review._id), input(fixture.review, 'won'), String(admin._id));
  expect(await Balance.countDocuments()).toBe(0);
  expect((await Hold.findById(unrelated._id)).status).toBe('pending');
  expect(await Hold.countDocuments({ _id: { $in: fixture.review.holdIds }, status: 'pending' })).toBe(0);
  const stored = await Payment.findById(fixture.payment._id); expect(stored.status).toBe('paid'); expect(stored.riskPending).toBe(false);
});

test.each(['PKR', 'USD', 'EUR', 'GBP'])('lost %s review records exactly the original native amount once', async currency => {
  fixture = await makeFixture(currency);
  const request = input(fixture.review);
  await resolver.resolveReview(String(fixture.review._id), request, String(admin._id));
  await resolver.resolveReview(String(fixture.review._id), request, String(admin._id));
  const rows = await Balance.find({ seller: fixture.sellers[0] }).lean();
  expect(rows).toHaveLength(1); expect(rows[0].status).toBe('completed'); expect(rows[0].referenceType).toBe('safepay_payment');
  expect(rows[0].sourceAmount).toBe(1000); expect(rows[0].sourceCurrency).toBe(currency);
  expect((await Payment.findById(fixture.payment._id)).status).toBe('reversed');
  const accounting = computeNativeSellerAccounting({ sellerId: fixture.sellers[0], orders: [fixture.order.toObject()], transactions: rows, reportingCurrency: currency });
  expect(accounting.balanceByCurrency[currency].paymentReversalDebits).toBe(1000);
  expect(accounting.balanceByCurrency[currency].withdrawableBalance).toBe(0);
  expect(accounting.balanceByCurrency[currency].deficit).toBe(0);
});

test('a full loss after an existing payout creates a deficit, not a second payout debit', async () => {
  fixture = await makeFixture();
  await resolver.resolveReview(String(fixture.review._id), input(fixture.review), String(admin._id));
  const rows = await Balance.find({ seller: fixture.sellers[0] }).lean();
  const withdrawals = [{ status: 'paid', balanceVersion: 2, currency: 'PKR', requestedCurrency: 'PKR', payoutCurrency: 'PKR',
    amount: 908, requestedAmount: 908, payoutAmount: 908 }];
  const accounting = computeNativeSellerAccounting({ sellerId: fixture.sellers[0], orders: [fixture.order.toObject()], transactions: rows, withdrawals, reportingCurrency: 'PKR' });
  expect(accounting.balanceByCurrency.PKR.paymentReversalDebits).toBe(1000);
  expect(accounting.balanceByCurrency.PKR.deficit).toBe(908);
  expect(accounting.balanceByCurrency.PKR.totalWithdrawn).toBe(908);
});

test.each([[500, 500], [300, 300, 400]].map(amounts => [amounts]))('partial multi-seller loss conserves exact cents for %j', async amounts => {
  fixture = await makeFixture('PKR', amounts);
  await resolver.resolveReview(String(fixture.review._id), input(fixture.review, 'lost', { bankReportedPrincipalMinor: 101 }), String(admin._id));
  const rows = await Balance.find({}).lean();
  expect(rows.reduce((sum, row) => sum + Math.round(row.sourceAmount * 100), 0)).toBe(101);
  expect(rows.every(row => fixture.sellers.some(seller => String(seller) === String(row.seller)))).toBe(true);
});

test.each([
  ['missing evidence', { evidenceText: '' }], ['unconfirmed decision', { confirmedProviderDecision: false }],
  ['too much principal', { bankReportedPrincipalMinor: 100001 }], ['fractional principal', { bankReportedPrincipalMinor: 1.5 }],
  ['string principal', { bankReportedPrincipalMinor: '1000' }], ['stale revision', { expectedRevision: 99 }],
  ['stale fingerprint', { expectedProviderFingerprint: '0'.repeat(64) }], ['missing key', { operationKey: '' }],
])('rejects %s without clearing holds or changing money', async (_label, changes) => {
  fixture = await makeFixture();
  await expect(resolver.resolveReview(String(fixture.review._id), input(fixture.review, 'lost', changes), String(admin._id))).rejects.toBeTruthy();
  expect(await Balance.countDocuments()).toBe(0);
  expect((await Review.findById(fixture.review._id)).status).toBe('pending');
  expect(await Hold.countDocuments({ status: 'pending' })).toBeGreaterThan(0);
});

test('seller cannot resolve a review; changing the outcome or principal after resolution is rejected', async () => {
  fixture = await makeFixture();
  const request = input(fixture.review);
  await expect(resolver.resolveReview(String(fixture.review._id), request, String(actor._id))).rejects.toMatchObject({ code: 'SAFEPAY_REVIEW_FORBIDDEN' });
  await resolver.resolveReview(String(fixture.review._id), request, String(admin._id));
  await expect(resolver.resolveReview(String(fixture.review._id), { ...request, outcome: 'won', bankReportedPrincipalMinor: 0 }, String(admin._id))).rejects.toMatchObject({ code: 'SAFEPAY_REVIEW_ALREADY_RESOLVED' });
  expect(await Balance.countDocuments()).toBe(1);
  const projected = await Review.findById(fixture.review._id).lean();
  expect(projected.evidenceText).toBeUndefined(); expect(projected.providerCaseReference).toBeUndefined();
});

test('changed provider evidence and a running reconciliation lease refuse resolution', async () => {
  fixture = await makeFixture();
  tracker.charge.balance.amount -= 1;
  await expect(resolver.resolveReview(String(fixture.review._id), input(fixture.review), String(admin._id))).rejects.toMatchObject({ code: 'SAFEPAY_REVIEW_STALE' });
  tracker.charge.balance.amount += 1;
  await Payment.updateOne({ _id: fixture.payment._id }, { $set: { leaseUntil: new Date(Date.now() + 60000) } });
  await expect(resolver.resolveReview(String(fixture.review._id), input(fixture.review), String(admin._id))).rejects.toMatchObject({ code: 'SAFEPAY_REVIEW_BUSY' });
  expect(await Balance.countDocuments()).toBe(0);
});

test('concurrent identical decisions commit one debit', async () => {
  fixture = await makeFixture();
  const request = input(fixture.review);
  await Promise.all([resolver.resolveReview(String(fixture.review._id), request, String(admin._id)), resolver.resolveReview(String(fixture.review._id), request, String(admin._id))]);
  expect(await Balance.countDocuments()).toBe(1);
});

async function walletFixture(spentAmounts = [600], totalMinor = 100000) {
  const base = await makeFixture('PKR', spentAmounts);
  await Review.deleteMany({}); await Hold.deleteMany({}); await Payment.deleteMany({});
  const order = base.order;
  order.paymentMethod = 'wallet'; order.safepayPaymentId = null; order.safepayTrackerId = null;
  await order.save();
  const spentMinor = Math.round(spentAmounts.reduce((sum, amount) => sum + amount, 0) * 100);
  const wallet = await Wallet.create({ user: actor._id, balances: { PKR: (totalMinor - spentMinor) / 100 },
    status: 'locked', lockSource: 'system', lockedReason: 'A Safepay-funded payment needs reconciliation. Please contact support.' });
  const payment = await Payment.create({ user: actor._id, environment: 'sandbox', purpose: 'wallet_top_up',
    reference: `wallet:${wallet._id}`, requestKey: `review-wallet:${wallet._id}`, fingerprint: 'b'.repeat(64),
    currency: 'PKR', amountMinor: totalMinor, capturedMinor: totalMinor, status: 'manual_review', riskPending: true,
    tracker: `track_review-wallet-${wallet._id}`, paidAt: new Date('2026-01-01'), appliedAt: new Date('2026-01-01') });
  const source = await WalletTransaction.create({ user: actor._id, wallet: wallet._id, type: 'top_up', direction: 'credit',
    status: 'completed', amount: totalMinor / 100, currency: 'PKR', referenceType: 'safepay_payment', referenceId: payment.tracker,
    idempotencyKey: `safepay:sandbox:${payment._id}:wallet-credit`, safepayPaymentId: payment._id,
    safepayTrackerId: payment.tracker, safepayEnvironment: 'sandbox', paymentFlow: 'safepay_hosted', paymentSetupState: 'complete',
    completedAt: new Date('2026-01-01'), metadata: { availableCreditedMinor: totalMinor,
      fundingRemainingMinor: totalMinor - spentMinor, fundingOriginalAvailableMinor: totalMinor } });
  if (spentMinor) await WalletTransaction.create({ user: actor._id, wallet: wallet._id, type: 'order_payment', direction: 'debit',
    status: 'completed', amount: spentMinor / 100, currency: 'PKR', referenceType: 'order', referenceId: String(order._id),
    idempotencyKey: `wallet-order:${order._id}`, completedAt: new Date('2026-01-02'), metadata: { fundingProvenance: [{
      sourceType: 'wallet_top_up', sourceTransactionId: String(source._id), orderId: String(order._id), amountMinor: spentMinor,
      sellerAllocations: order.sellerSettlement.map(entry => ({ seller: String(entry.seller), sourceAmountMinor: entry.sourceAmountMinor,
        amountUSDMinor: entry.amountUSDMinor })) }] } });
  tracker.token = payment.tracker; tracker.metadata.order_id = payment.reference; tracker.purchase_totals.quote_amount.amount = totalMinor;
  tracker.charge.tracker = payment.tracker; tracker.charge.amount.amount = totalMinor;
  tracker.charge.capture.tracker = payment.tracker; tracker.charge.capture.totals.amount = totalMinor; tracker.charge.balance.amount = totalMinor;
  const opened = await runInTransaction(session => observeBankReview(payment, tracker, { orders: spentMinor ? [order] : [], sellers: spentMinor ? base.sellers : [], session }));
  return { ...base, payment, wallet, source, review: await Review.findById(opened.review._id) };
}

test('Wallet loss collects unspent funds first, follows spent seller funds once and restores only its system lock', async () => {
  fixture = await walletFixture([300, 300]);
  const request = input(fixture.review);
  await resolver.resolveReview(String(fixture.review._id), request, String(admin._id));
  await resolver.resolveReview(String(fixture.review._id), request, String(admin._id));
  const wallet = await Wallet.findById(fixture.wallet._id), source = await WalletTransaction.findById(fixture.source._id);
  expect(wallet.balances.PKR).toBe(0); expect(wallet.status).toBe('active');
  expect(source.metadata.fundingRemainingMinor).toBe(0); expect(source.metadata.fundingOriginalAvailableMinor).toBe(60000);
  const buyerDebits = await WalletTransaction.find({ type: 'reversal' }).lean();
  expect(buyerDebits).toHaveLength(1); expect(buyerDebits[0].amount).toBe(400);
  expect(buyerDebits[0].metadata.outstandingMinor).toBe(0);
  const sellerDebits = await Balance.find({}).lean(); expect(sellerDebits).toHaveLength(2);
  expect(sellerDebits.reduce((sum, row) => sum + row.sourceAmount, 0)).toBe(600);
  expect(sellerDebits.every(row => String(row.order) === String(fixture.order._id))).toBe(true);
  const stored = await Review.findById(fixture.review._id);
  expect(stored.fundingAccounted).toBe(true);
  expect([...stored.sellerAllocations, ...stored.buyerAllocations].reduce((sum, row) => sum + row.amountMinor, 0)).toBe(100000);
});

test('partial Wallet loss preserves surviving funds and does not debit unaffected seller orders', async () => {
  fixture = await walletFixture([600]);
  await resolver.resolveReview(String(fixture.review._id), input(fixture.review, 'lost', { bankReportedPrincipalMinor: 30000 }), String(admin._id));
  expect((await Wallet.findById(fixture.wallet._id)).balances.PKR).toBe(100);
  expect(await Balance.countDocuments()).toBe(0);
  const { reviewedFundingIsHealthy } = require('../../services/safepayPaymentReviewFundingService');
  const payment = await Payment.findById(fixture.payment._id);
  await runInTransaction(async session => expect(await reviewedFundingIsHealthy(payment, fixture.order._id, session)).toBe(true));
});

test('a won Wallet case reactivates a system lock but preserves an independent admin lock', async () => {
  fixture = await walletFixture([600]);
  await Wallet.updateOne({ _id: fixture.wallet._id }, { $set: { lockSource: 'manual', lockedReason: 'Separate operational hold' } });
  await resolver.resolveReview(String(fixture.review._id), input(fixture.review, 'won'), String(admin._id));
  expect((await Wallet.findById(fixture.wallet._id)).lockedReason).toBe('Separate operational hold');
  expect(await Balance.countDocuments()).toBe(0);
  await Wallet.updateOne({ _id: fixture.wallet._id }, { $set: { lockSource: 'system',
    lockedReason: 'A Safepay-funded payment needs reconciliation. Please contact support.' } });
  const { restoreReviewedWallets } = require('../../services/safepayPaymentReviewFundingService');
  await runInTransaction(session => restoreReviewedWallets(fixture.payment, session));
  expect((await Wallet.findById(fixture.wallet._id)).status).toBe('active');
});

test('malformed Wallet provenance leaves all balances, cases and holds unchanged', async () => {
  fixture = await walletFixture([600]);
  await WalletTransaction.updateOne({ _id: fixture.source._id }, { $set: { 'metadata.fundingRemainingMinor': '40000' } });
  await expect(resolver.resolveReview(String(fixture.review._id), input(fixture.review), String(admin._id))).rejects.toMatchObject({ code: 'SAFEPAY_REVIEW_FUNDING_UNVERIFIED' });
  expect((await Review.findById(fixture.review._id)).status).toBe('pending');
  expect((await Wallet.findById(fixture.wallet._id)).balances.PKR).toBe(400);
  expect(await Balance.countDocuments()).toBe(0); expect(await Hold.countDocuments({ status: 'pending' })).toBeGreaterThan(0);
});

test('fresh provider recheck updates evidence without treating an ended tracker as a won dispute', async () => {
  fixture = await makeFixture(); tracker.state = 'TRACKER_ENDED';
  const fresh = await resolver.refreshReview(String(fixture.review._id));
  expect(fresh.status).toBe('pending'); expect(fresh.revision).toBe(1);
  expect(await Hold.countDocuments({ status: 'pending' })).toBeGreaterThan(0); expect(await Balance.countDocuments()).toBe(0);
  await expect(resolver.resolveReview(String(fixture.review._id), input(fixture.review, 'won'), String(admin._id))).rejects.toBeTruthy();
  await resolver.resolveReview(String(fixture.review._id), input(fresh, 'won'), String(admin._id));
  expect((await Payment.findById(fixture.payment._id)).status).toBe('paid');
});

test('repeated quarantine after a reviewed win or loss cannot reopen the case or duplicate its debit', async () => {
  fixture = await walletFixture([600]);
  await resolver.resolveReview(String(fixture.review._id), input(fixture.review, 'won'), String(admin._id));
  const { quarantineSafepayPayment } = require('../../services/safepaySettlementService');
  const payment = await Payment.findById(fixture.payment._id);
  const response = await runInTransaction(session => quarantineSafepayPayment(payment, tracker, session));
  expect(response.resolved).toBe(true); expect(response.status).toBe('paid');
  expect(await Review.countDocuments()).toBe(1); expect((await Wallet.findById(fixture.wallet._id)).status).toBe('active');
});

test('real admin routes enforce session ownership, private evidence and exact-once resolution', async () => {
  fixture = await makeFixture();
  const express = require('express'), request = require('supertest'), jwt = require('jsonwebtoken');
  const previous = process.env.JWT_SECRET; process.env.JWT_SECRET = 'isolated-bank-review-test-session-secret';
  try {
    const app = express(); app.use(express.json());
    const auth = require('../../middleware/authMiddleware');
    const handlers = require('../../controllers/safepayPaymentReviewController').createController({ serviceFor: () => resolver });
    app.get('/reviews', auth, handlers.listSafepayPaymentReviews);
    app.get('/reviews/:id/audit', auth, handlers.getSafepayPaymentReviewAudit);
    app.post('/reviews/:id/resolve', auth, handlers.resolveSafepayPaymentReview);
    const adminToken = jwt.sign({ id: String(admin._id), role: 'admin' }, process.env.JWT_SECRET);
    const buyerToken = jwt.sign({ id: String(actor._id), role: 'admin' }, process.env.JWT_SECRET); // forged role claim is ignored
    await request(app).get('/reviews').expect(401);
    await request(app).get('/reviews').auth(buyerToken, { type: 'bearer' }).expect(403);
    const response = await request(app).get('/reviews').auth(adminToken, { type: 'bearer' }).expect(200);
    expect(response.body.reviews).toHaveLength(1); expect(JSON.stringify(response.body)).not.toContain('evidenceText');
    const payload = input(fixture.review);
    await request(app).post(`/reviews/${fixture.review._id}/resolve`).auth(adminToken, { type: 'bearer' })
      .set('Idempotency-Key', payload.operationKey).send(payload).expect(200);
    const audit = await request(app).get(`/reviews/${fixture.review._id}/audit`).auth(adminToken, { type: 'bearer' }).expect(200);
    expect(audit.body.audit.evidence).toBe(payload.evidenceText); expect(audit.body.audit.sellerAllocations[0].amountMinor).toBe(100000);
    await request(app).get(`/reviews/${fixture.review._id}/audit`).auth(buyerToken, { type: 'bearer' }).expect(403);
    await request(app).get('/reviews?page=0').auth(adminToken, { type: 'bearer' }).expect(400);
    expect(await Balance.countDocuments()).toBe(1);
  } finally { if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; }
});

test('review notifications pass authority, cannot leak to another seller and do not expose private evidence', async () => {
  fixture = await makeFixture('PKR', [300, 700]);
  const Outbox = require('../../models/NotificationOutbox');
  await Outbox.deleteMany({});
  await resolver.resolveReview(String(fixture.review._id), input(fixture.review), String(admin._id));
  const rows = await Outbox.find({ aggregateId: String(fixture.review._id) }).select('+recipient.email +recipient.phone').lean();
  expect(rows.length).toBeGreaterThan(0);
  const { verifySafepayNotificationAuthority } = require('../../services/safepayNotificationAuthority');
  for (const row of rows) expect(await verifySafepayNotificationAuthority(row)).toBeNull();
  const seller = rows.find(row => row.recipient.audienceRole === 'seller');
  expect(await verifySafepayNotificationAuthority({ ...seller, recipient: { ...seller.recipient, user: actor._id } })).toMatchObject({ outcome: 'skipped' });
  expect(JSON.stringify(rows)).not.toContain('SIMULATED SANDBOX ONLY');
});

async function refundFixture(base, { sellerFunded = false } = {}) {
  const requestId = new mongoose.Types.ObjectId(), creditId = new mongoose.Types.ObjectId();
  const item = base.order.orderItems[0], principal = base.payment.amountMinor;
  let payment = base.payment;
  if (sellerFunded) {
    await Review.deleteMany({}); await Hold.deleteMany({}); await Payment.deleteMany({});
    // Build a new COD fixture; never mutate a saved order's immutable fee.
    const cod = new Order({ ...base.order.toObject(), paymentMethod: 'cash_on_delivery', safepayPaymentId: null, onlineFeeSnapshot: undefined });
    await Order.deleteOne({ _id: base.order._id }); base.order = await cod.save();
    payment = await Payment.create({ user: base.sellers[0], environment: 'sandbox', purpose: 'return_settlement',
      reference: `return:${requestId}`, requestKey: `return-review:${requestId}`, fingerprint: 'c'.repeat(64),
      returnRequest: requestId, currency: 'PKR', amountMinor: principal, capturedMinor: principal,
      status: 'manual_review', riskPending: true, tracker: `track_return-review-${requestId}`,
      walletRefundMinor: principal, paidAt: new Date('2026-01-01'), appliedAt: new Date('2026-01-01') });
    tracker.token = payment.tracker; tracker.metadata.order_id = payment.reference;
    tracker.charge.tracker = payment.tracker; tracker.charge.capture.tracker = payment.tracker;
  } else {
    await Payment.updateOne({ _id: payment._id }, { $set: { walletRefundMinor: principal } });
    payment = await Payment.findById(payment._id);
    await Balance.create({ seller: base.sellers[0], order: base.order._id, type: 'return_refund', direction: 'debit',
      status: 'completed', sourceCurrency: 'PKR', sourceAmount: principal / 100,
      amountUSD: base.order.sellerSettlement[0].amountUSDMinor / 100, referenceType: 'return_request', referenceId: String(requestId) });
  }
  const wallet = await Wallet.create({ user: actor._id, balances: { PKR: principal / 100 }, status: 'locked', lockSource: 'system',
    lockedReason: sellerFunded ? 'A card-funded return refund needs payment reconciliation. Please contact support.'
      : 'A card-funded Wallet refund needs reconciliation. Please contact support.' });
  const request = await ReturnRequest.create({ _id: requestId, returnNumber: `RET-REVIEW-${requestId}`, order: base.order._id,
    orderId: base.order.orderId, buyer: actor._id, seller: base.sellers[0], currency: 'PKR', status: 'returned',
    reasonCategory: 'defective', reasonDetails: 'Isolated reviewed funding fixture', eligibilityDeadline: new Date('2026-01-31'),
    policySnapshot: { returnsEnabled: true, returnDuration: 30, refundType: 'full_refund' },
    items: [{ orderItemId: item._id, productId: item.productId, name: item.name, quantity: 1, purchasedQuantity: 1, unitPrice: item.price, lineSubtotal: item.price }],
    refund: { itemSubtotal: principal / 100, taxAmount: 0, shippingAmount: 0, discountAmount: 0, totalAmount: principal / 100 },
    settlement: { status: 'completed', walletTransaction: creditId, ...(sellerFunded ? { provider: 'safepay', fundingSource: 'card',
      safepayPaymentId: payment._id, safepayEnvironment: 'sandbox' } : { fundingSource: 'held_order' }) } });
  const source = await WalletTransaction.create({ _id: creditId, user: actor._id, wallet: wallet._id, type: 'return_refund',
    direction: 'credit', status: 'completed', amount: principal / 100, currency: 'PKR', referenceType: 'return_request',
    referenceId: String(requestId), idempotencyKey: `return-refund:${requestId}`, safepayPaymentId: payment._id,
    safepayTrackerId: payment.tracker, safepayEnvironment: 'sandbox', completedAt: new Date('2026-01-02'),
    metadata: { cardRefundFunding: true, sourceOrderId: String(base.order._id), availableCreditedMinor: principal,
      fundingRemainingMinor: principal, fundingOriginalAvailableMinor: principal } });
  const opened = await runInTransaction(session => require('../../services/safepaySettlementService').quarantineSafepayPayment(payment, tracker, session));
  return { ...base, payment, request, wallet, source, review: await Review.findById(opened.review._id) };
}

test('loss of an already Wallet-refunded card order does not debit the original seller a second time', async () => {
  fixture = await refundFixture(await makeFixture());
  await resolver.resolveReview(String(fixture.review._id), input(fixture.review), String(admin._id));
  expect(await Balance.countDocuments({ type: 'reversal' })).toBe(0);
  expect(await Balance.countDocuments({ type: 'return_refund' })).toBe(1);
  expect((await Wallet.findById(fixture.wallet._id)).balances.PKR).toBe(0);
  expect(await WalletTransaction.countDocuments({ type: 'reversal' })).toBe(1);
});

test('a lost seller-funded COD refund records seller debt while preserving the buyer’s completed refund', async () => {
  fixture = await refundFixture(await makeFixture(), { sellerFunded: true });
  await resolver.resolveReview(String(fixture.review._id), input(fixture.review), String(admin._id));
  const rows = await Balance.find({}).lean(); expect(rows).toHaveLength(1); expect(rows[0].sourceAmount).toBe(1000);
  expect(String(rows[0].seller)).toBe(String(fixture.sellers[0]));
  expect((await Wallet.findById(fixture.wallet._id)).balances.PKR).toBe(1000);
  expect((await Wallet.findById(fixture.wallet._id)).status).toBe('active');
  expect(await WalletTransaction.countDocuments({ type: 'reversal' })).toBe(0);
  expect((await ReturnRequest.findById(fixture.request._id)).status).toBe('returned');
  const accounting = computeNativeSellerAccounting({ sellerId: fixture.sellers[0], orders: [fixture.order.toObject()], transactions: rows, reportingCurrency: 'PKR' });
  expect(accounting.balanceByCurrency.PKR.deficit).toBe(1000);
});

test('a foreign-currency bank loss uses the original seller currency and frozen FX, not current rates', async () => {
  fixture = await makeFixture('USD', [1000], { nativeCurrency: 'PKR' });
  await resolver.resolveReview(String(fixture.review._id), input(fixture.review), String(admin._id));
  const rows = await Balance.find({}).lean(); expect(rows[0].sourceCurrency).toBe('USD'); expect(rows[0].sourceAmount).toBe(1000);
  const summary = computeNativeSellerAccounting({ sellerId: fixture.sellers[0], orders: [fixture.order.toObject()], transactions: rows, reportingCurrency: 'PKR' });
  expect(summary.balanceByCurrency.PKR.paymentReversalDebits).toBe(280000);
  expect(summary.balanceByCurrency.USD.paymentReversalDebits).toBe(0);
});

test('future eligible earnings settle an existing deficit before becoming withdrawable', async () => {
  fixture = await makeFixture();
  await resolver.resolveReview(String(fixture.review._id), input(fixture.review), String(admin._id));
  const next = fixture.order.toObject(); next._id = new mongoose.Types.ObjectId(); next.orderId = 'ORD-NEXT-ELIGIBLE';
  next.orderItems[0].price = 1500; next.orderItems[0].lineSubtotal = 1500;
  next.orderItems[0].sourcePrice = 1500; next.orderItems[0].sourceLineSubtotal = 1500;
  next.orderSummary.subtotal = 1500; next.orderSummary.totalAmount = 1500;
  next.sellerSettlement = buildOrderSellerSettlement(next, { requireOrderTotal: true }); next.sellerCurrencyMoney = buildOrderSellerCurrencyMoney(next);
  next.onlineFeeSnapshot = buildOnlineOrderFee(next);
  const summary = computeNativeSellerAccounting({ sellerId: fixture.sellers[0], orders: [fixture.order.toObject(), next],
    transactions: await Balance.find({}).lean(), withdrawals: [{ status: 'paid', balanceVersion: 2, currency: 'PKR', requestedCurrency: 'PKR',
      payoutCurrency: 'PKR', amount: 908, requestedAmount: 908, payoutAmount: 908 }], reportingCurrency: 'PKR' });
  expect(summary.balanceByCurrency.PKR.deficit).toBe(0);
  expect(summary.balanceByCurrency.PKR.withdrawableBalance).toBe(469);
  expect(summary.balanceByCurrency.PKR.totalWithdrawn).toBe(908);
});

async function cancelledFixture(destination) {
  const base = await makeFixture();
  base.order.sellerFulfillment[0].status = 'cancelled'; base.order.orderStatus = 'cancelled'; base.order.isDelivered = false;
  await base.order.save();
  const cancellationId = new mongoose.Types.ObjectId(), creditId = new mongoose.Types.ObjectId();
  const originalCard = destination === 'original_card', refund = originalCard ? 90800 : 100000;
  const row = await Cancellation.create({ _id: cancellationId, order: base.order._id, buyer: actor._id, seller: base.sellers[0],
    paymentMethod: 'safepay', paymentRail: 'card', payment: base.payment._id, environment: 'sandbox', currency: 'PKR',
    amountMinor: 100000, refundAmountMinor: refund, deductionMinor: 100000 - refund, policyVersion: 1,
    sellerCurrency: 'PKR', sellerAmountMinor: 100000, refundStatus: 'refunded', refundDestination: destination,
    requestedAt: new Date('2026-01-02'), refundedAt: new Date('2026-01-02'), ...(!originalCard ? { walletTransaction: creditId } : {}) });
  if (originalCard) {
    await Payment.updateOne({ _id: base.payment._id }, { $set: { refundedMinor: refund } });
    tracker.charge.balance.amount = 100000 - refund;
    tracker.charge.cybersource_refunds = [{ token: 'refund_completed-cancellation', tracker: base.payment.tracker,
      totals: { currency: 'PKR', amount: refund }, created_at: { seconds: 1767398400 } }];
    await resolver.refreshReview(String(base.review._id));
  } else {
    await Payment.updateOne({ _id: base.payment._id }, { $set: { walletRefundMinor: refund } });
    const wallet = await Wallet.create({ user: actor._id, balances: { PKR: 1000 }, status: 'locked', lockSource: 'system',
      lockedReason: 'A card-funded Wallet refund needs reconciliation. Please contact support.' });
    await WalletTransaction.create({ _id: creditId, user: actor._id, wallet: wallet._id, type: 'return_refund', direction: 'credit',
      status: 'completed', amount: 1000, currency: 'PKR', referenceType: 'order_cancellation', referenceId: String(cancellationId),
      idempotencyKey: `order-cancellation:${cancellationId}:wallet`, safepayPaymentId: base.payment._id,
      safepayTrackerId: base.payment.tracker, safepayEnvironment: 'sandbox', completedAt: new Date('2026-01-02'),
      metadata: { cardRefundFunding: true, sourceOrderId: String(base.order._id), availableCreditedMinor: 100000,
        fundingRemainingMinor: 100000, fundingOriginalAvailableMinor: 100000 } });
  }
  return { ...base, payment: await Payment.findById(base.payment._id), review: await Review.findById(base.review._id), cancellation: row };
}

test('an actual cancelled Wallet-refunded portion never creates a second seller deduction', async () => {
  fixture = await cancelledFixture('wallet');
  await resolver.resolveReview(String(fixture.review._id), input(fixture.review), String(admin._id));
  expect(await Balance.countDocuments()).toBe(0); expect((await Wallet.findOne({ user: actor._id })).balances.PKR).toBe(0);
  expect((await Cancellation.findById(fixture.cancellation._id)).refundStatus).toBe('refunded');
});

test('loss of the retained cancellation fee belongs to Rozare, not a seller who never earned the cancelled order', async () => {
  fixture = await cancelledFixture('original_card');
  await resolver.resolveReview(String(fixture.review._id), input(fixture.review, 'lost', { bankReportedPrincipalMinor: 9200 }), String(admin._id));
  const review = await Review.findById(fixture.review._id);
  expect(review.platformPrincipalMinor).toBe(9200); expect(review.sellerAllocations).toHaveLength(0);
  expect(await Balance.countDocuments()).toBe(0); expect(await WalletTransaction.countDocuments({ type: 'reversal' })).toBe(0);
  expect((await Payment.findById(fixture.payment._id)).refundedMinor).toBe(90800);
});
