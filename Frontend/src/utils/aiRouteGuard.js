const ROUTE_ALIASES = {
  '/seller/apply': '/become-seller',
  '/seller-signup': '/become-seller',
  '/apply-seller': '/become-seller',
  '/seller-registration': '/become-seller',
  '/seller-dashboard/products': '/seller-dashboard/product-management',
  '/seller-dashboard/product': '/seller-dashboard/product-management',
  '/seller-dashboard/orders': '/seller-dashboard/order-management',
  '/seller-dashboard/shipping': '/seller-dashboard/shipping-configuration',
  '/seller-dashboard/settings': '/seller-dashboard/store-settings',
  '/seller-dashboard/store': '/seller-dashboard/store-overview',
  '/seller-dashboard/coupon-management': '/seller-dashboard/coupons',
  '/user-dashboard/order-management': '/user-dashboard/orders',
};

const EXACT_ROUTES = new Set([
  '/',
  '/marketplace',
  '/marketplace/trusted',
  '/trusted-stores',
  '/about',
  '/faq',
  '/contact',
  '/docs',
  '/track-order',
  '/become-seller',
  '/terms',
  '/privacy',
  '/ai-chat',
  '/login',
  '/signup',
  '/cart',
  '/checkout',
  '/products',
  '/stores',
  '/unauthorized',
  '/user-dashboard',
  '/user-dashboard/account-overview',
  '/user-dashboard/profile',
  '/user-dashboard/orders',
  '/user-dashboard/whatsapp',
  '/user-dashboard/wallet',
  '/user-dashboard/notifications',
  '/user-dashboard/payment-methods',
  '/seller-dashboard',
  '/seller-dashboard/seller-home',
  '/seller-dashboard/store-overview',
  '/seller-dashboard/product-management',
  '/seller-dashboard/order-management',
  '/seller-dashboard/store-settings',
  '/seller-dashboard/shipping-configuration',
  '/seller-dashboard/analytics',
  '/seller-dashboard/payments',
  '/seller-dashboard/payment-methods',
  '/seller-dashboard/notifications',
  '/seller-dashboard/notification-settings',
  '/seller-dashboard/subdomain',
  '/seller-dashboard/subscription',
  '/seller-dashboard/ads',
  '/seller-dashboard/coupons',
  '/seller-dashboard/whatsapp-settings',
  '/seller-dashboard/profile',
  '/admin-dashboard',
  '/admin-dashboard/store-overview',
  '/admin-dashboard/product-management',
  '/admin-dashboard/order-management',
  '/admin-dashboard/user-management',
  '/admin-dashboard/tax-configuration',
  '/admin-dashboard/store-verifications',
  '/admin-dashboard/analytics',
  '/admin-dashboard/payments',
  '/admin-dashboard/notifications',
  '/admin-dashboard/notification-settings',
  '/admin-dashboard/subdomains',
  '/admin-dashboard/complaints',
  '/admin-dashboard/whatsapp-verification',
  '/admin-dashboard/whatsapp-test-inbox',
  '/admin-dashboard/broadcast',
  '/admin-dashboard/ads',
  '/admin-dashboard/ai-prompts',
]);

const PREFIX_ROUTES = [
  '/single-product/',
  '/store/',
  '/orders/confirm/',
  '/seller-dashboard/order/',
  '/admin-dashboard/order/',
  '/user-dashboard/order/',
];

export const normalizeAIRoute = (route) => {
  const raw = String(route || '').trim();
  if (!raw) return '/';

  let pathname = raw;
  try {
    const url = new URL(raw, window.location.origin);
    pathname = url.pathname + url.search + url.hash;
  } catch {
    pathname = raw.startsWith('/') ? raw : `/${raw}`;
  }

  const [pathOnly, suffix = ''] = pathname.split(/(?=[?#])/);
  const normalizedPath = (ROUTE_ALIASES[pathOnly] || pathOnly).replace(/\/+$/, '') || '/';
  if (EXACT_ROUTES.has(normalizedPath)) return `${normalizedPath}${suffix}`;
  if (PREFIX_ROUTES.some(prefix => normalizedPath === prefix.replace(/\/$/, '') || normalizedPath.startsWith(prefix))) {
    return `${normalizedPath}${suffix}`;
  }
  return '/';
};
