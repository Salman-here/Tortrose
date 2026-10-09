'use strict';

// Read-only reconciliation for exactly the two authorised disposable QA sellers.
// Run from the primary Backend directory to use that directory's .env.
// No controller, payout decryption, mutation, index creation or provider API is used.
const dns = require('node:dns');
const mongoose = require('mongoose');
require('dotenv').config({ quiet: true });
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

const APPROVED_SELLERS = Object.freeze([
  'rozare.seller.82904@mailinator.com',
  'rozare-safepay-seller-20260925@mailinator.com',
]);
const ACTIVE_RESERVATIONS = new Set(['pending', 'approved', 'processing', 'manual_review']);
const SUPPORTED_CURRENCIES = new Set(['USD', 'PKR', 'EUR', 'GBP']);
const id = value => String(value?._id || value || '');
const fail = code => Object.assign(new Error(code), { code });

const MONEY_FIELDS = Object.freeze([
  'stripeDeliveredRevenue', 'stripePendingRevenue', 'safepayDeliveredRevenue', 'safepayPendingRevenue',
  'walletDeliveredRevenue', 'walletPendingRevenue', 'codDeliveredRevenue', 'codPendingRevenue',
  'onlineDeliveredRevenue', 'onlinePendingRevenue', 'totalDeliveredRevenue', 'estimatedRevenue',
  'onlineGrossEarnings', 'processingFeeAndTax', 'onlineFeeDeductions', 'pendingOnlineFeeDeductions',
  'returnWindowHeldAmount', 'pendingOnlineBalance', 'pendingOnlineNetBalance',
  'pendingWithdrawalAmount', 'approvedWithdrawalAmount', 'processingWithdrawalAmount',
  'manualReviewWithdrawalAmount', 'totalWithdrawn', 'returnRefundDebits', 'paymentReversalDebits',
  'balanceAdjustmentCredits', 'totalReservedOrWithdrawn', 'paymentRiskHeldAmount', 'deficit',
  'withdrawableBalance', 'minimumWithdrawal',
]);
const COMPACT_MONEY_FIELDS = Object.freeze([
  'onlineDeliveredRevenue', 'onlinePendingRevenue', 'codDeliveredRevenue', 'codPendingRevenue',
  'totalDeliveredRevenue', 'onlineGrossEarnings', 'processingFeeAndTax', 'onlineFeeDeductions',
  'pendingOnlineFeeDeductions', 'returnWindowHeldAmount', 'pendingOnlineBalance', 'pendingOnlineNetBalance',
  'pendingWithdrawalAmount', 'approvedWithdrawalAmount', 'processingWithdrawalAmount',
  'manualReviewWithdrawalAmount', 'totalWithdrawn', 'returnRefundDebits', 'paymentReversalDebits',
  'balanceAdjustmentCredits', 'totalReservedOrWithdrawn', 'paymentRiskHeldAmount', 'deficit',
  'withdrawableBalance', 'minimumWithdrawal',
]);

function parseArguments(args) {
  const options = { summary: false, notifications: false, requestId: null, sellerEmail: null, help: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--summary') options.summary = true;
    else if (argument === '--notifications') options.notifications = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--request') {
      const value = args[++index];
      if (options.requestId || typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) {
        throw fail('QA_WITHDRAWAL_ID_REQUIRED');
      }
      options.requestId = value.toLowerCase();
    } else if (argument === '--seller') {
      const value = args[++index];
      if (options.sellerEmail || !APPROVED_SELLERS.includes(value)) throw fail('QA_SELLER_SCOPE_REQUIRED');
      options.sellerEmail = value;
    } else throw fail('QA_AUDIT_ARGUMENT_INVALID');
  }
  return options;
}

function moneySummary(balance, compact) {
  const fields = compact ? COMPACT_MONEY_FIELDS : MONEY_FIELDS;
  return Object.fromEntries([
    ['currency', balance.currency],
    ...fields.filter(field => balance[field] !== undefined).map(field => [field, balance[field]]),
  ]);
}

// Even malformed stored suffixes must not become an accidental bank-detail dump.
function maskedLastFour(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9]{4}$/.test(value)) return null;
  return `**** ${value.toUpperCase()}`;
}

function withdrawalEvidence(row) {
  return {
    id: id(row), status: row.status, currency: row.currency, balanceVersion: row.balanceVersion,
    balanceAmount: row.amount,
    reservedAmount: ACTIVE_RESERVATIONS.has(row.status) ? row.amount : 0,
    withdrawnAmount: row.status === 'paid' ? row.amount : 0,
    requestedAmount: row.requestedAmount, requestedCurrency: row.requestedCurrency,
    payoutAmount: row.payoutAmount, payoutCurrency: row.payoutCurrency,
    minimumAmount: row.minimumAmount,
    payoutWorkflowVersion: row.payoutWorkflowVersion,
    activePayoutAttemptId: row.activePayoutAttemptId || null,
    paidPayoutAttemptId: row.paidPayoutAttemptId || null,
    attempts: (row.payoutAttempts || []).map(attempt => ({
      attemptId: attempt.attemptId, sequence: attempt.sequence, status: attempt.status,
    })),
    opsCount: row.opsCount,
    snapshot: {
      version: row.paymentAccountSnapshotVersion,
      accountNumberLast4: maskedLastFour(row.paymentAccountSnapshot?.accountNumberLast4),
      ibanLast4: maskedLastFour(row.paymentAccountSnapshot?.ibanLast4),
    },
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

async function auditSeller(seller, options) {
  const Product = require('../models/Product');
  const Order = require('../models/Order');
  const Store = require('../models/Store');
  const ReturnRequest = require('../models/ReturnRequest');
  const Withdrawal = require('../models/SellerWithdrawalRequest');
  const BalanceTransaction = require('../models/SellerBalanceTransaction');
  const RiskHold = require('../models/SellerPaymentRiskHold');
  const { computeNativeSellerAccounting, nativeSellerEntitlement } = require('../services/sellerNativeAccountingService');
  const { isSellerRevenueRecognized, sumCurrencyAmountsInCurrency } = require('../services/orderMoneyService');

  const products = await Product.find({ seller: seller._id }).select('_id').lean();
  const productIds = products.map(product => product._id);
  const productIdSet = new Set(productIds.map(id));
  const orderScope = { $or: [
    { 'orderItems.seller': seller._id }, { 'sellerSettlement.seller': seller._id },
    ...(productIds.length ? [{ orderItems: { $elemMatch: { seller: null, productId: { $in: productIds } } } }] : []),
  ] };
  const [store, orders, withdrawals, transactions, pendingRiskHolds, returns] = await Promise.all([
    Store.findOne({ seller: seller._id }).select('productCurrency').lean(),
    Order.find(orderScope).select('_id currency displayCurrency orderCurrency exchangeRateSnapshot '
      + 'orderItems sellerSettlementVersion sellerSettlement sellerCurrencyMoneyVersion sellerCurrencyMoney '
      + 'checkoutRoundingSnapshot sellerPolicies sellerShipping shippingMethod orderSummary appliedCoupons sellerFulfillment deliveredAt '
      + 'orderStatus awaitingPayment isPaid paymentMethod isDelivered onlineFeeSnapshot createdAt').sort({ createdAt: -1 }).lean(),
    Withdrawal.aggregate([
      { $match: { seller: seller._id } },
      { $project: {
        _id: 1, status: 1, currency: 1, balanceVersion: 1, amount: 1, minimumAmount: 1,
        requestedAmount: 1, requestedCurrency: 1, payoutAmount: 1, payoutCurrency: 1,
        payoutWorkflowVersion: 1, activePayoutAttemptId: 1, paidPayoutAttemptId: 1,
        'payoutAttempts.attemptId': 1, 'payoutAttempts.sequence': 1, 'payoutAttempts.status': 1,
        paymentAccountSnapshotVersion: 1, 'paymentAccountSnapshot.accountNumberLast4': 1,
        'paymentAccountSnapshot.ibanLast4': 1, createdAt: 1, updatedAt: 1,
        opsCount: { $size: { $ifNull: ['$adminOperations', []] } },
      } },
      { $sort: { createdAt: -1, _id: -1 } },
    ]),
    BalanceTransaction.find({ seller: seller._id }).select('_id order type direction status amountUSD sourceAmount '
      + 'sourceCurrency referenceType referenceId metadata.riskTrackKey').lean(),
    RiskHold.find({ seller: seller._id, status: 'pending' }).select('_id').lean(),
    ReturnRequest.find({ seller: seller._id }).select('_id order seller status items refund.totalAmount').lean(),
  ]);
  const returnLineage = new Map(returns.map(row => [id(row), row.order]));
  transactions.forEach(row => {
    if (!row.order && row.referenceType === 'return_request') row.order = returnLineage.get(row.referenceId);
  });
  const reportingCurrency = store?.productCurrency || seller.currency;
  if (!SUPPORTED_CURRENCIES.has(reportingCurrency)) throw fail('QA_REPORTING_CURRENCY_INVALID');
  const native = computeNativeSellerAccounting({ sellerId: seller._id, orders, productIds: productIdSet,
    transactions, withdrawals, pendingRiskHolds, returns, reportingCurrency });

  // Independent all-time gross analytics use the existing pure recognition and
  // historical sum helpers. No withdrawal/return ledger or live FX is consulted.
  const grossEntries = orders.filter(order => isSellerRevenueRecognized(order, seller._id)).map(order => {
    const money = nativeSellerEntitlement(order, seller._id, productIdSet);
    if (!money) throw fail('QA_GROSS_ANALYTICS_ENTITLEMENT_MISSING');
    return { order, amount: money.summary.totalAmount, currency: money.currency };
  });
  const grossByCurrency = {};
  for (const currency of SUPPORTED_CURRENCIES) {
    grossByCurrency[currency] = await sumCurrencyAmountsInCurrency(
      grossEntries.filter(row => row.currency === currency), currency);
  }
  const visibleWithdrawals = options.requestId
    ? withdrawals.filter(row => id(row) === options.requestId) : withdrawals;
  const notificationEvidence = options.notifications && visibleWithdrawals.length
    ? await require('../models/NotificationOutbox').find({
      aggregateType: 'SellerWithdrawalRequest',
      aggregateId: { $in: visibleWithdrawals.map(id) },
      'recipient.user': seller._id,
    }).select('aggregateId eventType channel status attempts lastErrorCode occurredAt deliveredAt skippedAt '
      + 'payload.title payload.subject payload.data.status').sort({ occurredAt: 1, channel: 1 }).lean()
    : [];
  return {
    email: seller.email, sellerId: id(seller), reportingCurrency,
    paymentRiskPending: native.paymentRiskPending, legacyWithdrawalHold: native.legacyWithdrawalHold,
    nativeRevenue: moneySummary(native.revenue, options.summary),
    displayRevenue: moneySummary(native.displayRevenue, options.summary),
    balances: native.balances.map(balance => moneySummary(balance, options.summary)),
    accountingScopes: {
      nativeRevenue: 'Selected original-currency bucket; other original currencies remain in balances.',
      displayRevenue: 'Sales fields use saved checkout rates across native buckets; balance and reservation fields retain the selected native bucket.',
      grossAnalytics: 'All-time gross recognized sales, including paid online orders before delivery.',
      helperExcludesLegacyOrders: false,
      selectedNativeRelevantOrderCount: native.balanceByCurrency[reportingCurrency].totalRelevantOrders,
      otherNativeRelevantOrderCount: native.revenue.totalRelevantOrders
        - native.balanceByCurrency[reportingCurrency].totalRelevantOrders,
      relevantOrderCountsByNativeCurrency: Object.fromEntries(native.balances.map(balance => [balance.currency, {
        totalRelevantOrders: balance.totalRelevantOrders,
        deliveredCodOrders: balance.deliveredCodOrders,
        pendingCodOrders: balance.pendingCodOrders,
      }])),
    },
    grossAnalytics: {
      period: 'all_time', recognizedOrderCount: grossEntries.length,
      currency: reportingCurrency,
      recognizedGrossRevenue: await sumCurrencyAmountsInCurrency(grossEntries, reportingCurrency),
      recognizedGrossRevenueByCurrency: grossByCurrency,
    },
    withdrawals: visibleWithdrawals.map(withdrawalEvidence),
    ...(options.notifications ? { notifications: notificationEvidence.map(row => ({
      withdrawalId: row.aggregateId, eventType: row.eventType, channel: row.channel,
      deliveryStatus: row.status, attempts: row.attempts, errorCode: row.lastErrorCode || null,
      title: row.payload?.title || row.payload?.subject || null,
      withdrawalStatus: row.payload?.data?.status || null,
      occurredAt: row.occurredAt, deliveredAt: row.deliveredAt, skippedAt: row.skippedAt,
    })) } : {}),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node auditQaWithdrawals.js [--summary] [--notifications] [--seller <approved QA email>] [--request <withdrawal ObjectId>]');
    return;
  }
  if (!process.env.MONGO_URI) throw fail('QA_DATABASE_NOT_CONFIGURED');
  dns.setServers(['1.1.1.1', '8.8.8.8']);
  await mongoose.connect(process.env.MONGO_URI, {
    autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000,
  });
  const emails = options.sellerEmail ? [options.sellerEmail] : APPROVED_SELLERS;
  const User = require('../models/User');
  const sellers = await User.find({ email: { $in: emails }, role: 'seller' }).select('_id email currency').lean();
  if (sellers.length !== emails.length) throw fail('QA_SELLER_NOT_FOUND');
  const results = [];
  for (const email of emails) results.push(await auditSeller(sellers.find(seller => seller.email === email), options));
  if (options.requestId && !results.some(row => row.withdrawals.length)) throw fail('QA_WITHDRAWAL_NOT_IN_APPROVED_SCOPE');
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), readOnly: true, sellers: results }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.code)
      ? error.code : 'QA_WITHDRAWAL_AUDIT_FAILED';
    console.error(JSON.stringify({ error: code }));
    process.exitCode = 1;
  }).finally(() => mongoose.disconnect());
}

module.exports = { parseArguments, withdrawalEvidence, moneySummary };
