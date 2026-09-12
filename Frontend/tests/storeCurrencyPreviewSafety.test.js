import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/components/layout/StoreSettings.jsx', import.meta.url), 'utf8');
const update = source.slice(source.indexOf('const requestProductCurrencyChange ='), source.indexOf('const handleProductCurrencySelect ='));

test('currency confirmation submits its exact reviewed quote', () => {
  assert.match(update, /quoteToken: confirm \? productCurrencyConfirm\?\.quoteToken : undefined/);
});

test('a confirmed currency save cannot be presented as cancelled while it is in flight', () => {
  assert.match(source, /const cancelProductCurrencyConfirmation = \(\) => \{\s*if \(productCurrencySaving\) return;/);
  assert.match(source, /disabled=\{productCurrencySaving\} onClick=\{cancelProductCurrencyConfirmation\}/);
});
