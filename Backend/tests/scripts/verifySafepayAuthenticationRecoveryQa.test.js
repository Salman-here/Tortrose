'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Payment = require('../../models/SafepayPayment');
const Customer = require('../../models/SafepayCustomer');
const User = require('../../models/User');
const mockFetch = jest.fn();
jest.mock('../../services/safepayClient', () => {
  const actual = jest.requireActual('../../services/safepayClient');
  return { ...actual, createSafepayClient: options => actual.createSafepayClient({ ...options, fetchImpl: options?.fetchImpl || mockFetch }) };
});
const qa = require('../../scripts/verifySafepayAuthenticationRecoveryQa');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const env = { SAFEPAY_ENV: 'sandbox', SAFEPAY_SANDBOX_PUBLIC_KEY: 'sec_sandbox-fixture',
  SAFEPAY_SANDBOX_SECRET_KEY: 'private-recovery-qa-fixture', SAFEPAY_SANDBOX_WEBHOOK_SECRET: 'private-webhook-fixture',
  SAFEPAY_SANDBOX_WEBHOOK_SCHEME: 'sha512-data', SAFEPAY_PRODUCTION_PUBLIC_KEY: 'sec_production-fixture',
  SAFEPAY_PRODUCTION_SECRET_KEY: 'private-production-fixture', SAFEPAY_PRODUCTION_WEBHOOK_SECRET: 'private-production-webhook-fixture',
  SAFEPAY_PRODUCTION_WEBHOOK_SCHEME: 'sha512-data' };
const previousEnv = {};
const originalGlobalFetch = globalThis.fetch;
let repl, payment, tracker, card, beforeTrackerReturn;
const run = (mode = 'inspect') => qa.verifyAuthenticationRecoveryQa({ paymentId: String(payment._id), mode });
const journal = () => mongoose.connection.collection(qa.JOURNAL_COLLECTION);
const fullPayment = () => Payment.findById(payment._id).select('+cardId +requestKey +checkoutUrl +processingToken +savedCardAuthentication.encryptedContext +savedCardAuthentication.operationToken').lean();
beforeAll(async () => {
  for (const [key, value] of Object.entries(env)) { previousEnv[key] = process.env[key]; process.env[key] = value; }
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri()); await Promise.all([Payment.init(), Customer.init()]);
}, 60000);
afterAll(async () => {
  globalThis.fetch = originalGlobalFetch;
  await mongoose.disconnect(); await repl.stop();
  for (const key of Object.keys(env)) { if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]; }
});
beforeEach(async () => {
  globalThis.fetch = mockFetch;
  process.env.SAFEPAY_ENV = 'sandbox'; beforeTrackerReturn = null;
  await Promise.all([Payment.deleteMany({}), Customer.deleteMany({}), User.deleteMany({}), journal().deleteMany({})]);
  const user = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: user, email: 'rozare-safepay-buyer-20260925@mailinator.com', status: 'active' });
  payment = await Payment.create({ user, environment: 'sandbox', purpose: 'wallet_top_up', reference: 'wallet:qa-recovery-fixture',
    requestKey: 'qa-recovery-fixture', fingerprint: 'a'.repeat(64), amountMinor: 200, currency: 'USD',
    providerMode: 'payment', providerEntryMode: 'tms', customerId: 'cus_qa-recovery-fixture', cardId: 'pm_qa-recovery-fixture',
    tracker: 'track_qa-recovery-fixture', status: 'ready', savedCardAuthentication: {
      setupStartedAt: new Date(), encryptedContext: 'test-encrypted-context-not-for-output', expiresAt: new Date(Date.now() + 600000),
    } });
  await Customer.create({ user, environment: 'sandbox', customerId: payment.customerId, status: 'ready' });
  tracker = { token: payment.tracker, environment: 'sandbox', client: env.SAFEPAY_SANDBOX_PUBLIC_KEY,
    mode: 'payment', entry_mode: 'tms', customer: payment.customerId, metadata: { data: { order_id: payment.reference } },
    purchase_totals: { quote_amount: { amount: 200, currency: 'USD' } }, state: 'TRACKER_STARTED',
    next_actions: { CYBERSOURCE: { kind: 'PAYER_AUTH_ENROLLMENT' } }, charge: null };
  card = { token: payment.cardId, customer: payment.customerId, merchant_api_key: env.SAFEPAY_SANDBOX_PUBLIC_KEY,
    is_deleted: false, max_usage: -1, expires_at: { seconds: 2200000000 }, cybersource: { token: 'tms_qa-recovery-fixture', last_four: '1111' } };
  mockFetch.mockReset().mockImplementation(async (url, options) => {
    let data;
    if (new URL(url).pathname.startsWith('/reporter/api/v1/payments/')) {
      if (beforeTrackerReturn) await beforeTrackerReturn(); data = structuredClone(tracker);
    } else if (new URL(url).pathname.endsWith(`/wallet/${payment.cardId}`)) data = structuredClone(card);
    else if (options.method === 'POST' && new URL(url).pathname === `/order/payments/v3/${payment.tracker}`) {
      expect(JSON.parse(options.body)).toEqual({ payload: { payment_method: { tokenized_card: { token: payment.cardId } } }, use_action_chaining: false });
      tracker.next_actions.CYBERSOURCE.kind = 'PAYER_AUTH_ENROLLMENT';
      data = { tracker: structuredClone(tracker), action: { payer_authentication_setup: {
        access_token: 'private-successful-setup-reply-fixture', device_data_collection_url: 'https://centinelapistag.cardinalcommerce.com/V1/Cruise/Collect' } } };
    }
    else throw new Error('Unexpected QA provider read');
    return { ok: true, status: 200, json: async () => ({ data }) };
  });
});

test('inspect is the default, read-only and limited to safe whitelisted evidence', async () => {
  const before = await fullPayment();
  const proof = await run();
  expect(proof).toEqual({ mode: 'inspect', simulatedPersistedResponseLoss: false, paymentId: String(payment._id),
    amountMinor: 200, currency: 'USD', providerState: 'TRACKER_STARTED', setupIntentPresent: true,
    contextPresent: true, providerHasCharge: false });
  expect(await fullPayment()).toEqual(before); expect(await journal().countDocuments()).toBe(0);
  expect(Object.keys(proof)).not.toEqual(expect.arrayContaining(['cardId', 'customerId', 'tracker', 'checkoutUrl', 'encryptedContext']));
  expect(JSON.stringify(proof)).not.toContain('private-');
});

test('explicit simulation clears exactly context/expiry and commits a durable one-shot receipt atomically', async () => {
  const before = await fullPayment();
  const proof = await run('simulate-missing-context');
  expect(proof).toMatchObject({ simulatedPersistedResponseLoss: true, contextPresent: false, setupIntentPresent: true });
  const after = await fullPayment();
  expect(after).toEqual({ ...before, savedCardAuthentication: { ...before.savedCardAuthentication, encryptedContext: '', expiresAt: null } });
  expect(await journal().countDocuments()).toBe(1);
  const receipt = await journal().findOne({ _id: `${qa.NAMESPACE}:${payment._id}` });
  expect(receipt).toMatchObject({ environment: 'sandbox', namespace: qa.NAMESPACE, simulatedPersistedResponseLoss: true, amountMinor: 200 });
  expect(JSON.stringify(receipt)).not.toContain('test-encrypted-context');
  await expect(run('simulate-missing-context')).rejects.toMatchObject({ code: 'QA_SIMULATION_ALREADY_RECORDED' });
});

test('the same payment cannot be simulated again after recovery produces a new context', async () => {
  await run('simulate-missing-context');
  await Payment.updateOne({ _id: payment._id }, { $set: { 'savedCardAuthentication.encryptedContext': 'test-new-context',
    'savedCardAuthentication.expiresAt': new Date(Date.now() + 600000) } });
  await expect(run('simulate-missing-context')).rejects.toMatchObject({ code: 'QA_SIMULATION_ALREADY_RECORDED' });
  expect((await fullPayment()).savedCardAuthentication.encryptedContext).toBe('test-new-context');
});

test('parallel simulation calls have exactly one permitted write and one durable receipt', async () => {
  const outcomes = await Promise.allSettled([run('simulate-missing-context'), run('simulate-missing-context')]);
  expect(outcomes.filter(entry => entry.status === 'fulfilled')).toHaveLength(1);
  expect(await journal().countDocuments()).toBe(1);
  expect((await fullPayment()).savedCardAuthentication.encryptedContext).toBe('');
});

test.each([
  ['environment', { environment: 'production' }], ['order purpose', { purpose: 'order' }],
  ['MIT mode', { providerMode: 'subscription' }], ['non-TMS entry', { providerEntryMode: '' }],
  ['over USD5', { amountMinor: 501 }], ['non-USD currency', { currency: 'PKR' }],
  ['captured', { capturedMinor: 1 }], ['refunded', { refundedMinor: 1 }], ['Wallet-refunded', { walletRefundMinor: 1 }],
  ['applied', { appliedAt: new Date() }], ['cancelled', { localCancelledAt: new Date() }], ['paid status', { status: 'paid' }],
  ['risk hold', { riskPending: true }], ['charge intent', { chargeStartedAt: new Date() }],
])('scope rejects %s payments without journal or provider mutations', async (_, fields) => {
  await Payment.collection.updateOne({ _id: payment._id }, { $set: fields });
  const before = await fullPayment();
  await expect(run('simulate-missing-context')).rejects.toMatchObject({ code: 'QA_PAYMENT_SCOPE_REQUIRED' });
  expect(await fullPayment()).toEqual(before); expect(await journal().countDocuments()).toBe(0);
  expect(mockFetch).not.toHaveBeenCalled();
});

test('production configuration rejects the command before any provider or document access', async () => {
  process.env.SAFEPAY_ENV = 'production';
  await expect(run('simulate-missing-context')).rejects.toMatchObject({ code: 'QA_SANDBOX_REQUIRED' });
  expect(mockFetch).not.toHaveBeenCalled(); expect(await journal().countDocuments()).toBe(0);
});

test.each([
  ['non-QA owner', { email: 'other-qa-account@mailinator.com' }],
  ['inactive owner', { status: 'blocked' }],
])('scope rejects %s', async (_, fields) => {
  await User.collection.updateOne({ _id: payment.user }, { $set: fields });
  await expect(run('simulate-missing-context')).rejects.toMatchObject({ code: 'QA_ACCOUNT_SCOPE_REQUIRED' });
  expect(mockFetch).not.toHaveBeenCalled(); expect(await journal().countDocuments()).toBe(0);
});

test('an old payment is rejected even when every other QA/payment binding is valid', async () => {
  await Payment.collection.updateOne({ _id: payment._id }, { $set: { createdAt: new Date(Date.now() - 48 * 3600000) } });
  await expect(run('simulate-missing-context')).rejects.toMatchObject({ code: 'QA_FRESH_TODAY_PAYMENT_REQUIRED' });
  expect(mockFetch).not.toHaveBeenCalled(); expect(await journal().countDocuments()).toBe(0);
});

test('future-created records are not fresh-today proof', async () => {
  await Payment.collection.updateOne({ _id: payment._id }, { $set: { createdAt: new Date(Date.now() + 1000) } });
  await expect(run('simulate-missing-context')).rejects.toMatchObject({ code: 'QA_FRESH_TODAY_PAYMENT_REQUIRED' });
});

test.each([
  ['active operation lease', { 'savedCardAuthentication.operationLeaseUntil': new Date(Date.now() + 60000) }],
  ['pending reset', { 'savedCardAuthentication.resetStartedAt': new Date() }],
])('refuses to disturb %s', async (_, fields) => {
  await Payment.updateOne({ _id: payment._id }, { $set: fields });
  await expect(run('simulate-missing-context')).rejects.toMatchObject({ code: 'QA_AUTHENTICATION_OPERATION_ACTIVE' });
  expect(mockFetch).not.toHaveBeenCalled(); expect(await journal().countDocuments()).toBe(0);
});

test.each([
  ['charge', candidate => { candidate.charge = { token: 'chg_qa-fixture' }; }],
  ['authorized state', candidate => { candidate.state = 'TRACKER_AUTHORIZED'; }],
  ['ended state', candidate => { candidate.state = 'TRACKER_ENDED'; }],
])('fresh provider %s evidence refuses context loss', async (_, alter) => {
  alter(tracker);
  await expect(run('simulate-missing-context')).rejects.toMatchObject({ code: 'QA_UNCAPTURED_SETUP_EVIDENCE_REQUIRED' });
  expect(await journal().countDocuments()).toBe(0);
  expect((await fullPayment()).savedCardAuthentication.encryptedContext).toBe('test-encrypted-context-not-for-output');
});

test('fresh provider money or ownership mismatch is rejected by the actual client', async () => {
  tracker.customer = 'cus_wrong-qa-fixture';
  await expect(run('simulate-missing-context')).rejects.toMatchObject({ code: 'SAFEPAY_PAYMENT_MISMATCH' });
  expect(await journal().countDocuments()).toBe(0);
});

test('a nonreusable/expired card is rejected by the actual owned-card service', async () => {
  card.expires_at.seconds = 1;
  await expect(run('simulate-missing-context')).rejects.toMatchObject({ code: 'SAFEPAY_REUSABLE_CARD_REQUIRED' });
  expect(await journal().countDocuments()).toBe(0);
});

test('original-context compare-and-set rollback prevents clearing a newer setup and rolls back its journal', async () => {
  beforeTrackerReturn = () => Payment.updateOne({ _id: payment._id }, { $set: { 'savedCardAuthentication.encryptedContext': 'test-context-changed-by-another-setup' } });
  await expect(run('simulate-missing-context')).rejects.toMatchObject({ code: 'QA_ORIGINAL_CONTEXT_CHANGED' });
  expect(await journal().countDocuments()).toBe(0);
  expect((await fullPayment()).savedCardAuthentication.encryptedContext).toBe('test-context-changed-by-another-setup');
});

test('a concurrently claimed operation rejects simulation and rolls back its journal', async () => {
  beforeTrackerReturn = () => Payment.updateOne({ _id: payment._id }, { $set: { 'savedCardAuthentication.operationLeaseUntil': new Date(Date.now() + 60000) } });
  await expect(run('simulate-missing-context')).rejects.toMatchObject({ code: 'QA_AUTHENTICATION_OPERATION_ACTIVE' });
  expect(await journal().countDocuments()).toBe(0);
});

test('CLI mode must be explicit for mutation; omitted mode is always inspect', () => {
  const paymentId = String(payment._id);
  expect(qa.parseArgs([paymentId])).toEqual({ paymentId, mode: 'inspect' });
  expect(qa.parseArgs(['inspect', paymentId])).toEqual({ paymentId, mode: 'inspect' });
  expect(qa.parseArgs(['simulate-missing-context', paymentId])).toEqual({ paymentId, mode: 'simulate-missing-context' });
  expect(qa.parseArgs(['simulate-setup-reply-loss', paymentId])).toEqual({ paymentId, mode: 'simulate-setup-reply-loss' });
  expect(() => qa.parseArgs(['--force', paymentId])).toThrow('QA_EXACT_PAYMENT_AND_MODE_REQUIRED');
  expect(() => qa.parseArgs([])).toThrow('QA_EXACT_PAYMENT_AND_MODE_REQUIRED');
  expect(() => qa.parseArgs(['simulate-missing-context', 'wrong-id'])).toThrow('QA_EXACT_PAYMENT_AND_MODE_REQUIRED');
});

async function unstartedPayment() {
  await Payment.updateOne({ _id: payment._id }, { $set: { 'savedCardAuthentication.setupStartedAt': null,
    'savedCardAuthentication.encryptedContext': '', 'savedCardAuthentication.expiresAt': null } });
  tracker.next_actions.CYBERSOURCE.kind = 'PAYER_AUTH_SETUP';
}
// A fresh Node process is essential: Jest has its own module registry and does
// not implement Node require.cache eviction. Exercise the actual CLI isolation,
// restoration and source modules against this test's disposable Mongo database.
async function nodeSourceFault(scenario = 'success') {
  const source = `
  (async () => {
    const mongoose = require('mongoose');
    await mongoose.connect(process.env.TEST_MONGO_URI, { autoIndex:false, autoCreate:false });
    try {
      const Payment = require('./models/SafepayPayment');
      const payment = await Payment.findById(process.env.TEST_PAYMENT_ID).select('+cardId');
      const tracker = { token:payment.tracker, environment:'sandbox', client:process.env.SAFEPAY_SANDBOX_PUBLIC_KEY,
        mode:'payment', entry_mode:'tms', customer:payment.customerId, metadata:{ data:{ order_id:payment.reference } },
        purchase_totals:{ quote_amount:{ amount:payment.amountMinor, currency:payment.currency } }, state:'TRACKER_STARTED',
        next_actions:{ CYBERSOURCE:{ kind:'PAYER_AUTH_SETUP' } }, charge:null };
      const card = { token:payment.cardId, customer:payment.customerId, merchant_api_key:process.env.SAFEPAY_SANDBOX_PUBLIC_KEY,
        is_deleted:false, max_usage:-1, expires_at:{ seconds:2200000000 }, cybersource:{ token:'tms_qa-test-fixture', last_four:'1111' } };
      let setupPosts=0, forbiddenCalls=0;
      globalThis.fetch = async (url,options) => {
        const path = new URL(url).pathname;
        let data;
        if(options.method==='GET' && path==='/reporter/api/v1/payments/'+payment.tracker) data=structuredClone(tracker);
        else if(options.method==='GET' && path==='/user/customers/v1/'+payment.customerId+'/wallet/'+payment.cardId) data=structuredClone(card);
        else if(options.method==='POST' && path==='/order/payments/v3/'+payment.tracker) {
          const expected={ payload:{ payment_method:{ tokenized_card:{ token:payment.cardId } } }, use_action_chaining:false };
          if(JSON.stringify(JSON.parse(options.body))!==JSON.stringify(expected)) { forbiddenCalls++;throw Error('unexpected setup payload'); }
          setupPosts++;
          if(process.env.TEST_SCENARIO==='reject') return { ok:false,status:400,json:async()=>({ status:{ errors:['test rejection'] } }) };
          if(process.env.TEST_SCENARIO!=='no-advance') tracker.next_actions.CYBERSOURCE.kind='PAYER_AUTH_ENROLLMENT';
          data={ tracker:structuredClone(tracker), action:{ payer_authentication_setup:{ access_token:'private-response-fixture',device_data_collection_url:'https://centinelapistag.cardinalcommerce.com/V1/Cruise/Collect' } } };
        } else { forbiddenCalls++;throw Error('forbidden provider operation'); }
        return { ok:true,status:200,json:async()=>({ data }) };
      };
      const savedSource = require('./services/safepaySavedCardCheckoutService');
      const originalFactory = require('./services/safepayClient').createSafepayClient;
      const qa = require('./scripts/verifySafepayAuthenticationRecoveryQa');
      let proof=null,errorCode='',repeatCode='';
      try { proof=await qa.verifyAuthenticationRecoveryQa({ paymentId:String(payment._id),mode:'simulate-setup-reply-loss' }); }
      catch(error) { errorCode=error.code||'TEST_ERROR'; }
      try { await qa.verifyAuthenticationRecoveryQa({ paymentId:String(payment._id),mode:'simulate-setup-reply-loss' }); }
      catch(error) { repeatCode=error.code||'TEST_ERROR'; }
      const receipt = await mongoose.connection.collection(qa.JOURNAL_COLLECTION).findOne({ _id:qa.NAMESPACE+':'+payment._id });
      process.stdout.write(JSON.stringify({ proof,errorCode,repeatCode,setupPosts,forbiddenCalls,journalOutcome:receipt?.outcome,
        factoryRestored:require('./services/safepayClient').createSafepayClient===originalFactory,
        sourceRestored:require('./services/safepaySavedCardCheckoutService')===savedSource }));
    } finally { await mongoose.disconnect(); }
  })().catch(error=>{ process.stdout.write(JSON.stringify({ childError:error.code||error.name }));process.exitCode=1 });`;
  const { stdout } = await execFile(process.execPath, ['-e', source], {
    cwd: require('node:path').resolve(__dirname, '../..'), timeout: 30000,
    env: { ...process.env, TEST_MONGO_URI: repl.getUri(), TEST_PAYMENT_ID: String(payment._id), TEST_SCENARIO: scenario },
  });
  return JSON.parse(stdout);
}
test('real authenticate source persists intent after exactly one successful setup reply is discarded, without context/auth/capture', async () => {
  await unstartedPayment();
  const before = await fullPayment();
  const result = await nodeSourceFault();
  expect(result.errorCode).toBe('');
  const proof = result.proof;
  expect(proof).toMatchObject({ mode: 'simulate-setup-reply-loss', simulatedLocalTransportReplyLoss: true,
    simulatedPersistedResponseLoss: false, setupPosts: 1, setupReplyDiscarded: true, setupIntentPresent: true,
    contextPresent: false, providerHasCharge: false });
  const after = await fullPayment();
  expect(after.savedCardAuthentication.setupStartedAt).toBeInstanceOf(Date);
  expect(after.savedCardAuthentication.encryptedContext).toBe(''); expect(after.savedCardAuthentication.expiresAt).toBeNull();
  for (const field of ['user', 'amountMinor', 'currency', 'customerId', 'cardId', 'tracker', 'purpose', 'status', 'capturedMinor', 'refundedMinor', 'walletRefundMinor', 'appliedAt']) {
    expect(after[field]).toEqual(before[field]);
  }
  expect(result.setupPosts).toBe(1); expect(result.forbiddenCalls).toBe(0);
  expect(await journal().countDocuments()).toBe(1);
  expect((await journal().findOne({ _id: `${qa.NAMESPACE}:${payment._id}` })).outcome).toBe('verified');
  expect(result.factoryRestored).toBe(true); expect(result.sourceRestored).toBe(true);
  expect(JSON.stringify(proof)).not.toContain('private-'); expect(JSON.stringify(proof)).not.toContain(payment.cardId);
  expect(result.repeatCode).toBe('QA_SIMULATION_ALREADY_RECORDED');
});

test('source fault mode refuses an already started setup before outbound mutation', async () => {
  await expect(run('simulate-setup-reply-loss')).rejects.toMatchObject({ code: 'QA_UNSTARTED_SETUP_REQUIRED' });
  expect(mockFetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
  expect(await journal().countDocuments()).toBe(0);
});

test('transport guard rejects capture/authorization, reset, token creation and tracker creation before outbound fetch', async () => {
  const config = require('../../config/safepay').readSafepayConfig();
  const outbound = jest.fn();
  const transport = qa.createSetupReplyLossTransport(payment, config, outbound);
  const setupUrl = `${config.apiHost}/order/payments/v3/${payment.tracker}`;
  const withCapture = { payload: { payment_method: { tokenized_card: { token: payment.cardId } }, authorization: { do_capture: true } }, use_action_chaining: false };
  await expect(transport.fetchImpl(setupUrl, { method: 'POST', body: JSON.stringify(withCapture) })).rejects.toMatchObject({ code: 'QA_NETWORK_MUTATION_REJECTED' });
  await expect(transport.fetchImpl(setupUrl, { method: 'PUT', body: '{}' })).rejects.toMatchObject({ code: 'QA_NETWORK_MUTATION_REJECTED' });
  await expect(transport.fetchImpl(`${config.apiHost}/client/passport/v1/token`, { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'QA_NETWORK_MUTATION_REJECTED' });
  await expect(transport.fetchImpl(`${config.apiHost}/order/payments/v3/`, { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'QA_NETWORK_MUTATION_REJECTED' });
  await expect(transport.fetchImpl(`https://api.getsafepay.com/order/payments/v3/${payment.tracker}`, { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'QA_NETWORK_SCOPE_REJECTED' });
  expect(outbound).not.toHaveBeenCalled(); expect(transport.evidence().setupPosts).toBe(0);
});

test('transport guard permits exactly one setup POST and consumes it even when its reply is discarded', async () => {
  const config = require('../../config/safepay').readSafepayConfig();
  const outbound = jest.fn(async () => ({ ok: true, body: { cancel: jest.fn(async () => {}) } }));
  const transport = qa.createSetupReplyLossTransport(payment, config, outbound);
  const url = `${config.apiHost}/order/payments/v3/${payment.tracker}`;
  const options = { method: 'POST', body: JSON.stringify({ payload: { payment_method: { tokenized_card: { token: payment.cardId } } }, use_action_chaining: false }) };
  await expect(transport.fetchImpl(url, options)).rejects.toMatchObject({ code: 'QA_SIMULATED_SETUP_REPLY_LOSS', outcomeUnknown: true });
  await expect(transport.fetchImpl(url, options)).rejects.toMatchObject({ code: 'QA_NETWORK_MUTATION_REJECTED' });
  expect(outbound).toHaveBeenCalledTimes(1); expect(transport.evidence()).toEqual({ setupPosts: 1, setupReplyDiscarded: true });
});

test('an upstream rejection consumes the source-fault journal and is reported unverified, never retried', async () => {
  await unstartedPayment();
  const result = await nodeSourceFault('reject');
  expect(result.errorCode).toBe('QA_SETUP_FAULT_NOT_ESTABLISHED');
  expect((await journal().findOne({ _id: `${qa.NAMESPACE}:${payment._id}` })).outcome).toBe('not_verified');
  expect(result.factoryRestored).toBe(true); expect(result.repeatCode).toBe('QA_SIMULATION_ALREADY_RECORDED');
  expect(result.setupPosts).toBe(1); expect(result.forbiddenCalls).toBe(0);
});

test('HTTP200 alone is not setup proof unless fresh owned provider evidence confirms enrollment/validation', async () => {
  await unstartedPayment();
  const result = await nodeSourceFault('no-advance');
  expect(result.errorCode).toBe('QA_SETUP_FAULT_NOT_ESTABLISHED');
  expect((await journal().findOne({ _id: `${qa.NAMESPACE}:${payment._id}` })).outcome).toBe('not_verified');
  expect(result.setupPosts).toBe(1); expect(result.forbiddenCalls).toBe(0); expect(result.factoryRestored).toBe(true);
});
