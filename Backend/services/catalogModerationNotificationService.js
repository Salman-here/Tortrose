'use strict';
const { enqueueNotificationEvent } = require('./notificationOutboxService');
const { escapeHtml } = require('../utils/orderPresentation');

async function ensureCatalogModerationNotification(kind, entity, { session = null } = {}) {
  const Model = require(kind === 'store' ? '../models/Store' : '../models/Product');
  if (entity?._id && !entity.catalogModeration) entity = await Model.findById(entity._id).select('seller +catalogModeration').lean();
  const notice = entity?.catalogModeration;
  if (!entity?.seller || !notice?.noticeId || !notice.noticeAt || notice.noticeEnqueuedAt) return [];
  const label = kind === 'store' ? 'Store' : 'Product';
  const title = `${label} ${notice.noticeStatus === 'approved' ? 'content approved' : notice.noticeStatus === 'blocked' ? 'needs changes' : 'checks delayed'}`;
  // Do not repeat a rejected title/name (or an offensive image caption) in
  // email subjects, notification banners or WhatsApp messages.
  const body = notice.noticeStatus === 'approved'
    ? `Your ${kind} passed the local content rules. You can view its current status in your seller dashboard.`
    : `${notice.noticeReason} ${notice.noticeStatus === 'blocked' ? 'Edit the flagged content to submit it for automatic checks again.' : 'It remains hidden while we retry automatically.'}`.slice(0, 1000);
  const linkTo = kind === 'store' ? '/seller-dashboard/store-settings' : '/seller-dashboard/product-management';
  const id = String(entity._id);
  const records = await enqueueNotificationEvent({
    eventKey: `catalog:${kind}:${id}:moderation:${notice.noticeId}:seller:v1`,
    eventType: 'catalog.moderation', aggregateType: label, aggregateId: id,
    occurredAt: new Date(notice.noticeAt), financial: false,
    recipient: { kind: 'user', audienceRole: 'seller', user: String(entity.seller?._id || entity.seller), destinationPolicy: 'current_user' },
    channels: notice.noticeStatus === 'pending' ? ['inapp', 'push'] : ['inapp', 'push', 'email', 'whatsapp'],
    templates: {
      inapp: { title, body }, push: { title, body },
      email: { subject: title, text: `${body}\nOpen your seller dashboard to review the details.`, html: `<p>${escapeHtml(body)}</p><p>Open your seller dashboard to review the details.</p>` },
      whatsapp: { message: `${title}\n\n${body}` },
    },
    metadata: { category: 'seller', channelId: 'seller', linkTo, whatsappCategory: 'product_blocked',
      data: { type: 'catalog_moderation', catalogKind: kind, audienceRole: 'seller', aggregateId: id, noticeId: notice.noticeId, status: notice.noticeStatus } },
    session,
  });
  await Model.updateOne({ _id: entity._id, 'catalogModeration.noticeId': notice.noticeId, 'catalogModeration.noticeEnqueuedAt': null },
    { $set: { 'catalogModeration.noticeEnqueuedAt': new Date() } }, { ...(session ? { session } : {}), timestamps: false });
  return records;
}

async function recoverCatalogModerationNotifications({ limit = 10 } = {}) {
  const results = [];
  for (const kind of ['product', 'store']) {
    const Model = require(kind === 'store' ? '../models/Store' : '../models/Product');
    const rows = await Model.find({ 'catalogModeration.noticeAt': { $ne: null }, 'catalogModeration.noticeEnqueuedAt': null })
      .select('+catalogModeration').sort({ 'catalogModeration.noticeAt': 1 }).limit(limit).lean();
    for (const row of rows) {
      try { await ensureCatalogModerationNotification(kind, row); results.push({ kind, id: String(row._id), success: true }); }
      catch (error) { results.push({ kind, id: String(row._id), success: false, code: error.code || 'MODERATION_NOTICE_FAILED' }); }
    }
  }
  return results;
}
module.exports = { ensureCatalogModerationNotification, recoverCatalogModerationNotifications };
