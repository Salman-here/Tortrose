import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Execute the actual component handler, replacing only Vite's compile-time URL.
// Financial/status authority stays on the backend; this tests error presentation.
const source = readFileSync(new URL('../src/components/layout/OrderDetail.jsx', import.meta.url), 'utf8');
const start = source.indexOf('const handleStatusUpdate = async');
const end = source.indexOf('const handleCancelOrder = async', start);
assert.ok(start >= 0 && end > start);
const handler = source.slice(start, end).replaceAll('import.meta.env.VITE_API_URL', "'https://qa.invalid/'") + '\nhandleStatusUpdate;';

function fixture(error) {
  const calls = { errors: [], successes: [], requests: [], refreshed: 0, updating: [] };
  const context = { order: { _id: 'test-order' }, newStatus: 'shipped', getAuthToken: () => 'test-only-token',
    axios: { patch: async (url, body) => { calls.requests.push({ url, body }); if (error !== undefined) throw error; return { data: { msg: 'Status updated' } }; } },
    toast: { error: value => calls.errors.push(value), success: value => calls.successes.push(value) },
    fetchOrderDetail: () => { calls.refreshed++; }, setIsUpdating: value => calls.updating.push(value),
  };
  return { update: vm.runInNewContext(handler, context), calls };
}

test('seller sees the backend funding/refund refusal instead of a generic status error', async () => {
  const message = 'This order payment was refunded or reversed. Shipping is not allowed.';
  const f = fixture({ response: { status: 409, data: { msg: message, code: 'ORDER_FUNDING_REVERSED' } } });
  await f.update();
  assert.deepEqual(f.calls.errors, [message]);
  assert.deepEqual(f.calls.successes, []); assert.equal(f.calls.refreshed, 0);
  assert.deepEqual(f.calls.updating, [false]);
  assert.equal(f.calls.requests[0].url, 'https://qa.invalid/api/order/update-status/test-order');
  assert.equal(f.calls.requests[0].body.newStatus, 'shipped');
});

for (const invalidMessage of [undefined, null, '', '   ', 409, { internal: 'not displayable' }, ['not a message']]) {
  test(`invalid server message (${JSON.stringify(invalidMessage)}) retains the safe fallback`, async () => {
    const f = fixture({ response: { msg: 'Wrong Axios property must not be used', data: { msg: invalidMessage } } });
    await f.update();
    assert.deepEqual(f.calls.errors, ['Error updating status']);
    assert.deepEqual(f.calls.successes, []); assert.equal(f.calls.refreshed, 0);
    assert.deepEqual(f.calls.updating, [false]);
  });
}

test('network failure does not display a raw transport exception', async () => {
  const f = fixture(new Error('Raw transport details are not a seller message'));
  await f.update();
  assert.deepEqual(f.calls.errors, ['Error updating status']);
  assert.deepEqual(f.calls.updating, [false]);
});

test('valid server message is trimmed and successful status flow is unchanged', async () => {
  const refused = fixture({ response: { data: { msg: '  Payment needs review.  ' } } });
  await refused.update(); assert.deepEqual(refused.calls.errors, ['Payment needs review.']);
  const success = fixture(); await success.update();
  assert.deepEqual(success.calls.errors, []); assert.deepEqual(success.calls.successes, ['Status updated']);
  assert.equal(success.calls.refreshed, 1); assert.deepEqual(success.calls.updating, [false]);
});
