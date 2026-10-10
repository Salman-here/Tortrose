const RAILS = new Set(['unknown', 'card', 'raast']);

// These values come from verified server responses. A Safepay provider name,
// checkout selection, saved-card picker or return URL is not rail evidence.
export function getSafepayPaymentRail(value = {}) {
  if (!value || typeof value !== 'object') return 'unknown';
  const rail = value.safepayPaymentRail ?? value.paymentRail ?? 'unknown';
  if (!RAILS.has(rail) || rail === 'raast' && value.currency !== 'PKR'
    || value.safepayPaymentRail && value.paymentRail && value.safepayPaymentRail !== value.paymentRail) return 'unknown';
  return rail;
}

export function getOrderPaymentLabel(order = {}) {
  if (!order || typeof order !== 'object') return 'Payment method unavailable';
  if (order.paymentMethod === 'cash_on_delivery') return 'Cash on Delivery';
  if (order.paymentMethod === 'wallet') return 'Rozare Wallet';
  if (order.paymentMethod === 'stripe') return 'Card';
  if (order.paymentMethod !== 'safepay') return 'Payment method unavailable';
  const rail = getSafepayPaymentRail(order);
  return rail === 'card' ? 'Card (Safepay)' : rail === 'raast' ? 'Raast (Safepay)' : 'Safepay';
}

export function getSafepayCheckoutLabel(currency) {
  return currency === 'PKR' ? 'Card / Raast' : 'Credit / Debit Card';
}

export function getOriginalPaymentLabel(value = {}) {
  const rail = getSafepayPaymentRail(value);
  return rail === 'card' ? 'Original card' : rail === 'raast' ? 'Original Raast payment' : 'Original payment method';
}

export function getOriginalPaymentRefundCopy(value = {}, status) {
  const rail = getSafepayPaymentRail(value);
  if (status === 'refunded') return rail === 'card'
    ? 'Safepay confirmed the refund to your original card. Your bank may take additional time to display it.'
    : `The refund to your ${getOriginalPaymentLabel(value).toLowerCase()} has been confirmed.`;
  if (status === 'manual_review' && rail === 'card') return 'This refund needs support review. Contact support with your payment reference; no refund has been confirmed.';
  if (rail !== 'card') return 'The original-payment refund needs support review. Contact support with your payment reference; no bank refund has been confirmed.';
  return 'The refund to your original card is being verified; it is not a Rozare Wallet credit.';
}
