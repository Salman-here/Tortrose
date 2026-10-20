import { presentSafepaySheet } from './safepaySheet';

const HOSTS = { sandbox: 'sandbox.api.getsafepay.com', production: 'getsafepay.com' };
const ID = /^[a-f0-9]{24}$/i;
const unwrap = response => response?.data || response || {};
const failure = message => Object.assign(new Error(message), { code: 'SAFEPAY_CHECKOUT_INVALID' });
const aborted = () => Object.assign(new Error('Payment verification stopped.'), { code: 'SAFEPAY_VERIFICATION_ABORTED' });
export const getSafepayCheckoutChoice = (method, cardId = '') => method === 'card'
  ? cardId && cardId !== 'raast' ? `saved:${cardId}` : 'new-card' : method;
export const safepayPaymentExpectation = payment => Object.fromEntries(
  ['paymentId', 'environment', 'purpose', 'currency', 'amountMinor', 'paymentRail'].filter(key => payment?.[key] !== undefined).map(key => [key, payment[key]]));
const hasConfirmedRail = payment => payment?.status === 'paid' && payment.isPaid === true && payment.webhookProcessed === true
  || payment?.purpose === 'card_setup' && payment.status === 'authorized' && payment.cardSaved === true && payment.completed === true
  || ['refund_pending', 'refunded', 'manual_review', 'reversed'].includes(payment?.status) && (
    Number.isSafeInteger(payment.capturedMinor) && payment.capturedMinor > 0 && payment.capturedMinor <= payment.amountMinor
    || ['TRACKER_ENDED', 'TRACKER_REFUNDED', 'TRACKER_PARTIAL_REFUND', 'TRACKER_DISPUTED'].includes(payment.providerState));
const requirePaymentRail = (payment, expected) => {
  const rail = payment.paymentRail ?? 'unknown';
  if (!['unknown', 'card', 'raast'].includes(rail) || rail === 'raast' && (payment.currency !== 'PKR'
      || payment.purpose === 'card_setup'
      || payment.checkoutPresentation === 'saved-card' && payment.cardEntryRequired !== true
      || expected?.checkoutPresentation === 'saved-card' && expected.cardEntryRequired !== true)
    || hasConfirmedRail(expected) && expected.paymentRail && expected.paymentRail !== 'unknown' && rail !== expected.paymentRail) {
    throw failure('The verified payment method is invalid. Check this same payment again.');
  }
  return { ...payment, paymentRail: rail };
};

export function validateSafepayCheckout(response) {
  const payment = requirePaymentRail(unwrap(response));
  if (payment.paymentMethod !== 'safepay' || payment.paymentFlow !== 'safepay_hosted'
    || !ID.test(String(payment.paymentId || '')) || !HOSTS[payment.environment]) {
    throw failure('Secure Safepay checkout did not return a valid payment reference.');
  }
  if ((payment.isPaid === true && payment.status === 'paid')
    || (payment.purpose === 'card_setup' && payment.completed === true && payment.status === 'authorized')) return payment;
  if (payment.purpose === 'card_setup' && payment.amountMinor === 0 && payment.isPaid === false
    && payment.completed === false && payment.cardSaved === false && ['failed', 'cancelled'].includes(payment.status)) return payment;
  let url;
  try { url = new URL(payment.checkoutUrl || payment.url); } catch (_) { throw failure('The secure payment link is unavailable.'); }
  if (payment.checkoutPresentation === 'saved-card') {
    if (payment.paymentRail === 'raast' || url.protocol !== 'https:' || url.hostname !== 'rozare.up.railway.app' || url.port || url.username || url.password
      || url.pathname !== `/api/safepay/saved-checkout/${payment.paymentId}` || url.search
      || !/^#ticket=[A-Za-z0-9_.%-]+$/.test(url.hash) || payment.purpose === 'card_setup'
      || typeof payment.checkoutSessionGrant !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(payment.checkoutSessionGrant)) {
      throw failure('The saved-card verification screen does not belong to this payment.');
    }
    return { ...payment, checkoutUrl: url.toString() };
  }
  if (url.protocol !== 'https:' || url.hostname !== HOSTS[payment.environment] || url.port
    || url.username || url.password || !['/embedded/', '/checkout/subscribe'].includes(url.pathname)) {
    throw failure('The payment link does not belong to the configured Safepay environment.');
  }
  return { ...payment, checkoutUrl: url.toString() };
}

export function normalizeSafepayStatus(response, expectedPaymentId, expected) {
  const payment = requirePaymentRail(unwrap(response), expected);
  if (payment.paymentMethod !== 'safepay' || String(payment.paymentId) !== String(expectedPaymentId)
    || !ID.test(String(expectedPaymentId || '')) || !HOSTS[payment.environment]) {
    throw failure('Payment verification returned a different payment reference.');
  }
  if (expected && ['environment', 'purpose', 'currency', 'amountMinor'].some(key => expected[key] !== undefined && payment[key] !== expected[key])) {
    throw failure('Payment verification returned different checkout details.');
  }
  const status = payment.purpose === 'card_setup' && payment.status === 'authorized' && payment.cardSaved === true && payment.completed === true
    ? 'authorized' : payment.status === 'paid' && payment.isPaid === true && payment.webhookProcessed === true
    ? 'paid' : ['cancelled', 'failed', 'refunded', 'refund_pending', 'manual_review', 'reversed'].includes(payment.status) ? payment.status : 'pending';
  return { ...payment, status, isPaid: status === 'paid' };
}

// Axios' normal timeout also covers unrelated requests and can be retried by
// interceptors. Bound this read itself so a closed sheet can never trap a button.
async function readPaymentStatus(apiClient, paymentId, timeoutMs, signal) {
  const controller = new AbortController();
  let timer, onAbort;
  try {
    if (signal?.aborted) throw aborted();
    return await Promise.race([
      Promise.resolve().then(() => apiClient.get(`/api/safepay/payments/${paymentId}`, {
        timeout: timeoutMs, signal: controller.signal,
      })),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error('Payment verification is pending.'), { code: 'SAFEPAY_STATUS_TIMEOUT' }));
      }, timeoutMs); }),
      ...(signal ? [new Promise((_, reject) => { onAbort = () => { controller.abort(); reject(aborted()); };
        signal.addEventListener('abort', onAbort, { once: true }); })] : []),
    ]);
  } finally { clearTimeout(timer); if (onAbort) signal.removeEventListener('abort', onAbort); }
}

function waitForVerification(ms, signal) {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(aborted()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

export async function verifySafepayPayment({ apiClient, paymentId, expectedPayment, attempts = 4, delayMs = 1200, requestTimeoutMs = 5000,
  sleep, signal }) {
  if (!ID.test(String(paymentId || ''))) throw failure('A valid payment reference is required.');
  let last = { status: 'pending', paymentId, isPaid: false };
  for (let index = 0; index < Math.max(1, Math.min(attempts, 10)); index++) {
    if (signal?.aborted) throw aborted();
    try {
      last = normalizeSafepayStatus(await readPaymentStatus(apiClient, paymentId,
        Math.max(1, Math.min(requestTimeoutMs, 15000)), signal), paymentId, expectedPayment || last);
      if (last.status !== 'pending') return last;
    } catch (error) {
      if (signal?.aborted || error.code === 'SAFEPAY_VERIFICATION_ABORTED') throw aborted();
      if (error.code === 'SAFEPAY_CHECKOUT_INVALID' || [401, 403, 404].includes(error.response?.status)) throw error;
      last = { ...last, status: 'pending', message: 'Payment verification is still pending. Please check again before starting another payment.' };
    }
    if (index + 1 < Math.max(1, Math.min(attempts, 10))) await (sleep ? sleep(delayMs) : waitForVerification(delayMs, signal));
  }
  return last;
}

export async function retireSafepayCheckout({ apiClient, paymentId, expectedPayment }) {
  if (!ID.test(String(paymentId || ''))) throw failure('A valid payment reference is required.');
  const response = await apiClient.post(`/api/safepay/payments/${paymentId}/retire-checkout`, { clientSurface: 'mobile' });
  const data = unwrap(response), verified = normalizeSafepayStatus(data, paymentId, expectedPayment);
  if (data.checkoutRetired === true && (verified.purpose !== 'order' || !['pending', 'cancelled', 'failed'].includes(verified.status))) {
    throw failure('Check the previous payment before changing payment methods.');
  }
  return { ...verified, checkoutRetired: data.checkoutRetired === true };
}

export async function openSafepayCheckout({ apiClient, response, openSheet = presentSafepaySheet, openBrowser }) {
  const payment = validateSafepayCheckout(response);
  let returned = null;
  if (!payment.isPaid && !(payment.purpose === 'card_setup' && ['authorized', 'failed', 'cancelled'].includes(payment.status))) {
    // The return URL is just navigation. Even cancel/dismiss may race a
    // successful charge, so always ask our authenticated backend afterwards.
    // openBrowser is an injected test adapter; production uses the app sheet.
    try { returned = await (openBrowser ? openBrowser(payment.checkoutUrl) : openSheet(payment)); }
    catch (_) { /* Keep the same attempt and verify; never silently start again. */ }
  }
  // A single short authenticated check catches a success racing dismissal.
  // Anything still uncertain belongs to the same attempt's check/resume screen,
  // not a minute of blocking retries on the originating payment button.
  const verified = await verifySafepayPayment({ apiClient, paymentId: payment.paymentId, expectedPayment: payment,
    attempts: 1, requestTimeoutMs: 2000 });
  return { ...verified, browserDismissed: returned?.type === 'cancel' || returned?.type === 'dismiss' };
}

export async function resumeSafepayCheckout({ apiClient, paymentId, ...options }) {
  if (!ID.test(String(paymentId || ''))) throw failure('A valid payment reference is required.');
  try {
    const response = await apiClient.post(`/api/safepay/payments/${paymentId}/reopen`, { clientSurface: 'mobile' });
    if (String(unwrap(response).paymentId) !== String(paymentId)) throw failure('The original payment could not be verified.');
    return openSafepayCheckout({ apiClient, response, ...options });
  } catch (error) {
    if (error.response?.data?.code !== 'SAFEPAY_CHECKOUT_CLOSED') throw error;
    return verifySafepayPayment({ apiClient, paymentId, attempts: 1, requestTimeoutMs: 2000 });
  }
}
