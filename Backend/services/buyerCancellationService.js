'use strict';
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Cancellation = require('../models/OrderCancellation');
const Payment = require('../models/SafepayPayment');
const Product = require('../models/Product');
const SellerLock = require('../models/SellerSettlementLock');
const { toMinorUnits, fromMinorUnits } = require('./moneyMath');
const { sellerOrderSummaryForItems, sellerCurrencyMoneyPresentation } = require('./orderMoneyService');
const { ensureOrderSellerFulfillment, syncAggregateDeliveryState } = require('./orderFulfillmentService');
const { aggregateOrderInventoryLines } = require('./orderInventoryService');
const { releaseOrderCouponsInSession } = require('./couponUsageService');
const { creditWalletInSession } = require('./walletService');
const { assertWalletOrderFundingReturnable, attachReturnedWalletFundingProvenance } = require('./walletOrderFundingRiskService');
const { enqueueNotificationEvent } = require('./notificationOutboxService');
const { snapshotMinorMoney } = require('./notificationMoneySnapshotService');
const { tryOrderBuyerPhoneE164 } = require('./orderBuyerContactService');
const { escapeHtml } = require('../utils/orderPresentation');
const id = value => String(value?._id || value || '');
const fail = (message, code = 'ORDER_CANCELLATION_CONFLICT', statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const eligible = status => ['pending', 'confirmed', 'processing'].includes(status);

function chooseCancellationSellers(order, selection) {
  const rows = order.sellerFulfillment || [];
  const all = rows.map(row => id(row.seller));
  const requested = selection === undefined ? all : selection;
  if (!Array.isArray(requested) || !requested.length || requested.length > all.length
    || requested.some(value => typeof value !== 'string') || new Set(requested).size !== requested.length
    || requested.some(value => !all.includes(value))) throw fail('Choose seller portions belonging to this order.', 'ORDER_CANCELLATION_SCOPE_INVALID', 400);
  if (requested.some(seller => { const row = rows.find(entry => id(entry.seller) === seller); return row.status !== 'cancelled' && !eligible(row.status); })) {
    throw fail('Shipped or delivered items cannot be cancelled. Cancel only the unshipped seller portions.', 'ORDER_FULFILLMENT_STARTED');
  }
  return requested.slice().sort();
}
function cancellationView(row) {
  return { reference: row._id, refundStatus: row.refundStatus, destination: row.refundDestination,
    amountMinor: row.paymentMethod === 'cash_on_delivery' ? 0 : row.amountMinor, currency: row.currency,
    requestedAt: row.requestedAt, refundedAt: row.refundedAt };
}

async function notifyCancellation(row, order, { completed = false, session } = {}) {
  const phone = tryOrderBuyerPhoneE164(order);
  const literal = value => String(value).replace(/\{\{money\./g, '{money.');
  const name = literal((order.sellerPolicies || []).find(entry => id(entry.seller) === id(row.seller))?.storeName || 'Store');
  const items = order.orderItems.filter(item => id(item.seller) === id(row.seller));
  const description = Array.from(items.map(item => {
    const options = item.selectedOptions instanceof Map ? [...item.selectedOptions.entries()] : Object.entries(item.selectedOptions || {});
    const selected = [item.selectedColor, ...options.map(([name, value]) => `${name}: ${value}`)].filter(Boolean).join(', ');
    return literal(`${item.name} × ${item.quantity}${selected ? ` (${selected})` : ''}`);
  }).join(', ')).slice(0, 1800).join('');
  for (const seller of [false, true]) {
    const title = completed ? 'Cancellation refund completed' : 'Order items cancelled';
    const refund = row.refundDestination === 'none' ? 'No payment refund is required.'
      : completed ? `{{money.refund}} was refunded to ${row.refundDestination === 'wallet' ? 'the buyer’s Rozare Wallet' : 'the original card'}.`
        : `An automatic refund of {{money.refund}} to the original card is being verified.`;
    const message = `Order ${order.orderId} · ${name}\n${description}\n${completed ? '' : 'The buyer cancelled these items before shipment. '}${refund}${seller ? ' No seller action is required. Other seller portions are unchanged.' : ''}`;
    const link = seller ? `/seller-dashboard/order/${order._id}` : `/user-dashboard/order/detail/${order._id}`;
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f4f5fc;font-family:Arial,sans-serif;color:#253149"><table role="presentation" style="width:100%;max-width:600px;margin:32px auto;border:1px solid #e3e7f5;border-radius:22px;background:#ffffff"><tr><td style="padding:28px;background:linear-gradient(125deg,#ecfbf7,#f1edff);border-radius:22px 22px 0 0"><img src="https://rozare.com/favicon-512.png" alt="Rozare" width="42" height="42"><h1 style="font-size:23px;margin:18px 0 0">${escapeHtml(title)}</h1></td></tr><tr><td style="padding:28px;line-height:1.7;font-size:14px">${escapeHtml(message).replace(/\n/g, '<br>')}<p><a href="https://rozare.com${link}" style="display:inline-block;background:#665af2;color:white;padding:12px 22px;border-radius:12px;text-decoration:none">View order details</a></p>${completed && row.refundDestination === 'original_card' ? '<p style="color:#76829b;font-size:12px">Your bank may take additional time to display the refund.</p>' : ''}</td></tr></table></body></html>`;
    const recipient = seller ? { kind: 'user', audienceRole: 'seller', user: row.seller, destinationPolicy: 'current_user', allowBlocked: true }
      : { kind: 'user', audienceRole: 'buyer', user: row.buyer, destinationPolicy: 'event_snapshot', email: order.shippingInfo.email, phone: phone || '' };
    await enqueueNotificationEvent({ eventKey: `order-cancellation:${row._id}:${completed ? 'refunded' : 'cancelled'}:${seller ? 'seller' : 'buyer'}:v1`,
      eventType: completed ? 'order.cancellation_refund_completed' : 'order.seller_portion_cancelled', aggregateType: 'OrderCancellation', aggregateId: row._id,
      occurredAt: completed ? row.refundedAt : row.requestedAt, financial: row.refundDestination !== 'none', recipient,
      channels: ['inapp', 'push', 'email', 'whatsapp'],
      templates: { inapp: { title, body: message }, push: { title, body: message }, email: { subject: title, text: message, html }, whatsapp: { message } },
      money: row.refundDestination === 'none' ? [] : [snapshotMinorMoney({ key: 'refund', label: 'Cancellation refund', amountMinor: row.amountMinor,
        currency: row.currency, sourceModel: 'OrderCancellation', sourceDocumentId: row._id, sourcePath: 'amountMinor' })],
      metadata: { category: 'order', channelId: seller ? 'seller' : 'buyer', whatsappCategory: 'order_update', relatedOrder: order._id,
        linkTo: link,
        data: { type: 'order_status', orderId: id(order), sellerId: id(row.seller) } }, session });
  }
}

async function cancelBuyerOrder({ orderId, buyerId, sellerIds }) {
  await Cancellation.init();
  const result = await mongoose.connection.transaction(async session => {
    const order = await Order.findOne({ _id: orderId, user: buyerId }).session(session);
    if (!order) throw fail('Order not found or it does not belong to you.', 'ORDER_NOT_FOUND', 404);
    if (!['wallet', 'safepay', 'cash_on_delivery'].includes(order.paymentMethod)) throw fail('This payment requires support review.', 'ORDER_PAYMENT_PROVIDER_UNSUPPORTED');
    if (order.awaitingPayment) throw fail('Use the unfinished checkout cancellation flow for this payment.', 'ORDER_PAYMENT_STILL_PENDING');
    await ensureOrderSellerFulfillment(order);
    const selected = chooseCancellationSellers(order, sellerIds);
    for (const seller of selected) await SellerLock.findOneAndUpdate({ seller }, { $inc: { version: 1 } }, { upsert: true, new: true, session });
    // Same order document is touched by shipment/return transactions. Conflicts
    // retry against current shipment status; a stale buyer screen cannot win.
    await Order.updateOne({ _id: order._id }, { $inc: { returnVersion: 1 } }, { session });
    if (order.paymentMethod !== 'cash_on_delivery') {
      if (!order.isPaid) throw fail('Payment must be verified before a paid cancellation.', 'ORDER_PAYMENT_STILL_PENDING');
      await assertWalletOrderFundingReturnable({ orderId: order._id, session });
      if (order.paymentMethod === 'safepay') {
        const payment = await Payment.findOne({ _id: order.safepayPaymentId, order: order._id, user: order.user,
          purpose: 'order', environment: order.safepayEnvironment, currency: order.currency, appliedAt: { $ne: null }, riskPending: false }).session(session);
        if (!payment || payment.amountMinor !== toMinorUnits(order.orderSummary.totalAmount)
          || payment.status !== 'paid') throw fail('The original card payment requires reconciliation before cancellation.', 'ORDER_PAYMENT_BINDING_INVALID');
      }
    }
    for (const seller of selected) {
      const fulfillment = order.sellerFulfillment.find(row => id(row.seller) === seller);
      const previous = await Cancellation.findOne({ order: order._id, seller }).session(session);
      if (previous) continue; // A repeat tap never restores stock or refunds twice.
      if (!eligible(fulfillment.status)) throw fail('This seller portion can no longer be cancelled.', 'ORDER_FULFILLMENT_STARTED');
      const items = order.orderItems.filter(item => id(item.seller) === seller);
      if (!items.length) throw fail('Seller ownership snapshot is unavailable.');
      const buyerMoney = sellerOrderSummaryForItems(order, seller, items);
      const nativeMoney = sellerCurrencyMoneyPresentation(order, seller, items);
      if (!nativeMoney) throw fail('The frozen seller money is unavailable.');
      const destination = buyerMoney.totalAmount === 0 ? 'none' : order.paymentMethod === 'wallet' ? 'wallet' : order.paymentMethod === 'safepay' ? 'original_card' : 'none';
      const [row] = await Cancellation.create([{ order: order._id, buyer: order.user, seller, paymentMethod: order.paymentMethod,
        payment: order.safepayPaymentId || null, environment: order.safepayEnvironment || null, currency: order.currency, amountMinor: toMinorUnits(buyerMoney.totalAmount),
        sellerCurrency: nativeMoney.currency, sellerAmountMinor: toMinorUnits(nativeMoney.summary.totalAmount),
        refundDestination: destination, refundStatus: destination === 'none' ? 'not_required' : destination === 'wallet' ? 'refunded' : 'pending',
        requestedAt: new Date(), refundedAt: destination === 'wallet' ? new Date() : null }], { session });
      if (order.inventoryCommitted) for (const line of aggregateOrderInventoryLines(items)) {
        await Product.updateOne({ _id: line.productId }, [{ $set: {
          stock: { $add: [{ $ifNull: ['$stock', 0] }, line.quantity] },
          totalSales: { $max: [0, { $subtract: [{ $ifNull: ['$totalSales', 0] }, line.quantity] }] },
        } }], { session });
      }
      if (destination === 'wallet' && row.amountMinor) {
        const transaction = await creditWalletInSession({ userId: order.user, amount: fromMinorUnits(row.amountMinor), currency: order.currency,
          type: 'return_refund', referenceType: 'order_cancellation', referenceId: id(row), idempotencyKey: `order-cancellation:${row._id}:wallet`,
          description: `Refund for cancelled items in ${order.orderId}`, metadata: { orderId: order.orderId, sellerId: seller }, allowLocked: true }, session);
        await attachReturnedWalletFundingProvenance({ walletTransaction: transaction, orderId: order._id, sellerId: seller,
          returnRequestId: row._id, refundAmount: fromMinorUnits(row.amountMinor), currency: order.currency, session });
        row.walletTransaction = transaction._id; await row.save({ session });
      }
      fulfillment.status = 'cancelled'; fulfillment.updatedAt = row.requestedAt; fulfillment.cancellation = cancellationView(row);
      await notifyCancellation(row, order, { completed: destination === 'wallet', session });
    }
    await releaseOrderCouponsInSession(order, session, 'Buyer cancelled before shipment.', new Date(), { includeConsumed: true, sellerIds: selected });
    syncAggregateDeliveryState(order);
    if (order.orderStatus === 'cancelled') {
      order.inventoryCommitted = false;
      order.confirmation = order.confirmation || {};
      order.confirmation.cancelledByRole = 'buyer'; order.confirmation.cancelledVia = 'dashboard'; order.confirmation.cancelledAt = new Date();
      order.confirmation.cancelledFromDashboardAt = new Date();
    }
    await order.save({ session });
    return order;
  });
  // Card cancellation is durable before contacting Safepay. A timeout cannot
  // roll back the cancellation or cause a blind duplicate refund.
  return result;
}

module.exports = { cancelBuyerOrder, chooseCancellationSellers, cancellationView, notifyCancellation };
