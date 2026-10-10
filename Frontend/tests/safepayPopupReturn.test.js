import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkSafepayPopupSession, isSafepayPopupReturn, notifySafepayParent,
  SAFEPAY_BACKEND_ORIGIN, SAFEPAY_RETURN_MESSAGE, SAFEPAY_STATUS_TIMEOUT_MS,
  safepayVerificationError } from '../src/utils/safepayPopupReturn.js';

const paymentId = '6ab6e12cba71edafe4fc6c5b';
const payment = { paymentId, status: 'pending', isPaid: false };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(verify) {
  const session = { payment, checking: false, closeRequested: false, retryNotBefore: 0 };
  const finished = [], notices = [], checking = [];
  let active = session;
  const options = { verify, finish: result => { finished.push(result); active = null; },
    notice: value => notices.push(value), checking: value => checking.push(value),
    isCurrent: value => value === active, retryAfter: () => 0, now: () => 1000 };
  return { session, options, finished, notices, checking, setActive: value => { active = value; } };
}

test('only exact return type, frame, payment and trusted origin are navigation signals', () => {
  const frameWindow = {}, appOrigin = 'https://rozare.com';
  const event = { source: frameWindow, origin: SAFEPAY_BACKEND_ORIGIN, data: { type: SAFEPAY_RETURN_MESSAGE, paymentId } };
  const expected = { frameWindow, appOrigin, paymentId };
  assert.equal(isSafepayPopupReturn(event, expected), true);
  assert.equal(isSafepayPopupReturn({ ...event, origin: appOrigin }, expected), true);
  for (const changed of [{ origin: 'https://rozare.up.railway.app.evil.test' }, { origin: 'http://rozare.up.railway.app' },
    { origin: 'https://getsafepay.com' }, { origin: 'null' }, { source: {} }, { source: null },
    { data: { type: SAFEPAY_RETURN_MESSAGE, paymentId: 'a'.repeat(24) } },
    { data: { type: 'rozare-saved-card-ready', paymentId } }, { data: null }]) {
    assert.equal(isSafepayPopupReturn({ ...event, ...changed }, expected), false);
  }
  assert.equal(isSafepayPopupReturn(event, { ...expected, frameWindow: null }), false);
  assert.equal(isSafepayPopupReturn(event, { ...expected, paymentId: 'bad' }), false);
  // Even a hostile status attached to a valid navigation message is not read.
  assert.equal(isSafepayPopupReturn({ ...event, data: { ...event.data, status: 'paid', outcome: 'cancel' } }, expected), true);
});

test('frontend fallback notifies its own origin without credentials or payment claims', () => {
  const messages = [];
  const browser = { parent: { postMessage: (...args) => messages.push(args) }, location: { origin: 'https://rozare.com' } };
  assert.equal(notifySafepayParent(browser, paymentId), true);
  assert.deepEqual(messages, [[{ type: SAFEPAY_RETURN_MESSAGE, paymentId }, 'https://rozare.com']]);
  assert.equal(notifySafepayParent(browser, 'bad'), false);
  browser.parent = browser;
  assert.equal(notifySafepayParent(browser, paymentId), false);
  assert.equal(messages.length, 1);
});

test('cancel/close queued during verification reuses that request and resolves pending, not cancelled', async () => {
  const response = deferred(); let requests = 0;
  const f = fixture(() => { requests++; return response.promise; });
  const running = checkSafepayPopupSession(f.session, f.options);
  await checkSafepayPopupSession(f.session, { ...f.options, closing: true });
  await checkSafepayPopupSession(f.session, { ...f.options, closing: true });
  assert.equal(requests, 1); assert.equal(f.finished.length, 0);
  response.resolve(payment); await running;
  assert.deepEqual(f.finished, [payment]); assert.equal(f.session.checking, false);
});

test('verified results survive a concurrent close and navigation cannot override them', async () => {
  for (const status of ['paid', 'authorized', 'cancelled', 'failed', 'refunded', 'refund_pending', 'manual_review']) {
    const response = deferred(); const f = fixture(() => response.promise);
    const running = checkSafepayPopupSession(f.session, f.options);
    await checkSafepayPopupSession(f.session, { ...f.options, closing: true });
    const result = { ...payment, status, isPaid: status === 'paid' };
    response.resolve(result); await running;
    assert.deepEqual(f.finished, [result]);
  }
});

test('timeout after return closes with unknown/pending and never promotes success', async () => {
  const response = deferred(); const f = fixture(() => response.promise);
  const running = checkSafepayPopupSession(f.session, f.options);
  await checkSafepayPopupSession(f.session, { ...f.options, closing: true });
  response.reject(Object.assign(new Error('timeout of 45000ms exceeded'), { code: 'ECONNABORTED' }));
  await running;
  assert.deepEqual(f.finished, [{ paymentId, status: 'pending', isPaid: false }]);
});

test('closing during Retry-After needs no extra request and preserves unresolved payment', async () => {
  let requests = 0; const f = fixture(async () => { requests++; return payment; });
  f.session.retryNotBefore = 2000;
  await checkSafepayPopupSession(f.session, f.options);
  assert.equal(f.finished.length, 0); assert.equal(f.notices.length, 1);
  await checkSafepayPopupSession(f.session, { ...f.options, closing: true });
  assert.equal(requests, 0); assert.equal(f.finished[0].status, 'pending');
});

test('late old verification cannot settle or clear checking for a newer payment session', async () => {
  for (const fails of [false, true]) {
    const response = deferred(); const f = fixture(() => response.promise);
    const running = checkSafepayPopupSession(f.session, f.options);
    f.setActive({ payment: { paymentId: 'a'.repeat(24) }, checking: true });
    if (fails) response.reject(new Error('Old request failed'));
    else response.resolve({ ...payment, status: 'paid', isPaid: true });
    await running;
    assert.deepEqual(f.finished, []); assert.deepEqual(f.notices, []); assert.deepEqual(f.checking, [true]);
  }
});

test('pending polling stays open, 429 backs off, and no raw network timeout is exposed', async () => {
  const pending = fixture(async () => payment);
  await checkSafepayPopupSession(pending.session, pending.options);
  assert.equal(pending.finished.length, 0); assert.deepEqual(pending.checking, [true, false]);
  const paused = fixture(async () => { throw { response: { status: 429 } }; });
  await checkSafepayPopupSession(paused.session, { ...paused.options, retryAfter: () => 60000 });
  assert.equal(paused.session.retryNotBefore, 61000);
  const timeout = Object.assign(new Error('timeout of 20000ms exceeded'), { code: 'ECONNABORTED' });
  assert.match(safepayVerificationError(timeout), /taking longer/);
  assert.doesNotMatch(safepayVerificationError(timeout), /20000|Axios|ECONNABORTED/);
  assert.match(safepayVerificationError(new Error('Network Error')), /temporarily unavailable/);
  assert.equal(SAFEPAY_STATUS_TIMEOUT_MS, 45000);
});

test('return fallback is standalone without marketplace chrome or a second iframe poll', () => {
  const page = readFileSync(new URL('../src/pages/SafepayReturnPage.jsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const routes = readFileSync(new URL('../src/routes/AppRoutes.jsx', import.meta.url), 'utf8');
  const provider = readFileSync(new URL('../src/components/common/SafepayCheckoutProvider.jsx', import.meta.url), 'utf8');
  assert.match(provider, /key=\{`\$\{payment\.paymentId\}:\$\{payment\.popupGeneration\}`\}/);
  assert.match(page, /if \(embedded \|\| resuming/);
  assert.match(page, /if \(embedded\) notifySafepayParent/);
  assert.match(app, /!paymentReturn && <TestPhaseNotice/);
  assert.match(app, /!paymentReturn && <ShoppingLocationPrompt/);
  assert.ok(routes.indexOf("path='/safepay/return'") > routes.indexOf("path='/login'"));
  assert.doesNotMatch(page, /err\.message/);
});
