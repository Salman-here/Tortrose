'use strict';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Order = require('../../models/Order');
const ReturnRequest = require('../../models/ReturnRequest');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const Payment = require('../../models/SafepayPayment');
const SellerBalanceTransaction = require('../../models/SellerBalanceTransaction');
const SellerPaymentRiskHold = require('../../models/SellerPaymentRiskHold');
const SellerSettlementLock = require('../../models/SellerSettlementLock');
const Withdrawal = require('../../models/SellerWithdrawalRequest');
const SellerPaymentAccount = require('../../models/SellerPaymentAccount');
const User = require('../../models/User');
const NotificationOutbox = require('../../models/NotificationOutbox');
const RefundEvent = require('../../models/SafepayRefundEvent');
const payments = require('../../services/safepayPaymentService');
const { buildOrderSellerSettlement, buildOrderSellerCurrencyMoney } = require('../../services/orderMoneyService');
const { buildOnlineOrderFee } = require('../../services/onlineOrderFeeService');
const { buildSellerPaymentSummary, createWithdrawalRequest } = require('../../controllers/PaymentController');
const { settleFromSellerBalance, createSafepayReturnSettlement, completeSafepayReturnSettlement } = require('../../services/returnService');
const { debitWalletInSession } = require('../../services/walletService');
const { attachSafepayReturnFundingProvenance } = require('../../services/walletOrderFundingRiskService');

const rates = { USD: 1, PKR: 300, EUR: 0.9, GBP: 0.8 };
const models = [Order, ReturnRequest, Wallet, WalletTransaction, Payment, SellerBalanceTransaction,
  SellerPaymentRiskHold, SellerSettlementLock, Withdrawal, SellerPaymentAccount, User, NotificationOutbox, RefundEvent];
let replica, prepare;
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await Promise.all(models.map(model => model.init()));
}, 120000);
afterAll(async () => { await mongoose.disconnect(); await replica?.stop(); });
beforeEach(async () => {
  await Promise.all(models.map(model => model.deleteMany({})));
  Object.assign(process.env, { SAFEPAY_ENV: 'sandbox', SAFEPAY_SANDBOX_PUBLIC_KEY: 'sec_test-cod-returns',
    SAFEPAY_SANDBOX_SECRET_KEY: 'private-cod-return-test', SAFEPAY_SANDBOX_WEBHOOK_SECRET: 'private-cod-return-webhook',
    SAFEPAY_SANDBOX_WEBHOOK_SCHEME: 'sha512-raw' });
  prepare = jest.spyOn(payments, 'prepareCheckout').mockImplementation(async paymentId => ({ paymentId: String(paymentId) }));
});
afterEach(() => prepare.mockRestore());

async function order({ seller = new mongoose.Types.ObjectId(), buyer = new mongoose.Types.ObjectId(),
  native = 'PKR', currency = native, total = 1000, method = 'cash_on_delivery' } = {}) {
  const buyerTotal = Math.round(total / rates[native] * rates[currency] * 100) / 100;
  const returnable = method === 'cash_on_delivery';
  const policy = { returnsEnabled: returnable, returnDuration: returnable ? 7 : 0, refundType: returnable ? 'full_refund' : 'none' };
  const stored = new Order({ user: buyer, orderId: `ORD-COD-TEST-${new mongoose.Types.ObjectId()}`, currency,
    orderItems: [{ productId: new mongoose.Types.ObjectId(), seller, name: 'COD QA item', image: 'https://example.com/item.png',
      quantity: 1, price: buyerTotal, lineSubtotal: buyerTotal, sourcePrice: total, sourceLineSubtotal: total, sourceCurrency: native,
      returnPolicySnapshotVersion: 1, returnPolicy: policy }],
    orderSummary: { subtotal: buyerTotal, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: buyerTotal },
    shippingInfo: { fullName: 'QA Buyer', email: 'cod-qa@example.com', phone: '+923001234567', address: 'QA Street',
      city: 'Lahore', state: 'Punjab', postalCode: '54000', country: 'Pakistan' },
    shippingMethod: { name: 'free', price: 0, estimatedDays: 1, seller },
    sellerShipping: [{ seller, shippingMethod: { name: 'free', price: 0, estimatedDays: 1, sourceCost: 0, sourceCurrency: native } }],
    sellerPolicies: [{ seller, productCurrency: native, returnPolicy: policy }],
    sellerFulfillment: [{ seller, status: 'delivered', deliveredAt: new Date() }],
    exchangeRateSnapshot: { base: 'USD', rates, capturedAt: new Date(), source: 'qa-frozen', fallback: false },
    paymentMethod: method, isPaid: method !== 'cash_on_delivery', orderStatus: 'delivered', isDelivered: true,
    deliveredAt: new Date(), awaitingPayment: false, inventoryCommitted: true });
  stored.sellerSettlementVersion = 1; stored.sellerSettlement = buildOrderSellerSettlement(stored, { requireOrderTotal: true });
  stored.sellerCurrencyMoneyVersion = 1; stored.sellerCurrencyMoney = buildOrderSellerCurrencyMoney(stored);
  if (method === 'wallet') stored.onlineFeeSnapshot = buildOnlineOrderFee(stored);
  await stored.save();
  return stored;
}

async function request(original) {
  const line = original.orderItems[0];
  return ReturnRequest.create({ returnNumber: `RET-COD-QA-${new mongoose.Types.ObjectId()}`, order: original._id,
    orderId: original.orderId, buyer: original.user, seller: line.seller, currency: original.currency,
    items: [{ orderItemId: line._id, productId: line.productId, name: line.name, quantity: 1, purchasedQuantity: 1,
      unitPrice: line.price, lineSubtotal: line.lineSubtotal }], reasonCategory: 'defective', reasonDetails: 'QA defective item',
    status: 'under_review', statusHistory: [{ status: 'under_review', actorRole: 'seller' }],
    eligibilityDeadline: new Date(Date.now() + 86400000), refundFundingPolicy: 'seller_funded',
    policySnapshot: { returnsEnabled: true, returnDuration: 7, refundType: 'full_refund' },
    refund: { itemSubtotal: line.lineSubtotal, taxAmount: 0, shippingAmount: 0, discountAmount: 0, totalAmount: line.lineSubtotal } });
}

async function cardAttempt(original) {
  const returned = await request(original);
  const setup = await createSafepayReturnSettlement({ returnRequestId: returned._id, sellerId: returned.seller,
    requestKey: `cod-return:${returned._id}` });
  const payment = await Payment.findById(setup.paymentId);
  payment.status = 'ready'; payment.tracker = `track_cod-return-${payment._id}`; await payment.save();
  let state = 'TRACKER_ENDED';
  const service = payments.createSafepayPaymentService({ configFor: () => ({ environment: 'sandbox' }),
    clientFor: () => ({ getTracker: async () => ({ state }) }) });
  return { returned, payment, service, setState: next => { state = next; } };
}

test.each([['PKR', 'PKR'], ['PKR', 'USD'], ['USD', 'USD'], ['USD', 'PKR']])(
  'delivered COD %s seller / %s buyer can fund the exact NET available boundary without a withdrawal minimum', async (native, currency) => {
    // Align the PKR entitlement with a whole buyer USD cent (909 PKR = 3.03 USD).
    const earning = await order({ native, method: 'wallet', total: native === 'PKR' && currency === 'USD' ? 1001.07 : 1000 });
    const seller = earning.orderItems[0].seller;
    const before = await buildSellerPaymentSummary(seller, { displayCurrency: native });
    const available = before.balanceByCurrency[native].withdrawableBalance;
    const original = await order({ seller, native, currency, total: available });
    const returned = await request(original);
    await settleFromSellerBalance({ returnRequestId: returned._id, sellerId: seller });
    await settleFromSellerBalance({ returnRequestId: returned._id, sellerId: seller });
    const after = await buildSellerPaymentSummary(seller, { displayCurrency: native });
    expect(after.balanceByCurrency[native].withdrawableBalance).toBe(0);
    expect(after.balanceByCurrency[native].deficit).toBe(0);
    expect(after.balanceByCurrency[native].processingFeeAndTax).toBe(before.balanceByCurrency[native].processingFeeAndTax);
    for (const other of Object.keys(rates).filter(code => code !== native)) expect(after.balanceByCurrency[other].withdrawableBalance).toBe(0);
    expect(await SellerBalanceTransaction.countDocuments({ type: 'return_refund' })).toBe(1);
    expect((await ReturnRequest.findById(returned._id)).settlement.fundingSource).toBe('seller_balance');
    expect((await Wallet.findOne({ user: original.user })).balances[currency]).toBe(original.orderSummary.totalAmount);
  });

test.each([['PKR', 'PKR'], ['PKR', 'USD'], ['USD', 'USD'], ['USD', 'PKR']])(
  'COD %s seller / %s buyer rejects one native cent over available even with another currency balance', async (native, currency) => {
    const crossPkr = native === 'PKR' && currency === 'USD';
    const earning = await order({ native, method: 'wallet', total: crossPkr ? 991.46 : 1000 });
    const seller = earning.orderItems[0].seller;
    const other = native === 'PKR' ? 'USD' : 'PKR';
    await order({ seller, native: other, method: 'wallet' });
    const before = await buildSellerPaymentSummary(seller, { displayCurrency: native });
    const available = before.balanceByCurrency[native].withdrawableBalance;
    const original = await order({ seller, native, currency, total: crossPkr ? 900 : Math.round((available + 0.01) * 100) / 100 });
    expect(original.sellerCurrencyMoney[0].totalMinor).toBe(Math.round(available * 100) + 1);
    const returned = await request(original);
    await expect(settleFromSellerBalance({ returnRequestId: returned._id, sellerId: seller }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_SELLER_BALANCE', availableBalance: available, currency: native });
    expect((await ReturnRequest.findById(returned._id)).status).toBe('under_review');
    expect(await SellerBalanceTransaction.countDocuments()).toBe(0);
    expect(await WalletTransaction.countDocuments()).toBe(0);
    const after = await buildSellerPaymentSummary(seller, { displayCurrency: native });
    expect(after.balanceByCurrency[native].withdrawableBalance).toBe(available);
    expect(after.balanceByCurrency[other].withdrawableBalance).toBe(before.balanceByCurrency[other].withdrawableBalance);
  });

test('seller Safepay COD refund becomes a principal lot and reversal fences its later seller without a second fee or seller debit', async () => {
  const earning = await order({ method: 'wallet' });
  const seller = earning.orderItems[0].seller;
  const before = await buildSellerPaymentSummary(seller, { displayCurrency: 'PKR' });
  const original = await order({ seller, currency: 'USD', total: 600 });
  const attempt = await cardAttempt(original);
  await attempt.service.reconcilePayment(attempt.payment._id);
  const credit = await WalletTransaction.findOne({ type: 'return_refund' });
  expect(credit.metadata).toMatchObject({ cardRefundFunding: true, fundingProviderPurpose: 'return_settlement',
    fundingRemainingMinor: 200, fundingOriginalAvailableMinor: 200, fundingProvenanceReturns: [] });
  expect(String(credit.safepayPaymentId)).toBe(String(attempt.payment._id));
  expect(credit.safepayEnvironment).toBe('sandbox');
  expect(credit.metadata.onlineFeeSnapshot).toBeUndefined();
  expect(await SellerBalanceTransaction.countDocuments({ type: 'return_refund' })).toBe(0);
  expect((await buildSellerPaymentSummary(seller, { displayCurrency: 'PKR' })).balanceByCurrency.PKR.withdrawableBalance)
    .toBe(before.balanceByCurrency.PKR.withdrawableBalance);
  const downstream = await order({ buyer: original.user, native: 'USD', total: 2, method: 'wallet' });
  await mongoose.connection.transaction(async session => {
    const spent = await debitWalletInSession({ userId: original.user, amount: 2, currency: 'USD', type: 'order_payment',
      referenceType: 'order', referenceId: downstream._id, idempotencyKey: `qa-spend:${downstream._id}` }, session);
    expect(spent.metadata.fundingProvenance).toMatchObject([{ sourceTransactionId: String(credit._id), amountMinor: 200 }]);
    expect(spent.metadata.untrackedFundingMinor).toBe(0);
  });
  await attempt.service.reconcilePayment(attempt.payment._id);
  expect(await WalletTransaction.countDocuments({ type: 'return_refund' })).toBe(1);
  expect((await WalletTransaction.findById(credit._id)).metadata.fundingRemainingMinor).toBe(0);
  expect((await Payment.findById(attempt.payment._id))).toMatchObject({ capturedMinor: 200, walletRefundMinor: 200 });
  expect((await Wallet.findOne({ user: original.user })).balances.USD).toBe(0);
  attempt.setState('TRACKER_REVERSED');
  await attempt.service.reconcilePayment(attempt.payment._id);
  const holds = await SellerPaymentRiskHold.find({ status: 'pending' });
  expect(new Set(holds.map(row => String(row.seller)))).toEqual(new Set([String(seller), String(downstream.orderItems[0].seller)]));
  expect((await buildSellerPaymentSummary(downstream.orderItems[0].seller, { displayCurrency: 'USD' })).balanceByCurrency.USD.withdrawableBalance).toBe(0);
  expect((await Wallet.findOne({ user: original.user })).status).toBe('locked');
});

test.each(['purpose', 'environment', 'currency', 'buyer', 'seller', 'return', 'order', 'attempt', 'tracker', 'capture', 'refund_cap'])('seller card principal rejects changed %s binding without a Wallet credit', async field => {
  const original = await order();
  const attempt = await cardAttempt(original);
  const payment = attempt.payment.toObject();
  if (field === 'purpose') payment.purpose = 'wallet_top_up';
  if (field === 'environment') payment.environment = 'production';
  if (field === 'currency') payment.currency = 'USD';
  if (field === 'buyer') payment.terms.buyerId = String(new mongoose.Types.ObjectId());
  if (field === 'seller') payment.user = new mongoose.Types.ObjectId();
  if (field === 'return') payment.returnRequest = new mongoose.Types.ObjectId();
  if (field === 'order') payment.terms.orderId = String(new mongoose.Types.ObjectId());
  if (field === 'attempt') payment.terms.attempt += 1;
  if (field === 'tracker') payment.tracker = 'track_other-owned-tracker';
  if (field === 'capture') payment.capturedMinor = payment.amountMinor - 1;
  if (field === 'refund_cap') payment.walletRefundMinor = 1;
  await expect(mongoose.connection.transaction(session => completeSafepayReturnSettlement(payment, { state: 'TRACKER_ENDED' }, session)))
    .rejects.toMatchObject({ code: expect.stringMatching(/SAFEPAY_RETURN_BINDING_INVALID|WALLET_CARD_REFUND_BINDING_INVALID/) });
  expect(await WalletTransaction.countDocuments()).toBe(0);
  expect((await ReturnRequest.findById(attempt.returned._id)).status).toBe('accepted_pending_payment');
});

test('concurrent duplicate completion retries its transaction and claims card principal once', async () => {
  const attempt = await cardAttempt(await order({ total: 20 }));
  const complete = () => mongoose.connection.transaction(async session => {
    const payment = await Payment.findById(attempt.payment._id).session(session);
    return completeSafepayReturnSettlement(payment, { state: 'TRACKER_ENDED' }, session);
  });
  await Promise.all([complete(), complete()]);
  expect(await WalletTransaction.countDocuments({ type: 'return_refund' })).toBe(1);
  expect((await Payment.findById(attempt.payment._id)).walletRefundMinor).toBe(2000);
  expect((await Wallet.findOne({ user: attempt.returned.buyer })).balances.PKR).toBe(20);
});

test('pending authorization grants no credit; provider closure allows a fresh distinct attempt', async () => {
  const attempt = await cardAttempt(await order());
  await expect(mongoose.connection.transaction(session => completeSafepayReturnSettlement(attempt.payment, { state: 'TRACKER_AUTHORIZED' }, session)))
    .rejects.toMatchObject({ code: 'RETURN_SETTLEMENT_NOT_PAID' });
  attempt.setState('TRACKER_CANCELLED'); await attempt.service.reconcilePayment(attempt.payment._id);
  expect((await ReturnRequest.findById(attempt.returned._id)).status).toBe('under_review');
  const next = await createSafepayReturnSettlement({ returnRequestId: attempt.returned._id, sellerId: attempt.returned.seller,
    requestKey: `cod-return-fresh:${attempt.returned._id}` });
  expect(next.paymentId).not.toBe(String(attempt.payment._id));
  expect(await WalletTransaction.countDocuments()).toBe(0);
});

test('principal replay validates the durable lot and never replenishes spent cents', async () => {
  const attempt = await cardAttempt(await order({ total: 10 }));
  await attempt.service.reconcilePayment(attempt.payment._id);
  const returned = await ReturnRequest.findById(attempt.returned._id), payment = await Payment.findById(attempt.payment._id);
  const credit = await WalletTransaction.findOne({ type: 'return_refund' });
  await WalletTransaction.updateOne({ _id: credit._id }, { $set: { 'metadata.fundingRemainingMinor': 100 } });
  await mongoose.connection.transaction(async session => {
    const currentCredit = await WalletTransaction.findById(credit._id).session(session);
    await attachSafepayReturnFundingProvenance({ walletTransaction: currentCredit, request: returned, payment, session });
  });
  expect((await WalletTransaction.findById(credit._id)).metadata.fundingRemainingMinor).toBe(100);
  expect((await Payment.findById(payment._id)).walletRefundMinor).toBe(1000);
});

test('an expired attempt followed by a fresh attempt cannot credit old late capture or duplicate new principal', async () => {
  const original = await order({ total: 10 });
  const old = await cardAttempt(original);
  old.setState('TRACKER_EXPIRED');
  await old.service.reconcilePayment(old.payment._id);
  expect((await Payment.findById(old.payment._id)).status).toBe('cancelled');
  expect((await ReturnRequest.findById(old.returned._id)).status).toBe('under_review');

  const setup = await createSafepayReturnSettlement({ returnRequestId: old.returned._id,
    sellerId: old.returned.seller, requestKey: `fresh-after-expiry:${old.returned._id}` });
  const fresh = await Payment.findById(setup.paymentId);
  fresh.status = 'ready'; fresh.tracker = `track_cod-fresh-${fresh._id}`; await fresh.save();
  expect(String(fresh._id)).not.toBe(String(old.payment._id));
  expect(fresh.terms.attempt).toBe(2);

  old.setState('TRACKER_ENDED');
  await old.service.reconcilePayment(old.payment._id);
  const quarantined = await Payment.findById(old.payment._id);
  expect(quarantined).toMatchObject({ status: 'manual_review', riskPending: true, walletRefundMinor: 0, refundedMinor: 0 });
  expect(await RefundEvent.countDocuments()).toBe(0);
  expect(await WalletTransaction.countDocuments({ type: 'return_refund' })).toBe(0);
  expect(String((await ReturnRequest.findById(old.returned._id)).settlement.safepayPaymentId)).toBe(String(fresh._id));

  const service = payments.createSafepayPaymentService({ configFor: () => ({ environment: 'sandbox' }),
    clientFor: () => ({ getTracker: async () => ({ state: 'TRACKER_ENDED' }) }) });
  await service.reconcilePayment(fresh._id);
  await old.service.reconcilePayment(old.payment._id);
  await service.reconcilePayment(fresh._id);
  const credits = await WalletTransaction.find({ type: 'return_refund' });
  expect(credits).toHaveLength(1);
  expect(credits[0]).toMatchObject({ amount: 10, currency: 'PKR',
    metadata: { cardRefundFunding: true, fundingRemainingMinor: 1000, fundingOriginalAvailableMinor: 1000 } });
  expect(String(credits[0].safepayPaymentId)).toBe(String(fresh._id));
  expect((await Wallet.findOne({ user: original.user })).balances.PKR).toBe(10);
  expect((await Payment.findById(fresh._id))).toMatchObject({ status: 'paid', capturedMinor: 1000, walletRefundMinor: 1000 });
  expect((await Payment.findById(old.payment._id)).walletRefundMinor).toBe(0);
  expect(await SellerBalanceTransaction.countDocuments({ type: 'return_refund' })).toBe(0);
});

test.each([[true, false], [true, true], [false, false], [false, true]])(
  'concurrent COD refund/withdrawal with existing fence=%s and withdrawal first=%s cannot consume the same funds',
  async (existingFence, withdrawalFirst) => {
  const previousEncryptionKey = process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY;
  process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString('base64');
  try {
    const seller = await User.create({ username: 'COD Race QA Seller', email: 'cod-race-seller@example.com',
      password: 'test-password', role: 'seller', currency: 'PKR' });
    await order({ seller: seller._id, method: 'wallet', total: 3000 });
    const original = await order({ seller: seller._id, total: 2000 });
    const returned = await request(original);
    await SellerPaymentAccount.create({ seller: seller._id, accountHolderName: 'QA Race Seller',
      bankName: 'QA Bank No Real Transfer', accountNumber: 'QA-NO-TRANSFER-0001', accountNumberLast4: '0001',
      country: 'Pakistan', countryCode: 'PK', currency: 'PKR', isActive: true,
      payoutInstructions: 'QA only; never send an actual bank transfer.' });
    if (existingFence) await SellerSettlementLock.create({ seller: seller._id });
    const before = await buildSellerPaymentSummary(seller._id, { displayCurrency: 'PKR' });
    expect(before.balanceByCurrency.PKR.withdrawableBalance).toBe(2784);
    const withdrawal = { statusCode: 200, body: null };
    const res = { status: code => { withdrawal.statusCode = code; return res; },
      json: body => { withdrawal.body = body; return res; } };
    const settleRefund = () => settleFromSellerBalance({ returnRequestId: returned._id, sellerId: seller._id });
    const submitWithdrawal = () => createWithdrawalRequest({ user: { id: String(seller._id), role: 'seller', currency: 'PKR' },
      body: { requestedAmount: 2000, requestedCurrency: 'PKR' }, get: () => 'cod-refund-withdrawal-race' }, res);
    const outcomes = await Promise.allSettled(withdrawalFirst
      ? [submitWithdrawal(), settleRefund()] : [settleRefund(), submitWithdrawal()]);
    const refund = outcomes[withdrawalFirst ? 1 : 0], withdraw = outcomes[withdrawalFirst ? 0 : 1];
    expect(withdraw.status).toBe('fulfilled');
    const refundWon = refund.status === 'fulfilled';
    const withdrawalWon = withdrawal.statusCode === 201;
    expect(Number(refundWon) + Number(withdrawalWon)).toBe(1);
    if (!refundWon) expect(refund.reason.code).toBe('INSUFFICIENT_SELLER_BALANCE');
    if (!withdrawalWon) expect(withdrawal.statusCode).toBe(400);
    const after = await buildSellerPaymentSummary(seller._id, { displayCurrency: 'PKR' });
    expect(after.balanceByCurrency.PKR).toMatchObject({ withdrawableBalance: 784, deficit: 0,
      totalReservedOrWithdrawn: 2000, pendingWithdrawalAmount: withdrawalWon ? 2000 : 0,
      returnRefundDebits: refundWon ? 2000 : 0, processingFeeAndTax: 216 });
    expect(await Withdrawal.countDocuments({ seller: seller._id })).toBe(withdrawalWon ? 1 : 0);
    expect(await SellerBalanceTransaction.countDocuments({ referenceId: String(returned._id) })).toBe(refundWon ? 1 : 0);
    expect(await WalletTransaction.countDocuments({ referenceId: String(returned._id), type: 'return_refund' })).toBe(refundWon ? 1 : 0);
    expect((await ReturnRequest.findById(returned._id)).status).toBe(refundWon ? 'returned' : 'under_review');
    expect(await Payment.countDocuments({ purpose: 'return_settlement' })).toBe(0);
  } finally {
    if (previousEncryptionKey === undefined) delete process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY;
    else process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = previousEncryptionKey;
  }
});

test('a committed withdrawal reservation blocks the later COD refund without any partial credit or debit', async () => {
  const previousEncryptionKey = process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY;
  process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString('base64');
  try {
    const seller = await User.create({ username: 'Reserved COD QA Seller', email: 'reserved-cod-seller@example.com',
      password: 'test-password', role: 'seller', currency: 'PKR' });
    await order({ seller: seller._id, method: 'wallet', total: 3000 });
    const original = await order({ seller: seller._id, total: 2000 });
    const returned = await request(original);
    await SellerPaymentAccount.create({ seller: seller._id, accountHolderName: 'QA Reserved Seller',
      bankName: 'QA Bank No Real Transfer', accountNumber: 'QA-NO-TRANSFER-0001', accountNumberLast4: '0001',
      country: 'Pakistan', countryCode: 'PK', currency: 'PKR', isActive: true });
    const withdrawal = { statusCode: 200, body: null };
    const res = { status: code => { withdrawal.statusCode = code; return res; },
      json: body => { withdrawal.body = body; return res; } };
    await createWithdrawalRequest({ user: { id: String(seller._id), role: 'seller', currency: 'PKR' },
      body: { requestedAmount: 2000, requestedCurrency: 'PKR' }, get: () => 'cod-withdrawal-reserved-first' }, res);
    expect(withdrawal.statusCode).toBe(201);
    await expect(settleFromSellerBalance({ returnRequestId: returned._id, sellerId: seller._id }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_SELLER_BALANCE', availableBalance: 784, currency: 'PKR' });
    const after = await buildSellerPaymentSummary(seller._id, { displayCurrency: 'PKR' });
    expect(after.balanceByCurrency.PKR).toMatchObject({ withdrawableBalance: 784, deficit: 0,
      totalReservedOrWithdrawn: 2000, pendingWithdrawalAmount: 2000, returnRefundDebits: 0, processingFeeAndTax: 216 });
    expect(await WalletTransaction.countDocuments({ referenceId: String(returned._id) })).toBe(0);
    expect(await SellerBalanceTransaction.countDocuments({ referenceId: String(returned._id) })).toBe(0);
    expect((await ReturnRequest.findById(returned._id)).status).toBe('under_review');
    expect(await Withdrawal.countDocuments({ seller: seller._id, status: 'pending' })).toBe(1);
  } finally {
    if (previousEncryptionKey === undefined) delete process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY;
    else process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = previousEncryptionKey;
  }
});
