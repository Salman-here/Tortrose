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
      ['order_paid', 'order'],
      ['order_no_charge_confirmed', 'order'],
      ['order_confirmation_requested', 'order'],
      ['paid_order_received', 'seller'],
      ['no_charge_order_received', 'seller'],
      ['cod_order_received', 'seller'],
      ['cod_order_confirmed', 'seller'],
      ['cod_order_reconfirmed', 'seller'],
      ['cod_order_cancelled', 'seller'],
      ['return_settled', 'order'],
      ['withdrawal_requested', 'payment'],
      ['withdrawal_status_changed', 'payment'],
      ['wallet_transaction_completed', 'payment'],
      ['subscription_payment_received', 'subscription'],
      ['subscription_payment_recovered', 'subscription'],
      ['subscription_activated', 'subscription'],
      ['subscription_cancelled', 'subscription'],
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

    it('promotes an outbox order aggregate for grouping and native detail routing', () => {
      expect(normalizePersistentInboxNotification({
        _id: 'outbox-order-1',
        aggregateType: 'Order',
        aggregateId: 'order-object-id',
        eventType: 'order.paid',
        category: 'order',
      })).toEqual(expect.objectContaining({
        orderId: 'order-object-id',
        category: 'order',
      }));
    });

    it('keeps the public order reference separate from the internal grouping id', () => {
      expect(normalizePersistentInboxNotification({
        _id: 'outbox-order-2',
        aggregateType: 'Order',
        aggregateId: '6a94ffdcbcde01045357cab2',
        title: 'Seller delivered your items',
        body: 'Order #ORD-1788186109184: Mobile Cedar Lane marked your items delivered.',
        category: 'order',
      })).toEqual(expect.objectContaining({
        orderId: '6a94ffdcbcde01045357cab2',
        publicOrderId: 'ORD-1788186109184',
      }));
    });

    it('prefers a supported server category over a legacy type heuristic', () => {
      expect(categorizeNotification('unknown_queued_type', 'payment')).toBe('payment');
      expect(categorizeNotification('order_paid', 'announcement')).toBe('system');
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

    test('does not call a pending unconfirmed COD order confirmed or processing', () => {
      const out = buildNotificationsFromOrders([{
        _id: 'pending-cod-order',
        orderId: 'RZ-COD-1',
        orderStatus: 'pending',
        paymentMethod: 'cash_on_delivery',
        isPaid: false,
        createdAt: '2026-08-24T08:00:00.000Z',
        confirmation: {
          confirmedAt: null,
          emailSentAt: '2026-08-24T08:01:00.000Z',
        },
      }]);
      expect(out).toEqual([]);
    });

    test('uses the persisted cancellation decision and never retains a prior confirmation claim', () => {
      const out = buildNotificationsFromOrders([{
        _id: 'cancelled-order',
        orderId: 'RZ-CANCELLED-1',
        orderStatus: 'cancelled',
        isPaid: false,
        confirmation: {
          confirmedAt: '2026-08-24T08:00:00.000Z',
          cancelledFromDashboardAt: '2026-08-24T09:00:00.000Z',
        },
      }]);
      expect(out).toEqual([expect.objectContaining({
        title: 'Order Cancelled',
        category: 'order',
        createdAt: '2026-08-24T09:00:00.000Z',
      })]);
      expect(out.some(({ title }) => title === 'Order Confirmed' || title === 'Payment Confirmed')).toBe(false);
    });

    test('does not invent a cancellation time from createdAt or updatedAt', () => {
      expect(buildNotificationsFromOrders([{
        _id: 'cancelled-without-event-time',
        orderStatus: 'cancelled',
        createdAt: '2026-08-24T08:00:00.000Z',
        updatedAt: '2026-08-24T09:00:00.000Z',
      }])).toEqual([]);
    });

    test('emits a confirmed COD fallback only from confirmation.confirmedAt', () => {
      const out = buildNotificationsFromOrders([{
        _id: 'confirmed-cod-order',
        orderId: 'RZ-COD-2',
        orderStatus: 'confirmed',
        paymentMethod: 'cash_on_delivery',
        isPaid: false,
        confirmation: { confirmedAt: '2026-08-24T10:00:00.000Z' },
      }]);
      expect(out).toEqual([expect.objectContaining({
        title: 'Order Confirmed',
        category: 'order',
        createdAt: '2026-08-24T10:00:00.000Z',
      })]);
    });

    test('emits a paid fallback only from isPaid plus paidAt, without generic confirmation copy', () => {
      const out = buildNotificationsFromOrders([{
        _id: 'paid-order',
        orderId: 'RZ-PAID-1',
        orderStatus: 'confirmed',
        isPaid: true,
        paidAt: '2026-08-24T11:00:00.000Z',
        confirmation: { confirmedAt: '2026-08-24T11:00:00.000Z' },
      }]);
      expect(out).toEqual([expect.objectContaining({
        title: 'Payment Confirmed',
        category: 'payment',
        createdAt: '2026-08-24T11:00:00.000Z',
      })]);
      expect(out.some(({ title }) => title === 'Order Confirmed')).toBe(false);
    });

    test('requires actual shipped/delivered timestamps instead of inferring a timeline from final status', () => {
      expect(buildNotificationsFromOrders([{
        _id: 'delivered-without-times',
        orderStatus: 'delivered',
      }])).toEqual([]);

      const out = buildNotificationsFromOrders([{
        _id: 'delivered-with-times',
        orderStatus: 'delivered',
        shippedAt: '2026-08-24T12:00:00.000Z',
        deliveredAt: '2026-08-24T13:00:00.000Z',
      }]);
      expect(out.map(({ title }) => title)).toEqual(['Order Shipped', 'Order Delivered']);
    });

    test('suppresses local order snapshots when a durable push or inbox event exists for the order', () => {
      const order = {
        _id: 'durable-order-id',
        orderStatus: 'confirmed',
        isPaid: true,
        paidAt: '2026-08-24T11:00:00.000Z',
      };
      expect(buildNotificationsFromOrders([order], {
        durableNotifications: [{
          data: { aggregateType: 'Order', aggregateId: 'durable-order-id' },
        }],
      })).toEqual([]);
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

    test('uses the public order reference for display without changing the grouping key', () => {
      const groups = groupNotifications([
        {
          id: '1',
          orderId: '6a94ffdcbcde01045357cab2',
          publicOrderId: 'ORD-1788186109184',
          category: 'order',
          createdAt: '2026-08-31T00:00:00Z',
        },
        {
          id: '2',
          orderId: '6a94ffdcbcde01045357cab2',
          category: 'delivery',
          createdAt: '2026-08-31T01:00:00Z',
        },
      ]);

      expect(groups[0]).toEqual(expect.objectContaining({
        orderId: '6a94ffdcbcde01045357cab2',
        publicOrderId: 'ORD-1788186109184',
      }));
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
