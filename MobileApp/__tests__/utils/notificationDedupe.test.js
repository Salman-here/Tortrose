import {
  dedupeInboxNotifications,
  getPersistentNotificationInboxId,
  getPushNotificationInboxId,
  mergeInboxNotification,
  normalizeNotificationChannelDedupeKey,
  normalizeNotificationEventKey,
} from '../../src/utils/notificationDedupe';

describe('notification event dedupe', () => {
  test('push and persistent copies of one event resolve to the same inbox id', () => {
    const eventKey = 'order:507f1f77bcf86cd799439011:paid:buyer:v1';
    const push = {
      request: {
        identifier: 'expo-provider-ticket',
        content: { data: { notificationEventKey: eventKey } },
      },
    };
    const persistent = { _id: 'notification-row', eventKey };
    expect(getPushNotificationInboxId(push)).toBe(`event:${eventKey}`);
    expect(getPersistentNotificationInboxId(persistent)).toBe(`event:${eventKey}`);
  });

  test('channel idempotency keys dedupe push retries when no event key is available', () => {
    const key = 'a'.repeat(64);
    const notification = {
      request: {
        identifier: 'provider-retry-id',
        content: { data: { notificationDedupeKey: key } },
      },
    };
    expect(getPushNotificationInboxId(notification)).toBe(`outbox:${key}`);
  });

  test.each([
    '',
    ' order:event',
    'order/event',
    'javascript:alert(1)',
    'a'.repeat(301),
    false,
  ])('rejects malformed event identity %p', value => {
    expect(normalizeNotificationEventKey(value)).toBe('');
  });

  test.each(['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), true, null])(
    'rejects malformed channel dedupe identity %p',
    value => {
      expect(normalizeNotificationChannelDedupeKey(value)).toBe('');
    }
  );

  test('legacy provider identifiers remain supported', () => {
    expect(getPushNotificationInboxId({
      request: { identifier: 'legacy-provider-id', content: { data: {} } },
    })).toBe('legacy-provider-id');
    expect(getPersistentNotificationInboxId({ _id: 'legacy-row' })).toBe('broadcast_legacy-row');
  });

  test('dedupes legacy cached ids by the stable event identity', () => {
    const eventKey = 'wallet:credit:buyer-1:v1';
    const cached = [
      { id: 'provider-a', title: 'First', data: { notificationEventKey: eventKey } },
      { id: 'provider-b', title: 'Retry', data: { notificationEventKey: eventKey } },
    ];
    expect(dedupeInboxNotifications(cached)).toEqual([expect.objectContaining({
      id: `event:${eventKey}`,
      title: 'First',
    })]);
  });

  test('does not prepend a duplicate foreground event to an existing durable row', () => {
    const eventKey = 'order:paid:buyer-1:v1';
    const existing = [{ id: `event:${eventKey}`, title: 'Durable receipt' }];
    const incoming = {
      id: 'provider-ticket',
      title: 'Push receipt',
      data: { notificationEventKey: eventKey },
    };
    expect(mergeInboxNotification(existing, incoming)).toEqual(existing);
  });
});
