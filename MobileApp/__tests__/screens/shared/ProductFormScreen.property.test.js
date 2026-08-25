/**
 * Property-Based Tests for ProductFormScreen
 * 
 * Feature: mobile-app-modernization
 * Property 28: Product Form Mode Detection
 * Validates: Requirements 19.4, 19.5
 */

import * as fc from 'fast-check';

import {
  buildProductImagePayload,
  buildProductPayload,
  buildProductReturnPolicy,
  getProductFormMode as getFormMode,
  resolveProductFormCurrency,
  normalizeInitialProductImages as normalizeInitialImages,
  validateProductFormContract as validateProductForm,
} from '../../../src/utils/productFormContract';

const validForm = (overrides = {}) => ({
  name: 'Premium Leather Wallet',
  description: 'A durable handmade wallet with clean stitching.',
  price: '49.99',
  discountedPrice: '',
  stock: '5',
  category: 'Accessories',
  brand: 'Rozare Studio',
  ...overrides,
});

const validOptions = (overrides = {}) => ({
  images: ['https://cdn.example.com/product.jpg'],
  returnPolicy: { useStorePolicy: true },
  ...overrides,
});

// Product generator for existing products
const existingProductArbitrary = fc.record({
  _id: fc.uuid(),
  name: fc.string({ minLength: 3, maxLength: 100 }),
  description: fc.string({ minLength: 0, maxLength: 500 }),
  price: fc.integer({ min: 1, max: 100000 }).map(n => n / 100),
  stock: fc.integer({ min: 0, max: 1000 }),
  category: fc.string({ minLength: 0, maxLength: 50 }),
  brand: fc.string({ minLength: 0, maxLength: 50 }),
});

// Form data generator
const formDataArbitrary = fc.record({
  name: fc.oneof(
    fc.constant(''),
    fc.string({ minLength: 1, maxLength: 2 }),
    fc.string({ minLength: 3, maxLength: 100 })
  ),
  price: fc.oneof(
    fc.constant(''),
    fc.constant('0'),
    fc.constant('-10'),
    fc.constant('abc'),
    fc.integer({ min: 1, max: 100000 }).map(n => (n / 100).toString())
  ),
  stock: fc.oneof(
    fc.constant(''),
    fc.constant('-1'),
    fc.constant('abc'),
    fc.integer({ min: 0, max: 1000 }).map(n => n.toString())
  ),
});

describe('ProductFormScreen Property Tests', () => {
  test('currency-less persisted products edit as canonical USD even for a PKR account', () => {
    expect(resolveProductFormCurrency({ _id: 'legacy-1', price: 10 }, 'PKR')).toBe('USD');
  });

  test('new products may inherit the current account currency', () => {
    expect(resolveProductFormCurrency(undefined, 'PKR')).toBe('PKR');
  });

  test.each([
    { _id: 'null', currency: null },
    { _id: 'blank', currency: '' },
    { _id: 'unsupported', currency: 'CAD' },
    { _id: 'boolean', currency: false },
    { _id: 'conflict', currency: 'USD', priceCurrency: 'PKR' },
  ])('fails closed for present corrupt edit currency metadata: %j', product => {
    expect(() => resolveProductFormCurrency(product, 'USD')).toThrow(
      expect.objectContaining({ code: 'PRODUCT_CURRENCY_METADATA_INVALID' })
    );
  });
  /**
   * Property 28: Product Form Mode Detection
   * The ProductFormScreen SHALL detect whether it is in "create" mode (no product passed) 
   * or "edit" mode (existing product passed) and display appropriate UI elements.
   * 
   * Validates: Requirements 19.4, 19.5
   */
  describe('Property 28: Product Form Mode Detection', () => {
    it('should return "create" mode when product is null', () => {
      expect(getFormMode(null)).toBe('create');
    });

    it('should return "create" mode when product is undefined', () => {
      expect(getFormMode(undefined)).toBe('create');
    });

    it('should return "create" mode when product has no _id', () => {
      fc.assert(
        fc.property(
          fc.record({
            name: fc.string(),
            price: fc.integer({ min: 1, max: 1000 }),
          }),
          (product) => {
            expect(getFormMode(product)).toBe('create');
            return true;
          }
        ),
        { numRuns: 50 }
      );
    });

    it('should return "edit" mode when product has _id', () => {
      fc.assert(
        fc.property(existingProductArbitrary, (product) => {
          expect(getFormMode(product)).toBe('edit');
          return true;
        }),
        { numRuns: 100 }
      );
    });

    it('should return "create" mode when product._id is empty string', () => {
      const product = { _id: '', name: 'Test' };
      expect(getFormMode(product)).toBe('create');
    });
  });

  /**
   * Form Validation Tests
   */
  describe('Form Validation', () => {
    it('should require product name', () => {
      const result = validateProductForm(validForm({ name: '' }), validOptions());
      expect(result.isValid).toBe(false);
      expect(result.errors.name).toBeDefined();
    });

    it('should require name to be at least 3 characters', () => {
      const result = validateProductForm(validForm({ name: 'AB' }), validOptions());
      expect(result.isValid).toBe(false);
      expect(result.errors.name).toContain('at least 3 characters');
    });

    it('should require valid price', () => {
      const invalidPrices = ['', '-10', 'abc', '1.001', '1e2', null, undefined, true];
      invalidPrices.forEach(price => {
        const result = validateProductForm(validForm({ price }), validOptions());
        expect(result.isValid).toBe(false);
        expect(result.errors.price).toBeDefined();
      });
    });

    it('should require valid stock', () => {
      const invalidStocks = ['', '-1', 'abc', null, undefined];
      invalidStocks.forEach(stock => {
        const result = validateProductForm(validForm({ stock }), validOptions());
        expect(result.isValid).toBe(false);
        expect(result.errors.stock).toBeDefined();
      });
    });

    it('should accept valid form data', () => {
      fc.assert(
        fc.property(
          fc.record({
            name: fc.string({ minLength: 1, maxLength: 80 }).map(value => `Product ${value}`),
            description: fc.string({ minLength: 1, maxLength: 300 }).map(value => `Description ${value}`),
            price: fc.integer({ min: 1, max: 100000 }).map(n => (n / 100).toString()),
            stock: fc.integer({ min: 0, max: 1000 }).map(n => n.toString()),
            category: fc.constant('Accessories'),
            brand: fc.constant('Rozare Studio'),
            discountedPrice: fc.constant(''),
          }),
          (data) => {
            const result = validateProductForm(data, validOptions());
            expect(result.isValid).toBe(true);
            expect(Object.keys(result.errors).length).toBe(0);
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should allow zero stock', () => {
      const result = validateProductForm(validForm({ stock: '0' }), validOptions());
      expect(result.isValid).toBe(true);
    });

    it('supports an intentional free product but rejects a sale price on it', () => {
      expect(validateProductForm(validForm({ price: '0', discountedPrice: '' }), validOptions()).isValid)
        .toBe(true);
      expect(validateProductForm(validForm({ price: '0.00', discountedPrice: '0' }), validOptions()).isValid)
        .toBe(true);
      expect(validateProductForm(validForm({ price: '0', discountedPrice: '0.01' }), validOptions()).errors.discountedPrice)
        .toBeDefined();
    });

    it('should trim whitespace from name validation', () => {
      const result = validateProductForm(validForm({ name: '   ' }), validOptions());
      expect(result.isValid).toBe(false);
      expect(result.errors.name).toBeDefined();
    });

    it.each([
      ['description', ''],
      ['category', ''],
      ['brand', ''],
    ])('should require %s', (field, value) => {
      const result = validateProductForm(validForm({ [field]: value }), validOptions());
      expect(result.isValid).toBe(false);
      expect(result.errors[field]).toBeDefined();
    });

    it('should require at least one product image', () => {
      const result = validateProductForm(validForm(), validOptions({ images: [] }));
      expect(result.isValid).toBe(false);
      expect(result.errors.images).toBeDefined();
    });

    it('should reject a sale price that is not below the regular price', () => {
      const result = validateProductForm(validForm({ price: '50', discountedPrice: '50' }), validOptions());
      expect(result.errors.discountedPrice).toBeDefined();
    });

    it('should validate custom return and warranty limits', () => {
      const result = validateProductForm(validForm(), validOptions({
        returnPolicy: {
          useStorePolicy: false,
          returnsEnabled: true,
          returnDuration: '0',
          refundType: 'none',
          warrantyEnabled: true,
          warrantyDuration: '121',
        },
      }));
      expect(result.errors.returnDuration).toBeDefined();
      expect(result.errors.refundType).toBeDefined();
      expect(result.errors.warrantyDuration).toBeDefined();
    });
  });

  describe('Backend product contract', () => {
    it('serializes uploaded images as embedded { url } documents and keeps the first as primary', () => {
      const payload = buildProductImagePayload([
        'https://cdn.example.com/main.jpg',
        'https://cdn.example.com/detail.jpg',
        'https://cdn.example.com/main.jpg',
      ]);
      expect(payload).toEqual({
        image: 'https://cdn.example.com/main.jpg',
        images: [
          { url: 'https://cdn.example.com/main.jpg' },
          { url: 'https://cdn.example.com/detail.jpg' },
        ],
      });
    });

    it('normalizes an existing primary image before gallery images without duplicates', () => {
      expect(normalizeInitialImages({
        image: 'https://cdn.example.com/main.jpg',
        images: [
          { url: 'https://cdn.example.com/detail.jpg' },
          { url: 'https://cdn.example.com/main.jpg' },
        ],
      })).toEqual([
        'https://cdn.example.com/main.jpg',
        'https://cdn.example.com/detail.jpg',
      ]);
    });

    it('sends only inheritance for the store-default policy', () => {
      expect(buildProductReturnPolicy({ useStorePolicy: true, returnsEnabled: true })).toEqual({ useStorePolicy: true });
    });

    it('normalizes a custom return policy for the strict backend contract', () => {
      expect(buildProductReturnPolicy({
        useStorePolicy: false,
        returnsEnabled: true,
        returnDuration: '14',
        refundType: 'store_credit',
        warrantyEnabled: true,
        warrantyDuration: '12',
        warrantyDescription: ' Manufacturer warranty ',
        policyDescription: ' Unused and in original packaging ',
      })).toEqual({
        useStorePolicy: false,
        returnsEnabled: true,
        returnDuration: 14,
        refundType: 'store_credit',
        warrantyEnabled: true,
        warrantyDuration: 12,
        warrantyDescription: 'Manufacturer warranty',
        policyDescription: 'Unused and in original packaging',
      });
    });

    it('builds the complete backend payload with native currency metadata and a primary image', () => {
      const payload = buildProductPayload({
        data: validForm({ price: '50', discountedPrice: '40', stock: '7' }),
        uploadedImages: ['https://cdn.example.com/main.jpg', 'https://cdn.example.com/detail.jpg'],
        currency: 'PKR',
        tags: [' leather ', 'gift', 'gift'],
        optionGroups: [
          { name: ' Color ', values: ['Black', ' Black ', 'Brown'], default: 'Black' },
          { name: '', values: ['Ignored'] },
        ],
        returnPolicy: { useStorePolicy: true },
        isFeatured: true,
      });

      expect(payload).toEqual(expect.objectContaining({
        name: 'Premium Leather Wallet',
        description: 'A durable handmade wallet with clean stitching.',
        price: 50,
        discountedPrice: 40,
        stock: 7,
        category: 'Accessories',
        brand: 'Rozare Studio',
        currency: 'PKR',
        priceCurrency: 'PKR',
        priceInputAmount: 50,
        discountedPriceCurrency: 'PKR',
        discountedPriceInputAmount: 40,
        image: 'https://cdn.example.com/main.jpg',
        images: [
          { url: 'https://cdn.example.com/main.jpg' },
          { url: 'https://cdn.example.com/detail.jpg' },
        ],
        tags: ['leather', 'gift'],
        optionGroups: [{ name: 'Color', values: ['Black', 'Brown'], default: 'Black' }],
        returnPolicy: { useStorePolicy: true },
        isFeatured: true,
      }));
    });
  });
});
