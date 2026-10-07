import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';
import { getReturnItemVariantLabels } from '../src/utils/returnItemVariants.js';
import { inspectReturnPresentationSnapshot } from '../src/utils/returnPresentationSafety.js';
import { RETURN_STATUS_LABELS, RETURN_STATUS_TRANSITIONS, returnResolutionLabel, returnStatusTone, returnGroupPolicyLabel } from '../src/utils/returns.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sellerSource = read('../src/components/layout/ReturnOrdersPanel.jsx');
const buyerSource = read('../src/components/layout/BuyerReturnsPanel.jsx');
const transpile = source => transformSync(source, { loader: 'jsx', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment' }).code;
const motionDiv = props => React.createElement('div', Object.fromEntries(Object.entries(props).filter(([key]) =>
  ['role', 'id', 'className', 'style', 'tabIndex', 'aria-modal', 'aria-busy', 'aria-labelledby'].includes(key))), props.children);
const allNodes = element => !element || typeof element !== 'object' ? []
  : [element, ...React.Children.toArray(element.props?.children).flatMap(allNodes)];

const item = { orderItemId: '64b000000000000000000002', name: 'Mug', quantity: 1, purchasedQuantity: 1,
  unitPrice: 1000, lineSubtotal: 1000, selectedColor: 'Blue', selectedOptions: { Color: 'Blue', Size: 'Large' } };
const request = { _id: '64b000000000000000000001', returnNumber: 'RET-C1', orderId: 'ORD-C1',
  status: 'under_review', currency: 'PKR', items: [item], reasonDetails: 'The handle is damaged.',
  policySnapshot: { returnsEnabled: true, returnDuration: 14, refundType: 'full_refund' },
  refund: { itemSubtotal: 1000, taxAmount: 0, shippingAmount: 0, discountAmount: 0, totalAmount: 1000 }, statusHistory: [] };

function baseContext() {
  const calls = { closed: [], portals: 0, writes: [] };
  const context = { React, motion: { div: motionDiv }, AnimatePresence: ({ children }) => React.createElement(React.Fragment, null, children),
    getReturnItemVariantLabels, inspectReturnPresentationSnapshot, RETURN_STATUS_LABELS, RETURN_STATUS_TRANSITIONS, returnResolutionLabel, returnStatusTone,
    API: '/api/returns', document: { body: {} }, useAuth: () => ({ currentUser: { _id: 'seller-1' } }),
    useCallback: fn => fn, useEffect() {}, useRef: value => ({ current: value }),
    useReturnDialogAccessibility: () => ({ current: null }),
    createPortal: element => { calls.portals++; return element; },
    axios: { post: (...args) => calls.writes.push(args), patch: (...args) => calls.writes.push(args) },
    getAuthToken: () => 'test-token', toast: { error() {}, success() {}, info() {} },
  };
  for (const icon of ['ArrowRight', 'CheckCircle', 'CreditCard', 'Loader2', 'RefreshCw', 'RotateCcw', 'Search', 'WalletCards', 'X', 'XCircle', 'Check', 'Package']) context[icon] = () => null;
  return { context, calls };
}

function seller(dialog = null, busy = false, variantItem = item) {
  const f = baseContext();
  const states = [[{ ...request, items: [variantItem] }], false, '', 'all', '', dialog, '', busy];
  let stateIndex = 0;
  f.context.useState = () => {
    const index = stateIndex++;
    return [states[index], value => { if (index === 5) f.calls.closed.push(value); }];
  };
  const code = sellerSource.slice(sellerSource.indexOf('const actionLabels')).replace('export default function', 'function');
  const Component = vm.runInNewContext(transpile(code) + '\nReturnOrdersPanel;', f.context);
  const tree = Component({ formatPrice: amount => `PKR ${amount.toFixed(2)}` });
  return { ...f, tree, html: renderToStaticMarkup(tree) };
}

test('actual seller card shows structured Color once and preserves its exact quantity and money', () => {
  const f = seller();
  assert.equal((f.html.match(/Color: Blue/g) || []).length, 1);
  assert.match(f.html, /Size: Large/); assert.match(f.html, /Quantity 1/); assert.match(f.html, /PKR 1000\.00/);
  assert.equal(f.calls.writes.length, 0);
  const escaped = seller(null, false, { ...item, selectedOptions: { Edition: '<script>alert(1)</script>' }, selectedColor: null });
  assert.match(escaped.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(escaped.html, /<script>/);
});

for (const busy of [false, true]) {
  test(`seller popup is labelled and its close action respects busy=${busy}`, () => {
    const f = seller({ type: 'status', request, status: 'approved' }, busy);
    assert.match(f.html, /role="dialog"[^>]*aria-modal="true"/);
    assert.match(f.html, /aria-labelledby="seller-return-dialog-title"/);
    assert.match(f.html, /id="seller-return-dialog-title"[^>]*>Approve return/);
    assert.equal(f.calls.portals, 1);
    const close = allNodes(f.tree).find(node => node.props?.['aria-label'] === 'Close return update');
    assert.equal(close.props.disabled, busy); close.props.onClick();
    assert.equal(f.calls.closed.length, busy ? 0 : 1); assert.equal(f.calls.writes.length, 0);
  });
}

for (const busy of [false, true]) {
  test(`buyer return popup has its title association and read-only variants with busy=${busy}`, () => {
    const f = baseContext();
    f.context.submitting = busy;
    f.context.setSelectedGroup = value => f.calls.closed.push(value);
    f.context.useCallback = fn => fn;
    const closeStart = buyerSource.indexOf('const closeDialog =');
    const closeEnd = buyerSource.indexOf('\n  const dialogPanel', closeStart);
    f.context.closeDialog = vm.runInNewContext(buyerSource.slice(closeStart, closeEnd) + '\ncloseDialog;', f.context);
    Object.assign(f.context, { selectedGroup: { store: { storeName: 'Test Store' }, items: [{ ...item, eligible: true, remainingReturnableQuantity: 1 }] },
      quantities: { [item.orderItemId]: 1 }, reasonCategory: 'damaged', reasonDetails: '',
      reasonOptions: [['damaged', 'Arrived damaged']], loadError: '', selection: { valid: true }, dialogPanel: { current: null },
      selectedActiveReturn: null,
      setQuantities() {}, setReasonCategory() {}, setReasonDetails() {}, submitReturn() {}, load() {} });
    const start = buyerSource.indexOf("{typeof document !== 'undefined' && createPortal(");
    const marker = '</AnimatePresence>, document.body)}';
    const end = buyerSource.indexOf(marker, start) + marker.length;
    const expression = buyerSource.slice(start + 1, end - 1);
    const tree = vm.runInNewContext(transpile(`const render = () => (${expression}); render();`), f.context);
    const html = renderToStaticMarkup(tree);
    assert.match(html, /role="dialog"[^>]*aria-modal="true"/);
    assert.match(html, /aria-labelledby="buyer-return-dialog-title"/);
    assert.match(html, /id="buyer-return-dialog-title"[^>]*>Request a return/);
    assert.equal((html.match(/Color: Blue/g) || []).length, 1);
    assert.match(html, /Size: Large/);
    const close = allNodes(tree).find(node => node.props?.['aria-label'] === 'Close return request');
    assert.equal(close.props.disabled, busy); close.props.onClick();
    assert.equal(f.calls.closed.length, busy ? 0 : 1); assert.equal(f.calls.writes.length, 0);
  });
}

test('actual buyer cards disable only the matching active store and keep its explanatory hint', () => {
  const f = baseContext();
  const helperStart = buyerSource.indexOf('const UNRESOLVED_RETURN_STATUSES');
  const helperEnd = buyerSource.indexOf('const canonicalRequestKey', helperStart);
  Object.assign(f.context, vm.runInNewContext(`${buyerSource.slice(helperStart, helperEnd)}\n({ activeReturnForSeller, activeReturnHint });`, {}));
  const group = (id, name) => ({ seller: { _id: id, username: name }, store: { storeName: name },
    policy: { returnsEnabled: true, returnDuration: 14, refundType: 'full_refund' }, eligible: true, items: [] });
  const active = { order: 'order-1', seller: { _id: 'seller-1' }, status: 'requested', returnNumber: 'RET-C4-FIRST' };
  Object.assign(f.context, { groups: [group('seller-1', 'First Store'), group('seller-2', 'Other Store')],
    requests: [active], orderContext: { orderId: 'order-1' }, returnGroupPolicyLabel, openRequest() {} });
  const start = buyerSource.indexOf('{groups.map(');
  const end = buyerSource.indexOf("\n\n      {typeof document", start);
  const expression = buyerSource.slice(start, end).trim().slice(1, -1);
  const render = () => vm.runInNewContext(transpile(`(${expression});`), f.context);
  const trees = render();
  const buttons = trees.flatMap(allNodes).filter(node => node.type === 'button');
  assert.equal(buttons[0].props.disabled, true);
  assert.equal(buttons[1].props.disabled, false);
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, trees));
  assert.match(html, /Return RET-C4-FIRST is in progress\. You can request another return from this store after it is resolved\./);
  assert.match(html, /aria-label="Request return from First Store"/);
  active.status = 'returned';
  assert.ok(render().flatMap(allNodes).filter(node => node.type === 'button').every(node => node.props.disabled === false));
  assert.equal(f.calls.writes.length, 0);
});

test('shared return popup hook traps focus, restores it and blocks Escape while busy', () => {
  const source = read('../src/utils/returnDialogAccessibility.js');
  const code = source.slice(source.indexOf('export const')).replace('export const', 'const');
  const refs = []; const effects = []; const listeners = new Map(); let cursor = 0; let closed = 0;
  const document = { body: { style: { overflow: 'auto' } }, activeElement: null,
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const previous = { focus() { document.activeElement = previous; } }; document.activeElement = previous;
  const first = { focus() { document.activeElement = first; } }, last = { focus() { document.activeElement = last; } };
  const panel = { focus() { document.activeElement = panel; }, querySelectorAll: () => [first, last] };
  const context = { document, useRef: value => { const index = cursor++; refs[index] ||= { current: value }; return refs[index]; },
    useEffect: effect => effects.push(effect) };
  const hook = vm.runInNewContext(code + '\nuseReturnDialogAccessibility;', context);
  const ref = hook({ open: true, busy: false, onClose: () => closed++ }); ref.current = panel;
  const cleanup = effects.shift()();
  assert.equal(document.body.style.overflow, 'hidden'); assert.equal(document.activeElement, panel);
  const key = listeners.get('keydown');
  key({ key: 'Tab', preventDefault() {} }); assert.equal(document.activeElement, first);
  key({ key: 'Tab', shiftKey: true, preventDefault() {} }); assert.equal(document.activeElement, last);
  cursor = 0; hook({ open: true, busy: true, onClose: () => closed++ });
  key({ key: 'Escape', preventDefault() {} }); assert.equal(closed, 0);
  cursor = 0; hook({ open: true, busy: false, onClose: () => closed++ });
  key({ key: 'Escape', preventDefault() {} }); assert.equal(closed, 1);
  cleanup(); assert.equal(document.activeElement, previous); assert.equal(document.body.style.overflow, 'auto');
  assert.equal(listeners.size, 0);
});
