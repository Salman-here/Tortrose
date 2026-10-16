const PRIVATE_EXACT_PATHS = new Set([
  '/ai-chat', '/checkout', '/forgot-password', '/login', '/marketplace/trusted',
  '/profile', '/seller-signup', '/settings/blocked-accounts', '/signup',
  '/success', '/safepay/return', '/unauthorized',
]);
const PRIVATE_PATH_PREFIXES = ['/admin-dashboard', '/auth', '/orders', '/reset-password', '/seller-dashboard', '/user-dashboard'];

export function isPrivatePath(value) {
  const path = (String(value || '').replace(/\/+$/, '') || '/').toLowerCase();
  return PRIVATE_EXACT_PATHS.has(path) || PRIVATE_PATH_PREFIXES.some(prefix => path === prefix || path.startsWith(prefix + '/'));
}

export function nonIndexableQuery(searchParams) {
  const privateKeys = new Set(['token', 'paymentid', 'orderid', 'email', 'session_id', 'setup_intent', 'payment_intent', 'setup_intent_client_secret', 'payment_intent_client_secret']);
  return [...searchParams].some(([key, value]) => value && (privateKeys.has(key.toLowerCase()) || ['search', 'q'].includes(key.toLowerCase())));
}
