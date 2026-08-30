import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createNotificationRequestGuard,
  inspectAnalyticsNotificationResponse,
  inspectNotificationInboxResponse,
  inspectNotificationReadAllResponse,
  inspectNotificationReadResponse,
  isSafeNotificationLink,
  mergeNotificationStreams,
  resolveNotificationAccount,
  resolveNotificationSurfaceAccount,
} from '../src/utils/notificationInboxSafety.js';

const BUYER_ID = '507f1f77bcf86cd799439011';
const SELLER_ID = '507f1f77bcf86cd799439012';
const ADMIN_ID = '507f1f77bcf86cd799439013';
const NOTIFICATION_ID = '507f1f77bcf86cd799439014';
const ORDER_ID = '507f1f77bcf86cd799439015';
const SECOND_NOTIFICATION_ID = '507f1f77bcf86cd799439016';
const NOW = '2026-08-26T10:00:00.000Z';

const buyerAccount = resolveNotificationAccount({ _id: BUYER_ID, role: 'user' }, 'user');
const sellerAccount = resolveNotificationAccount({ id: SELLER_ID, role: 'seller' }, 'seller');
const adminAccount = resolveNotificationAccount({ _id: ADMIN_ID, role: 'admin' }, 'admin');

const durableItem = (overrides = {}) => ({
  _id: NOTIFICATION_ID,
  user: BUYER_ID,
  title: 'Payment received',
  body: 'Charged total: PKR 1,880.00.',
  category: 'payment',
  source: 'system',
  targetRole: 'user',
  audience: 'specific',
  linkTo: `/user-dashboard/order/detail/${ORDER_ID}`,
  read: false,
  eventKey: `order:${ORDER_ID}:paid:buyer:v1`,
  eventType: 'order.paid',
  aggregateType: 'Order',
  aggregateId: ORDER_ID,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const inbox = (overrides = {}) => ({
  account: { userId: BUYER_ID, role: 'user' },
  items: [durableItem()],
  unread: 1,
  ...overrides,
});

test('notification accounts require one canonical id, an exact role, and no conflicting identity', () => {
  assert.deepEqual(buyerAccount, { userId: BUYER_ID, role: 'user', key: `user:${BUYER_ID}` });
  assert.deepEqual(sellerAccount, { userId: SELLER_ID, role: 'seller', key: `seller:${SELLER_ID}` });
  assert.equal(resolveNotificationAccount({ _id: BUYER_ID, id: SELLER_ID, role: 'user' }), null);
  assert.equal(resolveNotificationAccount({ _id: BUYER_ID.toUpperCase(), role: 'user' }), null);
  assert.equal(resolveNotificationAccount({ _id: BUYER_ID, role: 'seller' }, 'user'), null);
  assert.equal(resolveNotificationAccount({ _id: BUYER_ID, role: 'User' }), null);
  assert.deepEqual(
    resolveNotificationSurfaceAccount({ _id: SELLER_ID, role: 'seller' }, 'buyer'),
    sellerAccount,
    'a seller account must retain its buyer-commerce notification surface',
  );
  assert.deepEqual(resolveNotificationSurfaceAccount({ _id: SELLER_ID, role: 'seller' }, 'seller'), sellerAccount);
  assert.equal(resolveNotificationSurfaceAccount({ _id: BUYER_ID, role: 'user' }, 'seller'), null);
  assert.equal(resolveNotificationSurfaceAccount({ _id: ADMIN_ID, role: 'admin' }, 'buyer'), null);
});

test('seller buyer receipts and seller-business notifications stay on exact server-bound surfaces', () => {
  const sellerBusiness = durableItem({
    user: SELLER_ID,
    targetRole: 'seller',
    title: 'Seller payout available',
    linkTo: '/seller-dashboard/payments',
    eventKey: 'seller:payout:available:v1',
  });
  const buyerReceipt = durableItem({
    _id: SECOND_NOTIFICATION_ID,
    user: SELLER_ID,
    targetRole: 'both',
    title: 'Your purchase was paid',
    linkTo: `/user-dashboard/order/detail/${ORDER_ID}`,
    eventKey: `order:${ORDER_ID}:paid:buyer-seller-account:v1`,
  });

  const sellerSurface = inspectNotificationInboxResponse({
    account: { userId: SELLER_ID, role: 'seller', surface: 'seller' },
    items: [sellerBusiness],
    unread: 1,
  }, sellerAccount, { surface: 'seller' });
  assert.equal(sellerSurface.valid, true, sellerSurface.errors.join(', '));
  assert.equal(sellerSurface.items[0]._audienceSurface, 'seller');
  assert.equal(sellerSurface.items[0].linkTo, '/seller-dashboard/payments');
  assert.equal(sellerSurface.unread, 1);

  const buyerSurface = inspectNotificationInboxResponse({
    account: { userId: SELLER_ID, role: 'seller', surface: 'buyer' },
    items: [buyerReceipt],
    unread: 1,
  }, sellerAccount, { surface: 'buyer' });
  assert.equal(buyerSurface.valid, true, buyerSurface.errors.join(', '));
  assert.equal(buyerSurface.items[0]._audienceSurface, 'buyer');
  assert.equal(buyerSurface.items[0].linkTo, `/user-dashboard/order/detail/${ORDER_ID}`);
  const markedBuyerReceipt = { ...buyerReceipt, read: true, readAt: NOW };
  const markedBuyerReceiptResponse = {
    account: { userId: SELLER_ID, role: 'seller', surface: 'buyer' },
    notification: markedBuyerReceipt,
  };
  assert.equal(inspectNotificationReadResponse(
    markedBuyerReceiptResponse,
    sellerAccount,
    SECOND_NOTIFICATION_ID,
    { surface: 'buyer' },
  ).valid, true);
  assert.equal(inspectNotificationReadResponse(
    markedBuyerReceiptResponse,
    sellerAccount,
    SECOND_NOTIFICATION_ID,
    { surface: 'seller' },
  ).valid, false, 'a buyer receipt read response cannot mutate the seller-business surface');

  const contaminatedSellerPayload = {
    account: { userId: SELLER_ID, role: 'seller', surface: 'seller' },
    items: [sellerBusiness, buyerReceipt],
    unread: 2,
  };
  const contaminated = inspectNotificationInboxResponse(
    contaminatedSellerPayload,
    sellerAccount,
    { surface: 'seller' },
  );
  assert.equal(contaminated.valid, false, 'targetRole both must never enter a seller-business response');
  assert.deepEqual(contaminated.items, [], 'a cross-surface response must fail closed as a whole');

  const misroutedBuyer = structuredClone(buyerReceipt);
  misroutedBuyer.linkTo = '/seller-dashboard/payments';
  const unsafe = inspectNotificationInboxResponse({
    account: { userId: SELLER_ID, role: 'seller', surface: 'buyer' },
    items: [misroutedBuyer],
    unread: 1,
  }, sellerAccount, { surface: 'buyer' });
  assert.equal(unsafe.valid, false, 'buyer-audience rows cannot navigate into seller management');

  for (const wrongSurface of [undefined, 'seller', 'admin']) {
    const payload = {
      account: { userId: SELLER_ID, role: 'seller', ...(wrongSurface ? { surface: wrongSurface } : {}) },
      items: [buyerReceipt],
      unread: 1,
    };
    assert.equal(
      inspectNotificationInboxResponse(payload, sellerAccount, { surface: 'buyer' }).valid,
      false,
      `response surface ${String(wrongSurface)} must not be trusted as buyer data`,
    );
  }
});

test('durable inbox accepts only an internally consistent active-account response', () => {
  const inspected = inspectNotificationInboxResponse(inbox(), buyerAccount);
  assert.equal(inspected.valid, true, inspected.errors.join(', '));
  assert.equal(inspected.unread, 1);
  assert.equal(inspected.items[0].inboxId, NOTIFICATION_ID);
  assert.equal(inspected.items[0].description, 'Charged total: PKR 1,880.00.');
  assert.equal(inspected.items[0]._stream, 'durable');

  const subscription = inspectNotificationInboxResponse(inbox({
    items: [durableItem({ category: 'subscription' })],
  }), buyerAccount);
  assert.equal(subscription.valid, true, subscription.errors.join(', '));
  assert.equal(subscription.items[0].category, 'system', 'subscription rows must never be mislabeled as store alerts');

  const corruptions = [
    payload => { payload.account.userId = SELLER_ID; },
    payload => { payload.account.role = 'seller'; },
    payload => { payload.items[0].user = SELLER_ID; },
    payload => { payload.items[0].targetRole = 'seller'; },
    payload => { payload.items[0].audience = 'all_sellers'; },
    payload => { payload.items[0].read = 'false'; },
    payload => { payload.items[0].createdAt = 'not-a-date'; },
    payload => { payload.items[0].linkTo = '/admin-dashboard/payments'; },
    payload => { payload.items.push(structuredClone(payload.items[0])); },
    payload => { payload.unread = 0; },
    payload => { payload.unread = '1'; },
  ];
  for (const mutate of corruptions) {
    const payload = structuredClone(inbox());
    mutate(payload);
    const failed = inspectNotificationInboxResponse(payload, buyerAccount);
    assert.equal(failed.valid, false, JSON.stringify(payload));
    assert.deepEqual(failed.items, [], 'a contaminated response must fail closed as a whole');
    assert.equal(failed.unread, null);
  }
});

test('legacy role rules and links are mirrored client-side without widening audiences', () => {
  const sellerLegacy = durableItem({
    user: SELLER_ID,
    targetRole: null,
    audience: 'specific',
    category: 'order',
    linkTo: '/seller-dashboard/order-management',
  });
  const sellerPayload = {
    account: { userId: SELLER_ID, role: 'seller' },
    items: [sellerLegacy],
    unread: 1,
  };
  assert.equal(inspectNotificationInboxResponse(sellerPayload, sellerAccount).valid, true);

  sellerPayload.items[0].source = 'admin_broadcast';
  assert.equal(inspectNotificationInboxResponse(sellerPayload, sellerAccount).valid, false);
  const sameSiteLegacy = structuredClone(sellerPayload);
  sameSiteLegacy.items[0].source = 'system';
  sameSiteLegacy.items[0].linkTo = 'https://rozare.com/seller-dashboard/payments';
  const sameSiteInspected = inspectNotificationInboxResponse(sameSiteLegacy, sellerAccount);
  assert.equal(sameSiteInspected.valid, true, sameSiteInspected.errors.join(', '));
  assert.equal(sameSiteInspected.items[0].linkTo, '/seller-dashboard/payments');
  assert.equal(isSafeNotificationLink('/seller-dashboard/payments', 'seller'), true);
  assert.equal(isSafeNotificationLink('/user-dashboard/wallet', 'seller'), false);
  assert.equal(isSafeNotificationLink('//evil.example/path', 'seller'), false);
  assert.equal(isSafeNotificationLink('https://evil.example/seller-dashboard/payments', 'seller'), false);
  assert.equal(isSafeNotificationLink('/seller-dashboard/%0Apayments', 'seller'), false);

  const adminLegacy = durableItem({
    user: ADMIN_ID,
    targetRole: null,
    audience: 'specific',
    category: 'system',
    linkTo: '/admin-dashboard/payments',
  });
  assert.equal(inspectNotificationInboxResponse({
    account: { userId: ADMIN_ID, role: 'admin' }, items: [adminLegacy], unread: 1,
  }, adminAccount).valid, true);
});

test('read and read-all responses are verified before local state can change', () => {
  const marked = durableItem({ read: true, readAt: NOW });
  const markedResponse = {
    account: { userId: BUYER_ID, role: 'user', surface: 'buyer' },
    notification: marked,
  };
  const inspected = inspectNotificationReadResponse(
    markedResponse,
    buyerAccount,
    NOTIFICATION_ID,
    { surface: 'buyer' },
  );
  assert.equal(inspected.valid, true, inspected.errors.join(', '));
  assert.equal(inspectNotificationReadResponse(markedResponse, buyerAccount, SELLER_ID, { surface: 'buyer' }).valid, false);
  assert.equal(inspectNotificationReadResponse({ ...markedResponse, notification: { ...marked, user: SELLER_ID } }, buyerAccount, NOTIFICATION_ID, { surface: 'buyer' }).valid, false);
  assert.equal(inspectNotificationReadResponse({ notification: marked }, buyerAccount, NOTIFICATION_ID, { surface: 'buyer' }).valid, false);
  for (const account of [
    { userId: SELLER_ID, role: 'user', surface: 'buyer' },
    { userId: BUYER_ID, role: 'seller', surface: 'buyer' },
    { userId: BUYER_ID, role: 'user', surface: 'seller' },
  ]) {
    assert.equal(inspectNotificationReadResponse(
      { ...markedResponse, account },
      buyerAccount,
      NOTIFICATION_ID,
      { surface: 'buyer' },
    ).valid, false);
  }
  const readAll = {
    ok: true,
    account: { userId: BUYER_ID, role: 'user', surface: 'buyer' },
  };
  assert.equal(inspectNotificationReadAllResponse(readAll, buyerAccount, { surface: 'buyer' }).valid, true);
  assert.equal(inspectNotificationReadAllResponse({ ...readAll, ok: 'true' }, buyerAccount, { surface: 'buyer' }).valid, false);
  assert.equal(inspectNotificationReadAllResponse({ ...readAll, account: { ...readAll.account, userId: SELLER_ID } }, buyerAccount, { surface: 'buyer' }).valid, false);
  assert.equal(inspectNotificationReadAllResponse({ ...readAll, account: { ...readAll.account, surface: 'seller' } }, buyerAccount, { surface: 'buyer' }).valid, false);
  assert.equal(inspectNotificationReadAllResponse({}, buyerAccount, { surface: 'buyer' }).valid, false);
});

test('request generations reject account-switch and same-account out-of-order responses', () => {
  const guard = createNotificationRequestGuard();
  guard.activate(buyerAccount.key);
  const buyerRequest = guard.begin(buyerAccount.key);
  guard.activate(sellerAccount.key);
  const sellerRequestOne = guard.begin(sellerAccount.key);
  assert.equal(guard.isCurrent(buyerRequest, buyerAccount.key), false);
  assert.equal(guard.isCurrent(buyerRequest, sellerAccount.key), false);
  assert.equal(guard.isCurrent(sellerRequestOne, sellerAccount.key), true);

  const sellerRequestTwo = guard.begin(sellerAccount.key);
  assert.equal(guard.isCurrent(sellerRequestOne, sellerAccount.key), false);
  assert.equal(guard.isCurrent(sellerRequestTwo, sellerAccount.key), true);
  guard.invalidate();
  assert.equal(guard.isCurrent(sellerRequestTwo, sellerAccount.key), false);
});

test('seller analytics must echo the exact seller and role and use a strict alert schema', () => {
  const payload = {
    sellerId: SELLER_ID,
    audienceRole: 'seller',
    notifications: [{
      id: `paid-${ORDER_ID}`,
      type: 'success',
      category: 'payment',
      title: 'Payment received',
      description: 'PKR 1,880.00',
      time: NOW,
      read: false,
      orderId: ORDER_ID,
    }],
  };
  const inspected = inspectAnalyticsNotificationResponse(payload, sellerAccount, 'seller');
  assert.equal(inspected.valid, true, inspected.errors.join(', '));
  assert.equal(inspected.items[0].linkTo, `/seller-dashboard/order/${ORDER_ID}`);

  for (const mutate of [
    value => { value.sellerId = BUYER_ID; },
    value => { value.audienceRole = 'admin'; },
    value => { value.notifications[0].description = 1880; },
    value => { value.notifications[0].orderId = 'bad'; },
    value => { value.notifications[0].category = 'store'; },
    value => { value.notifications[0].read = 0; },
  ]) {
    const value = structuredClone(payload);
    mutate(value);
    assert.equal(inspectAnalyticsNotificationResponse(value, sellerAccount, 'seller').valid, false);
  }
});

test('admin analytics are accepted only under a verified active admin authority', () => {
  const payload = {
    msg: 'Notifications fetched',
    notifications: [{
      id: `paid-${ORDER_ID}`,
      type: 'success',
      category: 'payment',
      title: 'Payment received',
      description: 'PKR 1,880.00',
      time: NOW,
      read: false,
      orderId: ORDER_ID,
    }],
  };
  const inspected = inspectAnalyticsNotificationResponse(payload, adminAccount, 'admin');
  assert.equal(inspected.valid, true, inspected.errors.join(', '));
  assert.equal(inspected.items[0].linkTo, `/admin-dashboard/order/${ORDER_ID}`);
  assert.equal(inspectAnalyticsNotificationResponse(payload, sellerAccount, 'admin').valid, false);
  assert.equal(inspectAnalyticsNotificationResponse({
    ...payload,
    notifications: [{ ...payload.notifications[0], category: 'seller' }],
  }, adminAccount, 'admin').valid, false);
});

test('durable event identity dedupes analytics and keeps the frozen financial body', () => {
  const durable = inspectNotificationInboxResponse(inbox(), buyerAccount).items[0];
  const analytics = {
    id: `paid-${ORDER_ID}`,
    type: 'success',
    category: 'payment',
    title: 'Payment received',
    description: 'USD 999.99 recomputed incorrectly',
    time: '2026-08-26T11:00:00.000Z',
    read: false,
    eventKey: '',
    eventType: 'order.paid',
    aggregateType: 'Order',
    aggregateId: ORDER_ID,
    linkTo: `/user-dashboard/order/detail/${ORDER_ID}`,
    _stream: 'analytics',
  };
  const merged = mergeNotificationStreams({ durableItems: [durable], analyticsItems: [analytics] });
  assert.equal(merged.length, 1);
  assert.equal(merged[0]._stream, 'durable');
  assert.equal(merged[0].description, 'Charged total: PKR 1,880.00.');

  const sameEventKey = { ...analytics, id: 'another-id', eventKey: durable.eventKey, eventType: '', aggregateType: '', aggregateId: '' };
  assert.equal(mergeNotificationStreams({ durableItems: [durable], analyticsItems: [sameEventKey] }).length, 1);
});

test('distinct durable seller fulfillment transitions for one order all remain visible', () => {
  const first = inspectNotificationInboxResponse(inbox({
    items: [durableItem({
      title: 'Seller is preparing your items',
      body: 'Nova Nest Market is preparing your items.',
      category: 'order',
      eventKey: `order:${ORDER_ID}:seller-fulfillment:first:buyer:v1`,
      eventType: 'order.seller_fulfillment_updated',
    })],
  }), buyerAccount).items[0];
  const second = inspectNotificationInboxResponse(inbox({
    items: [durableItem({
      _id: SECOND_NOTIFICATION_ID,
      title: 'Seller shipped your items',
      body: 'Pulse Peak Gear shipped your items.',
      category: 'order',
      eventKey: `order:${ORDER_ID}:seller-fulfillment:second:buyer:v1`,
      eventType: 'order.seller_fulfillment_updated',
      createdAt: '2026-08-26T10:05:00.000Z',
      updatedAt: '2026-08-26T10:05:00.000Z',
    })],
  }), buyerAccount).items[0];
  const syntheticFallback = {
    id: `seller-fulfillment-${ORDER_ID}`,
    type: 'info',
    category: 'order',
    title: 'Synthetic seller update',
    description: 'This fallback must not replace durable history.',
    time: '2026-08-26T10:10:00.000Z',
    read: false,
    eventKey: '',
    eventType: 'order.seller_fulfillment_updated',
    aggregateType: 'Order',
    aggregateId: ORDER_ID,
    linkTo: `/user-dashboard/order/detail/${ORDER_ID}`,
    _stream: 'analytics',
  };

  const merged = mergeNotificationStreams({
    durableItems: [second, first],
    analyticsItems: [syntheticFallback],
  });
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map(item => item.eventKey), [second.eventKey, first.eventKey]);
  assert.ok(merged.every(item => item._stream === 'durable'));
});

test('buyer notification route is accessible and all web surfaces use the guarded durable inbox', () => {
  const routes = readFileSync(new URL('../src/routes/AppRoutes.jsx', import.meta.url), 'utf8');
  const buyerDashboard = readFileSync(new URL('../src/components/layout/UserDashboard.jsx', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../src/components/layout/NotificationsPage.jsx', import.meta.url), 'utf8');
  const admin = readFileSync(new URL('../src/components/layout/AdminDashboard.jsx', import.meta.url), 'utf8');
  const seller = readFileSync(new URL('../src/components/layout/SellerDashboard.jsx', import.meta.url), 'utf8');
  const bellHook = readFileSync(new URL('../src/hooks/useNotificationBellInbox.js', import.meta.url), 'utf8');

  assert.match(routes, /path=\{'\/user-dashboard'\}[\s\S]*?<ProtectedRoute>[\s\S]*?<UserDashboard/);
  assert.match(routes, /path='\/user-dashboard\/notifications'[\s\S]*?<ProtectedRoute><NotificationsPage/);
  assert.doesNotMatch(routes, /path='\/user-dashboard\/notifications'[^\n]*role=\{'user'\}/);
  assert.match(buyerDashboard, /dashboardRole:\s*'user'/);
  assert.match(buyerDashboard, /link:\s*'\/user-dashboard\/notifications'/);
  assert.match(page, /inspectNotificationInboxResponse\([\s\S]*?inboxResult\.value\.data,[\s\S]*?surface: notificationSurface/);
  assert.match(page, /params:\s*\{ surface: notificationSurface \}/);
  assert.match(page, /api\/notifications\/\$\{notification\.inboxId\}\/read/);
  const patchStart = page.indexOf('const response = await axios.patch(');
  const readInspectorStart = page.indexOf('const inspected = inspectNotificationReadResponse(', patchStart);
  assert.notEqual(patchStart, -1);
  assert.notEqual(readInspectorStart, -1);
  assert.match(
    page.slice(patchStart, readInspectorStart),
    /params:\s*\{ surface: notificationSurface \}/,
    'the individual read PATCH itself must carry the active notification surface',
  );
  assert.match(page, /api\/notifications\/read-all/);
  assert.doesNotMatch(page, /readNotifIds|localStorage\.setItem/);
  assert.match(admin, /useNotificationBellInbox\(\{ currentUser, role: 'admin' \}\)/);
  assert.match(seller, /useNotificationBellInbox\(\{ currentUser, role: 'seller' \}\)/);
  assert.match(bellHook, /api\/notifications\/me/);
  assert.match(bellHook, /params:\s*\{ surface: inboxSurface \}/);
  assert.match(bellHook, /mergeNotificationStreams\(\{ durableItems, analyticsItems \}\)/);
});
