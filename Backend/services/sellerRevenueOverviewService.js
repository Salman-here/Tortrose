'use strict';

const Order = require('../models/Order');
const Product = require('../models/Product');
const ReturnRequest = require('../models/ReturnRequest');
const SellerBalanceTransaction = require('../models/SellerBalanceTransaction');
const { isSupportedCurrency } = require('./currencyService');
const { buildNativeSellerPaymentSummary, computeNativeSellerAccounting } = require('./sellerNativeAccountingService');

const id = value => String(value?._id || value || '');
const invalid = message => Object.assign(new Error(message), { statusCode: 400, code: 'SELLER_REVENUE_PERIOD_INVALID' });
const validCurrency = value => typeof value === 'string' && value === value.trim().toUpperCase() && isSupportedCurrency(value);

function revenuePeriod(days = 'all', at = new Date()) {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw invalid('Invalid reporting time.');
  if (days === 'all') return { days: null, startDate: null, endDateExclusive: null, timezone: 'UTC', basis: 'order_created_at' };
  if (!/^[1-9]\d{0,2}$/.test(String(days)) || Number(days) > 365) throw invalid('Choose 1 to 365 whole days, or all time.');
  const end = new Date(at); end.setUTCHours(0, 0, 0, 0); end.setUTCDate(end.getUTCDate() + 1);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - Number(days));
  return { days: Number(days), startDate: start.toISOString(), endDateExclusive: end.toISOString(), timezone: 'UTC', basis: 'order_created_at' };
}

function presentRevenueOverview(summary, period) {
  const revenue = summary.displayRevenue;
  // This is the EXACT earned-currency metric previously shown in Payments,
  // not a converted sum of other currency balances and not a payout balance.
  const online = summary.balanceByCurrency[summary.displayCurrency].onlineGrossEarnings;
  return { version: 1, sellerId: summary.sellerId, currency: summary.displayCurrency,
    scope: period.days === null ? 'all_time' : 'period', period,
    exchangeRateStatus: summary.exchangeRateStatus, onlineEarningsBasis: 'native_balance_currency',
    onlineGrossEarnings: online, codDeliveredRevenue: revenue.codDeliveredRevenue,
    onlineDeliveredRevenue: revenue.onlineDeliveredRevenue, totalDeliveredRevenue: revenue.totalDeliveredRevenue,
    onlinePendingRevenue: revenue.onlinePendingRevenue, codPendingRevenue: revenue.codPendingRevenue,
    estimatedRevenue: revenue.estimatedRevenue };
}

function computeSellerPeriodRevenue({ sellerId, currency, days, at = new Date(), orders = [], transactions = [], returns = [], productIds = new Set() }) {
  if (!validCurrency(currency)) throw invalid('Choose a supported reporting currency.');
  const period = revenuePeriod(days, at);
  const start = period.startDate ? Date.parse(period.startDate) : -Infinity;
  const end = period.endDateExclusive ? Date.parse(period.endDateExclusive) : Infinity;
  const selected = orders.filter(order => {
    if (period.days === null) return true;
    if (order.createdAt === null || order.createdAt === undefined) throw invalid('An order has no valid placement date.');
    const created = new Date(order.createdAt).getTime();
    if (!Number.isFinite(created)) throw invalid('An order has no valid placement date.');
    return created >= start && created < end;
  });
  const selectedIds = new Set(selected.map(id));
  const lineage = new Map(returns.map(row => [id(row), row.order]));
  const relatedTransactions = transactions.flatMap(row => {
    const order = row.order || (row.referenceType === 'return_request' ? lineage.get(id(row.referenceId)) : null);
    if (!order && row.referenceType === 'return_request') {
      throw Object.assign(new Error('A refund cannot be linked to its original order. Revenue cannot be calculated safely.'),
        { statusCode: 409, code: 'SELLER_REVENUE_LIABILITY_INVALID' });
    }
    // Withdrawals, standalone adjustments and unrelated order liabilities do
    // not get assigned to the selected sales cohort. Never mutate ledger rows.
    return selectedIds.has(id(order)) ? [{ ...row, order }] : [];
  });
  const summary = computeNativeSellerAccounting({ sellerId, orders: selected, transactions: relatedTransactions,
    returns: returns.filter(row => selectedIds.has(id(row.order))), productIds, reportingCurrency: currency, at });
  return presentRevenueOverview(summary, period);
}

async function buildSellerRevenueOverview(sellerId, { currency = 'USD', days = 'all', at = new Date() } = {}) {
  if (!validCurrency(currency)) throw invalid('Choose a supported reporting currency.');
  const period = revenuePeriod(days, at);
  if (period.days === null) {
    return presentRevenueOverview(await buildNativeSellerPaymentSummary(sellerId, { displayCurrency: currency }), period);
  }
  const products = await Product.find({ seller: sellerId }).select('_id').lean();
  const productIds = products.map(row => row._id);
  const orders = await Order.find({ createdAt: { $gte: new Date(period.startDate), $lt: new Date(period.endDateExclusive) },
    $or: [{ 'orderItems.seller': sellerId }, { 'sellerSettlement.seller': sellerId },
      ...(productIds.length ? [{ orderItems: { $elemMatch: { seller: null, productId: { $in: productIds } } } }] : [])],
  }).sort({ createdAt: -1 }).lean();
  const orderIds = orders.map(row => row._id);
  const transactions = await SellerBalanceTransaction.find({ seller: sellerId,
    $or: [{ order: { $in: orderIds } }, { order: null, referenceType: 'return_request' }] }).lean();
  const legacyRefs = transactions.filter(row => !row.order && row.referenceType === 'return_request').map(row => row.referenceId);
  const returns = await ReturnRequest.find({ seller: sellerId,
    $or: [{ order: { $in: orderIds } }, ... (legacyRefs.length ? [{ _id: { $in: legacyRefs } }] : [])] }).lean();
  return computeSellerPeriodRevenue({ sellerId, currency, days, at, orders, transactions, returns,
    productIds: new Set(products.map(id)) });
}

module.exports = { revenuePeriod, computeSellerPeriodRevenue, buildSellerRevenueOverview };
