import { getOrderPaymentLabel } from './paymentPresentation.js';

const OBJECT_ID = /^[a-f\d]{24}$/i;
const PUBLIC_ID = /^ORD-[A-Za-z\d-]{1,96}$/;
const METHODS = new Set(['cash_on_delivery', 'wallet', 'safepay', 'stripe']);
const ORDER_STATES = new Set(['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled']);
const PAYMENT_STATES = new Set(['paid', 'unpaid', 'pending', 'review_required', 'refunded', 'partially_refunded', 'cancelled', 'not_required']);
const invalid = () => Object.assign(new Error('The order confirmation could not be verified. Open My Orders or try again.'), { code: 'ORDER_RECEIPT_INVALID' });
export const isOrderCompletionReference = value => typeof value === 'string' && (OBJECT_ID.test(value) || PUBLIC_ID.test(value));

// Only the owner-scoped server receipt establishes completion. URL hints,
// navigation state and temporary browser records cannot establish success.
export function validateOrderCompletion(receipt, { reference, buyerId }) {
  if (!isOrderCompletionReference(reference) || !OBJECT_ID.test(buyerId || '') || receipt?.version !== 1
    || !OBJECT_ID.test(receipt.mongoOrderId || '') || !PUBLIC_ID.test(receipt.orderId || '')
    || typeof receipt.buyerId !== 'string' || receipt.buyerId.toLowerCase() !== buyerId.toLowerCase()
    || (OBJECT_ID.test(reference) ? receipt.mongoOrderId.toLowerCase() !== reference.toLowerCase() : receipt.orderId !== reference)
    || !METHODS.has(receipt.paymentMethod) || !['unknown', 'card', 'raast'].includes(receipt.paymentRail)
    || !['USD', 'PKR', 'EUR', 'GBP'].includes(receipt.currency)
    || receipt.paymentRail === 'raast' && (receipt.paymentMethod !== 'safepay' || receipt.currency !== 'PKR')
    || receipt.paymentMethod !== 'safepay' && receipt.paymentRail !== 'unknown'
    || !Number.isSafeInteger(receipt.totalMinor) || receipt.totalMinor < 0
    || typeof receipt.placedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(receipt.placedAt) || !Number.isFinite(Date.parse(receipt.placedAt))
    || !ORDER_STATES.has(receipt.orderStatus) || !PAYMENT_STATES.has(receipt.paymentStatus)
    || ['orderPlaced', 'isPaid', 'confirmationRequired', 'noPaymentRequired', 'hasCancelledItems'].some(key => typeof receipt[key] !== 'boolean')
    || typeof receipt.reviewReason !== 'string' || receipt.reviewReason.length > 500) throw invalid();
  if (receipt.noPaymentRequired && receipt.totalMinor !== 0
    || receipt.paymentMethod !== 'cash_on_delivery' && receipt.paymentStatus === 'paid' && receipt.totalMinor === 0
    || receipt.paymentStatus === 'paid' && !receipt.isPaid
    || receipt.isPaid && (!receipt.orderPlaced || !['paid', 'not_required'].includes(receipt.paymentStatus))
    || receipt.paymentStatus === 'not_required' && (!receipt.noPaymentRequired || receipt.totalMinor !== 0 || !receipt.orderPlaced || !receipt.isPaid)
    || receipt.orderPlaced && receipt.orderStatus === 'cancelled'
    || receipt.orderPlaced && receipt.paymentMethod !== 'cash_on_delivery' && !['paid', 'not_required'].includes(receipt.paymentStatus)
    || receipt.orderPlaced && ['refunded', 'partially_refunded', 'review_required', 'cancelled'].includes(receipt.paymentStatus)
    || receipt.confirmationRequired && (receipt.paymentMethod !== 'cash_on_delivery' || !receipt.orderPlaced || receipt.orderStatus !== 'pending')) throw invalid();
  return receipt;
}

export function orderCompletionPresentation(receipt) {
  const base = { detailsHref: `/user-dashboard/order/detail/${receipt.mongoOrderId}`,
    methodLabel: getOrderPaymentLabel(receipt), originalTotal: receipt.hasCancelledItems || ['refunded', 'partially_refunded'].includes(receipt.paymentStatus) };
  if (receipt.orderStatus === 'cancelled') return { ...base, tone: 'neutral', eyebrow: 'Order updated', title: 'Order cancelled',
    message: 'This order is cancelled. Open its details for the current item, payment and refund information.' };
  if (['refunded', 'partially_refunded'].includes(receipt.paymentStatus)) return { ...base, tone: 'neutral', eyebrow: 'Refund update', title: 'Your order has a refund update',
    message: 'A refund is recorded for this order. View its details for the amount, destination and latest status.' };
  if (receipt.paymentStatus === 'review_required') return { ...base, tone: 'warning', eyebrow: 'Order status', title: 'Order needs review',
    message: receipt.reviewReason || 'The current payment needs review. Open your order details or contact support before attempting another payment.' };
  if (receipt.paymentStatus === 'cancelled') return { ...base, tone: 'neutral', eyebrow: 'Payment status', title: 'Payment not completed',
    message: 'This payment attempt did not complete the order. Review the order details before trying another payment.' };
  if (!receipt.orderPlaced) return { ...base, tone: 'warning', eyebrow: 'Checking your order', title: 'Order confirmation pending',
    message: 'Your payment or order completion is still being checked. Check this same order again before attempting another payment.' };
  if (receipt.hasCancelledItems) return { ...base, tone: 'neutral', eyebrow: 'Order updated', title: 'Your order was updated',
    message: 'Some items from this order were cancelled. View its details for the current item, delivery and refund information.' };
  let message;
  if (receipt.paymentMethod === 'cash_on_delivery') message = receipt.confirmationRequired
    ? 'Your order was placed. Confirm it using the button sent by WhatsApp or email.'
    : receipt.orderStatus === 'delivered' ? 'Your Cash on Delivery order was delivered. Open its details for the current order status.'
      : 'Your Cash on Delivery order was placed. Follow its current delivery status in your order details.';
  else if (receipt.noPaymentRequired) message = 'Your order is confirmed. Its final total was zero, so no payment was required.';
  else if (receipt.paymentMethod === 'wallet') message = 'Your Rozare Wallet payment is complete and your order is confirmed.';
  else message = `Your ${receipt.paymentRail === 'raast' ? 'Raast' : receipt.paymentRail === 'card' || receipt.paymentMethod === 'stripe' ? 'card' : 'Safepay'} payment was verified and your order is confirmed.`;
  return { ...base, tone: 'success', eyebrow: receipt.confirmationRequired ? 'Order placed' : 'Order received', title: 'Thank you for your order!', message };
}

export function formatOrderReceiptTotal(receipt) {
  // The frozen order currency, never today's rate or browsing currency.
  const amount = BigInt(receipt.totalMinor);
  const fraction = String(amount % 100n).padStart(2, '0');
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: receipt.currency, minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .formatToParts(amount / 100n).map(part => part.type === 'fraction' ? fraction : part.value).join('');
}

export function orderCompletionReadError(error) {
  if (error?.response?.status === 401) return { status: 'signin', message: 'Sign in to view your order confirmation securely.' };
  if ([403, 404].includes(error?.response?.status)) return { status: 'unavailable', message: 'We could not find this order in your account. Open My Orders to check the correct order.' };
  if (error?.code === 'ORDER_RECEIPT_INVALID') return { status: 'unavailable', message: error.message };
  return { status: 'unavailable', message: 'Order confirmation is temporarily unavailable. This check has not changed your order. Open My Orders or try again.' };
}

// Every owner/reference/screen lifetime gets its own read-only controller.
export function createOrderCompletionCheck({ reference, buyerId, read, publish }) {
  let active = true, generation = 0;
  const scope = `${buyerId || ''}:${reference || ''}`;
  return {
    stop() { active = false; generation += 1; },
    async run() {
      const request = ++generation;
      const current = () => active && request === generation;
      if (!current()) return null;
      if (!OBJECT_ID.test(buyerId || '')) { publish({ scope, status: 'signin', receipt: null, message: 'Sign in to view your order confirmation securely.' }); return null; }
      if (!isOrderCompletionReference(reference)) { publish({ scope, status: 'unavailable', receipt: null, message: 'Use a valid order reference or open My Orders to find your purchase.' }); return null; }
      publish({ scope, status: 'checking', receipt: null, message: 'Loading your order confirmation securely…' });
      try {
        const response = await read(reference);
        if (!current()) return null;
        const receipt = validateOrderCompletion(response, { reference, buyerId });
        publish({ scope, status: 'ready', receipt, message: '' });
        return receipt;
      } catch (error) {
        if (current()) publish({ scope, ...orderCompletionReadError(error), receipt: null });
        return null;
      }
    },
  };
}
