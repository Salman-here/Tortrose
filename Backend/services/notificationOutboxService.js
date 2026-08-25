'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const NotificationOutbox = require('../models/NotificationOutbox');
const {
  formatMoneySnapshot,
  snapshotMinorMoney,
} = require('./notificationMoneySnapshotService');

const CHANNELS = new Set(['inapp', 'push', 'email', 'whatsapp']);
const ALLOW_BLOCKED_EVENT_AUDIENCES = new Map([
  ['account.blocked', new Set(['buyer', 'seller'])],
  ['subscription.cancelled', new Set(['seller'])],
  ['subscription.trial_blocked', new Set(['seller'])],
  // Immutable receipts and payout status records remain legally/operationally
  // useful after an account is blocked. COD/new-order marketing and mutable
  // lifecycle events are intentionally absent.
  ['order.paid', new Set(['buyer', 'seller'])],
  ['order.stock_refund_completed', new Set(['buyer'])],
  ['order.payment_refund_completed', new Set(['buyer', 'seller'])],
  ['order.payment_dispute_opened', new Set(['seller'])],
  ['order.payment_dispute_won', new Set(['seller'])],
  ['order.payment_dispute_lost', new Set(['seller'])],
  ['order.no_charge_confirmed', new Set(['buyer', 'seller'])],
  ['return.settled', new Set(['buyer', 'seller'])],
  ['return.safety_refund_completed', new Set(['seller'])],
  ['return.payment_refund_completed', new Set(['seller'])],
  ['return.payment_dispute_opened', new Set(['seller'])],
  ['return.payment_dispute_won', new Set(['seller'])],
  ['return.payment_dispute_lost', new Set(['seller'])],
  ['wallet.completed', new Set(['buyer'])],
  ['wallet.payment_refund_completed', new Set(['buyer', 'seller'])],
  ['wallet.payment_dispute_opened', new Set(['buyer', 'seller'])],
  ['wallet.payment_dispute_won', new Set(['buyer', 'seller'])],
  ['wallet.payment_dispute_lost', new Set(['buyer', 'seller'])],
  ['withdrawal.requested', new Set(['seller'])],
  ['withdrawal.status_changed', new Set(['seller'])],
  ['subscription.payment_received', new Set(['seller'])],
  ['subscription.payment_recovered', new Set(['seller'])],
  ['subscription.payment_failed', new Set(['seller'])],
  ['subscription.refund_confirmed', new Set(['seller'])],
  ['subscription.dispute_opened', new Set(['seller'])],
  ['subscription.dispute_won', new Set(['seller'])],
  ['subscription.dispute_lost', new Set(['seller'])],
  ['subdomain.payment_received', new Set(['seller'])],
  ['subdomain.refund_confirmed', new Set(['seller'])],
  ['subdomain.dispute_opened', new Set(['seller'])],
  ['subdomain.dispute_won', new Set(['seller'])],
  ['subdomain.dispute_lost', new Set(['seller'])],
  ['subdomain.ownership_expired', new Set(['seller'])],
  ['subdomain.removed', new Set(['seller'])],
]);
const ALLOW_BLOCKED_EVENT_TYPES = new Set(ALLOW_BLOCKED_EVENT_AUDIENCES.keys());
const blockedRecipientEventAllowed = (eventType, audienceRole) => (
  ALLOW_BLOCKED_EVENT_AUDIENCES.get(eventType)?.has(audienceRole) === true
);
const FINANCIAL_DATA_KEY = /(?:amount|balance|currency|discount|fee|money|payout|price|refund|subtotal|tax|total)/i;
const MONEY_TOKEN = /\{\{money\.([a-z][a-z0-9_.-]{0,63})\}\}/g;

const outboxError = (message, code = 'NOTIFICATION_OUTBOX_INVALID', statusCode = 409) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const cleanRequiredString = (value, field, maxLength, pattern = null) => {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > maxLength) {
    throw outboxError(`${field} is invalid.`);
  }
  if (pattern && !pattern.test(value)) throw outboxError(`${field} is invalid.`);
  return value;
};

const canonicalize = value => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw outboxError('Notification payload contains a non-finite number.');
    return value;
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw outboxError('Notification payload contains an invalid date.');
    return value.toISOString();
  }
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw outboxError('Notification payload must contain plain JSON values only.');
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw outboxError('Notification payload contains an unsafe key.');
    }
    const entry = value[key];
    if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') {
      throw outboxError('Notification payload contains a non-JSON value.');
    }
    result[key] = canonicalize(entry);
  }
  return result;
};

const canonicalJson = value => JSON.stringify(canonicalize(value));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

const normalizeEvent = ({ eventKey, eventType, aggregateType, aggregateId, occurredAt }) => {
  const timestamp = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  if (!occurredAt || !Number.isFinite(timestamp.getTime())) {
    throw outboxError('Notification occurredAt must be the authoritative event timestamp.');
  }
  return {
    eventKey: cleanRequiredString(
      eventKey,
      'Notification eventKey',
      300,
      /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,299}$/
    ),
    eventType: cleanRequiredString(
      eventType,
      'Notification eventType',
      100,
      /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/
    ),
    aggregateType: cleanRequiredString(
      aggregateType,
      'Notification aggregateType',
      80,
      /^[A-Za-z][A-Za-z0-9_]{0,79}$/
    ),
    aggregateId: cleanRequiredString(aggregateId?.toString?.() || '', 'Notification aggregateId', 200),
    occurredAt: timestamp,
  };
};

const normalizeEmail = value => {
  if (typeof value !== 'string' || value !== value.trim()) return '';
  const email = value.toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
};

const normalizePhone = value => {
  if (typeof value !== 'string') return '';
  const digits = value.replace(/\D/g, '');
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : '';
};

const isExplicitInternationalPhone = value => {
  if (typeof value !== 'string' || value !== value.trim()) return false;
  return value.startsWith('+') || /^00\d/.test(value);
};

const normalizeRecipient = (recipient, channel) => {
  if (!recipient || typeof recipient !== 'object' || Array.isArray(recipient)) {
    throw outboxError('Notification recipient is required.');
  }
  const kind = recipient.kind;
  const audienceRole = recipient.audienceRole;
  if (!['user', 'guest'].includes(kind) || !['buyer', 'seller', 'admin'].includes(audienceRole)) {
    throw outboxError('Notification recipient kind or audience role is invalid.');
  }
  if (kind === 'guest' && audienceRole !== 'buyer') {
    throw outboxError('Guest notification recipients can only be buyers.');
  }

  let user = null;
  let guestKey = '';
  if (kind === 'user') {
    if (!mongoose.isValidObjectId(recipient.user)) {
      throw outboxError('Notification user recipient id is invalid.');
    }
    user = new mongoose.Types.ObjectId(recipient.user);
  } else {
    guestKey = cleanRequiredString(recipient.guestKey, 'Notification guestKey', 220);
    if (['inapp', 'push'].includes(channel)) {
      throw outboxError('Guest recipients cannot receive in-app or push notifications.');
    }
  }

  const destinationPolicy = recipient.destinationPolicy
    || (kind === 'guest' ? 'event_snapshot' : 'current_user');
  if (!['current_user', 'event_snapshot'].includes(destinationPolicy)) {
    throw outboxError('Notification destination policy is invalid.');
  }
  if (kind === 'guest' && destinationPolicy !== 'event_snapshot') {
    throw outboxError('Guest recipients require an event-snapshot destination.');
  }
  const email = normalizeEmail(recipient.email);
  const phone = normalizePhone(recipient.phone);
  if (destinationPolicy === 'event_snapshot' && channel === 'email' && !email) {
    throw outboxError('Snapshot email notifications require a valid email address.');
  }
  if (
    destinationPolicy === 'event_snapshot'
    && channel === 'whatsapp'
    && (!phone || !isExplicitInternationalPhone(recipient.phone))
  ) {
    throw outboxError('Snapshot WhatsApp notifications require an explicit international phone number.');
  }

  return {
    kind,
    audienceRole,
    user,
    guestKey,
    destinationPolicy,
    email,
    phone,
    allowBlocked: recipient.allowBlocked === true,
  };
};

const normalizeMoney = entries => {
  if (!Array.isArray(entries)) throw outboxError('Notification money snapshots must be an array.');
  const normalized = entries.map(entry => snapshotMinorMoney(entry));
  const keys = normalized.map(entry => entry.key);
  if (new Set(keys).size !== keys.length) {
    throw outboxError('Notification money snapshot keys must be unique.');
  }
  return normalized;
};

const assertSafeData = (data, financial) => {
  const normalized = canonicalize(data || {});
  const serialized = JSON.stringify(normalized);
  if (serialized.length > 8000) throw outboxError('Notification data payload is too large.');
  if (financial) {
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value)) {
        if (FINANCIAL_DATA_KEY.test(key)) {
          throw outboxError(
            'Financial values must be rendered from the immutable money snapshot, not placed in client data.',
            'NOTIFICATION_CLIENT_MONEY_FORBIDDEN'
          );
        }
        visit(entry);
      }
    };
    visit(normalized);
  }
  return normalized;
};

const renderMoneyText = (value, moneyByKey, usedKeys, field, maxLength) => {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > maxLength * 2) {
    throw outboxError(`${field} is invalid.`);
  }
  const rendered = value.replace(MONEY_TOKEN, (_token, key) => {
    const snapshot = moneyByKey.get(key);
    if (!snapshot) {
      throw outboxError(`Notification template references an unknown money snapshot: ${key}.`);
    }
    usedKeys.add(key);
    return formatMoneySnapshot(snapshot);
  });
  if (/\{\{money\./.test(rendered) || rendered.length > maxLength) {
    throw outboxError(`${field} is invalid after rendering.`);
  }
  return rendered;
};

const optionalRenderedText = (value, moneyByKey, usedKeys, field, maxLength) => {
  if (value === null || value === undefined || value === '') return '';
  return renderMoneyText(value, moneyByKey, usedKeys, field, maxLength);
};

const normalizeJsonSnapshot = (value, field) => {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'string' || value !== value.trim() || value.length > 20000) {
    throw outboxError(`${field} is invalid.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (_error) {
    throw outboxError(`${field} is invalid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw outboxError(`${field} must contain a JSON object.`);
  }
  const normalized = canonicalJson(parsed);
  if (normalized.length > 20000) throw outboxError(`${field} is too large.`);
  return normalized;
};

const normalizeChannelPayload = ({ channel, templates, metadata, money, financial, audienceRole }) => {
  const template = templates?.[channel];
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    throw outboxError(`Notification content for ${channel} is required.`);
  }
  const moneyByKey = new Map(money.map(entry => [entry.key, entry]));
  const usedKeys = new Set();
  const base = {
    title: '',
    body: '',
    subject: '',
    text: '',
    html: '',
    message: '',
    linkTo: optionalRenderedText(metadata.linkTo || '', moneyByKey, usedKeys, 'Notification link', 500),
    category: metadata.category || 'system',
    whatsappCategory: metadata.whatsappCategory || '',
    channelId: metadata.channelId || 'general',
    data: assertSafeData(metadata.data, financial),
    relatedOrder: metadata.relatedOrder || null,
    whatsappButtonsPayloadJson: '',
    whatsappListPayloadJson: '',
  };

  if (channel === 'whatsapp' && metadata.whatsappInteractive) {
    base.whatsappButtonsPayloadJson = normalizeJsonSnapshot(
      metadata.whatsappInteractive.buttonsPayloadJson,
      'Notification WhatsApp buttons snapshot',
    );
    base.whatsappListPayloadJson = normalizeJsonSnapshot(
      metadata.whatsappInteractive.listPayloadJson,
      'Notification WhatsApp list snapshot',
    );
    if (!base.whatsappButtonsPayloadJson || !base.whatsappListPayloadJson) {
      throw outboxError('Interactive WhatsApp notifications require both frozen payloads.');
    }
  }

  if (!['announcement', 'promo', 'order', 'payment', 'system', 'seller', 'subscription'].includes(base.category)) {
    throw outboxError('Notification category is invalid.');
  }
  if (base.linkTo && (!base.linkTo.startsWith('/') || base.linkTo.startsWith('//'))) {
    throw outboxError('Notification links must be application-relative paths.');
  }
  if (typeof base.whatsappCategory !== 'string' || base.whatsappCategory.length > 80) {
    throw outboxError('Notification WhatsApp category is invalid.');
  }
  if (typeof base.channelId !== 'string' || !base.channelId || base.channelId.length > 80) {
    throw outboxError('Notification push channel id is invalid.');
  }
  if (base.relatedOrder && !mongoose.isValidObjectId(base.relatedOrder)) {
    throw outboxError('Notification related order id is invalid.');
  }

  if (channel === 'inapp' || channel === 'push') {
    base.title = renderMoneyText(template.title, moneyByKey, usedKeys, 'Notification title', 140);
    base.body = renderMoneyText(template.body, moneyByKey, usedKeys, 'Notification body', 1000);
  } else if (channel === 'email') {
    base.subject = renderMoneyText(template.subject, moneyByKey, usedKeys, 'Notification email subject', 200);
    base.text = optionalRenderedText(template.text, moneyByKey, usedKeys, 'Notification email text', 10000);
    base.html = optionalRenderedText(template.html, moneyByKey, usedKeys, 'Notification email HTML', 100000);
    if (!base.text && !base.html) throw outboxError('Notification email content is required.');
  } else {
    base.message = renderMoneyText(template.message, moneyByKey, usedKeys, 'Notification WhatsApp message', 4000);
    if (audienceRole === 'seller' && !base.whatsappCategory) {
      throw outboxError('Seller WhatsApp notifications require a category.');
    }
  }
  if (financial && usedKeys.size === 0) {
    throw outboxError(
      `Financial notification content for ${channel} must reference an immutable money snapshot.`,
      'NOTIFICATION_MONEY_NOT_RENDERED'
    );
  }
  return { payload: base, usedKeys };
};

const recipientIdentity = recipient => (
  recipient.kind === 'user'
    ? `user:${recipient.user}:${recipient.audienceRole}`
    : `guest:${recipient.guestKey}:${recipient.audienceRole}`
);

const outboxDedupeKey = ({ eventKey, channel, recipient }) => sha256(
  canonicalJson({ schemaVersion: 1, eventKey, channel, recipient: recipientIdentity(recipient) })
);

const contentHashFor = document => sha256(canonicalJson({
  schemaVersion: document.schemaVersion,
  eventKey: document.eventKey,
  eventType: document.eventType,
  aggregateType: document.aggregateType,
  aggregateId: document.aggregateId,
  occurredAt: (
    document.occurredAt instanceof Date
      ? document.occurredAt
      : new Date(document.occurredAt)
  ).toISOString(),
  financial: document.financial,
  recipient: {
    kind: document.recipient.kind,
    audienceRole: document.recipient.audienceRole,
    user: document.recipient.user?.toString?.() || null,
    guestKey: document.recipient.guestKey,
    destinationPolicy: document.recipient.destinationPolicy,
    email: document.recipient.email,
    phone: document.recipient.phone,
    allowBlocked: document.recipient.allowBlocked,
  },
  channel: document.channel,
  payload: document.payload,
  money: document.money,
}));

const loadOutboxByDedupe = dedupeKey => NotificationOutbox.findOne({ dedupeKey })
  .select('+dedupeKey +contentHash +recipient.email +recipient.phone +leaseToken');

const markTransactionRetryable = error => {
  if (typeof error?.addErrorLabel === 'function') {
    error.addErrorLabel('TransientTransactionError');
    return error;
  }
  if (!Array.isArray(error?.errorLabels)) error.errorLabels = [];
  if (!error.errorLabels.includes('TransientTransactionError')) {
    error.errorLabels.push('TransientTransactionError');
  }
  return error;
};

async function enqueueNotificationEvent({
  eventKey,
  eventType,
  aggregateType,
  aggregateId,
  occurredAt,
  financial = false,
  recipient,
  channels,
  templates,
  metadata = {},
  money = [],
  maxAttempts = 8,
  session = null,
}) {
  const event = normalizeEvent({ eventKey, eventType, aggregateType, aggregateId, occurredAt });
  if (
    recipient?.allowBlocked === true
    && !blockedRecipientEventAllowed(event.eventType, recipient?.audienceRole)
  ) {
    throw outboxError(
      'This event and audience are not authorized to notify a blocked recipient.',
      'NOTIFICATION_BLOCKED_RECIPIENT_EVENT_FORBIDDEN'
    );
  }
  if (!Array.isArray(channels) || !channels.length) {
    throw outboxError('At least one notification channel is required.');
  }
  const uniqueChannels = [...new Set(channels)];
  if (uniqueChannels.length !== channels.length || uniqueChannels.some(channel => !CHANNELS.has(channel))) {
    throw outboxError('Notification channels must be unique and supported.');
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 25) {
    throw outboxError('Notification maxAttempts must be an integer between 1 and 25.');
  }
  const normalizedMoney = normalizeMoney(money);
  if (financial !== true && normalizedMoney.length) {
    throw outboxError('Notifications with money snapshots must be explicitly marked financial.');
  }
  if (financial === true && !normalizedMoney.length) {
    throw outboxError('Financial notifications require an immutable money snapshot.');
  }

  const documents = [];
  const allUsedKeys = new Set();
  for (const channel of uniqueChannels) {
    const normalizedRecipient = normalizeRecipient(recipient, channel);
    const { payload, usedKeys } = normalizeChannelPayload({
      channel,
      templates,
      metadata,
      money: normalizedMoney,
      financial,
      audienceRole: normalizedRecipient.audienceRole,
    });
    usedKeys.forEach(key => allUsedKeys.add(key));
    const dedupeKey = outboxDedupeKey({ eventKey: event.eventKey, channel, recipient: normalizedRecipient });
    const document = {
      schemaVersion: 1,
      dedupeKey,
      ...event,
      financial: financial === true,
      recipient: normalizedRecipient,
      channel,
      payload,
      money: normalizedMoney,
      status: 'pending',
      attempts: 0,
      maxAttempts,
      nextAttemptAt: new Date(),
    };
    document.contentHash = contentHashFor(document);
    documents.push(document);
  }
  for (const snapshot of normalizedMoney) {
    if (!allUsedKeys.has(snapshot.key)) {
      throw outboxError(
        `Notification money snapshot ${snapshot.key} is never rendered.`,
        'NOTIFICATION_MONEY_NOT_RENDERED'
      );
    }
  }

  const records = [];
  for (const document of documents) {
    let record;
    try {
      let query = NotificationOutbox.findOneAndUpdate(
        { dedupeKey: document.dedupeKey },
        { $setOnInsert: document },
        { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true, session }
      ).select('+dedupeKey +contentHash +recipient.email +recipient.phone +leaseToken');
      record = await query;
    } catch (error) {
      if (Number(error?.code) !== 11000) throw error;
      if (session?.inTransaction?.()) {
        // A concurrent first insert can make this upsert lose the unique
        // dedupe-key race. MongoDB has already aborted the transaction, so a
        // read on the same session is invalid. Mark the error transient and
        // let the surrounding withTransaction retry from a fresh snapshot;
        // that replay reads the winner and then verifies contentHash below.
        throw markTransactionRetryable(error);
      }
      record = await loadOutboxByDedupe(document.dedupeKey).session(session);
    }
    if (!record) throw outboxError('Notification outbox idempotency recovery failed.');
    if (record.contentHash !== document.contentHash) {
      throw outboxError(
        'The same notification event/channel/recipient was retried with different content.',
        'NOTIFICATION_IDEMPOTENCY_CONFLICT'
      );
    }
    records.push(record);
  }
  return records;
}

const claimNextNotification = async ({
  workerId,
  now = new Date(),
  leaseMs = 60_000,
} = {}) => {
  const owner = cleanRequiredString(workerId, 'Notification worker id', 120);
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 5_000 || leaseMs > 15 * 60_000) {
    throw outboxError('Notification lease duration is invalid.');
  }
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  return NotificationOutbox.findOneAndUpdate({
    $expr: { $lt: ['$attempts', '$maxAttempts'] },
    $or: [
      { status: { $in: ['pending', 'retry'] }, nextAttemptAt: { $lte: now } },
      { status: 'processing', leaseExpiresAt: { $lte: now } },
    ],
  }, {
    $set: {
      status: 'processing',
      leaseToken,
      leaseOwner: owner,
      leaseExpiresAt,
      lastErrorCode: '',
      lastError: '',
    },
    $inc: { attempts: 1 },
  }, {
    new: true,
    sort: { nextAttemptAt: 1, createdAt: 1 },
  }).select('+dedupeKey +contentHash +recipient.email +recipient.phone +leaseToken');
};

const markNotificationDelivered = ({ id, leaseToken, providerMessageId = '', at = new Date() }) => (
  NotificationOutbox.findOneAndUpdate({
    _id: id,
    status: 'processing',
    leaseToken,
  }, {
    $set: {
      status: 'delivered',
      deliveredAt: at,
      providerMessageId: String(providerMessageId || '').slice(0, 300),
      leaseToken: null,
      leaseOwner: '',
      leaseExpiresAt: null,
      lastErrorCode: '',
      lastError: '',
    },
  }, { new: true })
);

const markNotificationSkipped = ({ id, leaseToken, code, reason, at = new Date() }) => (
  NotificationOutbox.findOneAndUpdate({
    _id: id,
    status: 'processing',
    leaseToken,
  }, {
    $set: {
      status: 'skipped',
      skippedAt: at,
      leaseToken: null,
      leaseOwner: '',
      leaseExpiresAt: null,
      lastErrorCode: String(code || 'NOTIFICATION_SKIPPED').slice(0, 120),
      lastError: String(reason || 'Notification delivery was skipped.').slice(0, 1000),
    },
  }, { new: true })
);

const retryDelayMs = attempts => Math.min(60 * 60_000, 30_000 * (2 ** Math.max(0, attempts - 1)));

// A parent notification waiting on a durable child queue should poll forever
// (until the child reaches a terminal state) without spending provider attempt
// budget. The capped exponential interval avoids both hot polling and an
// unbounded delay before the parent observes child completion.
const deferredPollDelayMs = deferredCount => (
  Math.min(5 * 60_000, 30_000 * (2 ** Math.min(4, Math.max(0, deferredCount))))
);

const markNotificationDeferred = ({
  record,
  leaseToken,
  code = 'NOTIFICATION_CHILD_PENDING',
  reason = 'A durable child delivery is still pending.',
  at = new Date(),
}) => {
  const count = Number.isSafeInteger(record?.deferredCount) && record.deferredCount >= 0
    ? record.deferredCount
    : 0;
  return NotificationOutbox.findOneAndUpdate({
    _id: record._id,
    status: 'processing',
    leaseToken,
    attempts: { $gte: 1 },
  }, {
    $set: {
      status: 'retry',
      nextAttemptAt: new Date(at.getTime() + deferredPollDelayMs(count)),
      leaseToken: null,
      leaseOwner: '',
      leaseExpiresAt: null,
      lastErrorCode: String(code || 'NOTIFICATION_CHILD_PENDING').slice(0, 120),
      lastError: String(reason || 'A durable child delivery is still pending.').slice(0, 1000),
    },
    // claimNextNotification increments attempts. Give that attempt back because
    // no provider call was made by the parent while it inspected the child.
    $inc: { attempts: -1, deferredCount: 1 },
  }, { new: true });
};

const markNotificationFailed = ({ record, leaseToken, error, at = new Date() }) => {
  const retryable = error?.retryable !== false;
  const exhausted = record.attempts >= record.maxAttempts;
  const retry = retryable && !exhausted;
  return NotificationOutbox.findOneAndUpdate({
    _id: record._id,
    status: 'processing',
    leaseToken,
  }, {
    $set: {
      status: retry ? 'retry' : 'dead',
      nextAttemptAt: retry ? new Date(at.getTime() + retryDelayMs(record.attempts)) : null,
      deadAt: retry ? null : at,
      leaseToken: null,
      leaseOwner: '',
      leaseExpiresAt: null,
      lastErrorCode: String(error?.code || 'NOTIFICATION_DELIVERY_FAILED').slice(0, 120),
      lastError: String(error?.message || 'Notification delivery failed.').slice(0, 1000),
    },
  }, { new: true });
};

const reapExhaustedNotificationLeases = (now = new Date()) => NotificationOutbox.updateMany({
  status: 'processing',
  leaseExpiresAt: { $lte: now },
  $expr: { $gte: ['$attempts', '$maxAttempts'] },
}, {
  $set: {
    status: 'dead',
    deadAt: now,
    leaseToken: null,
    leaseOwner: '',
    leaseExpiresAt: null,
    lastErrorCode: 'NOTIFICATION_LEASE_EXHAUSTED',
    lastError: 'The notification worker lease expired on the final delivery attempt.',
  },
});

module.exports = {
  ALLOW_BLOCKED_EVENT_AUDIENCES,
  ALLOW_BLOCKED_EVENT_TYPES,
  blockedRecipientEventAllowed,
  canonicalJson,
  claimNextNotification,
  contentHashFor,
  enqueueNotificationEvent,
  markNotificationDelivered,
  markNotificationDeferred,
  markNotificationFailed,
  markNotificationSkipped,
  outboxDedupeKey,
  outboxError,
  reapExhaustedNotificationLeases,
  retryDelayMs,
  deferredPollDelayMs,
};
