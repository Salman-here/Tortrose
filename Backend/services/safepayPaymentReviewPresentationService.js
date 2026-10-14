'use strict';
const Review = require('../models/SafepayPaymentReview');
const Payment = require('../models/SafepayPayment');
const Transaction = require('../models/WalletTransaction');
const id = value => String(value?._id || value || '');
const minor = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

async function attachPaymentReviewViews(orders, { sellerId = null } = {}) {
  const ids = orders.map(id).filter(value => /^[a-f0-9]{24}$/i.test(value));
  if (!ids.length) return orders;
  const reviews = await Review.find({ orders: { $in: ids }, purpose: { $ne: 'return_settlement' },
    ...(sellerId ? { sellers: sellerId } : {}) }).select('payment environment tracker purpose originalAmountMinor orders sellers status principalMinor sellerAllocations currency resolvedAt authority').lean();
  if (!reviews.length) return orders;
  const payments = await Payment.find({ _id: { $in: reviews.map(row => row.payment) } }).lean();
  const byPayment = new Map(payments.map(row => [id(row), row]));
  const debits = await Transaction.find({ type: 'order_payment', direction: 'debit', status: 'completed', referenceId: { $in: ids } })
    .select('user referenceId metadata.fundingProvenance').lean();
  const sources = await Transaction.find({ _id: { $in: debits.flatMap(row => (row.metadata?.fundingProvenance || []).map(value => value.sourceTransactionId)).filter(value => /^[a-f0-9]{24}$/i.test(value)) } })
    .select('user safepayPaymentId safepayEnvironment safepayTrackerId currency').lean();
  const bySource = new Map(sources.map(row => [id(row), row]));
  return orders.map(order => {
    const linked = reviews.filter(review => review.orders.some(value => id(value) === id(order)));
    if (!linked.length) return order;
    const valid = linked.every(review => {
      const payment = byPayment.get(id(review.payment));
      if (!payment || payment.environment !== review.environment || payment.tracker !== review.tracker
          || payment.purpose !== review.purpose || payment.currency !== review.currency || payment.currency !== order.currency
          || payment.amountMinor !== review.originalAmountMinor || !minor(review.principalMinor)
          || (review.status !== 'pending' && (review.authority !== 'admin_reviewed_provider_evidence' || !review.resolvedAt))) return false;
      if (order.paymentMethod === 'safepay') return id(order.safepayPaymentId) === id(payment)
        && id(payment.order) === id(order) && id(payment.user) === id(order.user) && order.safepayEnvironment === payment.environment;
      if (order.paymentMethod !== 'wallet') return false;
      const debit = debits.find(row => row.referenceId === id(order) && id(row.user) === id(order.user));
      return (debit?.metadata?.fundingProvenance || []).some(lot => {
        const source = bySource.get(lot.sourceTransactionId);
        return lot.sourceType === 'wallet_top_up' && source && id(source.safepayPaymentId) === id(payment)
          && source.safepayEnvironment === payment.environment && source.safepayTrackerId === payment.tracker
          && source.currency === order.currency && id(source.user) === id(order.user);
      });
    });
    const unavailable = () => ({ ...order, safepayPaymentReview: { version: 1, orderId: id(order), status: 'unavailable' } });
    if (!valid) return unavailable();
    const pending = linked.some(review => review.status === 'pending');
    const lost = linked.filter(review => review.status === 'lost');
    const loss = !sellerId && order.paymentMethod === 'safepay'
      ? lost.reduce((sum, review) => sum + review.principalMinor, 0)
      : lost.flatMap(review => review.sellerAllocations || [])
        .filter(row => id(row.order) === id(order) && (!sellerId || id(row.seller) === id(sellerId)))
        .reduce((sum, row) => sum + row.amountMinor, 0);
    if (!minor(loss)) return unavailable();
    if (!pending && lost.length && !loss) return order;
    return { ...order, safepayPaymentReview: { version: 1, orderId: id(order),
      status: pending ? 'pending' : lost.length ? 'lost' : 'won', currency: order.currency, lostMinor: loss,
      fundingSource: order.paymentMethod === 'wallet' ? 'card_funded_wallet' : 'card',
      authority: 'admin_reviewed_provider_evidence' } };
  });
}
module.exports = { attachPaymentReviewViews };
