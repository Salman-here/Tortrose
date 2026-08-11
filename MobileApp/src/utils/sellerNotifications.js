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
    orderId: notification.orderId || null,
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
    orderId: notification.orderId || null,
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

export function mergeSellerNotifications(analyticsNotifications = [], persistentNotifications = []) {
  const normalized = [
    ...analyticsNotifications.map(normalizeAnalyticsNotification),
    ...persistentNotifications.map(normalizePersistentNotification),
  ].filter(Boolean);

  const byId = new Map();
  normalized.forEach((notification) => byId.set(notification.id, notification));

  return sortSellerNotifications(Array.from(byId.values()));
}

export function filterSellerNotifications(notifications, category) {
  if (!Array.isArray(notifications)) return [];
  if (!category || category === 'all') return notifications;
  return notifications.filter((notification) => notification.category === category);
}

function getQueryParam(linkTo, key) {
  if (!linkTo || typeof linkTo !== 'string') return null;
  const query = linkTo.split('?')[1]?.split('#')[0];
  if (!query) return null;

  for (const pair of query.split('&')) {
    const [rawKey, rawValue = ''] = pair.split('=');
    if (decodeURIComponent(rawKey) === key) return decodeURIComponent(rawValue.replace(/\+/g, ' '));
  }
  return null;
}

export function resolveSellerNotificationTarget(notification) {
  if (!notification) return null;

  if (notification.orderId) {
    return { screen: 'OrderDetailManagement', params: { orderId: notification.orderId } };
  }

  const linkTo = typeof notification.linkTo === 'string' ? notification.linkTo : '';
  const orderMatch = linkTo.match(/\/seller-dashboard\/order\/([^/?#]+)/i);
  if (orderMatch) {
    return {
      screen: 'OrderDetailManagement',
      params: { orderId: decodeURIComponent(orderMatch[1]) },
    };
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
