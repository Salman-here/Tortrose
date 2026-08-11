/**
 * Pure-function tests for useNotificationInbox helpers.
 * Avoids RN/expo runtime by exercising only the exported pure utilities.
 */

import {
  categorizeNotification,
  formatTime,
  buildNotificationsFromOrders,
  groupNotifications,
  normalizePersistentInboxNotification,
} from '../../src/hooks/useNotificationInbox';

describe('useNotificationInbox helpers', () => {
  describe('normalizePersistentInboxNotification', () => {
    it('preserves server recipient and role metadata for final client-side isolation', () => {
      expect(normalizePersistentInboxNotification({
        _id: 'notification-1',
        user: 'seller-1',
        title: 'Seller operation',
        body: 'A seller-only update.',
        category: 'order',
        source: 'system',
        targetRole: 'seller',
        audience: 'specific',
        linkTo: '/seller/orders/one',
      })).toEqual(expect.objectContaining({
        id: 'broadcast_notification-1',
        data: expect.objectContaining({
          recipientUserId: 'seller-1',
          type: 'persistent_system',
          targetRole: 'seller',
          audience: 'specific',
        }),
      }));
    });

    it('marks only actual broadcast records as broadcasts', () => {
      expect(normalizePersistentInboxNotification({
        _id: 'broadcast-1',
        source: 'admin_broadcast',
      }).data.type).toBe('admin_broadcast');
    });

    it('drops malformed persistent records without a stable server id', () => {
      expect(normalizePersistentInboxNotification({ title: 'No id' })).toBeNull();
    });
  });

  describe('categorizeNotification', () => {
    test.each([
      ['order_placed', 'order'],
      ['order_processing', 'order'],
      ['order_shipped', 'delivery'],
      ['order_delivered', 'delivery'],
      ['new_order_received', 'seller'],
      ['order_confirmed_by_buyer', 'seller'],
      ['order_cancelled_by_buyer', 'seller'],
      ['return_requested', 'seller'],
      ['return_status_update', 'order'],
      ['low_stock', 'seller'],
      ['store_verified', 'seller'],
      ['price_drop', 'promo'],
      ['back_in_stock', 'promo'],
      ['coupon_available', 'promo'],
      ['cart_reminder', 'promo'],
      ['random_unknown_type', 'system'],
      [undefined, 'system'],
      [null, 'system'],
    ])('categorizes %s as %s', (input, expected) => {
      expect(categorizeNotification(input)).toBe(expected);
    });
  });

  describe('formatTime', () => {
    test('returns "Just now" for sub-minute timestamps', () => {
      expect(formatTime(new Date().toISOString())).toBe('Just now');
    });

    test('returns minutes for sub-hour timestamps', () => {
      const t = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      expect(formatTime(t)).toBe('5m ago');
    });

    test('returns hours for sub-day timestamps', () => {
      const t = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      expect(formatTime(t)).toBe('3h ago');
    });

    test('returns days for sub-week timestamps', () => {
      const t = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      expect(formatTime(t)).toBe('2d ago');
    });

    test('returns locale date for older timestamps', () => {
      const t = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      expect(formatTime(t)).toMatch(/\d/);
    });
  });

  describe('buildNotificationsFromOrders', () => {
    test('returns empty array for no orders', () => {
      expect(buildNotificationsFromOrders([])).toEqual([]);
    });

    test('emits "Order Confirmed" for every order', () => {
      const orders = [{ _id: 'abc123def456', orderStatus: 'pending', createdAt: new Date().toISOString() }];
      const out = buildNotificationsFromOrders(orders);
      expect(out.some(n => n.title === 'Order Confirmed')).toBe(true);
    });

    test('emits delivery + delivered notifications for delivered orders', () => {
      const orders = [{ _id: 'order_delivered_id', orderStatus: 'delivered', createdAt: new Date().toISOString() }];
      const out = buildNotificationsFromOrders(orders);
      expect(out.find(n => n.title === 'Order Shipped')).toBeTruthy();
      expect(out.find(n => n.title === 'Order Delivered')).toBeTruthy();
    });

    test('emits cancellation alert for cancelled orders', () => {
      const orders = [{ _id: 'cancelled_order', orderStatus: 'cancelled', createdAt: new Date().toISOString() }];
      const out = buildNotificationsFromOrders(orders);
      expect(out.find(n => n.category === 'alert')).toBeTruthy();
    });
  });

  describe('groupNotifications', () => {
    test('groups multiple notifications with the same orderId', () => {
      const notifs = [
        { id: '1', orderId: 'o1', category: 'order', createdAt: '2025-01-01T00:00:00Z' },
        { id: '2', orderId: 'o1', category: 'delivery', createdAt: '2025-01-02T00:00:00Z' },
        { id: '3', orderId: 'o2', category: 'order', createdAt: '2025-01-03T00:00:00Z' },
      ];
      const groups = groupNotifications(notifs);
      const o1 = groups.find(g => g.type === 'group' && g.orderId === 'o1');
      expect(o1.items).toHaveLength(2);
    });

    test('keeps non-order notifications as singles', () => {
      const notifs = [
        { id: 'p1', category: 'promo', createdAt: '2025-01-01T00:00:00Z' },
      ];
      const groups = groupNotifications(notifs);
      expect(groups[0].type).toBe('single');
    });

    test('sorts groups by latest date descending', () => {
      const notifs = [
        { id: '1', orderId: 'old', category: 'order', createdAt: '2024-01-01T00:00:00Z' },
        { id: '2', orderId: 'new', category: 'order', createdAt: '2025-06-01T00:00:00Z' },
      ];
      const groups = groupNotifications(notifs);
      expect(groups[0].orderId || groups[0].item.orderId).toBe('new');
    });
  });
});
