/**
 * Pure notification classification and native deep-link routing.
 *
 * Server-provided category/link metadata is preferred, but typed fallbacks keep
 * older queued pushes useful. Only known application-relative paths are mapped;
 * a web URL or a route for another account role is deliberately ignored.
 */

const CATEGORY_ALIASES = Object.freeze({
  alert: 'order',
  announcement: 'system',
  delivery: 'delivery',
  order: 'order',
  orders: 'order',
  payment: 'payment',
  payments: 'payment',
  promo: 'promo',
  promotion: 'promo',
  promotions: 'promo',
  seller: 'seller',
  subscription: 'subscription',
  system: 'system',
  wallet: 'payment',
});

export const SELLER_ORDER_NOTIFICATION_TYPES = new Set([
  'new_order_received',
  'order_confirmed_by_buyer',
  'order_cancelled_by_buyer',
  'paid_order_received',
  'no_charge_order_received',
  'cod_order_received',
  'cod_order_confirmed',
  'cod_order_reconfirmed',
  'cod_order_cancelled',
]);

export const SHOPPER_ORDER_NOTIFICATION_TYPES = new Set([
  'order_placed',
  'order_confirmed',
  'order_processing',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
  'order_paid',
  'order_no_charge_confirmed',
  'order_confirmation_requested',
  'return_status_update',
]);

export const SELLER_PAYMENT_NOTIFICATION_TYPES = new Set([
  'payout_account_updated',
  'payout_received',
  'withdrawal_requested',
  'withdrawal_status_changed',
]);

export const SELLER_SUBSCRIPTION_NOTIFICATION_TYPES = new Set([
  'subscription_expiring',
  'subscription_payment_received',
  'subscription_payment_recovered',
  'subscription_activated',
  'subscription_cancelled',
]);

const SELLER_OPERATION_NOTIFICATION_TYPES = new Set([
  ...SELLER_ORDER_NOTIFICATION_TYPES,
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
]);

const DELIVERY_NOTIFICATION_TYPES = new Set(['order_shipped', 'order_delivered']);
const PROMO_NOTIFICATION_TYPES = new Set([
  'price_drop',
  'back_in_stock',
  'wishlist_sale',
  'coupon_available',
  'cart_reminder',
]);

function normalizeType(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizedRole(value) {
  const role = String(value?.role || value || '').trim().toLowerCase();
  return ['user', 'seller', 'admin'].includes(role) ? role : 'guest';
}

function decodePathPart(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

function safeRelativeLink(value) {
  if (typeof value !== 'string') return '';
  const link = value.trim();
  return link.startsWith('/') && !link.startsWith('//') ? link : '';
}

function queryParam(link, key) {
  const query = link.split('?')[1]?.split('#')[0];
  if (!query) return '';
  for (const pair of query.split('&')) {
    const [rawKey, rawValue = ''] = pair.split('=');
    if (decodePathPart(rawKey) === key) {
      return decodePathPart(rawValue.replace(/\+/g, ' '));
    }
  }
  return '';
}

function notificationData(notification = {}) {
  const nested = notification?.data && typeof notification.data === 'object'
    ? notification.data
    : {};
  return { ...notification, ...nested };
}

function detailTarget(orderId, extraParams = {}) {
  if (!orderId) return { screen: 'Orders', params: {} };
  return { screen: 'OrderDetail', params: { orderId: String(orderId), ...extraParams } };
}

function sellerOrderTarget(orderId) {
  if (!orderId) return { screen: 'SellerOrderManagement', params: { isAdmin: false } };
  return {
    screen: 'OrderDetailManagement',
    params: { orderId: String(orderId), isAdmin: false },
  };
}

/** Map a server category or event type to an inbox category. */
export function inferNotificationCategory(type, explicitCategory) {
  const category = normalizeType(explicitCategory);
  if (CATEGORY_ALIASES[category]) return CATEGORY_ALIASES[category];

  const normalizedType = normalizeType(type);
  if (!normalizedType) return 'system';
  if (DELIVERY_NOTIFICATION_TYPES.has(normalizedType)) return 'delivery';
  if (SELLER_PAYMENT_NOTIFICATION_TYPES.has(normalizedType)
      || normalizedType === 'wallet_transaction_completed') return 'payment';
  if (SELLER_SUBSCRIPTION_NOTIFICATION_TYPES.has(normalizedType)) return 'subscription';
  if (SELLER_OPERATION_NOTIFICATION_TYPES.has(normalizedType)) return 'seller';
  if (normalizedType === 'return_settled'
      || SHOPPER_ORDER_NOTIFICATION_TYPES.has(normalizedType)
      || normalizedType.startsWith('order_')) return 'order';
  if (PROMO_NOTIFICATION_TYPES.has(normalizedType)) return 'promo';
  return 'system';
}

/**
 * Resolve a push/inbox payload to a registered native screen.
 * Returns null when no safe native destination exists; callers may then open
 * the inbox without guessing at an arbitrary web route.
 */
export function resolveNotificationTarget(notification, roleOrUser) {
  const data = notificationData(notification);
  const role = normalizedRole(roleOrUser);
  if (role === 'guest') return null;

  const type = normalizeType(data.type);
  const linkTo = safeRelativeLink(data.linkTo);
  const orderId = data.orderObjectId || data.orderId || '';
  const returnRequestId = data.returnRequestId || data.returnId || '';
  const transactionId = data.transactionId || '';

  if (linkTo) {
    const confirmationMatch = linkTo.match(/^\/orders\/confirm\/([^/?#]+)/i);
    if (confirmationMatch && (role === 'user' || role === 'seller')) {
      const token = decodePathPart(confirmationMatch[1]);
      if (token) return { screen: 'OrderConfirmation', params: { token } };
    }

    const buyerOrderMatch = linkTo.match(/^\/user-dashboard\/order\/detail\/([^/?#]+)/i);
    if (buyerOrderMatch && (role === 'user' || role === 'seller')) {
      const linkedOrderId = decodePathPart(buyerOrderMatch[1]);
      if (linkedOrderId) {
        const linkedReturnId = queryParam(linkTo, 'returnId');
        return detailTarget(linkedOrderId, linkedReturnId ? { returnId: linkedReturnId } : {});
      }
    }

    if (/^\/user-dashboard\/wallet(?:[/?#]|$)/i.test(linkTo)
        && ['user', 'seller', 'admin'].includes(role)) {
      return { screen: 'Wallet', params: transactionId ? { transactionId } : {} };
    }

    const publicStoreMatch = linkTo.match(/^\/store\/([^/?#]+)/i);
    if (publicStoreMatch && (role === 'user' || role === 'seller')) {
      if (normalizeType(data.audienceRole) === 'seller' && role !== 'seller') return null;
      const slug = decodePathPart(publicStoreMatch[1]);
      if (slug) return { screen: 'Store', params: { slug } };
    }

    if (role === 'seller') {
      const sellerOrderMatch = linkTo.match(/^\/(?:seller-dashboard\/order|seller\/orders)\/([^/?#]+)/i);
      if (sellerOrderMatch) {
        const linkedOrderId = decodePathPart(sellerOrderMatch[1]);
        if (linkedOrderId) return sellerOrderTarget(linkedOrderId);
      }

      if (/^\/seller-dashboard\/order-management(?:[/?#]|$)/i.test(linkTo)) {
        const linkedOrderId = queryParam(linkTo, 'orderId');
        if (linkedOrderId) return sellerOrderTarget(linkedOrderId);
        const tab = queryParam(linkTo, 'tab');
        const linkedReturnId = queryParam(linkTo, 'returnId') || returnRequestId;
        return {
          screen: 'SellerOrderManagement',
          params: {
            isAdmin: false,
            ...(tab ? { tab } : {}),
            ...(linkedReturnId ? { returnRequestId: linkedReturnId } : {}),
          },
        };
      }

      const sellerMappings = [
        ['/seller-dashboard/payments', 'SellerPayments'],
        ['/seller-dashboard/subscription', 'SellerSubscription'],
        ['/seller-dashboard/product-management', 'SellerProductManagement'],
        ['/seller-dashboard/store-overview', 'SellerStoreOverview'],
        ['/seller-dashboard/store-settings', 'SellerStoreSettings'],
        ['/seller-dashboard/shipping-configuration', 'SellerShippingConfiguration'],
        ['/seller-dashboard/coupons', 'SellerCouponManagement'],
        ['/seller-dashboard/analytics', 'SellerAnalytics'],
        ['/seller-dashboard/subdomain', 'SellerSubdomainManagement'],
        ['/seller-dashboard/profile', 'SellerProfile'],
        ['/seller-dashboard/whatsapp-settings', 'SellerWhatsAppSettings'],
        ['/seller-dashboard/notification-settings', 'NotificationSettings'],
      ];
      const mapping = sellerMappings.find(([path]) => (
        linkTo.toLowerCase() === path || linkTo.toLowerCase().startsWith(`${path}?`)
      ));
      if (mapping) return { screen: mapping[1], params: {} };
    }

    // There is no native admin payments surface. Keep a valid admin push in
    // the inbox instead of sending it to a seller or buyer screen.
    if (role === 'admin' && /^\/admin-dashboard(?:[/?#]|$)/i.test(linkTo)) return null;
  }

  if (type === 'order_confirmation_requested' && (role === 'user' || role === 'seller')) {
    const token = data.confirmationToken || data.token;
    return token
      ? { screen: 'OrderConfirmation', params: { token: String(token) } }
      : detailTarget(orderId);
  }

  if (type === 'return_settled') {
    if (role === 'seller') {
      return {
        screen: 'SellerOrderManagement',
        params: {
          isAdmin: false,
          tab: 'returns',
          ...(returnRequestId ? { returnRequestId: String(returnRequestId) } : {}),
        },
      };
    }
    if (role === 'user') {
      return detailTarget(orderId, returnRequestId ? { returnId: String(returnRequestId) } : {});
    }
    return null;
  }

  if ((SELLER_ORDER_NOTIFICATION_TYPES.has(type) || type === 'return_requested') && role === 'seller') {
    if (type === 'return_requested') {
      return {
        screen: 'SellerOrderManagement',
        params: {
          isAdmin: false,
          tab: 'returns',
          ...(returnRequestId ? { returnRequestId: String(returnRequestId) } : {}),
        },
      };
    }
    return sellerOrderTarget(orderId);
  }

  if (SHOPPER_ORDER_NOTIFICATION_TYPES.has(type) && (role === 'user' || role === 'seller')) {
    return detailTarget(orderId);
  }

  if (SELLER_PAYMENT_NOTIFICATION_TYPES.has(type) && role === 'seller') {
    return { screen: 'SellerPayments', params: {} };
  }
  if (type === 'wallet_transaction_completed') {
    return { screen: 'Wallet', params: transactionId ? { transactionId: String(transactionId) } : {} };
  }
  if (SELLER_SUBSCRIPTION_NOTIFICATION_TYPES.has(type) && role === 'seller') {
    return { screen: 'SellerSubscription', params: {} };
  }

  if (type === 'low_stock' && role === 'seller') return { screen: 'SellerProductManagement', params: {} };
  if (type === 'product_blocked' && role === 'seller') {
    return { screen: 'SellerProductManagement', params: {} };
  }
  if (type === 'seller_account_created' && role === 'seller') {
    return { screen: 'SellerStoreOverview', params: {} };
  }
  if (type === 'new_review' && role === 'seller') {
    return { screen: 'SellerStoreOverview', params: {} };
  }
  if ([
    'store_created',
    'store_verified',
    'store_verification_approved',
    'store_verification_rejected',
    'store_verification_removed',
  ].includes(type) && role === 'seller') {
    return { screen: 'SellerStoreSettings', params: {} };
  }

  if (['price_drop', 'back_in_stock', 'wishlist_sale'].includes(type)
      && (role === 'user' || role === 'seller')) {
    return data.productId
      ? { screen: 'ProductDetail', params: { productId: String(data.productId) } }
      : { screen: 'MainTabs', params: { screen: 'Wishlist' } };
  }
  if (type === 'cart_reminder' && (role === 'user' || role === 'seller')) {
    return { screen: 'MainTabs', params: { screen: 'Cart' } };
  }
  if (type === 'coupon_available' && (role === 'user' || role === 'seller')) {
    return { screen: 'MainTabs', params: { screen: 'Home' } };
  }

  const category = inferNotificationCategory(type, data.category);
  if (orderId && ['order', 'delivery'].includes(category)) {
    if (role === 'seller' && normalizeType(data.audienceRole) === 'seller') {
      return sellerOrderTarget(orderId);
    }
    if (role === 'user' || role === 'seller') return detailTarget(orderId);
  }
  if (data.productId && (role === 'user' || role === 'seller')) {
    return { screen: 'ProductDetail', params: { productId: String(data.productId) } };
  }

  return null;
}
