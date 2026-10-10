const HOSTS = { sandbox: 'sandbox.api.getsafepay.com', production: 'getsafepay.com' };
const ID = /^[a-f0-9]{24}$/i;
const PURPOSES = new Set(['order', 'wallet_top_up', 'card_setup', 'subdomain', 'return_settlement']);
const fail = () => Object.assign(new Error('The secure payment response could not be verified. Please retry the same attempt.'), { code: 'SAFEPAY_CHECKOUT_INVALID', retainMutationAttempt: true });
const hasConfirmedRail = payment => payment?.status === 'paid' && payment.isPaid === true && payment.webhookProcessed === true
  || payment?.purpose === 'card_setup' && payment.status === 'authorized' && payment.cardSaved === true && payment.completed === true
  || ['refund_pending', 'refunded', 'manual_review'].includes(payment?.status) && (
    Number.isSafeInteger(payment.capturedMinor) && payment.capturedMinor > 0 && payment.capturedMinor <= payment.amountMinor
    || ['TRACKER_ENDED', 'TRACKER_REFUNDED', 'TRACKER_PARTIAL_REFUND', 'TRACKER_DISPUTED'].includes(payment.providerState));
export const validateSafepayPayment = (payment, expected) => {
  if (!payment || payment.paymentMethod !== 'safepay' || payment.paymentFlow !== 'safepay_hosted'
    || !ID.test(payment.paymentId) || !HOSTS[payment.environment] || !PURPOSES.has(payment.purpose)
    || !['PKR', 'USD', 'EUR', 'GBP'].includes(payment.currency) || !Number.isSafeInteger(payment.amountMinor) || payment.amountMinor < 0
    || (payment.purpose !== 'card_setup' && payment.amountMinor === 0)) throw fail();
  if (expected && ['paymentId', 'environment', 'purpose', 'currency', 'amountMinor'].some(key => payment[key] !== expected[key])) throw fail();
  const paymentRail = payment.paymentRail ?? 'unknown';
  if (!['unknown', 'card', 'raast'].includes(paymentRail) || paymentRail === 'raast' && (payment.currency !== 'PKR'
      || payment.purpose === 'card_setup' || payment.checkoutPresentation === 'saved-card' || expected?.checkoutPresentation === 'saved-card')
    || hasConfirmedRail(expected) && expected.paymentRail && expected.paymentRail !== 'unknown' && paymentRail !== expected.paymentRail) throw fail();
  const status = payment.status === 'paid' && payment.isPaid === true && payment.webhookProcessed === true ? 'paid'
    : payment.purpose === 'card_setup' && payment.status === 'authorized' && payment.cardSaved === true && payment.completed === true ? 'authorized'
    : ['cancelled', 'failed', 'refunded', 'refund_pending', 'manual_review'].includes(payment.status) ? payment.status : 'pending';
  return { ...payment, paymentRail, status, isPaid: status === 'paid' };
};
export const validateSafepayCheckout = response => {
  const payment = validateSafepayPayment(response?.data || response);
  if (payment.status !== 'pending') return payment;
  let url;
  try { url = new URL(payment.checkoutUrl || payment.url); } catch { throw fail(); }
  if (payment.checkoutPresentation === 'saved-card') {
    if (payment.paymentRail === 'raast' || url.protocol !== 'https:' || url.hostname !== 'rozare.up.railway.app' || url.port || url.username || url.password
      || url.pathname !== `/api/safepay/saved-checkout/${payment.paymentId}` || url.search
      || !/^#ticket=[A-Za-z0-9_.%-]+$/.test(url.hash) || payment.purpose === 'card_setup'
      || typeof payment.checkoutSessionGrant !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(payment.checkoutSessionGrant)) throw fail();
    return { ...payment, checkoutUrl: url.toString() };
  }
  if (url.protocol !== 'https:' || url.hostname !== HOSTS[payment.environment] || url.port || url.username || url.password
    || url.pathname !== '/embedded/' || url.searchParams.get('environment') !== payment.environment) throw fail();
  return { ...payment, checkoutUrl: url.toString() };
};
