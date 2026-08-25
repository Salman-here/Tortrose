import {
  getNotificationInboxItemId,
  getPersistentNotificationInboxId,
  normalizeNotificationEventKey,
} from './notificationDedupe';
import {
  isNotificationAllowedForRole,
  normalizeNotificationRole,
  scopeNotificationsForRole,
} from './notificationScope';

const NOTIFICATION_CATEGORIES = new Set([
  'announcement',
  'promo',
  'order',
  'payment',
  'system',
  'seller',
  'subscription',
]);
const NOTIFICATION_SOURCES = new Set(['admin_broadcast', 'system']);
const TARGET_ROLES = new Set(['user', 'seller', 'admin', 'both']);
const AUDIENCES = new Set(['all_users', 'all_sellers', 'both', 'specific']);
const SELLER_LINK_PATTERN = /^\/(?:seller-dashboard|seller)(?:\/|$)/i;
const ADMIN_LINK_PATTERN = /\/admin-dashboard(?:\/|$)/i;

function inboxContractError(message) {
  const error = new Error(message);
  error.code = 'NOTIFICATION_INBOX_RESPONSE_INVALID';
  return error;
}

function requireAccount(currentUser) {
  const role = normalizeNotificationRole(currentUser);
  const rawId = currentUser?._id || currentUser?.id;
  if (
    role === 'guest'
    || typeof rawId !== 'string'
    || !rawId
    || rawId !== rawId.trim()
    || rawId.length > 200
  ) {
    throw inboxContractError('Notification inbox account is invalid.');
  }
  return { role, userId: rawId };
}

function requireAccountEnvelope(account, { currentUser, expectedSurface = null } = {}) {
  const { role, userId } = requireAccount(currentUser);
  if (expectedSurface !== null && expectedSurface !== 'seller') {
    throw inboxContractError('Notification response surface is invalid.');
  }
  const expectedKeys = expectedSurface
    ? ['role', 'surface', 'userId']
    : ['role', 'userId'];
  if (
    !account
    || typeof account !== 'object'
    || Array.isArray(account)
    || account.userId !== userId
    || account.role !== role
    || (expectedSurface
      ? account.surface !== expectedSurface
      : Object.prototype.hasOwnProperty.call(account, 'surface'))
    || Object.keys(account).sort().join('|') !== expectedKeys.join('|')
  ) {
    throw inboxContractError('Notification response does not match this account and surface.');
  }
  return { role, userId, ...(expectedSurface ? { surface: expectedSurface } : {}) };
}

function notificationMatchesSellerSurface(notification) {
  if (notification.targetRole === 'seller') return true;
  if (notification.targetRole != null) return false;
  if (['all_sellers', 'both'].includes(notification.audience)) return true;

  const linkTo = String(notification.linkTo || '');
  const legacyAudience = notification.audience == null || notification.audience === 'specific';
  const sellerIntent = ['seller', 'subscription'].includes(notification.category)
    || SELLER_LINK_PATTERN.test(linkTo);
  return legacyAudience
    && notification.source !== 'admin_broadcast'
    && !ADMIN_LINK_PATTERN.test(linkTo)
    && sellerIntent;
}

function requireExactString(value, label, { max, allowEmpty = false } = {}) {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || (!allowEmpty && !value)
    || (Number.isSafeInteger(max) && value.length > max)
  ) {
    throw inboxContractError(`${label} is invalid.`);
  }
  return value;
}

function requireOptionalExactString(value, label, max) {
  if (value == null) return null;
  return requireExactString(value, label, { max, allowEmpty: true });
}

function requireDate(value, label) {
  requireExactString(value, label, { max: 100 });
  if (!Number.isFinite(Date.parse(value))) throw inboxContractError(`${label} is invalid.`);
  return value;
}

export function inspectPersistentInboxNotification(notification, { currentUser } = {}) {
  const { userId } = requireAccount(currentUser);
  if (!notification || typeof notification !== 'object' || Array.isArray(notification)) {
    throw inboxContractError('A persistent notification is malformed.');
  }

  const notificationId = requireExactString(notification._id, 'Notification id', { max: 200 });
  if (String(notification.user || '') !== userId) {
    throw inboxContractError('A persistent notification belongs to another account.');
  }
  requireExactString(notification.title, 'Notification title', { max: 140 });
  requireExactString(notification.body, 'Notification body', { max: 1000, allowEmpty: true });
  requireDate(notification.createdAt, 'Notification timestamp');

  if (typeof notification.read !== 'boolean') {
    throw inboxContractError('Notification read state is invalid.');
  }
  if (!NOTIFICATION_CATEGORIES.has(notification.category)) {
    throw inboxContractError('Notification category is invalid.');
  }
  if (!NOTIFICATION_SOURCES.has(notification.source)) {
    throw inboxContractError('Notification source is invalid.');
  }
  if (notification.targetRole != null && !TARGET_ROLES.has(notification.targetRole)) {
    throw inboxContractError('Notification target role is invalid.');
  }
  if (notification.audience != null && !AUDIENCES.has(notification.audience)) {
    throw inboxContractError('Notification audience is invalid.');
  }

  requireOptionalExactString(notification.linkTo, 'Notification link', 2048);
  const eventKey = requireOptionalExactString(notification.eventKey, 'Notification event key', 300);
  if (eventKey && normalizeNotificationEventKey(eventKey) !== eventKey) {
    throw inboxContractError('Notification event key is invalid.');
  }
  requireOptionalExactString(notification.eventType, 'Notification event type', 100);
  requireOptionalExactString(notification.aggregateType, 'Notification aggregate type', 80);
  requireOptionalExactString(notification.aggregateId, 'Notification aggregate id', 200);

  if (!isNotificationAllowedForRole(notification, currentUser)) {
    throw inboxContractError('Notification audience does not match this account.');
  }
  if (!getPersistentNotificationInboxId(notification)) {
    throw inboxContractError('Notification has no stable identity.');
  }

  return { ...notification, _id: notificationId, user: userId };
}

export function parseNotificationInboxResponse(payload, { currentUser } = {}) {
  const { role, userId } = requireAccount(currentUser);
  if (
    !payload
    || typeof payload !== 'object'
    || Array.isArray(payload)
    || !payload.account
    || payload.account.userId !== userId
    || payload.account.role !== role
    || Object.prototype.hasOwnProperty.call(payload.account, 'surface')
    || !Array.isArray(payload.items)
    || payload.items.length > 100
    || !Number.isSafeInteger(payload.unread)
    || payload.unread < 0
  ) {
    throw inboxContractError('Notification inbox does not match this account.');
  }

  return {
    account: { userId, role },
    items: payload.items.map((notification) => (
      inspectPersistentInboxNotification(notification, { currentUser })
    )),
    unread: payload.unread,
  };
}

export function parseNotificationReadResponse(payload, {
  currentUser,
  notificationId,
  expectedSurface = null,
} = {}) {
  const expectedId = requireExactString(notificationId, 'Expected notification id', { max: 200 });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw inboxContractError('Notification read response is malformed.');
  }
  requireAccountEnvelope(payload.account, { currentUser, expectedSurface });
  const notification = inspectPersistentInboxNotification(payload.notification, { currentUser });
  if (notification._id !== expectedId || notification.read !== true) {
    throw inboxContractError('Notification read response did not confirm the requested row.');
  }
  if (expectedSurface === 'seller' && !notificationMatchesSellerSurface(notification)) {
    throw inboxContractError('Notification read response is outside the seller surface.');
  }
  return notification;
}

export function parseNotificationReadAllResponse(payload, {
  currentUser,
  expectedSurface = null,
} = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.ok !== true) {
    throw inboxContractError('Notification read-all response is invalid.');
  }
  requireAccountEnvelope(payload.account, { currentUser, expectedSurface });
  return true;
}

export function parseStoredNotificationReadIds(value) {
  if (value == null || value === '') return new Set();
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.length > 10000) {
    throw inboxContractError('Stored notification read state is invalid.');
  }
  const ids = parsed.map((id) => requireExactString(id, 'Stored notification id', { max: 500 }));
  return new Set(ids);
}

export function reconcileNotificationUnreadCount({
  snapshot,
  cachedNotifications,
  readIds,
  currentUser,
} = {}) {
  if (!snapshot || !Number.isSafeInteger(snapshot.unread) || snapshot.unread < 0) {
    throw inboxContractError('Authoritative notification unread count is invalid.');
  }
  const persistentIds = new Set(snapshot.items.map(getPersistentNotificationInboxId));
  const localReadIds = readIds instanceof Set ? readIds : new Set();
  const seenLocalIds = new Set();
  let localOnlyUnread = 0;

  scopeNotificationsForRole(cachedNotifications, currentUser).forEach((notification) => {
    const id = getNotificationInboxItemId(notification);
    if (
      !id
      || seenLocalIds.has(id)
      || persistentIds.has(id)
      || localReadIds.has(id)
      || notification.read === true
    ) return;
    seenLocalIds.add(id);
    localOnlyUnread += 1;
  });

  const total = snapshot.unread + localOnlyUnread;
  if (!Number.isSafeInteger(total)) {
    throw inboxContractError('Reconciled notification unread count is unsafe.');
  }
  return total;
}

export function persistentInboxIds(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items)) return new Set();
  return new Set(snapshot.items.map(getPersistentNotificationInboxId).filter(Boolean));
}

export { inboxContractError };
