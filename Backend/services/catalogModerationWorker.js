'use strict';
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { POLICY_VERSION, contentSnapshot, contentHash } = require('./catalogContentPolicy');
const { prepareCatalogModeration, summarizeViolations } = require('./catalogModerationService');
const { reviewCatalogContent } = require('./catalogModerationProvider');
const { pinCatalogImages } = require('./catalogModerationAssets');
const { ensureCatalogModerationNotification, recoverCatalogModerationNotifications } = require('./catalogModerationNotificationService');

const LEASE_MS = 300000;
let timer = null, activeTick = null, nextNoticeRecovery = 0, nextIntake = 0;
const modelFor = kind => require(kind === 'store' ? '../models/Store' : '../models/Product');

async function processNextCatalogItem(kind, { review = reviewCatalogContent, prepareMedia = pinCatalogImages, now = () => new Date() } = {}) {
  const Model = modelFor(kind), at = now(), token = crypto.randomUUID();
  const entity = await Model.findOneAndUpdate({
    moderationStatus: 'pending', 'catalogModeration.contentHash': { $type: 'string' },
    'catalogModeration.nextAttemptAt': { $lte: at },
    $or: [{ 'catalogModeration.leaseUntil': null }, { 'catalogModeration.leaseUntil': { $lte: at } }],
  }, { $set: { 'catalogModeration.leaseToken': token, 'catalogModeration.leaseUntil': new Date(at.getTime() + LEASE_MS) }, $inc: { 'catalogModeration.attempts': 1 } },
  { new: true, sort: { 'catalogModeration.nextAttemptAt': 1, _id: 1 }, timestamps: false }).select('+catalogModeration').lean();
  if (!entity) return null;
  const identity = { _id: entity._id, moderationStatus: 'pending', 'catalogModeration.contentHash': entity.catalogModeration.contentHash,
    'catalogModeration.revision': entity.catalogModeration.revision, 'catalogModeration.leaseToken': token };
  try {
    const snapshot = contentSnapshot(kind, entity);
    if (contentHash(snapshot) !== entity.catalogModeration.contentHash) {
      const { fields } = kind === 'product' ? require('./productModerationService').stageProductModeration(entity) : prepareCatalogModeration(kind, entity);
      await Model.updateOne(identity, { $set: fields, $inc: { __v: 1 } });
      return { kind, id: String(entity._id), status: 'restaged' };
    }
    const media = await prepareMedia(kind, entity, { persist: async asset => {
      const stored = await Model.updateOne(identity, { $addToSet: { 'catalogModeration.assets': asset } }, { timestamps: false });
      if (stored.matchedCount !== 1) throw Object.assign(new Error('Content changed during image preparation'), { code: 'MODERATION_SUPERSEDED' });
    } });
    const result = await review(media.snapshot);
    if (!result || !['approved', 'blocked', 'pending'].includes(result.status) || !Array.isArray(result.violations)) throw Object.assign(new Error('Invalid moderation result'), { code: 'MODERATION_RESPONSE_INVALID' });
    if (result.status === 'pending') throw Object.assign(new Error('Content review needs another attempt'), { code: 'MODERATION_REVIEW_INCOMPLETE' });
    const completedAt = now();
    const reason = result.status === 'blocked' ? summarizeViolations(result.violations) : '';
    if (result.status === 'blocked' && !reason) throw Object.assign(new Error('Missing policy reason'), { code: 'MODERATION_RESPONSE_INVALID' });
    const set = {
      moderationStatus: result.status, moderationReason: reason, moderationReviewedAt: completedAt,
      moderationSignals: [...new Set(result.violations.map(v => v.code))],
      moderationFields: [...new Set(result.violations.map(v => v.field))],
      'catalogModeration.violations': result.violations, 'catalogModeration.nextAttemptAt': null,
      'catalogModeration.leaseToken': '', 'catalogModeration.leaseUntil': null, 'catalogModeration.lastError': '',
      'catalogModeration.noticeId': crypto.randomUUID(), 'catalogModeration.noticeAt': completedAt,
      'catalogModeration.noticeStatus': result.status, 'catalogModeration.noticeReason': reason, 'catalogModeration.noticeEnqueuedAt': null,
    };
    if (result.status === 'approved') {
      Object.assign(set, media.fields);
      set['catalogModeration.contentHash'] = contentHash(media.snapshot);
    }
    if (kind === 'product') Object.assign(set, { isBlocked: result.status !== 'approved', blockedReason: reason, blockedAt: result.status === 'blocked' ? completedAt : null });
    if (kind === 'store' && result.status === 'approved') {
      const previousName = entity.catalogModeration.lastApprovedName;
      if (previousName && previousName !== entity.storeName) set.lastNameChangeAt = completedAt;
      set['catalogModeration.lastApprovedName'] = entity.storeName;
    }
    const updated = await Model.findOneAndUpdate(identity, { $set: set, $inc: { __v: 1 } }, { new: true, runValidators: true }).lean();
    if (!updated) return { kind, id: String(entity._id), status: 'superseded' };
    await ensureCatalogModerationNotification(kind, updated).catch(error => console.error('[catalog-moderation] notice deferred:', error.code || 'OUTBOX_ERROR'));
    return { kind, id: String(entity._id), status: updated.moderationStatus };
  } catch (error) {
    const completedAt = now();
    const delay = Math.min(6 * 60 * 60 * 1000, 60000 * 2 ** Math.min(9, entity.catalogModeration.attempts - 1));
    const set = { 'catalogModeration.leaseToken': '', 'catalogModeration.leaseUntil': null,
      'catalogModeration.nextAttemptAt': new Date(completedAt.getTime() + delay),
      'catalogModeration.lastError': String(error.code || 'MODERATION_UNAVAILABLE').slice(0, 160),
      moderationReason: 'Automatic checks could not finish yet. The content remains hidden and will be checked again automatically. If this continues, add clearer details or replace unavailable images.',
    };
    if (!entity.catalogModeration.noticeId) Object.assign(set, {
      'catalogModeration.noticeId': crypto.randomUUID(), 'catalogModeration.noticeAt': completedAt,
      'catalogModeration.noticeStatus': 'pending', 'catalogModeration.noticeReason': set.moderationReason, 'catalogModeration.noticeEnqueuedAt': null,
    });
    if (kind === 'product') set.blockedReason = set.moderationReason;
    const updated = await Model.findOneAndUpdate(identity, { $set: set }, { new: true }).lean();
    if (updated) await ensureCatalogModerationNotification(kind, updated).catch(() => {});
    return { kind, id: String(entity._id), status: updated ? 'pending' : 'superseded', code: set['catalogModeration.lastError'] };
  }
}

function startCatalogModerationWorker({ intervalMs = 3000, concurrency = Number(process.env.CATALOG_MODERATION_CONCURRENCY || 2) } = {}) {
  if (timer) return false;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000) throw new Error('Invalid moderation worker interval');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Moderation concurrency must be 1–8');
  let firstKind = 0;
  const tick = () => {
    if (activeTick || mongoose.connection.readyState !== 1) return;
    activeTick = (async () => {
      if (Date.now() >= nextIntake) {
        nextIntake = Date.now() + 30000;
        await require('./catalogModerationIntake').enqueueUnreviewedCatalog();
      }
      const kinds = ['product', 'store'];
      await Promise.all(Array.from({ length: concurrency }, async (_, i) => {
        const index = (firstKind + i) % 2;
        if (!await processNextCatalogItem(kinds[index])) await processNextCatalogItem(kinds[1 - index]);
      }));
      firstKind = 1 - firstKind;
      if (Date.now() >= nextNoticeRecovery) {
        nextNoticeRecovery = Date.now() + 30000;
        await recoverCatalogModerationNotifications();
      }
    })().catch(error => console.error('[catalog-moderation] worker tick failed:', error.code || 'WORKER_ERROR')).finally(() => { activeTick = null; });
  };
  timer = setInterval(tick, intervalMs); timer.unref?.(); tick(); return true;
}
async function stopCatalogModerationWorker() { if (timer) clearInterval(timer); timer = null; await activeTick; }
const isCatalogModerationWorkerRunning = () => !!timer;
module.exports = { processNextCatalogItem, startCatalogModerationWorker, stopCatalogModerationWorker, isCatalogModerationWorkerRunning };
