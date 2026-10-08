'use strict';
// Read-only evidence for the four authorised Sandbox journeys. No mutation,
// payment URL, secret, PAN, bank detail, selected-card ID or auth token output.
const mongoose = require('mongoose');
require('dotenv').config({ quiet: true });
const EMAILS = [
  'rozare-safepay-buyer-20260925@mailinator.com',
  'rozare-safepay-seller-20260925@mailinator.com',
  'rozare.seller.82904@mailinator.com',
  'rozare.seller.82901@mailinator.com',
];
const START = new Date('2026-10-08T09:00:00Z');
const summaryFields = ['currency', 'onlineGrossEarnings', 'processingFeeAndTax', 'pendingOnlineBalance',
  'pendingOnlineNetBalance', 'withdrawableBalance', 'safepayDeliveredRevenue', 'safepayPendingRevenue',
  'walletDeliveredRevenue', 'walletPendingRevenue', 'returnWindowHeldAmount', 'totalWithdrawn',
  'returnRefundDebits', 'paymentReversalDebits', 'totalDeliveredRevenue', 'estimatedRevenue', 'totalRelevantOrders'];
const moneySummary = row => Object.fromEntries(summaryFields.filter(k => row[k] !== undefined).map(k => [k, row[k]]));
async function main() {
  const config = require('../config/safepay').readSafepayConfig(process.env, { requireWebhook: true });
  if (config.environment !== 'sandbox') throw new Error('SANDBOX_REQUIRED');
  require('node:dns').setServers(['1.1.1.1', '8.8.8.8']);
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
  const User = require('../models/User');
  const Store = require('../models/Store');
  const Order = require('../models/Order');
  const Product = require('../models/Product');
  const Payment = require('../models/SafepayPayment');
  const actors = await User.find({ email: { $in: EMAILS } }).select('_id email role status').lean();
  if (actors.length !== EMAILS.length) throw new Error('QA_ACTORS_REQUIRED');
  const buyer = actors.find(a => a.email === EMAILS[0]);
  const buyerIds = actors.filter(a => [EMAILS[0], EMAILS[1]].includes(a.email)).map(a => a._id);
  const sellers = actors.filter(a => a.role === 'seller');
  const sellerIds = new Set(sellers.map(a => String(a._id)));
  const balances = [];
  for (const seller of sellers) {
    const store = await Store.findOne({ seller: seller._id }).select('_id storeName storeSlug productCurrency isActive subdomainPurchase.isPurchased subdomainPurchase.purchasedAt subdomainPurchase.expiresAt subdomainPurchase.paymentRiskState').lean();
    let accounting;
    try {
      const summary = await require('../services/sellerNativeAccountingService').buildNativeSellerPaymentSummary(seller._id, { displayCurrency: store.productCurrency });
      accounting = { balances: summary.balances.filter(row => row.currency === store.productCurrency || row.onlineGrossEarnings || row.withdrawableBalance).map(moneySummary),
        revenue: moneySummary(summary.revenue), displayRevenue: moneySummary(summary.displayRevenue),
        paymentRiskPending: summary.paymentRiskPending, historicalSnapshot: summary.exchangeRateStatus };
    } catch (error) { accounting = { error: error.code || 'ACCOUNTING_READ_FAILED' }; }
    const grants = await require('../models/SafepaySubdomainGrant').find({ seller: seller._id, environment: 'sandbox' })
      .select('_id payment resourceKey capturedMinor refundedMinor grantStart grantEnd effectiveGrantEnd riskSuspended').lean();
    balances.push({ sellerId: seller._id, account: seller.email, store, accounting, grants });
  }
  const orders = await Order.find({ user: { $in: buyerIds }, createdAt: { $gte: START } })
    .select('_id user orderId currency orderSummary onlineFeeSnapshot orderStatus isPaid awaitingPayment paymentMethod paidAt orderItems exchangeRateSnapshot sellerShipping sellerFulfillment sellerCurrencyMoney inventoryCommitted inventoryReleased safepayPaymentId').sort({ createdAt: 1 }).lean();
  for (const order of orders) {
    if (order.orderItems.some(item => !sellerIds.has(String(item.seller)))) throw new Error('QA_ORDER_SCOPE_REQUIRED');
    order.orderItems = order.orderItems.map(({ image, ...item }) => item);
    order.cancellations = await require('../models/OrderCancellation').find({ order: order._id, buyer: order.user })
      .select('_id seller currency amountMinor refundAmountMinor deductionMinor sellerCurrency sellerAmountMinor refundStatus refundDestination requestedAt refundedAt lastErrorCode').lean();
    order.walletEffects = await require('../models/WalletTransaction').find({ order: order._id, user: order.user })
      .select('_id type direction amount currency status balanceAfter referenceType createdAt').lean();
  }
  const payments = await Payment.find({ user: { $in: actors.map(a => a._id) }, environment: 'sandbox',
    purpose: { $in: ['order', 'subdomain'] }, createdAt: { $gte: START } }).sort({ createdAt: 1 }).lean();
  const client = require('../services/safepayClient').createSafepayClient({ config });
  const paymentEvidence = [];
  for (const p of payments) {
    let provider;
    try {
      if (p.tracker) {
        const t = await client.getTracker(p.tracker, p);
        provider = { state: t.state, mode: t.mode, entryMode: t.entry_mode, nextAction: t.next_actions?.CYBERSOURCE?.kind, quote: t.purchase_totals?.quote_amount,
          capture: t.charge?.capture?.totals || null, balance: t.charge?.balance || null };
      }
    } catch (error) { provider = { error: error.code || 'PROVIDER_READ_FAILED' }; }
    const refundEvents = await require('../models/SafepayRefundEvent').find({ payment: p._id, environment: 'sandbox' })
      .select('_id currency cumulativeMinor deltaMinor occurredAt sellerAllocations').lean();
    paymentEvidence.push({ id: p._id, order: p.order, store: p.store, purpose: p.purpose, reference: p.reference,
      tracker: p.tracker, status: p.status, currency: p.currency, amountMinor: p.amountMinor, capturedMinor: p.capturedMinor,
      refundedMinor: p.refundedMinor, walletRefundMinor: p.walletRefundMinor, providerEntryMode: p.providerEntryMode,
      hasMerchantCustomer: !!p.customerId,
      createdAt: p.createdAt, appliedAt: p.appliedAt, paidAt: p.paidAt, chargeOutcome: p.chargeOutcome,
      authentication: { setupStartedAt: p.savedCardAuthentication?.setupStartedAt, expiresAt: p.savedCardAuthentication?.expiresAt, resetStartedAt: p.savedCardAuthentication?.resetStartedAt },
      lastErrorCode: p.lastErrorCode, riskPending: p.riskPending, provider, refundEvents });
  }
  const productIds = ['6ab76c69f1585bb3833af7d9', '6a931edefac20b9d5e05aacf'];
  const products = await Product.find({ _id: { $in: productIds }, seller: { $in: sellers.map(a => a._id) } })
    .select('_id name stock price discountedPrice currency optionGroups returnPolicy isApproved').lean();
  const wallet = await require('../models/Wallet').findOne({ user: buyer._id }).select('balances status').lean();
  const buyerWallets = await require('../models/Wallet').find({ user: { $in: buyerIds } }).select('user balances status').lean();
  const profiles = await require('../models/SafepayCustomer').find({ user: { $in: actors.map(a => a._id) }, environment: 'sandbox' })
    .select('user status createdForCardConsentAt').lean();
  const cardProfileEvidence = actors.map(actor => ({ account: actor.email,
    readyConsentedProfile: profiles.some(p => String(p.user) === String(actor._id) && p.status === 'ready' && !!p.createdForCardConsentAt) }));
  console.log(JSON.stringify({ readOnly: true, sandbox: true, cutoff: START, wallet, products,
    buyerWallets, cardProfileEvidence, sellers: balances, orders, payments: paymentEvidence }, null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.code || error.message || 'QA_AUDIT_FAILED'); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
module.exports = { main };
