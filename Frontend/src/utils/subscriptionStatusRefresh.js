export const SUBSCRIPTION_STATUS_CHANGED = 'rozare:subscription-status-changed';

export function subscriptionStatusEventMatchesAccount(event, accountKey) {
  return !!accountKey && event?.detail?.accountKey === String(accountKey);
}

export function notifySubscriptionStatusChanged(accountKey, target = typeof window === 'undefined' ? null : window) {
  if (!accountKey || typeof target?.dispatchEvent !== 'function' || typeof target.CustomEvent !== 'function') return false;
  // An invalidation signal only, not claimed entitlements or payment proof.
  target.dispatchEvent(new target.CustomEvent(SUBSCRIPTION_STATUS_CHANGED, { detail: { accountKey: String(accountKey) } }));
  return true;
}
