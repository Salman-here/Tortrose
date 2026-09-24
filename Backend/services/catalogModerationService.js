'use strict';
const crypto = require('node:crypto');
const { POLICY_VERSION, contentSnapshot, contentHash, inspectContent } = require('./catalogContentPolicy');

const plain = value => value?.toObject ? value.toObject() : value;
const summarizeViolations = violations => [...new Set(violations.map(v => `${v.field}: ${v.reason}`))].join(' ').slice(0, 950);

function prepareCatalogModeration(kind, entity, { previous = null, extraViolations = [], now = new Date() } = {}) {
  const snapshot = contentSnapshot(kind, entity);
  const hash = contentHash(snapshot);
  const prior = plain(previous?.catalogModeration);
  const violations = [...new Map([...inspectContent(snapshot), ...extraViolations].map(violation => [`${violation.field}:${violation.code}`, violation])).values()].slice(0, 20);
  if (prior?.policyVersion === POLICY_VERSION && prior.contentHash === hash
    && previous?.moderationPolicyVersion === POLICY_VERSION
    && ['approved', 'blocked'].includes(previous.moderationStatus) && previous.moderationReviewedAt
    && (!violations.length || JSON.stringify(prior.violations || []) === JSON.stringify(violations))) {
    // Reuse an unchanged local decision; never retain the old AI pending state.
    return { fields: {}, result: { status: previous.moderationStatus, blocked: previous.moderationStatus === 'blocked', reason: previous.moderationReason || '' } };
  }
  const status = violations.length ? 'blocked' : 'approved';
  const reason = violations.length ? summarizeViolations(violations) : '';
  const notify = status === 'blocked' || ['blocked', 'pending'].includes(previous?.moderationStatus);
  const revision = crypto.randomUUID();
  const fields = {
    moderationPolicyVersion: POLICY_VERSION,
    moderationRevision: revision,
    moderationStatus: status,
    moderationReason: reason,
    moderationSignals: [...new Set(violations.map(v => v.code))],
    moderationFields: [...new Set(violations.map(v => v.field))],
    moderationReviewedAt: now,
    catalogModeration: {
      policyVersion: POLICY_VERSION, contentHash: hash, revision, submittedAt: now,
      violations, attempts: 0, nextAttemptAt: null, leaseUntil: null, leaseToken: '', lastError: '',
      lastApprovedName: kind === 'store' && status === 'approved' ? entity.storeName || '' : prior?.lastApprovedName || (previous && !['blocked', 'pending'].includes(previous.moderationStatus) ? previous.storeName || '' : ''),
      noticeId: notify ? crypto.randomUUID() : '', noticeAt: notify ? now : null,
      noticeStatus: notify ? status : '', noticeReason: notify ? reason : '', noticeEnqueuedAt: null,
    },
  };
  if (kind === 'product') Object.assign(fields, {
    isBlocked: status === 'blocked', blockedAt: status === 'blocked' ? now : null, blockedReason: reason,
    moderationNotice: { reviewedAt: null, productName: '', reason: '', notificationEnqueuedAt: now },
  });
  return { fields, result: { status, blocked: status === 'blocked', reason, signals: fields.moderationSignals } };
}

function moderationMessage(kind, entity) {
  const label = kind === 'store' ? 'Store' : 'Product';
  if (entity?.moderationStatus === 'pending') return `${label} is waiting for local rule checks. No AI review is used.`;
  if (entity?.moderationStatus === 'blocked') return `${label} saved but not published. ${entity.moderationReason || 'Please correct the content policy violations.'}`;
  return `${label} saved successfully. Local content rules passed.`;
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
    // Rejected names do not consume the cooldown. Accepted edits do, without
    // requiring any background model call.
    prepared.fields.lastNameChangeAt = prepared.result.status === 'approved' ? new Date() : previous.lastNameChangeAt || null;
  } else if (prepared.result.status === 'approved' && previous?.moderationStatus === 'pending'
    && previous.catalogModeration?.lastApprovedName && previous.catalogModeration.lastApprovedName !== entity.storeName) {
    prepared.fields.lastNameChangeAt = new Date();
  }
  return prepared;
}

const moderatedStoreInput = input => ({ ...input, ...stageStoreModeration(input).fields });

module.exports = { prepareCatalogModeration, stageStoreModeration, moderatedStoreInput, catalogWriteGuard, moderationMessage, summarizeViolations };
