import {
  inferNotificationCategory,
  resolveNotificationTarget,
} from '../../src/utils/notificationRouting';

const buyer = { _id: 'buyer-1', role: 'user' };
const seller = { _id: 'seller-1', role: 'seller' };
const admin = { _id: 'admin-1', role: 'admin' };

describe('financial notification category and tap routing', () => {
  test.each([
    ['order_paid', 'order'],
    ['paid_order_received', 'seller'],
    ['order_no_charge_confirmed', 'order'],
    ['no_charge_order_received', 'seller'],
    ['order_confirmation_requested', 'order'],
    ['cod_order_received', 'seller'],
    ['cod_order_confirmed', 'seller'],
    ['cod_order_reconfirmed', 'seller'],
    ['cod_order_cancelled', 'seller'],
    ['return_settled', 'order'],
    ['wallet_transaction_completed', 'payment'],
    ['withdrawal_requested', 'payment'],
    ['withdrawal_status_changed', 'payment'],
    ['subscription_payment_received', 'subscription'],
    ['subscription_payment_recovered', 'subscription'],
    ['subscription_activated', 'subscription'],
    ['subscription_cancelled', 'subscription'],
  ])('classifies %s without relying on a generic system bucket', (type, category) => {
    expect(inferNotificationCategory(type)).toBe(category);
  });

  it('routes buyer and seller order links to their distinct native order surfaces', () => {
    expect(resolveNotificationTarget({
      type: 'order_paid',
      orderId: 'order-1',
      linkTo: '/user-dashboard/order/detail/order-1',
    }, buyer)).toEqual({ screen: 'OrderDetail', params: { orderId: 'order-1' } });

    expect(resolveNotificationTarget({
      type: 'paid_order_received',
      orderId: 'order-1',
      linkTo: '/seller-dashboard/order-management?orderId=order-1',
    }, seller)).toEqual({
      screen: 'OrderDetailManagement',
      params: { orderId: 'order-1', isAdmin: false },
    });
  });

  test.each([
    'paid_order_received',
    'no_charge_order_received',
    'cod_order_received',
    'cod_order_confirmed',
    'cod_order_reconfirmed',
    'cod_order_cancelled',
  ])('has a seller order fallback for %s when a queued push predates link metadata', (type) => {
    expect(resolveNotificationTarget({ type, orderId: 'order-2' }, seller)).toEqual({
      screen: 'OrderDetailManagement',
      params: { orderId: 'order-2', isAdmin: false },
    });
  });

  it('opens the native COD confirmation screen only for shopper roles', () => {
    const notification = {
      type: 'order_confirmation_requested',
      linkTo: '/orders/confirm/token%2D123',
    };
    expect(resolveNotificationTarget(notification, buyer)).toEqual({
      screen: 'OrderConfirmation',
      params: { token: 'token-123' },
    });
    expect(resolveNotificationTarget(notification, admin)).toBeNull();
  });

  it('routes return settlement to the role-correct order or returns surface', () => {
    expect(resolveNotificationTarget({
      type: 'return_settled',
      orderId: 'order-3',
      returnRequestId: 'return-3',
    }, buyer)).toEqual({
      screen: 'OrderDetail',
      params: { orderId: 'order-3', returnId: 'return-3' },
    });
    expect(resolveNotificationTarget({
      type: 'return_settled',
      returnRequestId: 'return-3',
    }, seller)).toEqual({
      screen: 'SellerOrderManagement',
      params: { isAdmin: false, tab: 'returns', returnRequestId: 'return-3' },
    });
    expect(resolveNotificationTarget({
      type: 'return_settled',
      linkTo: '/seller-dashboard/order-management?tab=returns&returnId=return%2D4',
    }, seller)).toEqual({
      screen: 'SellerOrderManagement',
      params: { isAdmin: false, tab: 'returns', returnRequestId: 'return-4' },
    });
  });

  test.each([
    ['withdrawal_requested', seller, 'SellerPayments', {}],
    ['withdrawal_status_changed', seller, 'SellerPayments', {}],
    ['subscription_payment_received', seller, 'SellerSubscription', {}],
    ['subscription_payment_recovered', seller, 'SellerSubscription', {}],
    ['subscription_activated', seller, 'SellerSubscription', {}],
    ['subscription_cancelled', seller, 'SellerSubscription', {}],
    ['wallet_transaction_completed', buyer, 'Wallet', { transactionId: 'transaction-1' }],
  ])('routes %s to its native financial surface', (type, account, screen, params) => {
    expect(resolveNotificationTarget({ type, transactionId: 'transaction-1' }, account)).toEqual({
      screen,
      params,
    });
  });

  it('preserves buyer-vs-seller intent for generic order records carrying audience metadata', () => {
    expect(resolveNotificationTarget({
      orderId: 'buyer-order',
      category: 'order',
      audienceRole: 'buyer',
    }, seller)).toEqual({ screen: 'OrderDetail', params: { orderId: 'buyer-order' } });
    expect(resolveNotificationTarget({
      orderId: 'seller-order',
      category: 'order',
      audienceRole: 'seller',
    }, seller)).toEqual({
      screen: 'OrderDetailManagement',
      params: { orderId: 'seller-order', isAdmin: false },
    });
  });

  test.each([
    ['seller_account_created', '/seller-dashboard/store-overview', 'SellerStoreOverview'],
    ['store_created', '/seller-dashboard/store-settings', 'SellerStoreSettings'],
    ['store_verification_rejected', '/seller-dashboard/store-settings', 'SellerStoreSettings'],
    ['product_blocked', '/seller-dashboard/product-management', 'SellerProductManagement'],
    ['payout_account_updated', '/seller-dashboard/payments', 'SellerPayments'],
  ])('routes seller operational event %s through its safe native link fallback', (type, linkTo, screen) => {
    expect(resolveNotificationTarget({ type, linkTo, audienceRole: 'seller' }, seller)).toEqual({
      screen,
      params: {},
    });
    expect(resolveNotificationTarget({ type, linkTo, audienceRole: 'seller' }, buyer)).toBeNull();
  });

  test.each([
    ['seller_account_created', 'SellerStoreOverview'],
    ['store_created', 'SellerStoreSettings'],
    ['store_verification_removed', 'SellerStoreSettings'],
    ['product_blocked', 'SellerProductManagement'],
    ['new_review', 'SellerStoreOverview'],
    ['payout_account_updated', 'SellerPayments'],
  ])('routes seller operational event %s safely even when an older push omits linkTo', (type, screen) => {
    expect(resolveNotificationTarget({ type, audienceRole: 'seller' }, seller)).toEqual({
      screen,
      params: {},
    });
    expect(resolveNotificationTarget({ type, audienceRole: 'seller' }, buyer)).toBeNull();
  });

  it('routes a seller-only new-review link to the exact public store without exposing it cross-role', () => {
    const notification = {
      type: 'new_review',
      linkTo: '/store/recovery-store#store-reviews',
      audienceRole: 'seller',
    };
    expect(resolveNotificationTarget(notification, seller)).toEqual({
      screen: 'Store',
      params: { slug: 'recovery-store' },
    });
    expect(resolveNotificationTarget(notification, buyer)).toBeNull();
  });

  it('never turns external or cross-role web links into native privileged routes', () => {
    expect(resolveNotificationTarget({ linkTo: 'https://evil.example/seller-dashboard/payments' }, seller)).toBeNull();
    expect(resolveNotificationTarget({ linkTo: '/seller-dashboard/payments' }, buyer)).toBeNull();
    expect(resolveNotificationTarget({ linkTo: '/user-dashboard/wallet' }, buyer)).toEqual({
      screen: 'Wallet',
      params: {},
    });
    expect(resolveNotificationTarget({ linkTo: '/admin-dashboard/payments' }, admin)).toBeNull();
  });
});
