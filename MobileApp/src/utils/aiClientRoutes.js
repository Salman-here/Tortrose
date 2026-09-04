const stack = (name, params) => ({ type: 'stack', name, ...(params ? { params } : {}) });
const tab = (screen, params) => ({ type: 'tab', screen, ...(params ? { params } : {}) });

const STATIC_CLIENT_ROUTES = {
  orders: stack('Orders'),
  checkout: stack('Checkout'),
  settings: stack('Settings'),
  'track-order': stack('TrackOrder'),
  'become-seller': stack('BecomeSeller'),
  about: stack('About'),
  faq: stack('FAQ'),
  contact: stack('Contact'),
  docs: stack('Docs'),
  terms: stack('TermsOfService'),
  'terms-of-service': stack('TermsOfService'),
  privacy: stack('PrivacyPolicy'),
  'privacy-policy': stack('PrivacyPolicy'),
  'ai-chat': stack('AIChat'),
  notifications: stack('Notifications'),
  'user-dashboard': stack('UserDashboard'),
  'user-dashboard/account-overview': stack('UserDashboard'),
  'user-dashboard/profile': tab('Account'),
  'user-dashboard/orders': stack('Orders'),
  'user-dashboard/whatsapp': stack('UserWhatsAppSettings'),
  'user-dashboard/wallet': stack('Wallet'),
  'user-dashboard/notifications': stack('Notifications'),
  'user-dashboard/payment-methods': stack('PaymentMethods'),
  'seller-dashboard': stack('SellerDashboard'),
  'seller-dashboard/seller-home': stack('SellerDashboard'),
  'seller-dashboard/store-overview': stack('SellerStoreOverview'),
  'seller-dashboard/product-management': stack('SellerProductManagement'),
  'seller-dashboard/order-management': stack('SellerOrderManagement'),
  'seller-dashboard/store-settings': stack('SellerStoreSettings'),
  'seller-dashboard/shipping-configuration': stack('SellerShippingConfiguration'),
  'seller-dashboard/analytics': stack('SellerAnalytics'),
  'seller-dashboard/payments': stack('SellerPayments'),
  'seller-dashboard/payment-methods': stack('PaymentMethods'),
  'seller-dashboard/notifications': stack('SellerNotifications'),
  'seller-dashboard/notification-settings': stack('NotificationSettings'),
  'seller-dashboard/subdomain': stack('SellerSubdomainManagement'),
  'seller-dashboard/subscription': stack('SellerSubscription'),
  'seller-dashboard/ads': stack('SellerAds'),
  'seller-dashboard/coupons': stack('SellerCouponManagement'),
  'seller-dashboard/whatsapp-settings': stack('SellerWhatsAppSettings'),
  'seller-dashboard/profile': stack('SellerProfile'),
  wallet: stack('Wallet'),
};

const TAB_CLIENT_ROUTES = {
  '': 'Home',
  home: 'Home',
  cart: 'Cart',
  profile: 'Account',
  account: 'Account',
  stores: 'Marketplace',
  marketplace: 'Marketplace',
  favorites: 'Wishlist',
  wishlist: 'Wishlist',
};

const ROUTE_ALIASES = {
  'seller-dashboard/products': 'seller-dashboard/product-management',
  'seller-dashboard/product': 'seller-dashboard/product-management',
  'seller-dashboard/orders': 'seller-dashboard/order-management',
  'seller-dashboard/shipping': 'seller-dashboard/shipping-configuration',
  'seller-dashboard/settings': 'seller-dashboard/store-settings',
  'seller-dashboard/store': 'seller-dashboard/store-overview',
  'seller-dashboard/coupon-management': 'seller-dashboard/coupons',
  'user-dashboard/order-management': 'user-dashboard/orders',
};

export const resolveAIClientRoute = (rawRoute) => {
  const raw = String(rawRoute || '').trim();
  if (!raw) return tab('Home');

  let path = raw
    .replace(/^https?:\/\/[^/]+/i, '')
    .split(/[?#]/)[0]
    .replace(/^\/+|\/+$/g, '');
  try {
    path = decodeURIComponent(path);
  } catch {}

  const rawKey = path.toLowerCase();
  const routeKey = ROUTE_ALIASES[rawKey] || rawKey;
  if (TAB_CLIENT_ROUTES[routeKey]) return tab(TAB_CLIENT_ROUTES[routeKey]);
  if (STATIC_CLIENT_ROUTES[routeKey]) return STATIC_CLIENT_ROUTES[routeKey];
  if (routeKey === 'marketplace/trusted') return tab('Wishlist', { tab: 'stores' });

  const segments = routeKey.split('/').filter(Boolean);
  const identifierFrom = index => path.split('/').filter(Boolean).slice(index).join('/');
  if (segments[0] === 'single-product' && segments[1] && !segments[1].startsWith(':')) {
    return stack('ProductDetail', { productId: identifierFrom(1) });
  }
  if (segments[0] === 'store' && segments[1] && !segments[1].startsWith(':')) {
    return stack('Store', { storeSlug: identifierFrom(1) });
  }
  if (segments[0] === 'order' && segments[1] && !segments[1].startsWith(':')) {
    return stack('OrderDetail', { orderId: identifierFrom(1) });
  }
  if (segments[0] === 'seller-dashboard' && segments[1] === 'order' && segments[2]) {
    return stack('OrderDetailManagement', { orderId: identifierFrom(2), isAdmin: false });
  }
  if (segments[0] === 'user-dashboard' && segments[1] === 'order') {
    const idIndex = segments[2] === 'detail' ? 3 : 2;
    if (segments[idIndex]) return stack('OrderDetail', { orderId: identifierFrom(idIndex) });
  }
  return null;
};

