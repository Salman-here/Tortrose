'use strict';

const {
  parseMoneyLikeNumber,
  parseNonNegativeSafeInteger,
  parsePositiveSafeInteger,
  parseStrictFiniteNumber,
} = require('../../services/numericInputService');
const { __private } = require('../../services/aiActionExecutor');
const { __private: productPrivate } = require('../../controllers/productController');

describe('strict numeric persistence boundaries', () => {
  test.each([true, false, null, undefined, '', '   ', [], {}, '1x', '1.2.3']) (
    'rejects coerced scalar input %p',
    value => expect(parseStrictFiniteNumber(value)).toBeNull(),
  );

  test('accepts intentional decimal strings but only safe integer quantities', () => {
    expect(parseStrictFiniteNumber('1.25e2')).toBe(125);
    expect(parsePositiveSafeInteger('3')).toBe(3);
    expect(parsePositiveSafeInteger(1.9)).toBeNull();
    expect(parsePositiveSafeInteger(true)).toBeNull();
    expect(parsePositiveSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(parseNonNegativeSafeInteger('0')).toBe(0);
  });

  test('accepts one currency-marked amount and rejects ambiguous/coerced money', () => {
    expect(parseMoneyLikeNumber('PKR 1,250.50')).toBe(1250.5);
    expect(parseMoneyLikeNumber('$10')).toBe(10);
    expect(parseMoneyLikeNumber('10 or 20')).toBeNull();
    expect(parseMoneyLikeNumber(true)).toBeNull();
    expect(parseMoneyLikeNumber('')).toBeNull();
  });

  test('AI quantities never truncate decimals and AI money never casts booleans', () => {
    expect(__private.parseQuantity('1.9')).toBeNull();
    expect(__private.parseQuantity(true)).toBeNull();
    expect(__private.parseQuantity(undefined, 1)).toBe(1);
    expect(__private.parseMoneyInput(true, 'PKR')).toEqual({ amount: null, currency: 'PKR' });
    expect(__private.normalizeMoneyAmount('90071992547409.92')).toBeNull();
  });

  test('manual product boundaries reject boolean, blank, unsafe money, and unsafe stock', () => {
    expect(productPrivate.invalidProductNumber({ price: true })).toMatch(/non-negative/);
    expect(productPrivate.invalidProductNumber({ price: ' ' })).toMatch(/non-negative/);
    expect(productPrivate.invalidProductNumber({ price: '90071992547409.92' })).toMatch(/too large/);
    expect(productPrivate.invalidProductNumber({ stock: Number.MAX_SAFE_INTEGER + 1 })).toMatch(/safe whole/);
    expect(productPrivate.normalizeBulkMoneyInput(true)).toBeNull();
    expect(productPrivate.normalizeBulkMoneyInput('1.005')).toBeNull();
    expect(productPrivate.normalizeBulkMoneyInput('1.01')).toBe(1.01);
  });
});
