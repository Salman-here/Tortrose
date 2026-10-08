'use strict';
// Explicit clock fixture only. No price, consent, card, payment, invoice, order,
// inventory, Wallet, earned balance or provider state is created/changed here.
// It is not an HTTP endpoint, and cannot operate on Production or other users.
const mongoose = require('mongoose');
require('dotenv').config({ quiet: true });
const EMAIL = 'rozare-safepay-seller-20260925@mailinator.com';
function clockTerms(sub, at = new Date()) {
  if (sub.billingProvider !== 'safepay' || sub.safepayBilling?.environment !== 'sandbox'
    || !['active', 'free_period'].includes(sub.status) || !sub.safepayBilling.autoRenew || sub.paymentRisk?.suspended
    || sub.cancelledAt && !sub.pendingDowngrade?.toPlan || sub.safepayBilling.pendingOperation
    || !sub.safepayBilling.contractId || !sub.safepayBilling.consentedAt || !sub.safepayBilling.consentVersion
    || !Number.isSafeInteger(sub.safepayBilling.cycle) || sub.safepayBilling.cycle < 0
    || ![599, 999, 1299, 1699, 2165, 2565].includes(sub.safepayBilling.monthlyMinor)) throw new Error('QA_CLOCK_STATE_UNSAFE');
  const due = new Date(at.getTime() - 1000), cycle = sub.safepayBilling.cycle;
  // Use a day safely present in every month; retain the current real cycle/key.
  due.setUTCDate(Math.min(28, due.getUTCDate()));
  const anchor = new Date(due); anchor.setUTCMonth(anchor.getUTCMonth() - cycle);
  if (!sub.currentPeriodStart || new Date(sub.currentPeriodStart) >= due) throw new Error('QA_CLOCK_PERIOD_UNSAFE');
  return { 'safepayBilling.anchorAt': anchor, 'safepayBilling.nextChargeAt': due,
    currentPeriodEnd: due, ...(sub.status === 'free_period' ? { freePeriodEndDate: due } : {}) };
}
async function main() {
  const config = require('../config/safepay').readSafepayConfig(process.env, { requireWebhook: true });
  if (config.environment !== 'sandbox') throw new Error('SANDBOX_REQUIRED');
  require('node:dns').setServers(['1.1.1.1', '8.8.8.8']);
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
  const seller = await require('../models/User').findOne({ email: EMAIL, role: 'seller', status: 'active' }).select('_id').lean();
  if (!seller) throw new Error('QA_SELLER_REQUIRED');
  const Model = require('../models/SellerSubscription');
  const sub = await Model.findOne({ seller: seller._id }).lean();
  if (!sub) throw new Error('QA_SUBSCRIPTION_REQUIRED');
  const changes = clockTerms(sub);
  if (!process.argv.includes('--make-renewal-due')) {
    console.log(JSON.stringify({ dryRun: true, qaEmail: EMAIL, before: { currentPeriodEnd: sub.currentPeriodEnd,
      anchorAt: sub.safepayBilling.anchorAt, cycle: sub.safepayBilling.cycle }, proposedClock: changes })); return;
  }
  await mongoose.connection.transaction(async session => {
    const current = await Model.findOne({ _id: sub._id, seller: seller._id, 'safepayBilling.version': sub.safepayBilling.version }).session(session).lean();
    if (!current) throw new Error('QA_CLOCK_STATE_CHANGED');
    clockTerms(current);
    await mongoose.connection.collection('qa_billing_clock_receipts').insertOne({
      _id: `${sub._id}:${sub.safepayBilling.contractId}:${sub.safepayBilling.cycle}`, qaEmail: EMAIL, sandbox: true,
      createdAt: new Date(), purpose: 'Explicit accelerated renewal test; no payment status or monetary values changed',
      before: { currentPeriodStart: current.currentPeriodStart, currentPeriodEnd: current.currentPeriodEnd,
        freePeriodEndDate: current.freePeriodEndDate, anchorAt: current.safepayBilling.anchorAt,
        nextChargeAt: current.safepayBilling.nextChargeAt, cycle: current.safepayBilling.cycle }, after: changes,
    }, { session });
    const result = await Model.updateOne({ _id: current._id, 'safepayBilling.version': current.safepayBilling.version },
      { $set: changes, $inc: { 'safepayBilling.version': 1 } }, { session, runValidators: true });
    if (result.modifiedCount !== 1) throw new Error('QA_CLOCK_STATE_CHANGED');
  });
  console.log(JSON.stringify({ sandbox: true, qaEmail: EMAIL, clockFixtureApplied: true, after: changes,
    paymentStatusManuallyChanged: false, chargesSubmittedByFixture: 0 }));
}
if (require.main === module) main().catch(error => { console.error(error.code || error.message || 'QA_CLOCK_FAILED'); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
module.exports = { clockTerms };
