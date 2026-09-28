const HOSTS = { sandbox: 'sandbox.api.getsafepay.com', production: 'getsafepay.com' };
const ID = /^[a-f0-9]{24}$/i;
const PURPOSES = new Set(['order', 'wallet_top_up', 'card_setup', 'subdomain', 'return_settlement']);
const fail = () => Object.assign(new Error('The secure payment response could not be verified. Please retry the same attempt.'), { code: 'SAFEPAY_CHECKOUT_INVALID', retainMutationAttempt: true });
export const validateSafepayPayment = (payment, expected) => {
  if (!payment || payment.paymentMethod !== 'safepay' || payment.paymentFlow !== 'safepay_hosted'
    || !ID.test(payment.paymentId) || !HOSTS[payment.environment] || !PURPOSES.has(payment.purpose)
    || !['PKR', 'USD', 'EUR', 'GBP'].includes(payment.currency) || !Number.isSafeInteger(payment.amountMinor) || payment.amountMinor < 0
    || (payment.purpose !== 'card_setup' && payment.amountMinor === 0)) throw fail();
  if (expected && ['paymentId', 'environment', 'purpose', 'currency', 'amountMinor'].some(key => payment[key] !== expected[key])) throw fail();
  const status = payment.status === 'paid' && payment.isPaid === true && payment.webhookProcessed === true ? 'paid'
    : payment.purpose === 'card_setup' && payment.status === 'authorized' && payment.cardSaved === true && payment.completed === true ? 'authorized'
    : ['cancelled', 'failed', 'refunded', 'refund_pending', 'manual_review'].includes(payment.status) ? payment.status : 'pending';
  return { ...payment, status, isPaid: status === 'paid' };
};
export const validateSafepayCheckout = response => {
  const payment = validateSafepayPayment(response?.data || response);
  if (payment.status !== 'pending') return payment;
  let url;
  try { url = new URL(payment.checkoutUrl || payment.url); } catch { throw fail(); }
  if (url.protocol !== 'https:' || url.hostname !== HOSTS[payment.environment] || url.port || url.username || url.password
    || url.pathname !== '/embedded/' || url.searchParams.get('environment') !== payment.environment) throw fail();
  return { ...payment, checkoutUrl: url.toString() };
};
