const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const VALID_ROLES = new Set(['user', 'seller', 'admin']);
const VALID_INBOX_SURFACES = new Set(['account', 'buyer', 'seller', 'admin']);
const VALID_TARGET_ROLES = new Set(['user', 'seller', 'admin', 'both']);
const VALID_AUDIENCES = new Set(['all_users', 'all_sellers', 'both', 'specific']);
const VALID_CATEGORIES = new Set([
  'announcement',
  'promo',
  'order',
  'payment',
  'system',
  'seller',
  'subscription',
]);
const VALID_SOURCES = new Set(['admin_broadcast', 'system']);
const VALID_ANALYTICS_TYPES = new Set(['critical', 'warning', 'info', 'success']);
const ANALYTICS_CATEGORIES = {
  admin: new Set(['store', 'stock', 'order', 'payment']),
  seller: new Set(['stock', 'order', 'payment']),
};

const isPlainObject = value => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
);

const isCanonicalObjectId = value => typeof value === 'string' && OBJECT_ID_PATTERN.test(value);

const isValidDateString = value => (
  typeof value === 'string'
  && ISO_TIMESTAMP_PATTERN.test(value)
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value
);

const isBoundedString = (value, maxLength, { allowEmpty = false } = {}) => (
  typeof value === 'string'
  && value.length <= maxLength
  && (allowEmpty || value.trim().length > 0)
);

const optionalCanonicalString = (value, maxLength) => (
  value === undefined
  || value === null
  || (typeof value === 'string' && value.length <= maxLength && value.trim() === value)
);

const activeRoleCanReceiveTarget = (role, targetRole) => {
  if (role === 'user') return targetRole === 'user' || targetRole === 'both';
  if (role === 'seller') return targetRole === 'seller' || targetRole === 'both';
  return role === 'admin' && targetRole === 'admin';
};

const audienceCanIncludeRole = (role, audience) => {
  if (role === 'user') return audience === 'all_users' || audience === 'both';
  if (role === 'seller') return audience === 'all_sellers' || audience === 'both';
  return false;
};

const explicitTargetAndAudienceAgree = (targetRole, audience) => {
  if (audience === null || audience === undefined || audience === 'specific') return true;
  if (targetRole === 'user') return audience === 'all_users' || audience === 'both';
  if (targetRole === 'seller') return audience === 'all_sellers' || audience === 'both';
  if (targetRole === 'both') return audience === 'both';
  return false;
};

const containsRoleRoute = (path, role) => {
  if (role === 'seller') return /\/(?:seller-dashboard|seller)(?:[/?#]|$)/i.test(path);
  if (role === 'admin') return /\/admin-dashboard(?:[/?#]|$)/i.test(path);
  if (role === 'user') return /\/user-dashboard(?:[/?#]|$)/i.test(path);
  return false;
};

const normalizeSafeNotificationLink = (value, role) => {
  if (value === '' || value === null || value === undefined) return '';
  if (!isBoundedString(value, 500) || value.trim() !== value) return null;

  let candidate = value;
  if (/^https:\/\//i.test(candidate)) {
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      return null;
    }
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.port
      || !['rozare.com', 'www.rozare.com'].includes(parsed.hostname.toLowerCase())
    ) return null;
    // A genuine pre-relative-link notification is safe to preserve, but keep
    // navigation in the active deployment instead of crossing environments.
    candidate = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }

  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return null;
  if (/\p{Cc}/u.test(candidate)) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return null;
  }
  if (decoded.startsWith('//') || decoded.includes('\\') || /\p{Cc}/u.test(decoded)) return null;
  if (role === 'user' && (containsRoleRoute(decoded, 'seller') || containsRoleRoute(decoded, 'admin'))) return null;
  if (role === 'seller' && (containsRoleRoute(decoded, 'user') || containsRoleRoute(decoded, 'admin'))) return null;
  if (role === 'admin' && (containsRoleRoute(decoded, 'user') || containsRoleRoute(decoded, 'seller'))) return null;
  return candidate;
};

export const isSafeNotificationLink = (value, role) => normalizeSafeNotificationLink(value, role) !== null;

export const resolveNotificationAccount = (user, expectedRole = null) => {
  if (!isPlainObject(user)) return null;
  const id = user.id;
  const underscoreId = user._id;
  if (id !== undefined && !isCanonicalObjectId(id)) return null;
  if (underscoreId !== undefined && !isCanonicalObjectId(underscoreId)) return null;
  const userId = underscoreId || id;
  if (!userId || (id && underscoreId && id !== underscoreId)) return null;
  if (!VALID_ROLES.has(user.role)) return null;
  if (expectedRole !== null && user.role !== expectedRole) return null;
  return Object.freeze({ userId, role: user.role, key: `${user.role}:${userId}` });
};

const accountCanUseSurface = (account, surface) => {
  if (!account || !VALID_INBOX_SURFACES.has(surface)) return false;
  if (surface === 'account') return VALID_ROLES.has(account.role);
  if (surface === 'buyer') return account.role === 'user' || account.role === 'seller';
  if (surface === 'seller') return account.role === 'seller';
  return surface === 'admin' && account.role === 'admin';
};

export const resolveNotificationSurfaceAccount = (user, surface) => {
  const account = resolveNotificationAccount(user);
  return accountCanUseSurface(account, surface) ? account : null;
};

const durableItemMatchesRole = (item, account) => {
  const targetRole = item.targetRole ?? null;
  const audience = item.audience ?? null;

  if (targetRole !== null) {
    if (!VALID_TARGET_ROLES.has(targetRole)) return false;
    if (!activeRoleCanReceiveTarget(account.role, targetRole)) return false;
    if (!explicitTargetAndAudienceAgree(targetRole, audience)) return false;
    if (item.source === 'admin_broadcast' && audience === null) return false;
    return true;
  }

  if (audience !== null && audienceCanIncludeRole(account.role, audience)) return true;
  if (audience !== null && audience !== 'specific') return false;
  if (item.source === 'admin_broadcast') return false;

  if (account.role === 'user') {
    return !['seller', 'subscription'].includes(item.category)
      && !containsRoleRoute(item.linkTo || '', 'seller')
      && !containsRoleRoute(item.linkTo || '', 'admin');
  }
  if (account.role === 'seller') return !containsRoleRoute(item.linkTo || '', 'admin');
  return ['announcement', 'system'].includes(item.category)
    && !containsRoleRoute(item.linkTo || '', 'seller');
};

const classifyDurableSurface = (item, account) => {
  if (item.targetRole === 'user' || item.targetRole === 'both') return 'buyer';
  if (item.targetRole === 'seller') return 'seller';
  if (item.targetRole === 'admin') return 'admin';

  if (item.audience === 'all_users') return 'buyer';
  if (item.audience === 'all_sellers') return 'seller';
  if (item.audience === 'both') return account.role === 'seller' ? 'seller' : 'buyer';
  if (containsRoleRoute(item.linkTo || '', 'user')) return 'buyer';
  if (containsRoleRoute(item.linkTo || '', 'seller')) return 'seller';
  if (containsRoleRoute(item.linkTo || '', 'admin')) return 'admin';
  if (['seller', 'subscription'].includes(item.category)) return 'seller';
  if (account.role === 'user' || account.role === 'seller') return 'buyer';
  if (account.role === 'admin') return 'admin';
  return null;
};

const policyRoleForDurableSurface = (surface, accountRole) => {
  if (surface === 'buyer') return 'user';
  if (surface === 'seller') return 'seller';
  if (surface === 'admin') return 'admin';
  return accountRole;
};

const durableItemMatchesSurface = (item, surface) => surface === 'account' || item._audienceSurface === surface;

const durablePresentationCategory = category => {
  if (category === 'order' || category === 'payment') return category;
  if (category === 'seller') return 'store';
  return 'system';
};

const durablePresentationType = category => {
  if (category === 'promo') return 'success';
  if (category === 'payment') return 'success';
  return 'info';
};

const durablePresentationIcon = category => {
  if (category === 'order' || category === 'payment') return 'order';
  if (category === 'seller') return 'store';
  return 'shield';
};

const inspectDurableItem = (item, account) => {
  const errors = [];
  if (!isPlainObject(item)) return { valid: false, errors: ['Notification is not an object.'], item: null };
  if (!isCanonicalObjectId(item._id)) errors.push('Notification id is invalid.');
  if (!isCanonicalObjectId(item.user) || item.user !== account.userId) errors.push('Notification account does not match.');
  if (!isBoundedString(item.title, 140)) errors.push('Notification title is invalid.');
  if (!isBoundedString(item.body, 1000)) errors.push('Notification body is invalid.');
  if (!VALID_CATEGORIES.has(item.category)) errors.push('Notification category is invalid.');
  if (!VALID_SOURCES.has(item.source)) errors.push('Notification source is invalid.');
  if (item.targetRole !== undefined && item.targetRole !== null && !VALID_TARGET_ROLES.has(item.targetRole)) errors.push('Notification target role is invalid.');
  if (item.audience !== undefined && item.audience !== null && !VALID_AUDIENCES.has(item.audience)) errors.push('Notification audience is invalid.');
  if (typeof item.read !== 'boolean') errors.push('Notification read state is invalid.');
  if (!isValidDateString(item.createdAt) || !isValidDateString(item.updatedAt)) errors.push('Notification timestamps are invalid.');
  if (item.readAt !== undefined && item.readAt !== null && !isValidDateString(item.readAt)) errors.push('Notification read timestamp is invalid.');
  if (!optionalCanonicalString(item.linkTo, 500)) errors.push('Notification link is invalid.');
  if (!optionalCanonicalString(item.eventKey, 300)) errors.push('Notification event key is invalid.');
  if (!optionalCanonicalString(item.eventType, 100)) errors.push('Notification event type is invalid.');
  if (!optionalCanonicalString(item.aggregateType, 80)) errors.push('Notification aggregate type is invalid.');
  if (!optionalCanonicalString(item.aggregateId, 200)) errors.push('Notification aggregate id is invalid.');
  if (item.broadcastJob !== undefined && item.broadcastJob !== null && !isCanonicalObjectId(item.broadcastJob)) errors.push('Notification broadcast id is invalid.');
  if (item.sentBy !== undefined && item.sentBy !== null && !isCanonicalObjectId(item.sentBy)) errors.push('Notification sender id is invalid.');

  if (errors.length === 0 && !durableItemMatchesRole(item, account)) errors.push('Notification audience does not match this account role.');
  const audienceSurface = errors.length === 0 ? classifyDurableSurface(item, account) : null;
  const normalizedLink = errors.length === 0
    ? normalizeSafeNotificationLink(
      item.linkTo,
      policyRoleForDurableSurface(audienceSurface, account.role),
    )
    : null;
  if (errors.length === 0 && normalizedLink === null) errors.push('Notification link is outside its declared audience surface.');
  if (errors.length > 0) return { valid: false, errors, item: null };

  const eventKey = item.eventKey || '';
  const eventType = item.eventType || '';
  const aggregateType = item.aggregateType || '';
  const aggregateId = item.aggregateId || '';
  return {
    valid: true,
    errors: [],
    item: Object.freeze({
      ...item,
      id: `inbox-${item._id}`,
      inboxId: item._id,
      eventKey,
      eventType,
      aggregateType,
      aggregateId,
      type: durablePresentationType(item.category),
      category: durablePresentationCategory(item.category),
      originalCategory: item.category,
      description: item.body,
      time: item.createdAt,
      icon: durablePresentationIcon(item.category),
      linkTo: normalizedLink || undefined,
      _audienceSurface: audienceSurface,
      _stream: 'durable',
    }),
  };
};

export const inspectNotificationInboxResponse = (payload, account, { surface = 'account' } = {}) => {
  const errors = [];
  if (!account || !isCanonicalObjectId(account.userId) || !VALID_ROLES.has(account.role)) {
    return { valid: false, errors: ['Active notification account is invalid.'], items: [], unread: null, unreadComplete: false, accountUnread: null };
  }
  if (!accountCanUseSurface(account, surface)) {
    return { valid: false, errors: ['Notification surface does not match the active account.'], items: [], unread: null, unreadComplete: false, accountUnread: null };
  }
  if (!isPlainObject(payload)) return { valid: false, errors: ['Notification response is invalid.'], items: [], unread: null, unreadComplete: false, accountUnread: null };
  if (!isPlainObject(payload.account)) errors.push('Notification response account is missing.');
  else {
    if (payload.account.userId !== account.userId) errors.push('Notification response belongs to another account.');
    if (payload.account.role !== account.role) errors.push('Notification response belongs to another role.');
    if (surface === 'account' && payload.account.surface !== undefined) errors.push('Notification response has an unexpected surface.');
    if (surface !== 'account' && payload.account.surface !== surface) errors.push('Notification response belongs to another surface.');
  }
  if (!Array.isArray(payload.items) || payload.items.length > 100) errors.push('Notification list is invalid.');
  if (!Number.isSafeInteger(payload.unread) || payload.unread < 0) errors.push('Notification unread count is invalid.');

  const items = [];
  const ids = new Set();
  if (Array.isArray(payload.items) && payload.items.length <= 100) {
    payload.items.forEach((item, index) => {
      const inspected = inspectDurableItem(item, account);
      if (!inspected.valid) errors.push(...inspected.errors.map(error => `Item ${index}: ${error}`));
      else if (ids.has(inspected.item.inboxId)) errors.push(`Item ${index}: Notification id is duplicated.`);
      else {
        ids.add(inspected.item.inboxId);
        items.push(inspected.item);
        if (!durableItemMatchesSurface(inspected.item, surface)) {
          errors.push(`Item ${index}: Notification audience does not match the requested surface.`);
        }
      }
    });
  }
  const listedUnread = items.filter(item => item.read === false).length;
  if (Number.isSafeInteger(payload.unread) && payload.unread < listedUnread) errors.push('Notification unread count contradicts the list.');
  if (errors.length > 0) return { valid: false, errors, items: [], unread: null, unreadComplete: false, accountUnread: null };

  return {
    valid: true,
    errors: [],
    items,
    unread: payload.unread,
    unreadComplete: true,
    accountUnread: payload.unread,
  };
};

export const inspectNotificationReadResponse = (
  payload,
  account,
  expectedInboxId,
  { surface = 'account' } = {},
) => {
  if (!isPlainObject(payload) || !isCanonicalObjectId(expectedInboxId)) {
    return { valid: false, errors: ['Notification read response is invalid.'], item: null };
  }
  if (
    !accountCanUseSurface(account, surface)
    || !isPlainObject(payload.account)
    || payload.account.userId !== account.userId
    || payload.account.role !== account.role
    || (surface === 'account' && payload.account.surface !== undefined)
    || (surface !== 'account' && payload.account.surface !== surface)
  ) {
    return { valid: false, errors: ['Notification read response has the wrong account surface.'], item: null };
  }
  const inspected = inspectDurableItem(payload.notification, account);
  if (!inspected.valid) return inspected;
  if (
    inspected.item.inboxId !== expectedInboxId
    || inspected.item.read !== true
    || !durableItemMatchesSurface(inspected.item, surface)
  ) {
    return { valid: false, errors: ['Notification read response does not match the request.'], item: null };
  }
  return inspected;
};

export const inspectNotificationReadAllResponse = (
  payload,
  account,
  { surface = 'account' } = {},
) => {
  if (
    !isPlainObject(payload)
    || payload.ok !== true
    || !isPlainObject(payload.account)
    || !accountCanUseSurface(account, surface)
    || payload.account.userId !== account.userId
    || payload.account.role !== account.role
    || (surface === 'account' && payload.account.surface !== undefined)
    || (surface !== 'account' && payload.account.surface !== surface)
  ) {
    return { valid: false, errors: ['Notification read-all response is invalid.'] };
  }
  return { valid: true, errors: [] };
};

const analyticsPresentationLink = (item, role) => {
  if (item.linkTo) return item.linkTo;
  if (item.orderId) return `/${role}-dashboard/order/${item.orderId}`;
  if (role === 'admin' && item.category === 'store' && item.id.startsWith('store-verify-')) return '/admin-dashboard/store-verifications';
  return `/${role}-dashboard/product-management`;
};

const inferAnalyticsEventType = item => {
  if (item.category === 'payment' && item.id.startsWith('paid-')) return 'order.paid';
  if (item.category === 'order' && item.id.startsWith('confirmed-')) return 'order.confirmed';
  if (item.category === 'order' && item.id.startsWith('order-')) return 'order.pending';
  if (item.category === 'stock' && item.id.startsWith('stock-')) return 'product.out_of_stock';
  if (item.category === 'stock' && item.id.startsWith('low-')) return 'product.low_stock';
  return '';
};

const inspectAnalyticsItem = (item, role, index) => {
  const errors = [];
  if (!isPlainObject(item)) return { valid: false, errors: [`Item ${index}: Analytics notification is invalid.`], item: null };
  if (!isBoundedString(item.id, 300) || item.id.trim() !== item.id) errors.push(`Item ${index}: Analytics notification id is invalid.`);
  if (!VALID_ANALYTICS_TYPES.has(item.type)) errors.push(`Item ${index}: Analytics notification type is invalid.`);
  if (!ANALYTICS_CATEGORIES[role]?.has(item.category)) errors.push(`Item ${index}: Analytics notification category is invalid.`);
  if (!isBoundedString(item.title, 140)) errors.push(`Item ${index}: Analytics notification title is invalid.`);
  if (item.description !== undefined && item.description !== null && !isBoundedString(item.description, 1000, { allowEmpty: true })) errors.push(`Item ${index}: Analytics notification description is invalid.`);
  if (!isValidDateString(item.time)) errors.push(`Item ${index}: Analytics notification timestamp is invalid.`);
  if (item.read !== false && item.read !== true) errors.push(`Item ${index}: Analytics notification read state is invalid.`);
  if (item.orderId !== undefined && !isCanonicalObjectId(item.orderId)) errors.push(`Item ${index}: Analytics order id is invalid.`);
  if (item.productId !== undefined && !isCanonicalObjectId(item.productId)) errors.push(`Item ${index}: Analytics product id is invalid.`);
  if (item.eventKey !== undefined && !optionalCanonicalString(item.eventKey, 300)) errors.push(`Item ${index}: Analytics event key is invalid.`);

  const rawLink = errors.length === 0 ? analyticsPresentationLink(item, role) : '';
  const linkTo = errors.length === 0 ? normalizeSafeNotificationLink(rawLink, role) : null;
  if (errors.length === 0 && linkTo === null) errors.push(`Item ${index}: Analytics link is outside this account role.`);
  if (errors.length > 0) return { valid: false, errors, item: null };

  const aggregateType = item.orderId ? 'Order' : item.productId ? 'Product' : '';
  const aggregateId = item.orderId || item.productId || '';
  return {
    valid: true,
    errors: [],
    item: Object.freeze({
      ...item,
      description: item.description || '',
      linkTo,
      eventKey: item.eventKey || '',
      eventType: inferAnalyticsEventType(item),
      aggregateType,
      aggregateId,
      _stream: 'analytics',
    }),
  };
};

export const inspectAnalyticsNotificationResponse = (payload, account, expectedRole) => {
  const errors = [];
  if (!account || account.role !== expectedRole || !['admin', 'seller'].includes(expectedRole)) {
    return { valid: false, errors: ['Analytics notification account is invalid.'], items: [] };
  }
  if (!isPlainObject(payload)) return { valid: false, errors: ['Analytics notification response is invalid.'], items: [] };
  if (expectedRole === 'seller') {
    if (payload.sellerId !== account.userId) errors.push('Analytics notification response belongs to another seller.');
    if (payload.audienceRole !== 'seller') errors.push('Analytics notification response has the wrong role.');
  }
  const maxItems = expectedRole === 'seller' ? 20 : 30;
  if (!Array.isArray(payload.notifications) || payload.notifications.length > maxItems) errors.push('Analytics notification list is invalid.');
  const items = [];
  const ids = new Set();
  if (Array.isArray(payload.notifications) && payload.notifications.length <= maxItems) {
    payload.notifications.forEach((item, index) => {
      const inspected = inspectAnalyticsItem(item, expectedRole, index);
      if (!inspected.valid) errors.push(...inspected.errors);
      else if (ids.has(inspected.item.id)) errors.push(`Item ${index}: Analytics notification id is duplicated.`);
      else {
        ids.add(inspected.item.id);
        items.push(inspected.item);
      }
    });
  }
  return errors.length > 0 ? { valid: false, errors, items: [] } : { valid: true, errors: [], items };
};

const notificationExactDedupeKeys = item => {
  const keys = [];
  if (item.inboxId) keys.push(`inbox:${item.inboxId}`);
  if (item.eventKey) keys.push(`event:${item.eventKey}`);
  if (item.id) keys.push(`id:${item.id}`);
  return keys;
};

const notificationEventAggregateKey = item => (
  item.eventType && item.aggregateType && item.aggregateId
    ? `event-aggregate:${item.eventType}:${item.aggregateType}:${item.aggregateId}`
    : ''
);

export const mergeNotificationStreams = ({ durableItems = [], analyticsItems = [] } = {}) => {
  if (!Array.isArray(durableItems) || !Array.isArray(analyticsItems)) return [];
  const merged = [];
  const seen = new Set();
  const durableEventAggregates = new Set();

  // Durable events are authoritative history. Distinct event keys for the
  // same order and event type (for example, each seller-owned fulfillment
  // transition) must all remain visible.
  durableItems.forEach(item => {
    if (!isPlainObject(item) || !isValidDateString(item.time)) return;
    const keys = notificationExactDedupeKeys(item);
    if (keys.some(key => seen.has(key))) return;
    keys.forEach(key => seen.add(key));
    const eventAggregateKey = notificationEventAggregateKey(item);
    if (eventAggregateKey) durableEventAggregates.add(eventAggregateKey);
    merged.push(item);
  });

  // Analytics rows are synthetic fallbacks. Suppress them when a durable
  // event already represents that event type and aggregate, while keeping
  // every distinct durable transition above.
  analyticsItems.forEach(item => {
    if (!isPlainObject(item) || !isValidDateString(item.time)) return;
    const eventAggregateKey = notificationEventAggregateKey(item);
    if (eventAggregateKey && durableEventAggregates.has(eventAggregateKey)) return;
    const keys = notificationExactDedupeKeys(item);
    if (eventAggregateKey) keys.push(eventAggregateKey);
    if (keys.some(key => seen.has(key))) return;
    keys.forEach(key => seen.add(key));
    merged.push(item);
  });
  return merged.sort((left, right) => Date.parse(right.time) - Date.parse(left.time));
};

export const createNotificationRequestGuard = () => {
  let generation = 0;
  let accountKey = null;
  return Object.freeze({
    activate(nextAccountKey) {
      generation += 1;
      accountKey = typeof nextAccountKey === 'string' ? nextAccountKey : null;
      return generation;
    },
    begin(nextAccountKey) {
      generation += 1;
      accountKey = typeof nextAccountKey === 'string' ? nextAccountKey : null;
      return Object.freeze({ generation, accountKey });
    },
    isCurrent(token, currentAccountKey) {
      return isPlainObject(token)
        && token.generation === generation
        && token.accountKey === accountKey
        && token.accountKey === currentAccountKey;
    },
    invalidate() {
      generation += 1;
      accountKey = null;
    },
  });
};
