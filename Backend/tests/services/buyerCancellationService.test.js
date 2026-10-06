'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
jest.mock('../../services/notificationOutboxService', () => ({ enqueueNotificationEvent: jest.fn(async () => {}) }));
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const Cancellation = require('../../models/OrderCancellation');
const Payment = require('../../models/SafepayPayment');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const ReturnRequest = require('../../models/ReturnRequest');
const { buildOrderSellerSettlement, buildOrderSellerCurrencyMoney } = require('../../services/orderMoneyService');
const { cancelBuyerOrder, chooseCancellationSellers } = require('../../services/buyerCancellationService');
const { enqueueNotificationEvent } = require('../../services/notificationOutboxService');
let replica;
beforeAll(async () => { replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(replica.getUri());
  await Promise.all([Order, Product, Cancellation, Payment, Wallet, WalletTransaction, require('../../models/SellerSettlementLock')].map(model => model.init())); }, 60000);
afterAll(async () => { await mongoose.disconnect(); if (replica) await replica.stop(); }, 60000);
afterEach(async () => { await Promise.all(Object.values(mongoose.models).map(model => model.deleteMany({}))); jest.clearAllMocks(); });
async function fixture(method = 'wallet', statusB = 'confirmed', fees = false, { currency = 'USD', prices = [10, 20], shipping = 2 } = {}) {
  const buyer = new mongoose.Types.ObjectId(), sellers = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  const products = await Product.create(sellers.map((seller, index) => ({ seller, name: `Cup ${index}`, description: 'Reusable cup',
    price: prices[index], currency, priceCurrency: currency, stock: 4, totalSales: 1,
    category: 'Home', brand: 'Test', image: 'https://example.com/cup.png' })));
  const subtotal = prices.reduce((sum, value) => sum + value, 0);
  const raw = { user: buyer, currency, orderId: `ORD-QA-${new mongoose.Types.ObjectId()}`,
    orderItems: products.map((product, index) => ({ productId: product._id, seller: product.seller, name: product.name,
      price: prices[index], lineSubtotal: prices[index], sourcePrice: prices[index],
      sourceLineSubtotal: prices[index], sourceCurrency: currency, quantity: 1, returnPolicySnapshotVersion: 1,
      returnPolicy: { returnsEnabled: false, returnDuration: 0, refundType: 'none' } })),
    sellerPolicies: sellers.map((seller, index) => ({ seller, productCurrency: currency, storeName: `Store ${index}` })),
    sellerShipping: sellers.map(seller => ({ seller, shippingMethod: { name: 'standard', price: shipping, sourceCost: shipping, sourceCurrency: currency, estimatedDays: 3 } })),
    shippingMethod: { name: 'standard', price: shipping * sellers.length, estimatedDays: 3 },
    sellerFulfillment: sellers.map((seller, index) => ({ seller, status: index ? statusB : 'confirmed' })),
    orderSummary: { subtotal, shippingCost: shipping * sellers.length, tax: 0, couponDiscount: 0, totalAmount: subtotal + shipping * sellers.length },
    shippingInfo: { fullName: 'QA Buyer', email: 'qa@example.com', phone: '+923001234567', address: 'QA Street', city: 'Lahore', state: 'Punjab', postalCode: '54000', country: 'Pakistan' },
    paymentMethod: method, isPaid: method !== 'cash_on_delivery', inventoryCommitted: true, awaitingPayment: false, orderStatus: 'confirmed',
    exchangeRateSnapshot: { base: 'USD', rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 }, capturedAt: new Date(), source: 'test', fallback: false },
  };
  raw.sellerSettlementVersion = 1; raw.sellerSettlement = buildOrderSellerSettlement(raw, { requireOrderTotal: true });
  raw.sellerCurrencyMoneyVersion = 1; raw.sellerCurrencyMoney = buildOrderSellerCurrencyMoney(raw);
  if (fees) raw.onlineFeeSnapshot = require('../../services/onlineOrderFeeService').buildOnlineOrderFee(raw);
  if (method === 'safepay') { raw.safepayPaymentId = new mongoose.Types.ObjectId(); raw.safepayEnvironment = 'sandbox'; }
  const order = await Order.create(raw);
  const result = { buyer, sellers, products, order };
  if (method === 'safepay') await cardPayment(result);
  return result;
}
test('Wallet cancellation refunds only the selected unshipped seller, including its shipping', async () => {
  const f = await fixture('wallet', 'shipped');
  const cancelled = await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer, sellerIds: [String(f.sellers[0])] });
  expect(cancelled.sellerFulfillment.map(row => row.status)).toEqual(['cancelled', 'shipped']);
  expect(cancelled.orderSummary.totalAmount).toBe(34);
  expect((await Wallet.findOne({ user: f.buyer })).balances.USD).toBe(12);
  expect((await Product.findById(f.products[0]._id)).stock).toBe(5);
  expect((await Product.findById(f.products[1]._id)).stock).toBe(4);
  expect(await Cancellation.countDocuments()).toBe(1);
  expect(enqueueNotificationEvent).toHaveBeenCalledTimes(2);
});
test('parallel repeated cancellations refund and restore stock exactly once', async () => {
  const f = await fixture();
  await require('../../models/SellerSettlementLock').create({ seller: f.sellers[0], version: 0 });
  await Promise.all([1, 2].map(() => cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer, sellerIds: [String(f.sellers[0])] })));
  expect(await Cancellation.countDocuments()).toBe(1);
  expect(await WalletTransaction.countDocuments()).toBe(1);
  expect((await Wallet.findOne({ user: f.buyer })).balances.USD).toBe(12);
  expect((await Product.findById(f.products[0]._id)).stock).toBe(5);
});
test('whole-order cancellation is refused when any seller has shipped', async () => {
  const f = await fixture('wallet', 'shipped');
  await expect(cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer })).rejects.toMatchObject({ code: 'ORDER_FULFILLMENT_STARTED' });
  expect(await Cancellation.countDocuments()).toBe(0);
  expect(await Wallet.countDocuments()).toBe(0);
});
test('all unshipped Wallet portions cancel and refund exactly the frozen checkout total', async () => {
  const f = await fixture();
  const order = await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer });
  expect(order.orderStatus).toBe('cancelled'); expect(order.inventoryCommitted).toBe(false);
  expect((await Wallet.findOne({ user: f.buyer })).balances.USD).toBe(34);
  expect(await WalletTransaction.countDocuments()).toBe(2);
});
test('COD cancellation makes no Wallet credit or provider payment', async () => {
  const f = await fixture('cash_on_delivery');
  await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer });
  expect(await WalletTransaction.countDocuments()).toBe(0);
  expect((await Cancellation.find({})).every(row => row.refundStatus === 'not_required')).toBe(true);
});
test('Safepay cancellation records a durable original-card refund, not a Wallet credit', async () => {
  const f = await fixture('safepay', 'shipped');
  await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer, sellerIds: [String(f.sellers[0])] });
  const row = await Cancellation.findOne({});
  expect(row).toMatchObject({ amountMinor: 1200, refundStatus: 'pending', refundDestination: 'original_card' });
  expect(await WalletTransaction.countDocuments()).toBe(0);
});
test('a different buyer cannot cancel the order', async () => {
  const f = await fixture();
  await expect(cancelBuyerOrder({ orderId: f.order._id, buyerId: new mongoose.Types.ObjectId() })).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
  expect(await Cancellation.countDocuments()).toBe(0);
});
test('later whole-order cleanup does not restore a previously cancelled portion twice', async () => {
  const f = await fixture('cash_on_delivery');
  await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer, sellerIds: [String(f.sellers[0])] });
  await require('../../services/orderInventoryService').restoreOrderInventory(f.order._id);
  expect((await Product.findById(f.products[0]._id)).stock).toBe(5);
  expect((await Product.findById(f.products[1]._id)).stock).toBe(5);
});
test('a later COD confirmation cannot resurrect a cancelled seller portion', async () => {
  const f = await fixture('cash_on_delivery');
  const order = await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer, sellerIds: [String(f.sellers[0])] });
  require('../../services/orderFulfillmentService').setAllSellerFulfillmentStatus(order, 'confirmed');
  expect(order.sellerFulfillment.map(row => row.status)).toEqual(['cancelled', 'confirmed']);
});
test('invalid/duplicate seller scope and shipped scope fail closed', () => {
  const order = { sellerFulfillment: [{ seller: 'A', status: 'processing' }, { seller: 'B', status: 'delivered' }] };
  expect(chooseCancellationSellers(order, ['A'])).toEqual(['A']);
  expect(() => chooseCancellationSellers(order, ['B'])).toThrow();
  expect(() => chooseCancellationSellers(order, ['A', 'A'])).toThrow();
  expect(() => chooseCancellationSellers(order, ['C'])).toThrow();
});

async function cardPayment(f) {
  const existing = await Payment.findById(f.order.safepayPaymentId);
  if (existing) return existing;
  return Payment.create({ _id: f.order.safepayPaymentId, user: f.buyer, order: f.order._id, environment: 'sandbox', purpose: 'order',
    reference: `order:${f.order._id}`, requestKey: 'qa-cancellation-key', fingerprint: 'a'.repeat(64),
    amountMinor: Math.round(f.order.orderSummary.totalAmount * 100), currency: f.order.currency, tracker: `track_${new mongoose.Types.ObjectId()}`, status: 'paid',
    capturedMinor: Math.round(f.order.orderSummary.totalAmount * 100), appliedAt: new Date(), paidAt: new Date() });
}
function trackerRefund(payment, amount = 1200) {
  return { token: payment.tracker, state: amount === payment.amountMinor ? 'TRACKER_REFUNDED' : 'TRACKER_PARTIAL_REFUND',
    charge: { token: 'charge_qa', tracker: payment.tracker, amount: { currency: payment.currency, amount: payment.amountMinor },
      capture: { totals: { currency: payment.currency, amount: payment.amountMinor } }, balance: { currency: payment.currency, amount: payment.amountMinor - amount },
      cybersource_refunds: [{ token: 'refund_qa-cancellation', tracker: payment.tracker, totals: { currency: payment.currency, amount }, created_at: { seconds: Math.floor(Date.now() / 1000) } }] } };
}
async function reconcileProviderRefund(payment, amount) {
  await mongoose.connection.transaction(async session => {
    const current = await Payment.findById(payment._id).session(session);
    const result = await require('../../services/safepayRefundService').reconcileOrderRefund(current, trackerRefund(current, amount), session);
    current.refundedMinor = result.refundedMinor; current.status = result.status; current.riskPending = !result.resolved;
    await current.save({ session });
  });
}
test('a scoped Safepay refund cannot debit the shipped seller', async () => {
  const f = await fixture('safepay', 'shipped'), payment = await cardPayment(f);
  await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer, sellerIds: [String(f.sellers[0])] });
  await Cancellation.updateOne({ order: f.order._id }, { $set: { refundStatus: 'processing', submitStartedAt: new Date(), refundBaselineMinor: 0, refundTargetMinor: 1200 } });
  const tracker = trackerRefund(payment);
  const evidence = require('../../services/safepayRefundService').refundEvidence(tracker, payment);
  await mongoose.connection.transaction(session => require('../../services/cancellationRefundService').reconcileCancellationRefund(payment, tracker, session, evidence));
  expect((await Cancellation.findOne({})).refundStatus).toBe('refunded');
  const event = await require('../../models/SafepayRefundEvent').findOne({});
  expect(event.sellerAllocations).toHaveLength(1); expect(String(event.sellerAllocations[0].seller)).toBe(String(f.sellers[0]));
  expect((await Order.findById(f.order._id)).sellerFulfillment[1].status).toBe('shipped');
  expect(await require('../../models/SellerBalanceTransaction').countDocuments()).toBe(0);
});
test('provider refunds with the wrong amount cannot be attributed or marked completed', async () => {
  const f = await fixture('safepay'), payment = await cardPayment(f);
  await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer, sellerIds: [String(f.sellers[0])] });
  await Cancellation.updateOne({ order: f.order._id }, { $set: { refundStatus: 'processing', submitStartedAt: new Date(), refundBaselineMinor: 0, refundTargetMinor: 1200 } });
  const tracker = trackerRefund(payment, 1199), evidence = require('../../services/safepayRefundService').refundEvidence(tracker, payment);
  await expect(mongoose.connection.transaction(session => require('../../services/cancellationRefundService').reconcileCancellationRefund(payment, tracker, session, evidence)))
    .resolves.toMatchObject({ resolved: false, status: 'manual_review' });
  expect((await Cancellation.findOne({})).refundStatus).toBe('manual_review');
  expect(await require('../../models/SellerPaymentRiskHold').countDocuments({ status: 'pending' })).toBe(2);
  expect(await require('../../models/SafepayRefundEvent').countDocuments()).toBe(0);
});
test('an ambiguous refund response is recovered read-only and never POSTed twice', async () => {
  const f = await fixture('safepay'), payment = await cardPayment(f);
  await cancelBuyerOrder({ orderId: f.order._id, buyerId: f.buyer, sellerIds: [String(f.sellers[0])] });
  const config = jest.spyOn(require('../../config/safepay'), 'readSafepayConfig').mockReturnValue({ environment: 'sandbox' });
  const refund = jest.fn(async () => { throw Object.assign(new Error('Response lost'), { outcomeUnknown: true }); });
  const tracker = { token: payment.tracker, state: 'TRACKER_ENDED', charge: { cybersource_refunds: [] } };
  const client = { getTracker: jest.fn().mockResolvedValueOnce(tracker).mockResolvedValue(trackerRefund(payment)), refundPaymentAmount: refund };
  const factory = jest.spyOn(require('../../services/safepayClient'), 'createSafepayClient').mockReturnValue(client);
  try {
    const { processCancellationRefund } = require('../../services/cancellationRefundService');
    await processCancellationRefund(payment._id); await processCancellationRefund(payment._id); await processCancellationRefund(payment._id);
    expect(refund).toHaveBeenCalledTimes(1);
    expect((await Cancellation.findOne({})).refundStatus).toBe('refunded');
    expect((await Payment.findById(payment._id)).refundedMinor).toBe(1200);
  } finally { config.mockRestore(); factory.mockRestore(); }
});

test('new card cancellation requires a destination, fresh quote and explicit fee consent', async () => {
  const f = await fixture('safepay', 'shipped', true);
  const args = { orderId:f.order._id, buyerId:f.buyer, sellerIds:[String(f.sellers[0])] };
  const { previewBuyerCancellation } = require('../../services/buyerCancellationService');
  const quote = await previewBuyerCancellation(args);
  expect(quote.options).toMatchObject([{ destination:'wallet', amountMinor:1200, deductionMinor:0 },
    { destination:'original_card', amountMinor:1122, deductionMinor:78 }]);
  await expect(cancelBuyerOrder(args)).rejects.toMatchObject({ code:'REFUND_CHOICE_REQUIRED' });
  await expect(cancelBuyerOrder({ ...args, refundDestination:'original_card', quoteId:'bad', acceptDeduction:true })).rejects.toMatchObject({ code:'CANCELLATION_QUOTE_CHANGED' });
  await expect(cancelBuyerOrder({ ...args, refundDestination:'original_card', quoteId:quote.quoteId })).rejects.toMatchObject({ code:'REFUND_DEDUCTION_CONSENT_REQUIRED' });
  expect(await Cancellation.countDocuments()).toBe(0);
  await cancelBuyerOrder({ ...args, refundDestination:'original_card', quoteId:quote.quoteId, acceptDeduction:true });
  const row = await Cancellation.findOne({});
  expect(row).toMatchObject({ amountMinor:1200, refundAmountMinor:1122, deductionMinor:78, refundDestination:'original_card', policyVersion:1 });
  expect(await WalletTransaction.countDocuments()).toBe(0);
  const card = await Payment.findById(f.order.safepayPaymentId);
  await Cancellation.updateOne({ _id:row._id }, { $set:{refundStatus:'processing',submitStartedAt:new Date(),refundBaselineMinor:0,refundTargetMinor:1122} });
  const tracker = trackerRefund(card,1122), evidence = require('../../services/safepayRefundService').refundEvidence(tracker,card);
  await mongoose.connection.transaction(session => require('../../services/cancellationRefundService').reconcileCancellationRefund(card,tracker,session,evidence));
  const view = (await Order.findById(f.order._id)).sellerFulfillment[0].cancellation;
  expect(view).toMatchObject({ amountMinor:1122,grossAmountMinor:1200,deductionMinor:78,refundStatus:'refunded' });
  expect(enqueueNotificationEvent.mock.calls.some(([event]) => event.money.some(m => m.sourcePath === 'refundAmountMinor'))).toBe(true);
});
test('new card-to-Wallet cancellation credits FULL principal exactly once and cannot switch destination', async () => {
  const f=await fixture('safepay','confirmed',true);
  const args={orderId:f.order._id,buyerId:f.buyer,sellerIds:[String(f.sellers[0])]};
  const quote=await require('../../services/buyerCancellationService').previewBuyerCancellation(args);
  await cancelBuyerOrder({...args,refundDestination:'wallet',quoteId:quote.quoteId});
  await cancelBuyerOrder({...args,refundDestination:'wallet',quoteId:quote.quoteId});
  await expect(cancelBuyerOrder({...args,refundDestination:'original_card',quoteId:quote.quoteId,acceptDeduction:true})).rejects.toMatchObject({code:'REFUND_DESTINATION_ALREADY_CHOSEN'});
  expect((await Wallet.findOne({user:f.buyer})).balances.USD).toBe(12);
  const tx=await WalletTransaction.findOne({});
  expect(tx.metadata).toMatchObject({cardRefundFunding:true,fundingRemainingMinor:1200,fundingOriginalAvailableMinor:1200});
  expect(String(tx.safepayPaymentId)).toBe(String(f.order.safepayPaymentId));
  expect((await Payment.findById(f.order.safepayPaymentId)).walletRefundMinor).toBe(1200);
  expect(await Cancellation.countDocuments()).toBe(1);
  expect(await WalletTransaction.countDocuments()).toBe(1);
});

test.each([false, true])('an unowned partial card refund blocks preview, stale cancellation and held returns without repricing (fees=%s)', async fees => {
  const f = await fixture('safepay', 'confirmed', fees);
  const args = { orderId: f.order._id, buyerId: f.buyer, sellerIds: [String(f.sellers[0])] };
  const { previewBuyerCancellation } = require('../../services/buyerCancellationService');
  const quote = await previewBuyerCancellation(args);
  await reconcileProviderRefund(await cardPayment(f), 680);
  expect(await require('../../models/SellerBalanceTransaction').countDocuments({ type: 'reversal' })).toBe(2);
  expect((await Payment.findById(f.order.safepayPaymentId))).toMatchObject({ refundedMinor: 680, status: 'paid', riskPending: false });
  const review = { code: 'RETURN_EXTERNAL_FUNDING_REFUND_REVIEW', statusCode: 409, message: expect.stringContaining('contact support') };
  await expect(previewBuyerCancellation(args)).rejects.toMatchObject(review);
  await expect(cancelBuyerOrder({ ...args, refundDestination: 'wallet', quoteId: quote.quoteId })).rejects.toMatchObject(review);
  await expect(cancelBuyerOrder({ ...args, refundDestination: 'original_card', quoteId: quote.quoteId, acceptDeduction: true })).rejects.toMatchObject(review);
  expect(await Cancellation.countDocuments()).toBe(0);
  expect((await Order.findById(f.order._id)).sellerFulfillment.every(row => row.status === 'confirmed')).toBe(true);
  expect((await Product.findById(f.products[0]._id)).stock).toBe(4);
  await Order.updateOne({ _id: f.order._id }, { $set: { orderStatus: 'delivered', isDelivered: true, deliveredAt: new Date(),
    'sellerFulfillment.0.status': 'delivered', 'sellerFulfillment.0.deliveredAt': new Date() } });
  const request = await ReturnRequest.create({ returnNumber: `RET-EXTERNAL-${new mongoose.Types.ObjectId()}`,
    order: f.order._id, orderId: f.order.orderId, buyer: f.buyer, seller: f.sellers[0], currency: 'USD',
    items: [{ orderItemId: f.order.orderItems[0]._id, productId: f.products[0]._id, name: 'Cup 0', quantity: 1,
      purchasedQuantity: 1, unitPrice: 10, lineSubtotal: 10 }], reasonCategory: 'defective', reasonDetails: 'Defective cup',
    status: 'under_review', statusHistory: [{ status: 'under_review', actorRole: 'seller' }],
    eligibilityDeadline: new Date(Date.now() + 86400000), policySnapshot: { returnsEnabled: true, returnDuration: 7, refundType: 'full_refund' },
    refund: { itemSubtotal: 10, taxAmount: 0, shippingAmount: 0, discountAmount: 0, totalAmount: 10 } });
  await expect(require('../../services/returnService').settleFromSellerBalance({ returnRequestId: request._id, sellerId: f.sellers[0] }))
    .rejects.toMatchObject(review);
  expect((await ReturnRequest.findById(request._id)).status).toBe('under_review');
  expect(await require('../../models/SellerBalanceTransaction').countDocuments({ type: 'return_refund' })).toBe(0);
  expect(await WalletTransaction.countDocuments()).toBe(0);
  expect(await Wallet.countDocuments()).toBe(0);
  expect((await Order.findById(f.order._id)).onlineFeeSnapshot).toEqual(f.order.onlineFeeSnapshot);
});

test.each([false, true])('a verified seller card cancellation still permits another seller full Wallet refund (fees=%s)', async fees => {
  const f = await fixture('safepay', 'confirmed', fees);
  const { previewBuyerCancellation } = require('../../services/buyerCancellationService');
  const first = { orderId: f.order._id, buyerId: f.buyer, sellerIds: [String(f.sellers[0])] };
  const quote = await previewBuyerCancellation(first);
  await cancelBuyerOrder({ ...first, refundDestination: 'original_card', quoteId: quote.quoteId, acceptDeduction: true });
  const row = await Cancellation.findOne({ seller: f.sellers[0] });
  const amount = row.refundAmountMinor ?? row.amountMinor;
  await Cancellation.updateOne({ _id: row._id }, { $set: { refundStatus: 'processing', submitStartedAt: new Date(),
    refundBaselineMinor: 0, refundTargetMinor: amount } });
  await reconcileProviderRefund(await cardPayment(f), amount);
  const second = { orderId: f.order._id, buyerId: f.buyer, sellerIds: [String(f.sellers[1])] };
  const secondQuote = await previewBuyerCancellation(second);
  expect(secondQuote.options[0]).toMatchObject({ destination: 'wallet', amountMinor: 2200, deductionMinor: 0, available: true });
  await cancelBuyerOrder({ ...second, refundDestination: 'wallet', quoteId: secondQuote.quoteId });
  await cancelBuyerOrder({ ...second, refundDestination: 'wallet', quoteId: secondQuote.quoteId });
  expect((await Wallet.findOne({ user: f.buyer })).balances.USD).toBe(22);
  expect(await WalletTransaction.countDocuments()).toBe(1);
  expect(await Cancellation.countDocuments()).toBe(2);
  expect((await Payment.findById(f.order.safepayPaymentId))).toMatchObject({ refundedMinor: amount, walletRefundMinor: 2200,
    riskPending: false, status: 'paid' });
  expect(await require('../../models/SellerBalanceTransaction').countDocuments()).toBe(0);
});
test('Wallet-paid cancellation has ONE full refund option and refuses a card destination', async () => {
  const f=await fixture('wallet','confirmed',true), args={orderId:f.order._id,buyerId:f.buyer};
  const quote=await require('../../services/buyerCancellationService').previewBuyerCancellation(args);
  expect(quote.options).toEqual([{destination:'wallet',label:'Rozare Wallet',amountMinor:3400,deductionMinor:0,available:true}]);
  await expect(cancelBuyerOrder({...args,refundDestination:'original_card'})).rejects.toMatchObject({code:'REFUND_DESTINATION_INVALID'});
  await cancelBuyerOrder({...args,refundDestination:'wallet'});
  expect((await Wallet.findOne({user:f.buyer})).balances.USD).toBe(34);
});
test('full card cancellation conserves gross = actual refund + deduction across both sellers', async () => {
  const f=await fixture('safepay','confirmed',true),args={orderId:f.order._id,buyerId:f.buyer};
  const quote=await require('../../services/buyerCancellationService').previewBuyerCancellation(args);
  expect(quote.options[1]).toMatchObject({amountMinor:3178,deductionMinor:222});
  await cancelBuyerOrder({...args,refundDestination:'original_card',quoteId:quote.quoteId,acceptDeduction:true});
  const rows=await Cancellation.find({});
  expect(rows.reduce((n,r)=>n+r.refundAmountMinor,0)).toBe(3178);
  expect(rows.reduce((n,r)=>n+r.deductionMinor,0)).toBe(222);
  expect(rows.reduce((n,r)=>n+r.amountMinor,0)).toBe(3400);
});

test.each(['new', 'queued'])('a %s zero-net seller finishes locally while the positive card refund completes exactly once', async mode => {
  const f = await fixture('safepay', 'confirmed', true, { currency: 'PKR', prices: [1, 31], shipping: 0 });
  const args = { orderId: f.order._id, buyerId: f.buyer };
  const quote = await require('../../services/buyerCancellationService').previewBuyerCancellation(args);
  expect(quote.options[1]).toMatchObject({ amountMinor: 2, deductionMinor: 3198, available: true });
  await cancelBuyerOrder({ ...args, refundDestination: 'original_card', quoteId: quote.quoteId, acceptDeduction: true });
  const zero = await Cancellation.findOne({ seller: f.sellers[0] });
  expect(zero).toMatchObject({ amountMinor: 100, refundAmountMinor: 0, deductionMinor: 100,
    refundDestination: 'original_card', refundStatus: 'not_required', submitStartedAt: null });
  expect(enqueueNotificationEvent.mock.calls.filter(([event]) => String(event.recipient.user) === String(f.sellers[0]))
    .every(([event]) => event.templates.inapp.body.includes('No payment refund is required.'))).toBe(true);
  if (mode === 'queued') {
    // Reproduce a zero-net row already queued by the earlier implementation.
    await Cancellation.updateOne({ _id: zero._id }, { $set: { refundStatus: 'pending' } });
    await Order.updateOne({ _id: f.order._id }, { $set: { 'sellerFulfillment.0.cancellation.refundStatus': 'pending' } });
  }
  const payment = await Payment.findById(f.order.safepayPaymentId);
  const config = jest.spyOn(require('../../config/safepay'), 'readSafepayConfig').mockReturnValue({ environment: 'sandbox' });
  const refund = jest.fn(async () => {});
  const client = { getTracker: jest.fn()
    .mockResolvedValueOnce({ token: payment.tracker, state: 'TRACKER_ENDED', charge: { cybersource_refunds: [] } })
    .mockResolvedValue(trackerRefund(payment, 2)), refundPaymentAmount: refund };
  const factory = jest.spyOn(require('../../services/safepayClient'), 'createSafepayClient').mockReturnValue(client);
  try {
    const { processCancellationRefund } = require('../../services/cancellationRefundService');
    await processCancellationRefund(payment._id);
    await processCancellationRefund(payment._id);
    await processCancellationRefund(payment._id);
    await cancelBuyerOrder({ ...args, refundDestination: 'original_card', quoteId: quote.quoteId, acceptDeduction: true });
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith(payment.tracker, expect.anything(), 2);
    expect(await Cancellation.countDocuments()).toBe(2);
    expect(await Cancellation.countDocuments({ refundStatus: 'manual_review' })).toBe(0);
    expect((await Cancellation.findById(zero._id)).refundStatus).toBe('not_required');
    expect((await Cancellation.findOne({ seller: f.sellers[1] })).refundStatus).toBe('refunded');
    expect((await Order.findById(f.order._id)).sellerFulfillment[0].cancellation.refundStatus).toBe('not_required');
    expect((await Payment.findById(payment._id))).toMatchObject({ refundedMinor: 2, walletRefundMinor: 0, riskPending: false });
    expect(await WalletTransaction.countDocuments()).toBe(0);
    expect(await Wallet.countDocuments()).toBe(0);
    expect((await Product.findById(f.products[0]._id)).stock).toBe(5);
    expect((await Product.findById(f.products[1]._id)).stock).toBe(5);
  } finally { config.mockRestore(); factory.mockRestore(); }
});
test('a ship operation after preview refuses cancellation without any refund or inventory mutation', async () => {
  const f=await fixture('safepay','confirmed',true),args={orderId:f.order._id,buyerId:f.buyer,sellerIds:[String(f.sellers[0])]};
  const quote=await require('../../services/buyerCancellationService').previewBuyerCancellation(args);
  await Order.updateOne({_id:f.order._id},{$set:{'sellerFulfillment.0.status':'shipped'}});
  await expect(cancelBuyerOrder({...args,refundDestination:'wallet',quoteId:quote.quoteId})).rejects.toMatchObject({code:'ORDER_FULFILLMENT_STARTED'});
  expect(await WalletTransaction.countDocuments()).toBe(0);expect(await Cancellation.countDocuments()).toBe(0);
  expect((await Product.findById(f.products[0]._id)).stock).toBe(4);
});
test('a refunded card principal can fund a later Wallet purchase without losing its risk source',async()=>{
  const f=await fixture('safepay','confirmed',true),args={orderId:f.order._id,buyerId:f.buyer,sellerIds:[String(f.sellers[0])]};
  const quote=await require('../../services/buyerCancellationService').previewBuyerCancellation(args);
  await cancelBuyerOrder({...args,refundDestination:'wallet',quoteId:quote.quoteId});
  const source=await WalletTransaction.findOne({type:'return_refund'});
  const debit=await mongoose.connection.transaction(session=>require('../../services/walletService').debitWalletInSession({
    userId:f.buyer,amount:5,currency:'USD',type:'order_payment',referenceType:'order',referenceId:String(new mongoose.Types.ObjectId()),
    idempotencyKey:'qa-card-refund-respend',description:'QA Wallet purchase'},session));
  expect(debit.metadata.fundingProvenance).toEqual([{sourceType:'wallet_top_up',sourceTransactionId:String(source._id),amountMinor:500}]);
  expect((await WalletTransaction.findById(source._id)).metadata.fundingRemainingMinor).toBe(700);
  expect((await Wallet.findOne({user:f.buyer})).balances.USD).toBe(7);
});
test('a card vs Wallet cancellation race credits only the winning destination',async()=>{
  const f=await fixture('safepay','confirmed',true),args={orderId:f.order._id,buyerId:f.buyer,sellerIds:[String(f.sellers[0])]};
  const quote=await require('../../services/buyerCancellationService').previewBuyerCancellation(args);
  await require('../../models/SellerSettlementLock').create({seller:f.sellers[0],version:0});
  const outcomes=await Promise.allSettled(['wallet','original_card'].map(refundDestination=>cancelBuyerOrder({...args,
    refundDestination,quoteId:quote.quoteId,acceptDeduction:true})));
  expect(outcomes.filter(row=>row.status==='fulfilled')).toHaveLength(1);
  expect(await Cancellation.countDocuments()).toBe(1);
  const row=await Cancellation.findOne({});
  expect(await WalletTransaction.countDocuments()).toBe(row.refundDestination==='wallet'?1:0);
  expect((await Product.findById(f.products[0]._id)).stock).toBe(5);
});
test('a no-charge Safepay-method order cancels without a card payment or Wallet movement',async()=>{
  const f=await fixture('safepay','confirmed',true);
  const raw=f.order.toObject();raw._id=new mongoose.Types.ObjectId();raw.orderId='ORD-ZERO-'+raw._id;raw.safepayPaymentId=null;
  raw.orderItems=raw.orderItems.map(row=>({...row,price:0,lineSubtotal:0,sourcePrice:0,sourceLineSubtotal:0}));
  raw.sellerShipping=raw.sellerShipping.map(row=>({...row,shippingMethod:{...row.shippingMethod,price:0,sourceCost:0}}));
  raw.shippingMethod.price=0;raw.orderSummary={subtotal:0,shippingCost:0,tax:0,couponDiscount:0,totalAmount:0};
  raw.sellerSettlement=buildOrderSellerSettlement({...raw,sellerSettlementVersion:0},{requireOrderTotal:true});
  raw.sellerCurrencyMoney=buildOrderSellerCurrencyMoney({...raw,sellerCurrencyMoneyVersion:0});
  raw.onlineFeeSnapshot=require('../../services/onlineOrderFeeService').buildOnlineOrderFee(raw);
  const order=await Order.create(raw),args={orderId:order._id,buyerId:f.buyer};
  const quote=await require('../../services/buyerCancellationService').previewBuyerCancellation(args);
  expect(quote.options[0]).toMatchObject({destination:'none',amountMinor:0,deductionMinor:0});
  expect((await cancelBuyerOrder({...args,refundDestination:'none'})).orderStatus).toBe('cancelled');
  expect(await WalletTransaction.countDocuments()).toBe(0);
});
