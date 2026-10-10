import { resolveAIClientRoute } from '../../src/utils/aiClientRoutes';
const { buyerFlows, sellerFlows } = require('../../../Backend/services/aiSecureFlowService');

describe('AI client routes', () => {
  test('every secure feature handoff reaches an existing native screen', () => {
    for (const flow of Object.values({ ...buyerFlows, ...sellerFlows })) expect(resolveAIClientRoute(flow[0])).not.toBeNull();
    expect(resolveAIClientRoute('/account-deletion')).toEqual({ type: 'stack', name: 'Settings' });
    expect(resolveAIClientRoute('/settings/blocked-accounts')).toEqual({ type: 'stack', name: 'BlockedAccounts' });
  });
  test.each([
    ['/seller-dashboard/products', 'SellerProductManagement'],
    ['/seller-dashboard/product-management', 'SellerProductManagement'],
    ['/seller-dashboard/orders', 'SellerOrderManagement'],
    ['/seller-dashboard/shipping-configuration', 'SellerShippingConfiguration'],
    ['/seller-dashboard/coupons', 'SellerCouponManagement'],
    ['/seller-dashboard/subscription', 'SellerSubscription'],
    ['/user-dashboard/orders', 'Orders'],
    ['/user-dashboard/wallet', 'Wallet'],
    ['/shipping-policy', 'ShippingPolicy'],
    ['/refund-policy', 'RefundPolicy'],
    ['/cancellation-policy', 'CancellationPolicy'],
  ])('maps %s to the native %s screen', (route, expectedName) => {
    expect(resolveAIClientRoute(route)).toEqual(expect.objectContaining({
      type: 'stack',
      name: expectedName,
    }));
  });

  test('maps seller and buyer order detail routes with their identifiers', () => {
    expect(resolveAIClientRoute('/seller-dashboard/order/order-123')).toEqual({
      type: 'stack',
      name: 'OrderDetailManagement',
      params: { orderId: 'order-123', isAdmin: false },
    });
    expect(resolveAIClientRoute('/user-dashboard/order/detail/order-456')).toEqual({
      type: 'stack',
      name: 'OrderDetail',
      params: { orderId: 'order-456' },
    });
  });

  test('rejects unknown screens instead of navigating to a dead page', () => {
    expect(resolveAIClientRoute('/seller-dashboard/not-a-page')).toBeNull();
    expect(resolveAIClientRoute('https://outside.example/not-a-page')).toBeNull();
  });
});
