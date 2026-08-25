const EVENT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,299}$/;
const CHANNEL_DEDUPE_PATTERN = /^[a-f0-9]{64}$/;

export function normalizeNotificationEventKey(value) {
  if (typeof value !== 'string' || value !== value.trim() || !EVENT_KEY_PATTERN.test(value)) return '';
  return value;
}

export function normalizeNotificationChannelDedupeKey(value) {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || !CHANNEL_DEDUPE_PATTERN.test(value)
  ) return '';
  return value;
}

export function getPushNotificationInboxId(notification, fallbackId = '') {
  const data = notification?.request?.content?.data || {};
  const eventKey = normalizeNotificationEventKey(data.notificationEventKey);
  if (eventKey) return `event:${eventKey}`;
  const channelKey = normalizeNotificationChannelDedupeKey(data.notificationDedupeKey);
  if (channelKey) return `outbox:${channelKey}`;
  return notification?.request?.identifier || fallbackId;
}

export function getPersistentNotificationInboxId(notification) {
  const eventKey = normalizeNotificationEventKey(notification?.eventKey);
  if (eventKey) return `event:${eventKey}`;
  return notification?._id ? `broadcast_${notification._id}` : '';
}

/**
 * Resolve the canonical identity of an already-normalized inbox item.
 *
 * Older cached pushes can still carry a provider-generated `id` even when the
 * durable event key is present in `data`. Prefer the event/channel identity so
 * those rows collapse with the persistent in-app copy after an app upgrade.
 */
export function getNotificationInboxItemId(notification) {
  if (!notification || typeof notification !== 'object' || Array.isArray(notification)) return '';
  const data = notification.data && typeof notification.data === 'object'
    ? notification.data
    : {};
  const eventKey = normalizeNotificationEventKey(
    data.notificationEventKey || notification.eventKey
  );
  if (eventKey) return `event:${eventKey}`;
  const channelKey = normalizeNotificationChannelDedupeKey(
    data.notificationDedupeKey || notification.notificationDedupeKey
  );
  if (channelKey) return `outbox:${channelKey}`;

  const id = notification.id;
  if (typeof id !== 'string' || !id || id !== id.trim() || id.length > 500) return '';
  return id;
}

export function dedupeInboxNotifications(notifications, { max = 200 } = {}) {
  const boundedMax = Number.isSafeInteger(max) && max >= 0 ? max : 200;
  const seen = new Set();
  const deduped = [];
  (Array.isArray(notifications) ? notifications : []).forEach((notification) => {
    const id = getNotificationInboxItemId(notification);
    if (!id || seen.has(id) || deduped.length >= boundedMax) return;
    seen.add(id);
    deduped.push(notification.id === id ? notification : { ...notification, id });
  });
  return deduped;
}

/** Preserve the existing canonical row (normally the durable in-app copy). */
export function mergeInboxNotification(notifications, incoming, { max = 200 } = {}) {
  const existing = dedupeInboxNotifications(notifications, { max });
  const normalizedIncoming = dedupeInboxNotifications([incoming], { max: 1 })[0];
  if (!normalizedIncoming) return existing;
  if (existing.some((notification) => notification.id === normalizedIncoming.id)) return existing;
  return [normalizedIncoming, ...existing].slice(0, max);
}
