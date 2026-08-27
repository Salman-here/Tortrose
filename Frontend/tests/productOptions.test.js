import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createProductSelection,
  getProductSelectionPayload,
  hasProductOptions,
  normalizeProductOptionGroups,
  validateProductSelection,
} from '../src/utils/productOptions.js';

const configurableProduct = {
  _id: 'product-options-web',
  name: 'Premium overshirt',
  colors: ['Legacy black'],
  optionGroups: [
    { name: 'Color', values: ['Navy', 'Stone'], default: 'Stone' },
    { name: 'Size', values: ['Small', 'Large'], default: 'Large' },
  ],
};

test('normalizes flexible option groups and suppresses duplicate legacy Color', () => {
  assert.equal(hasProductOptions(configurableProduct), true);
  assert.deepEqual(normalizeProductOptionGroups(configurableProduct), [
    { name: 'Color', values: ['Navy', 'Stone'], default: 'Stone', legacy: false },
    { name: 'Size', values: ['Small', 'Large'], default: 'Large', legacy: false },
  ]);
});

test('keeps seller defaults as suggestions and does not treat omission as consent', () => {
  assert.deepEqual(createProductSelection(configurableProduct), {
    selectedOptions: {},
    selectedColor: null,
  });

  const validation = validateProductSelection(configurableProduct);
  assert.equal(validation.ok, false);
  assert.deepEqual(validation.missingOptions.map(option => option.name), ['Color', 'Size']);
});

test('canonicalizes an explicit complete selection for the cart payload', () => {
  const selection = validateProductSelection(
    configurableProduct,
    { color: 'navy', SIZE: 'large' },
    'navy',
  );

  assert.equal(selection.ok, true);
  assert.deepEqual(getProductSelectionPayload(
    configurableProduct,
    { color: 'navy', SIZE: 'large' },
    'navy',
  ), {
    selectedColor: 'Navy',
    selectedOptions: { Color: 'Navy', Size: 'Large' },
  });
});

test('supports legacy colors and rejects stale or fabricated option metadata', () => {
  const legacy = { name: 'Cap', colors: ['Black', 'White'] };
  assert.deepEqual(validateProductSelection(legacy, { Color: 'black' }), {
    ok: true,
    selectedOptions: null,
    selectedColor: 'Black',
    missingOptions: [],
    invalidOptions: [],
    groups: [{ name: 'Color', values: ['Black', 'White'], default: '', legacy: true }],
  });

  const invalid = validateProductSelection(legacy, { Size: 'XL' }, 'Purple');
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.invalidOptions.map(option => option.name), ['Color', 'Size']);
});
