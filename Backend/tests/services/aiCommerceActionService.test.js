'use strict';
process.env.JWT_SECRET = 'ai-commerce-isolated-test-secret-for-payout-snapshots';
process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('base64');
process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID = 'ai-commerce-test';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
jest.mock('../../services/notificationOutboxService', () => ({ enqueueNotificationEvent: jest.fn(async () => {}) }));
jest.mock('../../services/returnNotificationService', () => ({ notifySellerReturnRequested: jest.fn(async () => {}),
  notifyBuyerReturnStatus: jest.fn(async () => {}), notifyReturnSettlementCompleted: jest.fn(async () => {}),
  enqueueReturnCancellationNotifications: jest.fn(async () => {}) }));
jest.mock('../../services/financialNotificationOutboxService', () => ({ enqueueReturnSettlementNotifications: jest.fn(async () => {}),
  enqueueWithdrawalRequestedAdminNotifications: jest.fn(async () => {}), enqueueWithdrawalRequestedSellerNotifications: jest.fn(async () => {}),
  enqueueCodOrderDecisionSellerNotifications: jest.fn(async () => {}), enqueueOrderLifecycleBuyerNotifications: jest.fn(async () => {}),
  enqueueOrderSellerFulfillmentBuyerNotifications: jest.fn(async () => {}) }));
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const History = require('../../models/ChatHistory');
const Payment = require('../../models/SafepayPayment');
const Wallet = require('../../models/Wallet');
const Transaction = require('../../models/WalletTransaction');
const Return = require('../../models/ReturnRequest');
const Store = require('../../models/Store');
const Bank = require('../../models/SellerPaymentAccount');
const Withdrawal = require('../../models/SellerWithdrawalRequest');
const { buildOrderSellerSettlement, buildOrderSellerCurrencyMoney } = require('../../services/orderMoneyService');
const { executeCommerceTool: run } = require('../../services/aiCommerceActionService');
let replica;
const actor = (id, role = 'user') => ({ _id: id, id, role });
const ctx = (key, conversationId, text = '') => ({ _chatRequestKey: key, _chatConversationId: conversationId, _lastUserText: text });
async function savePreview(user, name, result) {
  const history = await History.findOne({ user: user._id }) || new History({ user: user._id, conversations: [] });
  history.conversations.push({ messages: [{ role: 'assistant', content: result.message, toolEvents: [{ tool: name, result }] }] });
  await history.save(); return String(history.conversations[history.conversations.length - 1]._id);
}
async function confirm(user, name, input, result, text = 'Yes, confirm this action') {
  const conversationId = await savePreview(user, name, result);
  return run(name, { ...input, confirm: true, ...ctx('confirm-' + new mongoose.Types.ObjectId(), conversationId, text) }, user);
}
async function fixture({ method = 'wallet', currency = 'USD', statuses = ['confirmed', 'shipped'], returnsEnabled = false, paymentRail = 'card' } = {}) {
  const buyerId = new mongoose.Types.ObjectId(), sellers = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  const products = await Product.create(sellers.map((seller, index) => ({ seller, name: 'Ceramic Cup ' + index, description: 'Reusable glazed ceramic cup.',
    price: index ? 20 : 10, currency, priceCurrency: currency, stock: 4, totalSales: 1, category: 'Home', brand: 'Coastal', image: 'https://example.com/cup.png' })));
  const deliveredAt = new Date(Date.now() - 3600000);
  const policy = { returnsEnabled, returnDuration: returnsEnabled ? 7 : 0, refundType: returnsEnabled ? 'full_refund' : 'none' };
  const raw = { user: buyerId, currency, orderId: 'ORD-QA-' + new mongoose.Types.ObjectId(),
    orderItems: products.map(product => ({ productId: product._id, seller: product.seller, name: product.name, price: product.price,
      lineSubtotal: product.price, sourcePrice: product.price, sourceLineSubtotal: product.price, sourceCurrency: currency,
      quantity: 1, returnPolicySnapshotVersion: 1, returnPolicy: policy })),
    sellerPolicies: sellers.map((seller, index) => ({ seller, productCurrency: currency, storeName: 'Coastal Store ' + index, returnPolicy: policy })),
    sellerShipping: sellers.map(seller => ({ seller, shippingMethod: { name: 'Standard', price: 2, sourceCost: 2, sourceCurrency: currency, estimatedDays: 3 } })),
    shippingMethod: { name: 'Standard', price: 4, estimatedDays: 3 },
    sellerFulfillment: sellers.map((seller, index) => ({ seller, status: statuses[index], ...(statuses[index] === 'delivered' ? { deliveredAt } : {}) })),
    orderSummary: { subtotal: 30, shippingCost: 4, tax: 0, couponDiscount: 0, totalAmount: 34 },
    shippingInfo: { fullName: 'QA Buyer', email: 'qa@example.com', phone: '+923001234567', address: 'Fixture Street', city: 'Lahore', state: 'Punjab', postalCode: '54000', country: 'Pakistan' },
    paymentMethod: method, isPaid: method !== 'cash_on_delivery', inventoryCommitted: true, awaitingPayment: false,
    orderStatus: statuses.every(status => status === 'delivered') ? 'delivered' : 'confirmed',
    isDelivered: statuses.every(status => status === 'delivered'), paymentSetupState: method === 'wallet' ? 'closed' : 'complete',
    paymentAppliedAt: new Date(), paidAt: new Date(),
    exchangeRateSnapshot: { base: 'USD', rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 }, capturedAt: new Date(), source: 'test', fallback: false } };
  raw.sellerSettlementVersion = 1; raw.sellerSettlement = buildOrderSellerSettlement(raw, { requireOrderTotal: true });
  raw.sellerCurrencyMoneyVersion = 1; raw.sellerCurrencyMoney = buildOrderSellerCurrencyMoney(raw);
  if (method !== 'cash_on_delivery') raw.onlineFeeSnapshot = require('../../services/onlineOrderFeeService').buildOnlineOrderFee(raw);
  if (method === 'safepay') { raw.safepayPaymentId = new mongoose.Types.ObjectId(); raw.safepayEnvironment = 'sandbox'; raw.safepayPaymentRail = paymentRail; }
  const order = await Order.create(raw);
  if (method === 'wallet') await Transaction.create({ user: buyerId, type: 'order_payment', direction: 'debit', status: 'completed', amount: 34,
    currency, referenceType: 'order', referenceId: String(order._id), idempotencyKey: 'wallet-order:' + order._id });
  if (method === 'safepay') await Payment.create({ _id: order.safepayPaymentId, environment: 'sandbox', purpose: 'order', user: buyerId, order: order._id,
    reference: 'order:' + order._id, requestKey: 'fixture-' + order._id, amountMinor: 3400, currency, providerMode: 'payment',
    fingerprint: 'a'.repeat(64), terms: {}, tracker: 'track_' + order._id, status: 'paid', capturedMinor: 3400, refundedMinor: 0, walletRefundMinor: 0,
    paymentRail, providerIntent: paymentRail === 'raast' ? 'RAAST' : 'CYBERSOURCE', paidAt: new Date(), appliedAt: new Date() });
  return { buyer: actor(buyerId), sellers: sellers.map(id => actor(id, 'seller')), products, order };
}
beforeAll(async () => { replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(replica.getUri());
  await Promise.all(Object.values(mongoose.models).map(model => model.init())); }, 60000);
beforeEach(() => {
  jest.spyOn(require('../../config/safepay'), 'readSafepayConfig').mockReturnValue({ environment: 'sandbox' });
  jest.spyOn(require('../../services/safepayClient'), 'createSafepayClient').mockReturnValue({ getTracker: jest.fn(async (_tracker, payment) => ({ token: payment.tracker,
    state: 'TRACKER_ENDED', intent: payment.providerIntent, mode: 'payment', purchase_totals: { quote_amount: { currency: payment.currency, amount: payment.amountMinor } } })) });
});
afterEach(async () => { await Promise.all(Object.values(mongoose.models).map(model => model.deleteMany({}))); jest.restoreAllMocks(); jest.clearAllMocks(); });
afterAll(async () => { await mongoose.disconnect(); if (replica) await replica.stop(); });

test('Wallet cancellation previews without money movement, then refunds only the confirmed unshipped seller', async () => {
  const f = await fixture(); const input = { orderId: f.order.orderId, sellerIds: [String(f.sellers[0]._id)] };
  const preview = await run('cancel_order', { ...input, ...ctx('preview') }, f.buyer);
  expect(preview.previewOnly).toBe(true); expect(preview.data.request.refundDestination).toBe('wallet');
  expect(await Wallet.countDocuments()).toBe(0);
  const result = await confirm(f.buyer, 'cancel_order', input, preview);
  expect(result.success).toBe(true); expect(result.message).toContain('12.00 USD credited');
  expect((await Wallet.findOne({ user: f.buyer._id })).balances.USD).toBe(12);
  const order = await Order.findById(f.order._id);
  expect(order.sellerFulfillment.map(row => row.status)).toEqual(['cancelled', 'shipped']);
  expect(order.orderSummary.totalAmount).toBe(34); expect((await Product.findById(f.products[0]._id)).stock).toBe(5);
  expect((await Product.findById(f.products[1]._id)).stock).toBe(4);
  const wallet = await run('get_wallet_balance', {}, f.buyer);
  expect(wallet.data.balances.USD).toBe(12); expect(wallet.data.balances.PKR).toBe(0);
  expect(wallet.message).toContain('separate');
});
test('a whole mixed order with a shipped portion is rejected before preview or refund', async () => {
  const f = await fixture(); const result = await run('cancel_order', { orderId: f.order.orderId, ...ctx('preview') }, f.buyer);
  expect(result).toMatchObject({ success: false, code: 'ORDER_FULFILLMENT_STARTED' }); expect(await Wallet.countDocuments()).toBe(0);
});
test('a foreign buyer cannot list or cancel another account\'s purchase', async () => {
  const f = await fixture(); const other = actor(new mongoose.Types.ObjectId());
  expect((await run('cancel_order', { orderId: f.order.orderId, ...ctx('preview') }, other)).success).toBe(false);
  expect((await run('get_purchase_orders', {}, other)).data.totalCount).toBe(0);
});
test('a seller can view their personal purchases without gaining control of another store', async () => {
  const f = await fixture(); const buyerSeller = actor(f.buyer._id, 'seller');
  const list = await run('get_purchase_orders', {}, buyerSeller);
  expect(list.data.totalCount).toBe(1); expect(list.data.scope).toBe('personal-purchases');
  expect((await run('update_order_status', { orderId: f.order.orderId, newStatus: 'shipped', ...ctx('preview') }, buyerSeller)).success).toBe(false);
});
test('Raast preview and cancellation allow full Wallet only, including small amounts below the fixed fee', async () => {
  const f = await fixture({ method: 'safepay', currency: 'PKR', paymentRail: 'raast' });
  const input = { orderId: f.order.orderId, sellerIds: [String(f.sellers[0]._id)] };
  const preview = await run('cancel_order', { ...input, ...ctx('preview') }, f.buyer);
  expect(preview.data.commercePreview.options.map(option => option.destination)).toEqual(['wallet']);
  expect((await run('cancel_order', { ...input, refundDestination: 'original_card', ...ctx('bad') }, f.buyer)).success).toBe(false);
  const result = await confirm(f.buyer, 'cancel_order', input, preview);
  expect(result.success).toBe(true); expect((await Wallet.findOne({ user: f.buyer._id })).balances.PKR).toBe(12);
  expect((await Payment.findById(f.order.safepayPaymentId)).walletRefundMinor).toBe(1200);
});
test('COD cancellation moves no refund money and cannot cancel shipped goods', async () => {
  const f = await fixture({ method: 'cash_on_delivery' }); const input = { orderId: f.order.orderId, sellerIds: [String(f.sellers[0]._id)] };
  const preview = await run('cancel_order', { ...input, ...ctx('preview') }, f.buyer);
  expect(preview.data.request.refundDestination).toBe('none');
  expect((await confirm(f.buyer, 'cancel_order', input, preview)).success).toBe(true);
  expect(await Wallet.countDocuments()).toBe(0);
});
test('returns expose frozen eligibility and require a real reason and exact owned item', async () => {
  const f = await fixture({ statuses: ['delivered', 'delivered'], returnsEnabled: true });
  const eligibility = await run('get_return_eligibility', { orderId: f.order.orderId }, f.buyer);
  expect(eligibility.data.groups[0].eligible).toBe(true);
  const input = { orderId: f.order.orderId, sellerId: String(f.sellers[0]._id), items: [{ orderItemId: String(f.order.orderItems[0]._id), quantity: 1 }],
    reasonCategory: 'damaged', reasonDetails: 'Cup arrived with a cracked rim.' };
  expect((await run('request_return', { ...input, reasonDetails: 'bad', ...ctx('bad') }, f.buyer)).code).toBe('RETURN_REASON_TOO_SHORT');
  const preview = await run('request_return', { ...input, ...ctx('preview') }, f.buyer);
  expect(preview.previewOnly).toBe(true); expect(await Return.countDocuments()).toBe(0);
  const result = await confirm(f.buyer, 'request_return', input, preview);
  expect(result.success).toBe(true); expect(result.data.status).toBe('requested');
  expect(result.data.refund.totalAmount).toBe(12); expect(await Wallet.countDocuments()).toBe(0);
  expect((await run('get_seller_returns', {}, f.sellers[1])).data.totalCount).toBe(0);
});
test('return scope cannot include another seller\'s line and undelivered goods are ineligible', async () => {
  const f = await fixture({ statuses: ['delivered', 'shipped'], returnsEnabled: true });
  const input = { orderId: f.order.orderId, sellerId: String(f.sellers[0]._id), items: [{ orderItemId: String(f.order.orderItems[1]._id), quantity: 1 }], reasonCategory: 'damaged', reasonDetails: 'Cup arrived with a cracked rim.' };
  expect((await run('request_return', { ...input, ...ctx('bad') }, f.buyer)).success).toBe(false);
  const groups = (await run('get_return_eligibility', { orderId: f.order.orderId }, f.buyer)).data.groups;
  expect(groups.find(group => String(group.seller._id) === String(f.sellers[1]._id)).eligible).toBe(false);
});
test('withdrawal previews enforce currency, bank, amount precision, minimum and held funds', async () => {
  const f = await fixture({ statuses: ['delivered', 'delivered'], returnsEnabled: true });
  const seller = f.sellers[0];
  await Bank.create({ seller: seller._id, bankName: 'QA Bank', accountHolderName: 'QA Seller', accountNumber: '12345678', accountNumberLast4: '5678', country: 'Pakistan', currency: 'USD' });
  expect((await run('request_withdrawal', { amount: 5.001, currency: 'USD', ...ctx('precision') }, seller)).code).toBe('WITHDRAWAL_AMOUNT_INVALID');
  expect((await run('request_withdrawal', { amount: 4, currency: 'USD', ...ctx('minimum') }, seller)).code).toBe('WITHDRAWAL_MINIMUM_NOT_MET');
  expect((await run('request_withdrawal', { amount: 5, currency: 'PKR', ...ctx('currency') }, seller)).code).toBe('WITHDRAWAL_BANK_CURRENCY_MISMATCH');
  expect((await run('request_withdrawal', { amount: 5, currency: 'USD', ...ctx('held') }, seller)).code).toBe('INSUFFICIENT_SELLER_BALANCE');
  expect(await Withdrawal.countDocuments()).toBe(0);
});
test('seller balance withdrawal reserves net money exactly once, without another processing fee', async () => {
  const f = await fixture({ statuses: ['delivered', 'delivered'] }); const seller = f.sellers[0];
  await Bank.create({ seller: seller._id, bankName: 'QA Bank', accountHolderName: 'QA Seller', accountNumber: '12345678', accountNumberLast4: '5678', country: 'Pakistan', currency: 'USD' });
  const input = { amount: 5, currency: 'USD' };
  const preview = await run('request_withdrawal', { ...input, ...ctx('preview') }, seller);
  expect(preview.previewOnly).toBe(true); expect(preview.message).toContain('No additional checkout fee'); expect(await Withdrawal.countDocuments()).toBe(0);
  const result = await confirm(seller, 'request_withdrawal', input, preview, 'Yes, withdraw 5 USD');
  expect(result).toMatchObject({ success: true }); expect(result.message).toContain('not paid');
  const withdrawal = await Withdrawal.findOne({ seller: seller._id });
  expect(withdrawal).toMatchObject({ amount: 5, currency: 'USD', status: 'pending', payoutAmount: 5, payoutCurrency: 'USD' });
  const another = await run('request_withdrawal', { ...input, ...ctx('another-preview') }, seller);
  expect(another.previewOnly).toBe(true); expect(another.message).toContain('ANOTHER NEW request');
  expect((await confirm(seller, 'request_withdrawal', input, another, 'Yes, withdraw 5 USD')).code).toBe('AI_COMMERCE_CONFIRMATION_CHANGED');
  expect(await Withdrawal.countDocuments()).toBe(1);
});
async function reviewedReturn(f) {
  const input = { orderId: f.order.orderId, sellerId: String(f.sellers[0]._id), items: [{ orderItemId: String(f.order.orderItems[0]._id), quantity: 1 }],
    reasonCategory: 'damaged', reasonDetails: 'Cup arrived with a cracked rim.' };
  const preview = await run('request_return', { ...input, ...ctx('return-preview') }, f.buyer);
  const created = await confirm(f.buyer, 'request_return', input, preview);
  expect(created.success).toBe(true);
  const request = await Return.findOne({ order: f.order._id });
  for (const status of ['approved', 'picked_up', 'in_transit_to_seller', 'received_by_seller', 'under_review']) {
    const action = { returnId: String(request._id), status };
    const next = await run('update_return_status', { ...action, ...ctx('status-' + status) }, f.sellers[0]);
    expect(next.previewOnly).toBe(true);
    expect((await confirm(f.sellers[0], 'update_return_status', action, next)).success).toBe(true);
  }
  return Return.findById(request._id);
}
test('AI follows real return transitions, then uses held Wallet order funds with no second seller payment', async () => {
  const f = await fixture({ statuses: ['delivered', 'delivered'], returnsEnabled: true });
  const request = await reviewedReturn(f);
  expect(request.status).toBe('under_review');
  const action = { returnId: String(request._id), fundingSource: 'safepay' };
  const preview = await run('accept_return', { ...action, ...ctx('accept-preview') }, f.sellers[0]);
  expect(preview.data.request.fundingSource).toBe('held_order');
  expect(preview.message).toContain('do not charge the seller again');
  const accepted = await confirm(f.sellers[0], 'accept_return', action, preview);
  expect(accepted).toMatchObject({ success: true, data: { status: 'returned', settlement: { fundingSource: 'held_order', walletCredited: true } } });
  expect((await Wallet.findOne({ user: f.buyer._id })).balances.USD).toBe(12);
  expect(await Payment.countDocuments()).toBe(0);
  const again = await run('accept_return', { ...action, ...ctx('again') }, f.sellers[0]);
  expect(again.success).toBe(false);
  expect(await Transaction.countDocuments({ type: 'return_refund' })).toBe(1);
});
test('seller cannot skip return logistics or mark a money refund through a status update', async () => {
  const f = await fixture({ statuses: ['delivered', 'delivered'], returnsEnabled: true });
  const input = { orderId: f.order.orderId, sellerId: String(f.sellers[0]._id), items: [{ orderItemId: String(f.order.orderItems[0]._id), quantity: 1 }], reasonCategory: 'damaged', reasonDetails: 'Cup arrived with a cracked rim.' };
  const preview = await run('request_return', { ...input, ...ctx('preview') }, f.buyer);
  await confirm(f.buyer, 'request_return', input, preview);
  const request = await Return.findOne({});
  for (const status of ['returned', 'under_review', 'received_by_seller']) expect((await run('update_return_status', { returnId: String(request._id), status, ...ctx(status) }, f.sellers[0])).success).toBe(false);
  expect((await run('accept_return', { returnId: String(request._id), ...ctx('bad-accept') }, f.sellers[0])).success).toBe(false);
  expect(await Wallet.countDocuments()).toBe(0);
});
test('a timely open return keeps funds held after the frozen return deadline', async () => {
  const f = await fixture({ statuses: ['delivered', 'delivered'], returnsEnabled: true });
  const input = { orderId: f.order.orderId, sellerId: String(f.sellers[0]._id), items: [{ orderItemId: String(f.order.orderItems[0]._id), quantity: 1 }], reasonCategory: 'damaged', reasonDetails: 'Cup arrived with a cracked rim.' };
  const preview = await run('request_return', { ...input, ...ctx('preview') }, f.buyer);
  await confirm(f.buyer, 'request_return', input, preview);
  const request = await Return.findOne({}).lean();
  const hold = require('../../services/sellerReturnHoldService').sellerReturnHold(f.order.toObject(), f.sellers[0]._id,
    { returns: [request], at: new Date(Date.now() + 8 * 86400000) });
  expect(hold.activeReturn).toBe(true); expect(hold.heldMinor).toBe(1200);
});
test('a changed bank between preview and confirmation creates a new review without reserving funds', async () => {
  const f = await fixture({ statuses: ['delivered', 'delivered'] }); const seller = f.sellers[0];
  const bank = await Bank.create({ seller: seller._id, bankName: 'QA Bank', accountHolderName: 'QA Seller', accountNumber: '12345678', accountNumberLast4: '5678', country: 'Pakistan', currency: 'USD' });
  const input = { amount: 5, currency: 'USD' };
  const preview = await run('request_withdrawal', { ...input, ...ctx('preview') }, seller);
  await Bank.updateOne({ _id: bank._id }, { bankName: 'Changed QA Bank' });
  const result = await confirm(seller, 'request_withdrawal', input, preview, 'Yes, withdraw 5 USD');
  expect(result.previewOnly).toBe(true); expect(await Withdrawal.countDocuments()).toBe(0);
});

test('saved cards expose only this environment masked presentation, never tokens or billing contact', async () => {
  const f = await fixture();
  jest.spyOn(require('../../services/safepayCustomerService'), 'listCards').mockResolvedValue({ environment: 'sandbox', billingProfileReady: true,
    defaultPaymentMethodId: 'private-card-token', cards: [{ id: 'private-card-token', last4: '1096', brand: 'mastercard', expMonth: 3, expYear: 2028, usable: true }],
    billingContact: { fullName: 'Private Billing Contact' } });
  const result = await run('get_saved_payment_methods', {}, f.buyer);
  expect(result).toMatchObject({ success: true, data: { environment: 'sandbox', cards: [{ last4: '1096', isDefault: true }] } });
  expect(JSON.stringify(result)).not.toMatch(/private-card-token|Private Billing Contact/);
});
test('withdrawal, subdomain and badge readers enforce seller scope and never claim new money movement', async () => {
  const f = await fixture();
  await Store.create({ seller: f.sellers[0]._id, storeName: 'Private QA Store', storeSlug: 'private-qa-store',
    subdomainPurchase: { isPurchased: true, expiresAt: new Date(Date.now() + 86400000) } });
  expect((await run('get_subdomain_status', {}, f.sellers[0])).data.purchasedOwnershipActive).toBe(true);
  expect((await run('get_subdomain_status', {}, f.sellers[1])).success).toBe(false);
  for (const name of ['get_my_withdrawals', 'get_subdomain_status', 'get_verification_status']) {
    expect((await run(name, {}, f.buyer)).code).toBe('AI_COMMERCE_SELLER_REQUIRED');
  }
  const withdrawals = await run('get_my_withdrawals', {}, f.sellers[0]);
  expect(withdrawals).toMatchObject({ success: true, data: { count: 0 } });
  expect(withdrawals.message).toContain('No new request or transfer');
});
test('the canonical controller adapter supports an id-only authenticated actor', async () => {
  const value = new mongoose.Types.ObjectId();
  const result = await require('../../services/aiCommerceActionService').controllerCall(async (req, res) => {
    expect(req.user.id).toBe(String(value)); res.json({ success: true });
  }, { id: value, role: 'seller' }, {});
  expect(result.success).toBe(true);
});

test('store visibility edits validate country rules, affect only the owner and retain old order policies', async () => {
  const f = await fixture();
  await require('../../models/User').collection.insertOne({ _id: f.sellers[0]._id, role: 'seller', currency: 'PKR', sellerInfo: { country: 'Pakistan', countryCode: 'PK' } });
  const store = await Store.create({ seller: f.sellers[0]._id, storeName: 'Visibility QA Store', storeSlug: 'visibility-qa-store',
    visibility: { mode: 'country', country: 'Pakistan', countryCode: 'PK', countryKey: 'pakistan' } });
  const execute = require('../../services/aiActionExecutor').executeToolCall;
  const invalid = await execute('update_store', { updates: { visibility: { mode: 'country', country: 'Pakistan', countryCode: 'US' } }, ...ctx('visibility-invalid') }, f.sellers[0]);
  expect(invalid).toMatchObject({ success: false, code: 'STORE_VISIBILITY_INVALID' });
  const global = await execute('update_store', { updates: { visibility: { mode: 'global' } }, ...ctx('visibility-global') }, f.sellers[0]);
  expect(global).toMatchObject({ success: true, data: { visibility: { mode: 'global' } } });
  expect(global.requiredDisclosure).toContain('ship your products globally');
  const country = await execute('update_store', { updates: { visibility: { mode: 'country' } }, ...ctx('visibility-country') }, f.sellers[0]);
  expect(country).toMatchObject({ success: true, data: { visibility: { mode: 'country', countryCode: 'PK' } } });
  expect((await Store.findById(store._id)).visibility.country).toBe('Pakistan');
  expect((await Order.findById(f.order._id)).sellerPolicies.map(policy => policy.returnDuration)).toEqual(f.order.sellerPolicies.map(policy => policy.returnDuration));
});

test('verified store discovery follows Global plus home country and verified-brand filtering cannot be spoofed by product metadata', async () => {
  const f = await fixture();
  const User = require('../../models/User');
  await User.collection.insertMany(f.sellers.map((seller, index) => ({ _id: seller._id, role: 'seller', status: 'active', username: 'QA Brand ' + index })));
  const global = await Store.create({ seller: f.sellers[0]._id, storeName: 'Verified Global QA', storeSlug: 'verified-global-qa', sellerType: 'brand', verification: { isVerified: true }, visibility: { mode: 'global' } });
  const local = await Store.create({ seller: f.sellers[1]._id, storeName: 'Verified Pakistan QA', storeSlug: 'verified-pakistan-qa', sellerType: 'brand', verification: { isVerified: true }, visibility: { mode: 'country', country: 'Pakistan', countryCode: 'PK', countryKey: 'pakistan' } });
  await Product.updateMany({}, { brand: 'Verified Pakistan QA' });
  const execute = require('../../services/aiActionExecutor').executeToolCall;
  const shopper = { ...f.buyer, currency: 'USD', _buyerLocation: { mode: 'country', country: 'Pakistan', countryCode: 'PK' } };
  const country = await execute('get_verified_stores', { brandOnly: true }, shopper);
  expect(country.data.stores.map(store => String(store._id))).toEqual([String(local._id)]);
  shopper._buyerLocation.mode = 'global';
  const all = await execute('get_verified_stores', { brandOnly: true }, shopper);
  expect(all.data.count).toBe(2);
  const filtered = await execute('search_products', { verifiedBrandStoreId: String(local._id) }, shopper);
  expect(filtered.success).toBe(true);
  expect(filtered.data.products.length).toBeGreaterThan(0);
  expect(filtered.data.products.every(product => String(product.seller) === String(f.sellers[1]._id))).toBe(true);
  shopper._buyerLocation = { mode: 'global', country: 'United States', countryCode: 'US' };
  const outside = await execute('get_verified_stores', { brandOnly: true }, shopper);
  expect(outside.data.stores.map(store => String(store._id))).toEqual([String(global._id)]);
  expect((await execute('search_products', { verifiedBrandStoreId: String(local._id) }, shopper)).code).toBe('CATALOG_FILTER_INVALID');
});

test.each([{ minPrice: -1 }, { maxPrice: -1 }, { minPrice: 5, maxPrice: 1 }, { currency: 'CAD' }])('invalid AI price filters fail instead of silently removing the filter: %j', async args => {
  const result = await require('../../services/aiActionExecutor').executeToolCall('search_products', args, { currency: 'USD', role: 'guest' });
  expect(result).toMatchObject({ success: false, code: 'CATALOG_FILTER_INVALID' });
});

test('a historical returned flag without its actual refund ledger cannot claim a verified Wallet refund', async () => {
  const f = await fixture({ statuses: ['delivered', 'delivered'], returnsEnabled: true });
  const input = { orderId: f.order.orderId, sellerId: String(f.sellers[0]._id), items: [{ orderItemId: String(f.order.orderItems[0]._id), quantity: 1 }], reasonCategory: 'damaged', reasonDetails: 'Cup arrived with a cracked rim.' };
  const preview = await run('request_return', { ...input, ...ctx('return-proof-preview') }, f.buyer);
  await confirm(f.buyer, 'request_return', input, preview);
  const request = await Return.findOne({});
  await Return.collection.updateOne({ _id: request._id }, { $set: { status: 'returned', 'settlement.status': 'completed', 'settlement.walletTransaction': new mongoose.Types.ObjectId() } });
  const result = await run('get_return_detail', { returnId: String(request._id), view: 'buyer' }, f.buyer);
  expect(result.data.settlement.walletCredited).toBe(false);
  expect(result.data.statusLabel).toBe('Return completed; Wallet refund not yet verified');
  expect(await Transaction.countDocuments({ type: 'return_refund' })).toBe(0);
});
