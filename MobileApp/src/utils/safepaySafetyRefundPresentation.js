const isMinor = value => Number.isSafeInteger(value) && value >= 0;
const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const unavailable = () => ({ available: false, label: 'Payment status unavailable', message: 'Refresh this order or contact support to verify the card refund.' });

export const getSafetyRefundPresentation = order => {
  if (order?.paymentMethod !== 'safepay' || order.orderStatus !== 'cancelled' || order.awaitingPayment !== true
    || order.paymentResult?.failureCode !== 'SAFEPAY_SAFETY_REFUND_PENDING') return null;
  const value = order.safepaySafetyRefund;
  const total = order.orderSummary?.totalAmount;
  if (value?.available !== true || !['USD', 'PKR', 'EUR', 'GBP'].includes(value.currency)
    || value.currency !== order.currency || typeof total !== 'number' || !Number.isFinite(total)
    || Math.round(total * 100) / 100 !== total || !isMinor(value.capturedMinor) || value.capturedMinor <= 0
    || value.capturedMinor !== Math.round(total * 100) || !isMinor(value.refundedMinor)
    || value.refundedMinor > value.capturedMinor || !isDate(value.capturedAt) || value.destination !== 'original_card') return unavailable();
  if (value.status === 'refunded') {
    if (value.refundedMinor !== value.capturedMinor || !isDate(value.refundedAt)) return unavailable();
    return { ...value, label: 'Refunded', message: 'This checkout was not fulfilled. Safepay confirmed the refund to your original card. Your bank may take additional time to display it.' };
  }
  if (!['refund_pending', 'manual_review'].includes(value.status) || value.refundedMinor === value.capturedMinor || value.refundedAt !== null) return unavailable();
  return { ...value, label: value.status === 'manual_review' ? 'Refund under review' : 'Refund pending',
    message: 'This checkout was not fulfilled. The refund to your original card is being verified; it is not a Rozare Wallet credit.' };
};
