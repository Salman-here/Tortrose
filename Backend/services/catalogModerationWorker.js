'use strict';
const mongoose = require('mongoose');
const { stageStoreModeration, catalogWriteGuard } = require('./catalogModerationService');
const { ensureCatalogModerationNotification, recoverCatalogModerationNotifications } = require('./catalogModerationNotificationService');

let timer = null, activeTick = null, nextNoticeRecovery = 0, nextIntake = 0;
const modelFor = kind => require(kind === 'store' ? '../models/Store' : '../models/Product');

// Compatibility recovery for submissions left pending by the removed AI
// reviewer. Current submissions are checked synchronously at save time.
// No model, image downloader/copier, or provider credentials are used here.
async function processNextCatalogItem(kind) {
  const Model = modelFor(kind);
  const entity = await Model.findOne({ moderationStatus: 'pending' })
    .select('+catalogModeration').sort({ 'catalogModeration.submittedAt': 1, _id: 1 }).lean();
  if (!entity) return null;
  const { fields } = kind === 'product'
    ? require('./productModerationService').stageProductModeration(entity, { previous: entity })
    : stageStoreModeration(entity, { previous: entity });
  const updated = await Model.findOneAndUpdate({
    _id: entity._id, ...catalogWriteGuard(entity),
    ...(entity.updatedAt ? { updatedAt: entity.updatedAt } : {}),
  }, { $set: fields, $inc: { __v: 1 } }, { new: true, runValidators: true }).lean();
  if (!updated) return { kind, id: String(entity._id), status: 'superseded' };
  await ensureCatalogModerationNotification(kind, updated).catch(error => console.error('[catalog-moderation] notice deferred:', error.code || 'OUTBOX_ERROR'));
  return { kind, id: String(entity._id), status: updated.moderationStatus };
}

function startCatalogModerationWorker({ intervalMs = 3000 } = {}) {
  if (timer) return false;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000) throw new Error('Invalid moderation recovery interval');
  const tick = () => {
    if (activeTick || mongoose.connection.readyState !== 1) return;
    activeTick = (async () => {
      if (Date.now() >= nextIntake) {
        nextIntake = Date.now() + 30000;
        await require('./catalogModerationIntake').enqueueUnreviewedCatalog();
      }
      await Promise.all(['product', 'store'].map(kind => processNextCatalogItem(kind)));
      if (Date.now() >= nextNoticeRecovery) {
        nextNoticeRecovery = Date.now() + 30000;
        await recoverCatalogModerationNotifications();
      }
    })().catch(error => console.error('[catalog-moderation] recovery tick failed:', error.code || 'RECOVERY_ERROR')).finally(() => { activeTick = null; });
  };
  timer = setInterval(tick, intervalMs); timer.unref?.(); tick(); return true;
}
async function stopCatalogModerationWorker() { if (timer) clearInterval(timer); timer = null; await activeTick; }
const isCatalogModerationWorkerRunning = () => !!timer;
module.exports = { processNextCatalogItem, startCatalogModerationWorker, stopCatalogModerationWorker, isCatalogModerationWorkerRunning };
