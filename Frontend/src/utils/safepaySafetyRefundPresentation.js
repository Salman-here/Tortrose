import { getOriginalPaymentLabel, getOriginalPaymentRefundCopy, getSafepayPaymentRail } from './paymentPresentation.js';

const isMinor = value => Number.isSafeInteger(value) && value >= 0;
const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const unavailable = () => ({ available: false, label: 'Payment status unavailable', message: 'Refresh this order or contact support to verify the payment refund.' });

export const getSafetyRefundPresentation = order => {
  if (order?.paymentMethod !== 'safepay' || order.orderStatus !== 'cancelled' || order.awaitingPayment !== true
    || order.paymentResult?.failureCode !== 'SAFEPAY_SAFETY_REFUND_PENDING') return null;
  const value = order.safepaySafetyRefund;
  const total = order.orderSummary?.totalAmount;
  const rail = value?.paymentRail ?? order.safepayPaymentRail ?? 'unknown';
  const source = { paymentRail: rail, currency: value?.currency };
  if (!['unknown', 'card', 'raast'].includes(rail) || rail === 'raast' && order.currency !== 'PKR'
    || order.safepayPaymentRail && order.safepayPaymentRail !== 'unknown' && rail !== order.safepayPaymentRail) return unavailable();
  const destinationLabel = getOriginalPaymentLabel(source);
  if (value?.automaticRefundSupported !== undefined && typeof value.automaticRefundSupported !== 'boolean'
    || value?.supportRequired !== undefined && typeof value.supportRequired !== 'boolean'
    || value?.automaticRefundSupported === true && rail !== 'card') return unavailable();
  if (value?.available !== true || !['USD', 'PKR', 'EUR', 'GBP'].includes(value.currency)
    || value.currency !== order.currency || typeof total !== 'number' || !Number.isFinite(total)
    || Math.round(total * 100) / 100 !== total || !isMinor(value.capturedMinor) || value.capturedMinor <= 0
    || value.capturedMinor !== Math.round(total * 100) || !isMinor(value.refundedMinor)
    || value.refundedMinor > value.capturedMinor || !isDate(value.capturedAt) || value.destination !== 'original_card') return unavailable();
  if (value.status === 'refunded') {
    if (value.refundedMinor !== value.capturedMinor || !isDate(value.refundedAt)) return unavailable();
    return { ...value, paymentRail: getSafepayPaymentRail(source), destinationLabel, label: 'Refunded', message: `This checkout was not fulfilled. ${getOriginalPaymentRefundCopy(source, value.status)}` };
  }
  if (!['refund_pending', 'manual_review'].includes(value.status) || value.refundedMinor === value.capturedMinor || value.refundedAt !== null) return unavailable();
  return { ...value, paymentRail: getSafepayPaymentRail(source), destinationLabel, label: value.status === 'manual_review' ? 'Refund under review' : 'Refund pending',
    message: `This checkout was not fulfilled. ${getOriginalPaymentRefundCopy(source, value.status)}` };
};
