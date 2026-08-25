'use strict';

const crypto = require('crypto');
const WalletTransaction = require('../models/WalletTransaction');
const { escapeHtml } = require('../utils/orderPresentation');
const {
  enqueueNotificationEvent,
  outboxError,
} = require('./notificationOutboxService');
const {
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
const {
  buildOrderButtonsPayload,
  buildOrderListPayload,
} = require('./whatsapp/messageBuilder');
const { tryOrderBuyerPhoneE164 } = require('./orderBuyerContactService');

const stringId = value => value?._id?.toString?.() || value?.toString?.() || '';
const safeText = (value, max = 300) => String(value || '').trim().slice(0, max);
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
    detail: 'Your order has been confirmed and is being prepared.',
  },
  processing: {
    title: 'Order processing',
    detail: 'Your order is now being prepared for shipment.',
  },
  shipped: {
    title: 'Order shipped',
    detail: 'Your order has been handed to the courier and is on the way.',
  },
  delivered: {
    title: 'Order delivered',
    detail: 'Your order has been marked delivered.',
  },
  cancelled: {
    title: 'Order cancelled',
    detail: 'Your order has been cancelled. This status does not by itself record or promise a refund.',
  },
});
const ORDER_LIFECYCLE_ACTOR_ROLES = new Set(['buyer', 'seller', 'admin', 'system']);

const orderLifecycleBuyerTemplates = (orderNumber, status) => {
  const copy = ORDER_LIFECYCLE_STATUS_COPY[status];
  const totalSentence = 'Frozen order total: {{money.order_total}}.';
  return {
    inapp: {
      title: copy.title,
      body: `Order #${orderNumber}: ${copy.detail} ${totalSentence}`,
    },
    push: {
      title: copy.title,
      body: `Order #${orderNumber}: ${copy.detail} ${totalSentence}`,
    },
    email: {
      subject: `${copy.title} - ${orderNumber}`,
      text: `Order #${orderNumber}: ${copy.detail} ${totalSentence} Open your Rozare account for details.`,
      html: `<p>Order <strong>#${escapeHtml(orderNumber)}</strong>: ${escapeHtml(copy.detail)}</p><p>${totalSentence}</p><p>Open your Rozare account for details.</p>`,
    },
    whatsapp: {
      message: `${copy.title}\n\nOrder: #${orderNumber}\n${copy.detail}\n${totalSentence}\n\nOpen your Rozare account for details.`,
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
    templates: orderLifecycleBuyerTemplates(orderNumber, status),
    metadata: {
      category: 'order',
      linkTo: `/user-dashboard/order/detail/${id}`,
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
      linkTo: `/user-dashboard/order/detail/${id}`,
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
    body: `Payment for order #${orderNumber} is complete. Charged total: {{money.order_total}}.`,
  },
  push: {
    title: 'Payment received',
    body: `Order #${orderNumber} was paid successfully. Total: {{money.order_total}}.`,
  },
  email: {
    subject: `Payment received for order ${orderNumber}`,
    text: `Your payment for order #${orderNumber} was successful. Charged total: {{money.order_total}}.`,
    html: `<p>Your payment for order <strong>#${escapeHtml(orderNumber)}</strong> was successful.</p><p>Charged total: <strong>{{money.order_total}}</strong></p>`,
  },
  whatsapp: {
    message: `Rozare Payment Received\n\nOrder: #${orderNumber}\nCharged total: {{money.order_total}}\n\nOpen your Rozare account for order details.`,
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
      linkTo: `/user-dashboard/order/detail/${id}`,
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
    body: `Your portion of order #${orderNumber} is {{money.seller_order_total}} in the buyer's frozen order currency.`,
  },
  push: {
    title: 'Paid order received',
    body: `Order #${orderNumber}: your order allocation is {{money.seller_order_total}}.`,
  },
  email: {
    subject: `Paid order received - ${orderNumber}`,
    text: `Your portion of buyer order #${orderNumber} is {{money.seller_order_total}} in the order currency. Open Seller Dashboard to process it.`,
    html: `<p>You received paid order <strong>#${escapeHtml(orderNumber)}</strong>.</p><p>Your portion of the buyer order total: <strong>{{money.seller_order_total}}</strong>.</p><p>This is the frozen order-currency allocation, not a live-FX estimate of a bank payout.</p>`,
  },
  whatsapp: {
    message: `Paid Order Received\n\nOrder: #${orderNumber}\nYour order allocation: {{money.seller_order_total}}\n\nThis is the frozen buyer-order currency amount. Open Seller Dashboard to process the order.`,
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
      linkTo: `/seller-dashboard/order-management?orderId=${encodeURIComponent(id)}`,
      channelId: 'seller',
      whatsappCategory: 'new_order',
      relatedOrder: id,
      data: { type: 'paid_order_received', orderId: id },
    },
    money: [orderSellerTotalSnapshot(order, seller)],
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
    message: `Rozare Order Confirmed\n\nOrder: #${orderNumber}\nTotal: {{money.order_total}}\nNo payment was required or charged.\n\nOpen your Rozare account for order details.`,
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
      linkTo: `/user-dashboard/order/detail/${id}`,
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
    body: `Order #${orderNumber} is confirmed. Your frozen order allocation is {{money.seller_order_total}}; no buyer payment was required.`,
  },
  push: {
    title: 'No-charge order received',
    body: `Order #${orderNumber}: your allocation is {{money.seller_order_total}}. No buyer payment was required.`,
  },
  email: {
    subject: `No-charge order received - ${orderNumber}`,
    text: `Order #${orderNumber} is confirmed. Your frozen order allocation is {{money.seller_order_total}}. No buyer payment was required or collected. Open Seller Dashboard to process your items.`,
    html: `<p>Order <strong>#${escapeHtml(orderNumber)}</strong> is confirmed.</p><p>Your frozen order allocation: <strong>{{money.seller_order_total}}</strong>.</p><p>No buyer payment was required or collected. Open Seller Dashboard to process your items.</p>`,
  },
  whatsapp: {
    message: `No-Charge Order Received\n\nOrder: #${orderNumber}\nYour order allocation: {{money.seller_order_total}}\nNo buyer payment was required or collected.\n\nOpen Seller Dashboard to process your items.`,
  },
});

async function enqueueNoChargeOrderSellerNotifications(order, sellerId, {
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
} = {}) {
  const id = stringId(order?._id);
  const seller = stringId(sellerId);
  const orderNumber = safeText(order?.orderId || id, 100);
  const sellerTotal = requireZeroSnapshot(
    orderSellerTotalSnapshot(order, seller),
    'No-charge seller allocation',
  );
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
      linkTo: `/seller-dashboard/order-management?orderId=${encodeURIComponent(id)}`,
      channelId: 'seller',
      whatsappCategory: 'new_order',
      relatedOrder: id,
      data: { type: 'no_charge_order_received', orderId: id },
    },
    money: [sellerTotal],
    session,
  });
}

const codSellerPlacedTemplates = orderNumber => ({
  inapp: {
    title: 'New cash on delivery order',
    body: `Order #${orderNumber}: your frozen order allocation is {{money.seller_order_total}}. Payment has not been collected yet.`,
  },
  push: {
    title: 'New cash on delivery order',
    body: `Order #${orderNumber}: your allocation is {{money.seller_order_total}}. Await buyer confirmation.`,
  },
  email: {
    subject: `New cash on delivery order - ${orderNumber}`,
    text: `You received cash on delivery order #${orderNumber}. Your frozen order allocation is {{money.seller_order_total}}. Payment has not been collected. Open Seller Dashboard for your items and shipping details.`,
    html: `<p>You received cash on delivery order <strong>#${escapeHtml(orderNumber)}</strong>.</p><p>Your frozen order allocation: <strong>{{money.seller_order_total}}</strong>.</p><p>Payment has not been collected. Open Seller Dashboard for only your items and shipping details.</p>`,
  },
  whatsapp: {
    message: `New Cash on Delivery Order\n\nOrder: #${orderNumber}\nYour order allocation: {{money.seller_order_total}}\nPayment has not been collected.\n\nOpen Seller Dashboard to review your items and await buyer confirmation.`,
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
      linkTo: `/seller-dashboard/order-management?orderId=${encodeURIComponent(id)}`,
      channelId: 'seller',
      whatsappCategory: 'new_order',
      relatedOrder: id,
      data: { type: 'cod_order_received', orderId: id },
    },
    money: [orderSellerTotalSnapshot(order, seller)],
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
      text: `Confirm order #${orderNumber}. Order total: {{money.order_total}}. Review and confirm: ${confirmUrl}`,
      html: `<p>Please confirm cash on delivery order <strong>#${escapeHtml(orderNumber)}</strong>.</p><p>Order total: <strong>{{money.order_total}}</strong>.</p><p><a href="${escapeHtml(confirmUrl)}">Review and confirm order</a></p>`,
    },
    whatsapp: {
      message: `Rozare Cash on Delivery Order\n\nOrder: #${orderNumber}\nTotal: {{money.order_total}}\n\nReview and confirm: ${confirmUrl}`,
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
      action: `The buyer cancelled order #${orderNumber}. Stop fulfillment for your items.`,
    },
    seller: {
      title: 'Seller cancelled order',
      action: `A seller cancelled order #${orderNumber}. Stop fulfillment for your items.`,
    },
    admin: {
      title: 'Administrator cancelled order',
      action: `An administrator cancelled order #${orderNumber}. Stop fulfillment for your items.`,
    },
    system: {
      title: 'Order cancelled automatically',
      action: `Rozare automatically cancelled order #${orderNumber}. Stop fulfillment for your items.`,
    },
  };
  const title = confirmed
    ? (reconfirmed ? 'Buyer re-confirmed order' : 'Buyer confirmed order')
    : cancellationCopy[actorRole].title;
  const action = confirmed
    ? `The buyer ${reconfirmed ? 're-confirmed' : 'confirmed'} order #${orderNumber}. Prepare only your items after checking Seller Dashboard.`
    : cancellationCopy[actorRole].action;
  const settlementMeaning = confirmed
    ? 'Cash on delivery has not been collected yet.'
    : 'No cash on delivery payment was collected.';
  const allocationSentence = includeMoney
    ? ' Your frozen allocation is {{money.seller_order_total}}.'
    : '';
  const allocationLine = includeMoney
    ? '\nYour order allocation: {{money.seller_order_total}}'
    : '';
  return {
    inapp: { title, body: `${action}${allocationSentence} ${settlementMeaning}` },
    push: { title, body: `Order #${orderNumber}.${allocationSentence} ${settlementMeaning}` },
    email: {
      subject: `${title} - ${orderNumber}`,
      text: `${action}${includeMoney ? ' Your frozen order allocation is {{money.seller_order_total}}.' : ''} ${settlementMeaning}`,
      html: `<p>${escapeHtml(action)}</p>${includeMoney ? '<p>Your frozen order allocation: <strong>{{money.seller_order_total}}</strong>.</p>' : ''}<p>${escapeHtml(settlementMeaning)}</p>`,
    },
    whatsapp: {
      message: `${title}\n\nOrder: #${orderNumber}${allocationLine}\n${settlementMeaning}\n\nOpen Seller Dashboard for your items.`,
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
    money = [orderSellerTotalSnapshot(order, seller)];
  } catch (error) {
    if (error?.code !== 'NOTIFICATION_SELLER_SETTLEMENT_MISSING') throw error;
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
      linkTo: `/seller-dashboard/order-management?orderId=${encodeURIComponent(id)}`,
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
    body: `Return #${returnNumber} for order #${orderNumber} is complete. Refund total: {{money.refund_total}}. Available Wallet credit: {{money.refund_wallet_available}}. Applied to outstanding Wallet liability: {{money.refund_liability_applied}}. Remaining liability: {{money.refund_remaining_liability}}.`,
  },
  push: {
    title: 'Return refund completed',
    body: `Refund {{money.refund_total}} processed: {{money.refund_wallet_available}} available and {{money.refund_liability_applied}} applied to Wallet liability. Remaining liability: {{money.refund_remaining_liability}}.`,
  },
  email: {
    subject: `Return refund completed - ${returnNumber}`,
    text: `Return #${returnNumber} for order #${orderNumber} is complete. Refund total: {{money.refund_total}}. Available Wallet credit: {{money.refund_wallet_available}}. Applied to outstanding Wallet liability: {{money.refund_liability_applied}}. Remaining liability: {{money.refund_remaining_liability}}.`,
    html: `<p>Return <strong>#${escapeHtml(returnNumber)}</strong> for order <strong>#${escapeHtml(orderNumber)}</strong> is complete.</p><p>Refund total: <strong>{{money.refund_total}}</strong>.</p><p>Available Wallet credit: <strong>{{money.refund_wallet_available}}</strong>.</p><p>Applied to outstanding Wallet liability: <strong>{{money.refund_liability_applied}}</strong>.</p><p>Remaining liability: <strong>{{money.refund_remaining_liability}}</strong>.</p>`,
  },
  whatsapp: {
    message: `Rozare Return Refund Completed\n\nReturn: #${returnNumber}\nOrder: #${orderNumber}\nRefund total: {{money.refund_total}}\nAvailable Wallet credit: {{money.refund_wallet_available}}\nApplied to Wallet liability: {{money.refund_liability_applied}}\nRemaining liability: {{money.refund_remaining_liability}}\n\nOpen your Rozare account for details.`,
  },
}) : ({
  inapp: {
    title: 'Return refund completed',
    body: `Return #${returnNumber} for order #${orderNumber} is complete. Wallet credit: {{money.refund_total}}.`,
  },
  push: {
    title: 'Return refund completed',
    body: `{{money.refund_total}} was credited for return #${returnNumber}.`,
  },
  email: {
    subject: `Return refund completed - ${returnNumber}`,
    text: `Return #${returnNumber} for order #${orderNumber} is complete. Wallet credit: {{money.refund_total}}.`,
    html: `<p>Return <strong>#${escapeHtml(returnNumber)}</strong> for order <strong>#${escapeHtml(orderNumber)}</strong> is complete.</p><p>Wallet credit: <strong>{{money.refund_total}}</strong>.</p>`,
  },
  whatsapp: {
    message: `Rozare Return Refund Completed\n\nReturn: #${returnNumber}\nOrder: #${orderNumber}\nWallet credit: {{money.refund_total}}\n\nOpen your Rozare account for details.`,
  },
});

const returnSellerTemplates = (returnNumber, orderNumber) => ({
  inapp: {
    title: 'Return refund completed',
    body: `Refund {{money.refund_total}} was processed for return #${returnNumber}, order #${orderNumber}. Buyer Wallet allocation details remain private.`,
  },
  push: {
    title: 'Return refund completed',
    body: `Return #${returnNumber}: refund {{money.refund_total}} was processed.`,
  },
  email: {
    subject: `Return completed - ${returnNumber}`,
    text: `Refund {{money.refund_total}} was processed for return #${returnNumber}, order #${orderNumber}. Buyer Wallet allocation details remain private.`,
    html: `<p>Refund <strong>{{money.refund_total}}</strong> was processed for return <strong>#${escapeHtml(returnNumber)}</strong>, order <strong>#${escapeHtml(orderNumber)}</strong>.</p><p>Buyer Wallet allocation details remain private.</p>`,
  },
  whatsapp: {
    message: `Return Refund Completed\n\nReturn: #${returnNumber}\nOrder: #${orderNumber}\nRefund processed: {{money.refund_total}}\n\nBuyer Wallet allocation details remain private. Open Seller Dashboard for details.`,
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
  requestedAndPayout = true,
}) => {
  const noteText = note ? ` Note: ${note}` : '';
  const meaningText = statusMeaning ? ` ${statusMeaning}` : '';
  const amountText = requestedAndPayout
    ? 'Requested: {{money.requested_amount}}. Frozen bank payout: {{money.payout_amount}}.'
    : 'Amount: {{money.requested_amount}}.';
  return {
    inapp: { title, body: `${amountText} Status: ${statusLabel}.${meaningText}${noteText}` },
    push: { title, body: `${amountText} Status: ${statusLabel}.${meaningText}` },
    email: {
      subject: title,
      text: `${amountText} Status: ${statusLabel}.${meaningText}${noteText}`,
      html: `<p>${amountText}</p><p>Status: <strong>${escapeHtml(statusLabel)}</strong>.</p>${statusMeaning ? `<p>${escapeHtml(statusMeaning)}</p>` : ''}${note ? `<p>Note: ${escapeHtml(note)}</p>` : ''}`,
    },
    whatsapp: {
      message: `${title}\n\n${amountText.replace(/\. /g, '\n')}\nStatus: ${statusLabel}${statusMeaning ? `\n${statusMeaning}` : ''}${note ? `\nNote: ${note}` : ''}\n\nOpen Seller Dashboard > Payments for details.`,
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
      statusLabel: 'Pending admin review',
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
    pending: 'The request is awaiting admin review; no payout has been sent.',
    approved: 'The funds are reserved, but no bank payout has been sent yet.',
    processing: 'The bank transfer is processing and is not yet recorded as paid.',
    manual_review: 'The transfer outcome requires manual review and the full reservation remains held.',
    failed: 'The transfer definitively failed with no payout, so the reservation was released.',
    paid: 'The bank payout is recorded as paid with administrator-supplied transfer proof.',
    rejected: 'The request was rejected and its reservation was released.',
    cancelled: 'The request was cancelled and its reservation was released.',
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
      body: `${safeSeller} requested {{money.requested_amount}}. Transfer exactly {{money.payout_amount}} only to this request's frozen payout destination after approval.`,
    },
    push: {
      title: 'New seller withdrawal request',
      body: `${safeSeller}: {{money.requested_amount}} requested; frozen bank payout {{money.payout_amount}}.`,
    },
    email: {
      subject: 'New seller withdrawal request',
      text: `${safeSeller} requested {{money.requested_amount}}. If approved, transfer exactly {{money.payout_amount}} only to the frozen payout destination on this request.`,
      html: `<p><strong>${escapeHtml(safeSeller)}</strong> requested <strong>{{money.requested_amount}}</strong>.</p><p>If approved, transfer exactly <strong>{{money.payout_amount}}</strong> only to the frozen payout destination on this request.</p>`,
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
    const title = liabilityApplied ? 'Wallet credit allocated' : 'Wallet credited';
    templates = liabilityApplied ? {
      inapp: {
        title,
        body: `Incoming credit: {{money.wallet_amount}}. Available Wallet credit: {{money.wallet_available_credit}}. Applied to outstanding Wallet liability: {{money.wallet_liability_applied}}. Remaining liability: {{money.wallet_remaining_liability}}.`,
      },
      push: {
        title,
        body: `{{money.wallet_amount}} processed: {{money.wallet_available_credit}} available and {{money.wallet_liability_applied}} applied to Wallet liability.`,
      },
      email: {
        subject: title,
        text: `Incoming credit: {{money.wallet_amount}}. Available Wallet credit: {{money.wallet_available_credit}}. Applied to outstanding Wallet liability: {{money.wallet_liability_applied}}. Remaining liability: {{money.wallet_remaining_liability}}. Reference: ${safeText(transaction?.referenceId, 120)}.`,
        html: `<p>Incoming credit: <strong>{{money.wallet_amount}}</strong>.</p><p>Available Wallet credit: <strong>{{money.wallet_available_credit}}</strong>.</p><p>Applied to outstanding Wallet liability: <strong>{{money.wallet_liability_applied}}</strong>.</p><p>Remaining liability: <strong>{{money.wallet_remaining_liability}}</strong>.</p><p>Reference: ${escapeHtml(safeText(transaction?.referenceId, 120))}</p>`,
      },
    } : {
      inapp: { title, body: '{{money.wallet_amount}} was credited to your Rozare Wallet.' },
      push: { title, body: '{{money.wallet_amount}} was credited to your wallet.' },
      email: {
        subject: title,
        text: `{{money.wallet_amount}} was credited to your Rozare Wallet. Reference: ${safeText(transaction?.referenceId, 120)}.`,
        html: `<p><strong>{{money.wallet_amount}}</strong> was credited to your Rozare Wallet.</p><p>Reference: ${escapeHtml(safeText(transaction?.referenceId, 120))}</p>`,
      },
    };
  } else {
    const title = 'Wallet payment completed';
    money = [walletTransactionSnapshot(transaction)];
    templates = {
      inapp: { title, body: '{{money.wallet_amount}} was debited from your Rozare Wallet.' },
      push: { title, body: '{{money.wallet_amount}} was debited from your wallet.' },
      email: {
        subject: title,
        text: `{{money.wallet_amount}} was debited from your Rozare Wallet. Reference: ${safeText(transaction?.referenceId, 120)}.`,
        html: `<p><strong>{{money.wallet_amount}}</strong> was debited from your Rozare Wallet.</p><p>Reference: ${escapeHtml(safeText(transaction?.referenceId, 120))}</p>`,
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
