'use strict';

const mongoose = require('mongoose');

const SUPPORTED_CURRENCIES = ['USD', 'PKR', 'EUR', 'GBP'];
const OUTBOX_CHANNELS = ['inapp', 'push', 'email', 'whatsapp'];
const OUTBOX_STATUSES = ['pending', 'processing', 'retry', 'delivered', 'skipped', 'dead', 'superseded'];

const strictString = value => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') throw new TypeError('Notification outbox text fields require strings.');
  return value;
};

const safeMinorUnits = value => (
  typeof value === 'number'
  && Number.isSafeInteger(value)
  && value >= 0
);

const moneySnapshotSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    immutable: true,
    maxlength: 64,
    match: /^[a-z][a-z0-9_.-]{0,63}$/,
    set: strictString,
  },
  label: { type: String, default: '', immutable: true, maxlength: 100, set: strictString },
  amountMinor: {
    type: Number,
    required: true,
    immutable: true,
    set(value) {
      return safeMinorUnits(value) ? value : Number.NaN;
    },
    validate: {
      validator: safeMinorUnits,
      message: 'Notification money must be a non-negative safe minor-unit integer.',
    },
  },
  currency: {
    type: String,
    required: true,
    immutable: true,
    enum: SUPPORTED_CURRENCIES,
    set: strictString,
  },
  sourceModel: {
    type: String,
    required: true,
    immutable: true,
    maxlength: 80,
    match: /^[A-Za-z][A-Za-z0-9_]{0,79}$/,
    set: strictString,
  },
  sourceDocumentId: {
    type: String,
    required: true,
    immutable: true,
    maxlength: 200,
    set: strictString,
  },
  sourcePath: {
    type: String,
    required: true,
    immutable: true,
    maxlength: 160,
    match: /^[A-Za-z][A-Za-z0-9_.\[\]-]{0,159}$/,
    set: strictString,
  },
}, { _id: false, strict: 'throw' });

const recipientSchema = new mongoose.Schema({
  kind: { type: String, enum: ['user', 'guest'], required: true, immutable: true },
  audienceRole: {
    type: String,
    enum: ['buyer', 'seller', 'admin'],
    required: true,
    immutable: true,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    immutable: true,
    index: true,
  },
  // A stable, non-contact identity such as `order:<mongo-id>` for guests.
  // Email/phone must never be used directly as an idempotency key.
  guestKey: { type: String, default: '', immutable: true, maxlength: 220, set: strictString },
  destinationPolicy: {
    type: String,
    enum: ['current_user', 'event_snapshot'],
    default: 'current_user',
    immutable: true,
  },
  // Snapshot destinations are excluded from ordinary reads. They are needed
  // for guest receipts and explicit checkout-time destination contracts only.
  email: { type: String, default: '', immutable: true, maxlength: 320, select: false, set: strictString },
  phone: { type: String, default: '', immutable: true, maxlength: 32, select: false, set: strictString },
  allowBlocked: { type: Boolean, default: false, immutable: true },
}, { _id: false, strict: 'throw' });

const payloadSchema = new mongoose.Schema({
  title: { type: String, default: '', immutable: true, maxlength: 140, set: strictString },
  body: { type: String, default: '', immutable: true, maxlength: 1000, set: strictString },
  subject: { type: String, default: '', immutable: true, maxlength: 200, set: strictString },
  text: { type: String, default: '', immutable: true, maxlength: 10000, set: strictString },
  html: { type: String, default: '', immutable: true, maxlength: 100000, set: strictString },
  message: { type: String, default: '', immutable: true, maxlength: 4000, set: strictString },
  linkTo: { type: String, default: '', immutable: true, maxlength: 500, set: strictString },
  category: {
    type: String,
    enum: ['announcement', 'promo', 'order', 'payment', 'system', 'seller', 'subscription'],
    default: 'system',
    immutable: true,
  },
  whatsappCategory: { type: String, default: '', immutable: true, maxlength: 80, set: strictString },
  channelId: { type: String, default: 'general', immutable: true, maxlength: 80, set: strictString },
  data: { type: mongoose.Schema.Types.Mixed, default: () => ({}), immutable: true },
  relatedOrder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    default: null,
    immutable: true,
  },
  // JSON snapshots for interactive WhatsApp confirmation delivery. Storing
  // these in the transactional outbox prevents a later mutable Order read from
  // changing item/amount text while the queue is waiting to send.
  whatsappButtonsPayloadJson: {
    type: String, default: '', immutable: true, maxlength: 20000, set: strictString,
  },
  whatsappListPayloadJson: {
    type: String, default: '', immutable: true, maxlength: 20000, set: strictString,
  },
}, { _id: false, strict: 'throw' });

const notificationOutboxSchema = new mongoose.Schema({
  schemaVersion: { type: Number, enum: [1], default: 1, required: true, immutable: true },
  dedupeKey: {
    type: String,
    required: true,
    unique: true,
    index: true,
    immutable: true,
    select: false,
    maxlength: 64,
  },
  contentHash: {
    type: String,
    required: true,
    immutable: true,
    select: false,
    maxlength: 64,
    match: /^[a-f0-9]{64}$/,
  },
  eventKey: {
    type: String,
    required: true,
    immutable: true,
    maxlength: 300,
    match: /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,299}$/,
    index: true,
    set: strictString,
  },
  eventType: {
    type: String,
    required: true,
    immutable: true,
    maxlength: 100,
    match: /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/,
    index: true,
    set: strictString,
  },
  aggregateType: {
    type: String,
    required: true,
    immutable: true,
    maxlength: 80,
    match: /^[A-Za-z][A-Za-z0-9_]{0,79}$/,
    set: strictString,
  },
  aggregateId: { type: String, required: true, immutable: true, maxlength: 200, index: true, set: strictString },
  occurredAt: { type: Date, required: true, immutable: true },
  financial: { type: Boolean, default: false, immutable: true },
  recipient: { type: recipientSchema, required: true, immutable: true },
  channel: { type: String, enum: OUTBOX_CHANNELS, required: true, immutable: true, index: true },
  payload: { type: payloadSchema, required: true, immutable: true },
  money: { type: [moneySnapshotSchema], default: [], immutable: true },
  status: { type: String, enum: OUTBOX_STATUSES, default: 'pending', required: true, index: true },
  attempts: {
    type: Number,
    default: 0,
    min: 0,
    validate: { validator: Number.isSafeInteger, message: 'Notification attempts must be a safe integer.' },
  },
  // Polling a durable child queue is not a provider delivery attempt. Keep a
  // separate counter so child-state checks can back off without exhausting the
  // finite provider-attempt budget.
  deferredCount: {
    type: Number,
    default: 0,
    min: 0,
    validate: { validator: Number.isSafeInteger, message: 'Notification deferred count must be a safe integer.' },
  },
  maxAttempts: {
    type: Number,
    default: 8,
    min: 1,
    max: 25,
    immutable: true,
    validate: { validator: Number.isSafeInteger, message: 'Notification maxAttempts must be a safe integer.' },
  },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  leaseToken: { type: String, default: null, select: false, maxlength: 80 },
  leaseOwner: { type: String, default: '', maxlength: 120 },
  leaseExpiresAt: { type: Date, default: null, index: true },
  deliveredAt: { type: Date, default: null },
  skippedAt: { type: Date, default: null },
  deadAt: { type: Date, default: null },
  providerMessageId: { type: String, default: '', maxlength: 300 },
  lastErrorCode: { type: String, default: '', maxlength: 120 },
  lastError: { type: String, default: '', maxlength: 1000 },
}, {
  timestamps: true,
  strict: 'throw',
  optimisticConcurrency: true,
});

notificationOutboxSchema.index({ status: 1, nextAttemptAt: 1, leaseExpiresAt: 1, createdAt: 1 });
notificationOutboxSchema.index({ 'recipient.user': 1, eventType: 1, createdAt: -1 });
notificationOutboxSchema.index({ aggregateType: 1, aggregateId: 1, eventType: 1 });

notificationOutboxSchema.pre('validate', function validateEnvelope() {
  const recipient = this.recipient || {};
  if (recipient.kind === 'user' && !recipient.user) {
    this.invalidate('recipient.user', 'User notification recipients require a user id.');
  }
  if (recipient.kind === 'guest') {
    if (recipient.audienceRole !== 'buyer') {
      this.invalidate('recipient.audienceRole', 'Guest notification recipients can only be buyers.');
    }
    if (!recipient.guestKey) {
      this.invalidate('recipient.guestKey', 'Guest notification recipients require a stable guest key.');
    }
    if (['inapp', 'push'].includes(this.channel)) {
      this.invalidate('channel', 'Guest recipients cannot receive in-app or push notifications.');
    }
  }
  if (recipient.destinationPolicy === 'current_user' && recipient.kind !== 'user') {
    this.invalidate('recipient.destinationPolicy', 'Only user recipients can resolve current account destinations.');
  }
  if (recipient.destinationPolicy === 'event_snapshot') {
    if (this.channel === 'email' && !recipient.email) {
      this.invalidate('recipient.email', 'Snapshot email delivery requires an email address.');
    }
    if (this.channel === 'whatsapp' && !recipient.phone) {
      this.invalidate('recipient.phone', 'Snapshot WhatsApp delivery requires a phone number.');
    }
  }
  if (this.financial && !(this.money || []).length) {
    this.invalidate('money', 'Financial notifications require an immutable money snapshot.');
  }
  const keys = (this.money || []).map(entry => entry.key);
  if (new Set(keys).size !== keys.length) {
    this.invalidate('money', 'Notification money snapshot keys must be unique.');
  }
  if (this.channel === 'inapp' || this.channel === 'push') {
    if (!this.payload?.title || !this.payload?.body) {
      this.invalidate('payload', 'In-app and push notifications require a title and body.');
    }
  } else if (this.channel === 'email') {
    if (!this.payload?.subject || (!this.payload?.text && !this.payload?.html)) {
      this.invalidate('payload', 'Email notifications require a subject and text or HTML body.');
    }
  } else if (this.channel === 'whatsapp' && !this.payload?.message) {
    this.invalidate('payload.message', 'WhatsApp notifications require a message.');
  }
});

module.exports = mongoose.model('NotificationOutbox', notificationOutboxSchema);
module.exports.OUTBOX_CHANNELS = OUTBOX_CHANNELS;
module.exports.OUTBOX_STATUSES = OUTBOX_STATUSES;
module.exports.SUPPORTED_CURRENCIES = SUPPORTED_CURRENCIES;
