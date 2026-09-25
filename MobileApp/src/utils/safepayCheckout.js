import { presentSafepaySheet } from './safepaySheet';

const HOSTS = { sandbox: 'sandbox.api.getsafepay.com', production: 'getsafepay.com' };
const ID = /^[a-f0-9]{24}$/i;
const unwrap = response => response?.data || response || {};
const failure = message => Object.assign(new Error(message), { code: 'SAFEPAY_CHECKOUT_INVALID' });

export function validateSafepayCheckout(response) {
  const payment = unwrap(response);
  if (payment.paymentMethod !== 'safepay' || payment.paymentFlow !== 'safepay_hosted'
    || !ID.test(String(payment.paymentId || '')) || !HOSTS[payment.environment]) {
    throw failure('Secure Safepay checkout did not return a valid payment reference.');
  }
  if ((payment.isPaid === true && payment.status === 'paid')
    || (payment.purpose === 'card_setup' && payment.completed === true && payment.status === 'authorized')) return payment;
  let url;
  try { url = new URL(payment.checkoutUrl || payment.url); } catch (_) { throw failure('The secure payment link is unavailable.'); }
  if (url.protocol !== 'https:' || url.hostname !== HOSTS[payment.environment] || url.port
    || url.username || url.password || !['/embedded/', '/checkout/subscribe'].includes(url.pathname)) {
    throw failure('The payment link does not belong to the configured Safepay environment.');
  }
  return { ...payment, checkoutUrl: url.toString() };
}

export function normalizeSafepayStatus(response, expectedPaymentId) {
  const payment = unwrap(response);
  if (payment.paymentMethod !== 'safepay' || String(payment.paymentId) !== String(expectedPaymentId)
    || !ID.test(String(expectedPaymentId || '')) || !HOSTS[payment.environment]) {
    throw failure('Payment verification returned a different payment reference.');
  }
  const status = payment.purpose === 'card_setup' && payment.status === 'authorized' && payment.cardSaved === true && payment.completed === true
    ? 'authorized' : payment.status === 'paid' && payment.isPaid === true && payment.webhookProcessed === true
    ? 'paid' : ['cancelled', 'failed', 'refunded', 'refund_pending', 'manual_review'].includes(payment.status) ? payment.status : 'pending';
  return { ...payment, status, isPaid: status === 'paid' };
}

export async function verifySafepayPayment({ apiClient, paymentId, attempts = 4, delayMs = 1200,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!ID.test(String(paymentId || ''))) throw failure('A valid payment reference is required.');
  let last = { status: 'pending', paymentId, isPaid: false };
  for (let index = 0; index < Math.max(1, Math.min(attempts, 10)); index++) {
    try {
      last = normalizeSafepayStatus(await apiClient.get(`/api/safepay/payments/${paymentId}`), paymentId);
      if (last.status !== 'pending') return last;
    } catch (error) {
      if (error.code === 'SAFEPAY_CHECKOUT_INVALID' || [401, 403, 404].includes(error.response?.status)) throw error;
      last = { ...last, status: 'pending', message: 'Payment verification is still pending. Please check again before starting another payment.' };
    }
    if (index + 1 < attempts) await sleep(delayMs);
  }
  return last;
}

export async function openSafepayCheckout({ apiClient, response, openSheet = presentSafepaySheet, openBrowser }) {
  const payment = validateSafepayCheckout(response);
  let returned = null;
  if (!payment.isPaid && !(payment.purpose === 'card_setup' && payment.status === 'authorized')) {
    // The return URL is just navigation. Even cancel/dismiss may race a
    // successful charge, so always ask our authenticated backend afterwards.
    // openBrowser is an injected test adapter; production uses the app sheet.
    try { returned = await (openBrowser ? openBrowser(payment.checkoutUrl) : openSheet(payment)); }
    catch (_) { /* Keep the same attempt and verify; never silently start again. */ }
  }
  const verified = await verifySafepayPayment({ apiClient, paymentId: payment.paymentId });
  return { ...verified, browserDismissed: returned?.type === 'cancel' || returned?.type === 'dismiss' };
}
