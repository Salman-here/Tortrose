const SELLER_TYPES = new Set([
  'new_order_received',
  'order_confirmed_by_buyer',
  'order_cancelled_by_buyer',
  'return_requested',
  'low_stock',
  'new_review',
  'product_blocked',
  'seller_account_created',
  'store_created',
  'store_verified',
  'store_verification_approved',
  'store_verification_rejected',
  'store_verification_removed',
  'payout_account_updated',
  'subscription_expiring',
  'payout_received',
  'paid_order_received',
  'no_charge_order_received',
  'cod_order_received',
  'cod_order_confirmed',
  'cod_order_reconfirmed',
  'cod_order_cancelled',
  'withdrawal_requested',
  'withdrawal_status_changed',
  'subscription_payment_received',
  'subscription_payment_recovered',
  'subscription_activated',
  'subscription_cancelled',
]);

const BUYER_TYPES = new Set([
  'order_placed',
  'order_confirmed',
  'order_processing',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
  'price_drop',
  'back_in_stock',
  'wishlist_sale',
  'coupon_available',
  'cart_reminder',
  'return_status_update',
  'order_paid',
  'order_no_charge_confirmed',
  'order_confirmation_requested',
  'return_settled',
  'wallet_transaction_completed',
]);

const CATEGORY_OPTIONS = {
  user: [
    { key: 'all', label: 'All', icon: 'apps-outline' },
    { key: 'order', label: 'Orders', icon: 'receipt-outline' },
    { key: 'delivery', label: 'Delivery', icon: 'bicycle-outline' },
    { key: 'promo', label: 'Promos', icon: 'pricetag-outline' },
    { key: 'payment', label: 'Payments', icon: 'wallet-outline' },
    { key: 'system', label: 'System', icon: 'information-circle-outline' },
  ],
  seller: [
    { key: 'all', label: 'All', icon: 'apps-outline' },
    { key: 'order', label: 'Orders', icon: 'receipt-outline' },
    { key: 'delivery', label: 'Delivery', icon: 'bicycle-outline' },
    { key: 'promo', label: 'Promos', icon: 'pricetag-outline' },
    { key: 'payment', label: 'Payments', icon: 'wallet-outline' },
    { key: 'seller', label: 'Seller', icon: 'storefront-outline' },
    { key: 'system', label: 'System', icon: 'information-circle-outline' },
  ],
  admin: [
    { key: 'all', label: 'All', icon: 'apps-outline' },
    { key: 'payment', label: 'Payments', icon: 'wallet-outline' },
    { key: 'system', label: 'System', icon: 'information-circle-outline' },
  ],
};

export function normalizeNotificationRole(value) {
  const role = String(value?.role || value || '').trim().toLowerCase();
  return ['user', 'seller', 'admin'].includes(role) ? role : 'guest';
}

export function getNotificationIdentity(user) {
  const role = normalizeNotificationRole(user);
  const id = user?._id || user?.id;
  return id ? `${role}:${String(id)}` : `${role}:anonymous`;
}

export function getNotificationStorageKeys(user) {
  const identity = getNotificationIdentity(user);
  return {
    inbox: `notification_inbox:v2:${identity}`,
    read: `notifications_read_ids:v2:${identity}`,
  };
}

function normalizeAudience(value) {
  const raw = typeof value === 'object' && value !== null ? value.target : value;
  const audience = String(raw || '').trim().toLowerCase();
  if (['seller', 'sellers', 'all_sellers'].includes(audience)) return ['seller'];
  if (['user', 'users', 'buyer', 'buyers', 'all_users'].includes(audience)) return ['user'];
  if (['admin', 'admins', 'all_admins'].includes(audience)) return ['admin'];
  if (['both', 'all', 'user_and_seller'].includes(audience)) return ['user', 'seller'];
  return null;
}

function normalizeRecipientAudienceRole(value) {
  const audienceRole = String(value || '').trim().toLowerCase();
  // A seller can shop as a buyer, matching the backend recipient authority
  // rule. Seller/admin audiences remain private to their current role.
  if (audienceRole === 'buyer') return ['user', 'seller'];
  if (audienceRole === 'seller') return ['seller'];
  if (audienceRole === 'admin') return ['admin'];
  return null;
}

export function inferNotificationRoles(notification = {}) {
  const data = notification?.data || {};
  // Server-issued audience metadata is authoritative. Evaluate it before
  // legacy type/category heuristics so a stale or malformed category can
  // never widen a seller-only notification into the buyer inbox.
  const recipientAudience = [
    data.audienceRole,
    notification.audienceRole,
  ].map(normalizeRecipientAudienceRole).find(Boolean);
  if (recipientAudience) return recipientAudience;

  const explicit = [
    data.targetRole,
    data.recipientRole,
    data.audience,
    notification.targetRole,
    notification.recipientRole,
    notification.audience,
  ].map(normalizeAudience).find(Boolean);
  if (explicit) return explicit;

  const type = String(data.type || notification.type || '').toLowerCase();
  // Older broadcast pushes did not carry a recipient role. There is no safe
  // way to infer whether they targeted buyers or sellers after an account
  // switch, so ambiguous legacy broadcasts are intentionally suppressed.
  if (type === 'admin_broadcast') return [];
  if (SELLER_TYPES.has(type)) return ['seller'];
  if (BUYER_TYPES.has(type)) return ['user', 'seller'];

  const category = String(data.category || notification.category || '').toLowerCase();
  if (category === 'seller' || category === 'subscription') return ['seller'];

  const linkTo = String(notification.linkTo || data.linkTo || '');
  if (/\/(?:seller-dashboard|seller)(?:\/|$)/i.test(linkTo)) return ['seller'];
  if (/\/admin-dashboard(?:\/|$)/i.test(linkTo)) return ['admin'];

  if (category === 'promo' || category === 'delivery') return ['user', 'seller'];

  return null;
}

export function isNotificationAllowedForRole(notification, roleOrUser) {
  const role = normalizeNotificationRole(roleOrUser);
  if (role === 'guest') return false;

  if (typeof roleOrUser === 'object' && roleOrUser !== null && notification?.accountScope) {
    if (notification.accountScope !== getNotificationIdentity(roleOrUser)) return false;
  }

  if (typeof roleOrUser === 'object' && roleOrUser !== null) {
    const data = notification?.data || {};
    const intendedUserId = data.recipientUserId || data.recipientId || notification?.recipientUserId;
    const activeUserId = roleOrUser?._id || roleOrUser?.id;
    if (intendedUserId && activeUserId && String(intendedUserId) !== String(activeUserId)) return false;
  }

  const intendedRoles = inferNotificationRoles(notification);
  if (intendedRoles) return intendedRoles.includes(role);

  const data = notification?.data || {};
  const category = String(data.category || notification?.category || 'system').toLowerCase();
  if (role === 'admin') return ['system', 'announcement', 'admin'].includes(category);
  if (role === 'seller') return category !== 'admin';
  return !['seller', 'subscription', 'admin'].includes(category);
}

export function displayNotificationCategory(notification, roleOrUser) {
  const role = normalizeNotificationRole(roleOrUser);
  const data = notification?.data || {};
  const category = String(data.category || notification?.category || 'system').toLowerCase();
  const intendedRoles = inferNotificationRoles(notification);

  const sellerOnly = intendedRoles?.includes('seller') && !intendedRoles.includes('user');
  if (category === 'payment' || category === 'payments') return 'payment';
  if (role === 'seller' && (sellerOnly || ['seller', 'subscription'].includes(category))) {
    return 'seller';
  }
  if (role === 'admin') return 'system';
  if (role === 'user' && ['seller', 'subscription', 'admin'].includes(category)) return 'system';
  if (category === 'alert') return 'order';
  if (['order', 'delivery', 'promo', 'seller', 'system', 'payment'].includes(category)) return category;
  return 'system';
}

export function scopeNotificationsForRole(notifications, roleOrUser) {
  return (Array.isArray(notifications) ? notifications : [])
    .filter((notification) => isNotificationAllowedForRole(notification, roleOrUser))
    .map((notification) => ({
      ...notification,
      category: displayNotificationCategory(notification, roleOrUser),
    }));
}

export function getNotificationCategoriesForRole(roleOrUser) {
  const role = normalizeNotificationRole(roleOrUser);
  return CATEGORY_OPTIONS[role] || CATEGORY_OPTIONS.user;
}

export { BUYER_TYPES, SELLER_TYPES };
