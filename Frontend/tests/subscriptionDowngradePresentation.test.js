import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatUsdCents, getSubscriptionPricing } from '../src/utils/subscriptionPricing.js';
import { calendarMonthsRemaining, subscriptionStatusConfirmsEntitlement } from '../src/utils/subscriptionPlanChange.js';

// Render the entire real component, not an extracted banner that could be
// unreachable inside a contradictory parent condition.
const source = readFileSync(new URL('../src/components/layout/SellerSubscription.jsx', import.meta.url), 'utf8');
const compiled = transformSync(source.replaceAll('import.meta.env.VITE_API_URL', '"https://qa.invalid/"'),
  { loader: 'jsx', format: 'cjs' }).code;
const pricing = { schemaVersion: 1, currency: 'USD', metaAdsAddonCents: 400,
  starter: { plan: 'starter', planName: 'Rozare Starter', listAmountCents: 1175, standardAmountCents: 999,
    founderAmountCents: 599, advertisedDiscountPercent: 15, freePeriodDays: 30 },
  elite: { plan: 'elite', planName: 'Rozare Elite', listAmountCents: 3093, standardAmountCents: 2165,
    founderAmountCents: 1299, advertisedDiscountPercent: 30, freePeriodDays: 45 } };
const base = { status: 'active', plan: 'elite', billingProvider: 'safepay', metaAdsIncluded: false,
  currentPeriodEnd: '2027-11-08T03:53:39.183Z', freePeriodEndDate: '2026-10-08T03:53:39.183Z',
  pendingDowngrade: 'starter', cancelledAt: '2026-10-08T05:00:00Z', hasUsedFreePeriod: true, pricing };
const nodes = element => !element || typeof element !== 'object' ? []
  : [element, ...React.Children.toArray(element.props?.children).flatMap(nodes)];
const label = element => React.Children.toArray(element?.props?.children)
  .map(child => typeof child === 'string' ? child : typeof child === 'object' ? label(child) : '').join('');

function fixture(overrides = {}, busy = false) {
  const sub = { ...base, ...overrides }, calls = { posts: [], gets: 0 };
  const states = [sub, false, '', null, false, false, false, false, busy,
    false, false, false, sub.metaAdsIncluded, '', false, null];
  let stateIndex = 0;
  const fakeReact = { ...React, useState: () => [states[stateIndex++], () => {}],
    useEffect() {}, useCallback: fn => fn, useRef: value => ({ current: value }) };
  const motion = new Proxy({}, { get: (_target, tag) => ({ children, className, style, onClick, disabled }) =>
    React.createElement(tag, { className, style, onClick, disabled }, children) });
  const axios = { post: async (...args) => { calls.posts.push(args); return { data: { msg: 'Undone' } }; },
    get: async () => { calls.gets++; return { data: { subscription: sub } }; } };
  const imports = {
    react: fakeReact, 'framer-motion': { motion, AnimatePresence: ({ children }) => children },
    'lucide-react': new Proxy({}, { get: () => () => null }), axios,
    '../subscription/SafepayBillingReview': { useSafepaySubscriptionBilling: () => ({ review: null, busy: false }) },
    'react-toastify': { toast: { success() {}, error() {}, info() {} } },
    'react-router-dom': { useSearchParams: () => [new URLSearchParams()] },
    '../../utils/cookieHelper': { getAuthToken: () => 'fixture-token' },
    '../../utils/subscriptionPricing': { formatUsdCents, getSubscriptionPricing },
    '../../utils/subscriptionStatusRefresh': { notifySubscriptionStatusChanged() {} },
    '../../contexts/AuthContext': { useAuth: () => ({ currentUser: { _id: 'qa-seller' } }) },
    '../../utils/subscriptionPlanChange': { calendarMonthsRemaining, subscriptionStatusConfirmsEntitlement },
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, AbortController, console,
    require: path => { assert.ok(Object.hasOwn(imports, path), `Unexpected dependency: ${path}`); return imports[path]; } });
  const tree = module.exports.default();
  return { calls, tree, html: renderToStaticMarkup(tree), button: name => nodes(tree).find(node =>
    (node.type === 'button' || node.props?.onClick) && label(node).trim() === name) };
}

for (const status of ['active', 'free_period']) {
  test(`${status} Elite has a reachable downgrade notice and undo button`, () => {
    const f = fixture({ status });
    assert.match(f.html, /Switch to Starter scheduled/);
    assert.match(f.html, /Keep Elite/);
    assert.ok(f.button('Keep Elite'));
    assert.doesNotMatch(f.html, /Cancellation Scheduled/);
  });
}

test('Keep Elite invokes only the owned existing-agreement undo route then refreshes status', async () => {
  const f = fixture();
  await f.button('Keep Elite').props.onClick();
  assert.equal(f.calls.posts.length, 1);
  assert.equal(f.calls.posts[0][0], 'https://qa.invalid/api/subscription/cancel-downgrade');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.posts[0][1])), {});
  assert.equal(f.calls.gets, 1);
});

test('undo is disabled while its request is processing', () => {
  const f = fixture({}, true);
  assert.match(f.html, /Keeping Elite/);
  assert.equal(f.button('Keeping Elite...')?.props.disabled, true);
});

test('the scheduled Starter control cannot submit a redundant downgrade', () => {
  const f = fixture();
  assert.equal(f.button('Starter scheduled')?.props.disabled, true);
  assert.doesNotMatch(f.html, />Downgrade to Starter</);
});

test('a seller can still cancel all future renewal while a downgrade is scheduled', () => {
  assert.match(fixture().html, /Cancel Subscription/);
});

test('ordinary Elite, Starter, ended and trial states do not show a false scheduled switch', () => {
  for (const overrides of [{ pendingDowngrade: null, cancelledAt: null },
    { pendingDowngrade: null },
    { plan: 'starter', pendingDowngrade: null, cancelledAt: null },
    { status: 'cancelled' }, { status: 'trial' }]) {
    const f = fixture(overrides);
    assert.doesNotMatch(f.html, /Switch to Starter scheduled|Keep Elite/);
  }
});

test('the scheduled switch uses the funded period end, not the expired introductory date', () => {
  const f = fixture();
  const start = f.html.indexOf('Switch to Starter scheduled');
  const notice = f.html.slice(start, f.html.indexOf('</section>', start));
  assert.match(notice, /2027/);
  assert.doesNotMatch(notice, /2026/);
});

test('a missing or invalid period date is not replaced with an expired introductory date', () => {
  for (const currentPeriodEnd of [null, 'not-a-date']) {
    const f = fixture({ currentPeriodEnd });
    const start = f.html.indexOf('Switch to Starter scheduled');
    const notice = f.html.slice(start, f.html.indexOf('</section>', start));
    assert.match(notice, /the current period ends/);
    assert.doesNotMatch(notice, /Invalid Date|2026/);
  }
});
