import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrderExportQuery, orderExportErrorMessage } from '../src/utils/orderExport.js';

test('order export always sends the selected report currency', () => {
  const query = new URLSearchParams(buildOrderExportQuery('status=paid', 'csv', 'pkr'));
  assert.equal(query.get('status'), 'paid');
  assert.equal(query.get('format'), 'csv');
  assert.equal(query.get('currency'), 'PKR');
  assert.throws(() => buildOrderExportQuery('', 'csv', 'JPY'), /currency/i);
});
test('order export decodes structured blob errors', async () => {
  assert.equal(
    await orderExportErrorMessage(new Blob([JSON.stringify({ msg: 'Stored order money is invalid.' })])),
    'Stored order money is invalid.',
  );
  assert.equal(await orderExportErrorMessage(new Blob(['<html>gateway</html>'])), 'Failed to export orders');
});
