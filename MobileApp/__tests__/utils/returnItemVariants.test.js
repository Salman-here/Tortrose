import { getReturnItemVariantLabels, readReturnItemVariants } from '../../src/utils/returnItemVariants';

test('stored Color and selectedColor display once alongside other selected options', () => {
  const item = Object.freeze({ selectedColor: 'Blue', selectedOptions: Object.freeze({ Color: 'Blue', Size: 'Large' }) });
  expect(getReturnItemVariantLabels(item)).toEqual(['Color: Blue', 'Size: Large']);
  expect(getReturnItemVariantLabels({ selectedColor: 'blue', selectedOptions: { ' Colour ': 'BLUE' } })).toEqual(['Colour: BLUE']);
  expect(getReturnItemVariantLabels({ selectedColor: 'Blue' })).toEqual(['Color: Blue']);
  expect(readReturnItemVariants(item)).toEqual({ selectedColor: 'Blue', selectedOptions: { Color: 'Blue', Size: 'Large' } });
});

test('variants ignore malformed and inherited values without coercing them', () => {
  [null, {}, { selectedColor: 12, selectedOptions: ['Blue'] }, { selectedOptions: { Size: {}, Color: false } }].forEach(item => {
    expect(getReturnItemVariantLabels(item)).toEqual([]);
  });
  expect(getReturnItemVariantLabels(Object.create({ selectedColor: 'Private inherited color' }))).toEqual([]);
  expect(getReturnItemVariantLabels({ selectedOptions: { Color: 'Blue', color: 'BLUE' } })).toEqual(['Color: Blue']);
});
