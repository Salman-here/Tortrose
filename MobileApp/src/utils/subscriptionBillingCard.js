export function selectSubscriptionBillingCard(data = {}, { preferBilling = false } = {}) {
  const cards = Array.isArray(data.cards) ? data.cards.filter(card => typeof card?.id === 'string' && card.id && card.usable !== false) : [];
  const preferred = preferBilling ? data.billingPaymentMethodId : data.defaultPaymentMethodId;
  if (cards.some(card => card.id === preferred)) return preferred;
  // An existing agreement must not silently fall back to a shopping default,
  // especially the failed card. Require an explicit choice if it is unavailable.
  return preferBilling ? '' : cards[0]?.id || '';
}
