'use strict';

const mongoose = require('mongoose');
const ShippingMethod = require('../../models/ShippingMethod');

const makeShipping = methods => new ShippingMethod({
  seller: new mongoose.Types.ObjectId(),
  methods,
});

describe('shipping money schema integrity', () => {
  test('accepts exact free and positive paid methods with one active option', () => {
    expect(makeShipping([
      { type: 'free', cost: 0, currency: 'PKR', deliveryDays: 5, isActive: true },
      { type: 'standard', cost: 500, currency: 'PKR', deliveryDays: 3, isActive: true },
    ]).validateSync()).toBeUndefined();
  });

  test('accepts an unconfigured inactive paid slot alongside an active method', () => {
    expect(makeShipping([
      { type: 'standard', cost: 500, currency: 'PKR', deliveryDays: 3, isActive: true },
      { type: 'fast', cost: 0, costInputAmount: 0, currency: 'PKR', deliveryDays: 2, isActive: false },
    ]).validateSync()).toBeUndefined();
  });

  test.each([
    [[{ type: 'free', cost: 1, currency: 'PKR', deliveryDays: 5, isActive: true }], 'methods.0.cost'],
    [[{ type: 'standard', cost: 0, currency: 'PKR', deliveryDays: 5, isActive: true }], 'methods.0.cost'],
    [[{ type: 'standard', cost: 0.004, currency: 'PKR', deliveryDays: 5, isActive: true }], 'methods.0.cost'],
    [[{ type: 'standard', cost: '1.00', currency: 'PKR', deliveryDays: 5, isActive: true }], 'methods.0.cost'],
    [[{ type: 'standard', cost: true, currency: 'PKR', deliveryDays: 5, isActive: true }], 'methods.0.cost'],
    [[{ type: 'standard', cost: '', currency: 'PKR', deliveryDays: 5, isActive: true }], 'methods.0.cost'],
    [[{ type: 'standard', cost: Number.POSITIVE_INFINITY, currency: 'PKR', deliveryDays: 5, isActive: true }], 'methods.0.cost'],
    [[{ type: 'standard', cost: Number.MAX_SAFE_INTEGER, currency: 'PKR', deliveryDays: 5, isActive: true }], 'methods.0.cost'],
    [[{ type: 'standard', cost: 1, costInputAmount: 0.004, currency: 'PKR', deliveryDays: 5, isActive: true }], 'methods.0.costInputAmount'],
    [[{ type: 'standard', cost: 1, costInputAmount: 0, currency: 'PKR', deliveryDays: 5, isActive: true }], 'methods.0.costInputAmount'],
    [[{ type: 'standard', cost: 1, costInputAmount: '1.00', currency: 'PKR', deliveryDays: 5, isActive: true }], 'methods.0.costInputAmount'],
    [[{ type: 'standard', cost: 1, costInputAmount: true, currency: 'PKR', deliveryDays: 5, isActive: true }], 'methods.0.costInputAmount'],
    [[{ type: 'free', cost: 0, costInputAmount: 0.01, currency: 'PKR', deliveryDays: 5, isActive: true }], 'methods.0.costInputAmount'],
    [[{ type: 'standard', cost: 1, currency: 'PKR', deliveryDays: 1.5, isActive: true }], 'methods.0.deliveryDays'],
    [[{ type: 'standard', cost: 1, currency: 'PKR', deliveryDays: '2', isActive: true }], 'methods.0.deliveryDays'],
    [[{ type: 'standard', cost: 1, currency: 'PKR', deliveryDays: true, isActive: true }], 'methods.0.deliveryDays'],
    [[{ type: 'standard', cost: 1, currency: 'PKR', deliveryDays: Number.MAX_SAFE_INTEGER + 1, isActive: true }], 'methods.0.deliveryDays'],
    [[{ type: 'standard', cost: 1, currency: 'CAD', deliveryDays: 2, isActive: true }], 'methods.0.currency'],
    [[{ type: 'standard', cost: 1, currency: 'PKR', deliveryDays: 2, isActive: false }], 'methods'],
    [[
      { type: 'free', cost: 0, currency: 'PKR', deliveryDays: 5, isActive: true },
      { type: 'free', cost: 0, currency: 'PKR', deliveryDays: 7, isActive: true },
    ], 'methods'],
  ])('rejects invalid shipping configuration %#', (methods, expectedPath) => {
    const error = makeShipping(methods).validateSync();
    expect(error?.errors?.[expectedPath]).toBeDefined();
  });
});
