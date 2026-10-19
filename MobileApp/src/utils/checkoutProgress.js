import { getEffectiveProductSourcePrice } from './currencySafety';
import { getCartPresentationProductCurrency, getCartPresentationQuantity } from './cartPresentation';

export const CHECKOUT_STEPS = ['Cart', 'Shipping', 'Payment'];
const id = value => String(value?._id || value || '');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

// Progress is a review of this buyer's exact cart, not payment confirmation.
// A new line, variant, quantity, price, currency or account requires re-review.
export function createCheckoutReviewIdentity(cart = [], currency = 'USD', owner = 'guest') {
  const lines = cart.map(item => ({ product: id(item.product), seller: id(item.product?.seller),
    quantity: getCartPresentationQuantity(item), color: item.selectedColor || null,
    options: canonical(item.selectedOptions || item.options || {}),
    sourceCurrency: getCartPresentationProductCurrency(item.product), price: getEffectiveProductSourcePrice(item.product),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({ owner, currency, lines });
}

export function getReviewedCheckoutStep(progress, identity) {
  if (!identity || progress.identity !== identity) return 0;
  return Number.isInteger(progress.step) && progress.step >= 0 && progress.step < CHECKOUT_STEPS.length ? progress.step : 0;
}
