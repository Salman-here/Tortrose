import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SUBSCRIPTION_STATUS_CHANGED, notifySubscriptionStatusChanged, subscriptionStatusEventMatchesAccount } from '../src/utils/subscriptionStatusRefresh.js';

test('billing invalidation contains only the authenticated account key', () => {
  const events = [];
  const target = { CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } }, dispatchEvent: event => events.push(event) };
  assert.equal(notifySubscriptionStatusChanged('seller-a', target), true);
  assert.equal(events[0].type, SUBSCRIPTION_STATUS_CHANGED);
  assert.deepEqual(events[0].detail, { accountKey: 'seller-a' });
  assert.equal(subscriptionStatusEventMatchesAccount(events[0], 'seller-a'), true);
  assert.equal(subscriptionStatusEventMatchesAccount(events[0], 'seller-b'), false);
  assert.equal(subscriptionStatusEventMatchesAccount(null, 'seller-a'), false);
  assert.equal(subscriptionStatusEventMatchesAccount(events[0], ''), false);
  assert.equal(notifySubscriptionStatusChanged('', target), false);
  assert.equal(notifySubscriptionStatusChanged('seller-a', null), false);
  assert.equal(events.length, 1);
});
test('dashboard re-reads server status with stale request and account guards', () => {
  const shell = readFileSync(new URL('../src/components/layout/SellerDashboard.jsx', import.meta.url), 'utf8');
  assert.match(shell, /subscriptionStatusEventMatchesAccount\(event, subscriptionAccountKey\)/);
  assert.match(shell, /requestId === generation && !controller.signal.aborted/);
  assert.match(shell, /\[subscriptionAccountKey, location.pathname\]/);
  assert.match(shell, /window.removeEventListener\(SUBSCRIPTION_STATUS_CHANGED, invalidate\)/);
  const page = readFileSync(new URL('../src/components/layout/SellerSubscription.jsx', import.meta.url), 'utf8');
  assert.match(page, /const \{ currentUser \} = useAuth\(\)/);
  assert.match(page, /notifySubscriptionStatusChanged\(subscriptionAccountKey\)/);
  assert.match(page, /\[requestedCouponParam, subscriptionAccountKey\]/);
});
