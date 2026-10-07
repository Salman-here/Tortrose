import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fetchCompleteBuyerReturns,
  inspectBuyerReturnEligibilityResponse,
  inspectBuyerReturnMutationResponse,
  inspectBuyerReturnOrderContext,
  inspectBuyerReturnsResponse,
} from '../src/utils/returnPresentationSafety.js';
import { BUYER_CANCELLABLE_RETURN_STATUSES } from '../src/utils/returns.js';
import { startCancellationRefundRefresh } from '../src/utils/orderCancellationPresentation.js';

const source = readFileSync(new URL('../src/components/layout/BuyerReturnsPanel.jsx', import.meta.url), 'utf8');
// Execute the panel's real hook/control flow with deterministic effects and
// network/timer boundaries. Rendering JSX is outside these refresh regressions.
const constants = source.slice(source.indexOf('const reasonOptions'), source.indexOf('export default function'));
const control = source.slice(source.indexOf('export default function'), source.indexOf('  const moneyLabel'))
  .replace('export default function', 'function');
const dependencyNames = [
  'useCallback', 'useEffect', 'useMemo', 'useRef', 'useState', 'axios', 'toast',
  'getAuthToken', 'fetchCompleteBuyerReturns', 'inspectBuyerReturnEligibilityResponse',
  'inspectBuyerReturnMutationResponse', 'inspectBuyerReturnOrderContext',
  'inspectBuyerReturnsResponse', 'BUYER_CANCELLABLE_RETURN_STATUSES',
  'startCancellationRefundRefresh', 'window', 'document', 'globalThis', 'useReturnDialogAccessibility',
];
const createPanel = new Function(...dependencyNames, `
  const API = '/api/returns';
  ${constants}
  ${control}
    return { load, openRequest, submitReturn, cancelReturn,
      setQuantities, setReasonCategory, setReasonDetails,
      state: { groups, requests, loading, loadError, selectedGroup, quantities,
        reasonCategory, reasonDetails, submitting, cancellingId, selection, returnPending,
        requestKey: requestKeyRef.current } };
  }
  return BuyerReturnsPanel;
`);

const IDS = {
  order: '64b000000000000000000101', item: '64b000000000000000000102',
  product: '64b000000000000000000103', seller: '64b000000000000000000104',
  buyer: '64b000000000000000000105', store: '64b000000000000000000106',
  request: '64b000000000000000000107',
};
const order = {
  _id: IDS.order, orderId: 'ORD-RETURN-1001', currency: 'PKR',
  orderItems: [{ _id: IDS.item, productId: IDS.product, seller: IDS.seller,
    name: 'Verified shoes', image: '', quantity: 2, price: 50, lineSubtotal: 100 }],
  orderSummary: { subtotal: 100, shippingCost: 10, tax: 5, couponDiscount: 5, totalAmount: 110 },
};
const OTHER = { item: '64b000000000000000000112', product: '64b000000000000000000113',
  seller: '64b000000000000000000114', store: '64b000000000000000000116' };
order.orderItems.push({ _id: OTHER.item, productId: OTHER.product, seller: OTHER.seller,
  name: 'Other store item', image: '', quantity: 2, price: 1, lineSubtotal: 2 });
order.orderSummary.subtotal += 2;
order.orderSummary.totalAmount += 2;
const policy = { returnsEnabled: true, returnDuration: 14, refundType: 'full_refund' };
const eligibility = {
  success: true, orderId: order.orderId,
  groups: [{
    seller: { _id: IDS.seller, username: 'seller' },
    store: { _id: IDS.store, storeName: 'Verified Store' },
    policy, policyVariants: ['full_refund'], policySource: 'order_snapshot',
    fulfillment: { status: 'delivered', deliveredAt: '2026-08-01T00:00:00.000Z' },
    eligibilityDeadline: '2026-08-15T00:00:00.000Z', eligible: true, reason: '',
    items: [{
      orderItemId: IDS.item, productId: IDS.product, name: 'Verified shoes', image: '',
      purchasedQuantity: 2, alreadyRequestedQuantity: 1, remainingReturnableQuantity: 1,
      unitPrice: 50, lineSubtotal: 100, returnPolicy: policy,
      eligibilityDeadline: '2026-08-15T00:00:00.000Z', eligible: true, reason: '',
    }],
  }],
};
const otherGroup = structuredClone(eligibility.groups[0]);
otherGroup.seller = { _id: OTHER.seller, username: 'other-seller' };
otherGroup.store = { _id: OTHER.store, storeName: 'Other Store' };
Object.assign(otherGroup.items[0], { orderItemId: OTHER.item, productId: OTHER.product,
  name: 'Other store item', alreadyRequestedQuantity: 0, remainingReturnableQuantity: 2,
  unitPrice: 1, lineSubtotal: 2 });
eligibility.groups.push(otherGroup);
const requested = {
  _id: IDS.request, returnNumber: 'RET-1001-A1B2C3', order: IDS.order, orderId: order.orderId,
  buyer: IDS.buyer, seller: { _id: IDS.seller, username: 'seller' },
  store: { _id: IDS.store, storeName: 'Verified Store' }, storeName: 'Verified Store', currency: 'PKR',
  items: [{ orderItemId: IDS.item, productId: IDS.product, name: 'Verified shoes', image: '',
    quantity: 1, purchasedQuantity: 2, unitPrice: 50, lineSubtotal: 50 }],
  reasonCategory: 'damaged', reasonDetails: 'The item arrived damaged.', status: 'requested',
  statusHistory: [{ status: 'requested', note: 'The item arrived damaged.', changedBy: IDS.buyer,
    actorRole: 'buyer', changedAt: '2026-08-05T00:00:00.000Z' }],
  requestedAt: '2026-08-05T00:00:00.000Z', eligibilityDeadline: '2026-08-15T00:00:00.000Z',
  policySnapshot: policy,
  refund: { itemSubtotal: 50, taxAmount: 2.5, shippingAmount: 10, discountAmount: 2.5, totalAmount: 60 },
  createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:00:00.000Z',
};
const page = requests => ({ success: true, returns: requests,
  pagination: { page: 1, limit: 100, totalReturns: requests.length, totalPages: 1, hasMore: false } });
const snapshot = (status = 'requested', purchase = order) => {
  const value = structuredClone({ eligibility, requests: [requested] });
  value.eligibility.orderId = purchase.orderId;
  value.requests[0].order = purchase._id;
  value.requests[0].orderId = purchase.orderId;
  if (status !== 'requested') {
    value.requests[0].status = status;
    value.requests[0].updatedAt = '2026-08-06T00:00:00.000Z';
    value.requests[0].statusHistory.push({ status, note: 'Verified update', changedBy: IDS.seller,
      actorRole: 'seller', changedAt: '2026-08-06T00:00:00.000Z' });
  }
  if (['cancelled_by_buyer', 'rejected'].includes(status)) {
    value.eligibility.groups[0].items[0].alreadyRequestedQuantity = 0;
    value.eligibility.groups[0].items[0].remainingReturnableQuantity = 2;
  }
  return value;
};
// Drafts are allowed for the primary store while a different store's return
// keeps refresh polling active. They must not model a forbidden second return.
const allowedDraftSnapshot = (status = 'requested') => {
  const value = snapshot(status);
  const request = value.requests[0];
  request.seller = { ...otherGroup.seller };
  request.store = { ...otherGroup.store };
  request.storeName = 'Other Store';
  Object.assign(request.items[0], { orderItemId: OTHER.item, productId: OTHER.product,
    name: 'Other store item', unitPrice: 1, lineSubtotal: 1 });
  request.refund = { itemSubtotal: 1, taxAmount: 0, shippingAmount: 0, discountAmount: 0, totalAmount: 1 };
  value.eligibility.groups[0].items[0].alreadyRequestedQuantity = 0;
  value.eligibility.groups[0].items[0].remainingReturnableQuantity = 2;
  const consumes = !['rejected', 'cancelled_by_buyer'].includes(status);
  value.eligibility.groups[1].items[0].alreadyRequestedQuantity = consumes ? 1 : 0;
  value.eligibility.groups[1].items[0].remainingReturnableQuantity = consumes ? 1 : 2;
  return value;
};
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const networkError = (status) => Object.assign(new Error('Temporary connection failure'), {
  isAxiosError: true, ...(status ? { response: { status } } : {}),
});
const eventTarget = () => {
  const listeners = new Map();
  return {
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    dispatch(name) { for (const fn of listeners.get(name) || []) fn(); },
    count() { return [...listeners.values()].reduce((sum, entries) => sum + entries.size, 0); },
  };
};

const harness = () => {
  const slots = [];
  const pendingEffects = [];
  const timers = new Map();
  const calls = [];
  const notifications = [];
  let timerKey = 0, now = 0, cursor = 0, dirty = false, unmounted = false, lateUpdates = 0;
  let purchase = order, current, getResponse, postResponse = () => new Promise(() => {});
  const window = eventTarget();
  const document = { ...eventTarget(), visibilityState: 'visible', focused: true,
    hasFocus() { return this.focused; } };
  const sameDependencies = (a, b) => a && b && a.length === b.length
    && a.every((value, index) => Object.is(value, b[index]));
  const memo = (fn, dependencies) => {
    const key = cursor++;
    if (!slots[key] || !sameDependencies(slots[key].dependencies, dependencies)) {
      slots[key] = { value: fn(), dependencies };
    }
    return slots[key].value;
  };
  const timerApi = {
    setTimeout(fn, duration) { timers.set(++timerKey, { fn, at: now + duration }); return timerKey; },
    clearTimeout(key) { timers.delete(key); },
  };
  const dependencies = [
    (fn, values) => memo(() => fn, values),
    (effect, values) => {
      const key = cursor++;
      if (!slots[key] || !sameDependencies(slots[key].dependencies, values)) {
        pendingEffects.push({ key, effect, values });
      }
    },
    memo,
    value => { const key = cursor++; slots[key] ||= { current: value }; return slots[key]; },
    initial => {
      const key = cursor++;
      if (!slots[key]) slots[key] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[key].value, value => {
        if (unmounted) lateUpdates++;
        const next = typeof value === 'function' ? value(slots[key].value) : value;
        if (!Object.is(next, slots[key].value)) { slots[key].value = next; dirty = true; }
      }];
    },
    {
      get(url, options) { calls.push({ method: 'get', url, options }); return getResponse(url, options); },
      post(url, body, options) { calls.push({ method: 'post', url, body, options }); return postResponse(url, body, options); },
    },
    { error: message => notifications.push({ type: 'error', message }),
      success: message => notifications.push({ type: 'success', message }) },
    () => 'token', fetchCompleteBuyerReturns, inspectBuyerReturnEligibilityResponse,
    inspectBuyerReturnMutationResponse, inspectBuyerReturnOrderContext,
    inspectBuyerReturnsResponse, BUYER_CANCELLABLE_RETURN_STATUSES,
    (request, active) => startCancellationRefundRefresh(request, active, 5000, timerApi),
    window, document, { crypto: { randomUUID: () => '12345678-1234-4123-8123-123456789abc' } },
    () => ({ current: null }),
  ];
  const Panel = createPanel(...dependencies);
  const render = () => {
    dirty = false;
    cursor = 0;
    current = Panel({ order: purchase, formatMoney: amount => `PKR ${amount}` });
    for (const { key, effect, values } of pendingEffects.splice(0)) {
      slots[key]?.cleanup?.();
      slots[key] = { dependencies: values, cleanup: effect() };
    }
  };
  const flush = async () => {
    for (let step = 0; step < 50; step++) {
      await Promise.resolve();
      if (dirty && !unmounted) render();
    }
  };
  const install = value => { getResponse = async url => ({ data: url === '/api/returns/mine'
    ? page(value.requests) : value.eligibility }); };
  install(snapshot());
  render();
  return {
    get panel() { return current; }, get state() { return current.state; },
    get reads() { return calls.filter(call => call.method === 'get'); },
    get posts() { return calls.filter(call => call.method === 'post'); },
    get lateUpdates() { return lateUpdates; },
    timers, window, document, notifications, flush, install,
    getWith(fn) { getResponse = fn; }, postWith(fn) { postResponse = fn; },
    async navigate(next) { purchase = next; render(); await flush(); },
    async advance(duration) {
      const end = now + duration;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        void next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
    unmount() { unmounted = true; for (const slot of slots) slot?.cleanup?.(); },
    async draft() {
      install(allowedDraftSnapshot());
      await current.load({ notify: false, silent: true });
      await flush();
      current.openRequest(current.state.groups[0]);
      await flush();
      current.setQuantities({ [IDS.item]: 1 });
      current.setReasonCategory('changed_mind');
      current.setReasonDetails('Preserve this detailed return draft during seller status updates.');
      await flush();
    },
  };
};

test('active returns follow seller statuses to Wallet completion and stop without a loading flash', async () => {
  const app = harness();
  await app.flush();
  assert.equal(app.state.requests[0].status, 'requested');
  app.install(snapshot('accepted_pending_payment'));
  await app.advance(5000);
  assert.equal(app.state.requests[0].status, 'accepted_pending_payment');
  assert.equal(app.state.loading, false);
  app.install(snapshot('returned'));
  await app.advance(5000);
  assert.equal(app.state.requests[0].status, 'returned');
  assert.equal(app.state.returnPending, false);
  assert.equal(app.window.count() + app.document.count(), 0);
  await app.advance(30000);
  assert.equal(app.reads.length, 6);
  assert.deepEqual(app.notifications, []);
  for (const call of app.reads) assert.equal(call.options.timeout, 20000);
});

test('hidden and unfocused pages skip checks; focus and visibility resume without duplicate reads', async () => {
  const app = harness();
  await app.flush();
  app.document.visibilityState = 'hidden';
  await app.advance(10000);
  app.document.visibilityState = 'visible';
  app.document.focused = false;
  app.document.dispatch('visibilitychange');
  await app.advance(10000);
  assert.equal(app.reads.length, 2);
  const list = deferred();
  app.getWith(url => url === '/api/returns/mine' ? list.promise : Promise.resolve({ data: eligibility }));
  app.document.focused = true;
  app.window.dispatch('focus');
  app.document.dispatch('visibilitychange');
  await app.flush();
  assert.equal(app.reads.length, 4);
  list.resolve({ data: page(snapshot('approved').requests) });
  await app.flush();
  assert.equal(app.state.requests[0].status, 'approved');
  app.unmount();
});

test('quiet success and temporary transport errors preserve the draft and last verified rows', async () => {
  const app = harness();
  await app.flush();
  await app.draft();
  const group = app.state.selectedGroup;
  app.install(allowedDraftSnapshot('approved'));
  await app.advance(5000);
  assert.equal(app.state.requests[0].status, 'approved');
  for (const status of [undefined, 500, 408, 429]) {
    app.getWith(async () => { throw networkError(status); });
    await app.advance(5000);
    assert.equal(app.state.requests[0].status, 'approved');
    assert.equal(app.state.selectedGroup, group);
    assert.equal(app.state.quantities[IDS.item], 1);
    assert.equal(app.state.reasonCategory, 'changed_mind');
    assert.match(app.state.reasonDetails, /Preserve this detailed/);
    assert.equal(app.state.selection.valid, true);
    assert.equal(app.state.loadError, '');
  }
  assert.deepEqual(app.notifications, []);
  app.unmount();
});

test('unverified and unauthorized snapshots disable actions and preserve an open draft for a verified retry', async () => {
  for (const type of ['financial', 'pagination', 'eligibility', 'mixed-pagination', 'mixed-eligibility', 'mixed-financial', 'auth']) {
    const app = harness();
    await app.flush();
    await app.draft();
    const invalid = snapshot('returned');
    invalid.requests[0].refund.totalAmount = 9999;
    app.getWith(async url => {
      const mine = url === '/api/returns/mine';
      if (type === 'auth') throw networkError(403);
      if (type === 'mixed-pagination' && !mine) throw networkError(500);
      if (type === 'mixed-eligibility' && mine) throw networkError(500);
      if (type === 'mixed-financial' && !mine) throw networkError(500);
      if (mine && ['pagination', 'mixed-pagination'].includes(type)) return { data: { success: true, returns: [requested] } };
      if (!mine && ['eligibility', 'mixed-eligibility'].includes(type)) return { data: { success: true, groups: [] } };
      return { data: mine ? page(type.includes('financial') ? invalid.requests : [requested]) : eligibility };
    });
    await app.advance(5000);
    assert.equal(app.state.requests.length, 0, type);
    assert.equal(app.state.groups.length, 0, type);
    assert.ok(app.state.loadError, type);
    assert.ok(app.state.selectedGroup, type);
    assert.equal(app.state.quantities[IDS.item], 1, type);
    assert.match(app.state.reasonDetails, /Preserve this detailed/, type);
    assert.equal(app.state.selection.valid, false, type);
    await app.panel.submitReturn();
    assert.equal(app.posts.length, 0, type);
    assert.deepEqual(app.notifications, [], type);
    app.install(allowedDraftSnapshot());
    await app.panel.load({ notify: false, silent: true });
    await app.flush();
    assert.equal(app.state.loadError, '', type);
    assert.equal(app.state.selection.valid, true, type);
    assert.equal(app.state.quantities[IDS.item], 1, type);
    assert.ok(app.state.selectedGroup, type);
    app.unmount();
  }
  assert.match(source, /disabled=\{submitting \|\| !selection.valid \|\| Boolean\(loadError\)\}/);
  assert.match(source, /Retry return information/);
});

test('a slow snapshot and a failed sibling stay single-flight until all reads finish', async () => {
  const app = harness();
  await app.flush();
  const list = deferred();
  app.getWith(url => url === '/api/returns/mine'
    ? list.promise : Promise.reject(networkError(500)));
  await app.advance(5000);
  await app.advance(30000);
  app.window.dispatch('focus');
  await app.flush();
  assert.equal(app.reads.length, 4);
  assert.equal(app.state.requests[0].status, 'requested');
  list.resolve({ data: page([requested]) });
  await app.flush();
  app.install(snapshot('returned'));
  await app.advance(5000);
  assert.equal(app.state.requests[0].status, 'returned');
  assert.equal(app.reads.length, 6);
  assert.deepEqual(app.notifications, []);
});

test('buyer cancellation invalidates an older poll and verifies its own terminal snapshot', async () => {
  const app = harness();
  await app.flush();
  const list = deferred(), mutation = deferred();
  app.getWith(url => url === '/api/returns/mine' ? list.promise : Promise.resolve({ data: eligibility }));
  await app.advance(5000);
  app.postWith(() => mutation.promise);
  const cancel = app.panel.cancelReturn(IDS.request);
  await app.flush();
  assert.equal(app.posts.length, 1);
  const cancelled = snapshot('cancelled_by_buyer');
  app.install(cancelled);
  mutation.resolve({ data: { success: true, returnRequest: cancelled.requests[0] } });
  await app.flush();
  assert.equal(app.reads.length, 4);
  list.resolve({ data: page(snapshot('returned').requests) });
  await cancel;
  await app.flush();
  assert.equal(app.state.requests[0].status, 'cancelled_by_buyer');
  assert.equal(app.reads.length, 6);
  assert.deepEqual(app.notifications.map(value => value.type), ['success']);
  await app.advance(30000);
  assert.equal(app.reads.length, 6);
});

test('navigation rejects an old snapshot and unmount cannot publish or reschedule its result', async () => {
  const app = harness();
  await app.flush();
  const list = deferred();
  app.getWith(url => url === '/api/returns/mine' ? list.promise : Promise.resolve({ data: eligibility }));
  await app.advance(5000);
  const nextOrder = { ...order, _id: '64b000000000000000000201', orderId: 'ORD-RETURN-2001' };
  app.install(snapshot('approved', nextOrder));
  await app.navigate(nextOrder);
  assert.equal(app.reads.length, 4);
  list.resolve({ data: page(snapshot('returned').requests) });
  await app.flush();
  assert.equal(app.state.requests[0].order, nextOrder._id);
  assert.equal(app.state.requests[0].status, 'approved');
  const later = deferred();
  app.getWith(url => url === '/api/returns/mine' ? later.promise : Promise.resolve({ data: snapshot('approved', nextOrder).eligibility }));
  await app.advance(5000);
  app.unmount();
  const reads = app.reads.length;
  later.resolve({ data: page(snapshot('returned', nextOrder).requests) });
  await app.flush();
  await app.advance(30000);
  assert.equal(app.reads.length, reads);
  assert.equal(app.lateUpdates, 0);
  assert.equal(app.timers.size, 0);
  assert.equal(app.window.count() + app.document.count(), 0);
});

test('an A to B to A navigation cannot accept an old mutation or clear a newer busy state', async () => {
  const app = harness();
  await app.flush();
  const oldMutation = deferred();
  app.postWith(() => oldMutation.promise);
  const oldCancel = app.panel.cancelReturn(IDS.request);
  await app.flush();
  const nextOrder = { ...order, _id: '64b000000000000000000201', orderId: 'ORD-RETURN-2001' };
  app.install(snapshot('approved', nextOrder));
  await app.navigate(nextOrder);
  app.install(snapshot());
  await app.navigate(order);
  const newerMutation = deferred();
  app.postWith(() => newerMutation.promise);
  const newerCancel = app.panel.cancelReturn(IDS.request);
  await app.flush();
  oldMutation.resolve({ data: { success: true, returnRequest: snapshot('cancelled_by_buyer').requests[0] } });
  await oldCancel;
  await app.flush();
  assert.equal(app.state.cancellingId, IDS.request);
  assert.deepEqual(app.notifications, []);
  app.unmount();
  newerMutation.resolve({ data: { success: true, returnRequest: snapshot('cancelled_by_buyer').requests[0] } });
  await newerCancel;
  await app.flush();
  assert.equal(app.lateUpdates, 0);
});

test('failed creation keeps its idempotent draft recoverable and pauses checks during the retry', async () => {
  const app = harness();
  await app.flush();
  await app.draft();
  app.postWith(async () => { throw networkError(); });
  await app.panel.submitReturn();
  await app.flush();
  assert.equal(app.posts.length, 1);
  assert.ok(app.state.loadError);
  assert.ok(app.state.selectedGroup);
  assert.equal(app.state.quantities[IDS.item], 1);
  app.install(allowedDraftSnapshot());
  await app.panel.load({ notify: false, silent: true });
  await app.flush();
  assert.equal(app.state.selection.valid, true);
  const retry = deferred();
  app.postWith(() => retry.promise);
  const task = app.panel.submitReturn();
  await app.flush();
  assert.equal(app.posts.length, 2);
  assert.equal(app.posts[0].body.requestKey, app.posts[1].body.requestKey);
  assert.equal(app.posts[1].body.reasonCategory, 'changed_mind');
  assert.equal(app.posts[1].body.items[0].quantity, 1);
  const reads = app.reads.length;
  app.window.dispatch('focus');
  await app.advance(15000);
  assert.equal(app.reads.length, reads);
  app.unmount();
  retry.resolve({ data: { success: true, returnRequest: requested } });
  await task;
  assert.equal(app.lateUpdates, 0);
});

test('newly verified eligibility disables a stale draft quantity while retaining its contents', async () => {
  const app = harness();
  await app.flush();
  await app.draft();
  const changed = snapshot('returned');
  const item = changed.eligibility.groups[0].items[0];
  item.alreadyRequestedQuantity = 2;
  item.remainingReturnableQuantity = 0;
  item.eligible = false;
  item.reason = 'All units already requested';
  changed.eligibility.groups[0].eligible = false;
  changed.eligibility.groups[0].reason = 'All units already requested';
  changed.eligibility.groups[0].eligibilityDeadline = null;
  const second = structuredClone(changed.requests[0]);
  second._id = '64b000000000000000000108';
  second.returnNumber = 'RET-1002-D4E5F6';
  second.refund.shippingAmount = 0;
  second.refund.totalAmount = 50;
  changed.requests.push(second);
  const context = inspectBuyerReturnOrderContext(order);
  const inspectedEligibility = inspectBuyerReturnEligibilityResponse(changed.eligibility, context);
  assert.equal(inspectedEligibility.valid, true, inspectedEligibility.errors.join(','));
  const inspectedReturns = inspectBuyerReturnsResponse({ success: true, complete: true, returns: changed.requests,
    totalReturns: 2 }, context, inspectedEligibility);
  assert.equal(inspectedReturns.valid, true, inspectedReturns.errors.join(','));
  app.install(changed);
  await app.advance(5000);
  assert.equal(app.state.requests.length, 2);
  assert.equal(app.state.loadError, '');
  assert.ok(app.state.selectedGroup);
  assert.equal(app.state.quantities[IDS.item], 1);
  assert.match(app.state.reasonDetails, /Preserve this detailed/);
  assert.equal(app.state.selection.valid, false);
  await app.panel.submitReturn();
  assert.equal(app.posts.length, 0);
  app.unmount();
});

test('web and native active statuses match the backend order-and-seller guard exactly', () => {
  const backend = readFileSync(new URL('../../Backend/services/returnService.js', import.meta.url), 'utf8');
  const native = readFileSync(new URL('../../MobileApp/src/components/BuyerReturnsSection.js', import.meta.url), 'utf8');
  const literals = text => text.match(/const UNRESOLVED_RETURN_STATUSES = (?:new Set\()?\[([\s\S]*?)\]/)[1];
  const statuses = text => new Function(`return [${literals(text)}];`)();
  assert.deepEqual(statuses(source), statuses(backend));
  assert.deepEqual(statuses(native), statuses(backend));
  assert.match(source, /disabled=\{Boolean\(activeReturn\)\}/);
});

for (const status of ['requested', 'approved', 'pickup_scheduled', 'picked_up',
  'in_transit_to_seller', 'received_by_seller', 'under_review', 'accepted_pending_payment']) {
  test(`${status} prevents a second same-store request but leaves another store available`, async () => {
    const app = harness();
    app.install(snapshot(status));
    await app.flush();
    assert.equal(app.state.groups[0].eligible, true);
    assert.equal(app.state.groups[0].items[0].remainingReturnableQuantity, 1);
    app.panel.openRequest(app.state.groups[0]);
    await app.flush();
    assert.equal(app.state.selectedGroup, null);
    assert.match(app.notifications[0].message, /RET-1001-A1B2C3 is in progress/);
    app.panel.openRequest(app.state.groups[1]);
    await app.flush();
    assert.equal(app.state.selectedGroup.seller._id, OTHER.seller);
    assert.equal(app.posts.length, 0);
    app.unmount();
  });
}

for (const status of ['returned', 'replacement_approved', 'rejected', 'cancelled_by_buyer']) {
  test(`verified ${status} refresh releases only the active-request block`, async () => {
    const app = harness();
    await app.flush();
    app.panel.openRequest(app.state.groups[0]);
    await app.flush();
    assert.equal(app.state.selectedGroup, null);
    const terminal = snapshot(status);
    if (status === 'replacement_approved') terminal.requests[0].policySnapshot = {
      ...terminal.requests[0].policySnapshot, refundType: 'replacement_only',
    };
    app.install(terminal);
    await app.advance(5000);
    assert.equal(app.state.loadError, '');
    app.panel.openRequest(app.state.groups[0]);
    await app.flush();
    assert.equal(app.state.selectedGroup.seller._id, IDS.seller);
    assert.equal(app.posts.length, 0);
    app.unmount();
  });
}

test('a newly active same-store return disables a saved draft and terminal refresh restores it', async () => {
  const app = harness();
  await app.flush();
  await app.draft();
  app.install(snapshot('approved'));
  await app.advance(5000);
  assert.equal(app.state.selection.valid, false);
  assert.equal(app.state.quantities[IDS.item], 1);
  assert.match(app.state.reasonDetails, /Preserve this detailed/);
  await app.panel.submitReturn();
  assert.equal(app.posts.length, 0);
  assert.match(app.notifications.at(-1).message, /is in progress/);
  app.install(snapshot('returned'));
  await app.advance(5000);
  assert.equal(app.state.selection.valid, true);
  assert.equal(app.state.quantities[IDS.item], 1);
  assert.match(app.state.reasonDetails, /Preserve this detailed/);
  app.unmount();
});

test('a known same-store conflict closes the rejected draft, refreshes and never replays automatically', async () => {
  const app = harness();
  await app.flush();
  await app.draft();
  app.install(snapshot());
  app.postWith(async () => { throw { response: { status: 409, data: {
    code: 'RETURN_REQUEST_ALREADY_OPEN', msg: 'Finish return RET-1001-A1B2C3 before opening another return for this seller.',
  } } }; });
  await app.panel.submitReturn();
  await app.flush();
  assert.equal(app.posts.length, 1);
  assert.equal(app.state.selectedGroup, null);
  assert.equal(app.state.requestKey, null);
  assert.equal(app.state.loadError, '');
  assert.equal(app.state.requests[0].status, 'requested');
  assert.match(app.notifications.at(-1).message, /Finish return RET-1001-A1B2C3.*has been refreshed/);
  await app.advance(15000);
  assert.equal(app.posts.length, 1);
  app.unmount();
});

test('the blocker is scoped to exact order and seller identities, not shared store names', () => {
  const find = new Function(`${constants}; return activeReturnForSeller;`)();
  const request = { order: IDS.order, seller: { _id: IDS.seller }, status: 'requested' };
  assert.equal(find([request], IDS.order, IDS.seller), request);
  assert.equal(find([request], '64b000000000000000000999', IDS.seller), null);
  assert.equal(find([request], IDS.order, OTHER.seller), null);
});

test('a known conflict with an unavailable refresh remains fail-closed without replay', async () => {
  const app = harness();
  await app.flush();
  await app.draft();
  app.getWith(async () => { throw networkError(500); });
  app.postWith(async () => { throw { response: { status: 409, data: {
    code: 'RETURN_REQUEST_ALREADY_OPEN', msg: 'A return is already open for this store.',
  } } }; });
  await app.panel.submitReturn();
  await app.flush();
  assert.equal(app.posts.length, 1);
  assert.equal(app.state.selectedGroup, null);
  assert.equal(app.state.requestKey, null);
  assert.equal(app.state.groups.length, 0);
  assert.ok(app.state.loadError);
  assert.match(app.notifications.at(-1).message, /already open.*Reload return information/);
  await app.advance(15000);
  assert.equal(app.posts.length, 1);
  app.unmount();
});
