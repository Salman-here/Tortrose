import {
  buildAnalyticsNotificationReadKey,
  filterSellerNotifications,
  formatSellerNotificationTime,
  mergeSellerNotifications,
  normalizeAnalyticsNotification,
  normalizePersistentNotification,
  parseSellerAnalyticsNotificationsResponse,
  parseSellerInboxNotificationsResponse,
  resolveSellerNotificationTarget,
} from '../../src/utils/sellerNotifications';

describe('seller notification contracts', () => {
  const sellerId = '64b000000000000000000001';

  it('accepts only account-bound authoritative seller notification responses', () => {
    const analytics = parseSellerAnalyticsNotificationsResponse({
      sellerId,
      audienceRole: 'seller',
      notifications: [{
        id: 'paid-order-1',
        type: 'success',
        category: 'payment',
        title: 'Payment received',
        description: 'PKR 200.00',
        time: '2026-08-25T10:00:00.000Z',
        read: false,
        orderId: '64b000000000000000000099',
      }],
    }, { sellerId });
    expect(analytics).toHaveLength(1);
    expect(analytics[0]).toEqual(expect.objectContaining({
      source: 'analytics',
      body: 'PKR 200.00',
    }));

    const inbox = parseSellerInboxNotificationsResponse({
      account: { userId: sellerId, role: 'seller', surface: 'seller' },
      unread: 1,
      items: [{
        _id: '64b000000000000000000010',
        user: sellerId,
        targetRole: 'seller',
        category: 'payment',
        title: 'Withdrawal paid',
        body: 'PKR 1,000.00 was paid.',
        createdAt: '2026-08-25T10:00:00.000Z',
        read: false,
      }],
    }, { sellerId });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toEqual(expect.objectContaining({ source: 'persistent' }));
  });

  it('fails closed for another seller, cross-owned rows, or malformed money-alert metadata', () => {
    expect(() => parseSellerAnalyticsNotificationsResponse({
      sellerId: '64b000000000000000000002',
      audienceRole: 'seller',
      notifications: [],
    }, { sellerId })).toThrow(/account/i);
    expect(() => parseSellerAnalyticsNotificationsResponse({
      sellerId,
      audienceRole: 'seller',
      notifications: [{
        id: 'paid-order-1', type: 'success', category: 'payment', title: 'Payment',
        description: 'PKR 200.00', time: null, read: false,
      }],
    }, { sellerId })).toThrow(/timestamp/i);
    expect(() => parseSellerInboxNotificationsResponse({
      account: { userId: sellerId, role: 'seller', surface: 'seller' },
      unread: 1,
      items: [{
        _id: '64b000000000000000000010',
        user: '64b000000000000000000002',
        targetRole: 'seller',
        category: 'payment',
        title: 'Withdrawal paid',
        body: 'PKR 1,000.00 was paid.',
        createdAt: '2026-08-25T10:00:00.000Z',
        read: false,
      }],
    }, { sellerId })).toThrow(/another account/i);
  });

  it('requires the seller surface, rejects buyer-audience rows, and routes defensively', () => {
    expect(() => parseSellerInboxNotificationsResponse({
      account: { userId: sellerId, role: 'seller', surface: 'seller' },
      unread: 2,
      items: [{
        _id: '64b000000000000000000010',
        user: sellerId,
        targetRole: 'seller',
        category: 'payment',
        title: 'Withdrawal paid',
        body: 'PKR 1,000.00 was paid.',
        createdAt: '2026-08-25T10:00:00.000Z',
        read: false,
        linkTo: '/seller-dashboard/payments',
      }, {
        _id: '64b000000000000000000011',
        user: sellerId,
        targetRole: 'both',
        category: 'payment',
        title: 'Wallet credit received',
        body: 'PKR 500.00 was credited to your buyer Wallet.',
        createdAt: '2026-08-25T10:01:00.000Z',
        read: false,
        aggregateType: 'Order',
        aggregateId: 'buyer-order-id',
        linkTo: '/user-dashboard/wallet',
      }],
    }, { sellerId })).toThrow(/metadata|audience/i);
    expect(() => parseSellerInboxNotificationsResponse({
      account: { userId: sellerId, role: 'seller' },
      unread: 0,
      items: [],
    }, { sellerId })).toThrow(/account/i);
    expect(resolveSellerNotificationTarget({
      persisted: true,
      targetRole: 'both',
      category: 'payment',
      orderId: 'buyer-order-id',
      linkTo: '/user-dashboard/order/detail/buyer-order-id',
    })).toBeNull();
  });

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
    expect(resolveSellerNotificationTarget({
      linkTo: '/seller-dashboard/order-management?orderId=order%2D2',
    })).toEqual({
      screen: 'OrderDetailManagement', params: { orderId: 'order-2' },
    });
    expect(resolveSellerNotificationTarget({
      linkTo: '/seller-dashboard/order-management?tab=returns&returnId=return%2D2',
    })).toEqual({
      screen: 'SellerOrderManagement', params: { tab: 'returns', returnRequestId: 'return-2' },
    });
    expect(resolveSellerNotificationTarget({
      linkTo: '/store/recovery%2Dstore#store-reviews',
    })).toEqual({
      screen: 'Store', params: { slug: 'recovery-store' },
    });
  });

  it('takes a durable store-rating notice to the public store reviews screen, not product ratings', () => {
    const notification = normalizePersistentNotification({
      _id: 'store-review-notification', targetRole: 'seller', category: 'seller',
      title: 'New store review', body: 'A verified buyer rated Atlas Aura 5 out of 5.',
      aggregateType: 'Store', aggregateId: 'store-id',
      linkTo: '/store/atlas-aura#store-reviews',
    });
    expect(notification.orderId).toBeNull();
    expect(resolveSellerNotificationTarget(notification)).toEqual({
      screen: 'Store', params: { slug: 'atlas-aura' },
    });
    expect(resolveSellerNotificationTarget({ ...notification, targetRole: 'both' })).toBeNull();
    expect(notification.body).toBe('A verified buyer rated Atlas Aura 5 out of 5.');
  });

  it('keeps outbox subscription and aggregate order records out of the generic system bucket', () => {
    expect(normalizePersistentNotification({
      _id: 'subscription-1',
      category: 'subscription',
      linkTo: '/seller-dashboard/subscription',
    })).toEqual(expect.objectContaining({ category: 'payment' }));
    expect(normalizePersistentNotification({
      _id: 'order-aggregate-1',
      category: 'order',
      aggregateType: 'order',
      aggregateId: 'order-aggregate-id',
    })).toEqual(expect.objectContaining({ orderId: 'order-aggregate-id' }));
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

  it('prefers the seller-scoped durable paid-order receipt over the analytics fallback', () => {
    const merged = mergeSellerNotifications(
      [{
        id: 'paid-order-object-id',
        category: 'payment',
        type: 'success',
        title: 'Payment received for RZ-MIXED-1',
        description: 'PKR 200.00',
        time: '2026-08-24T11:00:00.000Z',
        orderId: 'order-object-id',
      }],
      [{
        _id: 'persistent-paid-order',
        category: 'order',
        eventType: 'order.paid',
        aggregateType: 'Order',
        aggregateId: 'order-object-id',
        title: 'Paid order received',
        body: 'Your frozen seller allocation is PKR 200.00.',
        createdAt: '2026-08-24T11:00:01.000Z',
      }],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(expect.objectContaining({
      persisted: true,
      source: 'persistent',
      orderId: 'order-object-id',
      body: 'Your frozen seller allocation is PKR 200.00.',
    }));
    expect(merged[0].body).not.toContain('1,880');
  });

  it('retains the seller-scoped analytics paid fallback until a durable receipt exists', () => {
    const merged = mergeSellerNotifications([{
      id: 'paid-order-without-outbox',
      category: 'payment',
      description: 'USD 6.00',
      orderId: 'order-without-outbox',
    }], []);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(expect.objectContaining({
      persisted: false,
      body: 'USD 6.00',
    }));
  });

  it('uses honest unavailable copy for invalid timestamps', () => {
    expect(formatSellerNotificationTime(null)).toBe('Time unavailable');
  });

  it('honours return navigation before the associated order id', () => {
    expect(resolveSellerNotificationTarget({
      persisted: true,
      targetRole: 'seller',
      orderId: 'order-1',
      linkTo: '/seller-dashboard/order-management?tab=returns&returnId=return%2D1',
    })).toEqual({ screen: 'SellerOrderManagement', params: { tab: 'returns', returnRequestId: 'return-1' } });
  });

  test.each([
    'https://evil.example/seller-dashboard/payments',
    '//evil.example/seller-dashboard/payments',
    '/%2fexample.test/seller-dashboard/payments',
    '/seller-dashboard/payments%5cunexpected',
    '/seller-dashboard/payments%00',
    '/user-dashboard/order/detail/order-1',
    '/%61dmin-dashboard/payments',
  ])('rejects unsafe or another audience link even when an order id exists: %s', (linkTo) => {
    expect(resolveSellerNotificationTarget({ targetRole: 'seller', orderId: 'order-1', category: 'payment', linkTo })).toBeNull();
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
