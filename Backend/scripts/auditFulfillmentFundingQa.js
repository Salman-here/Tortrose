'use strict';

// READ ONLY. This helper never invokes fulfillment/settlement/summary services:
// those may materialize accounting or acquire durable financial write fences.
// Provider inspection uses getTracker (GET) only. Output deliberately excludes
// auth URLs, tickets, customer/card/tracker IDs, contacts and arbitrary metadata.
const mongoose = require('mongoose');
require('dotenv').config({ quiet: true });
const ACCOUNTS = Object.freeze([
  'rozare-safepay-buyer-20260925@mailinator.com',
  'rozare-safepay-seller-20260925@mailinator.com',
  'rozare.seller.82901@mailinator.com',
  'rozare.seller.82904@mailinator.com',
]);
const id = value => String(value?._id || value || '');
const fail = code => Object.assign(new Error(code), { code });
const eligible = status => ['pending', 'confirmed', 'processing'].includes(status);
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const money = value => {
  if (!value) return null;
  if (!['PKR', 'USD', 'EUR', 'GBP'].includes(value.currency)) return { valid: false };
  try { return { currency: value.currency, amountMinor: require('../services/safepayClient').readMinor(value.amount) }; }
  catch (_) { return { valid: false }; }
};

async function main() {
  const args = process.argv.slice(2);
  const reference = args.find(arg => !arg.startsWith('--'));
  if (args.some(arg => arg.startsWith('--') && arg !== '--provider')
      || args.filter(arg => !arg.startsWith('--')).length > 1
      || (reference && !/^[a-f0-9]{24}$/i.test(reference))) throw fail('QA_ARGUMENT_INVALID');
  const config = require('../config/safepay').readSafepayConfig(process.env, { requireWebhook: true });
  if (config.environment !== 'sandbox') throw fail('QA_SANDBOX_REQUIRED');
  require('node:dns').setServers(['1.1.1.1', '8.8.8.8']);
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false,
    serverSelectionTimeoutMS: 10000, socketTimeoutMS: 20000 });
  const User = require('../models/User');
  const Order = require('../models/Order');
  const Payment = require('../models/SafepayPayment');
  const Cancellation = require('../models/OrderCancellation');
  const Ledger = require('../models/SellerBalanceTransaction');
  const Hold = require('../models/SellerPaymentRiskHold');
  const actors = await User.find({ email: { $in: ACCOUNTS } }).select('_id email role').lean();
  if (!actors.length) throw fail('QA_ACTORS_REQUIRED');
  const sellerIds = actors.filter(actor => actor.role === 'seller').map(actor => actor._id);
  const buyerIds = actors.filter(actor => ACCOUNTS.slice(0, 2).includes(actor.email)).map(actor => actor._id);
  if (!sellerIds.length || !buyerIds.length) throw fail('QA_SCOPE_REQUIRED');
  const allowedSellerIds = new Set(sellerIds.map(id));
  const orders = await Order.find({ user: { $in: buyerIds }, 'orderItems.seller': { $in: sellerIds },
    ...(reference ? { _id: reference } : {}) }).sort({ createdAt: -1 }).limit(10).lean();
  if (reference && !orders.length) throw fail('QA_ORDER_NOT_FOUND');
  const client = args.includes('--provider') ? require('../services/safepayClient').createSafepayClient({ config }) : null;
  const rows = [];
  let excludedOutsideSellerScope = 0;
  for (const order of orders) {
    if (!order.orderItems?.length || order.orderItems.some(item => !allowedSellerIds.has(id(item.seller)))) {
      excludedOutsideSellerScope++;
      continue;
    }
    const payment = order.safepayPaymentId ? await Payment.findById(order.safepayPaymentId).lean() : null;
    if (payment && payment.environment !== 'sandbox') throw fail('QA_SANDBOX_PAYMENT_REQUIRED');
    let bound = false;
    if (payment) try {
      require('../services/safepayPaymentFacts').assertSafepayOrderBinding(order, payment,
        require('../services/stripeOrderPaymentService').getExpectedStripeTotalMinor(order));
      bound = true;
    } catch (_) { /* Invalid binding is evidence, never silently repaired. */ }
    const cancellations = await Cancellation.find({ order: order._id, buyer: order.user,
      seller: { $in: sellerIds } }).select('seller refundStatus refundDestination amountMinor refundAmountMinor').lean();
    const scope = { seller: { $in: sellerIds }, type: 'reversal', 'metadata.sourceType': 'order_payment',
      'metadata.sourceReferenceId': id(order) };
    const ledger = await Ledger.find(scope).select('seller status sourceAmount sourceCurrency').lean();
    const holds = await Hold.find({ seller: { $in: sellerIds }, sourceType: 'order_payment', status: 'pending',
      sourceReferenceId: { $in: [id(order), ...(payment ? [id(payment)] : [])] } })
      .select('seller provider eventType status unknownExposure').lean();
    let provider = null;
    if (client && payment?.tracker && bound) {
      try {
        const tracker = await client.getTracker(payment.tracker, payment);
        let refund = null;
        try {
          const evidence = require('../services/safepayRefundService').refundEvidence(tracker, payment);
          if (evidence) refund = { amountMinor: evidence.amountMinor, full: evidence.full, occurredAt: evidence.occurredAt };
        } catch (_) { refund = { valid: false }; }
        provider = { state: tracker.state, quote: money(tracker.purchase_totals?.quote_amount),
          capture: money(tracker.charge?.capture?.totals), remaining: money(tracker.charge?.balance), refund };
      } catch (error) { provider = { error: error.code || 'QA_PROVIDER_READ_FAILED' }; }
    }
    const fulfillment = (order.sellerFulfillment || []).filter(row => allowedSellerIds.has(id(row.seller)))
      .map(row => ({ sellerId: id(row.seller), status: row.status }));
    const fullGenericRefund = !!(bound && order.paymentMethod === 'safepay' && order.isPaid && !order.awaitingPayment
      && eligible(order.orderStatus) && payment.status === 'refunded' && payment.capturedMinor > 0
      && payment.refundedMinor === payment.capturedMinor && cancellations.length === 0
      && provider?.refund?.full === true && provider.refund.amountMinor === payment.refundedMinor);
    rows.push({ orderId: order.orderId, databaseId: id(order), currency: order.currency,
      createdAt: order.createdAt, sellerCurrencyMoneyVersion: order.sellerCurrencyMoneyVersion,
      status: order.orderStatus, paymentMethod: order.paymentMethod, isPaid: order.isPaid,
      awaitingPayment: order.awaitingPayment, inventoryCommitted: order.inventoryCommitted, fulfillment,
      payment: payment ? { bindingVerified: bound, status: payment.status, applied: !!payment.appliedAt,
        currency: payment.currency, amountMinor: integer(payment.amountMinor), capturedMinor: integer(payment.capturedMinor),
        refundedMinor: integer(payment.refundedMinor), riskPending: payment.riskPending, providerState: payment.providerState } : null,
      provider, cancellations: cancellations.map(row => ({ sellerId: id(row.seller), status: row.refundStatus,
        destination: row.refundDestination, grossMinor: integer(row.amountMinor), refundMinor: integer(row.refundAmountMinor) })),
      reversalLedger: ledger.map(row => ({ sellerId: id(row.seller), status: row.status,
        sourceAmount: row.sourceAmount, currency: row.sourceCurrency })),
      pendingHolds: holds.map(row => ({ sellerId: id(row.seller), provider: row.provider,
        status: row.status, eventType: row.eventType, unknownExposure: row.unknownExposure })),
      ...(fullGenericRefund ? { hostedGuardTestCandidate: 'full-generic-provider-refund-before-shipment',
        candidateSellerIds: fulfillment.filter(row => eligible(row.status)).map(row => row.sellerId) } : {}),
    });
  }
  console.log(JSON.stringify({ readOnly: true, sandbox: true, limit: 10, providerReadRequested: !!client,
    excludedOutsideSellerScope, rows }, null, 2));
}

if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ error: error.code || error.name || 'QA_FUNDING_READ_FAILED' }));
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
module.exports = { main };
