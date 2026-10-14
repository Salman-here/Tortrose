'use strict';
const { enqueueNotificationEvent } = require('./notificationOutboxService');
const { snapshotMinorMoney } = require('./notificationMoneySnapshotService');
const { escapeHtml } = require('../utils/orderPresentation');
const Order = require('../models/Order');
const { tryOrderBuyerPhoneE164 } = require('./orderBuyerContactService');
const id = value => String(value?._id || value || '');

async function notifyPaymentReview(review, payment, session) {
  const order = payment.purpose === 'order' ? await Order.findById(payment.order).session(session) : null;
  const request = payment.purpose === 'return_settlement' ? await require('../models/ReturnRequest').findById(payment.returnRequest).session(session) : null;
  if (payment.purpose === 'order' && (!order || id(order.safepayPaymentId) !== id(payment))) return;
  if (payment.purpose === 'return_settlement' && (!request || id(request.seller) !== id(payment.user)
      || id(request.settlement?.safepayPaymentId) !== id(payment))) return;
  const buyerId = order?.user || request?.buyer || (payment.purpose === 'wallet_top_up' ? payment.user : null);
  const pending = review.status === 'pending';
  const eventType = pending ? 'payment.bank_review_opened' : 'payment.bank_review_resolved';
  const occurredAt = pending ? review.createdAt : review.resolvedAt;
  const phone = order ? tryOrderBuyerPhoneE164(order) : '';
  const recipients = [
    { kind: buyerId ? 'user' : 'guest', audienceRole: 'buyer', ...(buyerId ? { user: buyerId } : { guestKey: `order:${order._id}` }),
      destinationPolicy: order ? 'event_snapshot' : 'current_user', ...(order ? { email: order.shippingInfo?.email || '', phone: phone || '' } : {}) },
    ...review.sellers.map(seller => ({ kind: 'user', audienceRole: 'seller', user: seller, destinationPolicy: 'current_user', allowBlocked: true })),
  ];
  for (const recipient of recipients) {
    const seller = recipient.audienceRole === 'seller';
    const index = seller ? review.sellerTotals.findIndex(row => id(row.seller) === id(recipient.user)) : -1;
    const principal = seller ? review.sellerTotals[index]?.amountMinor || 0 : payment.purpose === 'return_settlement' ? 0 : review.principalMinor;
    const financial = review.status === 'lost' && principal > 0;
    const title = pending ? 'Card payment under review' : review.status === 'won' ? 'Card payment review completed' : 'Bank payment reversal recorded';
    const subject = order ? `order ${order.orderId}` : request ? `the refund for order ${request.orderId}` : 'a card-funded Wallet payment';
    const message = pending
      ? seller ? `A card payment funding ${subject} is under bank review. Related withdrawals are held until the review is resolved.`
        : request ? `The card payment funding your refund is under bank review. Your completed Wallet refund has not been removed.`
        : `The card payment for ${subject} is under bank review. This is separate from a product return or a new payment.`
      : review.status === 'won' ? seller ? `The bank review for ${subject} was resolved in the merchant's favour. This review's withdrawal hold has been cleared.`
        : `The bank review for ${subject} was resolved in the merchant's favour. Your recorded payment remains confirmed.`
        : seller ? financial ? `A bank payment reversal of {{money.principal}} was recorded for ${subject}. Your Payments balance reflects the related adjustment.`
          : `The bank review for ${subject} is complete. No additional deduction was recorded against your seller balance.`
          : request ? `The refund funding review is complete. Your completed Rozare Wallet refund remains available; no second refund was issued.`
          : `A bank payment reversal${financial ? ' of {{money.principal}}' : ''} was recorded for ${subject} after the final provider decision was reviewed. This does not issue an additional Rozare Wallet refund.`;
    const channels = seller || !order ? ['inapp', 'push', 'email', 'whatsapp'] : [
      ...(order.user ? ['inapp', 'push'] : []), ...(recipient.email ? ['email'] : []), ...(phone ? ['whatsapp'] : []) ];
    await enqueueNotificationEvent({ eventKey: `safepay-bank-review:${review._id}:${review.status}:${seller ? id(recipient.user) : 'buyer'}:v1`,
      eventType, aggregateType: 'SafepayPaymentReview', aggregateId: review._id, occurredAt, financial, recipient, channels,
      templates: { inapp: { title, body: message }, push: { title, body: message },
        email: { subject: `${title}${order || request ? ` — ${order?.orderId || request?.orderId}` : ''}`, text: message, html: `<p>${escapeHtml(message)}</p>` },
        whatsapp: { message: `*${title}*\n\n${message}` } },
      money: financial ? [snapshotMinorMoney({ key: 'principal', label: 'Recorded bank principal', amountMinor: principal,
        currency: review.currency, sourceModel: 'SafepayPaymentReview', sourceDocumentId: review._id,
        sourcePath: seller ? `sellerTotals[${index}].amountMinor` : 'principalMinor' })] : [],
      metadata: { category: 'payment', channelId: seller ? 'seller' : 'buyer', whatsappCategory: 'payment_risk',
        ...(order || request ? { relatedOrder: order?._id || request.order } : {}),
        linkTo: seller ? '/seller-dashboard/payments' : order ? `/user-dashboard/order/detail/${order._id}` : '/user-dashboard/wallet',
        data: { type: 'bank_review', reviewId: id(review), orderId: order ? id(order) : '', purpose: payment.purpose, outcome: review.status } }, session });
  }
}
module.exports = { notifyPaymentReview };
