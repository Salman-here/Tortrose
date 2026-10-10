import { createScopedMutationStorageKey } from './persistedMutationAttempt.js';
import { getEffectiveProductSourcePrice } from './currencySafety.js';
import { getCartPresentationProductCurrency, getCartPresentationQuantity } from './cartPresentation.js';

const GUEST_HANDOFF_KEY = 'checkoutProgress_guest_handoff_v1';
export const GUEST_CHECKOUT_HANDOFF_MAX_AGE_MS = 15 * 60 * 1000;
export const checkoutDraftStorageKey = owner => createScopedMutationStorageKey('checkoutProgress_v2', owner || 'guest');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const parse = value => { try { const data = JSON.parse(value || 'null'); return object(data) ? data : null; } catch { return null; } };
const canonicalize = value => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  return value;
};
const id = value => String(value?._id || value || '');

// Review progress belongs to this cart, while payment retry keys have their own
// durable ledger. Reordering lines or replacing objects does not change intent.
export function createCheckoutCartIdentity(cart = [], currency = 'USD') {
  const items = cart.map(item => ({
    productId: id(item?.product),
    sellerId: id(item?.product?.seller),
    quantity: getCartPresentationQuantity(item),
    selectedColor: item?.selectedColor || null,
    selectedOptions: canonicalize(item?.selectedOptions || item?.options || {}),
    sourceCurrency: getCartPresentationProductCurrency(item?.product),
    sourcePrice: getEffectiveProductSourcePrice(item?.product),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify({ version: 1, currency: String(currency).trim().toUpperCase(), items });
}

export function reconcileCheckoutProgress(progress, hydratedCartIdentity) {
  // A temporary empty/stale cart during account hydration cannot replace the
  // saved baseline before it has been compared to the authoritative cart.
  if (!hydratedCartIdentity || progress.cartIdentity === hydratedCartIdentity) return progress;
  return { currentStep: 0, cartIdentity: hydratedCartIdentity };
}

export function markGuestCheckoutHandoff(storage, owner, at = Date.now()) {
  if (owner !== 'guest' || !Number.isSafeInteger(at) || at < 0) return false;
  try {
    if (!parse(storage.getItem(checkoutDraftStorageKey('guest')))) return false;
    storage.setItem(GUEST_HANDOFF_KEY, JSON.stringify({ version: 1, from: 'guest', at }));
    return true;
  } catch { return false; }
}

export function readCheckoutDraft(storage, owner, at = Date.now()) {
  try {
    const key = checkoutDraftStorageKey(owner);
    if (owner && owner !== 'guest') {
      const handoff = parse(storage.getItem(GUEST_HANDOFF_KEY));
      const age = at - handoff?.at;
      if (handoff?.version === 1 && handoff.from === 'guest' && Number.isSafeInteger(handoff.at)
        && Number.isSafeInteger(at) && age >= 0 && age <= GUEST_CHECKOUT_HANDOFF_MAX_AGE_MS) {
        const guestKey = checkoutDraftStorageKey('guest');
        const guest = parse(storage.getItem(guestKey));
        if (guest) {
          // Only an explicit guest checkout submission may transfer a draft.
          // Authenticated drafts are never moved to another account.
          storage.setItem(key, JSON.stringify(guest));
          storage.removeItem(guestKey);
        }
      }
      if (handoff) storage.removeItem(GUEST_HANDOFF_KEY);
    }
    // Old unscoped v1 drafts have no verifiable owner and are not imported.
    const saved = parse(storage.getItem(key));
    if (!saved) return null;
    const hasCartIdentity = typeof saved.cartIdentity === 'string' && saved.cartIdentity.length > 0;
    return { ...saved, currentStep: hasCartIdentity && Number.isInteger(saved.currentStep) && saved.currentStep >= 0 && saved.currentStep <= 2 ? saved.currentStep : 0 };
  } catch { return null; }
}
