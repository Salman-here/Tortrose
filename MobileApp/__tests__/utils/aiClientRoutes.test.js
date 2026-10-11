import { resolveAIClientRoute, openAIClientRoute } from '../../src/utils/aiClientRoutes';
const { buyerFlows, sellerFlows } = require('../../../Backend/services/aiSecureFlowService');

describe('AI client routes', () => {
  test('secure handoff navigation preserves native stack parameters', () => {
    const navigation = { navigate: jest.fn() };
    expect(openAIClientRoute(navigation, '/seller-dashboard/order-management?tab=returns')).toBe(true);
    expect(navigation.navigate).toHaveBeenCalledWith('SellerOrderManagement', { tab: 'returns' });
  });
  test('tab handoffs select the existing navigator or its MainTabs parent', () => {
    const direct = { navigate: jest.fn(), getState: () => ({ routeNames: ['Account'] }) };
    expect(openAIClientRoute(direct, '/user-dashboard/profile')).toBe(true);
    expect(direct.navigate).toHaveBeenCalledWith('Account', undefined);
    const nested = { navigate: jest.fn() };
    expect(openAIClientRoute(nested, '/user-dashboard/profile')).toBe(true);
    expect(nested.navigate).toHaveBeenCalledWith('MainTabs', { screen: 'Account', params: undefined });
  });
  test('failed or unavailable native navigation never reports success', () => {
    expect(openAIClientRoute(null, '/checkout')).toBe(false);
    const navigation = { navigate: jest.fn(() => { throw new Error('Unavailable navigator'); }) };
    expect(openAIClientRoute(navigation, '/unknown')).toBe(false);
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(openAIClientRoute(navigation, '/checkout')).toBe(false);
  });
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

  test.each(['/seller-dashboard/order-management?tab=returns', 'https://rozare.com/seller-dashboard/order-management?tab=returns', '/seller-dashboard/orders?tab=returns'])('opens the native Return Orders tab from %s', route => {
    expect(resolveAIClientRoute(route)).toEqual({ type: 'stack', name: 'SellerOrderManagement', params: { tab: 'returns' } });
  });

  test('unknown and fragment-only tab hints do not change seller navigation', () => {
    for (const route of ['/seller-dashboard/order-management?tab=unknown', '/seller-dashboard/order-management#?tab=returns']) {
      expect(resolveAIClientRoute(route)).toEqual({ type: 'stack', name: 'SellerOrderManagement' });
    }
  });

  test('rejects unknown screens instead of navigating to a dead page', () => {
    expect(resolveAIClientRoute('/seller-dashboard/not-a-page')).toBeNull();
    expect(resolveAIClientRoute('https://outside.example/not-a-page')).toBeNull();
  });
});
