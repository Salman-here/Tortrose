import {
  parseNotificationInboxResponse,
  parseNotificationReadAllResponse,
  parseNotificationReadResponse,
  parseStoredNotificationReadIds,
  reconcileNotificationUnreadCount,
} from '../../src/utils/notificationInboxSafety';

const currentUser = { _id: '64b000000000000000000001', role: 'seller' };

const notificationRow = (overrides = {}) => ({
  _id: '64b000000000000000000010',
  user: currentUser._id,
  title: 'Wallet credit received',
  body: 'PKR 500.00 was credited.',
  category: 'payment',
  linkTo: '/user-dashboard/wallet',
  source: 'system',
  targetRole: 'both',
  audience: 'specific',
  read: false,
  eventKey: 'wallet:credit:buyer:v1',
  eventType: 'wallet.transaction_completed',
  aggregateType: 'WalletTransaction',
  aggregateId: 'wallet-transaction-1',
  createdAt: '2026-08-25T10:00:00.000Z',
  ...overrides,
});

const inboxPayload = (overrides = {}) => ({
  account: { userId: currentUser._id, role: 'seller' },
  items: [notificationRow()],
  unread: 1,
  ...overrides,
});

describe('notification inbox safety contract', () => {
  test('accepts an account-bound exact durable snapshot and reconciles local-only pushes once', () => {
    const snapshot = parseNotificationInboxResponse(inboxPayload({ unread: 3 }), { currentUser });
    const count = reconcileNotificationUnreadCount({
      snapshot,
      currentUser,
      readIds: new Set(),
      cachedNotifications: [{
        id: 'provider-duplicate',
        read: false,
        category: 'payment',
        data: {
          notificationEventKey: 'wallet:credit:buyer:v1',
          recipientUserId: currentUser._id,
          targetRole: 'both',
        },
      }, {
        id: 'local-only',
        read: false,
        category: 'promo',
        data: { recipientUserId: currentUser._id, targetRole: 'both' },
      }],
    });
    expect(count).toBe(4);
  });

  test.each([
    inboxPayload({ account: { userId: 'another-account', role: 'seller' } }),
    inboxPayload({ account: { userId: currentUser._id, role: 'seller', surface: 'seller' } }),
    inboxPayload({ unread: 1.5 }),
    inboxPayload({ items: [notificationRow({ user: 'another-account' })] }),
    inboxPayload({ items: [notificationRow({ eventKey: 'bad/event/key' })] }),
    inboxPayload({ items: [notificationRow({ targetRole: 'admin' })] }),
  ])('rejects malformed or cross-account durable snapshots', (payload) => {
    expect(() => parseNotificationInboxResponse(payload, { currentUser })).toThrow();
  });

  test('requires PATCH and read-all responses to prove the requested transition', () => {
    expect(parseNotificationReadResponse({
      account: { userId: currentUser._id, role: 'seller' },
      notification: notificationRow({ read: true }),
    }, {
      currentUser,
      notificationId: '64b000000000000000000010',
    })).toEqual(expect.objectContaining({ read: true }));
    expect(() => parseNotificationReadResponse({
      account: { userId: currentUser._id, role: 'seller' },
      notification: notificationRow({ read: false }),
    }, {
      currentUser,
      notificationId: '64b000000000000000000010',
    })).toThrow(/confirm/i);
    expect(() => parseNotificationReadResponse({
      notification: notificationRow({ read: true }),
    }, {
      currentUser,
      notificationId: '64b000000000000000000010',
    })).toThrow(/account|surface/i);
    expect(() => parseNotificationReadResponse({
      account: { userId: currentUser._id, role: 'seller', surface: 'seller' },
      notification: notificationRow({ read: true }),
    }, {
      currentUser,
      notificationId: '64b000000000000000000010',
    })).toThrow(/account|surface/i);
    expect(parseNotificationReadAllResponse({
      ok: true,
      account: { userId: currentUser._id, role: 'seller' },
    }, { currentUser })).toBe(true);
    expect(() => parseNotificationReadAllResponse({
      ok: true,
      account: { userId: 'another-account', role: 'seller' },
    }, { currentUser })).toThrow(/account|surface/i);
    expect(() => parseNotificationReadAllResponse({
      ok: 1,
      account: { userId: currentUser._id, role: 'seller' },
    }, { currentUser })).toThrow();
  });

  test('requires exact seller-surface envelopes and rejects buyer rows on seller mutations', () => {
    const sellerNotification = notificationRow({
      targetRole: 'seller',
      linkTo: '/seller-dashboard/payments',
      eventKey: 'seller:withdrawal:paid:v1',
    });
    const sellerOptions = {
      currentUser,
      notificationId: sellerNotification._id,
      expectedSurface: 'seller',
    };
    expect(parseNotificationReadResponse({
      account: { userId: currentUser._id, role: 'seller', surface: 'seller' },
      notification: { ...sellerNotification, read: true },
    }, sellerOptions)).toEqual(expect.objectContaining({ targetRole: 'seller', read: true }));

    expect(() => parseNotificationReadResponse({
      account: { userId: currentUser._id, role: 'seller', surface: 'seller' },
      notification: notificationRow({ read: true }),
    }, sellerOptions)).toThrow(/seller surface/i);
    expect(() => parseNotificationReadResponse({
      account: { userId: currentUser._id, role: 'seller' },
      notification: { ...sellerNotification, read: true },
    }, sellerOptions)).toThrow(/account|surface/i);
    expect(() => parseNotificationReadResponse({
      account: { userId: currentUser._id, role: 'user', surface: 'seller' },
      notification: { ...sellerNotification, read: true },
    }, sellerOptions)).toThrow(/account|surface/i);

    expect(parseNotificationReadAllResponse({
      ok: true,
      account: { userId: currentUser._id, role: 'seller', surface: 'seller' },
    }, { currentUser, expectedSurface: 'seller' })).toBe(true);
    expect(() => parseNotificationReadAllResponse({
      ok: true,
      account: { userId: currentUser._id, role: 'seller' },
    }, { currentUser, expectedSurface: 'seller' })).toThrow(/account|surface/i);
    expect(() => parseNotificationReadAllResponse({
      ok: true,
      account: { userId: currentUser._id, role: 'seller', surface: 'seller', extra: true },
    }, { currentUser, expectedSurface: 'seller' })).toThrow(/account|surface/i);
  });

  test('validates account-scoped local read tombstones', () => {
    expect(parseStoredNotificationReadIds('["event:one","event:two"]')).toEqual(
      new Set(['event:one', 'event:two'])
    );
    expect(() => parseStoredNotificationReadIds('{"event:one":true}')).toThrow();
  });
});
