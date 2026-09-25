// Provider auth URLs stay in memory, never in navigation or device storage.
let presenter = null;
export function registerSafepayPresenter(next) {
  presenter = next;
  return () => { if (presenter === next) presenter = null; };
}
export function presentSafepaySheet(payment) {
  if (!presenter) return Promise.reject(new Error('The payment screen is not ready. Please try again.'));
  return presenter(payment);
}
export function safepayNavigationAction(raw, environment) {
  let url;
  try { url = new URL(raw); } catch (_) { return 'block'; }
  if (url.href === 'about:blank') return 'allow';
  if (url.protocol === 'rozare:' && url.hostname === 'safepay-return') return 'complete';
  if (url.protocol !== 'https:' || url.username || url.password) return 'block';
  const host = environment === 'sandbox' ? 'sandbox.api.getsafepay.com' : 'getsafepay.com';
  if (url.hostname === host && /^\/(?:embedded\/)?external\/(?:complete|error)\/?$/.test(url.pathname)) return 'complete';
  if (url.hostname === 'rozare.up.railway.app' && url.pathname === '/api/safepay/return') return 'complete';
  // HTTPS issuer/3DS redirects may be necessary. No URL or page message is
  // financial proof; the authenticated backend verifies the owned payment.
  return 'allow';
}
