'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const Request = require('../../models/ReturnRequest');
const Evidence = require('../../models/AfterSalesEvidence');
const User = require('../../models/User');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const Ledger = require('../../models/SellerBalanceTransaction');
const Outbox = require('../../models/NotificationOutbox');
const Payment = require('../../models/SafepayPayment');
const { buildOrderSellerSettlement, buildOrderSellerCurrencyMoney } = require('../../services/orderMoneyService');
const { buildOnlineOrderFee } = require('../../services/onlineOrderFeeService');
const { warrantyDeadline, buildWarrantyEligibility, createWarrantyService } = require('../../services/warrantyService');
const { dispatchReplacement, confirmReplacementReceived } = require('../../services/replacementService');
const { createReturnRequest, updateReturnStatus, approveReplacement, settleFromSellerBalance, createSafepayReturnSettlement } = require('../../services/returnService');
const { buildSellerPaymentSummary } = require('../../controllers/PaymentController');
const payments = require('../../services/safepayPaymentService');
const supertest = require('supertest');
const jwt = require('jsonwebtoken');
const express = require('express');
const app = express(); app.use(express.json());
app.use('/api/returns', require('../../routes/returnRoutes'));
app.use('/api/warranties', require('../../routes/warrantyRoutes'));
const originalJwt = process.env.JWT_SECRET;
const clock = new Date('2026-10-14T12:00:00.000Z');
const rates = { USD: 1, PKR: 300, EUR: 0.9, GBP: 0.8 };
let replica;
beforeAll(async () => {
  process.env.JWT_SECRET = 'isolated-warranty-test-session-only';
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await Promise.all([Order, Product, Request, Evidence, User, Wallet, WalletTransaction, Ledger, Outbox, Payment].map(model => model.init()));
}, 120000);
afterAll(async () => { await mongoose.disconnect(); await replica?.stop(); if (originalJwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalJwt; });
beforeEach(async () => { await Promise.all(Object.values(mongoose.models).map(model => model.deleteMany({}))); });

async function fixture({ method = 'wallet', seller, buyer, delivered = '2026-10-01T12:00:00.000Z', warranty = true, returnsEnabled = true, quantity = 1, total = 1000, resolution = 'full_refund' } = {}) {
  seller ||= await User.create({ username: 'Warranty Seller', email: `seller-${new mongoose.Types.ObjectId()}@example.com`, password: 'not-a-real-password', role: 'seller', currency: 'PKR' });
  buyer ||= await User.create({ username: 'Warranty Buyer', email: `buyer-${new mongoose.Types.ObjectId()}@example.com`, password: 'not-a-real-password', role: 'user', currency: 'PKR' });
  const product = await Product.create({ name: 'Warranty QA product', price: total, currency: 'PKR', seller: seller._id, stock: 10, totalSales: quantity,
    image: 'https://example.com/qa.png', category: new mongoose.Types.ObjectId(), brand: 'QA',
    optionGroups: [{ name: 'Color', values: ['Blue', 'Green'] }] });
  const policy = { returnsEnabled, returnDuration: returnsEnabled ? 7 : 0, refundType: returnsEnabled ? resolution : 'none', warrantyEnabled: warranty, warrantyDuration: warranty ? 1 : 0, warrantyDescription: 'Manufacturing defects' };
  const order = new Order({ user: buyer._id, orderId: `ORD-WARRANTY-${new mongoose.Types.ObjectId()}`, currency: 'PKR',
    orderItems: [{ productId: product._id, seller: seller._id, name: product.name, image: 'https://example.com/qa.png', quantity,
      price: total / quantity, lineSubtotal: total, sourcePrice: Math.round(total / quantity * 100) / 100, sourceLineSubtotal: total, sourceCurrency: 'PKR',
      selectedColor: 'Blue', selectedOptions: { Color: 'Blue' }, returnPolicySnapshotVersion: 1, returnPolicy: policy }],
    orderSummary: { subtotal: total, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: total },
    shippingInfo: { fullName: 'Warranty QA Buyer', email: buyer.email, phone: '+923001234567', address: 'QA Street', city: 'Lahore', state: 'Punjab', postalCode: '54000', country: 'Pakistan' },
    shippingMethod: { name: 'free', price: 0, estimatedDays: 1, seller: seller._id },
    sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'free', price: 0, estimatedDays: 1, sourceCost: 0, sourceCurrency: 'PKR' } }],
    sellerPolicies: [{ seller: seller._id, productCurrency: 'PKR', returnPolicy: policy }],
    sellerFulfillment: [{ seller: seller._id, status: 'delivered', deliveredAt: new Date(delivered) }],
    exchangeRateSnapshot: { base: 'USD', rates, capturedAt: clock, source: 'isolated-qa', fallback: false },
    paymentMethod: method, isPaid: method !== 'cash_on_delivery', orderStatus: 'delivered', isDelivered: true,
    deliveredAt: new Date(delivered), awaitingPayment: false, inventoryCommitted: true });
  order.sellerSettlementVersion = 1; order.sellerSettlement = buildOrderSellerSettlement(order, { requireOrderTotal: true });
  order.sellerCurrencyMoneyVersion = 1; order.sellerCurrencyMoney = buildOrderSellerCurrencyMoney(order);
  if (method !== 'cash_on_delivery') order.onlineFeeSnapshot = buildOnlineOrderFee(order);
  await order.save();
  const photo = await Evidence.create({ user: buyer._id, order: order._id, url: 'https://example.com/owned-qa.png', publicId: `qa/${order._id}`, mime: 'image/png', size: 100 });
  const input = { orderId: String(order._id), sellerId: String(seller._id), buyerId: String(buyer._id),
    items: [{ orderItemId: String(order.orderItems[0]._id), quantity: 1 }], reasonDetails: 'The purchased product has stopped working.', evidenceIds: [String(photo._id)], requestKey: `warranty-test-${order._id}` };
  return { seller, buyer, product, order, photo, input };
}
async function inspect(claim, seller) {
  for (const status of ['picked_up', 'in_transit_to_seller', 'received_by_seller', 'under_review']) {
    claim = await updateReturnStatus({ returnRequestId: claim._id, actor: { id: String(seller._id), role: 'seller' }, nextStatus: status, note: 'QA collection and inspection confirmed.' });
  }
  return claim;
}

test.each([
  ['2028-01-31T08:34:56.000Z', 1, '2028-02-29T08:34:56.000Z'],
  ['2026-01-31T08:34:56.000Z', 1, '2026-02-28T08:34:56.000Z'],
  ['2028-02-29T08:34:56.000Z', 12, '2029-02-28T08:34:56.000Z'],
])('calendar warranty clock clamps month ends: %s', (start, months, end) => expect(warrantyDeadline(start, months).toISOString()).toBe(end));
test.each([0, -1, 1.5, '1', 121, NaN])('rejects invalid months %p', months => expect(warrantyDeadline(clock, months)).toBeNull());

test.each(['cash_on_delivery', 'wallet', 'safepay'])('%s: warranty replacement has no earnings hold, stock decrements once and original warranty survives', async method => {
  const fx = await fixture({ method }), service = createWarrantyService({ now: () => clock });
  const before = await buildSellerPaymentSummary(fx.seller._id, { displayCurrency: 'PKR' });
  let claim = await service.createClaim(fx.input);
  expect(claim.kind).toBe('warranty');
  expect(claim.warrantySnapshot.deadline.toISOString()).toBe('2026-11-01T12:00:00.000Z');
  expect((await buildSellerPaymentSummary(fx.seller._id, { displayCurrency: 'PKR' })).balanceByCurrency.PKR).toEqual(before.balanceByCurrency.PKR);
  expect((await service.createClaim(fx.input))._id).toEqual(claim._id);
  await expect(service.createClaim({ ...fx.input, reasonDetails: 'A different claim with this same key.' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(service.decide({ claimId: String(claim._id), sellerId: fx.input.sellerId, outcome: 'approve', reason: 'This is covered under warranty.' })).rejects.toMatchObject({ code: 'WARRANTY_DECISION_INVALID' });
  claim = await service.decide({ claimId: String(claim._id), sellerId: fx.input.sellerId, outcome: 'approve', resolution: 'replacement', reason: 'We will replace this faulty product.' });
  await inspect(claim, fx.seller);
  claim = await approveReplacement({ returnRequestId: claim._id, sellerId: fx.seller._id });
  const dispatch = { requestId: String(claim._id), sellerId: fx.input.sellerId, shippingMethod: 'courier', carrier: 'QA Courier', trackingNumber: 'QA-0001', operationKey: `dispatch-qa-${claim._id}` };
  await Promise.all([dispatchReplacement(dispatch), dispatchReplacement(dispatch)]);
  expect((await Product.findById(fx.product._id)).stock).toBe(9);
  expect((await Product.findById(fx.product._id)).totalSales).toBe(1);
  await expect(dispatchReplacement({ ...dispatch, trackingNumber: 'DIFFERENT' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(confirmReplacementReceived({ requestId: String(claim._id), buyerId: String(new mongoose.Types.ObjectId()) })).rejects.toMatchObject({ statusCode: 404 });
  await Promise.all([confirmReplacementReceived({ requestId: String(claim._id), buyerId: fx.input.buyerId }), confirmReplacementReceived({ requestId: String(claim._id), buyerId: fx.input.buyerId })]);
  const eligibility = await buildWarrantyEligibility(fx.order, { at: clock });
  expect(eligibility.groups[0].items[0]).toMatchObject({ eligible: true, availableQuantity: 1 });
  expect(eligibility.groups[0].items[0].deadline.toISOString()).toBe('2026-11-01T12:00:00.000Z');
  expect(await WalletTransaction.countDocuments({ type: 'return_refund' })).toBe(0);
  expect(await Ledger.countDocuments({ type: 'return_refund' })).toBe(0);
  expect((await buildSellerPaymentSummary(fx.seller._id, { displayCurrency: 'PKR' })).balanceByCurrency.PKR).toEqual(before.balanceByCurrency.PKR);
});

test('an original on-time rejection can be appealed after expiry, but a new claim cannot; decision and photos stay visible', async () => {
  const fx = await fixture(), service = createWarrantyService({ now: () => clock });
  let claim = await service.createClaim(fx.input);
  claim = await service.decide({ claimId: String(claim._id), sellerId: fx.input.sellerId, outcome: 'reject', reason: 'The supplied photo does not show the reported defect.' });
  const expired = createWarrantyService({ now: () => new Date('2026-12-01') });
  await expect(expired.createClaim({ ...fx.input, requestKey: 'new-claim-after-expiry-0001' })).rejects.toMatchObject({ code: 'WARRANTY_NOT_ELIGIBLE' });
  const appeal = { claimId: String(claim._id), buyerId: fx.input.buyerId, evidenceIds: fx.input.evidenceIds, reasonDetails: 'Please review this original on-time issue again.', requestKey: 'original-warranty-appeal-0001' };
  claim = await expired.appeal(appeal);
  await expired.appeal(appeal);
  expect(claim.appealVersion).toBe(1); expect(claim.requestedAt.toISOString()).toBe(clock.toISOString());
  expect(claim.warrantySnapshot.deadline.toISOString()).toBe('2026-11-01T12:00:00.000Z');
  expect(claim.statusHistory.some(row => row.note.includes('supplied photo'))).toBe(true);
  expect(await Outbox.countDocuments({ eventKey: { $regex: ':appeal:1$' } })).toBe(4);
  expect(JSON.stringify(claim)).not.toMatch(/lastAppealKey|lastAppealFingerprint|requestFingerprint/);
});

test('expired, undelivered, disabled and already consumed products cannot open a claim', async () => {
  const fx = await fixture(), service = createWarrantyService({ now: () => clock });
  await service.createClaim(fx.input);
  await expect(service.createClaim({ ...fx.input, requestKey: 'another-warranty-request-0001' })).rejects.toMatchObject({ code: 'WARRANTY_NOT_ELIGIBLE' });
  const disabled = await fixture({ warranty: false });
  await expect(service.createClaim(disabled.input)).rejects.toMatchObject({ code: 'WARRANTY_NOT_ELIGIBLE' });
  const old = await fixture({ delivered: '2025-10-01' });
  await expect(service.createClaim(old.input)).rejects.toMatchObject({ code: 'WARRANTY_NOT_ELIGIBLE' });
  const undelivered = await fixture();
  await Order.updateOne({ _id: undelivered.order._id }, { $set: { 'sellerFulfillment.0.status': 'shipped' } });
  await expect(service.createClaim(undelivered.input)).rejects.toMatchObject({ code: 'WARRANTY_NOT_ELIGIBLE' });
});

test('evidence ownership, seller ownership and concurrent quantity claims are enforced atomically', async () => {
  const fx = await fixture(), other = await fixture(), service = createWarrantyService({ now: () => clock });
  await expect(service.createClaim({ ...fx.input, evidenceIds: other.input.evidenceIds })).rejects.toMatchObject({ code: 'WARRANTY_EVIDENCE_UNOWNED' });
  await expect(service.createClaim({ ...fx.input, sellerId: other.input.sellerId })).rejects.toMatchObject({ code: 'WARRANTY_SELLER_MISMATCH' });
  const attempts = await Promise.allSettled([service.createClaim(fx.input), service.createClaim({ ...fx.input, requestKey: 'parallel-warranty-attempt-0001' })]);
  expect(attempts.filter(row => row.status === 'fulfilled')).toHaveLength(1);
  expect(await Request.countDocuments({ order: fx.order._id })).toBe(1);
});

test.each(['cash_on_delivery', 'wallet', 'safepay'])('%s: warranty refund requires real seller funds and credits the original price exactly once', async method => {
  const fx = await fixture({ method }), service = createWarrantyService({ now: () => clock });
  await fixture({ seller: fx.seller, warranty: false, total: 10000 });
  const before = await buildSellerPaymentSummary(fx.seller._id, { displayCurrency: 'PKR' });
  let claim = await service.createClaim(fx.input);
  claim = await service.decide({ claimId: String(claim._id), sellerId: fx.input.sellerId, outcome: 'approve', resolution: 'refund', reason: 'We will refund your original purchase price.' });
  await inspect(claim, fx.seller);
  await Promise.all([settleFromSellerBalance({ returnRequestId: claim._id, sellerId: fx.seller._id }), settleFromSellerBalance({ returnRequestId: claim._id, sellerId: fx.seller._id })]);
  expect((await Wallet.findOne({ user: fx.buyer._id })).balances.PKR).toBe(1000);
  expect(await WalletTransaction.countDocuments({ referenceId: String(claim._id) })).toBe(1);
  expect(await Ledger.countDocuments({ referenceId: String(claim._id) })).toBe(1);
  const after = await buildSellerPaymentSummary(fx.seller._id, { displayCurrency: 'PKR' });
  expect(before.balanceByCurrency.PKR.withdrawableBalance - after.balanceByCurrency.PKR.withdrawableBalance).toBe(1000);
  expect((await Request.findById(claim._id)).settlement.fundingSource).toBe('seller_balance');
  expect((await buildWarrantyEligibility(fx.order, { at: clock })).groups[0].items[0].eligible).toBe(false);
});

test('insufficient seller balance cannot refund warranty using an online held-order shortcut', async () => {
  const fx = await fixture(), service = createWarrantyService({ now: () => clock });
  const claim = await service.createClaim(fx.input);
  await service.decide({ claimId: String(claim._id), sellerId: fx.input.sellerId, outcome: 'approve', resolution: 'refund', reason: 'Refund the original paid amount.' });
  await inspect(claim, fx.seller);
  await expect(settleFromSellerBalance({ returnRequestId: claim._id, sellerId: fx.seller._id })).rejects.toMatchObject({ code: 'INSUFFICIENT_SELLER_BALANCE' });
  expect(await WalletTransaction.countDocuments()).toBe(0);
});

test('ordinary replacement return holds funds until receipt, then warranty may cover the replaced item', async () => {
  const fx = await fixture({ delivered: new Date(Date.now() - 86400000).toISOString(), resolution: 'replacement_only' });
  const photo = await Evidence.create({ user: fx.buyer._id, order: fx.order._id, kind: 'return', url: 'https://example.com/return.png', publicId: 'qa/return', mime: 'image/png', size: 100 });
  let returned = await createReturnRequest({ ...fx.input, evidenceIds: [String(photo._id)], reasonCategory: 'defective', requestKey: 'normal-replacement-return-0001' });
  await updateReturnStatus({ returnRequestId: returned._id, actor: { id: fx.input.sellerId, role: 'seller' }, nextStatus: 'approved', note: 'We will replace this defective product after collection.' });
  await inspect(returned, fx.seller);
  await expect(updateReturnStatus({ returnRequestId: returned._id, actor: { id: fx.input.sellerId, role: 'seller' }, nextStatus: 'rejected', note: 'Cannot reject the already approved request.' })).rejects.toMatchObject({ statusCode: 409 });
  expect((await buildSellerPaymentSummary(fx.seller._id, { displayCurrency: 'PKR' })).balanceByCurrency.PKR.returnWindowHeldAmount).toBeGreaterThan(0);
  await dispatchReplacement({ requestId: String(returned._id), sellerId: fx.input.sellerId, shippingMethod: 'hand_delivery', operationKey: 'replacement-hand-delivery-0001' });
  await confirmReplacementReceived({ requestId: String(returned._id), buyerId: fx.input.buyerId });
  expect((await buildWarrantyEligibility(fx.order)).groups[0].items[0].eligible).toBe(true);
  expect((await buildSellerPaymentSummary(fx.seller._id, { displayCurrency: 'PKR' })).balanceByCurrency.PKR.returnWindowHeldAmount).toBe(0);
});

test('ordinary returns require owned, order-scoped return photos and a reasoned decision before collection', async () => {
  const fx = await fixture({ delivered: new Date(Date.now() - 86400000).toISOString() });
  const base = { ...fx.input, reasonCategory: 'defective', requestKey: 'return-evidence-boundary-0001' };
  await expect(createReturnRequest({ ...base, evidenceIds: undefined })).rejects.toMatchObject({ code: 'RETURN_EVIDENCE_REQUIRED' });
  await expect(createReturnRequest(base)).rejects.toMatchObject({ code: 'RETURN_EVIDENCE_UNOWNED' });
  const other = await fixture({ delivered: new Date(Date.now() - 86400000).toISOString() });
  const foreign = await Evidence.create({ user: other.buyer._id, order: other.order._id, kind: 'return', url: 'https://example.com/foreign.png', publicId: 'qa/foreign', mime: 'image/png', size: 100 });
  await expect(createReturnRequest({ ...base, evidenceIds: [String(foreign._id)] })).rejects.toMatchObject({ code: 'RETURN_EVIDENCE_UNOWNED' });
  const photo = await Evidence.create({ user: fx.buyer._id, order: fx.order._id, kind: 'return', url: 'https://example.com/return.png', publicId: 'qa/return', mime: 'image/png', size: 100 });
  const request = await createReturnRequest({ ...base, evidenceIds: [String(photo._id)] });
  expect(request.returnReviewVersion).toBe(1);
  expect(request.evidenceUrls).toEqual([photo.url]);
  expect((await Evidence.findById(photo._id)).claim).toEqual(request._id);
  const transition = { returnRequestId: request._id, actor: { id: fx.input.sellerId, role: 'seller' } };
  await expect(updateReturnStatus({ ...transition, nextStatus: 'picked_up' })).rejects.toMatchObject({ statusCode: 409 });
  await expect(updateReturnStatus({ ...transition, nextStatus: 'approved', note: 'yes' })).rejects.toMatchObject({ code: 'RETURN_DECISION_REASON_REQUIRED' });
  const decision = await updateReturnStatus({ ...transition, nextStatus: 'rejected', note: 'The supplied photos do not match the reported defect.' });
  expect(decision.decisionReason).toContain('supplied photos');
  expect(decision.status).toBe('rejected');
  expect(await WalletTransaction.countDocuments()).toBe(0);
});

test('replacement validates legacy Color together with modern Size before touching stock', async () => {
  const fx = await fixture(), service = createWarrantyService({ now: () => clock });
  await Product.updateOne({ _id: fx.product._id }, { $set: { optionGroups: [{ name: 'Size', values: ['Small'] }], colors: ['Blue','Green'] } });
  fx.order.orderItems[0].selectedOptions = { Size: 'Small' }; await fx.order.save();
  const claim = await service.createClaim(fx.input);
  await service.decide({ claimId: String(claim._id), sellerId: fx.input.sellerId, outcome: 'approve', resolution: 'replacement', reason: 'We will replace the original purchased variant.' });
  await inspect(claim, fx.seller); await approveReplacement({ returnRequestId: claim._id, sellerId: fx.seller._id });
  await Product.updateOne({ _id: fx.product._id }, { $set: { colors: ['Green'] } });
  await expect(dispatchReplacement({ requestId: String(claim._id), sellerId: fx.input.sellerId, shippingMethod: 'hand_delivery', operationKey: 'mixed-legacy-variant-guard-0001' })).rejects.toMatchObject({ code: 'REPLACEMENT_VARIANT_UNAVAILABLE' });
  expect((await Product.findById(fx.product._id)).stock).toBe(10);
});

test('card-funded warranty refunds credit only after verified Sandbox capture (provider response simulated in this test)', async () => {
  const fx = await fixture({ method: 'cash_on_delivery' }), service = createWarrantyService({ now: () => clock });
  const claim = await service.createClaim(fx.input);
  await service.decide({ claimId: String(claim._id), sellerId: fx.input.sellerId, outcome: 'approve', resolution: 'refund', reason: 'We will fund your Wallet refund by card.' });
  await inspect(claim, fx.seller);
  const previous = { ...process.env };
  Object.assign(process.env, { SAFEPAY_ENV: 'sandbox', SAFEPAY_SANDBOX_PUBLIC_KEY: 'sec_test-warranty', SAFEPAY_SANDBOX_SECRET_KEY: 'isolated-warranty-test', SAFEPAY_SANDBOX_WEBHOOK_SECRET: 'isolated-warranty-test', SAFEPAY_SANDBOX_WEBHOOK_SCHEME: 'sha512-raw' });
  const prepare = jest.spyOn(payments, 'prepareCheckout').mockImplementation(async paymentId => ({ paymentId: String(paymentId) }));
  try {
    const setup = await createSafepayReturnSettlement({ returnRequestId: claim._id, sellerId: fx.seller._id, requestKey: 'warranty-card-funding-0001' });
    const payment = await Payment.findById(setup.paymentId);
    expect(payment.amountMinor).toBe(100000);
    expect(await WalletTransaction.countDocuments()).toBe(0);
    payment.status = 'ready'; payment.tracker = `track_qa-${payment._id}`; await payment.save();
    const provider = payments.createSafepayPaymentService({ configFor: () => ({ environment: 'sandbox' }), clientFor: () => ({ getTracker: async () => ({ state: 'TRACKER_ENDED' }) }) });
    await provider.reconcilePayment(payment._id); await provider.reconcilePayment(payment._id);
    expect((await Wallet.findOne({ user: fx.buyer._id })).balances.PKR).toBe(1000);
    expect(await WalletTransaction.countDocuments()).toBe(1); expect(await Ledger.countDocuments()).toBe(0);
  } finally { prepare.mockRestore(); for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); }
});

const call = (method, url, user) => supertest(app)[method](url).set('Authorization', `Bearer ${jwt.sign({ id: String(user._id), role: 'admin' }, process.env.JWT_SECRET)}`);
test('real protected routes isolate warranty and returns, reject forged roles, and require a declared seller decision', async () => {
  const fx = await fixture(), other = await fixture();
  const created = await call('post', '/api/warranties', fx.buyer).send(fx.input).expect(201);
  const claimId = created.body.returnRequest._id;
  expect(created.body.returnRequest.kind).toBe('warranty');
  expect((await call('get', '/api/returns/mine', fx.buyer).expect(200)).body.returns).toHaveLength(0);
  expect((await call('get', '/api/warranties/mine', fx.buyer).expect(200)).body.returns).toHaveLength(1);
  await call('get', `/api/warranties/${claimId}`, other.buyer).expect(404);
  await call('post', `/api/warranties/${claimId}/decision`, fx.buyer).send({ outcome: 'approve', resolution: 'refund', reason: 'Forge the seller decision please.' }).expect(403);
  await call('patch', `/api/returns/${claimId}/status`, fx.seller).send({ status: 'approved' }).expect(404);
  await call('patch', `/api/warranties/${claimId}/status`, fx.seller).send({ status: 'approved' }).expect(400);
  await call('post', `/api/warranties/${claimId}/decision`, fx.seller).send({ outcome: 'approve', resolution: 'replacement', reason: 'We will replace the faulty product.' }).expect(200);
  expect((await Request.findById(claimId)).resolution).toBe('replacement');
  expect((await call('get', '/api/returns/seller', fx.seller).expect(200)).body.returns).toHaveLength(0);
  expect((await call('get', '/api/warranties/seller', fx.seller).expect(200)).body.returns).toHaveLength(1);
});

test('stock and variant failures roll back a replacement without inventory or money changes', async () => {
  const fx = await fixture(), service = createWarrantyService({ now: () => clock });
  let claim = await service.createClaim(fx.input);
  await service.decide({ claimId: String(claim._id), sellerId: fx.input.sellerId, outcome: 'approve', resolution: 'replacement', reason: 'We will replace the purchased product.' });
  await inspect(claim, fx.seller); claim = await approveReplacement({ returnRequestId: claim._id, sellerId: fx.seller._id });
  const input = { requestId: String(claim._id), sellerId: fx.input.sellerId, shippingMethod: 'hand_delivery', operationKey: 'no-stock-replacement-0001' };
  await Product.updateOne({ _id: fx.product._id }, { $set: { stock: 0 } });
  await expect(dispatchReplacement(input)).rejects.toMatchObject({ code: 'REPLACEMENT_STOCK_UNAVAILABLE' });
  expect((await Request.findById(claim._id)).status).toBe('replacement_approved');
  await Product.updateOne({ _id: fx.product._id }, { $set: { stock: 5, 'optionGroups.0.values': ['Green'] } });
  await expect(dispatchReplacement(input)).rejects.toMatchObject({ code: 'REPLACEMENT_VARIANT_UNAVAILABLE' });
  expect((await Product.findById(fx.product._id)).stock).toBe(5);
  expect(await WalletTransaction.countDocuments()).toBe(0);
});

test('policy and price edits never alter saved coverage or an exact partial refund; appeal reuses original units after other quantities settle', async () => {
  const fx = await fixture({ quantity: 3, total: 100.01 }), service = createWarrantyService({ now: () => clock });
  await fixture({ seller: fx.seller, total: 10000, warranty: false });
  await Product.updateOne({ _id: fx.product._id }, { $set: { price: 9999, 'returnPolicy.warrantyEnabled': false } });
  let rejected = await service.createClaim(fx.input);
  await service.decide({ claimId: String(rejected._id), sellerId: fx.input.sellerId, outcome: 'reject', reason: 'Please provide more detail about the fault.' });
  const secondPhoto = await Evidence.create({ user: fx.buyer._id, order: fx.order._id, url: 'https://example.com/second-owned.png', publicId: 'qa/second-photo', mime: 'image/png', size: 100 });
  let other = await service.createClaim({ ...fx.input, evidenceIds: [String(secondPhoto._id)], items: [{ ...fx.input.items[0], quantity: 2 }], requestKey: 'other-two-original-units-0001' });
  await service.decide({ claimId: String(other._id), sellerId: fx.input.sellerId, outcome: 'approve', resolution: 'refund', reason: 'Refund these two faulty purchased units.' });
  await inspect(other, fx.seller); other = await settleFromSellerBalance({ returnRequestId: other._id, sellerId: fx.seller._id });
  rejected = await service.appeal({ claimId: String(rejected._id), buyerId: fx.input.buyerId, reasonDetails: 'Please reconsider this original faulty unit.', evidenceIds: fx.input.evidenceIds, requestKey: 'appeal-reallocated-cents-0001' });
  expect(Math.round((rejected.refund.totalAmount + other.refund.totalAmount) * 100)).toBe(10001);
  expect(rejected.warrantySnapshot.deadline.toISOString()).toBe('2026-11-01T12:00:00.000Z');
  await service.decide({ claimId: String(rejected._id), sellerId: fx.input.sellerId, outcome: 'approve', resolution: 'refund', reason: 'Refund the remaining original faulty unit.' });
  await inspect(rejected, fx.seller); await settleFromSellerBalance({ returnRequestId: rejected._id, sellerId: fx.seller._id });
  expect((await Wallet.findOne({ user: fx.buyer._id })).balances.PKR).toBe(100.01);
});

test('inspection rejection can be appealed without asking the buyer to send the same received product twice', async () => {
  const fx = await fixture(), service = createWarrantyService({ now: () => clock });
  const claim = await service.createClaim(fx.input);
  await service.decide({ claimId: String(claim._id), sellerId: fx.input.sellerId, outcome: 'approve', resolution: 'replacement', reason: 'We plan to replace this product.' });
  await inspect(claim, fx.seller);
  await updateReturnStatus({ returnRequestId: claim._id, actor: { id: fx.input.sellerId, role: 'seller' }, nextStatus: 'rejected', note: 'Inspection initially did not reproduce the issue.' });
  await service.appeal({ claimId: String(claim._id), buyerId: fx.input.buyerId, reasonDetails: 'Please retry under the original conditions.', evidenceIds: fx.input.evidenceIds, requestKey: 'appeal-after-received-0001' });
  const approved = await service.decide({ claimId: String(claim._id), sellerId: fx.input.sellerId, outcome: 'approve', resolution: 'refund', reason: 'The item is already here; we will refund it.' });
  expect(approved.status).toBe('under_review');
});

test('warranty operates independently when ordinary returns are disabled and adds no earnings hold', async () => {
  const fx = await fixture({ returnsEnabled: false }), service = createWarrantyService({ now: () => clock });
  const before = await buildSellerPaymentSummary(fx.seller._id, { displayCurrency: 'PKR' });
  expect((await buildWarrantyEligibility(fx.order, { at: clock })).groups[0].items[0].eligible).toBe(true);
  await service.createClaim(fx.input);
  const after = await buildSellerPaymentSummary(fx.seller._id, { displayCurrency: 'PKR' });
  expect(after.balanceByCurrency.PKR).toEqual(before.balanceByCurrency.PKR);
  expect(after.balanceByCurrency.PKR.returnWindowHeldAmount).toBe(0);
});

test('the saved warranty deadline is inclusive, but one millisecond later a new claim is refused', async () => {
  const fx = await fixture();
  const deadline = warrantyDeadline(fx.order.deliveredAt, 1);
  expect((await buildWarrantyEligibility(fx.order, { at: deadline })).groups[0].items[0].eligible).toBe(true);
  await expect(createWarrantyService({ now: () => new Date(deadline.getTime() + 1) }).createClaim(fx.input))
    .rejects.toMatchObject({ code: 'WARRANTY_NOT_ELIGIBLE' });
});

test('a zero-priced warranty can provide a replacement but cannot declare a money refund', async () => {
  const fx = await fixture({ total: 0 }), service = createWarrantyService({ now: () => clock });
  const claim = await service.createClaim(fx.input);
  await expect(service.decide({ claimId: String(claim._id), sellerId: fx.input.sellerId, outcome: 'approve', resolution: 'refund', reason: 'Attempt to refund a free purchase.' }))
    .rejects.toMatchObject({ code: 'WARRANTY_NO_REFUND_AMOUNT' });
  expect((await service.decide({ claimId: String(claim._id), sellerId: fx.input.sellerId, outcome: 'approve', resolution: 'replacement', reason: 'We will replace this covered free product.' })).resolution).toBe('replacement');
});

test('online orders without confirmed payment cannot open warranty claims', async () => {
  const fx = await fixture();
  await Order.updateOne({ _id: fx.order._id }, { $set: { isPaid: false } });
  await expect(createWarrantyService({ now: () => clock }).createClaim(fx.input)).rejects.toMatchObject({ code: 'WARRANTY_NOT_ELIGIBLE' });
});
