'use strict';
const crypto = require('node:crypto');
const { POLICY_VERSION, contentSnapshot, contentHash, inspectContent } = require('./catalogContentPolicy');

const PENDING_REASON = 'Automatic content checks are in progress. This content is not public yet.';
const plain = value => value?.toObject ? value.toObject() : value;
const summarizeViolations = violations => [...new Set(violations.map(v => `${v.field}: ${v.reason}`))].join(' ').slice(0, 950);

function prepareCatalogModeration(kind, entity, { previous = null, extraViolations = [], now = new Date() } = {}) {
  const snapshot = contentSnapshot(kind, entity);
  const hash = contentHash(snapshot);
  const prior = plain(previous?.catalogModeration);
  const violations = [...new Map([...inspectContent(snapshot), ...extraViolations].map(violation => [`${violation.field}:${violation.code}`, violation])).values()].slice(0, 20);
  if (prior?.policyVersion === POLICY_VERSION && prior.contentHash === hash
    && previous?.moderationPolicyVersion === POLICY_VERSION
    && (previous.moderationStatus !== 'approved' || previous.moderationReviewedAt)
    && (!violations.length || JSON.stringify(prior.violations || []) === JSON.stringify(violations))) {
    // A price/stock-only edit must not reset an in-flight lease or overwrite
    // a result that the worker committed since this request read the row.
    return { fields: {}, result: { status: previous.moderationStatus, blocked: previous.moderationStatus === 'blocked', reason: previous.moderationReason || '' } };
  }
  const status = violations.length ? 'blocked' : 'pending';
  const reason = violations.length ? summarizeViolations(violations) : PENDING_REASON;
  const revision = crypto.randomUUID();
  const fields = {
    moderationPolicyVersion: POLICY_VERSION,
    moderationRevision: revision,
    moderationStatus: status,
    moderationReason: reason,
    moderationSignals: [...new Set(violations.map(v => v.code))],
    moderationFields: [...new Set(violations.map(v => v.field))],
    moderationReviewedAt: status === 'blocked' ? now : null,
    catalogModeration: {
      policyVersion: POLICY_VERSION, contentHash: hash, revision, submittedAt: now,
      violations, attempts: 0, nextAttemptAt: status === 'pending' ? now : null, leaseUntil: null, leaseToken: '', lastError: '',
      lastApprovedName: prior?.lastApprovedName || (previous && !['blocked', 'pending'].includes(previous.moderationStatus) ? previous.storeName || '' : ''),
      noticeId: status === 'blocked' ? crypto.randomUUID() : '', noticeAt: status === 'blocked' ? now : null,
      noticeStatus: status === 'blocked' ? status : '', noticeReason: status === 'blocked' ? reason : '', noticeEnqueuedAt: null,
    },
  };
  if (kind === 'product') Object.assign(fields, {
    // Old clients already understand this availability guard; newer clients
    // distinguish pending from blocked using moderationStatus.
    isBlocked: true, blockedAt: status === 'blocked' ? now : null, blockedReason: reason,
    moderationNotice: { reviewedAt: null, productName: '', reason: '', notificationEnqueuedAt: now },
  });
  return { fields, result: { status, blocked: status === 'blocked', reason, signals: fields.moderationSignals } };
}

function moderationMessage(kind, entity) {
  const label = kind === 'store' ? 'Store' : 'Product';
  if (entity?.moderationStatus === 'pending') return `${label} saved. Automatic content checks are in progress; it will become public after approval.`;
  if (entity?.moderationStatus === 'blocked') return `${label} saved but not published. ${entity.moderationReason || 'Please correct the content policy violations.'}`;
  return `${label} saved successfully.`;
}

function catalogWriteGuard(previous) {
  return {
    'catalogModeration.revision': previous?.catalogModeration?.revision || { $in: ['', null] },
    moderationStatus: previous?.moderationStatus && previous.moderationStatus !== 'approved' ? previous.moderationStatus : { $in: ['approved', null] },
  };
}

function stageStoreModeration(entity, { previous = null } = {}) {
  const prepared = prepareCatalogModeration('store', entity, { previous });
  if (Object.keys(prepared.fields).length && previous && entity.storeName !== previous.storeName) {
    // Rejected/pending names do not consume the rename cooldown. The worker
    // starts it only when a changed name actually passes moderation.
    prepared.fields.lastNameChangeAt = previous.lastNameChangeAt || null;
  }
  return prepared;
}

const moderatedStoreInput = input => ({ ...input, ...stageStoreModeration(input).fields });

module.exports = { PENDING_REASON, prepareCatalogModeration, stageStoreModeration, moderatedStoreInput, catalogWriteGuard, moderationMessage, summarizeViolations };
