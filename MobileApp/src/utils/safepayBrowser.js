const HOSTS = { production: 'getsafepay.com', sandbox: 'sandbox.api.getsafepay.com' };
const RETURN_BASE = 'rozare://safepay-return';
let active = null, recent = null;
const invalid = () => Object.assign(new Error('This secure browser checkout could not be verified.'), { code: 'SAFEPAY_BROWSER_INVALID' });
const matchesReturn = (value, payment) => {
  try {
    const url = new URL(value);
    return url.protocol === 'rozare:' && url.hostname === 'safepay-return' && !url.username && !url.password && !url.port
      && ['', '/'].includes(url.pathname) && url.searchParams.get('paymentId') === payment.paymentId && url.searchParams.get('purpose') === payment.purpose;
  } catch (_) { return false; }
};
export function isSafepayBrowserReturn(url) {
  const session = active || (recent && recent.until > Date.now() ? recent : null);
  return Boolean(session && matchesReturn(url, session.payment));
}
export function cancelSafepayBrowser(paymentId) {
  if (!paymentId || active?.payment.paymentId === paymentId) active = null;
  recent = null;
}
export function presentSafepayBrowser(payment, openAuthSession) {
  if (!/^[a-f0-9]{24}$/i.test(payment?.paymentId || '') || payment.checkoutPresentation !== 'browser') return Promise.reject(invalid());
  let url;
  try {
    url = new URL(payment.checkoutUrl);
    if (url.protocol !== 'https:' || url.hostname !== HOSTS[payment.environment] || url.port || url.username || url.password || url.pathname !== '/embedded/'
      || url.searchParams.get('environment') !== payment.environment || url.searchParams.get('source') !== 'hosted') throw invalid();
    for (const [key, outcome] of [['redirect_url', 'return'], ['cancel_url', 'cancel']]) {
      const target = new URL(url.searchParams.get(key));
      if (target.origin !== 'https://rozare.up.railway.app' || target.pathname !== '/api/safepay/return'
        || target.searchParams.get('attempt') !== payment.paymentId || target.searchParams.get('purpose') !== payment.purpose
        || target.searchParams.get('surface') !== 'mobile' || target.searchParams.get('outcome') !== outcome || target.searchParams.get('browser') !== '1') throw invalid();
    }
  } catch (_) { return Promise.reject(invalid()); }
  if (active) return active.payment.paymentId === payment.paymentId ? active.promise : Promise.reject(invalid());
  const session = { payment, promise: null }; active = session; recent = null;
  session.promise = Promise.resolve().then(() => openAuthSession(url.toString(), RETURN_BASE, { preferEphemeralSession: false, showTitle: true }))
    .then(result => {
      if (result?.type === 'success' && !matchesReturn(result.url, payment)) throw invalid();
      if (active === session && result?.type === 'success') recent = { payment, until: Date.now() + 2000 };
      // Navigation is never a paid/cancelled financial result.
      return { type: result?.type === 'success' ? 'return' : 'dismiss' };
    }).finally(() => { if (active === session) active = null; });
  return session.promise;
}
