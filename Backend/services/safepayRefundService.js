'use strict';
const Order = require('../models/Order');
const Hold = require('../models/SellerPaymentRiskHold');
const RefundEvent = require('../models/SafepayRefundEvent');
const { readMinor } = require('./safepayClient');
const { getOrderExchangeRates, ensureOrderSellerSettlement } = require('./orderMoneyService');
const { getExpectedStripeTotalMinor: expectedOrderMinor } = require('./stripeOrderPaymentService');
const { assertSafepayOrderBinding } = require('./safepayPaymentFacts');
const { applySellerStripeRiskLedger: applySellerRiskLedger } = require('./stripeOrderPaymentRiskService');
const { cancelUnpaidOrderLocally } = require('./orderCancellationService');
const { enqueueNotificationEvent } = require('./notificationOutboxService');
const { snapshotMinorMoney } = require('./notificationMoneySnapshotService');
const { tryOrderBuyerPhoneE164 } = require('./orderBuyerContactService');
const fail = () => Object.assign(new Error('Safepay refund evidence does not reconcile to the original charge.'), { code: 'SAFEPAY_REFUND_EVIDENCE_INVALID', statusCode: 409 });

function refundEvidence(tracker, payment) {
  if (!['TRACKER_REFUNDED', 'TRACKER_PARTIAL_REFUND'].includes(tracker.state)) return null;
  const charge = tracker.charge;
  if (!charge || charge.tracker !== payment.tracker || charge.amount?.currency !== payment.currency
    || readMinor(charge.amount?.amount) !== payment.amountMinor || charge.capture?.totals?.currency !== payment.currency
    || readMinor(charge.capture?.totals?.amount) !== payment.amountMinor || charge.balance?.currency !== payment.currency
    || !Array.isArray(charge.cybersource_refunds) || !charge.cybersource_refunds.length) throw fail();
  const seen = new Set(); let amountMinor = 0, timestamp = 0;
  for (const refund of charge.cybersource_refunds) {
    if (!/^refund_[a-zA-Z0-9-]+$/.test(refund.token || '') || seen.has(refund.token)
      || refund.tracker !== payment.tracker || refund.totals?.currency !== payment.currency) throw fail();
    seen.add(refund.token);
    const amount = readMinor(refund.totals.amount), seconds = readMinor(refund.created_at?.seconds);
    if (!amount || !seconds) throw fail();
    amountMinor += amount; timestamp = Math.max(timestamp, seconds);
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor > payment.amountMinor || amountMinor < payment.refundedMinor
    || readMinor(charge.balance.amount) !== payment.amountMinor - amountMinor
    || (tracker.state === 'TRACKER_REFUNDED') !== (amountMinor === payment.amountMinor)) throw fail();
  const occurredAt = new Date(timestamp * 1000);
  if (!Number.isFinite(occurredAt.getTime())) throw fail();
  return { amountMinor, full: amountMinor === payment.amountMinor, occurredAt, chargeId: charge.token };
}

async function notifyRefund({ payment, order, evidence, record, sellerIndex = null, sellerId = null, amountMinor, session }) {
  if (amountMinor <= 0) return;
  const phone = tryOrderBuyerPhoneE164(order);
  const recipient = sellerId ? { kind: 'user', audienceRole: 'seller', user: sellerId, destinationPolicy: 'current_user', allowBlocked: true }
    : { kind: order.user ? 'user' : 'guest', audienceRole: 'buyer', ...(order.user ? { user: order.user } : { guestKey: `order:${order._id}` }),
      destinationPolicy: 'event_snapshot', email: order.shippingInfo?.email || '', phone: phone || '' };
  const channels = sellerId ? ['inapp', 'push', 'email', 'whatsapp']
    : [...(order.user ? ['inapp', 'push'] : []), ...(order.shippingInfo?.email ? ['email'] : []), ...(phone ? ['whatsapp'] : [])];
  if (!channels.length) return;
  const title = 'Card refund completed';
  const message = sellerId
    ? `Order ${order.orderId}: your share of the Safepay card refund is {{money.refund}} in the original order currency. The corresponding deduction is recorded in your seller balance.`
    : `Safepay confirmed a {{money.refund}} refund for order ${order.orderId} to the original card. Your bank may take additional time to display it.`;
  await enqueueNotificationEvent({ eventKey: `safepay-refund:${payment._id}:${evidence.amountMinor}:${sellerId || 'buyer'}:v1`,
    eventType: 'order.payment_refund_completed', aggregateType: 'SafepayRefundEvent', aggregateId: record._id,
    occurredAt: evidence.occurredAt, financial: true, recipient, channels,
    templates: { inapp: { title, body: message }, push: { title, body: message }, email: { subject: title, text: message }, whatsapp: { message } },
    money: [snapshotMinorMoney({ key: 'refund', label: sellerId ? 'Seller refund share in order currency' : 'Card refund', amountMinor,
      currency: payment.currency, sourceModel: 'SafepayRefundEvent', sourceDocumentId: record._id,
      sourcePath: sellerId ? `sellerAllocations[${sellerIndex}].amountMinor` : 'deltaMinor' })],
    metadata: { category: 'payment', channelId: sellerId ? 'seller' : 'buyer', whatsappCategory: 'orderUpdates',
      linkTo: sellerId ? `/seller-dashboard/order/${order._id}` : `/user-dashboard/order/detail/${order._id}`,
      data: { type: 'order_refund', orderId: String(order._id) } }, session });
}

async function reconcileOrderRefund(payment, tracker, session) {
  if (payment.purpose !== 'order') return null;
  let evidence;
  // Incomplete provider evidence must retain the fail-closed review path;
  // never infer a refund solely from a webhook name or settlement FX quote.
  try { evidence = refundEvidence(tracker, payment); } catch (_) { return null; }
  if (!evidence) return null;
  const order = await Order.findById(payment.order).session(session);
  assertSafepayOrderBinding(order, payment, expectedOrderMinor(order));
  const delta = evidence.amountMinor - payment.refundedMinor;
  if (evidence.full && payment.safetyRefund?.requestedAt) payment.safetyRefund.outcome = 'confirmed';
  let sellerImpacts = [];
  if (!payment.appliedAt) {
    if (!evidence.full) return null;
    await cancelUnpaidOrderLocally({ orderId: order._id, externalPaymentClosed: true, session,
      reason: 'Safepay confirmed that this captured checkout was fully refunded before fulfillment.' });
  } else {
    const entries = await ensureOrderSellerSettlement(order, { session, requireOrderTotal: true });
    const result = await applySellerRiskLedger({ session, sourceType: 'order_payment', sourceReferenceId: order._id,
      orderId: order._id, orderLabel: `order ${order.orderId}`, sellerEntitlements: entries,
      sourceCurrency: payment.currency, rates: getOrderExchangeRates(order), provider: 'safepay',
      safepayPaymentId: payment._id, safepayTrackerId: payment.tracker, safepayEnvironment: payment.environment,
      eventId: `safepay:${payment._id}:refund:${evidence.amountMinor}`, eventType: 'charge.refunded',
      chargeAmountMinor: payment.amountMinor, refundExposureMinor: evidence.amountMinor });
    sellerImpacts = result.sellerImpacts;
  }
  if (delta > 0) {
    let record = await RefundEvent.findOne({ payment: payment._id, cumulativeMinor: evidence.amountMinor }).session(session);
    if (!record) [record] = await RefundEvent.create([{ payment: payment._id, environment: payment.environment,
      currency: payment.currency, cumulativeMinor: evidence.amountMinor, deltaMinor: delta, occurredAt: evidence.occurredAt,
      sellerAllocations: sellerImpacts.map(impact => ({ seller: impact.sellerId, amountMinor: impact.sourceAmountMinor })) }], { session });
    for (let index = 0; index < record.sellerAllocations.length; index++) {
      const impact = record.sellerAllocations[index];
      await notifyRefund({ payment, order, evidence, record, sellerIndex: index, sellerId: String(impact.seller), amountMinor: impact.amountMinor, session });
    }
    await notifyRefund({ payment, order, evidence, record, amountMinor: record.deltaMinor, session });
  }
  await Hold.updateMany({ provider: 'safepay', providerPaymentId: payment.tracker, providerEnvironment: payment.environment,
    status: 'pending', eventType: { $in: ['TRACKER_REFUNDED', 'TRACKER_PARTIAL_REFUND'] } },
  { $set: { status: 'resolved', resolvedAt: new Date(), resolvedByEventId: `safepay:${payment._id}:refund:${evidence.amountMinor}`,
    resolvedExposureMinor: evidence.amountMinor } }, { session });
  const remaining = await Hold.exists({ provider: 'safepay', providerPaymentId: payment.tracker,
    providerEnvironment: payment.environment, status: 'pending' }).session(session);
  return { resolved: !remaining, status: evidence.full ? 'refunded' : 'paid', refundedMinor: evidence.amountMinor };
}
module.exports = { refundEvidence, reconcileOrderRefund };
