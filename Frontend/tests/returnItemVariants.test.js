import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getReturnItemVariantLabels, readReturnItemVariants } from '../src/utils/returnItemVariants.js';

test('stored options and legacy color show once without changing source data', () => {
  const item = Object.freeze({ selectedColor: 'Blue', selectedOptions: Object.freeze({ Color: 'Blue', Size: 'Large' }) });
  assert.deepEqual(getReturnItemVariantLabels(item), ['Color: Blue', 'Size: Large']);
  assert.deepEqual(getReturnItemVariantLabels({ selectedColor: 'blue', selectedOptions: { ' Colour ': 'BLUE' } }), ['Colour: BLUE']);
  assert.deepEqual(getReturnItemVariantLabels({ selectedColor: 'Blue' }), ['Color: Blue']);
  assert.deepEqual(readReturnItemVariants(item), { selectedColor: 'Blue', selectedOptions: { Color: 'Blue', Size: 'Large' } });
  assert.equal(item.selectedOptions.Color, 'Blue');
});

test('read-only variants ignore malformed values, inherited fields and duplicate option names', () => {
  for (const item of [null, {}, { selectedColor: 12, selectedOptions: ['Blue'] }, { selectedOptions: { Size: {}, Color: false } }]) {
    assert.deepEqual(getReturnItemVariantLabels(item), []);
  }
  assert.deepEqual(getReturnItemVariantLabels(Object.create({ selectedColor: 'Private inherited color' })), []);
  assert.deepEqual(getReturnItemVariantLabels({ selectedOptions: Object.assign(Object.create({ Color: 'Inherited' }), { Size: 'L' }) }), ['Size: L']);
  assert.deepEqual(getReturnItemVariantLabels({ selectedOptions: { Color: 'Blue', color: 'BLUE' } }), ['Color: Blue']);
  assert.deepEqual(getReturnItemVariantLabels({ selectedOptions: { Color: 'Red' }, selectedColor: 'Blue' }), ['Color: Red', 'Selected color: Blue']);
});

test('web and native share exactly the same read-only variant rules', () => {
  assert.equal(readFileSync(new URL('../src/utils/returnItemVariants.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../MobileApp/src/utils/returnItemVariants.js', import.meta.url), 'utf8'));
});
