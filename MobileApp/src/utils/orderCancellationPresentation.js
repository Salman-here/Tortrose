export function cancellationRefundPresentation(value, currency, totalAmount) {
  if (!value?.reference) return null;
  if (!['not_required', 'pending', 'processing', 'refunded', 'manual_review'].includes(value.refundStatus)
    || !['none', 'wallet', 'original_card'].includes(value.destination) || value.currency !== currency
    || !Number.isSafeInteger(value.amountMinor) || value.amountMinor < 0 || value.amountMinor > Math.round(totalAmount * 100))
    return { label: 'Refund status unavailable', valid: false };
  return { valid: true, amount: value.amountMinor / 100,
    destination: value.destination === 'wallet' ? 'Rozare Wallet' : value.destination === 'original_card' ? 'original card' : null,
    label: value.refundStatus === 'not_required' ? 'No refund required' : value.refundStatus === 'refunded' ? 'Refund completed'
      : value.refundStatus === 'manual_review' ? 'Refund under review' : 'Refund in progress',
    message: value.destination === 'original_card' && value.refundStatus === 'refunded' ? 'Your bank may take additional time to display the refund.' : '' };
}
