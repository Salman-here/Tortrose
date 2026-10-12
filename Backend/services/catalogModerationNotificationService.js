'use strict';
const { enqueueNotificationEvent } = require('./notificationOutboxService');
const { escapeHtml } = require('../utils/orderPresentation');

const MODERATION_NOTICE_REASONS = Object.freeze({
  profanity: 'Remove offensive or profane wording.',
  sexual_goods: 'Products intended for sexual activity are not permitted on Rozare.',
  explicit_sexual_content: 'Remove explicit sexual content.',
  hate_or_threats: 'Remove hateful or threatening content.',
  insufficient_details: 'Add clear, complete information about your listing.',
  image_invalid: 'Use a publicly accessible HTTPS image for your listing.',
  content_limit: 'Shorten excessive text or options and use no more than 12 images.',
});

const moderationNoticeReason = notice => {
  const violations = Array.isArray(notice?.violations) ? notice.violations : [];
  const reasons = [...new Set(violations.map(violation => Object.hasOwn(MODERATION_NOTICE_REASONS, violation?.code)
    ? MODERATION_NOTICE_REASONS[violation.code] : '').filter(Boolean))];
  return reasons.length ? reasons.join(' ') : 'The submitted content does not meet Rozare\'s content guidelines.';
};

async function ensureCatalogModerationNotification(kind, entity, { session = null } = {}) {
  const Model = require(kind === 'store' ? '../models/Store' : '../models/Product');
  if (entity?._id && !entity.catalogModeration) entity = await Model.findById(entity._id).select('seller +catalogModeration').lean();
  const notice = entity?.catalogModeration;
  if (!entity?.seller || !notice?.noticeId || !notice.noticeAt || notice.noticeEnqueuedAt) return [];
  const label = kind === 'store' ? 'Store' : 'Product';
  const title = `${label} ${notice.noticeStatus === 'approved' ? 'content approved' : notice.noticeStatus === 'blocked' ? 'needs changes' : 'review in progress'}`;
  // Do not repeat a rejected title/name (or an offensive image caption) in
  // email subjects, notification banners or WhatsApp messages.
  const body = notice.noticeStatus === 'approved'
    ? `Your ${kind} content has been approved. View its publishing status in your seller dashboard.`
    : notice.noticeStatus === 'blocked'
      ? `Your ${kind} is hidden from customers. ${moderationNoticeReason(notice)} Review the details in your seller dashboard and update the affected content to have it checked again.`
      : `Your ${kind} remains hidden while the checks are completed. No action is needed unless we ask for an update.`;
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
      email: { subject: title, text: body, html: `<p>${escapeHtml(body)}</p>` },
      whatsapp: { message: `*${title}*\n\n${body}` },
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
