'use strict';
// Provider-only negative test. The official Sandbox vectors are amount-based,
// not ordinary subscription prices. Never alters a Rozare invoice or plan.
// A durable one-shot journal prevents resubmission after an unknown response.
const mongoose = require('mongoose');
require('dotenv').config({ quiet: true });
const EMAIL = 'rozare-safepay-seller-20260925@mailinator.com';
const AMOUNTS = Object.freeze({ insufficient: 405100, stolen: 400400, expired: 405400 });
async function main() {
  const kind = process.argv[2];
  if (!Object.hasOwn(AMOUNTS, kind)) throw new Error('OFFICIAL_DECLINE_VECTOR_REQUIRED');
  const config = require('../config/safepay').readSafepayConfig(process.env, { requireWebhook: true });
  if (config.environment !== 'sandbox') throw new Error('SANDBOX_REQUIRED');
  require('node:dns').setServers(['1.1.1.1', '8.8.8.8']);
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
  const seller = await require('../models/User').findOne({ email: EMAIL, role: 'seller', status: 'active' }).select('_id').lean();
  if (!seller) throw new Error('QA_SELLER_REQUIRED');
  const sub = await require('../models/SellerSubscription').findOne({ seller: seller._id,
    billingProvider: 'safepay', 'safepayBilling.environment': 'sandbox' }).select('+safepayBilling.cardId').lean();
  if (!sub?.safepayBilling.cardId) throw new Error('QA_OWNED_REUSABLE_CARD_REQUIRED');
  const { link, card } = await require('../services/safepayCustomerService').requireOwnedReusableCard(seller._id, sub.safepayBilling.cardId);
  let knownErrorMarkers = null;
  const client = require('../services/safepayClient').createSafepayClient({ config, fetchImpl: async (...args) => {
    const response = await fetch(...args);
    if (!response.ok) {
      try {
        const body = await response.clone().json();
        const errors = Array.isArray(body?.status?.errors) ? body.status.errors : [];
        const text = errors.map(value => typeof value === 'string' ? value : String(value?.message || value?.description || '')).join(' ');
        // Emit only known-marker booleans, never raw provider bodies/messages.
        knownErrorMarkers = { insufficient: /insufficient/i.test(text), stolen: /stolen/i.test(text), expired: /expired/i.test(text),
          declined: /declin/i.test(text), authorization: /not.?authori[sz]ed|unauthori[sz]ed|permission|forbidden/i.test(text) };
      } catch (_) { /* Absence of safe diagnostics is not payment evidence. */ }
    }
    return response;
  } });
  const reference = `qa:billing-decline:20261008:${kind}`;
  const journal = mongoose.connection.collection('qa_safepay_gateway_probes');
  let receipt = await journal.findOne({ _id: reference });
  const expected = { environment: 'sandbox', purpose: 'subscription', providerMode: 'subscription',
    amountMinor: AMOUNTS[kind], currency: 'USD', reference, customerId: link.customerId };
  if (!receipt) {
    await journal.insertOne({ _id: reference, sandbox: true, qaEmail: EMAIL, amountMinor: expected.amountMinor,
      currency: 'USD', creationStartedAt: new Date(), chargeStartedAt: null, tracker: null });
    const tracker = await client.createTracker(expected);
    await journal.updateOne({ _id: reference, tracker: null }, { $set: { tracker: tracker.token } });
    receipt = await journal.findOne({ _id: reference });
  }
  if (!receipt.tracker || receipt.amountMinor !== expected.amountMinor || receipt.currency !== expected.currency) throw new Error('PROBE_REQUIRES_READ_ONLY_RECOVERY');
  let errorCode = '', providerStatus = null, outcomeUnknown = false;
  const claim = await journal.updateOne({ _id: reference, chargeStartedAt: null }, { $set: { chargeStartedAt: new Date() } });
  if (claim.modifiedCount === 1) {
    try { await client.chargeRecurring(receipt.tracker, expected, card.token); }
    catch (error) { errorCode = error.code || 'PROBE_REQUEST_FAILED'; providerStatus = error.providerStatus || null; outcomeUnknown = error.outcomeUnknown === true; }
    await journal.updateOne({ _id: reference }, { $set: { errorCode, providerStatus, outcomeUnknown, knownErrorMarkers } });
  }
  receipt = await journal.findOne({ _id: reference });
  const tracker = await client.getTracker(receipt.tracker, expected);
  const current = await require('../models/SellerSubscription').findById(sub._id).select('safepayBilling.monthlyMinor').lean();
  const result = { sandbox: true, providerOnly: true, kind, reference, amountMinor: expected.amountMinor, currency: expected.currency,
    state: tracker.state, mode: tracker.mode, entryMode: tracker.entry_mode, hasCharge: Boolean(tracker.charge),
    errorCode: receipt.errorCode, providerStatus: receipt.providerStatus, outcomeUnknown: receipt.outcomeUnknown, knownErrorMarkers: receipt.knownErrorMarkers || null,
    originalMonthlyMinor: sub.safepayBilling.monthlyMinor, currentMonthlyMinor: current?.safepayBilling.monthlyMinor,
    platformInvoiceCreated: false, walletOrSellerBalanceChanged: false, chargeSubmissionReused: claim.modifiedCount === 0 };
  await journal.updateOne({ _id: reference }, { $set: { observedAt: new Date(), observedState: tracker.state, hasCharge: result.hasCharge } });
  console.log(JSON.stringify(result));
  if (result.hasCharge || tracker.state === 'TRACKER_ENDED' || result.outcomeUnknown) throw new Error('UNEXPECTED_PROBE_OUTCOME_REQUIRES_REVIEW');
}
if (require.main === module) main().catch(error => { console.error(error.code || error.message || 'QA_PROBE_FAILED'); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
