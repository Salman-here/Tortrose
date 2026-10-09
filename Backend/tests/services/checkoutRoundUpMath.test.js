'use strict';

const fc = require('fast-check');
const { allocateCheckoutMinorUnitsByRates, fromMinorUnits } = require('../../services/moneyMath');

describe('exact upward rounding primitive and conserved component budgets', () => {
  test('converts PKR product and shipping directly to EUR and records the fractional remainder', () => {
    const result = allocateCheckoutMinorUnitsByRates([
      { key: 'product', amount: 1000, sourceRate: 277.08 },
      { key: 'shipping', amount: 200, sourceRate: 277.08 },
    ], 0.893);
    expect(result.totalMinor).toBe(387);
    expect([...result.allocations.values()].reduce((sum, value) => sum + value, 0)).toBe(387);
    // Shipping has the larger fractional-cent remainder, so it receives the
    // single checkout cent. Neither component is independently rounded up.
    expect(fromMinorUnits(result.allocations.get('product'))).toBe(3.22);
    expect(fromMinorUnits(result.allocations.get('shipping'))).toBe(0.65);
    expect(BigInt(result.remainderMinor.numerator)).toBeGreaterThanOrEqual(0n);
    expect(BigInt(result.remainderMinor.numerator)).toBeLessThan(BigInt(result.remainderMinor.denominator));
  });

  test('the primitive rounds supplied components once; the seller policy separately chooses owner budgets', () => {
    const result = allocateCheckoutMinorUnitsByRates([
      { key: 'A', amount: 301.2, sourceRate: 300 },
      { key: 'B', amount: 301.2, sourceRate: 300 },
    ], 1);
    expect(result.totalMinor).toBe(201);
    expect([...result.allocations.values()]).toEqual([101, 100]);
  });

  test('seller components consume the already allocated share without a second round-up', () => {
    const components = allocateCheckoutMinorUnitsByRates([
      { key: 'product', amount: 250, sourceRate: 300 },
      { key: 'shipping', amount: 51.2, sourceRate: 300 },
    ], 1, 2, { targetTotalMinor: 100 });
    expect(components.totalMinor).toBe(100);
    expect([...components.allocations.values()].reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(BigInt(components.remainderMinor.numerator)).toBeLessThan(0n);
    expect(() => allocateCheckoutMinorUnitsByRates([{ key: 'sale', amount: 301.2, sourceRate: 300 }], 1, 2, { targetTotalMinor: 102 })).toThrow();
    const discounted = allocateCheckoutMinorUnitsByRates([
      { key: 'product', amount: 1000, sourceRate: 277.08 },
      { key: 'coupon', amount: -1000, sourceRate: 277.08 },
    ], 0.893, 2, { targetTotalMinor: 0 });
    expect([...discounted.allocations.values()].reduce((sum, value) => sum + value, 0)).toBe(0);
  });

  test('native product prices and exact-cent checkouts remain unchanged', () => {
    expect(allocateCheckoutMinorUnitsByRates([
      { key: 'price', amount: 19.99, sourceRate: 1 },
      { key: 'shipping', amount: 5, sourceRate: 1 },
      { key: 'coupon', amount: -2.5, sourceRate: 1 },
    ], 1)).toMatchObject({ totalMinor: 2249, remainderMinor: { numerator: '0', denominator: '1' } });
    const mixed = allocateCheckoutMinorUnitsByRates([
      { key: 'native', amount: 29.99, sourceRate: 1 },
      { key: 'foreign', amount: 1990, sourceRate: 277.86 },
    ], 1);
    expect(mixed.allocations.get('native')).toBe(2999);
    expect(mixed.totalMinor).toBe(3716);
  });

  test('discounts participate before the single rounding boundary; free orders stay free', () => {
    const result = allocateCheckoutMinorUnitsByRates([
      { key: 'product', amount: 1000, sourceRate: 277.08 },
      { key: 'shipping', amount: 200, sourceRate: 277.08 },
      { key: 'discount', amount: -100, sourceRate: 277.08 },
    ], 0.893);
    expect(result.totalMinor).toBe(355);
    expect([...result.allocations.values()].reduce((sum, value) => sum + value, 0)).toBe(355);
    expect(result.allocations.get('discount')).toBeLessThanOrEqual(0);
    const free = allocateCheckoutMinorUnitsByRates([
      { key: 'product', amount: 1000, sourceRate: 277.08 },
      { key: 'discount', amount: -1000, sourceRate: 277.08 },
    ], 0.893);
    expect(free.totalMinor).toBe(0);
  });

  test('never invents an extra cent at exact boundaries or accepts negative/corrupt totals', () => {
    expect(allocateCheckoutMinorUnitsByRates([{ key: 'one', amount: 1.01, sourceRate: 1 }], 1).totalMinor).toBe(101);
    expect(() => allocateCheckoutMinorUnitsByRates([{ key: 'bad', amount: -1, sourceRate: 1 }], 1)).toThrow();
    expect(() => allocateCheckoutMinorUnitsByRates([{ key: 'bad', amount: 1, sourceRate: 0 }], 1)).toThrow();
    expect(() => allocateCheckoutMinorUnitsByRates([{ key: 'bad', amount: Infinity, sourceRate: 1 }], 1)).toThrow();
    expect(() => allocateCheckoutMinorUnitsByRates([{ key: 'same', amount: 1, sourceRate: 1 }, { key: 'same', amount: 2, sourceRate: 1 }], 1)).toThrow();
  });

  test('randomized mixed-rate components conserve buyer cents and keep the remainder below one cent', () => {
    fc.assert(fc.property(fc.array(fc.record({ amount: fc.integer({ min: 0, max: 1000000 }), rate: fc.integer({ min: 1, max: 50000 }) }), { maxLength: 40 }), rows => {
      const result = allocateCheckoutMinorUnitsByRates(rows.map((row, index) => ({ key: index, amount: row.amount / 100, sourceRate: row.rate / 100 })), 1);
      expect([...result.allocations.values()].reduce((sum, value) => sum + value, 0)).toBe(result.totalMinor);
      const numerator = BigInt(result.remainderMinor.numerator), denominator = BigInt(result.remainderMinor.denominator);
      expect(numerator).toBeGreaterThanOrEqual(0n);
      expect(numerator).toBeLessThan(denominator);
      const exact = result.exactTotalMinor;
      expect(BigInt(result.totalMinor) * BigInt(exact.denominator)).toBeGreaterThanOrEqual(BigInt(exact.numerator));
      expect((BigInt(result.totalMinor) - 1n) * BigInt(exact.denominator)).toBeLessThan(BigInt(exact.numerator));
    }), { numRuns: 500 });
  });
});
