import {
  displayNotificationCategory,
  getNotificationCategoriesForRole,
  getNotificationStorageKeys,
  isNotificationAllowedForRole,
  scopeNotificationsForRole,
} from '../../src/utils/notificationScope';

const buyer = { _id: 'buyer-1', role: 'user' };
const seller = { _id: 'seller-1', role: 'seller' };
const admin = { _id: 'admin-1', role: 'admin' };

describe('notification account and role isolation', () => {
  it('uses different persistence keys for every account and role', () => {
    expect(getNotificationStorageKeys(buyer)).not.toEqual(getNotificationStorageKeys({ _id: 'buyer-2', role: 'user' }));
    expect(getNotificationStorageKeys(buyer)).not.toEqual(getNotificationStorageKeys({ _id: 'buyer-1', role: 'seller' }));
    expect(getNotificationStorageKeys(buyer).inbox).toContain('user:buyer-1');
  });

  test.each([
    [{ data: { type: 'new_order_received' } }, buyer],
    [{ data: { type: 'low_stock' } }, buyer],
    [{ data: { type: 'return_requested' } }, buyer],
    [{ data: { type: 'order_cancelled_by_buyer' } }, buyer],
    [{ category: 'seller' }, buyer],
    [{ data: { linkTo: '/seller-dashboard/orders' } }, buyer],
    [{ data: { linkTo: '/seller/orders/abc' } }, buyer],
    [{ data: { linkTo: '/admin-dashboard/users' } }, buyer],
  ])('never exposes seller or admin intent to a buyer', (notification, account) => {
    expect(isNotificationAllowedForRole(notification, account)).toBe(false);
  });

  it('lets a seller receive both shopping updates and seller operations', () => {
    expect(isNotificationAllowedForRole({ data: { type: 'order_shipped' } }, seller)).toBe(true);
    expect(isNotificationAllowedForRole({ data: { type: 'price_drop' } }, seller)).toBe(true);
    expect(isNotificationAllowedForRole({ data: { type: 'new_order_received' } }, seller)).toBe(true);
  });

  it('treats server role metadata as authoritative over misleading legacy categories and types', () => {
    const sellerSnapshotWithBuyerType = {
      category: 'order',
      data: { type: 'order_delivered', targetRole: 'seller' },
    };
    expect(isNotificationAllowedForRole(sellerSnapshotWithBuyerType, buyer)).toBe(false);
    expect(isNotificationAllowedForRole(sellerSnapshotWithBuyerType, seller)).toBe(true);
    expect(displayNotificationCategory(sellerSnapshotWithBuyerType, seller)).toBe('seller');

    const buyerSnapshotWithSellerType = {
      category: 'seller',
      data: { type: 'new_order_received', targetRole: 'user' },
    };
    expect(isNotificationAllowedForRole(buyerSnapshotWithSellerType, buyer)).toBe(true);
    expect(isNotificationAllowedForRole(buyerSnapshotWithSellerType, seller)).toBe(false);
    expect(displayNotificationCategory(buyerSnapshotWithSellerType, buyer)).toBe('system');
  });

  it('supports explicit both-role shopping intent and role-scoped broadcast audiences', () => {
    expect(isNotificationAllowedForRole({ targetRole: 'both' }, buyer)).toBe(true);
    expect(isNotificationAllowedForRole({ targetRole: 'both' }, seller)).toBe(true);
    expect(isNotificationAllowedForRole({ audience: 'all_sellers' }, buyer)).toBe(false);
    expect(isNotificationAllowedForRole({ audience: 'all_sellers' }, seller)).toBe(true);
    expect(isNotificationAllowedForRole({
      data: { targetRole: 'unknown', audience: 'all_sellers' },
    }, buyer)).toBe(false);
  });

  it('fails closed for legacy broadcasts that have no recipient role metadata', () => {
    const ambiguous = { category: 'announcement', data: { type: 'admin_broadcast' } };
    expect(isNotificationAllowedForRole(ambiguous, buyer)).toBe(false);
    expect(isNotificationAllowedForRole(ambiguous, seller)).toBe(false);
    expect(isNotificationAllowedForRole(ambiguous, admin)).toBe(false);
  });

  it('rejects a persistent document whose recipient id differs from the active account', () => {
    const leaked = {
      recipientUserId: 'seller-2',
      targetRole: 'seller',
      category: 'seller',
    };
    expect(isNotificationAllowedForRole(leaked, seller)).toBe(false);
  });

  it('keeps admin inboxes limited to admin/system intent', () => {
    expect(isNotificationAllowedForRole({ category: 'system' }, admin)).toBe(true);
    expect(isNotificationAllowedForRole({ data: { type: 'new_order_received' } }, admin)).toBe(false);
    expect(isNotificationAllowedForRole({ data: { type: 'order_delivered' } }, admin)).toBe(false);
    expect(isNotificationAllowedForRole({ data: { linkTo: '/admin-dashboard/users' } }, admin)).toBe(true);
  });

  it('rejects an entry persisted under a different active account', () => {
    const stale = { accountScope: 'seller:seller-1', category: 'system' };
    expect(isNotificationAllowedForRole(stale, buyer)).toBe(false);
    expect(isNotificationAllowedForRole(stale, seller)).toBe(true);
  });

  it('provides only valid filter categories for the active role', () => {
    const buyerKeys = getNotificationCategoriesForRole(buyer).map(({ key }) => key);
    const sellerKeys = getNotificationCategoriesForRole(seller).map(({ key }) => key);
    const adminKeys = getNotificationCategoriesForRole(admin).map(({ key }) => key);
    expect(buyerKeys).not.toContain('seller');
    expect(sellerKeys).toEqual(expect.arrayContaining(['order', 'delivery', 'promo', 'seller', 'system']));
    expect(adminKeys).toEqual(['all', 'system']);
  });

  it('filters a mixed inbox and preserves the correct visible categories', () => {
    const mixed = [
      { id: 'buyer-order', data: { type: 'order_confirmed' }, category: 'order' },
      { id: 'seller-order', data: { type: 'new_order_received' }, category: 'order' },
      { id: 'system', category: 'system' },
    ];
    expect(scopeNotificationsForRole(mixed, buyer).map(({ id }) => id)).toEqual(['buyer-order', 'system']);
    expect(scopeNotificationsForRole(mixed, seller).map(({ id }) => id)).toEqual(['buyer-order', 'seller-order', 'system']);
    expect(displayNotificationCategory(mixed[0], seller)).toBe('order');
    expect(displayNotificationCategory(mixed[1], seller)).toBe('seller');
  });
});
