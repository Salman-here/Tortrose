'use strict';

const NotificationOutbox = require('../models/NotificationOutbox');
const Order = require('../models/Order');

const CONFIRMATION_EVENT_TYPE = 'order.confirmation_requested';
const TRACKED_CHANNELS = new Set(['email', 'whatsapp']);

const isBuyerConfirmationRecord = record => (
  record
  && record.aggregateType === 'Order'
  && record.eventType === CONFIRMATION_EVENT_TYPE
  && record.recipient?.audienceRole === 'buyer'
  && TRACKED_CHANNELS.has(record.channel)
);

const terminalDeliveryStatus = record => {
  if (!isBuyerConfirmationRecord(record)) return null;

  if (record.status === 'delivered') {
    return {
      channel: record.channel,
      sentAt: record.deliveredAt || record.updatedAt || record.createdAt || record.occurredAt || null,
      sentSuccess: true,
      error: '',
    };
  }

  if (record.status === 'skipped' || record.status === 'dead') {
    const code = String(record.lastErrorCode || '').trim();
    const reason = String(record.lastError || 'Confirmation delivery failed.').trim();
    return {
      channel: record.channel,
      sentAt: record.skippedAt || record.deadAt || record.updatedAt || record.createdAt || record.occurredAt || null,
      sentSuccess: false,
      error: `${code ? `${code}: ` : ''}${reason}`.slice(0, 1000),
    };
  }

  return null;
};

const confirmationPatch = status => {
  if (!status) return null;
  const prefix = status.channel === 'email' ? 'email' : 'whatsapp';
  return {
    [`confirmation.${prefix}SentAt`]: status.sentAt,
    [`confirmation.${prefix}SentSuccess`]: status.sentSuccess,
    [`confirmation.${prefix}Error`]: status.error,
  };
};

const applyStatusToConfirmation = (confirmation, status) => {
  if (!status) return confirmation;
  const prefix = status.channel === 'email' ? 'email' : 'whatsapp';
  // The child WhatsApp queue records the actual provider-acceptance time on
  // the order. Use the parent outbox only to repair an absent legacy value,
  // never to replace that more precise timestamp a few polling seconds later.
  if (prefix === 'whatsapp' && confirmation.whatsappSentSuccess != null) return confirmation;
  return {
    ...confirmation,
    [`${prefix}SentAt`]: status.sentAt,
    [`${prefix}SentSuccess`]: status.sentSuccess,
    [`${prefix}Error`]: status.error,
  };
};

async function syncOrderConfirmationDeliveryStatus(record) {
  const status = terminalDeliveryStatus(record);
  const patch = confirmationPatch(status);
  if (!patch) return null;

  const filter = {
    _id: record.aggregateId,
    paymentMethod: 'cash_on_delivery',
  };
  if (status.channel === 'whatsapp') {
    filter['confirmation.whatsappSentSuccess'] = null;
  }

  return Order.updateOne(filter, {
    $set: patch,
  });
}

async function withAuthoritativeOrderConfirmationDelivery(order) {
  if (!order || order.paymentMethod !== 'cash_on_delivery' || !order._id) return order;

  const orderView = order.toObject ? order.toObject() : { ...order };
  const rows = await NotificationOutbox.find({
    aggregateType: 'Order',
    aggregateId: String(order._id),
    eventType: CONFIRMATION_EVENT_TYPE,
    channel: { $in: [...TRACKED_CHANNELS] },
    'recipient.audienceRole': 'buyer',
  }).sort({ createdAt: 1 }).lean();

  let confirmation = { ...(orderView.confirmation || {}) };
  for (const row of rows) {
    confirmation = applyStatusToConfirmation(confirmation, terminalDeliveryStatus(row));
  }

  return { ...orderView, confirmation };
}

module.exports = {
  CONFIRMATION_EVENT_TYPE,
  isBuyerConfirmationRecord,
  syncOrderConfirmationDeliveryStatus,
  terminalDeliveryStatus,
  withAuthoritativeOrderConfirmationDelivery,
};
