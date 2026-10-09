'use strict';

const Order = require('../models/Order');
const Product = require('../models/Product');
const ReturnRequest = require('../models/ReturnRequest');
const SellerWithdrawalRequest = require('../models/SellerWithdrawalRequest');
const SellerBalanceTransaction = require('../models/SellerBalanceTransaction');
const SellerPaymentRiskHold = require('../models/SellerPaymentRiskHold');
const SellerPaymentAccount = require('../models/SellerPaymentAccount');
const { CURRENCIES, isSupportedCurrency, convertAmountWithRates } = require('./currencyService');
const { toMinorUnits, fromMinorUnits, convertMoneyByRates } = require('./moneyMath');
const { sellerCurrencyMoneyPresentation, getOrderExchangeRates, buildOrderSellerSettlement } = require('./orderMoneyService');

const { WITHDRAWAL_MINIMUMS } = require('./sellerWithdrawalPolicy');
const { sellerReturnHold } = require('./sellerReturnHoldService');
const { sellerOnlineFee, proportionalMinor } = require('./onlineOrderFeeService');
const ACTIVE_WITHDRAWAL_STATUSES = new Set(['pending', 'approved', 'processing', 'manual_review']);
const ALL_WITHDRAWAL_STATUSES = new Set([...ACTIVE_WITHDRAWAL_STATUSES, 'paid', 'failed', 'rejected', 'cancelled']);
const sellerOrderScope = (sellerId, productIds) => ({ $or: [
  { 'orderItems.seller': sellerId }, { 'sellerSettlement.seller': sellerId },
  ...(productIds.length ? [{ orderItems: { $elemMatch: { seller: null, productId: { $in: productIds } } } }] : []),
] });
const id = value => String(value?._id || value || '');
const fault = message => Object.assign(new Error(message), { statusCode: 409, code: 'SELLER_NATIVE_ACCOUNTING_INVALID' });
const minor = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw fault(`Invalid stored ${label}.`);
  const result = toMinorUnits(value);
  if (fromMinorUnits(result) !== value) throw fault(`Inexact stored ${label}.`);
  return result;
};
const add = (a, b) => {
  const n = a + b;
  if (!Number.isSafeInteger(n)) throw fault('Seller money exceeds the supported range.');
  return n;
};
const nativeFields = ['stripeDeliveredRevenue', 'stripePendingRevenue', 'walletDeliveredRevenue', 'walletPendingRevenue',
  'safepayDeliveredRevenue', 'safepayPendingRevenue',
  'codDeliveredRevenue', 'codPendingRevenue', 'returnWindowHeldAmount', 'pendingWithdrawalAmount', 'approvedWithdrawalAmount',
  'processingWithdrawalAmount', 'manualReviewWithdrawalAmount', 'totalWithdrawn', 'returnRefundDebits', 'paymentReversalDebits', 'balanceAdjustmentCredits',
  'onlineFeeDeductions', 'pendingOnlineFeeDeductions'];
const empty = currency => Object.fromEntries([['currency', currency], ...nativeFields.map(field => [field, 0])]);

function nativeSellerEntitlement(order, sellerId, productIds = new Set()) {
  const items = (order.orderItems || []).filter(item => item.seller ? id(item.seller) === id(sellerId) : productIds.has(id(item.productId)));
  if (!items.length) return null;
  let money = sellerCurrencyMoneyPresentation(order, sellerId, items);
  if (!money && !order.sellerSettlementVersion) {
    const historic = { ...order, sellerSettlementVersion: 1, sellerSettlement: buildOrderSellerSettlement(order, { requireOrderTotal: true }) };
    money = sellerCurrencyMoneyPresentation(historic, sellerId, items);
  }
  if (!money) throw fault('An order has no verifiable frozen seller money. Original orders must not be revalued using current prices.');
  return money;
}

// Cumulative buyer-currency refund/reversal liability -> original seller money.
// Full refund cancels the exact native credit; partial refund cents cannot drift
// by repeatedly converting independent refund amounts through USD.
function nativeLiabilityMinor(sourceMinor, buyerEntitlementMinor, nativeEntitlementMinor) {
  if (![sourceMinor, buyerEntitlementMinor, nativeEntitlementMinor].every(Number.isSafeInteger)
      || sourceMinor < 0 || buyerEntitlementMinor < 0 || nativeEntitlementMinor < 0 || sourceMinor > buyerEntitlementMinor) {
    throw fault('Refund or reversal exceeds the original seller entitlement.');
  }
  if (!sourceMinor || !nativeEntitlementMinor) return 0;
  if (sourceMinor === buyerEntitlementMinor) return nativeEntitlementMinor;
  return toMinorUnits(convertMoneyByRates(fromMinorUnits(sourceMinor), fromMinorUnits(buyerEntitlementMinor), fromMinorUnits(nativeEntitlementMinor)));
}

// COD collection belongs to the seller, including the buyer rounding remainder.
// Funding a Wallet return therefore costs the ACTUAL collected buyer amount,
// converted directly at the frozen checkout rate. Online returns instead
// reverse the original native credit; the platform's remainder is not earnings.
function nativeReturnFundingMinor(order, sourceMinor, buyerEntitlementMinor, nativeEntitlementMinor, nativeCurrency) {
  const original = nativeLiabilityMinor(sourceMinor, buyerEntitlementMinor, nativeEntitlementMinor);
  if (order.paymentMethod !== 'cash_on_delivery' || order.sellerCurrencyMoneyVersion !== 2) return original;
  const rates = getOrderExchangeRates(order);
  if (!rates || !isSupportedCurrency(nativeCurrency) || !isSupportedCurrency(order.currency)) {
    throw fault('COD return funding requires the original currency and exchange rates.');
  }
  return toMinorUnits(convertMoneyByRates(fromMinorUnits(sourceMinor), rates[order.currency], rates[nativeCurrency]));
}

function computeNativeSellerAccounting({ sellerId, orders, productIds = new Set(), transactions = [], withdrawals = [], pendingRiskHolds = [], returns = [], reportingCurrency = 'USD', at = new Date() }) {
  if (!isSupportedCurrency(reportingCurrency)) throw fault('Unsupported reporting currency.');
  const buckets = Object.fromEntries(Object.keys(CURRENCIES).map(currency => [currency, empty(currency)]));
  const report = empty(reportingCurrency);
  const entitlements = new Map();
  const deliveredOnline = [];
  const recentOrders = { stripe: [], safepay: [], wallet: [], cod: [] };
  const counts = { deliveredStripeOrders: 0, pendingStripeOrders: 0, deliveredSafepayOrders: 0, pendingSafepayOrders: 0, deliveredWalletOrders: 0, pendingWalletOrders: 0, deliveredCodOrders: 0, pendingCodOrders: 0, totalRelevantOrders: 0 };
  const countsByCurrency = Object.fromEntries(Object.keys(CURRENCIES).map(currency => [currency, { ...counts }]));
  const reportAmount = (order, valueMinor, source) => {
    if (source === reportingCurrency || !valueMinor) return valueMinor;
    const rates = getOrderExchangeRates(order);
    if (!rates) throw fault('Historical reporting requires the original order exchange-rate table.');
    return toMinorUnits(convertAmountWithRates(fromMinorUnits(valueMinor), source, reportingCurrency, rates));
  };
  for (const order of orders) {
    if (order.paymentMethod === 'stripe' && process.env.STRIPE_ENABLED !== 'true') continue;
    if (order.awaitingPayment === true) continue;
    const money = nativeSellerEntitlement(order, sellerId, productIds);
    if (!money) continue;
    const currency = money.currency;
    if (!buckets[currency]) throw fault('Unsupported frozen seller currency.');
    const total = minor(money.summary.totalAmount, 'seller entitlement');
    const buyerTotal = minor(money.buyerSummary.totalAmount, 'buyer allocation');
    entitlements.set(id(order), { order, currency, total, buyerTotal, buyerCurrency: money.buyerCurrency });
    const fulfillment = (order.sellerFulfillment || []).find(item => id(item.seller) === id(sellerId));
    const status = fulfillment?.status || order.orderStatus;
    if (order.awaitingPayment || status === 'cancelled' || order.orderStatus === 'cancelled') continue;
    const method = order.paymentMethod === 'cash_on_delivery' ? 'cod' : order.paymentMethod;
    if (!['stripe', 'wallet', 'safepay', 'cod'].includes(method)) throw fault('Unsupported stored order payment method.');
    if (method !== 'cod' && order.isPaid !== true) continue;
    const delivered = fulfillment ? status === 'delivered' : status === 'delivered' || order.isDelivered === true;
    const fee = ['wallet', 'safepay'].includes(method) ? sellerOnlineFee(order, sellerId) : null;
    if (fee && (fee.currency !== currency || fee.grossMinor !== total || fee.buyerGrossMinor !== buyerTotal)) throw fault('Online deduction and seller entitlement disagree.');
    if (delivered && ['wallet', 'safepay'].includes(method)) deliveredOnline.push({ order, currency, total, buyerTotal, feeMinor: fee?.feeMinor || 0 });
    if (!delivered && fee) {
      buckets[currency].pendingOnlineFeeDeductions = add(buckets[currency].pendingOnlineFeeDeductions, fee.feeMinor);
    }
    const field = method + (delivered ? 'DeliveredRevenue' : 'PendingRevenue');
    buckets[currency][field] = add(buckets[currency][field], total);
    report[field] = add(report[field], reportAmount(order, total, currency));
    counts[(delivered ? 'delivered' : 'pending') + (method === 'cod' ? 'Cod' : method === 'stripe' ? 'Stripe' : method === 'safepay' ? 'Safepay' : 'Wallet') + 'Orders']++;
    counts.totalRelevantOrders++;
    const countField = (delivered ? 'delivered' : 'pending') + (method === 'cod' ? 'Cod' : method === 'stripe' ? 'Stripe' : method === 'safepay' ? 'Safepay' : 'Wallet') + 'Orders';
    countsByCurrency[currency][countField]++;
    countsByCurrency[currency].totalRelevantOrders++;
    if (recentOrders[method].length < 5) recentOrders[method].push({ _id: order._id, orderId: order.orderId,
      status, amount: fromMinorUnits(total), amountCurrency: currency, sourceAmount: fromMinorUnits(buyerTotal),
      sourceCurrency: money.buyerCurrency, delivered, createdAt: order.createdAt,
      ...(fee ? { processingFeeAndTax: fromMinorUnits(fee.feeMinor), netAmount: fromMinorUnits(total - fee.feeMinor) } : {}) });
  }
  // Aggregate signed source liabilities by order before computing native cents.
  const liabilities = new Map();
  for (const row of transactions) {
    if (row.order && orders.some(order => id(order) === id(row.order) && order.paymentMethod === 'stripe' && process.env.STRIPE_ENABLED !== 'true')) continue;
    if (!['reserved', 'completed', 'reversed'].includes(row.status) || !['debit', 'credit'].includes(row.direction)) throw fault('Invalid seller balance transaction state.');
    minor(row.amountUSD, 'reference USD amount');
    const sourceAmount = minor(row.sourceAmount, 'transaction source amount');
    if (!isSupportedCurrency(row.sourceCurrency)) throw fault('Invalid transaction currency.');
    if (row.status === 'reversed') continue;
    const sign = row.direction === 'debit' ? 1 : -1;
    if (row.referenceType === 'admin' && !row.order) {
      const b = buckets[row.sourceCurrency];
      const field = sign > 0 ? 'paymentReversalDebits' : 'balanceAdjustmentCredits';
      b[field] = add(b[field], sourceAmount);
      continue;
    }
    const entitlement = entitlements.get(id(row.order));
    if (!entitlement || row.sourceCurrency !== entitlement.buyerCurrency) throw fault('A balance debit cannot be linked to its original order currency.');
    // Refunds and distinct disputes are separate provider liabilities. A
    // refund plus a full-charge dispute may legitimately exceed one sale.
    // Never cap their combined exposure or release one track with another.
    const kind = row.type === 'return_refund' ? 'returnRefundDebits' : 'paymentReversalDebits';
    const track = row.type === 'return_refund' ? 'return-refunds' : row.metadata?.riskTrackKey || 'reversals';
    const key = id(row.order) + ':' + track;
    const group = liabilities.get(key) || { entitlement, source: 0, kind };
    group.source = add(group.source, sign * sourceAmount);
    liabilities.set(key, group);
  }
  for (const { entitlement: e, source, kind } of liabilities.values()) {
    if (source < 0) throw fault('A credit exceeds the original native liability.');
    const native = kind === 'returnRefundDebits'
      ? nativeReturnFundingMinor(e.order, source, e.buyerTotal, e.total, e.currency)
      : nativeLiabilityMinor(source, e.buyerTotal, e.total);
    buckets[e.currency][kind] = add(buckets[e.currency][kind], native);
  }
  for (const e of deliveredOnline) {
    const refunded = [...liabilities.values()].filter(row => id(row.entitlement.order) === id(e.order))
      .reduce((sum, row) => add(sum, nativeLiabilityMinor(row.source, e.buyerTotal, e.total)), 0);
    const hold = sellerReturnHold(e.order, sellerId, { returns, at, remainingMinor: Math.max(0, e.total - refunded) });
    buckets[e.currency].returnWindowHeldAmount = add(buckets[e.currency].returnWindowHeldAmount, hold.heldMinor);
    report.returnWindowHeldAmount = add(report.returnWindowHeldAmount, reportAmount(e.order, hold.heldMinor, e.currency));
    // Refunded revenue reverses its proportional deduction. Return holds keep
    // the corresponding NET earnings pending; neither fee nor funds release
    // while a timely return is unresolved. Withdrawals never recompute a fee.
    const remaining = Math.max(0, e.total - refunded);
    const releasedFee = proportionalMinor(e.feeMinor, remaining - hold.heldMinor, e.total);
    const remainingFee = proportionalMinor(e.feeMinor, remaining, e.total);
    buckets[e.currency].onlineFeeDeductions = add(buckets[e.currency].onlineFeeDeductions, releasedFee);
    buckets[e.currency].pendingOnlineFeeDeductions = add(buckets[e.currency].pendingOnlineFeeDeductions, remainingFee - releasedFee);
  }
  let legacyWithdrawalHold = false;
  for (const request of withdrawals) {
    if (!ALL_WITHDRAWAL_STATUSES.has(request.status)) throw fault('Invalid withdrawal status.');
    if (!isSupportedCurrency(request.currency)) throw fault('Invalid withdrawal currency.');
    const value = minor(request.amount, 'withdrawal amount');
    if (![0, 2].includes(request.balanceVersion ?? 0)) throw fault('Unknown withdrawal accounting version.');
    if (request.balanceVersion !== 2) {
      // Never reassign a previously signed USD-based request to a guessed
      // native bucket. Retain its signed terms and quarantine new payouts.
      if (ACTIVE_WITHDRAWAL_STATUSES.has(request.status) || request.status === 'paid') legacyWithdrawalHold = true;
      continue;
    }
    if (request.currency !== request.requestedCurrency || request.currency !== request.payoutCurrency
        || value !== minor(request.requestedAmount, 'requested amount') || value !== minor(request.payoutAmount, 'payout amount')) throw fault('Native withdrawal currencies or amounts conflict.');
    const field = request.status === 'paid' ? 'totalWithdrawn' : ACTIVE_WITHDRAWAL_STATUSES.has(request.status) ? ({ pending: 'pendingWithdrawalAmount', approved: 'approvedWithdrawalAmount', processing: 'processingWithdrawalAmount', manual_review: 'manualReviewWithdrawalAmount' })[request.status] : null;
    if (field) buckets[request.currency][field] = add(buckets[request.currency][field], value);
  }
  const held = pendingRiskHolds.length > 0 || legacyWithdrawalHold;
  const finish = b => {
    b.onlineDeliveredRevenue = add(add(b.stripeDeliveredRevenue, b.safepayDeliveredRevenue), b.walletDeliveredRevenue);
    b.onlinePendingRevenue = add(add(b.stripePendingRevenue, b.safepayPendingRevenue), b.walletPendingRevenue);
    b.totalDeliveredRevenue = add(b.onlineDeliveredRevenue, b.codDeliveredRevenue);
    b.estimatedRevenue = add(add(b.totalDeliveredRevenue, b.onlinePendingRevenue), b.codPendingRevenue);
    b.totalReservedOrWithdrawn = ['pendingWithdrawalAmount', 'approvedWithdrawalAmount', 'processingWithdrawalAmount', 'manualReviewWithdrawalAmount', 'totalWithdrawn', 'returnRefundDebits', 'paymentReversalDebits'].reduce((sum, field) => add(sum, b[field]), 0);
    const beforeFees = add(add(add(b.onlineDeliveredRevenue, b.balanceAdjustmentCredits), -b.totalReservedOrWithdrawn), -b.returnWindowHeldAmount);
    const net = add(beforeFees, -b.onlineFeeDeductions);
    b.pendingOnlineBalance = add(b.onlinePendingRevenue, b.returnWindowHeldAmount);
    b.pendingOnlineNetBalance = add(b.pendingOnlineBalance, -b.pendingOnlineFeeDeductions);
    b.onlineGrossEarnings = Math.max(0, add(add(add(b.onlineDeliveredRevenue, b.onlinePendingRevenue), -b.returnRefundDebits), -b.paymentReversalDebits));
    b.processingFeeAndTax = add(b.onlineFeeDeductions, b.pendingOnlineFeeDeductions);
    b.deficit = Math.max(0, -net);
    b.paymentRiskHeldAmount = held ? Math.max(0, net) : 0;
    b.withdrawableBalance = held ? 0 : Math.max(0, net);
    return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, k === 'currency' ? v : fromMinorUnits(v)]));
  };
  const balances = Object.values(buckets).map(finish).map(b => ({ ...b, ...countsByCurrency[b.currency], minimumWithdrawal: WITHDRAWAL_MINIMUMS[b.currency] }));
  // Sales metrics are historical equivalents. Balance/reservation fields are
  // the selected native bucket only and must never be converted reporting totals.
  const selected = balances.find(b => b.currency === reportingCurrency);
  const reporting = finish(report);
  for (const field of ['withdrawableBalance', 'returnWindowHeldAmount', 'pendingOnlineBalance', 'pendingOnlineNetBalance', 'onlineGrossEarnings', 'processingFeeAndTax', 'onlineFeeDeductions', 'pendingOnlineFeeDeductions', 'paymentRiskHeldAmount', 'deficit', 'totalReservedOrWithdrawn', 'pendingWithdrawalAmount', 'approvedWithdrawalAmount', 'processingWithdrawalAmount', 'manualReviewWithdrawalAmount', 'totalWithdrawn', 'returnRefundDebits', 'paymentReversalDebits', 'balanceAdjustmentCredits']) reporting[field] = selected[field];
  return { sellerId: id(sellerId), accountingVersion: 2, baseCurrency: reportingCurrency, displayCurrency: reportingCurrency,
    balances, balanceByCurrency: Object.fromEntries(balances.map(b => [b.currency, b])),
    revenue: { ...selected, ...counts }, displayRevenue: { ...reporting, ...counts },
    paymentRiskPending: held, legacyWithdrawalHold,
    deductionPolicy: { version: 1, rateBps: 620, fixedCurrency: 'PKR', fixedMinor: 3000, appliesTo: ['safepay', 'wallet'] },
    exchangeRateStatus: { source: 'order-checkout-snapshots', fallback: false, frozen: true },
    withdrawalLimits: { currency: reportingCurrency, displayCurrency: reportingCurrency, baseCurrency: reportingCurrency,
      minimumAmount: selected.minimumWithdrawal, minimumDisplayAmount: selected.minimumWithdrawal,
      availableAmount: selected.withdrawableBalance, availableDisplayAmount: selected.withdrawableBalance },
    recentOrders };
}

async function buildNativeSellerPaymentSummary(sellerId, { session = null, displayCurrency = 'USD' } = {}) {
  const query = q => session ? q.session(session) : q;
  const products = await query(Product.find({ seller: sellerId }).select('_id')).lean();
  const [orders, withdrawals, transactions, pendingRiskHolds, paymentAccount, returns] = await Promise.all([
    query(Order.find(sellerOrderScope(sellerId, products.map(p => p._id))).sort({ createdAt: -1 })).lean(),
    query(SellerWithdrawalRequest.find({ seller: sellerId }).sort({ createdAt: -1 })).lean(),
    query(SellerBalanceTransaction.find({ seller: sellerId })).lean(),
    query(SellerPaymentRiskHold.find({ seller: sellerId, status: 'pending' })).lean(),
    query(SellerPaymentAccount.findOne({ seller: sellerId })).lean(),
    query(ReturnRequest.find({ seller: sellerId })).lean(),
  ]);
  const refs = transactions.filter(t => !t.order && t.referenceType === 'return_request').map(t => t.referenceId);
  if (refs.length) {
    const returns = await query(ReturnRequest.find({ _id: { $in: refs }, seller: sellerId }).select('_id order')).lean();
    const lineage = new Map(returns.map(r => [id(r), r.order]));
    transactions.forEach(t => { if (!t.order && t.referenceType === 'return_request') t.order = lineage.get(t.referenceId); });
  }
  return { ...computeNativeSellerAccounting({ sellerId, orders, withdrawals, transactions, pendingRiskHolds, returns,
    productIds: new Set(products.map(id)), reportingCurrency: displayCurrency }), paymentAccount, withdrawals };
}

module.exports = { WITHDRAWAL_MINIMUMS, computeNativeSellerAccounting, buildNativeSellerPaymentSummary,
  nativeSellerEntitlement, nativeLiabilityMinor, nativeReturnFundingMinor };
