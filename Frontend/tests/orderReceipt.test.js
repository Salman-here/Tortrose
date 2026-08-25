import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatPersistedOrderReceipt,
  formatSyntheticPaidOrderReceipt,
} from '../src/utils/orderReceipt.js';

test('formats receipts in the exact supported persisted denomination', () => {
  for (const [currency, amount, expected] of [
    ['USD', 6, 'USD 6.00'],
    ['PKR', 1880, 'PKR 1,880.00'],
    ['EUR', 9.25, 'EUR 9.25'],
    ['GBP', 4.5, 'GBP 4.50'],
  ]) {
    assert.equal(formatPersistedOrderReceipt({
      currency,
      orderSummary: { totalAmount: amount },
    }), expected);
  }
});

test('normalizes only the spelling of a supported currency and never converts the amount', () => {
  assert.equal(formatPersistedOrderReceipt({
    currency: ' pkr ',
    orderSummary: { totalAmount: 200 },
  }), 'PKR 200.00');
});

test('fails closed for missing, unsupported, or malformed stored receipt data', () => {
  for (const order of [
    { orderSummary: { totalAmount: 10 } },
    { currency: 'CAD', orderSummary: { totalAmount: 10 } },
    { currency: 'USD', orderSummary: { totalAmount: '10.00' } },
    { currency: 'USD', orderSummary: { totalAmount: false } },
    { currency: 'USD', orderSummary: { totalAmount: -1 } },
    { currency: 'USD', orderSummary: { totalAmount: 1.001 } },
  ]) {
    assert.equal(formatPersistedOrderReceipt(order), null);
  }
});

test('never exposes a mixed-seller buyer total through the seller synthetic receipt fallback', () => {
  const mixedSellerOrder = {
    currency: 'PKR',
    orderSummary: {
      totalAmount: 1880,
      _originalTotal: 1880,
      sellerScopedTotal: 200,
    },
  };

  assert.equal(formatSyntheticPaidOrderReceipt(mixedSellerOrder, 'seller'), null);
  assert.equal(formatSyntheticPaidOrderReceipt(mixedSellerOrder, 'user'), null);
  assert.equal(formatSyntheticPaidOrderReceipt(mixedSellerOrder, undefined), null);
});

test('allows only the admin outlet to synthesize its authorized full-order receipt', () => {
  const fullAdminOrder = {
    currency: 'PKR',
    orderSummary: { totalAmount: 1880, _originalTotal: 999999 },
  };
  assert.equal(formatSyntheticPaidOrderReceipt(fullAdminOrder, 'admin'), 'PKR 1,880.00');
  assert.notEqual(formatSyntheticPaidOrderReceipt(fullAdminOrder, 'admin'), 'PKR 999,999.00');
});
