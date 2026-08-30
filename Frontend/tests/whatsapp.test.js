import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildVerifyMessage,
  getConfirmationSourceLabel,
  hasWhatsAppPhone,
  sanitizePhone,
} from '../src/utils/whatsapp.js';

test('web WhatsApp routing preserves explicit international destinations', () => {
  assert.equal(sanitizePhone('+44 7700 900123'), '447700900123');
  assert.equal(sanitizePhone('0044 7700 900123'), '447700900123');
  assert.equal(sanitizePhone('923028588506'), '923028588506');
});

test('web WhatsApp routing resolves domestic numbers only from order country metadata', () => {
  assert.equal(sanitizePhone('0302 8588506', '+92'), '923028588506');
  assert.equal(sanitizePhone('07700 900123', '+44'), '447700900123');
  assert.equal(sanitizePhone('0302 8588506'), '');

  assert.equal(hasWhatsAppPhone({
    shippingInfo: { phone: '0302 8588506', phonecode: '+92' },
  }), true);
  assert.equal(hasWhatsAppPhone({
    shippingInfo: { phone: '0302 8588506' },
  }), false);
});

test('web WhatsApp routing rejects malformed or implausible destinations', () => {
  for (const value of ['', 'abc', '+123', `+${'1'.repeat(16)}`]) {
    assert.equal(sanitizePhone(value), '');
  }
});

test('web WhatsApp order money fails closed on unsupported or collided snapshots', () => {
  const base = {
    orderId: 'ORD-1',
    currency: 'PKR',
    shippingInfo: { fullName: 'A Buyer' },
    orderItems: [{ name: 'Bag', quantity: 1, price: 5 }],
    orderSummary: { totalAmount: 5 },
  };
  assert.throws(
    () => buildVerifyMessage({ ...base, currency: 'CAD' }),
    error => error?.code === 'ORDER_PRESENTATION_DATA_INVALID',
  );
  assert.throws(
    () => buildVerifyMessage({
      ...base,
      orderSummary: { totalAmount: 70368744177664.02 },
    }),
    error => error?.code === 'ORDER_PRESENTATION_DATA_INVALID',
  );
  for (const order of [
    { ...base, currency: '' },
    { ...base, currency: 'PKR', orderCurrency: 'USD' },
    { ...base, orderItems: [{ name: 'Bag', quantity: 0, price: 5 }] },
    { ...base, orderItems: [{ name: 'Bag', quantity: 1, qty: 2, price: 5 }] },
  ]) {
    assert.throws(
      () => buildVerifyMessage(order),
      error => error?.code === 'ORDER_PRESENTATION_DATA_INVALID',
    );
  }
});

test('web order labels preserve the actor who cancelled after buyer confirmation', () => {
  const baseOrder = {
    orderStatus: 'cancelled',
    confirmation: {
      confirmedAt: '2026-08-30T10:00:00.000Z',
      confirmedVia: 'email',
      cancelledAt: '2026-08-30T10:05:00.000Z',
      cancelledVia: 'admin',
    },
  };

  assert.equal(getConfirmationSourceLabel({
    ...baseOrder,
    confirmation: { ...baseOrder.confirmation, cancelledByRole: 'admin' },
  }), 'Cancelled by administrator (was confirmed by buyer via email)');
  assert.equal(getConfirmationSourceLabel({
    ...baseOrder,
    confirmation: {
      ...baseOrder.confirmation,
      cancelledByRole: 'buyer',
      cancelledVia: 'dashboard',
    },
  }), 'Cancelled by buyer from account (was confirmed via email)');
});
