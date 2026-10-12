'use strict';

const crypto = require('crypto');
const WalletTransaction = require('../models/WalletTransaction');
const { escapeHtml } = require('../utils/orderPresentation');
const {
  enqueueNotificationEvent,
  outboxError,
} = require('./notificationOutboxService');
const {
  orderSellerStoreTotalSnapshot,
  orderSellerTotalSnapshot,
  orderStockRefundSnapshot,
  orderTotalSnapshot,
  returnRefundSnapshot,
  snapshotMajorMoney,
  stripeEntitlementCapturedSnapshot,
  subscriptionCapturedSnapshot,
  walletCreditBreakdownSnapshots,
  walletTransactionSnapshot,
  withdrawalPayoutSnapshot,
  withdrawalRequestedSnapshot,
} = require('./notificationMoneySnapshotService');
const { sellerOrderSummaryForItems } = require('./orderMoneyService');
const {
  buildOrderButtonsPayload,
  buildOrderListPayload,
} = require('./whatsapp/messageBuilder');
const { tryOrderBuyerPhoneE164 } = require('./orderBuyerContactService');

const stringId = value => value?._id?.toString?.() || value?.toString?.() || '';
const safeText = (value, max = 300) => String(value || '').trim().slice(0, max);
const sellerOrderMoneySnapshots = (order, sellerId) => [
  orderSellerStoreTotalSnapshot(order, sellerId),
  orderSellerTotalSnapshot(order, sellerId),
];
const isValidSnapshotEmail = value => (
  typeof value === 'string'
  && value === value.trim()
  && value.length <= 320
  && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
);
const buyerReceiptChannels = (order, { includeAccountChannels = true } = {}) => {
  const channels = includeAccountChannels ? ['inapp', 'push'] : [];
  if (isValidSnapshotEmail(order?.shippingInfo?.email)) channels.push('email');
  if (tryOrderBuyerPhoneE164(order)) channels.push('whatsapp');
  return channels;
};

const requireEventDate = (value, field) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!value || !Number.isFinite(date.getTime())) {
    throw outboxError(`${field} is required for notification idempotency.`);
  }
  return date;
};

const buyerOrderRecipient = order => {
  const user = stringId(order?.user);
  const phone = tryOrderBuyerPhoneE164(order);
  if (user) {
    return {
      kind: 'user',
      audienceRole: 'buyer',
      user,
      // Order receipts belong to the checkout snapshot even if the account's
      // contact fields are edited before an asynchronous provider retry.
      destinationPolicy: 'event_snapshot',
      email: order?.shippingInfo?.email,
      phone,
    };
  }
  return {
    kind: 'guest',
    audienceRole: 'buyer',
    guestKey: `order:${stringId(order?._id)}`,
    destinationPolicy: 'event_snapshot',
    email: order?.shippingInfo?.email,
    phone,
  };
};

const ORDER_LIFECYCLE_STATUS_COPY = Object.freeze({
  confirmed: {
    title: 'Order confirmed',
    detail: 'Your order is confirmed. You will receive updates as your items are prepared and shipped.',
  },
  processing: {
    title: 'Your order is being prepared',
    detail: 'Your order is being prepared. We will let you know when it ships.',
  },
  shipped: {
    title: 'Order shipped',
    detail: 'Your order has been marked as shipped. View your order for delivery updates.',
  },
  delivered: {
    title: 'Order delivered',
    detail: 'Your order has been marked delivered.',
  },
  cancelled: {
    title: 'Order cancelled',
    detail: 'Your order was cancelled. Check the order details for any applicable payment or refund update.',
  },
});
const ORDER_LIFECYCLE_ACTOR_ROLES = new Set(['buyer', 'seller', 'admin', 'system']);
const ORDER_CANCELLATION_BUYER_DETAIL = Object.freeze({
  buyer: 'You cancelled this order.',
  seller: 'A seller cancelled your order.',
  admin: 'A Rozare administrator cancelled your order.',
  system: 'Rozare automatically cancelled your order.',
});

const orderLifecycleBuyerTemplates = (orderNumber, status, { actorRole } = {}) => {
  const copy = ORDER_LIFECYCLE_STATUS_COPY[status];
  const detail = status === 'cancelled'
    ? `${ORDER_CANCELLATION_BUYER_DETAIL[actorRole]} View your order for payment and refund details.`
    : copy.detail;
  const totalSentence = 'Order total: {{money.order_total}}.';
  return {
    inapp: {
      title: copy.title,
      body: `Order #${orderNumber}: ${detail} ${totalSentence}`,
    },
    push: {
      title: copy.title,
      body: `Order #${orderNumber}: ${detail} ${totalSentence}`,
    },
    email: {
      subject: `${copy.title} - ${orderNumber}`,
      text: `Order #${orderNumber}: ${detail}\n\n${totalSentence}`,
      html: `<p>Order <strong>#${escapeHtml(orderNumber)}</strong>: ${escapeHtml(detail)}</p><p>${totalSentence}</p>`,
    },
    whatsapp: {
      message: `*${copy.title}*\n\nOrder: #${orderNumber}\n${detail}\n${totalSentence}\n\nView your order in Rozare for details.`,
    },
  };
};

/**
 * Queue one immutable buyer-facing notification for an aggregate order status
 * transition. Callers insert this in the same MongoDB transaction as the
 * order write, so a committed transition can never lose its notification and
 * a transaction retry cannot create another delivery event.
 */
async function enqueueOrderLifecycleBuyerNotifications(order, {
  status,
  previousStatus,
  transitionAt,
  actorRole,
  channels = null,
  session = null,
} = {}) {
  if (!Object.prototype.hasOwnProperty.call(ORDER_LIFECYCLE_STATUS_COPY, status)) {
    throw outboxError('Order lifecycle notification status is invalid.');
  }
  if (order?.orderStatus !== status) {
    throw outboxError('Order lifecycle notification status does not match the persisted order.');
  }
  const previous = safeText(previousStatus, 40).toLowerCase();
  if (!previous || previous === status || !/^[a-z][a-z_]{0,39}$/.test(previous)) {
    throw outboxError('Order lifecycle notification requires the previous persisted status.');
  }
  if (!ORDER_LIFECYCLE_ACTOR_ROLES.has(actorRole)) {
    throw outboxError('Order lifecycle notification actor role is invalid.');
  }

  const at = requireEventDate(transitionAt, 'Order lifecycle transition timestamp');
  const id = stringId(order?._id);
  const orderNumber = safeText(order?.orderId || id, 100);
  const recipient = buyerOrderRecipient(order);
  const selectedChannels = channels || buyerReceiptChannels(order, {
    includeAccountChannels: recipient.kind === 'user',
  });
  if (!selectedChannels.length) return [];
  const transitionHash = crypto.createHash('sha256')
    .update(`${previous}:${status}:${at.toISOString()}`)
    .digest('hex');

  return enqueueNotificationEvent({
    eventKey: `order:${id}:lifecycle:${transitionHash}:buyer:v1`,
    eventType: 'order.status_updated',
    aggregateType: 'Order',
    aggregateId: id,
    occurredAt: at,
    financial: true,
    recipient,
    channels: selectedChannels,
    templates: orderLifecycleBuyerTemplates(orderNumber, status, { actorRole }),
    metadata: {
      category: 'order',
      linkTo: recipient.kind === 'user' ? `/user-dashboard/order/detail/${id}` : '/track-order',
      channelId: 'orders',
      relatedOrder: id,
      data: {
        type: 'order_status_updated',
        orderId: id,
        previousStatus: previous,
        status,
        changedByRole: actorRole,
      },
    },
    // This is the checkout total already frozen on the order. Product source
    // currencies and live FX are deliberately not consulted during rendering.
    money: [orderTotalSnapshot(order)],
    session,
  });
}

const SELLER_FULFILLMENT_STATUS_COPY = Object.freeze({
  confirmed: { title: 'Your items are confirmed', detail: 'confirmed your items' },
  processing: { title: 'Your items are being prepared', detail: 'is preparing your items' },
  shipped: { title: 'Your items have shipped', detail: 'marked your items as shipped' },
  delivered: { title: 'Your items were marked delivered', detail: 'marked your items as delivered' },
});

const sellerFulfillmentBuyerMoneySnapshot = (order, sellerId) => {
  // Versioned settlement is the strongest immutable evidence and must fail
  // closed if malformed. The computed fallback exists only for legacy orders
  // that predate sellerSettlementVersion.
  if (Number(order?.sellerSettlementVersion || 0) > 0) {
    return orderSellerTotalSnapshot(order, sellerId);
  }
  const sellerKey = stringId(sellerId);
  const sellerItems = (order?.orderItems || []).filter(
    item => stringId(item?.seller) === sellerKey,
  );
  const summary = sellerOrderSummaryForItems(order, sellerKey, sellerItems);
  return snapshotMajorMoney({
    key: 'seller_order_total',
    label: 'Seller order allocation',
    amount: summary.totalAmount,
    currency: order?.currency,
    sourceModel: 'Order',
    sourceDocumentId: order?._id,
    sourcePath: `computedSellerSummary[${sellerKey}].totalAmount`,
  });
};

const sellerFulfillmentBuyerTemplates = ({
  orderNumber,
  storeName,
  status,
  itemSummary,
  shippingSummary,
}) => {
  const copy = SELLER_FULFILLMENT_STATUS_COPY[status];
  const detail = `${storeName} ${copy.detail}: ${itemSummary}.`;
  const money = 'Your total for this store is {{money.seller_order_total}}.';
  const shipping = shippingSummary ? ` ${shippingSummary}` : '';
  return {
    inapp: { title: copy.title, body: `Order #${orderNumber}: ${detail}${shipping} ${money}` },
    push: { title: copy.title, body: `${storeName}: ${itemSummary}. ${money}` },
    email: {
      subject: `${copy.title} - ${orderNumber}`,
      text: `Order #${orderNumber}: ${detail}${shipping}\n\n${money}\nView your order for delivery updates.`,
      html: `<p>Order <strong>#${escapeHtml(orderNumber)}</strong>: ${escapeHtml(detail)}</p>${shipping ? `<p>${escapeHtml(shippingSummary)}</p>` : ''}<p>${money}</p><p>View your order for delivery updates.</p>`,
    },
    whatsapp: {
      message: `*${copy.title}*\n\nOrder: #${orderNumber}\nStore: ${storeName}\nItems: ${itemSummary}${shippingSummary ? `\n${shippingSummary}` : ''}\n${money}\n\nView your order in Rozare for delivery updates.`,
    },
  };
};

/**
 * Queue one buyer event for one seller-owned fulfillment transition. This is
 * intentionally independent of the aggregate orderStatus: in a multi-seller
 * order Seller B can advance while Seller A remains pending, and the buyer
 * must still receive and see that update.
 */
async function enqueueOrderSellerFulfillmentBuyerNotifications(order, {
  sellerId,
  status,
  previousStatus,
  transitionAt,
  actorRole,
  channels = null,
  session = null,
} = {}) {
  if (!Object.prototype.hasOwnProperty.call(SELLER_FULFILLMENT_STATUS_COPY, status)) {
    throw outboxError('Seller fulfillment notification status is invalid.');
  }
  if (!ORDER_LIFECYCLE_ACTOR_ROLES.has(actorRole)) {
    throw outboxError('Seller fulfillment notification actor role is invalid.');
  }
  const seller = stringId(sellerId);
  if (!seller) throw outboxError('Seller fulfillment notification requires a seller.');
  const persistedFulfillment = (order?.sellerFulfillment || []).filter(
    entry => stringId(entry?.seller) === seller,
  );
  if (persistedFulfillment.length !== 1 || persistedFulfillment[0].status !== status) {
    throw outboxError('Seller fulfillment notification does not match the persisted seller status.');
  }
  const previous = safeText(previousStatus, 40).toLowerCase();
  if (!previous || previous === status || !/^[a-z][a-z_]{0,39}$/.test(previous)) {
    throw outboxError('Seller fulfillment notification requires the previous persisted status.');
  }

  const at = requireEventDate(transitionAt, 'Seller fulfillment transition timestamp');
  const id = stringId(order?._id);
  const orderNumber = safeText(order?.orderId || id, 100);
  const sellerItems = (order?.orderItems || []).filter(item => stringId(item?.seller) === seller);
  if (!sellerItems.length) {
    throw outboxError('Seller fulfillment notification has no immutable seller item snapshots.');
  }
  const policy = (order?.sellerPolicies || []).find(entry => stringId(entry?.seller) === seller);
  const shipping = (order?.sellerShipping || []).find(entry => stringId(entry?.seller) === seller);
  const storeName = safeText(policy?.storeName, 100) || 'A seller';
  const itemNames = sellerItems.map(item => safeText(item?.name, 100) || 'Order item');
  const visibleNames = itemNames.slice(0, 4);
  const itemSummary = safeText(
    `${visibleNames.join(', ')}${itemNames.length > visibleNames.length ? ` and ${itemNames.length - visibleNames.length} more` : ''}`,
    300,
  );
  const shippingName = safeText(shipping?.shippingMethod?.name, 100);
  const estimatedDays = shipping?.shippingMethod?.estimatedDays;
  const shippingSummary = shippingName
    ? `Shipping: ${shippingName}${Number.isSafeInteger(estimatedDays) ? `, estimated ${estimatedDays} day${estimatedDays === 1 ? '' : 's'}` : ''}.`
    : '';
  const recipient = buyerOrderRecipient(order);
  const selectedChannels = channels || buyerReceiptChannels(order, {
    includeAccountChannels: recipient.kind === 'user',
  });
  if (!selectedChannels.length) return [];
  const transitionHash = crypto.createHash('sha256')
    .update(`${seller}:${previous}:${status}:${at.toISOString()}`)
    .digest('hex');

  return enqueueNotificationEvent({
    eventKey: `order:${id}:seller-fulfillment:${transitionHash}:buyer:v1`,
    eventType: 'order.seller_fulfillment_updated',
    aggregateType: 'Order',
    aggregateId: id,
    occurredAt: at,
    financial: true,
    recipient,
    channels: selectedChannels,
    templates: sellerFulfillmentBuyerTemplates({
      orderNumber,
      storeName,
      status,
      itemSummary,
      shippingSummary,
    }),
    metadata: {
      category: 'order',
      linkTo: recipient.kind === 'user' ? `/user-dashboard/order/detail/${id}` : '/track-order',
      channelId: 'orders',
      relatedOrder: id,
      data: {
        type: 'seller_fulfillment_updated',
        orderId: id,
        publicOrderId: orderNumber,
        sellerId: seller,
        storeName,
        itemNames,
        previousStatus: previous,
        status,
        shippingName: shippingName || null,
        estimatedDays: Number.isSafeInteger(estimatedDays) ? estimatedDays : null,
        changedByRole: actorRole,
      },
    },
    money: [sellerFulfillmentBuyerMoneySnapshot(order, seller)],
    session,
  });
}

const orderStockRefundBuyerTemplates = orderNumber => ({
  inapp: {
    title: 'Card refund completed',
    body: `Order #${orderNumber} was cancelled because inventory was unavailable. Stripe completed a {{money.refund_total}} refund to the original payment method. Bank posting times may vary.`,
  },
  push: {
    title: 'Card refund completed',
    body: `Order #${orderNumber}: Stripe completed a {{money.refund_total}} refund. Bank posting times may vary.`,
  },
  email: {
    subject: `Card refund completed - ${orderNumber}`,
    text: `Order #${orderNumber} was cancelled because inventory was unavailable. Stripe reports that the {{money.refund_total}} refund to your original payment method completed. Your bank may take additional time to display it.`,
    html: `<p>Order <strong>#${escapeHtml(orderNumber)}</strong> was cancelled because inventory was unavailable.</p><p>Stripe reports that the <strong>{{money.refund_total}}</strong> refund to your original payment method completed.</p><p>Your bank may take additional time to display it.</p>`,
  },
  whatsapp: {
    message: `Rozare Card Refund Completed\n\nOrder: #${orderNumber}\nRefund: {{money.refund_total}}\nReason: inventory was unavailable\n\nStripe reports the refund as completed. Your bank may take additional time to display it.`,
  },
});

async function enqueueOrderStockRefundBuyerNotifications(order, {
  channels = null,
  session = null,
} = {}) {
  if (
    order?.paymentMethod !== 'stripe'
    || order?.orderStatus !== 'cancelled'
    || order?.isPaid === true
    || order?.paymentResult?.stockRefundStatus !== 'succeeded'
  ) {
    throw outboxError('Stock-loss refund notifications require a completed Stripe refund on a cancelled unpaid order.');
  }
  const refundId = safeText(order?.paymentResult?.stockRefundId, 200);
  if (!/^re_[A-Za-z0-9_]+$/.test(refundId)) {
    throw outboxError('Stock-loss refund notifications require the persisted Stripe refund id.');
  }
  const id = stringId(order?._id);
  const orderNumber = safeText(order?.orderId || id, 100);
  const occurredAt = requireEventDate(
    order?.paymentResult?.stockRefundAt,
    'Stripe stock-loss refund completion timestamp',
  );
  const recipient = buyerOrderRecipient(order);
  const selectedChannels = channels || buyerReceiptChannels(order, {
    includeAccountChannels: recipient.kind === 'user',
  });
  if (!selectedChannels.length) return [];
  const refundHash = crypto.createHash('sha256').update(refundId).digest('hex');
  const refundMoney = orderStockRefundSnapshot(order);
  const chargedMoney = orderTotalSnapshot(order);
  if (
    refundMoney.currency !== chargedMoney.currency
    || refundMoney.amountMinor !== chargedMoney.amountMinor
  ) {
    throw outboxError(
      'The completed Stripe stock-loss refund does not match the frozen order charge.',
      'NOTIFICATION_REFUND_MONEY_MISMATCH',
    );
  }

  return enqueueNotificationEvent({
    eventKey: `order:${id}:stock-refund:${refundHash}:buyer:v1`,
    eventType: 'order.stock_refund_completed',
    aggregateType: 'Order',
    aggregateId: id,
    occurredAt,
    financial: true,
    recipient: recipient.kind === 'user'
      ? { ...recipient, allowBlocked: true }
      : recipient,
    channels: selectedChannels,
    templates: orderStockRefundBuyerTemplates(orderNumber),
    metadata: {
      category: 'payment',
      linkTo: recipient.kind === 'user' ? `/user-dashboard/order/detail/${id}` : '/track-order',
      channelId: 'orders',
      relatedOrder: id,
      data: {
        type: 'order_stock_refund_completed',
        orderId: id,
      },
    },
    money: [refundMoney],
    session,
  });
}

const paidBuyerTemplates = orderNumber => ({
  inapp: {
    title: 'Payment received',
    body: `Your payment for order #${orderNumber} was successful. Amount paid: {{money.order_total}}.`,
  },
  push: {
    title: 'Payment received',
    body: `Order #${orderNumber} was paid successfully. Total: {{money.order_total}}.`,
  },
  email: {
    subject: `Payment received for order ${orderNumber}`,
    text: `Your payment for order #${orderNumber} was successful.\n\nAmount paid: {{money.order_total}}.\nWe will keep you updated as your items are prepared and shipped.`,
    html: `<p>Your payment for order <strong>#${escapeHtml(orderNumber)}</strong> was successful.</p><p>Amount paid: <strong>{{money.order_total}}</strong>.</p><p>We will keep you updated as your items are prepared and shipped.</p>`,
  },
  whatsapp: {
    message: `*Payment received*\n\nOrder: #${orderNumber}\nAmount paid: {{money.order_total}}\n\nWe will keep you updated as your items are prepared and shipped. View your order in Rozare for details.`,
  },
});

async function enqueuePaidOrderBuyerNotifications(order, {
  channels = null,
  session = null,
} = {}) {
  const id = stringId(order?._id);
  const orderNumber = safeText(order?.orderId || id, 100);
  const recipient = buyerOrderRecipient(order);
  const selectedChannels = channels || buyerReceiptChannels(order, {
    includeAccountChannels: recipient.kind === 'user',
  });
  if (!selectedChannels.length) return [];
  return enqueueNotificationEvent({
    eventKey: `order:${id}:paid:buyer:v1`,
    eventType: 'order.paid',
    aggregateType: 'Order',
    aggregateId: id,
    occurredAt: requireEventDate(order?.paidAt || order?.paymentFulfilledAt, 'Order paid timestamp'),
    financial: true,
    recipient: recipient.kind === 'user'
      ? { ...recipient, allowBlocked: true }
      : recipient,
    channels: selectedChannels,
    templates: paidBuyerTemplates(orderNumber),
    metadata: {
      category: 'order',
      linkTo: recipient.kind === 'user' ? `/user-dashboard/order/detail/${id}` : '/track-order',
      channelId: 'orders',
      relatedOrder: id,
      data: { type: 'order_paid', orderId: id },
    },
    money: [orderTotalSnapshot(order)],
    session,
  });
}

const paidSellerTemplates = orderNumber => ({
  inapp: {
    title: 'Paid order received',
    body: `You received paid order #${orderNumber}. Store total: {{money.seller_store_total}}. Payment received: {{money.seller_order_total}} (checkout currency).`,
  },
  push: {
    title: 'Paid order received',
    body: `Order #${orderNumber}. Store total: {{money.seller_store_total}}. Payment received: {{money.seller_order_total}} (checkout currency).`,
  },
  email: {
    subject: `Paid order received - ${orderNumber}`,
    text: `You received paid order #${orderNumber}.\n\nStore total: {{money.seller_store_total}}.\nPayment received: {{money.seller_order_total}} (checkout currency).\nView the order in Seller Dashboard to begin fulfillment. Payout eligibility is shown in Payments.`,
    html: `<p>You received paid order <strong>#${escapeHtml(orderNumber)}</strong>.</p><p>Store total: <strong>{{money.seller_store_total}}</strong>.</p><p>Payment received: <strong>{{money.seller_order_total}}</strong> (checkout currency).</p><p>View the order in Seller Dashboard to begin fulfillment. Payout eligibility is shown in Payments.</p>`,
  },
  whatsapp: {
    message: `*Paid order received*\n\nOrder: #${orderNumber}\nStore total: {{money.seller_store_total}}\nPayment received: {{money.seller_order_total}} (checkout currency)\n\nView the order in Seller Dashboard to begin fulfillment. Payout eligibility is shown in Payments.`,
  },
});

async function enqueuePaidOrderSellerNotifications(order, sellerId, {
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
} = {}) {
  const id = stringId(order?._id);
  const seller = stringId(sellerId);
  const orderNumber = safeText(order?.orderId || id, 100);
  return enqueueNotificationEvent({
    eventKey: `order:${id}:paid:seller:${seller}:v1`,
    eventType: 'order.paid',
    aggregateType: 'Order',
    aggregateId: id,
    occurredAt: requireEventDate(order?.paidAt || order?.paymentFulfilledAt, 'Order paid timestamp'),
    financial: true,
    recipient: {
      kind: 'user',
      audienceRole: 'seller',
      user: seller,
      destinationPolicy: 'current_user',
      allowBlocked: true,
    },
    channels,
    templates: paidSellerTemplates(orderNumber),
    metadata: {
      category: 'order',
      linkTo: `/seller-dashboard/order/${encodeURIComponent(id)}`,
      channelId: 'seller',
      whatsappCategory: 'new_order',
      relatedOrder: id,
      data: { type: 'paid_order_received', orderId: id },
    },
    money: sellerOrderMoneySnapshots(order, seller),
    session,
  });
}

const requireZeroSnapshot = (snapshot, label) => {
  if (snapshot?.amountMinor !== 0) {
    throw outboxError(`${label} must be exactly zero for a no-charge order notification.`);
  }
  return snapshot;
};

const noChargeBuyerTemplates = orderNumber => ({
  inapp: {
    title: 'Order confirmed',
    body: `Order #${orderNumber} is confirmed. Total: {{money.order_total}}; no payment was required.`,
  },
  push: {
    title: 'Order confirmed',
    body: `Order #${orderNumber} is confirmed with no payment required. Total: {{money.order_total}}.`,
  },
  email: {
    subject: `Order confirmed - ${orderNumber}`,
    text: `Order #${orderNumber} is confirmed. Order total: {{money.order_total}}. No payment was required or charged.`,
    html: `<p>Order <strong>#${escapeHtml(orderNumber)}</strong> is confirmed.</p><p>Order total: <strong>{{money.order_total}}</strong>.</p><p>No payment was required or charged.</p>`,
  },
  whatsapp: {
    message: `*Your order is confirmed*\n\nOrder: #${orderNumber}\nTotal: {{money.order_total}}\nNo payment was required or charged.\n\nView your order in Rozare.`,
  },
});

async function enqueueNoChargeOrderBuyerNotifications(order, {
  channels = null,
  session = null,
} = {}) {
  const id = stringId(order?._id);
  const orderNumber = safeText(order?.orderId || id, 100);
  const recipient = buyerOrderRecipient(order);
  const selectedChannels = channels || buyerReceiptChannels(order, {
    includeAccountChannels: recipient.kind === 'user',
  });
  if (!selectedChannels.length) return [];
  return enqueueNotificationEvent({
    eventKey: `order:${id}:no-charge-confirmed:buyer:v1`,
    eventType: 'order.no_charge_confirmed',
    aggregateType: 'Order',
    aggregateId: id,
    occurredAt: requireEventDate(
      order?.paymentFulfilledAt || order?.paidAt,
      'No-charge order completion timestamp',
    ),
    financial: true,
    recipient: recipient.kind === 'user'
      ? { ...recipient, allowBlocked: true }
      : recipient,
    channels: selectedChannels,
    templates: noChargeBuyerTemplates(orderNumber),
    metadata: {
      category: 'order',
      linkTo: recipient.kind === 'user' ? `/user-dashboard/order/detail/${id}` : '/track-order',
      channelId: 'orders',
      relatedOrder: id,
      data: { type: 'order_no_charge_confirmed', orderId: id },
    },
    money: [requireZeroSnapshot(orderTotalSnapshot(order), 'No-charge order total')],
    session,
  });
}

const noChargeSellerTemplates = orderNumber => ({
  inapp: {
    title: 'No-charge order received',
    body: `You received confirmed order #${orderNumber}. Store total: {{money.seller_store_total}}. Order total: {{money.seller_order_total}} (checkout currency). No payment was required.`,
  },
  push: {
    title: 'No-charge order received',
    body: `Order #${orderNumber}. Store total: {{money.seller_store_total}}. Order total: {{money.seller_order_total}} (checkout currency). No payment was required.`,
  },
  email: {
    subject: `No-charge order received - ${orderNumber}`,
    text: `You received confirmed order #${orderNumber}.\n\nStore total: {{money.seller_store_total}}.\nOrder total: {{money.seller_order_total}} (checkout currency).\nNo buyer payment was required or collected. View the order in Seller Dashboard to begin fulfillment.`,
    html: `<p>You received confirmed order <strong>#${escapeHtml(orderNumber)}</strong>.</p><p>Store total: <strong>{{money.seller_store_total}}</strong>.</p><p>Order total: <strong>{{money.seller_order_total}}</strong> (checkout currency).</p><p>No buyer payment was required or collected.</p><p>View the order in Seller Dashboard to begin fulfillment.</p>`,
  },
  whatsapp: {
    message: `*No-charge order received*\n\nOrder: #${orderNumber}\nStore total: {{money.seller_store_total}}\nOrder total: {{money.seller_order_total}} (checkout currency)\nNo buyer payment was required or collected.\n\nView the order in Seller Dashboard to begin fulfillment.`,
  },
});

async function enqueueNoChargeOrderSellerNotifications(order, sellerId, {
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
} = {}) {
  const id = stringId(order?._id);
  const seller = stringId(sellerId);
  const orderNumber = safeText(order?.orderId || id, 100);
  const sellerTotals = sellerOrderMoneySnapshots(order, seller).map(snapshot => requireZeroSnapshot(
    snapshot,
    'No-charge seller allocation',
  ));
  return enqueueNotificationEvent({
    eventKey: `order:${id}:no-charge-confirmed:seller:${seller}:v1`,
    eventType: 'order.no_charge_confirmed',
    aggregateType: 'Order',
    aggregateId: id,
    occurredAt: requireEventDate(
      order?.paymentFulfilledAt || order?.paidAt,
      'No-charge order completion timestamp',
    ),
    financial: true,
    recipient: {
      kind: 'user', audienceRole: 'seller', user: seller, destinationPolicy: 'current_user', allowBlocked: true,
    },
    channels,
    templates: noChargeSellerTemplates(orderNumber),
    metadata: {
      category: 'order',
      linkTo: `/seller-dashboard/order/${encodeURIComponent(id)}`,
      channelId: 'seller',
      whatsappCategory: 'new_order',
      relatedOrder: id,
      data: { type: 'no_charge_order_received', orderId: id },
    },
    money: sellerTotals,
    session,
  });
}

const codSellerPlacedTemplates = orderNumber => ({
  inapp: {
    title: 'New cash on delivery order',
    body: `You received cash on delivery order #${orderNumber}. Store total: {{money.seller_store_total}}. Cash due: {{money.seller_order_total}}. Awaiting buyer confirmation.`,
  },
  push: {
    title: 'New cash on delivery order',
    body: `Order #${orderNumber}. Store total: {{money.seller_store_total}}. Cash due: {{money.seller_order_total}}. Awaiting buyer confirmation.`,
  },
  email: {
    subject: `New cash on delivery order - ${orderNumber}`,
    text: `You received cash on delivery order #${orderNumber}.\n\nStore total: {{money.seller_store_total}}.\nCash due for this order: {{money.seller_order_total}}.\nPlease wait for buyer confirmation before fulfillment. Payment is due on delivery.`,
    html: `<p>You received cash on delivery order <strong>#${escapeHtml(orderNumber)}</strong>.</p><p>Store total: <strong>{{money.seller_store_total}}</strong>.</p><p>Cash due for this order: <strong>{{money.seller_order_total}}</strong>.</p><p>Please wait for buyer confirmation before fulfillment. Payment is due on delivery.</p>`,
  },
  whatsapp: {
    message: `*New cash on delivery order*\n\nOrder: #${orderNumber}\nStore total: {{money.seller_store_total}}\nCash due for this order: {{money.seller_order_total}}\n\nPlease wait for buyer confirmation before fulfillment. Payment is due on delivery. View the order in Seller Dashboard.`,
  },
});

async function enqueueCodOrderSellerNotifications(order, sellerId, {
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
} = {}) {
  if (order?.paymentMethod !== 'cash_on_delivery' || order?.isPaid === true) {
    throw outboxError('COD seller notifications require an unpaid cash on delivery order.');
  }
  const id = stringId(order?._id);
  const seller = stringId(sellerId);
  const orderNumber = safeText(order?.orderId || id, 100);
  return enqueueNotificationEvent({
    eventKey: `order:${id}:placed:seller:${seller}:v1`,
    eventType: 'order.placed',
    aggregateType: 'Order',
    aggregateId: id,
    occurredAt: requireEventDate(order?.createdAt, 'Order creation timestamp'),
    financial: true,
    recipient: {
      kind: 'user', audienceRole: 'seller', user: seller, destinationPolicy: 'current_user',
    },
    channels,
    templates: codSellerPlacedTemplates(orderNumber),
    metadata: {
      category: 'order',
      linkTo: `/seller-dashboard/order/${encodeURIComponent(id)}`,
      channelId: 'seller',
      whatsappCategory: 'new_order',
      relatedOrder: id,
      data: { type: 'cod_order_received', orderId: id },
    },
    money: sellerOrderMoneySnapshots(order, seller),
    session,
  });
}

async function enqueueCodOrderBuyerConfirmationNotification(order, {
  channels = null,
  session = null,
} = {}) {
  if (order?.paymentMethod !== 'cash_on_delivery' || order?.isPaid === true) {
    throw outboxError('COD confirmation notifications require an unpaid cash on delivery order.');
  }
  const id = stringId(order?._id);
  const orderNumber = safeText(order?.orderId || id, 100);
  const token = safeText(order?.confirmation?.token, 256);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw outboxError('COD confirmation notifications require a valid persisted confirmation token.');
  }
  const frontendUrl = String(process.env.FRONTEND_URL || 'https://rozare.com').replace(/\/+$/, '');
  const confirmUrl = `${frontendUrl}/orders/confirm/${encodeURIComponent(token)}`;
  const confirmIntentUrl = `${confirmUrl}?intent=confirm`;
  const cancelIntentUrl = `${confirmUrl}?intent=cancel`;
  const recipient = buyerOrderRecipient(order);
  const selectedChannels = channels || buyerReceiptChannels(order, {
    includeAccountChannels: recipient.kind === 'user',
  });
  if (!selectedChannels.length) return [];
  const templates = {
    inapp: {
      title: 'Confirm your cash on delivery order',
      body: `Order #${orderNumber} total: {{money.order_total}}. Confirm it before fulfillment begins.`,
    },
    push: {
      title: 'Confirm your order',
      body: `Order #${orderNumber} total: {{money.order_total}}. Open Rozare to confirm.`,
    },
    email: {
      subject: `Confirm cash on delivery order ${orderNumber}`,
      text: `Your cash on delivery order #${orderNumber} is awaiting confirmation.\n\nAmount due on delivery: {{money.order_total}}.\nPlease review and confirm your order so fulfillment can begin.\nConfirm order: ${confirmIntentUrl}\nCancel order: ${cancelIntentUrl}`,
      html: `<p>Your cash on delivery order <strong>#${escapeHtml(orderNumber)}</strong> is awaiting confirmation.</p><p>Amount due on delivery: <strong>{{money.order_total}}</strong>.</p><p>Please review and confirm your order so fulfillment can begin.</p><div style="margin:24px 0"><a href="${escapeHtml(confirmIntentUrl)}" style="display:inline-block;background:#13b6bb;background-image:linear-gradient(110deg,#13b6bb,#5866f3);color:#fff;padding:12px 22px;border-radius:12px;text-decoration:none;font-weight:700;margin:0 10px 10px 0">Confirm order</a><a href="${escapeHtml(cancelIntentUrl)}" style="display:inline-block;background:#f3f0fa;color:#49566d;padding:12px 22px;border:1px solid #e0e4ef;border-radius:12px;text-decoration:none;font-weight:700;margin:0 0 10px">Cancel order</a></div><p style="color:#64748b;font-size:13px">Either button opens Rozare, where you can review and confirm your choice.</p>`,
    },
    whatsapp: {
      message: `*Confirm your cash on delivery order*\n\nOrder: #${orderNumber}\nAmount due on delivery: {{money.order_total}}\n\nPlease review and confirm your order so fulfillment can begin:\n${confirmUrl}`,
    },
  };
  const whatsappInteractive = selectedChannels.includes('whatsapp') ? {
    buttonsPayloadJson: JSON.stringify(buildOrderButtonsPayload(order)),
    listPayloadJson: JSON.stringify(buildOrderListPayload(order)),
  } : null;
  return enqueueNotificationEvent({
    eventKey: `order:${id}:confirmation-requested:buyer:v1`,
    eventType: 'order.confirmation_requested',
    aggregateType: 'Order',
    aggregateId: id,
    occurredAt: requireEventDate(order?.createdAt, 'Order creation timestamp'),
    financial: true,
    recipient,
    channels: selectedChannels,
    templates,
    metadata: {
      category: 'order',
      linkTo: `/orders/confirm/${encodeURIComponent(token)}`,
      channelId: 'orders',
      relatedOrder: id,
      data: { type: 'order_confirmation_requested', orderId: id },
      ...(whatsappInteractive ? { whatsappInteractive } : {}),
    },
    money: [orderTotalSnapshot(order)],
    session,
  });
}

const codSellerDecisionTemplates = (
  orderNumber,
  decision,
  { includeMoney = true, actorRole = 'buyer' } = {},
) => {
  const confirmed = decision !== 'cancelled';
  const reconfirmed = decision === 'reconfirmed';
  const cancellationCopy = {
    buyer: {
      title: 'Buyer cancelled order',
      action: `The buyer cancelled order #${orderNumber}. Do not fulfill this cancelled order.`,
    },
    seller: {
      title: 'Seller cancelled order',
      action: `Order #${orderNumber} was cancelled by a seller. Do not fulfill this cancelled order.`,
    },
    admin: {
      title: 'Administrator cancelled order',
      action: `Rozare cancelled order #${orderNumber}. Do not fulfill this cancelled order.`,
    },
    system: {
      title: 'Order cancelled automatically',
      action: `Rozare automatically cancelled order #${orderNumber}. Do not fulfill this cancelled order.`,
    },
  };
  const title = confirmed
    ? (reconfirmed ? 'Buyer reconfirmed order' : 'Buyer confirmed order')
    : cancellationCopy[actorRole].title;
  const action = confirmed
    ? `The buyer ${reconfirmed ? 'reconfirmed' : 'confirmed'} order #${orderNumber}. View the order in Seller Dashboard to begin fulfillment.`
    : cancellationCopy[actorRole].action;
  const settlementMeaning = confirmed
    ? 'Cash on delivery has not been collected yet.'
    : 'No cash on delivery payment was collected.';
  const allocationSentence = includeMoney
    ? ` Store total: {{money.seller_store_total}}. ${confirmed ? 'Cash due' : 'Original cash total'}: {{money.seller_order_total}}.`
    : '';
  const allocationLine = includeMoney
    ? `\nStore total: {{money.seller_store_total}}\n${confirmed ? 'Cash due' : 'Original cash total'}: {{money.seller_order_total}}`
    : '';
  return {
    inapp: { title, body: `${action}${allocationSentence} ${settlementMeaning}` },
    push: { title, body: `Order #${orderNumber}.${allocationSentence} ${settlementMeaning}` },
    email: {
      subject: `${title} - ${orderNumber}`,
      text: `${action}${allocationSentence}\n\n${settlementMeaning}`,
      html: `<p>${escapeHtml(action)}</p>${includeMoney ? `<p>Store total: <strong>{{money.seller_store_total}}</strong>.</p><p>${confirmed ? 'Cash due' : 'Original cash total'}: <strong>{{money.seller_order_total}}</strong>.</p>` : ''}<p>${escapeHtml(settlementMeaning)}</p>`,
    },
    whatsapp: {
      message: `*${title}*\n\nOrder: #${orderNumber}${allocationLine}\n${settlementMeaning}\n\n${confirmed ? 'View the order in Seller Dashboard to begin fulfillment.' : 'Do not fulfill this cancelled order. View the order in Seller Dashboard for details.'}`,
    },
  };
};

async function enqueueCodOrderDecisionSellerNotifications(order, sellerId, {
  decision,
  transitionAt,
  actorRole = 'buyer',
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
} = {}) {
  if (!['confirmed', 'reconfirmed', 'cancelled'].includes(decision)) {
    throw outboxError('COD seller decision notification type is invalid.');
  }
  if (
    !ORDER_LIFECYCLE_ACTOR_ROLES.has(actorRole)
    || (decision !== 'cancelled' && actorRole !== 'buyer')
  ) {
    throw outboxError('COD seller decision notification actor role is invalid.');
  }
  if (order?.paymentMethod !== 'cash_on_delivery' || order?.isPaid === true) {
    throw outboxError('COD seller decision notifications require an unpaid cash on delivery order.');
  }
  const at = requireEventDate(transitionAt, 'COD decision timestamp');
  const id = stringId(order?._id);
  const seller = stringId(sellerId);
  const orderNumber = safeText(order?.orderId || id, 100);
  const transitionHash = crypto.createHash('sha256')
    .update(`${decision}:${at.toISOString()}`)
    .digest('hex');
  let money = [];
  try {
    money = sellerOrderMoneySnapshots(order, seller);
  } catch (error) {
    if (![
      'NOTIFICATION_SELLER_SETTLEMENT_MISSING',
      'NOTIFICATION_SELLER_CURRENCY_MONEY_MISSING',
    ].includes(error?.code)) throw error;
  }
  const financial = money.length > 0;
  return enqueueNotificationEvent({
    eventKey: `order:${id}:decision:${transitionHash}:seller:${seller}:v1`,
    eventType: `order.${decision}`,
    aggregateType: 'Order',
    aggregateId: id,
    occurredAt: at,
    financial,
    recipient: {
      kind: 'user', audienceRole: 'seller', user: seller, destinationPolicy: 'current_user',
    },
    channels,
    templates: codSellerDecisionTemplates(orderNumber, decision, {
      includeMoney: financial,
      actorRole,
    }),
    metadata: {
      category: 'order',
      linkTo: `/seller-dashboard/order/${encodeURIComponent(id)}`,
      channelId: 'seller',
      whatsappCategory: 'order_update',
      relatedOrder: id,
      data: { type: `cod_order_${decision}`, orderId: id, changedByRole: actorRole },
    },
    money,
    session,
  });
}

const returnBuyerTemplates = (returnNumber, orderNumber, liabilityApplied) => liabilityApplied ? ({
  inapp: {
    title: 'Return refund completed',
    body: `Your return #${returnNumber} for order #${orderNumber} is complete. Refund: {{money.refund_total}}. Available Wallet credit: {{money.refund_wallet_available}}. Applied to your outstanding Wallet balance owed: {{money.refund_liability_applied}}. Balance still owed: {{money.refund_remaining_liability}}.`,
  },
  push: {
    title: 'Return refund completed',
    body: `Return #${returnNumber}: refund {{money.refund_total}} processed. Available credit: {{money.refund_wallet_available}}. Applied to your Wallet balance owed: {{money.refund_liability_applied}}. Still owed: {{money.refund_remaining_liability}}.`,
  },
  email: {
    subject: `Return refund completed - ${returnNumber}`,
    text: `Your return #${returnNumber} for order #${orderNumber} is complete.\n\nRefund total: {{money.refund_total}}.\nAvailable Wallet credit: {{money.refund_wallet_available}}.\nApplied to your outstanding Wallet balance owed: {{money.refund_liability_applied}}.\nBalance still owed: {{money.refund_remaining_liability}}.`,
    html: `<p>Your return <strong>#${escapeHtml(returnNumber)}</strong> for order <strong>#${escapeHtml(orderNumber)}</strong> is complete.</p><p>Refund total: <strong>{{money.refund_total}}</strong>.</p><p>Available Wallet credit: <strong>{{money.refund_wallet_available}}</strong>.</p><p>Applied to your outstanding Wallet balance owed: <strong>{{money.refund_liability_applied}}</strong>.</p><p>Balance still owed: <strong>{{money.refund_remaining_liability}}</strong>.</p>`,
  },
  whatsapp: {
    message: `*Your return refund is complete*\n\nReturn: #${returnNumber}\nOrder: #${orderNumber}\nRefund total: {{money.refund_total}}\nAvailable Wallet credit: {{money.refund_wallet_available}}\nApplied to your outstanding Wallet balance owed: {{money.refund_liability_applied}}\nBalance still owed: {{money.refund_remaining_liability}}\n\nView your return in Rozare for details.`,
  },
}) : ({
  inapp: {
    title: 'Return refund completed',
    body: `Your return #${returnNumber} for order #${orderNumber} is complete. {{money.refund_total}} was credited to your Rozare Wallet.`,
  },
  push: {
    title: 'Return refund completed',
    body: `{{money.refund_total}} was credited for return #${returnNumber}.`,
  },
  email: {
    subject: `Return refund completed - ${returnNumber}`,
    text: `Your return #${returnNumber} for order #${orderNumber} is complete.\n\n{{money.refund_total}} was credited to your Rozare Wallet. You can use it for your next purchase.`,
    html: `<p>Your return <strong>#${escapeHtml(returnNumber)}</strong> for order <strong>#${escapeHtml(orderNumber)}</strong> is complete.</p><p><strong>{{money.refund_total}}</strong> was credited to your Rozare Wallet. You can use it for your next purchase.</p>`,
  },
  whatsapp: {
    message: `*Your return refund is complete*\n\nReturn: #${returnNumber}\nOrder: #${orderNumber}\nWallet refund: {{money.refund_total}}\n\nThe refund is available in your Rozare Wallet for your next purchase. View your return in Rozare for details.`,
  },
});

const returnSellerTemplates = (returnNumber, orderNumber) => ({
  inapp: {
    title: 'Return refund completed',
    body: `Return #${returnNumber} for order #${orderNumber} is complete. The buyer's refund of {{money.refund_total}} has been processed.`,
  },
  push: {
    title: 'Return refund completed',
    body: `Return #${returnNumber}: refund {{money.refund_total}} was processed.`,
  },
  email: {
    subject: `Return completed - ${returnNumber}`,
    text: `Return #${returnNumber} for order #${orderNumber} is complete.\n\nThe buyer's refund of {{money.refund_total}} has been processed to their Rozare Wallet. The amount is shown in the original order currency. View the return in Seller Dashboard for details.`,
    html: `<p>Return <strong>#${escapeHtml(returnNumber)}</strong> for order <strong>#${escapeHtml(orderNumber)}</strong> is complete.</p><p>The buyer's refund of <strong>{{money.refund_total}}</strong> has been processed to their Rozare Wallet.</p><p>The amount is shown in the original order currency. View the return in Seller Dashboard for details.</p>`,
  },
  whatsapp: {
    message: `*Return completed*\n\nReturn: #${returnNumber}\nOrder: #${orderNumber}\nBuyer refund: {{money.refund_total}} (order currency)\n\nThe refund has been processed to the buyer's Rozare Wallet. View the return in Seller Dashboard for details.`,
  },
});

const loadReturnWalletTransaction = async (returnRequest, suppliedTransaction, session) => {
  const expectedId = stringId(returnRequest?.settlement?.walletTransaction);
  if (!expectedId) {
    throw outboxError('Return settlement notifications require the completed Wallet transaction.');
  }
  if (suppliedTransaction && stringId(suppliedTransaction?._id) !== expectedId) {
    throw outboxError('The supplied Wallet transaction does not match the return settlement.');
  }
  if (suppliedTransaction) return suppliedTransaction;
  const query = WalletTransaction.findById(expectedId);
  return session ? query.session(session) : query;
};

async function enqueueReturnSettlementNotifications(returnRequest, order, {
  buyerChannels = null,
  sellerChannels = ['inapp', 'push', 'email', 'whatsapp'],
  walletTransaction = null,
  session = null,
} = {}) {
  if (returnRequest?.status !== 'returned' || returnRequest?.settlement?.status !== 'completed') {
    throw outboxError('Return settlement notifications require a completed returned record.');
  }
  const id = stringId(returnRequest?._id);
  const relatedOrder = stringId(order?._id || returnRequest?.order);
  if (relatedOrder !== stringId(returnRequest?.order)) {
    throw outboxError('The return notification order does not match the return request.');
  }
  if (stringId(order?.user) !== stringId(returnRequest?.buyer)) {
    throw outboxError('The return notification buyer does not own the related order.');
  }
  const returnNumber = safeText(returnRequest?.returnNumber || id, 100);
  const orderNumber = safeText(returnRequest?.orderId || order?.orderId || relatedOrder, 100);
  const occurredAt = requireEventDate(returnRequest?.settlement?.settledAt, 'Return settlement timestamp');
  const refundMoney = returnRefundSnapshot(returnRequest);
  const authoritativeWalletTransaction = await loadReturnWalletTransaction(
    returnRequest,
    walletTransaction,
    session,
  );
  if (
    !authoritativeWalletTransaction
    || authoritativeWalletTransaction.status !== 'completed'
    || authoritativeWalletTransaction.direction !== 'credit'
    || authoritativeWalletTransaction.type !== 'return_refund'
    || authoritativeWalletTransaction.referenceType !== 'return_request'
    || stringId(authoritativeWalletTransaction.referenceId) !== id
    || stringId(authoritativeWalletTransaction.user) !== stringId(returnRequest.buyer)
  ) {
    throw outboxError('The return Wallet transaction does not match the completed buyer refund.');
  }
  requireEventDate(authoritativeWalletTransaction.completedAt, 'Return Wallet completion timestamp');
  const walletBreakdown = walletCreditBreakdownSnapshots(authoritativeWalletTransaction, {
    totalKey: 'refund_wallet_total',
    availableKey: 'refund_wallet_available',
    liabilityAppliedKey: 'refund_liability_applied',
    remainingLiabilityKey: 'refund_remaining_liability',
  });
  if (
    walletBreakdown.total.amountMinor !== refundMoney.amountMinor
    || walletBreakdown.total.currency !== refundMoney.currency
  ) {
    throw outboxError('The return Wallet transaction does not conserve the frozen refund total.');
  }
  const liabilityApplied = walletBreakdown.liabilityApplied.amountMinor > 0;
  const buyerMoney = liabilityApplied
    ? [
      refundMoney,
      walletBreakdown.available,
      walletBreakdown.liabilityApplied,
      walletBreakdown.remainingLiability,
    ]
    : [refundMoney];
  const sellerMoney = [refundMoney];
  const selectedBuyerChannels = buyerChannels || buyerReceiptChannels(order);
  if (!selectedBuyerChannels.length && !sellerChannels.length) {
    throw outboxError('Return settlement notifications require at least one recipient channel.');
  }
  const buyer = selectedBuyerChannels.length ? await enqueueNotificationEvent({
    eventKey: `return:${id}:settled:buyer:v2`,
    eventType: 'return.settled',
    aggregateType: 'ReturnRequest',
    aggregateId: id,
    occurredAt,
    financial: true,
    recipient: {
      kind: 'user',
      audienceRole: 'buyer',
      user: returnRequest.buyer,
      destinationPolicy: 'event_snapshot',
      email: order?.shippingInfo?.email,
      phone: tryOrderBuyerPhoneE164(order),
      allowBlocked: true,
    },
    channels: selectedBuyerChannels,
    templates: returnBuyerTemplates(returnNumber, orderNumber, liabilityApplied),
    metadata: {
      category: 'order',
      linkTo: `/user-dashboard/order/detail/${relatedOrder}?returnId=${id}`,
      channelId: 'orders',
      relatedOrder,
      data: { type: 'return_settled', returnRequestId: id, orderId: relatedOrder },
    },
    money: buyerMoney,
    session,
  }) : [];
  const seller = sellerChannels.length ? await enqueueNotificationEvent({
    eventKey: `return:${id}:settled:seller:v2`,
    eventType: 'return.settled',
    aggregateType: 'ReturnRequest',
    aggregateId: id,
    occurredAt,
    financial: true,
    recipient: {
      kind: 'user',
      audienceRole: 'seller',
      user: returnRequest.seller,
      destinationPolicy: 'current_user',
      allowBlocked: true,
    },
    channels: sellerChannels,
    templates: returnSellerTemplates(returnNumber, orderNumber),
    metadata: {
      category: 'order',
      linkTo: `/seller-dashboard/order-management?tab=returns&returnId=${id}`,
      channelId: 'seller',
      whatsappCategory: 'return_update',
      relatedOrder,
      data: { type: 'return_settled', returnRequestId: id, orderId: relatedOrder },
    },
    money: sellerMoney,
    session,
  }) : [];
  return { buyer, seller };
}

const withdrawalTemplates = ({
  title,
  statusLabel,
  statusMeaning = '',
  note = '',
  reference = '',
  requestedAndPayout = true,
}) => {
  const noteText = note ? ` Note: ${note}` : '';
  const meaningText = statusMeaning ? ` ${statusMeaning}` : '';
  const amountText = requestedAndPayout
    ? 'Requested amount: {{money.requested_amount}}. Bank transfer amount: {{money.payout_amount}}.'
    : 'Amount: {{money.requested_amount}}.';
  return {
    inapp: { title, body: `${amountText} Status: ${statusLabel}.${meaningText}${noteText}` },
    push: { title, body: `${amountText} Status: ${statusLabel}.${meaningText}` },
    email: {
      subject: title,
      text: `${amountText}\nStatus: ${statusLabel}.${meaningText}${noteText}${reference ? `\nWithdrawal reference: ${reference}` : ''}`,
      html: `<p>${amountText}</p><p>Status: <strong>${escapeHtml(statusLabel)}</strong>.</p>${statusMeaning ? `<p>${escapeHtml(statusMeaning)}</p>` : ''}${note ? `<p>Note: ${escapeHtml(note)}</p>` : ''}${reference ? `<p>Withdrawal reference: ${escapeHtml(reference)}</p>` : ''}`,
    },
    whatsapp: {
      message: `*${title}*\n\n${amountText.replace(/\. /g, '\n')}\nStatus: ${statusLabel}${statusMeaning ? `\n${statusMeaning}` : ''}${note ? `\nNote: ${note}` : ''}${reference ? `\nWithdrawal reference: ${reference}` : ''}\n\nView Payments in Seller Dashboard for details.`,
    },
  };
};

const withdrawalMoney = withdrawal => [
  withdrawalRequestedSnapshot(withdrawal),
  withdrawalPayoutSnapshot(withdrawal),
];

async function enqueueWithdrawalRequestedSellerNotifications(withdrawal, {
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
} = {}) {
  const id = stringId(withdrawal?._id);
  return enqueueNotificationEvent({
    eventKey: `withdrawal:${id}:requested:seller:v1`,
    eventType: 'withdrawal.requested',
    aggregateType: 'SellerWithdrawalRequest',
    aggregateId: id,
    occurredAt: requireEventDate(withdrawal?.createdAt, 'Withdrawal creation timestamp'),
    financial: true,
    recipient: {
      kind: 'user', audienceRole: 'seller', user: withdrawal?.seller, destinationPolicy: 'current_user', allowBlocked: true,
    },
    channels,
    templates: withdrawalTemplates({
      title: 'Withdrawal request received',
      statusLabel: 'Pending review',
      statusMeaning: 'Your request was received. The requested funds are reserved while Rozare reviews it.',
      reference: id,
    }),
    metadata: {
      category: 'payment',
      linkTo: '/seller-dashboard/payments',
      channelId: 'seller',
      whatsappCategory: 'withdrawal_update',
      data: { type: 'withdrawal_requested', withdrawalId: id, status: 'pending' },
    },
    money: withdrawalMoney(withdrawal),
    session,
  });
}

async function enqueueWithdrawalStatusSellerNotifications(withdrawal, {
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
} = {}) {
  const id = stringId(withdrawal?._id);
  const status = safeText(withdrawal?.status, 40).toLowerCase();
  if (!/^[a-z][a-z_]{1,39}$/.test(status)) throw outboxError('Withdrawal notification status is invalid.');
  const statusLabel = status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ');
  const note = safeText(withdrawal?.adminNote, 500);
  const operation = (withdrawal?.adminOperations || []).at(-1);
  const operationKey = operation?.operationKey;
  if (
    typeof operationKey !== 'string'
    || operationKey !== operationKey.trim()
    || !operationKey
    || operationKey.length > 200
  ) {
    throw outboxError(
      'Withdrawal status notifications require the durable admin operation key.',
      'WITHDRAWAL_NOTIFICATION_OPERATION_REQUIRED'
    );
  }
  if (operation?.toStatus !== status) {
    throw outboxError(
      'The withdrawal notification operation does not match the persisted status.',
      'WITHDRAWAL_NOTIFICATION_OPERATION_MISMATCH'
    );
  }
  const operationHash = crypto.createHash('sha256').update(operationKey).digest('hex');
  const statusMeanings = {
    pending: 'Your request is awaiting review. The requested funds remain reserved; no bank transfer has been sent.',
    approved: 'Your request was approved. The requested funds remain reserved until the bank transfer is completed.',
    processing: 'Your bank transfer is being processed. We will notify you when its status is updated.',
    manual_review: 'Rozare is checking the transfer outcome. The requested funds remain reserved until this review is resolved.',
    failed: 'The bank transfer failed and the withdrawal reservation was released. View Payments for your current withdrawable balance.',
    paid: 'Your bank transfer has been recorded as paid. View Payments for the transfer details.',
    rejected: 'Your request was rejected and the withdrawal reservation was released. View Payments for your current withdrawable balance.',
    cancelled: 'Your request was cancelled and the withdrawal reservation was released. View Payments for your current withdrawable balance.',
  };
  const statusMeaning = statusMeanings[status];
  if (!statusMeaning) throw outboxError('Withdrawal notification status is unsupported.');
  return enqueueNotificationEvent({
    eventKey: `withdrawal:${id}:status:${status}:operation:${operationHash}:seller:v1`,
    eventType: 'withdrawal.status_changed',
    aggregateType: 'SellerWithdrawalRequest',
    aggregateId: id,
    occurredAt: requireEventDate(operation?.appliedAt, 'Withdrawal operation timestamp'),
    financial: true,
    recipient: {
      kind: 'user', audienceRole: 'seller', user: withdrawal?.seller, destinationPolicy: 'current_user', allowBlocked: true,
    },
    channels,
    templates: withdrawalTemplates({
      title: `Withdrawal ${statusLabel}`,
      statusLabel,
      statusMeaning,
      note,
      reference: id,
    }),
    metadata: {
      category: 'payment',
      linkTo: '/seller-dashboard/payments',
      channelId: 'seller',
      whatsappCategory: 'withdrawal_update',
      data: { type: 'withdrawal_status_changed', withdrawalId: id, status },
    },
    money: withdrawalMoney(withdrawal),
    session,
  });
}

async function enqueueWithdrawalRequestedAdminNotifications(withdrawal, adminIds, sellerName = 'A seller', {
  channels = ['inapp', 'push', 'email'],
  session = null,
} = {}) {
  const id = stringId(withdrawal?._id);
  const safeSeller = safeText(sellerName, 100);
  const templates = {
    inapp: {
      title: 'New seller withdrawal request',
      body: `${safeSeller} requested {{money.requested_amount}}. Bank transfer amount: {{money.payout_amount}}. Review the request and use its saved payout details if approved.`,
    },
    push: {
      title: 'New seller withdrawal request',
      body: `${safeSeller} requested {{money.requested_amount}}. Bank transfer amount: {{money.payout_amount}}.`,
    },
    email: {
      subject: 'New seller withdrawal request',
      text: `${safeSeller} requested a withdrawal.\n\nRequested amount: {{money.requested_amount}}.\nBank transfer amount: {{money.payout_amount}}.\nWithdrawal reference: ${id}\nReview the request. If approved, send the exact bank transfer amount to the payout destination saved on this request.`,
      html: `<p><strong>${escapeHtml(safeSeller)}</strong> requested a withdrawal.</p><p>Requested amount: <strong>{{money.requested_amount}}</strong>.</p><p>Bank transfer amount: <strong>{{money.payout_amount}}</strong>.</p><p>Withdrawal reference: ${escapeHtml(id)}</p><p>Review the request. If approved, send the exact bank transfer amount to the payout destination saved on this request.</p>`,
    },
  };
  const uniqueAdmins = [...new Set((adminIds || []).map(stringId).filter(Boolean))];
  const results = [];
  for (const adminId of uniqueAdmins) {
    results.push(...await enqueueNotificationEvent({
      eventKey: `withdrawal:${id}:requested:admin:${adminId}:v1`,
      eventType: 'withdrawal.requested',
      aggregateType: 'SellerWithdrawalRequest',
      aggregateId: id,
      occurredAt: requireEventDate(withdrawal?.createdAt, 'Withdrawal creation timestamp'),
      financial: true,
      recipient: {
        kind: 'user', audienceRole: 'admin', user: adminId, destinationPolicy: 'current_user',
      },
      channels,
      templates,
      metadata: {
        category: 'payment',
        linkTo: '/admin-dashboard/payments',
        channelId: 'general',
        data: { type: 'withdrawal_requested', withdrawalId: id, status: 'pending' },
      },
      money: withdrawalMoney(withdrawal),
      session,
    }));
  }
  return results;
}

async function enqueueWalletTransactionNotification(transaction, {
  channels = ['inapp', 'push', 'email'],
  session = null,
} = {}) {
  if (transaction?.status !== 'completed') {
    throw outboxError('Wallet money notifications require a completed transaction.');
  }
  if (!['credit', 'debit'].includes(transaction?.direction)) {
    throw outboxError('Wallet money notifications require an exact credit or debit direction.');
  }
  const id = stringId(transaction?._id);
  let templates;
  let money;
  let eventVersion = 'v1';
  if (transaction.direction === 'credit') {
    const breakdown = walletCreditBreakdownSnapshots(transaction);
    const liabilityApplied = breakdown.liabilityApplied.amountMinor > 0;
    // Preserve the original event identity when a normal credit's rendered
    // meaning did not change. Only liability-splitting credits need the v2
    // schema; bumping every credit would duplicate already-frozen v1 receipts
    // during a legitimate settlement recovery replay after deployment.
    eventVersion = liabilityApplied ? 'v2' : 'v1';
    money = liabilityApplied
      ? [breakdown.total, breakdown.available, breakdown.liabilityApplied, breakdown.remainingLiability]
      : [breakdown.total];
    const title = liabilityApplied ? 'Wallet credit processed' : 'Wallet credited';
    templates = liabilityApplied ? {
      inapp: {
        title,
        body: `Your Wallet credit of {{money.wallet_amount}} was processed. Available credit: {{money.wallet_available_credit}}. Applied to your outstanding Wallet balance owed: {{money.wallet_liability_applied}}. Balance still owed: {{money.wallet_remaining_liability}}.`,
      },
      push: {
        title,
        body: `Wallet credit: {{money.wallet_amount}}. Available: {{money.wallet_available_credit}}. Applied to your Wallet balance owed: {{money.wallet_liability_applied}}. Still owed: {{money.wallet_remaining_liability}}.`,
      },
      email: {
        subject: title,
        text: `Your Wallet credit was processed.\n\nTotal credit: {{money.wallet_amount}}.\nAvailable Wallet credit: {{money.wallet_available_credit}}.\nApplied to your outstanding Wallet balance owed: {{money.wallet_liability_applied}}.\nBalance still owed: {{money.wallet_remaining_liability}}.\nReference: ${safeText(transaction?.referenceId, 120)}.`,
        html: `<p>Your Wallet credit was processed.</p><p>Total credit: <strong>{{money.wallet_amount}}</strong>.</p><p>Available Wallet credit: <strong>{{money.wallet_available_credit}}</strong>.</p><p>Applied to your outstanding Wallet balance owed: <strong>{{money.wallet_liability_applied}}</strong>.</p><p>Balance still owed: <strong>{{money.wallet_remaining_liability}}</strong>.</p><p>Reference: ${escapeHtml(safeText(transaction?.referenceId, 120))}</p>`,
      },
    } : {
      inapp: { title, body: '{{money.wallet_amount}} was credited to your Rozare Wallet.' },
      push: { title, body: '{{money.wallet_amount}} was credited to your Rozare Wallet.' },
      email: {
        subject: title,
        text: `{{money.wallet_amount}} was credited to your Rozare Wallet. Reference: ${safeText(transaction?.referenceId, 120)}.`,
        html: `<p><strong>{{money.wallet_amount}}</strong> was credited to your Rozare Wallet.</p><p>Reference: ${escapeHtml(safeText(transaction?.referenceId, 120))}</p>`,
      },
    };
  } else {
    const isOrderPayment = transaction.type === 'order_payment';
    const title = isOrderPayment ? 'Wallet payment completed' : 'Wallet balance updated';
    const debitText = isOrderPayment
      ? 'You paid {{money.wallet_amount}} from your Rozare Wallet.'
      : '{{money.wallet_amount}} was deducted from your Rozare Wallet. View your transaction history for the reason.';
    money = [walletTransactionSnapshot(transaction)];
    templates = {
      inapp: { title, body: debitText },
      push: { title, body: debitText },
      email: {
        subject: title,
        text: `${debitText}\n\nReference: ${safeText(transaction?.referenceId, 120)}.`,
        html: `<p>${debitText}</p><p>Reference: ${escapeHtml(safeText(transaction?.referenceId, 120))}</p>`,
      },
    };
  }
  return enqueueNotificationEvent({
    eventKey: `wallet-transaction:${id}:completed:buyer:${eventVersion}`,
    eventType: 'wallet.completed',
    aggregateType: 'WalletTransaction',
    aggregateId: id,
    occurredAt: requireEventDate(transaction?.completedAt, 'Wallet completion timestamp'),
    financial: true,
    recipient: {
      kind: 'user', audienceRole: 'buyer', user: transaction?.user, destinationPolicy: 'current_user', allowBlocked: true,
    },
    channels,
    templates,
    metadata: {
      category: 'payment',
      linkTo: '/user-dashboard/wallet',
      channelId: 'general',
      data: { type: 'wallet_transaction_completed', transactionId: id, direction: transaction.direction },
    },
    money,
    session,
  });
}

async function enqueueSubscriptionPaymentNotification(payment, {
  kind = 'received',
  planName = 'Rozare subscription',
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  occurredAt = null,
  session = null,
} = {}) {
  if (!['received', 'recovered'].includes(kind)) throw outboxError('Subscription payment notification kind is invalid.');
  const id = stringId(payment?._id);
  const safePlan = safeText(planName, 100);
  const title = kind === 'recovered' ? 'Subscription payment recovered' : 'Subscription payment received';
  const stateText = kind === 'recovered'
    ? 'This payment restored your subscription when it was processed.'
    : 'Your subscription payment was processed successfully.';
  const templates = {
    inapp: { title, body: `${stateText} Paid amount: {{money.invoice_paid}}.` },
    push: { title, body: `${safePlan}: {{money.invoice_paid}} paid successfully.` },
    email: {
      subject: title,
      text: `${stateText} Plan: ${safePlan}. Paid amount: {{money.invoice_paid}}.`,
      html: `<p>${escapeHtml(stateText)}</p><p>Plan: <strong>${escapeHtml(safePlan)}</strong></p><p>Paid amount: <strong>{{money.invoice_paid}}</strong></p>`,
    },
    whatsapp: {
      message: `${title}\n\nPlan: ${safePlan}\nPaid amount: {{money.invoice_paid}}\n\n${stateText}`,
    },
  };
  return enqueueNotificationEvent({
    eventKey: `subscription-payment:${id}:${kind}:seller:v1`,
    eventType: `subscription.payment_${kind}`,
    aggregateType: 'StripeEntitlementPayment',
    aggregateId: id,
    occurredAt: requireEventDate(occurredAt || payment?.createdAt, 'Subscription payment timestamp'),
    financial: true,
    recipient: {
      kind: 'user', audienceRole: 'seller', user: payment?.seller, destinationPolicy: 'current_user', allowBlocked: true,
    },
    channels,
    templates,
    metadata: {
      category: 'subscription',
      linkTo: '/seller-dashboard/subscription',
      channelId: 'seller',
      whatsappCategory: kind === 'recovered' ? 'payment_recovered' : 'subscription_activated',
      data: { type: `subscription_payment_${kind}`, paymentId: id },
    },
    money: [subscriptionCapturedSnapshot(payment)],
    session,
  });
}

async function enqueueSubdomainPaymentNotification(payment, store, {
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  occurredAt = null,
  session = null,
} = {}) {
  if (payment?.entitlementType !== 'subdomain') {
    throw outboxError('Subdomain payment notifications require a subdomain entitlement payment.');
  }
  const id = stringId(payment?._id);
  const storeId = stringId(store?._id);
  if (!storeId || stringId(payment?.store) !== storeId || stringId(payment?.seller) !== stringId(store?.seller)) {
    throw outboxError('Subdomain payment notification ownership is invalid.');
  }
  // Both the purchased resource and its contribution end were frozen on the
  // payment ledger. A replay after a later rename/renewal must reproduce the
  // original receipt instead of reinterpreting mutable Store state.
  const slug = safeText(payment?.resourceKey, 120);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw outboxError('Subdomain payment notification slug is invalid.');
  }
  const expiresAt = payment?.grantEnd instanceof Date
    ? payment.grantEnd
    : new Date(payment?.grantEnd);
  if (!Number.isFinite(expiresAt.getTime())) {
    throw outboxError('Subdomain payment notification expiry is invalid.');
  }
  const expiryDate = expiresAt.toISOString().slice(0, 10);
  const title = 'Subdomain ownership payment received';
  const stateText = `Payment was received for ${slug}.rozare.com. Its original paid ownership period runs through ${expiryDate}; later refunds or disputes may change current access.`;
  const templates = {
    inapp: { title, body: `${stateText} Paid amount: {{money.subdomain_paid}}.` },
    push: { title: 'Subdomain payment received', body: `${slug}.rozare.com: {{money.subdomain_paid}} received. Check current access in Seller Dashboard.` },
    email: {
      subject: title,
      text: `${stateText} Paid amount: {{money.subdomain_paid}}. Open Seller Dashboard > Subdomain for details.`,
      html: `<p>Payment was received for <strong>${escapeHtml(`${slug}.rozare.com`)}</strong>.</p><p>Original paid ownership period: through ${escapeHtml(expiryDate)}. Later refunds or disputes may change current access.</p><p>Paid amount: <strong>{{money.subdomain_paid}}</strong>.</p><p>Open Seller Dashboard &gt; Subdomain for current details.</p>`,
    },
    whatsapp: {
      message: `Subdomain Payment Received\n\n${slug}.rozare.com\nPaid amount: {{money.subdomain_paid}}\nOriginal paid period through: ${expiryDate}\nLater refunds or disputes may change current access.\n\nOpen Seller Dashboard > Subdomain for current details.`,
    },
  };
  return enqueueNotificationEvent({
    eventKey: `subdomain-payment:${id}:seller:v1`,
    eventType: 'subdomain.payment_received',
    aggregateType: 'StripeEntitlementPayment',
    aggregateId: id,
    occurredAt: requireEventDate(occurredAt || payment?.createdAt, 'Subdomain payment timestamp'),
    financial: true,
    recipient: {
      kind: 'user', audienceRole: 'seller', user: payment?.seller, destinationPolicy: 'current_user', allowBlocked: true,
    },
    channels,
    templates,
    metadata: {
      category: 'payment',
      linkTo: '/seller-dashboard/subdomain',
      channelId: 'seller',
      whatsappCategory: 'subdomain_payment',
      data: { type: 'subdomain_payment_received', paymentId: id, storeId },
    },
    money: [stripeEntitlementCapturedSnapshot(
      payment,
      'subdomain_paid',
      'Subdomain ownership payment',
    )],
    session,
  });
}

async function enqueueSubscriptionCancellationNotification(subscription, {
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
} = {}) {
  const id = stringId(subscription?._id);
  const transition = subscription?.cancellationTransition;
  const stripeSubscriptionId = safeText(transition?.stripeSubscriptionId, 200);
  if (!stripeSubscriptionId) {
    throw outboxError(
      'Subscription cancellation notifications require the ended Stripe subscription id.',
      'SUBSCRIPTION_CANCELLATION_ID_REQUIRED'
    );
  }
  if (String(subscription?.stripeSubscriptionId || '') !== stripeSubscriptionId) {
    throw outboxError(
      'The cancellation transition no longer owns the seller subscription.',
      'SUBSCRIPTION_CANCELLATION_STALE'
    );
  }
  if (subscription?.status !== 'blocked') {
    throw outboxError(
      'Subscription cancellation notifications require the persisted blocked state.',
      'SUBSCRIPTION_CANCELLATION_STATE_INVALID'
    );
  }

  const planName = safeText(subscription?.planName || subscription?.plan || 'Rozare subscription', 100);
  const title = 'Subscription ended - store blocked';
  const stateText = `Your ${planName} subscription ended. Your store is hidden until you subscribe again.`;
  const templates = {
    inapp: { title, body: stateText },
    push: { title: 'Subscription ended', body: 'Your store is hidden. Subscribe again to reactivate it.' },
    email: {
      subject: title,
      text: `${stateText} Open Seller Dashboard > Subscription to reactivate your store.`,
      html: `<p>${escapeHtml(stateText)}</p><p>Open <strong>Seller Dashboard &gt; Subscription</strong> to reactivate your store.</p>`,
    },
    whatsapp: {
      message: `Subscription Ended\n\n${stateText}\n\nOpen Seller Dashboard > Subscription to reactivate your store.`,
    },
  };
  const transitionHash = crypto.createHash('sha256').update(stripeSubscriptionId).digest('hex');
  return enqueueNotificationEvent({
    eventKey: `subscription:${id}:cancelled:${transitionHash}:seller:v1`,
    eventType: 'subscription.cancelled',
    aggregateType: 'SellerSubscription',
    aggregateId: id,
    occurredAt: requireEventDate(transition?.cancelledAt, 'Subscription cancellation timestamp'),
    financial: false,
    recipient: {
      kind: 'user',
      audienceRole: 'seller',
      user: subscription?.seller,
      destinationPolicy: 'current_user',
      // The cancellation itself may block account access. This is an explicit
      // account alert and must still reach the affected seller.
      allowBlocked: true,
    },
    channels,
    templates,
    metadata: {
      category: 'subscription',
      linkTo: '/seller-dashboard/subscription',
      channelId: 'seller',
      whatsappCategory: 'account_blocked',
      data: {
        type: 'subscription_cancelled',
        subscriptionId: id,
      },
    },
    session,
  });
}

module.exports = {
  enqueueCodOrderBuyerConfirmationNotification,
  enqueueCodOrderDecisionSellerNotifications,
  enqueueCodOrderSellerNotifications,
  enqueueNoChargeOrderBuyerNotifications,
  enqueueNoChargeOrderSellerNotifications,
  enqueueOrderLifecycleBuyerNotifications,
  enqueueOrderSellerFulfillmentBuyerNotifications,
  enqueueOrderStockRefundBuyerNotifications,
  enqueuePaidOrderBuyerNotifications,
  enqueuePaidOrderSellerNotifications,
  enqueueReturnSettlementNotifications,
  enqueueSubscriptionCancellationNotification,
  enqueueSubscriptionPaymentNotification,
  enqueueSubdomainPaymentNotification,
  enqueueWalletTransactionNotification,
  enqueueWithdrawalRequestedAdminNotifications,
  enqueueWithdrawalRequestedSellerNotifications,
  enqueueWithdrawalStatusSellerNotifications,
};
