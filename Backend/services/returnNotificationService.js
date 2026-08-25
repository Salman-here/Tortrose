'use strict';

const ReturnRequest = require('../models/ReturnRequest');
const sellerTemplates = require('./whatsapp/sellerMessageTemplates');
const { formatMoneySync, isSupportedCurrency } = require('./currencyService');
const { roundMoney } = require('./moneyMath');
const { RETURN_STATUS_LABELS } = require('./returnPolicyService');
const {
  enqueueReturnSettlementNotifications,
} = require('./financialNotificationOutboxService');
const { enqueueNotificationEvent } = require('./notificationOutboxService');
const { tryOrderBuyerPhoneE164 } = require('./orderBuyerContactService');

const notificationBody = value => String(value || '').trim().slice(0, 1000);
const escapeHtml = value => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const buyerReturnLink = (returnRequest) =>
  `/user-dashboard/order/detail/${returnRequest.order}?returnId=${returnRequest._id}`;

const sellerReturnLink = (returnRequest) =>
  `/seller-dashboard/order-management?tab=returns&returnId=${returnRequest._id}`;

const requireStoredReturnCurrency = (returnRequest) => {
  const rawCurrency = returnRequest?.currency;
  if (
    typeof rawCurrency !== 'string'
    || rawCurrency !== rawCurrency.trim()
    || rawCurrency !== rawCurrency.toUpperCase()
    || !isSupportedCurrency(rawCurrency)
  ) {
    const error = new Error('Stored return currency is invalid.');
    error.code = 'RETURN_FINANCIAL_DATA_INVALID';
    throw error;
  }
  return rawCurrency;
};

const requireStoredReturnTotal = (returnRequest) => {
  const amount = returnRequest?.refund?.totalAmount;
  if (
    typeof amount !== 'number'
    || !Number.isFinite(amount)
    || amount < 0
    || roundMoney(amount) !== amount
  ) {
    const error = new Error('Stored return total is invalid.');
    error.code = 'RETURN_FINANCIAL_DATA_INVALID';
    throw error;
  }
  return amount;
};

const formatReturnAmount = (returnRequest) => {
  const currency = requireStoredReturnCurrency(returnRequest);
  return formatMoneySync(
    requireStoredReturnTotal(returnRequest),
    currency,
    { sourceCurrency: currency }
  );
};

const statusNotificationOccurrence = (returnRequest) => {
  const history = returnRequest?.statusHistory || [];
  const matchingEntry = [...history].reverse().find(entry => entry.status === returnRequest.status);
  const timestamp = matchingEntry?.changedAt || returnRequest?.createdAt || new Date(0);
  const occurredAt = new Date(timestamp);
  if (!Number.isFinite(occurredAt.getTime())) {
    const error = new Error('Stored return notification occurrence time is invalid.');
    error.code = 'RETURN_NOTIFICATION_DATA_INVALID';
    throw error;
  }
  return {
    occurredAt,
    key: `${returnRequest.status}:${occurredAt.getTime()}`,
    note: matchingEntry?.note,
  };
};

const snapshotPhone = order => tryOrderBuyerPhoneE164(order);

const snapshotEmail = order => {
  const email = String(order?.shippingInfo?.email || '').trim().toLowerCase();
  return email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
};

const notifySellerReturnRequested = async (returnRequest, order, { session = null } = {}) => {
  if (!returnRequest?._id || !returnRequest?.seller || !returnRequest?.order) return false;
  const occurredAt = returnRequest.requestedAt || returnRequest.createdAt;
  const buyerName = order?.shippingInfo?.fullName || 'A buyer';
  const body = notificationBody(
    `${buyerName} requested a return for order #${returnRequest.orderId}. Reason: ${returnRequest.reasonDetails}`
  );
  const eventKey = `return:${returnRequest._id}:requested:seller:${returnRequest.seller}`;
  const records = await enqueueNotificationEvent({
    eventKey,
    eventType: 'return.requested',
    aggregateType: 'ReturnRequest',
    aggregateId: String(returnRequest._id),
    occurredAt,
    recipient: {
      kind: 'user',
      audienceRole: 'seller',
      user: returnRequest.seller,
      destinationPolicy: 'current_user',
    },
    channels: ['inapp', 'push', 'email', 'whatsapp'],
    templates: {
      inapp: { title: 'New return request', body },
      push: { title: 'New return request', body },
      email: {
        subject: `New return request for order #${returnRequest.orderId}`,
        text: `${body}\n\nSign in to Rozare to review and respond to this request.`,
        html: `<p>${escapeHtml(body)}</p><p>Sign in to Rozare to review and respond to this request.</p>`,
      },
      whatsapp: { message: sellerTemplates.return_requested(returnRequest) },
    },
    metadata: {
      category: 'order',
      channelId: 'seller',
      whatsappCategory: 'return_request',
      linkTo: sellerReturnLink(returnRequest),
      data: {
        type: 'return_requested',
        returnRequestId: String(returnRequest._id),
        orderId: String(returnRequest.order),
      },
    },
    session,
  });
  return records.length === 4;
};

const enqueueReturnCancellationNotifications = async (
  returnRequest,
  order,
  { session = null } = {}
) => {
  if (
    !returnRequest?._id
    || !returnRequest?.buyer
    || !returnRequest?.seller
    || !returnRequest?.order
    || returnRequest.status !== 'cancelled_by_buyer'
  ) {
    const error = new Error('A completed buyer cancellation is required for notifications.');
    error.code = 'RETURN_NOTIFICATION_DATA_INVALID';
    throw error;
  }
  const occurrence = statusNotificationOccurrence(returnRequest);
  const cleanNote = String(occurrence.note || '').trim().slice(0, 500);
  const noteLine = cleanNote ? ` Note: ${cleanNote}` : '';
  const buyerBody = notificationBody(
    `Your return #${returnRequest.returnNumber} for order #${returnRequest.orderId} was cancelled.${noteLine}`
  );
  const sellerBody = notificationBody(
    `Buyer cancelled return #${returnRequest.returnNumber} for order #${returnRequest.orderId}.${noteLine}`
  );
  const eventRoot = `return:${returnRequest._id}:cancelled:${occurrence.occurredAt.getTime()}`;
  const aggregate = {
    eventType: 'return.cancelled',
    aggregateType: 'ReturnRequest',
    aggregateId: String(returnRequest._id),
    occurredAt: occurrence.occurredAt,
    session,
  };
  const data = {
    type: 'return_cancelled',
    returnRequestId: String(returnRequest._id),
    orderId: String(returnRequest.order),
    status: 'cancelled_by_buyer',
  };

  const seller = await enqueueNotificationEvent({
    ...aggregate,
    eventKey: `${eventRoot}:seller:${returnRequest.seller}`,
    recipient: {
      kind: 'user',
      audienceRole: 'seller',
      user: returnRequest.seller,
      destinationPolicy: 'current_user',
    },
    channels: ['inapp', 'push', 'email', 'whatsapp'],
    templates: {
      inapp: { title: 'Return request cancelled', body: sellerBody },
      push: { title: 'Return request cancelled', body: sellerBody },
      email: {
        subject: `Return #${returnRequest.returnNumber} was cancelled`,
        text: `${sellerBody}\n\nSign in to Rozare to view the return record.`,
        html: `<p>${escapeHtml(sellerBody)}</p><p>Sign in to Rozare to view the return record.</p>`,
      },
      whatsapp: {
        message: [
          'Rozare Return Update',
          '',
          `Return: #${returnRequest.returnNumber}`,
          `Order: #${returnRequest.orderId}`,
          'Status: Cancelled by buyer',
          cleanNote ? `Note: ${cleanNote}` : '',
          '',
          'Open Seller Dashboard > Orders > Return Orders for details.',
        ].filter(Boolean).join('\n'),
      },
    },
    metadata: {
      category: 'order',
      channelId: 'seller',
      whatsappCategory: 'return_update',
      linkTo: sellerReturnLink(returnRequest),
      relatedOrder: returnRequest.order,
      data,
    },
  });

  const email = snapshotEmail(order);
  const phone = snapshotPhone(order);
  const buyerChannels = ['inapp', 'push'];
  if (email) buyerChannels.push('email');
  if (phone) buyerChannels.push('whatsapp');
  const buyerTemplates = {
    inapp: { title: 'Return cancelled', body: buyerBody },
    push: { title: 'Return cancelled', body: buyerBody },
  };
  if (email) {
    buyerTemplates.email = {
      subject: `Return #${returnRequest.returnNumber} cancelled`,
      text: `${buyerBody}\n\nSign in to Rozare to view the return details.`,
      html: `<p>${escapeHtml(buyerBody)}</p><p>Sign in to Rozare to view the return details.</p>`,
    };
  }
  if (phone) {
    buyerTemplates.whatsapp = {
      message: [
        'Rozare Return Update',
        '',
        `Return: #${returnRequest.returnNumber}`,
        `Order: #${returnRequest.orderId}`,
        'Status: Cancelled',
        cleanNote ? `Note: ${cleanNote}` : '',
        '',
        'Your cancellation has been recorded.',
      ].filter(Boolean).join('\n'),
    };
  }
  const buyer = await enqueueNotificationEvent({
    ...aggregate,
    eventKey: `${eventRoot}:buyer:${returnRequest.buyer}`,
    recipient: {
      kind: 'user',
      audienceRole: 'buyer',
      user: returnRequest.buyer,
      destinationPolicy: 'event_snapshot',
      email,
      phone,
    },
    channels: buyerChannels,
    templates: buyerTemplates,
    metadata: {
      category: 'order',
      channelId: 'orders',
      linkTo: buyerReturnLink(returnRequest),
      relatedOrder: returnRequest.order,
      data,
    },
  });
  return { buyer, seller };
};

const notifyBuyerReturnStatus = async (
  returnRequest,
  order,
  note = '',
  { session = null } = {}
) => {
  if (returnRequest?.status === 'returned') {
    if (returnRequest?.settlement?.status !== 'completed') {
      // Never tell a buyer that Wallet money was credited until the durable
      // settlement ledger says it completed.
      return false;
    }
    // The settlement event owns all completed-refund channels and its exact
    // frozen amount. This replay-safe call repairs legacy/controller retries
    // without creating a second direct status/refund notification.
    await enqueueReturnSettlementNotifications(returnRequest, order, { session });
    return true;
  }
  const current = returnRequest;
  if (!current?._id || !current?.buyer || !current?.order) return false;
  const occurrence = statusNotificationOccurrence(current);
  const cleanNote = String(occurrence.note ?? note ?? '').trim().slice(0, 500);
  const label = RETURN_STATUS_LABELS[current.status] || current.status;
  const noteLine = cleanNote ? ` Note: ${cleanNote}` : '';
  const body = notificationBody(
    `Return #${current.returnNumber} for order #${current.orderId} is now ${label.toLowerCase()}.${noteLine}`
  );
  const whatsappMessage = [
      'Rozare Return Update',
      '',
      `Return: #${current.returnNumber}`,
      `Order: #${current.orderId}`,
      `Status: ${label}`,
      cleanNote ? `Note: ${cleanNote}` : '',
      '',
      'Open your Rozare account for details.',
    ].filter(Boolean).join('\n');
  const phone = snapshotPhone(order);
  const email = snapshotEmail(order);
  const channels = ['inapp', 'push'];
  if (email) channels.push('email');
  if (phone) channels.push('whatsapp');
  const templates = {
    inapp: { title: label, body },
    push: { title: label, body },
  };
  if (email) {
    templates.email = {
      subject: `${label}: return #${current.returnNumber}`,
      text: `${body}\n\nSign in to Rozare to view the return details.`,
      html: `<p>${escapeHtml(body)}</p><p>Sign in to Rozare to view the return details.</p>`,
    };
  }
  if (phone) templates.whatsapp = { message: whatsappMessage };

  const records = await enqueueNotificationEvent({
    eventKey: `return:${current._id}:status:buyer:${occurrence.key}`,
    eventType: 'return.status_updated',
    aggregateType: 'ReturnRequest',
    aggregateId: String(current._id),
    occurredAt: occurrence.occurredAt,
    recipient: {
      kind: 'user',
      audienceRole: 'buyer',
      user: current.buyer,
      destinationPolicy: 'event_snapshot',
      email,
      phone,
    },
    channels,
    templates,
    metadata: {
      category: 'order',
      channelId: 'orders',
      linkTo: buyerReturnLink(current),
      relatedOrder: current.order,
      data: {
        type: 'return_status_update',
        returnRequestId: String(current._id),
        orderId: String(current.order),
        status: current.status,
      },
    },
    session,
  });
  return records.length === channels.length;
};

const notifySellerReturnSettled = async (returnRequest, order) => {
  const result = await enqueueReturnSettlementNotifications(returnRequest, order, {
    buyerChannels: [],
  });
  return result.seller;
};

const notifyReturnSettlementCompleted = async (returnRequest, order) => {
  const current = await ReturnRequest.findOne({
    _id: returnRequest?._id,
    status: 'returned',
    'settlement.status': 'completed',
  });
  if (!current) return false;

  // Settlement services enqueue this event inside the money transaction. This
  // idempotent compatibility call also repairs completed legacy rows/webhook
  // replays without sending any channel directly.
  await enqueueReturnSettlementNotifications(current, order);
  await ReturnRequest.updateOne(
    { _id: current._id, 'settlement.notificationSentAt': null },
    { $set: { 'settlement.notificationSentAt': new Date() } }
  );
  return true;
};

module.exports = {
  buyerReturnLink,
  sellerReturnLink,
  formatReturnAmount,
  enqueueReturnCancellationNotifications,
  notifySellerReturnRequested,
  notifyBuyerReturnStatus,
  notifySellerReturnSettled,
  notifyReturnSettlementCompleted,
};
