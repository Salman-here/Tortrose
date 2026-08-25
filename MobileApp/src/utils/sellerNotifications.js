const CATEGORY_ALIASES = {
  order: 'order',
  orders: 'order',
  delivery: 'order',
  payment: 'payment',
  payments: 'payment',
  stock: 'stock',
  inventory: 'stock',
  review: 'review',
  reviews: 'review',
  promotion: 'promotion',
  promotions: 'promotion',
  promo: 'promotion',
  announcement: 'promotion',
  seller: 'store',
  store: 'store',
  subscription: 'payment',
  system: 'system',
};

export const SELLER_NOTIFICATION_CATEGORIES = [
  { key: 'all', label: 'All', icon: 'grid-outline' },
  { key: 'order', label: 'Orders', icon: 'receipt-outline' },
  { key: 'stock', label: 'Stock', icon: 'cube-outline' },
  { key: 'payment', label: 'Payments', icon: 'wallet-outline' },
  { key: 'promotion', label: 'Updates', icon: 'megaphone-outline' },
  { key: 'store', label: 'Store', icon: 'storefront-outline' },
  { key: 'system', label: 'System', icon: 'information-circle-outline' },
];

export function normalizeSellerNotificationCategory(value) {
  if (typeof value !== 'string') return 'system';
  return CATEGORY_ALIASES[value.trim().toLowerCase()] || 'system';
}

function getStableId(source, notification, fallbackParts) {
  const backendId = notification?._id || notification?.id;
  if (backendId) return `${source}:${String(backendId)}`;
  return `${source}:${fallbackParts.map((part) => String(part || '')).join(':')}`;
}

export function normalizeAnalyticsNotification(notification) {
  if (!notification || typeof notification !== 'object') return null;

  // Analytics uses `type` for severity and `category` for the business area.
  const category = normalizeSellerNotificationCategory(notification.category || notification.type);
  const createdAt = notification.time || notification.createdAt || notification.date || null;
  const title = notification.title || notification.message || 'Seller update';
  const body = notification.description || notification.body || notification.message || '';
  const backendId = notification._id || notification.id || null;

  return {
    ...notification,
    id: getStableId('analytics', notification, [category, title, createdAt]),
    backendId: backendId ? String(backendId) : null,
    source: 'analytics',
    persisted: false,
    category,
    severity: notification.type || 'info',
    title,
    body,
    createdAt,
    read: Boolean(notification.read),
    orderId: notification.orderId
      || (String(notification.aggregateType || '').toLowerCase() === 'order' ? notification.aggregateId : null)
      || null,
    productId: notification.productId || null,
    linkTo: notification.linkTo || null,
  };
}

export function normalizePersistentNotification(notification) {
  if (!notification || typeof notification !== 'object') return null;

  const category = normalizeSellerNotificationCategory(notification.category);
  const createdAt = notification.createdAt || notification.time || null;
  const title = notification.title || 'Seller update';
  const body = notification.body || notification.description || notification.message || '';
  const backendId = notification._id || notification.id || null;

  return {
    ...notification,
    id: getStableId('persistent', notification, [category, title, createdAt]),
    backendId: backendId ? String(backendId) : null,
    source: 'persistent',
    persisted: true,
    category,
    severity: notification.type || (category === 'promotion' ? 'info' : 'default'),
    title,
    body,
    createdAt,
    read: Boolean(notification.read),
    orderId: notification.orderId
      || (String(notification.aggregateType || '').toLowerCase() === 'order' ? notification.aggregateId : null)
      || null,
    productId: notification.productId || null,
    linkTo: notification.linkTo || null,
  };
}

export function buildAnalyticsNotificationReadKey(notification) {
  const id = String(notification?.id || '').trim();
  if (!id) return '';
  const rawTime = notification?.createdAt || notification?.time || '';
  const parsedTime = Date.parse(rawTime);
  const timestamp = Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : String(rawTime || 'no-time');
  return `${id}|${timestamp}`;
}

function notificationTimestamp(notification) {
  const timestamp = Date.parse(notification?.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function sortSellerNotifications(notifications = []) {
  return [...notifications].filter(Boolean).sort(
    (left, right) => notificationTimestamp(right) - notificationTimestamp(left),
  );
}

const sellerNotificationResponseError = (message) => {
  const error = new Error(message);
  error.code = 'SELLER_NOTIFICATION_RESPONSE_INVALID';
  return error;
};

const requireResponseIdentity = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 200) {
    throw sellerNotificationResponseError(`${label} is invalid.`);
  }
  return value;
};

const requireNotificationDate = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw sellerNotificationResponseError(`${label} is invalid.`);
  }
  return value;
};

const requireNotificationText = (value, label, max) => {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max) {
    throw sellerNotificationResponseError(`${label} is invalid.`);
  }
  return value;
};

export function parseSellerAnalyticsNotificationsResponse(payload, {
  sellerId,
  analyticsReadKeys = new Set(),
} = {}) {
  const expectedSellerId = requireResponseIdentity(sellerId, 'Seller notification account');
  if (
    !payload
    || typeof payload !== 'object'
    || Array.isArray(payload)
    || payload.sellerId !== expectedSellerId
    || payload.audienceRole !== 'seller'
    || !Array.isArray(payload.notifications)
    || payload.notifications.length > 20
  ) {
    throw sellerNotificationResponseError('Seller analytics notifications do not match this account.');
  }

  return payload.notifications.map((notification) => {
    if (!notification || typeof notification !== 'object' || Array.isArray(notification)) {
      throw sellerNotificationResponseError('A seller analytics notification is malformed.');
    }
    requireResponseIdentity(notification.id, 'Seller analytics notification id');
    requireNotificationText(notification.title, 'Seller analytics notification title', 300);
    if (typeof notification.description !== 'string' || notification.description.length > 1000) {
      throw sellerNotificationResponseError('Seller analytics notification body is invalid.');
    }
    requireNotificationDate(notification.time, 'Seller analytics notification timestamp');
    if (
      typeof notification.read !== 'boolean'
      || !['critical', 'warning', 'info', 'success'].includes(notification.type)
      || !Object.prototype.hasOwnProperty.call(CATEGORY_ALIASES, notification.category)
    ) {
      throw sellerNotificationResponseError('Seller analytics notification metadata is invalid.');
    }
    const normalized = normalizeAnalyticsNotification(notification);
    if (!normalized) throw sellerNotificationResponseError('Seller analytics notification is invalid.');
    return analyticsReadKeys.has(buildAnalyticsNotificationReadKey(normalized))
      ? { ...normalized, read: true }
      : normalized;
  });
}

export function parseSellerInboxNotificationsResponse(payload, { sellerId } = {}) {
  const expectedSellerId = requireResponseIdentity(sellerId, 'Seller inbox account');
  if (
    !payload
    || typeof payload !== 'object'
    || Array.isArray(payload)
    || payload.account?.userId !== expectedSellerId
    || payload.account?.role !== 'seller'
    || payload.account?.surface !== 'seller'
    || !Array.isArray(payload.items)
    || payload.items.length > 100
    || !Number.isSafeInteger(payload.unread)
    || payload.unread < 0
  ) {
    throw sellerNotificationResponseError('Seller inbox notifications do not match this account.');
  }

  const normalized = payload.items.map((notification) => {
    if (!notification || typeof notification !== 'object' || Array.isArray(notification)) {
      throw sellerNotificationResponseError('A seller inbox notification is malformed.');
    }
    requireResponseIdentity(notification._id, 'Seller inbox notification id');
    if (notification.user !== expectedSellerId) {
      throw sellerNotificationResponseError('A seller inbox notification belongs to another account.');
    }
    requireNotificationText(notification.title, 'Seller inbox notification title', 140);
    if (typeof notification.body !== 'string' || notification.body.length > 1000) {
      throw sellerNotificationResponseError('Seller inbox notification body is invalid.');
    }
    requireNotificationDate(notification.createdAt, 'Seller inbox notification timestamp');
    if (
      typeof notification.read !== 'boolean'
      || typeof notification.category !== 'string'
      || (notification.targetRole != null && notification.targetRole !== 'seller')
    ) {
      throw sellerNotificationResponseError('Seller inbox notification metadata is invalid.');
    }
    const normalized = normalizePersistentNotification(notification);
    if (!normalized) throw sellerNotificationResponseError('Seller inbox notification is invalid.');
    return normalized;
  });

  if (normalized.some((notification) => !isSellerBusinessNotification(notification))) {
    throw sellerNotificationResponseError('Seller inbox contains a notification for another audience.');
  }
  return normalized;
}

export function isSellerBusinessNotification(notification) {
  if (!notification || typeof notification !== 'object') return false;
  if (notification.targetRole === 'seller') return true;
  if (notification.targetRole != null) return false;

  // Compatibility for provably seller-scoped legacy rows only. Ambiguous
  // target-less payment/order records are excluded rather than guessed.
  if (['all_sellers', 'both'].includes(notification.audience)) return true;
  if (['seller', 'subscription'].includes(notification.category)) return true;
  return /^\/(?:seller-dashboard|seller)(?:\/|$)/i.test(String(notification.linkTo || ''));
}

export function paidOrderNotificationIdentity(notification) {
  if (!notification) return '';
  const orderId = notification.orderId
    || (String(notification.aggregateType || '').toLowerCase() === 'order'
      ? notification.aggregateId
      : null);
  if (!orderId) return '';

  const eventType = String(
    notification.eventType
    || notification.notificationEventType
    || notification.data?.notificationEventType
    || ''
  ).trim().toLowerCase();
  const sourceId = String(notification.backendId || notification._id || notification.id || '');
  const isPersistentOutboxPaid = notification.persisted === true
    && eventType === 'order.paid'
    && String(notification.aggregateType || '').toLowerCase() === 'order';
  const isAnalyticsPaidFallback = notification.source === 'analytics'
    && notification.category === 'payment'
    && /^paid-/i.test(sourceId);
  return isPersistentOutboxPaid || isAnalyticsPaidFallback
    ? `order.paid:${String(orderId)}`
    : '';
}

export function mergeNormalizedSellerNotifications(analyticsNotifications = [], persistentNotifications = []) {
  const analytics = (Array.isArray(analyticsNotifications) ? analyticsNotifications : []).filter(Boolean);
  const persistent = (Array.isArray(persistentNotifications) ? persistentNotifications : []).filter(Boolean);
  const persistedPaidOrders = new Set(
    persistent.map(paidOrderNotificationIdentity).filter(Boolean),
  );
  const withoutDuplicatePaidFallbacks = analytics.filter((notification) => {
    const identity = paidOrderNotificationIdentity(notification);
    return !identity || !persistedPaidOrders.has(identity);
  });

  const byId = new Map();
  [...withoutDuplicatePaidFallbacks, ...persistent].forEach((notification) => {
    byId.set(notification.id, notification);
  });
  return sortSellerNotifications(Array.from(byId.values()));
}

export function mergeSellerNotifications(analyticsNotifications = [], persistentNotifications = []) {
  const analytics = analyticsNotifications.map(normalizeAnalyticsNotification).filter(Boolean);
  const persistent = persistentNotifications.map(normalizePersistentNotification).filter(Boolean);
  return mergeNormalizedSellerNotifications(analytics, persistent);
}

export function filterSellerNotifications(notifications, category) {
  if (!Array.isArray(notifications)) return [];
  if (!category || category === 'all') return notifications;
  return notifications.filter((notification) => notification.category === category);
}

function decodeLinkComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

function getQueryParam(linkTo, key) {
  if (!linkTo || typeof linkTo !== 'string') return null;
  const query = linkTo.split('?')[1]?.split('#')[0];
  if (!query) return null;

  for (const pair of query.split('&')) {
    const [rawKey, rawValue = ''] = pair.split('=');
    if (decodeLinkComponent(rawKey) === key) return decodeLinkComponent(rawValue.replace(/\+/g, ' '));
  }
  return null;
}

export function resolveSellerNotificationTarget(notification) {
  if (!notification) return null;

  // Defense in depth for callers that bypass the seller inbox parser. A buyer
  // receipt must never be transformed into a seller order/payment destination.
  if (notification.targetRole === 'both' || notification.audienceRole === 'buyer') return null;
  if (notification.persisted === true && !isSellerBusinessNotification(notification)) return null;

  const linkTo = typeof notification.linkTo === 'string' ? notification.linkTo : '';
  if (/^\/user-dashboard(?:[/?#]|$)/i.test(linkTo)) return null;

  if (notification.orderId) {
    return { screen: 'OrderDetailManagement', params: { orderId: notification.orderId } };
  }

  const publicStoreMatch = linkTo.match(/^\/store\/([^/?#]+)/i);
  if (publicStoreMatch) {
    const slug = decodeLinkComponent(publicStoreMatch[1]);
    if (slug) return { screen: 'Store', params: { slug } };
  }
  const orderMatch = linkTo.match(/\/seller-dashboard\/order\/([^/?#]+)/i);
  if (orderMatch) {
    const linkedOrderId = decodeLinkComponent(orderMatch[1]);
    if (linkedOrderId) {
      return {
        screen: 'OrderDetailManagement',
        params: { orderId: linkedOrderId },
      };
    }
  }

  if (linkTo.toLowerCase().includes('/seller-dashboard/order-management')) {
    const linkedOrderId = getQueryParam(linkTo, 'orderId');
    if (linkedOrderId) {
      return {
        screen: 'OrderDetailManagement',
        params: { orderId: linkedOrderId },
      };
    }
  }

  const routeMappings = [
    ['/seller-dashboard/order-management', 'SellerOrderManagement'],
    ['/seller-dashboard/payments', 'SellerPayments'],
    ['/seller-dashboard/product-management', 'SellerProductManagement'],
    ['/seller-dashboard/store-overview', 'SellerStoreOverview'],
    ['/seller-dashboard/store-settings', 'SellerStoreSettings'],
    ['/seller-dashboard/shipping-configuration', 'SellerShippingConfiguration'],
    ['/seller-dashboard/coupons', 'SellerCouponManagement'],
    ['/seller-dashboard/analytics', 'SellerAnalytics'],
    ['/seller-dashboard/subdomain', 'SellerSubdomainManagement'],
    ['/seller-dashboard/subscription', 'SellerSubscription'],
    ['/seller-dashboard/profile', 'SellerProfile'],
    ['/seller-dashboard/whatsapp-settings', 'SellerWhatsAppSettings'],
    ['/seller-dashboard/notification-settings', 'NotificationSettings'],
  ];

  const mapping = routeMappings.find(([path]) => linkTo.toLowerCase().includes(path));
  if (mapping) {
    const params = {};
    const tab = getQueryParam(linkTo, 'tab');
    if (tab) params.tab = tab;
    const returnRequestId = getQueryParam(linkTo, 'returnId');
    if (returnRequestId) params.returnRequestId = returnRequestId;
    return { screen: mapping[1], params };
  }

  if (notification.productId || notification.category === 'stock') {
    return {
      screen: 'SellerProductManagement',
      params: notification.productId ? { productId: notification.productId } : {},
    };
  }
  if (notification.category === 'order') return { screen: 'SellerOrderManagement', params: {} };
  if (notification.category === 'payment') return { screen: 'SellerPayments', params: {} };
  if (notification.category === 'store') return { screen: 'SellerStoreSettings', params: {} };

  return null;
}

export function formatSellerNotificationTime(value, now = Date.now()) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Time unavailable';

  const difference = Math.max(0, now - timestamp);
  const minutes = Math.floor(difference / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(difference / 3600000);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(difference / 86400000);
  if (days < 7) return `${days}d ago`;

  return new Date(timestamp).toLocaleDateString();
}
