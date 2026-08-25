'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const BroadcastJob = require('../models/BroadcastJob');
const {
  VALID_BROADCAST_AUDIENCES,
  normalizeBroadcastAudience,
} = require('./notificationAudienceService');

const VALID_BROADCAST_CATEGORIES = new Set([
  'announcement',
  'promo',
  'order',
  'system',
  'seller',
]);
const VALID_BROADCAST_CHANNELS = new Set(['inapp', 'push', 'email', 'whatsapp']);
const VALID_BROADCAST_SCHEDULE_TYPES = new Set(['immediate', 'one_time', 'recurring']);
const VALID_BROADCAST_RECURRENCES = new Set(['daily', 'weekly', 'monthly']);

const configuredLeaseMs = Number(process.env.BROADCAST_DELIVERY_LEASE_MS);
const BROADCAST_DELIVERY_LEASE_MS = Number.isSafeInteger(configuredLeaseMs) && configuredLeaseMs >= 60_000
  ? Math.min(configuredLeaseMs, 60 * 60 * 1000)
  : 15 * 60 * 1000;

class BroadcastValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BroadcastValidationError';
    this.code = 'BROADCAST_INPUT_INVALID';
    this.statusCode = 400;
  }
}

const invalid = message => {
  throw new BroadcastValidationError(message);
};

function normalizeBroadcastCreateInput(input = {}, { now = new Date() } = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const normalizedNow = new Date(now);
  if (Number.isNaN(normalizedNow.getTime())) invalid('The broadcast creation time is invalid');

  const title = typeof source.title === 'string' ? source.title.trim() : '';
  const body = typeof source.body === 'string' ? source.body.trim() : '';
  if (!title || !body) invalid('title and body are required');
  if (title.length > 140 || body.length > 1000) {
    invalid('title must be at most 140 characters and body at most 1000 characters');
  }

  const category = source.category === undefined ? 'announcement' : source.category;
  if (!VALID_BROADCAST_CATEGORIES.has(category)) {
    invalid(`Invalid category. Allowed: ${[...VALID_BROADCAST_CATEGORIES].join(', ')}`);
  }

  const audience = source.audience === undefined
    ? 'all_users'
    : normalizeBroadcastAudience(source.audience);
  if (!audience) {
    invalid(`Invalid audience. Allowed: ${[...VALID_BROADCAST_AUDIENCES].join(', ')}`);
  }

  const rawUserIds = source.userIds === undefined ? [] : source.userIds;
  if (!Array.isArray(rawUserIds)) invalid('userIds must be an array');
  if (audience === 'specific' && rawUserIds.length === 0) {
    invalid('userIds required when audience is "specific"');
  }
  const userIds = audience === 'specific'
    ? [...new Map(rawUserIds.map(id => [String(id), id])).values()]
    : [];
  if (userIds.some(id => !mongoose.isObjectIdOrHexString(id))) {
    invalid('Every userId must be a valid user identifier');
  }

  const rawChannels = source.channels === undefined ? ['inapp', 'push'] : source.channels;
  if (!Array.isArray(rawChannels) || rawChannels.length === 0) {
    invalid('channels must be a non-empty array');
  }
  if (rawChannels.some(channel => !VALID_BROADCAST_CHANNELS.has(channel))) {
    invalid(`Invalid channel. Allowed: ${[...VALID_BROADCAST_CHANNELS].join(', ')}`);
  }
  const channels = [...new Set(rawChannels)];

  const scheduleType = source.scheduleType === undefined ? 'immediate' : source.scheduleType;
  if (!VALID_BROADCAST_SCHEDULE_TYPES.has(scheduleType)) {
    invalid('Invalid scheduleType. Allowed: immediate, one_time, recurring');
  }

  let nextRunAt = normalizedNow;
  if (scheduleType === 'one_time' || scheduleType === 'recurring') {
    if (!source.scheduledAt) invalid('scheduledAt is required for scheduled broadcasts');
    nextRunAt = new Date(source.scheduledAt);
    if (Number.isNaN(nextRunAt.getTime())) invalid('Invalid scheduledAt');
  }

  let recurrence = 'none';
  let recurrenceAnchorDay = null;
  let endsAt = null;
  if (scheduleType === 'recurring') {
    recurrence = source.recurrence;
    if (!VALID_BROADCAST_RECURRENCES.has(recurrence)) {
      invalid('Recurring broadcasts require recurrence: daily, weekly, or monthly');
    }
    recurrenceAnchorDay = recurrence === 'monthly' ? nextRunAt.getUTCDate() : null;
    if (source.endsAt) {
      endsAt = new Date(source.endsAt);
      if (Number.isNaN(endsAt.getTime())) invalid('Invalid endsAt');
      if (endsAt < nextRunAt) invalid('endsAt cannot be before the first scheduled run');
    }
  }

  return {
    title,
    body,
    category,
    linkTo: typeof source.linkTo === 'string' ? source.linkTo.trim() : '',
    audience,
    userIds,
    channels,
    scheduleType,
    recurrence,
    recurrenceAnchorDay,
    nextRunAt,
    endsAt,
  };
}

async function createBroadcastJob({
  input,
  createdBy,
  claimImmediate = false,
  now = new Date(),
} = {}) {
  const normalized = normalizeBroadcastCreateInput(input, { now });
  const ownsImmediateRun = claimImmediate && normalized.scheduleType === 'immediate';
  const leaseToken = ownsImmediateRun ? crypto.randomUUID() : '';

  const job = await BroadcastJob.create({
    ...normalized,
    status: ownsImmediateRun ? 'sending' : 'scheduled',
    leaseToken,
    leaseAcquiredAt: ownsImmediateRun ? new Date(now) : null,
    leaseExpiresAt: ownsImmediateRun
      ? new Date(new Date(now).getTime() + BROADCAST_DELIVERY_LEASE_MS)
      : null,
    createdBy,
  });

  return { job, leaseToken };
}

async function cancelScheduledBroadcast(broadcastId) {
  if (!mongoose.isObjectIdOrHexString(broadcastId)) {
    return { outcome: 'not_found', job: null, status: null };
  }

  const job = await BroadcastJob.findOneAndUpdate(
    { _id: broadcastId, status: 'scheduled' },
    {
      $set: {
        status: 'cancelled',
        nextRunAt: null,
        leaseToken: '',
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
      },
    },
    { new: true }
  );
  if (job) return { outcome: 'cancelled', job, status: 'cancelled' };

  const existing = await BroadcastJob.findById(broadcastId).select('status');
  if (!existing) return { outcome: 'not_found', job: null, status: null };
  return {
    outcome: existing.status === 'sending' ? 'sending' : 'finalized',
    job: null,
    status: existing.status,
  };
}

function broadcastForResponse(job) {
  const value = typeof job?.toObject === 'function' ? job.toObject() : { ...(job || {}) };
  delete value.leaseToken;
  return value;
}

module.exports = {
  BROADCAST_DELIVERY_LEASE_MS,
  BroadcastValidationError,
  broadcastForResponse,
  cancelScheduledBroadcast,
  createBroadcastJob,
  normalizeBroadcastCreateInput,
};
