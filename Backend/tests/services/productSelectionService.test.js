const {
  validateProductSelection,
  createProductSelectionError,
} = require('../../services/productSelectionService');

describe('product selection service', () => {
  test('allows a product that has no configurable options', () => {
    expect(validateProductSelection({ name: 'Simple product' }, {})).toEqual({
      ok: true,
      selectedColor: null,
      selectedOptions: undefined,
      missingOptions: [],
      invalidOptions: [],
      requiredOptions: [],
      availableColors: [],
    });
  });

  test('requires every option explicitly even when the seller configured a default', () => {
    const product = {
      name: 'Premium shirt',
      optionGroups: [
        { name: 'Size', values: ['Small', 'Medium'], default: 'Medium' },
        { name: 'Material', values: ['Cotton', 'Linen'] },
      ],
    };

    const selection = validateProductSelection(product, {});

    expect(selection.ok).toBe(false);
    expect(selection.missingOptions.map(option => option.name)).toEqual(['Size', 'Material']);
  });

  test('canonicalizes option names and values case-insensitively', () => {
    const product = {
      name: 'Jacket',
      optionGroups: [
        { name: 'Color', values: ['Navy', 'Stone'] },
        { name: 'Size', values: ['M', 'L'] },
      ],
    };

    const selection = validateProductSelection(product, {
      selectedColor: 'navy',
      selectedOptions: { SIZE: 'm' },
    });

    expect(selection).toMatchObject({
      ok: true,
      selectedColor: 'Navy',
      selectedOptions: { Color: 'Navy', Size: 'M' },
    });
  });

  test('supports legacy color products without duplicating Color in selectedOptions', () => {
    const selection = validateProductSelection(
      { name: 'Legacy cap', colors: ['Black', 'White'] },
      { selectedOptions: { color: 'black' } },
    );

    expect(selection).toMatchObject({
      ok: true,
      selectedColor: 'Black',
      selectedOptions: undefined,
    });
  });

  test('rejects stale, fabricated, and conflicting option metadata', () => {
    const product = {
      name: 'Sneaker',
      optionGroups: [{ name: 'Color', values: ['Black', 'White'] }],
    };

    const selection = validateProductSelection(product, {
      selectedColor: 'White',
      selectedOptions: { Color: 'Black', Width: 'Ultra-wide' },
    });

    expect(selection.ok).toBe(false);
    expect(selection.invalidOptions.map(option => option.name)).toEqual(
      expect.arrayContaining(['Color', 'Width']),
    );
  });

  test('creates a structured picker response for API clients', () => {
    const product = {
      _id: 'product-1',
      name: 'Watch strap',
      optionGroups: [{ name: 'Length', values: ['Short', 'Long'] }],
    };
    const selection = validateProductSelection(product, {});
    const error = createProductSelectionError(product, selection, 'add');

    expect(error).toMatchObject({
      statusCode: 400,
      code: 'PRODUCT_OPTIONS_REQUIRED',
      needsSelection: true,
      productId: 'product-1',
      productName: 'Watch strap',
      requiredOptions: [{ name: 'Length', values: ['Short', 'Long'] }],
    });
  });
});
