import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { notificationMatchesSearch } from '../src/utils/notificationSearch.js';

for (const field of ['title', 'description', 'body', 'message']) {
  test(`finds public order references in ${field}, ignoring query whitespace and case`, () => {
    assert.equal(notificationMatchesSearch({ [field]: 'Your order #ORD-12345 is confirmed.' }, '  ord-12345  '), true);
  });
}
test('finds a buyer refund amount in the body without needing a title match', () => {
  assert.equal(notificationMatchesSearch({ title: 'Return refund completed', body: 'Rs100.00 PKR was credited.' }, 'rs100.00'), true);
});
test('empty search preserves the existing list and missing/non-text fields do not throw', () => {
  assert.equal(notificationMatchesSearch(null, '  '), true);
  assert.equal(notificationMatchesSearch({ title: null, body: {} }, 'ORD-12345'), false);
  assert.equal(notificationMatchesSearch({ title: 'Order confirmed', body: 'ORD-99999' }, 'ORD-12345'), false);
});
test('matches the existing Android/iOS search contract for the same notifications', async () => {
  const source = readFileSync(new URL('../../MobileApp/src/utils/notificationSearch.js', import.meta.url), 'utf8');
  const native = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  for (const item of [null, { title: 'Payment received', body: 'ORD-12345 Rs400.00 PKR' }, { description: 'Small Blue quantity 1' }]) {
    for (const query of ['', '  ORD-12345 ', 'rs400', 'small blue', 'missing']) {
      assert.equal(notificationMatchesSearch(item, query), native.notificationMatchesSearch(item, query));
    }
  }
});
test('the shared buyer/seller web inbox uses the full-message matcher', () => {
  const source = readFileSync(new URL('../src/components/layout/NotificationsPage.jsx', import.meta.url), 'utf8');
  assert.match(source, /notificationMatchesSearch\(notification, searchTerm\)/);
  assert.doesNotMatch(source, /!notification\.title\.toLowerCase\(\)\.includes\(searchTerm/);
});
