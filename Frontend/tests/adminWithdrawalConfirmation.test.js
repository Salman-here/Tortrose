import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { selectAdminWithdrawalPresentationMoney } from '../src/utils/adminPaymentsSafety.js';

const source = readFileSync(new URL('../src/components/layout/AdminPayments.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const helpersStart = source.indexOf('const statusTransitions =');
const helpersEnd = source.indexOf('const StatCard =');
const actionsStart = source.indexOf('const updateEdit =');
const actionsEnd = source.indexOf('const pendingRequests =', actionsStart);
assert.ok(helpersStart >= 0 && helpersEnd > helpersStart && actionsEnd > actionsStart);
const helpers = transformSync(source.slice(helpersStart, helpersEnd), {
  loader: 'jsx', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment',
}).code;
const actions = source.slice(actionsStart, actionsEnd);
const extracted = `${helpers}\n${actions}\n({ update: updateWithdrawal, confirm: confirmWithdrawal, cancel: closeWithdrawalConfirmation, change: updateEdit, createEdit: withdrawalEdit, Modal: WithdrawalConfirmation });`;

function request(status = 'approved') {
  const active = ['processing', 'manual_review'].includes(status);
  return {
    _id: 'withdrawal-1', seller: { username: 'Original Seller' }, status,
    balanceVersion: 2, amount: 15, minimumAmount: 5, currency: 'USD',
    requestedAmount: 15, requestedCurrency: 'USD', payoutAmount: 15, payoutCurrency: 'USD',
    payoutWorkflowVersion: 1, payoutWorkflow: { version: 1, attemptCount: active ? 1 : 0 },
    payoutAttempts: active ? [{ attemptId: 'attempt-1', status, provider: 'Frozen Transfer Rail', legacyImported: false }] : [],
    activePayoutAttemptId: active ? 'attempt-1' : undefined,
    paymentAccountSnapshotVersion: 1,
    paymentAccountSnapshot: { currency: 'USD', snapshotStatus: 'complete', payoutBlocked: false,
      bankName: 'Original Frozen Bank', accountNumberLast4: '1234' },
  };
}

function fixture(target = 'processing', current = target === 'processing' ? 'approved' : 'processing') {
  const row = request(current);
  const calls = { patches: [], keys: [], cleared: [], errors: [], successes: [], refreshed: 0 };
  const attempts = new Map();
  const effects = [];
  let generation = 0;
  const context = {
    data: { withdrawals: [row] }, edits: { [row._id]: {
      status: target, adminNote: 'Original note', payoutProvider: target === 'processing' ? 'New Transfer Rail' : '',
      attemptId: row.activePayoutAttemptId || '', transferReference: 'ORIGINAL-REFERENCE',
      transferredAt: '2026-10-07T06:00', evidenceType: 'provider_reference', evidenceUrl: '', evidenceNote: '',
      failureCertainty: 'definitively_not_sent', failureCode: 'NO_TRANSFER',
      failureReason: 'Provider verified that no transfer was sent.',
      reconciliationNote: 'The provider transfer outcome is uncertain.',
    } },
    pendingConfirmationRef: { current: null }, withdrawalSubmissionRef: { current: false },
    confirmation: null, savingId: '', API: '/api/payments', WITHDRAWAL_OPERATION_STORAGE_KEY: 'operation-ledger',
    setConfirmation(value) { context.confirmation = value; },
    setSavingId(value) { context.savingId = value; },
    setEdits(update) { context.edits = update(context.edits); },
    selectAdminWithdrawalPresentationMoney,
    useCallback: fn => fn, useRef: () => ({ current: null }), useEffect: effect => effects.push(effect),
    React: { createElement: (type, props, ...children) => ({ type,
      props: { ...props, children: children.flat(Infinity).filter(value => value !== false && value !== null && value !== undefined) } }) },
    motion: { div: 'div', section: 'section' }, AnimatePresence: 'AnimatePresence',
    AlertTriangle: 'AlertTriangle', RefreshCw: 'RefreshCw', X: 'X',
    createPortal: (tree, targetElement) => { context.portalTarget = targetElement; return tree; },
    window: { localStorage: {}, confirm: () => { throw new Error('Native browser confirmation must not run.'); } },
    getAuthToken: () => 'admin-token',
    getOrCreatePersistedMutationAttemptInLedger: async options => {
      if (!attempts.has(options.fingerprint)) attempts.set(options.fingerprint, `operation-${++generation}`);
      const key = attempts.get(options.fingerprint);
      calls.keys.push({ key, fingerprint: options.fingerprint });
      return { key };
    },
    clearPersistedMutationAttemptFromLedger: async (_storage, _ledger, fingerprint, key) => {
      calls.cleared.push(key); if (attempts.get(fingerprint) === key) attempts.delete(fingerprint);
    },
    axios: { patch: async (url, payload, config) => {
      calls.patches.push({ url, payload: JSON.parse(JSON.stringify(payload)), config });
      if (context.patchGate) await context.patchGate;
      if (context.patchError) throw context.patchError;
      return { data: { success: true } };
    } },
    toast: { success: message => calls.successes.push(message), error: message => calls.errors.push(message) },
    fetchOverview: async () => { calls.refreshed++; },
  };
  return { ...vm.runInNewContext(extracted, context), row, calls, context, effects };
}

function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...(tree.props?.children || []).flatMap(nodes)];
}
const textOf = tree => typeof tree === 'object'
  ? (tree?.props?.children || []).map(textOf).join('') : String(tree ?? '');

function renderModal(f, busy = false) {
  const listeners = new Map();
  const previousFocus = { focus() { document.activeElement = previousFocus; } };
  const document = {
    activeElement: previousFocus, body: { style: { overflow: 'auto' } },
    addEventListener: (event, fn) => listeners.set(event, fn),
    removeEventListener: (event, fn) => { if (listeners.get(event) === fn) listeners.delete(event); },
  };
  f.context.document = document;
  const tree = f.Modal({ confirmation: f.context.confirmation, busy,
    formatAmount: (amount, { targetCurrency }) => `${targetCurrency} ${amount.toFixed(2)}`,
    onCancel: f.cancel, onConfirm: f.confirm });
  const all = nodes(tree);
  const section = all.find(node => node.props.role === 'dialog');
  const buttons = all.filter(node => node.type === 'button').map(node => ({
    ...node, focus() { document.activeElement = this; },
  }));
  const panel = { focus() { document.activeElement = panel; },
    querySelectorAll: () => buttons.filter(button => !button.props.disabled) };
  if (section) section.props.ref.current = panel;
  const cleanup = f.effects.pop()?.();
  return { tree, all, section, buttons, panel, document, previousFocus, listeners, cleanup,
    backdrop: all.find(node => node.props.onMouseDown) };
}

function renderCard(f) {
  const start = source.indexOf('return (\n                                <div key={request._id}');
  const end = source.indexOf('\n                            );', start);
  assert.ok(start >= 0 && end > start);
  const render = transformSync(`const renderRow = () => { ${source.slice(start, end)}\n); }; renderRow;`,
    { loader: 'jsx', jsxFactory: 'React.createElement' }).code;
  const presentationMoney = selectAdminWithdrawalPresentationMoney(f.row);
  Object.assign(f.context, {
    request: f.row, edit: f.context.edits[f.row._id] || f.createEdit(f.row), presentationMoney,
    payoutDestination: f.row.paymentAccountSnapshot, payoutBlocked: false, attempts: f.row.payoutAttempts,
    activeAttempt: f.row.payoutAttempts[0], legacyProcessing: false, nextStatuses: ['paid', 'failed', 'manual_review'],
    isTerminal: false, canSubmit: true, StatusPill: 'StatusPill', CheckCircle: 'CheckCircle',
    formatAmount: (amount, { targetCurrency }) => `${targetCurrency} ${amount.toFixed(2)}`,
    formatLedgerAmount: amount => String(amount), updateEdit: f.change, updateWithdrawal: f.update,
  });
  return vm.runInNewContext(render, f.context)();
}

const warnings = {
  processing: "Start a new bank payout attempt using only this withdrawal's frozen destination and frozen payout amount?",
  manual_review: 'Place this payout attempt in manual review? The entire amount will remain reserved and no retry can start until it is resolved.',
  failed: 'Confirm that no transfer was completed and release this reservation? Use this only after definitive bank/provider verification.',
  paid: 'Permanently mark this withdrawal paid with transfer reference "ORIGINAL-REFERENCE"? The recorded proof cannot be replaced.',
};

for (const status of Object.keys(warnings)) {
  test(`${status} waits for in-page consent and Cancel creates no key or write`, async () => {
    const f = fixture(status);
    await f.update(f.row);
    assert.equal(f.context.confirmation.message, warnings[status]);
    assert.equal(f.calls.keys.length, 0); assert.equal(f.calls.patches.length, 0);
    f.cancel(); await f.confirm();
    assert.equal(f.context.confirmation, null);
    assert.equal(f.calls.keys.length, 0); assert.equal(f.calls.patches.length, 0);
  });
  test(`${status} confirms exactly its captured payload with expected status and idempotency key`, async () => {
    const f = fixture(status);
    await f.update(f.row);
    const captured = JSON.parse(JSON.stringify(f.context.confirmation.payload));
    f.context.edits[f.row._id].adminNote = 'Changed background note';
    f.context.edits[f.row._id].transferReference = 'CHANGED-REFERENCE';
    await f.confirm();
    assert.equal(f.calls.patches.length, 1);
    assert.deepEqual(f.calls.patches[0].payload, captured);
    assert.equal(f.calls.patches[0].config.headers['Idempotency-Key'], 'operation-1');
    assert.equal(f.calls.patches[0].config.headers.Authorization, 'Bearer admin-token');
    assert.equal(f.calls.cleared.length, 1); assert.equal(f.calls.refreshed, 1);
    assert.equal(f.context.confirmation, null);
  });
}

test('payout confirmation is a labelled portal with frozen amount, destination, provider and irreversible proof warning', async () => {
  const f = fixture('paid'); await f.update(f.row);
  f.row.paymentAccountSnapshot.bankName = 'Changed Current Bank';
  f.row.payoutAttempts[0].provider = 'Changed Current Provider';
  const view = renderModal(f);
  assert.equal(f.context.portalTarget, view.document.body);
  assert.equal(view.section.props['aria-modal'], 'true');
  assert.equal(view.section.props['aria-labelledby'], 'withdrawal-confirmation-title');
  assert.equal(view.section.props['aria-describedby'], 'withdrawal-confirmation-risk');
  assert.match(textOf(view.tree), /Frozen bank payout: USD 15\.00/);
  assert.match(textOf(view.tree), /Original Frozen Bank · \*\*\*\* 1234/);
  assert.match(textOf(view.tree), /Payout provider: Frozen Transfer Rail/);
  assert.match(textOf(view.tree), /ORIGINAL-REFERENCE.*recorded proof cannot be replaced/);
  assert.doesNotMatch(textOf(view.tree), /Changed Current/);
  view.cleanup();
});

test('keyboard focus is trapped and restored; Escape and backdrop cancellation never write', async () => {
  const f = fixture(); await f.update(f.row);
  const view = renderModal(f);
  assert.equal(view.document.body.style.overflow, 'hidden');
  assert.equal(view.document.activeElement, view.panel);
  let prevented = 0;
  const key = view.listeners.get('keydown');
  key({ key: 'Tab', shiftKey: false, preventDefault() { prevented++; } });
  assert.equal(view.document.activeElement, view.buttons[0]);
  key({ key: 'Tab', shiftKey: true, preventDefault() { prevented++; } });
  assert.equal(view.document.activeElement, view.buttons.at(-1));
  key({ key: 'Tab', shiftKey: false, preventDefault() { prevented++; } });
  assert.equal(view.document.activeElement, view.buttons[0]);
  key({ key: 'Escape', preventDefault() { prevented++; } });
  assert.equal(f.context.confirmation, null); assert.equal(f.calls.patches.length, 0);
  view.cleanup();
  assert.equal(view.document.activeElement, view.previousFocus);
  assert.equal(view.document.body.style.overflow, 'auto');
  assert.equal(view.listeners.has('keydown'), false); assert.equal(prevented, 4);
  await f.update(f.row);
  const next = renderModal(f);
  next.backdrop.props.onMouseDown({ target: next.section, currentTarget: next.backdrop });
  assert.ok(f.context.confirmation);
  next.backdrop.props.onMouseDown({ target: next.backdrop, currentTarget: next.backdrop });
  assert.equal(f.context.confirmation, null); assert.equal(f.calls.keys.length, 0);
  next.cleanup();
});

test('double confirmation locks before async work and busy confirmation cannot be dismissed', async () => {
  const f = fixture(); await f.update(f.row);
  let release;
  f.context.patchGate = new Promise(resolve => { release = resolve; });
  const first = f.confirm(), second = f.confirm();
  for (let tick = 0; tick < 5 && !f.calls.patches.length; tick++) await Promise.resolve();
  assert.equal(f.calls.keys.length, 1); assert.equal(f.calls.patches.length, 1);
  f.cancel(); assert.ok(f.context.confirmation);
  const busyView = renderModal(f, true);
  assert.ok(busyView.buttons.every(button => button.props.disabled));
  assert.equal(busyView.section.props['aria-busy'], true);
  busyView.listeners.get('keydown')({ key: 'Escape', preventDefault() {} });
  assert.ok(f.context.confirmation);
  release(); await Promise.all([first, second]);
  assert.equal(f.calls.cleared.length, 1); assert.equal(f.context.confirmation, null);
  busyView.cleanup();
});

test('lost response preserves the operation key for a confirmed retry', async () => {
  const f = fixture(); f.context.patchError = new Error('Lost response');
  await f.update(f.row); await f.confirm();
  assert.equal(f.calls.cleared.length, 0); assert.equal(f.context.confirmation, null);
  f.context.patchError = null;
  await f.update(f.row); await f.confirm();
  assert.deepEqual(f.calls.keys.map(value => value.key), ['operation-1', 'operation-1']);
  assert.equal(f.calls.cleared.length, 1);
});

test('changed server status invalidates pending consent before any key or write', async () => {
  const f = fixture('paid'); await f.update(f.row);
  f.context.data.withdrawals = [{ ...f.row, status: 'paid' }];
  await f.confirm();
  assert.equal(f.calls.keys.length, 0); assert.equal(f.calls.patches.length, 0);
  assert.equal(f.context.confirmation, null); assert.match(f.calls.errors[0], /Refresh before acting/);
});

for (const [target, override] of [
  ['processing', { payoutProvider: '' }], ['manual_review', { reconciliationNote: 'short' }],
  ['failed', { failureCertainty: '' }], ['failed', { failureReason: 'short' }],
  ['paid', { transferReference: 'x' }], ['paid', { evidenceType: 'receipt', evidenceUrl: '', evidenceNote: '' }],
]) {
  test(`incomplete ${target} proof cannot open or submit a confirmation`, async () => {
    const f = fixture(target); Object.assign(f.context.edits[f.row._id], override);
    await f.update(f.row); await f.confirm();
    assert.equal(f.context.confirmation, null); assert.equal(f.calls.keys.length, 0); assert.equal(f.calls.patches.length, 0);
  });
}

test('missing native frozen destination blocks new payout and ordinary paid advancement', async () => {
  for (const target of ['processing', 'paid']) {
    const f = fixture(target);
    Object.assign(f.row.paymentAccountSnapshot, { snapshotStatus: 'unreadable', payoutBlocked: true });
    await f.update(f.row); await f.confirm();
    assert.equal(f.context.confirmation, null); assert.equal(f.calls.patches.length, 0);
  }
});

test('an imported legacy payout keeps its unavailable amount explicit and only resolves its recorded attempt', async () => {
  const f = fixture('paid', 'manual_review');
  Object.assign(f.row, {
    balanceVersion: 0, amount: 5, requestedAmount: 0, payoutAmount: 0,
    paymentAccountSnapshotVersion: 0,
    paymentAccountSnapshot: { snapshotStatus: 'missing', payoutBlocked: true },
    payoutWorkflow: { version: 1, attemptCount: 1, legacyImported: true },
    payoutAttempts: [{ attemptId: 'attempt-1', status: 'manual_review', provider: 'Historical Bank', legacyImported: true }],
  });
  await f.update(f.row);
  const view = renderModal(f);
  assert.match(textOf(view.tree), /Original bank payout amount unavailable/);
  assert.match(textOf(view.tree), /Payout provider: Historical Bank/);
  assert.doesNotMatch(textOf(view.tree), /Frozen bank payout:/);
  await f.confirm();
  assert.equal(f.calls.patches[0].payload.attemptId, 'attempt-1');
  assert.equal(f.calls.patches[0].payload.payoutProvider, '');
  view.cleanup();
});

test('a changed active attempt invalidates captured transfer proof before sending it', async () => {
  const f = fixture('paid'); await f.update(f.row);
  f.row.activePayoutAttemptId = 'replacement-attempt';
  f.row.payoutAttempts = [{ attemptId: 'replacement-attempt', status: 'processing', provider: 'Original Rail' }];
  await f.confirm();
  assert.equal(f.calls.keys.length, 0); assert.equal(f.calls.patches.length, 0);
  assert.equal(f.context.confirmation, null);
});

test('approved actions still submit directly and terminal requests cannot advance', async () => {
  const f = fixture('approved', 'pending'); await f.update(f.row);
  assert.equal(f.context.confirmation, null); assert.equal(f.calls.patches[0].payload.status, 'approved');
  const terminal = fixture('processing', 'paid'); await terminal.update(terminal.row);
  assert.equal(terminal.context.confirmation, null); assert.equal(terminal.calls.patches.length, 0);
});

test('responsive withdrawal cards keep Update inside the bounded actions column and stack it before wide desktops', () => {
  const f = fixture('paid');
  const card = renderCard(f);
  const grid = nodes(card).find(node => node.props.className?.includes('2xl:grid-cols-'));
  assert.equal(grid.props.children.length, 3);
  assert.match(grid.props.className, /grid-cols-1 md:grid-cols-2/);
  assert.match(grid.props.className, /2xl:grid-cols-\[minmax\(0,1\.2fr\)_minmax\(0,1fr\)_minmax\(0,1\.5fr\)\]/);
  assert.doesNotMatch(grid.props.className, /(?:^|\s)lg:grid-cols|_auto\]/);
  const actionsColumn = grid.props.children[2];
  assert.match(actionsColumn.props.className, /min-w-0 max-w-full md:col-span-2 2xl:col-span-1/);
  for (const control of ['input', 'select', 'textarea']) {
    assert.ok(actionsColumn.props.className.includes(`[&_${control}]:max-w-full`));
    for (const node of nodes(actionsColumn).filter(child => child.type === control)) {
      if (node.props.type !== 'checkbox') assert.match(node.props.className, /w-full min-w-0/);
    }
  }
  const update = nodes(actionsColumn).find(node => node.type === 'button' && textOf(node).trim() === 'Update');
  assert.ok(update); assert.match(update.props.className, /max-w-full/);
  assert.doesNotMatch(actionsColumn.props.className, /hidden|overflow-hidden/);
  assert.match(source, /className="w-full min-w-0 px-3[^"\n]*" style=\{\{ contain: 'inline-size' \}\}/);
  assert.match(source, /className="w-full min-w-0 max-w-full overflow-x-auto"/);
});

test('previous status note is read-only and is never automatically resent with the next action', async () => {
  const f = fixture('failed', 'manual_review');
  const previousNote = 'The entire amount is still reserved while the provider outcome is reviewed.';
  f.row.adminNote = previousNote;
  f.context.edits[f.row._id] = f.createEdit(f.row);
  assert.equal(f.context.edits[f.row._id].adminNote, '');
  f.change(f.row._id, 'status', 'failed');
  f.change(f.row._id, 'failureCertainty', 'definitively_not_sent');
  f.change(f.row._id, 'failureReason', 'Provider verified no completed transfer.');
  const card = renderCard(f);
  const all = nodes(card);
  assert.ok(all.some(node => node.type === 'p' && textOf(node) === 'Last admin note'));
  assert.ok(all.some(node => node.type === 'p' && textOf(node) === previousNote));
  const noteInput = all.find(node => node.type === 'input' && node.props['aria-label'] === 'Note for this action');
  assert.equal(noteInput.props.value, '');
  assert.ok(!all.some(node => ['input', 'textarea'].includes(node.type) && node.props.value === previousNote));
  await f.update(f.row); await f.confirm();
  assert.equal(f.calls.patches[0].payload.adminNote, '');
  assert.equal(f.row.adminNote, previousNote);
});

test('a newly typed note survives status selection and is captured for the confirmed action', async () => {
  const f = fixture('failed', 'manual_review');
  f.row.adminNote = 'Old review note: reservation is still held.';
  f.context.edits[f.row._id] = f.createEdit(f.row);
  const currentNote = 'Provider verified no transfer; the reservation is released.';
  const input = nodes(renderCard(f)).find(node => node.props['aria-label'] === 'Note for this action');
  input.props.onChange({ target: { value: currentNote } });
  f.change(f.row._id, 'status', 'paid');
  assert.equal(f.context.edits[f.row._id].adminNote, currentNote);
  f.change(f.row._id, 'status', 'failed');
  f.change(f.row._id, 'failureCertainty', 'definitively_not_sent');
  f.change(f.row._id, 'failureReason', 'Provider verified no completed transfer.');
  await f.update(f.row);
  assert.equal(f.context.confirmation.payload.adminNote, currentNote);
  f.change(f.row._id, 'adminNote', 'A later background edit');
  await f.confirm();
  assert.equal(f.calls.patches[0].payload.adminNote, currentNote);
  assert.equal(f.row.adminNote, 'Old review note: reservation is still held.');
});
