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
  'codDeliveredRevenue', 'codPendingRevenue', 'pendingWithdrawalAmount', 'approvedWithdrawalAmount',
  'processingWithdrawalAmount', 'manualReviewWithdrawalAmount', 'totalWithdrawn', 'returnRefundDebits', 'paymentReversalDebits', 'balanceAdjustmentCredits'];
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

function computeNativeSellerAccounting({ sellerId, orders, productIds = new Set(), transactions = [], withdrawals = [], pendingRiskHolds = [], reportingCurrency = 'USD' }) {
  if (!isSupportedCurrency(reportingCurrency)) throw fault('Unsupported reporting currency.');
  const buckets = Object.fromEntries(Object.keys(CURRENCIES).map(currency => [currency, empty(currency)]));
  const report = empty(reportingCurrency);
  const entitlements = new Map();
  const recentOrders = { stripe: [], wallet: [], cod: [] };
  const counts = { deliveredStripeOrders: 0, pendingStripeOrders: 0, deliveredWalletOrders: 0, pendingWalletOrders: 0, deliveredCodOrders: 0, pendingCodOrders: 0, totalRelevantOrders: 0 };
  const countsByCurrency = Object.fromEntries(Object.keys(CURRENCIES).map(currency => [currency, { ...counts }]));
  const reportAmount = (order, valueMinor, source) => {
    if (source === reportingCurrency || !valueMinor) return valueMinor;
    const rates = getOrderExchangeRates(order);
    if (!rates) throw fault('Historical reporting requires the original order exchange-rate table.');
    return toMinorUnits(convertAmountWithRates(fromMinorUnits(valueMinor), source, reportingCurrency, rates));
  };
  for (const order of orders) {
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
    if (!['stripe', 'wallet', 'cod'].includes(method)) throw fault('Unsupported stored order payment method.');
    if (method !== 'cod' && order.isPaid !== true) continue;
    const delivered = fulfillment ? status === 'delivered' : status === 'delivered' || order.isDelivered === true;
    const field = method + (delivered ? 'DeliveredRevenue' : 'PendingRevenue');
    buckets[currency][field] = add(buckets[currency][field], total);
    report[field] = add(report[field], reportAmount(order, total, currency));
    counts[(delivered ? 'delivered' : 'pending') + (method === 'cod' ? 'Cod' : method === 'stripe' ? 'Stripe' : 'Wallet') + 'Orders']++;
    counts.totalRelevantOrders++;
    const countField = (delivered ? 'delivered' : 'pending') + (method === 'cod' ? 'Cod' : method === 'stripe' ? 'Stripe' : 'Wallet') + 'Orders';
    countsByCurrency[currency][countField]++;
    countsByCurrency[currency].totalRelevantOrders++;
    if (recentOrders[method].length < 5) recentOrders[method].push({ _id: order._id, orderId: order.orderId,
      status, amount: fromMinorUnits(total), amountCurrency: currency, sourceAmount: fromMinorUnits(buyerTotal),
      sourceCurrency: money.buyerCurrency, delivered, createdAt: order.createdAt });
  }
  // Aggregate signed source liabilities by order before computing native cents.
  const liabilities = new Map();
  for (const row of transactions) {
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
    const native = nativeLiabilityMinor(source, e.buyerTotal, e.total);
    buckets[e.currency][kind] = add(buckets[e.currency][kind], native);
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
    b.onlineDeliveredRevenue = add(b.stripeDeliveredRevenue, b.walletDeliveredRevenue);
    b.onlinePendingRevenue = add(b.stripePendingRevenue, b.walletPendingRevenue);
    b.totalDeliveredRevenue = add(b.onlineDeliveredRevenue, b.codDeliveredRevenue);
    b.estimatedRevenue = add(add(b.totalDeliveredRevenue, b.onlinePendingRevenue), b.codPendingRevenue);
    b.totalReservedOrWithdrawn = ['pendingWithdrawalAmount', 'approvedWithdrawalAmount', 'processingWithdrawalAmount', 'manualReviewWithdrawalAmount', 'totalWithdrawn', 'returnRefundDebits', 'paymentReversalDebits'].reduce((sum, field) => add(sum, b[field]), 0);
    const net = add(add(b.onlineDeliveredRevenue, b.balanceAdjustmentCredits), -b.totalReservedOrWithdrawn);
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
  for (const field of ['withdrawableBalance', 'paymentRiskHeldAmount', 'deficit', 'totalReservedOrWithdrawn', 'pendingWithdrawalAmount', 'approvedWithdrawalAmount', 'processingWithdrawalAmount', 'manualReviewWithdrawalAmount', 'totalWithdrawn', 'returnRefundDebits', 'paymentReversalDebits', 'balanceAdjustmentCredits']) reporting[field] = selected[field];
  return { sellerId: id(sellerId), accountingVersion: 2, baseCurrency: reportingCurrency, displayCurrency: reportingCurrency,
    balances, balanceByCurrency: Object.fromEntries(balances.map(b => [b.currency, b])),
    revenue: { ...selected, ...counts }, displayRevenue: { ...reporting, ...counts },
    paymentRiskPending: held, legacyWithdrawalHold,
    exchangeRateStatus: { source: 'order-checkout-snapshots', fallback: false, frozen: true },
    withdrawalLimits: { currency: reportingCurrency, displayCurrency: reportingCurrency, baseCurrency: reportingCurrency,
      minimumAmount: selected.minimumWithdrawal, minimumDisplayAmount: selected.minimumWithdrawal,
      availableAmount: selected.withdrawableBalance, availableDisplayAmount: selected.withdrawableBalance },
    recentOrders };
}

async function buildNativeSellerPaymentSummary(sellerId, { session = null, displayCurrency = 'USD' } = {}) {
  const query = q => session ? q.session(session) : q;
  const products = await query(Product.find({ seller: sellerId }).select('_id')).lean();
  const [orders, withdrawals, transactions, pendingRiskHolds, paymentAccount] = await Promise.all([
    query(Order.find(sellerOrderScope(sellerId, products.map(p => p._id))).sort({ createdAt: -1 })).lean(),
    query(SellerWithdrawalRequest.find({ seller: sellerId }).sort({ createdAt: -1 })).lean(),
    query(SellerBalanceTransaction.find({ seller: sellerId })).lean(),
    query(SellerPaymentRiskHold.find({ seller: sellerId, status: 'pending' })).lean(),
    query(SellerPaymentAccount.findOne({ seller: sellerId })).lean(),
  ]);
  const refs = transactions.filter(t => !t.order && t.referenceType === 'return_request').map(t => t.referenceId);
  if (refs.length) {
    const returns = await query(ReturnRequest.find({ _id: { $in: refs }, seller: sellerId }).select('_id order')).lean();
    const lineage = new Map(returns.map(r => [id(r), r.order]));
    transactions.forEach(t => { if (!t.order && t.referenceType === 'return_request') t.order = lineage.get(t.referenceId); });
  }
  return { ...computeNativeSellerAccounting({ sellerId, orders, withdrawals, transactions, pendingRiskHolds,
    productIds: new Set(products.map(id)), reportingCurrency: displayCurrency }), paymentAccount, withdrawals };
}

module.exports = { WITHDRAWAL_MINIMUMS, computeNativeSellerAccounting, buildNativeSellerPaymentSummary,
  nativeSellerEntitlement, nativeLiabilityMinor };
