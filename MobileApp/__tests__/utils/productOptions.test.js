import {
  getInitialProductSelections,
  getProductOptionGroups,
  hasProductOptions,
  validateProductSelections,
} from '../../src/utils/productOptions';

const configurableProduct = {
  _id: 'product-options-mobile',
  name: 'Premium overshirt',
  colors: ['Legacy black'],
  optionGroups: [
    { name: 'Color', values: ['Navy', 'Stone'], default: 'Stone' },
    { name: 'Size', values: ['Small', 'Large'], default: 'Large' },
  ],
};

describe('mobile product option helpers', () => {
  it('normalizes groups and suppresses legacy colors when Color is modern', () => {
    expect(hasProductOptions(configurableProduct)).toBe(true);
    expect(getProductOptionGroups(configurableProduct)).toEqual([
      { name: 'Color', values: ['Navy', 'Stone'], default: 'Stone', legacy: false },
      { name: 'Size', values: ['Small', 'Large'], default: 'Large', legacy: false },
    ]);
  });

  it('keeps seller defaults as suggestions and still requires explicit selection', () => {
    expect(getInitialProductSelections(configurableProduct)).toEqual({
      selectedColor: null,
      selectedOptions: {},
    });
    const validation = validateProductSelections(configurableProduct);
    expect(validation.ok).toBe(false);
    expect(validation.missingOptions.map(option => option.name)).toEqual(['Color', 'Size']);
  });

  it('canonicalizes explicit values for the cart line', () => {
    expect(validateProductSelections(configurableProduct, {
      selectedColor: 'navy',
      selectedOptions: { color: 'navy', SIZE: 'large' },
    })).toMatchObject({
      ok: true,
      selectedColor: 'Navy',
      selectedOptions: { Color: 'Navy', Size: 'Large' },
      selectedCount: 2,
      totalCount: 2,
    });
  });

  it('supports legacy colors and rejects stale or fabricated metadata', () => {
    const legacy = { name: 'Cap', colors: ['Black', 'White'] };
    expect(validateProductSelections(legacy, {
      selectedOptions: { color: 'black' },
    })).toMatchObject({
      ok: true,
      selectedColor: 'Black',
      selectedOptions: undefined,
    });

    const invalid = validateProductSelections(legacy, {
      selectedColor: 'Purple',
      selectedOptions: { Size: 'XL' },
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.invalidOptions.map(option => option.name)).toEqual(
      expect.arrayContaining(['Color', 'Size']),
    );
  });
});
