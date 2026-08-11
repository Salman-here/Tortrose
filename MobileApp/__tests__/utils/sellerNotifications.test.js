import {
  buildAnalyticsNotificationReadKey,
  filterSellerNotifications,
  formatSellerNotificationTime,
  mergeSellerNotifications,
  normalizeAnalyticsNotification,
  resolveSellerNotificationTarget,
} from '../../src/utils/sellerNotifications';

describe('seller notification contracts', () => {
  it('preserves analytics category, timestamp and order target', () => {
    const normalized = normalizeAnalyticsNotification({
      id: 'order-1',
      type: 'critical',
      category: 'order',
      title: 'New order',
      description: 'Needs attention',
      time: '2026-08-08T10:00:00.000Z',
      orderId: 'mongo-order-id',
    });

    expect(normalized).toMatchObject({
      category: 'order',
      severity: 'critical',
      createdAt: '2026-08-08T10:00:00.000Z',
      orderId: 'mongo-order-id',
    });
    expect(resolveSellerNotificationTarget(normalized)).toEqual({
      screen: 'OrderDetailManagement',
      params: { orderId: 'mongo-order-id' },
    });
  });

  it('maps website deep links to registered mobile seller routes', () => {
    expect(resolveSellerNotificationTarget({ linkTo: '/seller-dashboard/coupons' })).toEqual({
      screen: 'SellerCouponManagement', params: {},
    });
    expect(resolveSellerNotificationTarget({ linkTo: '/seller-dashboard/subdomain' })).toEqual({
      screen: 'SellerSubdomainManagement', params: {},
    });
  });

  it('merges real sources without inventing fallback notifications', () => {
    const merged = mergeSellerNotifications(
      [{ id: 'live', category: 'stock', title: 'Low stock', time: '2026-08-08T10:00:00Z' }],
      [{ _id: 'saved', category: 'announcement', title: 'Update', body: 'News', createdAt: '2026-08-08T11:00:00Z' }],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0].persisted).toBe(true);
    expect(filterSellerNotifications(merged, 'stock')).toHaveLength(1);
  });

  it('uses honest unavailable copy for invalid timestamps', () => {
    expect(formatSellerNotificationTime(null)).toBe('Time unavailable');
  });

  it('keys local analytics read state to the alert occurrence, not only its id', () => {
    expect(buildAnalyticsNotificationReadKey({
      id: 'analytics:stock-product-1',
      createdAt: '2026-08-08T10:00:00.000Z',
    })).toBe('analytics:stock-product-1|2026-08-08T10:00:00.000Z');
    expect(buildAnalyticsNotificationReadKey({
      id: 'analytics:stock-product-1',
      createdAt: '2026-08-09T10:00:00.000Z',
    })).not.toBe('analytics:stock-product-1|2026-08-08T10:00:00.000Z');
  });
});
