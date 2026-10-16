import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogViewerRequest } from '../src/utils/catalogViewerAuth.js';

const base = 'https://rozare.up.railway.app/';
test('own public catalogue reads carry the current optional shopper identity', () => {
  let token = 'qa-one';
  const config = { url: base + 'api/products/get-products', headers: { Accept: 'application/json' } };
  assert.deepEqual(catalogViewerRequest(config, base, () => token).headers, { Accept: 'application/json', Authorization: 'Bearer qa-one' });
  token = 'qa-two';
  assert.equal(catalogViewerRequest(config, base, () => token).headers.Authorization, 'Bearer qa-two');
  token = null;
  assert.equal(catalogViewerRequest(config, base, () => token), config);
});

test('catalogue authentication never leaks to external origins, lookalike hosts or credential URLs', () => {
  for (const url of ['https://getsafepay.com/api/products/a', 'https://rozare.up.railway.app.evil.example/api/stores/all', 'https://res.cloudinary.com/image/upload/example.png', 'https://user:password@rozare.up.railway.app/api/stores/all', 'https://rozare.up.railway.app:444/api/stores/all']) {
    const config = { url };
    let calls = 0;
    assert.equal(catalogViewerRequest(config, base, () => { calls += 1; return 'qa-secret-not-for-external-origins'; }), config);
    assert.equal(calls, 0);
  }
});

test('login, payment, mutation requests and explicit authorization retain their own contracts', () => {
  for (const config of [
    { url: base + 'api/auth/login', method: 'get' },
    { url: base + 'api/safepay/config', method: 'get' },
    { url: base + 'api/products/add', method: 'post' },
    { url: base + 'api/stores/update', method: 'put' },
    { url: base + 'api/stores/all', headers: { authorization: 'Bearer explicit-qa' } },
  ]) {
    let calls = 0;
    assert.equal(catalogViewerRequest(config, base, () => { calls += 1; return 'qa-do-not-replace'; }), config);
    assert.equal(calls, 0);
  }
});

test('missing or unavailable storage does not crash anonymous catalogue reads', () => {
  const config = { url: base + 'api/stores/suggestions' };
  assert.equal(catalogViewerRequest(config, base, () => null), config);
  assert.equal(catalogViewerRequest(config, base, () => { throw Error('storage unavailable'); }), config);
});
