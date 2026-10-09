'use strict';

// Deliberately limited QA fault simulations, NOT server-crash claims. One mode
// discards an existing persisted reply; the other runs real setup in this local
// CLI process and discards its successful HTTP reply before context persistence.
// Neither creates trackers, resets authentication, creates auth tokens or captures.
const mongoose = require('mongoose');
const Payment = require('../models/SafepayPayment');
const User = require('../models/User');
const { readSafepayConfig } = require('../config/safepay');
const { createSafepayClient, canResetSavedCardAuthentication } = require('../services/safepayClient');
const { requireOwnedReusableCard } = require('../services/safepayCustomerService');

const QA_ACCOUNTS = new Set(['rozare-safepay-buyer-20260925@mailinator.com', 'rozare-safepay-seller-20260925@mailinator.com']);
const MODES = new Set(['inspect', 'simulate-missing-context', 'simulate-setup-reply-loss']);
const JOURNAL_COLLECTION = 'qa_safepay_authentication_recovery';
const NAMESPACE = 'saved-card-persisted-response-loss-v1';
const fail = code => Object.assign(new Error(code), { code });
const localDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
const activeLease = (payment, at) => payment.savedCardAuthentication?.operationLeaseUntil > at;
const safeTracker = tracker => !tracker?.charge && (canResetSavedCardAuthentication(tracker)
  || (tracker?.state === 'TRACKER_STARTED' && tracker?.next_actions?.CYBERSOURCE?.kind === 'PAYER_AUTH_SETUP'));
const initialSetup = tracker => !tracker?.charge && tracker?.state === 'TRACKER_STARTED'
  && tracker?.next_actions?.CYBERSOURCE?.kind === 'PAYER_AUTH_SETUP';
let setupFaultProcessActive = false;

function assertScope(payment, user, at) {
  if (!payment || payment.environment !== 'sandbox' || payment.purpose !== 'wallet_top_up'
    || payment.providerMode !== 'payment' || payment.providerEntryMode !== 'tms'
    || !payment.customerId || !payment.cardId || !payment.tracker || payment.currency !== 'USD'
    || !Number.isSafeInteger(payment.amountMinor) || payment.amountMinor < 1 || payment.amountMinor > 500
    || payment.status !== 'ready' || payment.appliedAt || payment.localCancelledAt || payment.riskPending
    || payment.capturedMinor !== 0 || payment.refundedMinor !== 0 || payment.walletRefundMinor !== 0
    || payment.paidAt || payment.cancelledAt || payment.chargeStartedAt || payment.chargeCompletedAt
    || payment.chargeOutcome !== 'not_started') throw fail('QA_PAYMENT_SCOPE_REQUIRED');
  if (!user || user.status !== 'active' || !QA_ACCOUNTS.has(String(user.email || '').toLowerCase())
    || String(user._id) !== String(payment.user)) throw fail('QA_ACCOUNT_SCOPE_REQUIRED');
  if (!(payment.createdAt instanceof Date) || !Number.isFinite(payment.createdAt.getTime())
    || payment.createdAt > at || localDay(payment.createdAt) !== localDay(at)) throw fail('QA_FRESH_TODAY_PAYMENT_REQUIRED');
  if (activeLease(payment, at) || payment.savedCardAuthentication?.resetStartedAt) throw fail('QA_AUTHENTICATION_OPERATION_ACTIVE');
}

function publicEvidence(payment, tracker, mode, changed) {
  // Do not add user/card/customer/tracker IDs, URLs or encrypted/auth material.
  return { mode, simulatedPersistedResponseLoss: changed, paymentId: String(payment._id),
    amountMinor: payment.amountMinor, currency: payment.currency, providerState: tracker.state,
    setupIntentPresent: !!payment.savedCardAuthentication?.setupStartedAt,
    contextPresent: !!payment.savedCardAuthentication?.encryptedContext, providerHasCharge: !!tracker.charge };
}

function createSetupReplyLossTransport(payment, config, fetchImpl) {
  if (config.environment !== 'sandbox' || config.apiHost !== 'https://sandbox.api.getsafepay.com') throw fail('QA_SANDBOX_REQUIRED');
  let setupPosts = 0, setupReplyDiscarded = false;
  const permittedGets = new Set([`/reporter/api/v1/payments/${payment.tracker}`,
    `/user/customers/v1/${payment.customerId}/wallet/${payment.cardId}`]);
  const guardedFetch = async (url, options = {}) => {
    const target = new URL(url);
    if (target.origin !== config.apiHost || target.search || target.hash || target.username || target.password) throw fail('QA_NETWORK_SCOPE_REJECTED');
    if (options.method === 'GET' && permittedGets.has(target.pathname) && options.body === undefined) return fetchImpl(url, options);
    if (options.method !== 'POST' || target.pathname !== `/order/payments/v3/${payment.tracker}` || setupPosts !== 0) throw fail('QA_NETWORK_MUTATION_REJECTED');
    let body;
    try { body = JSON.parse(options.body); } catch (_) { throw fail('QA_NETWORK_MUTATION_REJECTED'); }
    // Strict equality excludes authorization, capture, action chaining, extra
    // payment methods or any arbitrary payload before an outbound request.
    const expected = { payload: { payment_method: { tokenized_card: { token: payment.cardId } } }, use_action_chaining: false };
    if (JSON.stringify(body) !== JSON.stringify(expected)) throw fail('QA_NETWORK_MUTATION_REJECTED');
    setupPosts++;
    const response = await fetchImpl(url, options);
    if (!response.ok) return response; // A rejection is not successful setup proof.
    setupReplyDiscarded = true;
    if (response.body?.cancel) await response.body.cancel();
    // The actual provider client translates this lost transport reply into its
    // normal outcomeUnknown error, retaining setup intent without context.
    throw Object.assign(fail('QA_SIMULATED_SETUP_REPLY_LOSS'), { outcomeUnknown: true });
  };
  return { fetchImpl: guardedFetch, evidence: () => ({ setupPosts, setupReplyDiscarded }) };
}

// CLI-process-only injection. The shared authenticate/reconciliation/customer
// source is reloaded with a transport restriction and then restored, including
// any earlier require-cache entries. Nothing is injected into the hosted server.
async function runLocalSetupReplyFault(payment, config) {
  if (setupFaultProcessActive) throw fail('QA_LOCAL_FAULT_PROCESS_BUSY');
  setupFaultProcessActive = true;
  const clientModule = require('../services/safepayClient');
  const originalFactory = clientModule.createSafepayClient;
  const modulePaths = ['../services/safepaySavedCardCheckoutService', '../services/safepayPaymentService', '../services/safepayCustomerService'].map(name => require.resolve(name));
  const originalModules = new Map(modulePaths.map(name => [name, require.cache[name]]));
  const transport = createSetupReplyLossTransport(payment, config, globalThis.fetch);
  let authenticationError = '';
  try {
    clientModule.createSafepayClient = options => originalFactory({ ...options, fetchImpl: transport.fetchImpl });
    for (const name of modulePaths) delete require.cache[name];
    const savedCheckout = require('../services/safepaySavedCardCheckoutService');
    const checkout = savedCheckout.buildCheckoutContext(payment, 'web');
    const ticket = new URL(checkout.checkoutUrl).hash.slice('#ticket='.length);
    try {
      await savedCheckout.authenticate(String(payment._id), `Bearer ${ticket}`,
        { street_1: 'QA Test Address', city: 'Lahore', country: 'PK' }, checkout.checkoutSessionGrant);
      throw fail('QA_EXPECTED_SETUP_LOSS_NOT_OBSERVED');
    } catch (error) {
      authenticationError = error.code || 'QA_AUTHENTICATION_FAILED';
      const evidence = transport.evidence();
      if (!evidence.setupReplyDiscarded || !error.outcomeUnknown || evidence.setupPosts !== 1) throw fail('QA_SETUP_FAULT_NOT_ESTABLISHED');
    }
    return { ...transport.evidence(), authenticationError };
  } finally {
    clientModule.createSafepayClient = originalFactory;
    for (const name of modulePaths) {
      if (originalModules.get(name)) require.cache[name] = originalModules.get(name);
      else delete require.cache[name];
    }
    setupFaultProcessActive = false;
  }
}

async function simulateSetupReplyLoss({ payment, tracker, journal, journalKey, at, now, config }) {
  const prior = payment.savedCardAuthentication;
  if (!initialSetup(tracker) || prior?.setupStartedAt || prior?.encryptedContext || prior?.expiresAt) throw fail('QA_UNSTARTED_SETUP_REQUIRED');
  // Claim before invoking the real source or HTTP. A crash/unknown outcome
  // consumes this one-shot namespace; the helper never resubmits on repeat.
  await mongoose.connection.transaction(async session => {
    if (await journal.findOne({ _id: journalKey }, { session })) throw fail('QA_SIMULATION_ALREADY_RECORDED');
    const current = await Payment.findById(payment._id).select('+cardId +savedCardAuthentication.encryptedContext').session(session);
    const user = await User.findById(payment.user).select('_id email status').session(session).lean();
    assertScope(current, user, now());
    const bindings = ['user', 'environment', 'purpose', 'providerMode', 'providerEntryMode', 'customerId', 'cardId', 'tracker', 'reference', 'amountMinor', 'currency'];
    if (bindings.some(field => String(current[field]) !== String(payment[field]))
      || current.savedCardAuthentication?.setupStartedAt || current.savedCardAuthentication?.encryptedContext
      || current.savedCardAuthentication?.expiresAt) throw fail('QA_ORIGINAL_CONTEXT_CHANGED');
    await journal.insertOne({ _id: journalKey, namespace: NAMESPACE, mode: 'simulate-setup-reply-loss',
      paymentId: payment._id, environment: 'sandbox', simulatedLocalTransportReplyLoss: true,
      amountMinor: payment.amountMinor, currency: payment.currency, observedProviderState: tracker.state,
      outcome: 'claimed', createdAt: at }, { session });
  }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  let fault;
  try {
    fault = await runLocalSetupReplyFault(payment, config);
    const current = await Payment.findById(payment._id).select('+cardId +savedCardAuthentication.encryptedContext');
    const user = await User.findById(payment.user).select('_id email status').lean();
    assertScope(current, user, now());
    const freshTracker = await createSafepayClient({ config }).getTracker(payment.tracker, payment);
    if (!canResetSavedCardAuthentication(freshTracker) || freshTracker.charge
      || !current.savedCardAuthentication?.setupStartedAt || current.savedCardAuthentication?.encryptedContext
      || current.savedCardAuthentication?.expiresAt) throw fail('QA_SETUP_FAULT_NOT_ESTABLISHED');
    await journal.updateOne({ _id: journalKey, outcome: 'claimed' }, { $set: { outcome: 'verified', verifiedAt: now(),
      observedProviderState: freshTracker.state, setupPosts: fault.setupPosts, setupReplyDiscarded: true } });
    return { ...publicEvidence(current, freshTracker, 'simulate-setup-reply-loss', false),
      simulatedLocalTransportReplyLoss: true, setupPosts: fault.setupPosts, setupReplyDiscarded: true };
  } catch (error) {
    await journal.updateOne({ _id: journalKey, outcome: 'claimed' }, { $set: { outcome: 'not_verified', observedAt: now() } });
    throw error;
  }
}

async function verifyAuthenticationRecoveryQa({ paymentId, mode = 'inspect', now = () => new Date() } = {}) {
  if (typeof paymentId !== 'string' || !/^[a-f0-9]{24}$/i.test(paymentId) || !MODES.has(mode)) throw fail('QA_EXACT_PAYMENT_AND_MODE_REQUIRED');
  const config = readSafepayConfig(process.env, { requireWebhook: true });
  if (config.environment !== 'sandbox') throw fail('QA_SANDBOX_REQUIRED');
  const at = now();
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw fail('QA_CLOCK_INVALID');
  const payment = await Payment.findById(paymentId).select('+cardId +savedCardAuthentication.encryptedContext');
  const user = payment?.user ? await User.findById(payment.user).select('_id email status').lean() : null;
  assertScope(payment, user, at);
  await requireOwnedReusableCard(payment.user, payment.cardId);
  // Fresh GET performs full environment, merchant, customer, tracker, frozen
  // amount, currency, reference and TMS mode binding validation in the client.
  const tracker = await createSafepayClient({ config }).getTracker(payment.tracker, payment);
  if (!safeTracker(tracker)) throw fail('QA_UNCAPTURED_SETUP_EVIDENCE_REQUIRED');
  if (mode === 'inspect') return publicEvidence(payment, tracker, mode, false);

  const journal = mongoose.connection.collection(JOURNAL_COLLECTION);
  const journalKey = `${NAMESPACE}:${String(payment._id)}`;
  if (await journal.findOne({ _id: journalKey })) throw fail('QA_SIMULATION_ALREADY_RECORDED');
  if (mode === 'simulate-setup-reply-loss') return simulateSetupReplyLoss({ payment, tracker, journal, journalKey, at, now, config });
  const prior = payment.savedCardAuthentication;
  if (!prior?.setupStartedAt || !prior.encryptedContext || !(prior.expiresAt > at)) throw fail('QA_CURRENT_SETUP_CONTEXT_REQUIRED');

  await mongoose.connection.transaction(async session => {
    if (await journal.findOne({ _id: journalKey }, { session })) throw fail('QA_SIMULATION_ALREADY_RECORDED');
    const current = await Payment.findById(paymentId).select('+cardId +savedCardAuthentication.encryptedContext').session(session);
    const currentUser = await User.findById(payment.user).select('_id email status').session(session).lean();
    assertScope(current, currentUser, now());
    // Both journal and loss simulation commit together. Unique _id also fences
    // concurrent operators, and no sensitive setup context is stored in it.
    await journal.insertOne({ _id: journalKey, namespace: NAMESPACE, paymentId: payment._id,
      environment: 'sandbox', simulatedPersistedResponseLoss: true, amountMinor: payment.amountMinor,
      currency: payment.currency, observedProviderState: tracker.state, createdAt: at }, { session });
    const changed = await Payment.updateOne({ _id: payment._id, user: payment.user, environment: 'sandbox',
      purpose: 'wallet_top_up', providerMode: 'payment', providerEntryMode: 'tms', customerId: payment.customerId,
      cardId: payment.cardId, tracker: payment.tracker, amountMinor: payment.amountMinor, currency: payment.currency,
      status: 'ready', appliedAt: null, localCancelledAt: null, riskPending: false, capturedMinor: 0,
      refundedMinor: 0, walletRefundMinor: 0, chargeStartedAt: null, chargeOutcome: 'not_started',
      paidAt: null, cancelledAt: null, chargeCompletedAt: null,
      'savedCardAuthentication.setupStartedAt': prior.setupStartedAt,
      'savedCardAuthentication.encryptedContext': prior.encryptedContext, 'savedCardAuthentication.expiresAt': prior.expiresAt,
      'savedCardAuthentication.resetStartedAt': null,
      $or: [{ 'savedCardAuthentication.operationLeaseUntil': null }, { 'savedCardAuthentication.operationLeaseUntil': { $lte: now() } }] },
    { $set: { 'savedCardAuthentication.encryptedContext': '', 'savedCardAuthentication.expiresAt': null } },
    { session, timestamps: false });
    if (changed.modifiedCount !== 1) throw fail('QA_ORIGINAL_CONTEXT_CHANGED');
  }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  const changed = await Payment.findById(paymentId).select('+savedCardAuthentication.encryptedContext');
  return publicEvidence(changed, tracker, mode, true);
}

function parseArgs(args) {
  const options = args.length === 1 ? { paymentId: args[0], mode: 'inspect' }
    : args.length === 2 && MODES.has(args[0]) ? { paymentId: args[1], mode: args[0] } : null;
  if (!options || !/^[a-f0-9]{24}$/i.test(options.paymentId || '')) throw fail('QA_EXACT_PAYMENT_AND_MODE_REQUIRED');
  return options;
}
async function main() {
  require('dotenv').config({ quiet: true });
  const options = parseArgs(process.argv.slice(2));
  const config = readSafepayConfig(process.env, { requireWebhook: true });
  if (config.environment !== 'sandbox') throw fail('QA_SANDBOX_REQUIRED');
  require('node:dns').setServers(['1.1.1.1', '8.8.8.8']);
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
  console.log(JSON.stringify(await verifyAuthenticationRecoveryQa(options)));
}
if (require.main === module) main().catch(error => {
  const code = typeof error.code === 'string' && /^(?:QA|SAFEPAY|CARD)_[A-Z0-9_]{1,90}$/.test(error.code) ? error.code : 'QA_VERIFICATION_FAILED';
  console.error(JSON.stringify({ error: code })); process.exitCode = 1;
}).finally(() => mongoose.disconnect());

module.exports = { verifyAuthenticationRecoveryQa, parseArgs, createSetupReplyLossTransport, JOURNAL_COLLECTION, NAMESPACE };
