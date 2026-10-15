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
  `/user-dashboard/order/detail/${returnRequest.order}?${returnRequest.kind === 'warranty' ? 'warrantyId' : 'returnId'}=${returnRequest._id}`;

const sellerReturnLink = (returnRequest) =>
  `/seller-dashboard/order-management?tab=${returnRequest.kind === 'warranty' ? 'warranty' : 'returns'}&${returnRequest.kind === 'warranty' ? 'warrantyId' : 'returnId'}=${returnRequest._id}`;

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
  const warranty = returnRequest.kind === 'warranty';
  const appeal = warranty && returnRequest.appealVersion > 0;
  const occurredAt = appeal ? statusNotificationOccurrence(returnRequest).occurredAt : returnRequest.requestedAt || returnRequest.createdAt;
  const noun = warranty ? 'warranty claim' : 'return request';
  const title = appeal ? 'Warranty appeal received' : warranty ? 'New warranty claim' : 'New return request';
  const buyerName = order?.shippingInfo?.fullName || 'A buyer';
  const body = notificationBody(
    `${buyerName} ${appeal ? 'appealed' : 'submitted'} ${noun} #${returnRequest.returnNumber} for order #${returnRequest.orderId}.${returnRequest.reasonDetails ? ` Reason: ${returnRequest.reasonDetails}` : ''}`
  );
  const eventKey = `return:${returnRequest._id}:requested:seller:${returnRequest.seller}${appeal ? `:appeal:${returnRequest.appealVersion}` : ''}`;
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
      inapp: { title, body },
      push: { title, body: `${warranty ? 'Warranty claim' : 'Return'} #${returnRequest.returnNumber} for order #${returnRequest.orderId} is awaiting your review.` },
      email: {
        subject: `${title} for order #${returnRequest.orderId}`,
        text: `${body}\n\nReview the buyer’s photos and reason in Seller Dashboard. Approve or reject the request before arranging collection.`,
        html: `<p>${escapeHtml(body)}</p><p>Review the buyer’s photos and reason in Seller Dashboard. Approve or reject the request before arranging collection.</p>`,
      },
      whatsapp: { message: warranty ? `*${title}*\n\nClaim: #${returnRequest.returnNumber}\nOrder: #${returnRequest.orderId}\nReason: ${returnRequest.reasonDetails}\n\nReview the photos in Seller Dashboard → Orders → Warranty. Declare a refund or replacement when approving, or explain a rejection.` : `${sellerTemplates.return_requested(returnRequest)}\n\nReview the buyer’s photos and reason in Orders → Returns. Approve or reject the request before arranging collection.` },
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
        ...(warranty ? { claimKind: 'warranty' } : {}),
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
  const warranty = returnRequest.kind === 'warranty';
  const noun = warranty ? 'warranty claim' : 'return';
  const heading = warranty ? 'Warranty claim' : 'Return';
  const cleanNote = String(occurrence.note || '').trim().slice(0, 500);
  const noteLine = cleanNote ? ` Note: ${cleanNote}` : '';
  const buyerBody = notificationBody(
    `You cancelled ${noun} #${returnRequest.returnNumber} for order #${returnRequest.orderId}.${noteLine}`
  );
  const sellerBody = notificationBody(
    `The buyer cancelled ${noun} #${returnRequest.returnNumber} for order #${returnRequest.orderId}.${noteLine}`
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
    ...(warranty ? { claimKind: 'warranty' } : {}),
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
      inapp: { title: warranty ? 'Warranty claim cancelled' : 'Return request cancelled', body: sellerBody },
      push: { title: warranty ? 'Warranty claim cancelled' : 'Return request cancelled', body: sellerBody },
      email: {
        subject: `${heading} #${returnRequest.returnNumber} was cancelled`,
        text: `${sellerBody}\n\nView the ${noun} in Seller Dashboard for details.`,
        html: `<p>${escapeHtml(sellerBody)}</p><p>View the ${noun} in Seller Dashboard for details.</p>`,
      },
      whatsapp: {
        message: [
          warranty ? '*Buyer cancelled a warranty claim*' : '*Buyer cancelled a return request*',
          '',
          `${heading}: #${returnRequest.returnNumber}`,
          `Order: #${returnRequest.orderId}`,
          'Status: Cancelled by buyer',
          cleanNote ? `Note: ${cleanNote}` : '',
          '',
          `View the ${noun} in Seller Dashboard for details.`,
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
    inapp: { title: `${heading} cancelled`, body: buyerBody },
    push: { title: `${heading} cancelled`, body: buyerBody },
  };
  if (email) {
    buyerTemplates.email = {
      subject: `${heading} #${returnRequest.returnNumber} cancelled`,
      text: `${buyerBody}\n\nYour original purchase is unchanged. View your order in Rozare for details.`,
      html: `<p>${escapeHtml(buyerBody)}</p><p>Your original purchase is unchanged. View your order in Rozare for details.</p>`,
    };
  }
  if (phone) {
    buyerTemplates.whatsapp = {
      message: [
        warranty ? '*Your warranty claim is cancelled*' : '*Your return request is cancelled*',
        '',
        `${heading}: #${returnRequest.returnNumber}`,
        `Order: #${returnRequest.orderId}`,
        'Status: Cancelled',
        cleanNote ? `Note: ${cleanNote}` : '',
        '',
        'Your original purchase is unchanged. View your order in Rozare for details.',
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

const RETURN_NOTIFICATION_COPY = Object.freeze({
  requested: { title: 'Return request received', detail: 'Your return request was received and is awaiting the seller’s review.' },
  approved: { title: 'Return request approved', detail: 'Your return request was approved. View the return details for the next steps.' },
  pickup_scheduled: { title: 'Return pickup scheduled', detail: 'Pickup has been scheduled for your return. View the return details for instructions.' },
  picked_up: { title: 'Return picked up', detail: 'Your return has been marked as picked up.' },
  in_transit_to_seller: { title: 'Your return is on its way', detail: 'Your returned items are on their way to the seller.' },
  received_by_seller: { title: 'Return received by seller', detail: 'Your returned items have been marked as received by the seller.' },
  under_review: { title: 'Return inspection in progress', detail: 'The seller is inspecting the received items to complete your approved refund or replacement.' },
  accepted_pending_payment: { title: 'Return accepted — refund pending', detail: 'Your return was accepted. The refund has not been credited yet; we will notify you when it is completed.' },
  replacement_approved: { title: 'Replacement approved', detail: 'A replacement was approved for your return. View the return details for the next steps.' },
  replacement_shipped: { title: 'Your replacement has shipped', detail: 'Your replacement is on its way. View tracking details and confirm receipt when it arrives.' },
  replacement_delivered: { title: 'Replacement received', detail: 'You confirmed receipt of the replacement. Your original warranty deadline is unchanged.' },
  rejected: { title: 'Return request declined', detail: 'Your return request was declined. View the return details for the reason.' },
  cancelled_by_buyer: { title: 'Return request cancelled', detail: 'You cancelled this return request. Your original purchase is unchanged.' },
});

const WARRANTY_NOTIFICATION_COPY = Object.freeze({
  requested: { title: 'Warranty claim received', detail: 'Your warranty claim is awaiting the seller’s decision.' },
  approved: { title: 'Warranty claim approved', detail: 'View the seller’s planned resolution and collection instructions in your claim.' },
  pickup_scheduled: { title: 'Warranty collection scheduled', detail: 'Collection has been scheduled. View your claim for instructions.' },
  picked_up: { title: 'Warranty item collected', detail: 'Your warranty item has been collected.' },
  in_transit_to_seller: { title: 'Warranty item on its way', detail: 'Your item is on its way to the seller.' },
  received_by_seller: { title: 'Warranty item received', detail: 'The seller has received your item.' },
  under_review: { title: 'Warranty inspection in progress', detail: 'The seller is inspecting the item under your original warranty.' },
  accepted_pending_payment: { title: 'Warranty refund pending', detail: 'The seller has accepted the refund. It is not yet credited; we will notify you when it completes.' },
  replacement_approved: { title: 'Warranty replacement approved', detail: 'The seller is preparing your replacement. You do not need to make another payment.' },
  rejected: { title: 'Warranty claim declined', detail: 'Review the seller’s reason. You can appeal this original on-time claim, even if the warranty has since expired.' },
  cancelled_by_buyer: { title: 'Warranty claim cancelled', detail: 'You cancelled this claim. Your original purchase is unchanged.' },
});

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
  const warranty = current.kind === 'warranty';
  const copy = warranty ? WARRANTY_NOTIFICATION_COPY[current.status] || RETURN_NOTIFICATION_COPY[current.status] : RETURN_NOTIFICATION_COPY[current.status];
  const noun = warranty ? 'Warranty claim' : 'Return';
  const label = copy?.title || RETURN_STATUS_LABELS[current.status] || 'Return update';
  const noteLine = `${current.resolution ? ` Planned resolution: ${current.resolution === 'refund' ? 'refund to Rozare Wallet' : 'replacement'}.` : ''}${cleanNote ? ` Note: ${cleanNote}` : ''}`;
  const body = notificationBody(
    `${noun} #${current.returnNumber} for order #${current.orderId}: ${copy?.detail || 'Your claim status has been updated.'}${noteLine}`
  );
  const whatsappMessage = [
      `*${label}*`,
      '',
      `${noun}: #${current.returnNumber}`,
      `Order: #${current.orderId}`,
      copy?.detail || 'Your return status has been updated.',
      noteLine.trim(),
      '',
      `View your ${warranty ? 'warranty claim' : 'return'} in Rozare for details.`,
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
      subject: `${label}: ${warranty ? 'claim' : 'return'} #${current.returnNumber}`,
      text: `${body}\n\nView your ${warranty ? 'warranty claim' : 'return'} in Rozare for details.`,
      html: `<p>${escapeHtml(body)}</p><p>View your ${warranty ? 'warranty claim' : 'return'} in Rozare for details.</p>`,
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
        ...(warranty ? { claimKind: 'warranty' } : {}),
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
