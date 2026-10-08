'use strict';
// Read-only, masked billing evidence for the authorised disposable QA seller.
const mongoose = require('mongoose');
require('dotenv').config({ quiet: true });
const EMAIL = 'rozare-safepay-seller-20260925@mailinator.com';
async function main() {
  const config = require('../config/safepay').readSafepayConfig(process.env, { requireWebhook: true });
  if (config.environment !== 'sandbox') throw new Error('SANDBOX_REQUIRED');
  require('node:dns').setServers(['1.1.1.1', '8.8.8.8']);
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
  const seller = await require('../models/User').findOne({ email: EMAIL, role: 'seller' }).select('_id').lean();
  if (!seller) throw new Error('QA_SELLER_REQUIRED');
  const sub = await require('../models/SellerSubscription').findOne({ seller: seller._id }).select('+safepayBilling.cardId').lean();
  if (!sub) throw new Error('QA_SUBSCRIPTION_REQUIRED');
  const store = await require('../models/Store').findOne({ seller: seller._id }).select('isActive productCurrency').lean();
  const operations = await require('../models/SafepayBillingOperation').find({ seller: seller._id, environment: 'sandbox' })
    .sort({ createdAt: -1 }).limit(30).lean();
  const client = require('../services/safepayClient').createSafepayClient({ config });
  const rows = [];
  for (const op of operations) {
    const payment = op.payment && await require('../models/SafepayPayment').findById(op.payment).lean();
    let provider = null;
    if (payment?.tracker) {
      try {
        const t = await client.getTracker(payment.tracker, payment);
        provider = { state: t.state, mode: t.mode, entryMode: t.entry_mode, quote: t.purchase_totals?.quote_amount,
          capture: t.charge?.capture?.totals || null, remaining: t.charge?.balance || null };
      } catch (error) { provider = { error: error.code || 'PROVIDER_READ_FAILED' }; }
    }
    rows.push({ operationId: String(op._id), kind: op.kind, status: op.status, acceptedAt: op.acceptedAt, appliedAt: op.appliedAt,
      terms: { plan: op.terms.plan, includeMetaAds: op.terms.includeMetaAds, monthlyMinor: op.terms.monthlyMinor,
        dueMinor: op.terms.dueMinor, trialDays: op.terms.trialDays, creditMinor: op.terms.creditMinor,
        appliedCreditMinor: op.terms.appliedCreditMinor, remainingCreditMinor: op.terms.remainingCreditMinor,
        metaAddonMinor: op.terms.metaAddonMinor, proration: op.terms.proration,
        periodStart: op.terms.periodStart, periodEnd: op.terms.periodEnd, cycle: op.terms.cycle },
      payment: payment ? { paymentId: String(payment._id), reference: payment.reference, status: payment.status,
        amountMinor: payment.amountMinor, currency: payment.currency, capturedMinor: payment.capturedMinor,
        refundedMinor: payment.refundedMinor, chargeOutcome: payment.chargeOutcome, appliedAt: payment.appliedAt,
        lastErrorCode: payment.lastErrorCode, riskPending: payment.riskPending, provider } : null });
  }
  let card = null;
  if (sub?.safepayBilling.customerId && sub.safepayBilling.cardId) {
    const c = await client.getCard(sub.safepayBilling.customerId, sub.safepayBilling.cardId);
    card = { last4: c.cybersource?.last_four, reusable: c.max_usage === -1 };
  }
  const notificationScope = { aggregateId: { $in: [String(sub._id), ...operations.map(op => String(op._id))] }, 'recipient.user': seller._id,
    occurredAt: { $gte: new Date('2026-10-08T00:00:00Z') } };
  const deliveryGroups = await require('../models/NotificationOutbox').aggregate([
    { $match: notificationScope },
    { $group: { _id: { eventType: '$eventType', channel: '$channel', status: '$status', errorCode: '$lastErrorCode' }, count: { $sum: 1 } } },
    { $sort: { '_id.eventType': 1, '_id.channel': 1, '_id.status': 1 } },
  ]);
  const virtualWhatsAppCopies = await require('../models/WhatsAppTestMessage').countDocuments({
    number: { $in: ['12025550120', '+12025550120'] }, direction: 'outbound',
    createdAt: { $gte: new Date('2026-10-08T00:00:00Z') }, text: /subscription|Starter|Elite/i,
  });
  console.log(JSON.stringify({ sandbox: true, email: EMAIL, store, subscription: sub ? {
    id: String(sub._id), status: sub.status, plan: sub.plan, planName: sub.planName, metaAdsIncluded: sub.metaAdsIncluded,
    currentPeriodStart: sub.currentPeriodStart, currentPeriodEnd: sub.currentPeriodEnd, freePeriodEndDate: sub.freePeriodEndDate,
    cancelledAt: sub.cancelledAt, pendingDowngrade: sub.pendingDowngrade?.toPlan || null,
    billing: { environment: sub.safepayBilling.environment, monthlyMinor: sub.safepayBilling.monthlyMinor,
      creditMinor: sub.safepayBilling.creditMinor, cycle: sub.safepayBilling.cycle, anchorAt: sub.safepayBilling.anchorAt,
      autoRenew: sub.safepayBilling.autoRenew, nextChargeAt: sub.safepayBilling.nextChargeAt,
      pendingOperation: sub.safepayBilling.pendingOperation, lastFailedOperation: sub.safepayBilling.lastFailedOperation,
      lastFailureCode: sub.safepayBilling.lastFailureCode, version: sub.safepayBilling.version, card } } : null,
    notificationEvidence: { deliveryGroups, virtualWhatsAppCopies, physicalWhatsAppReceiptClaimed: false }, operations: rows }, null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.code || error.message || 'QA_AUDIT_FAILED'); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
module.exports = { main };
