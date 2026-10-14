export function getPaymentReviewPresentation(order) {
  const review = order?.safepayPaymentReview;
  if (!review) return null;
  const orderId = String(order?._id || '');
  if (review.version !== 1 || review.orderId !== orderId || !/^[a-f0-9]{24}$/i.test(orderId)
      || !['pending', 'won', 'lost'].includes(review.status)
      || review.currency !== order.currency || !['PKR', 'USD', 'EUR', 'GBP'].includes(review.currency)
      || typeof review.lostMinor !== 'number' || !Number.isSafeInteger(review.lostMinor) || review.lostMinor < 0
      || review.authority !== 'admin_reviewed_provider_evidence') {
    return { status: 'unavailable', label: 'Payment review', message: 'Payment review details could not be verified. Please contact support.' };
  }
  if (review.status === 'pending') return { status: 'pending', label: 'Bank review',
    message: review.fundingSource === 'card_funded_wallet'
      ? 'A card payment funding this Wallet purchase is under bank review. This is separate from a product return or a new payment.'
      : 'The original card payment is under bank review. This is separate from a product return or a new payment.', lostMinor: 0 };
  if (review.status === 'lost') return { status: 'lost', label: 'Payment reversed', lostMinor: review.lostMinor,
    message: 'A bank reversal was recorded following review of the final provider decision. This does not issue an additional Rozare Wallet refund.' };
  return { status: 'won', label: 'Payment confirmed', lostMinor: 0,
    message: 'The bank review was resolved in the merchant’s favour. The original payment remains confirmed.' };
}
