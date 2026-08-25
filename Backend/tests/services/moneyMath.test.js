'use strict';

const fc = require('fast-check');

const {
  allocateConvertedMinorUnitsByRates,
  allocateHouseMonotoneMinorUnits,
  allocateMinorUnitsByWeights,
  fromMinorUnits,
  isExactDecimalAtScale,
  convertMoneyByRates,
  multiplyMoney,
  percentageOfMoney,
  sumMoney,
  roundMoney,
  toMinorUnits,
} = require('../../services/moneyMath');

describe('moneyMath exact minor-unit boundaries', () => {
  const referenceDhondt = (total, entries) => {
    const allocations = entries.map(() => 0);
    for (let seat = 0; seat < total; seat += 1) {
      let selected = -1;
      for (let index = 0; index < entries.length; index += 1) {
        if (allocations[index] >= entries[index].weight) continue;
        if (selected < 0) {
          selected = index;
          continue;
        }
        const left = BigInt(entries[index].weight) * BigInt(allocations[selected] + 1);
        const right = BigInt(entries[selected].weight) * BigInt(allocations[index] + 1);
        if (left > right || (left === right && index < selected)) selected = index;
      }
      if (selected < 0) throw new Error('Reference allocation exceeded capacity');
      allocations[selected] += 1;
    }
    return new Map(entries.map((entry, index) => [entry.key, allocations[index]]));
  };

  test.each([
    [1.005, 1.01],
    [2.675, 2.68],
    [-1.005, -1.01],
    [0.1 + 0.2, 0.3],
    ['5e-3', 0.01],
    ['4e-3', 0],
  ])('rounds %p deterministically to %p', (input, expected) => {
    expect(roundMoney(input)).toBe(expected);
  });

  it('multiplies cent-denominated unit prices without binary-float drift', () => {
    expect(multiplyMoney(19.99, 3)).toBe(59.97);
    expect(multiplyMoney(0.1, 3)).toBe(0.3);
  });

  it('aggregates sub-cent values before rounding the final total', () => {
    expect(sumMoney([0.004, 0.004, 0.004])).toBe(0.01);
    expect(sumMoney(['0.004', '-0.001', '0.002'], 6)).toBe(0.005);
  });

  it('supports two-decimal and zero-decimal payment processor units', () => {
    expect(toMinorUnits('10.005')).toBe(1001);
    expect(toMinorUnits('10.5', 0)).toBe(11);
    expect(fromMinorUnits(1001)).toBe(10.01);
  });

  test.each(['1001', true, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid minor-unit input %p instead of coercing it',
    value => {
      expect(() => fromMinorUnits(value)).toThrow('safe integer');
    },
  );

  it('converts across decimal rate ratios without binary half-cent drift', () => {
    expect(convertMoneyByRates(1, 1, 1.005)).toBe(1.01);
    expect(convertMoneyByRates(280, 280, 1)).toBe(1);
    expect(convertMoneyByRates(1, 1, 280)).toBe(280);
    expect(convertMoneyByRates(10, 0.9, 280)).toBe(3111.11);
  });

  it('calculates percentage taxes and discounts at an exact cent boundary', () => {
    expect(percentageOfMoney(0.01, 50)).toBe(0.01);
    expect(percentageOfMoney(19.99, 12.5)).toBe(2.5);
    expect(percentageOfMoney(100, -2.5)).toBe(-2.5);
  });

  test.each([undefined, null, '', true, {}, Number.NaN, Number.POSITIVE_INFINITY])(
    'never drops invalid money operand %p as zero',
    value => {
      expect(() => toMinorUnits(value)).toThrow(expect.objectContaining({ code: 'MONEY_AMOUNT_INVALID' }));
      expect(() => roundMoney(value)).toThrow(expect.objectContaining({ code: 'MONEY_AMOUNT_INVALID' }));
      expect(() => sumMoney([1, value])).toThrow(expect.objectContaining({ code: 'MONEY_AMOUNT_INVALID' }));
      expect(() => multiplyMoney(value, 1)).toThrow(expect.objectContaining({ code: 'MONEY_AMOUNT_INVALID' }));
      expect(() => percentageOfMoney(1, value)).toThrow(expect.objectContaining({ code: 'MONEY_AMOUNT_INVALID' }));
      expect(() => convertMoneyByRates(1, value, 1)).toThrow(expect.objectContaining({ code: 'MONEY_AMOUNT_INVALID' }));
    },
  );

  test('validates bounded two-decimal percentages without coercion or non-reversible overflow', () => {
    expect(isExactDecimalAtScale(40, { scale: 2, min: 0, max: 100 })).toBe(true);
    expect(isExactDecimalAtScale(12.34, { scale: 2, min: 0, max: 100 })).toBe(true);
    for (const value of [true, '40', '', 40.001, -0.01, 100.01, Number.POSITIVE_INFINITY]) {
      expect(isExactDecimalAtScale(value, { scale: 2, min: 0, max: 100 })).toBe(false);
    }
    expect(isExactDecimalAtScale(Number.MAX_VALUE, {
      scale: 2,
      min: 0,
      max: Number.MAX_VALUE,
    })).toBe(false);
  });

  test.each(['2', true, 1.5, -1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid money quantity %p instead of coercing or rounding it',
    quantity => {
      expect(() => multiplyMoney(1, quantity))
        .toThrow(expect.objectContaining({ code: 'MONEY_AMOUNT_INVALID' }));
    },
  );

  it('rejects values beyond the lossless decimal-storage range', () => {
    expect(() => toMinorUnits('90071992547409.92')).toThrow('too large');
  });

  it('fails closed before adjacent cents collapse in decimal Number storage', () => {
    const lastUniversallyReversibleCent = 7036874417766400;
    expect(toMinorUnits('70368744177664.00')).toBe(lastUniversallyReversibleCent);
    expect(fromMinorUnits(lastUniversallyReversibleCent)).toBe(70368744177664);

    // Above the boundary, .01 and .02 can become the same Number. Accepting
    // either direction would let a persisted amount silently change a cent.
    expect(() => toMinorUnits('70368744177664.01')).toThrow(
      expect.objectContaining({ code: 'MONEY_AMOUNT_OUT_OF_RANGE' }),
    );
    expect(() => fromMinorUnits(lastUniversallyReversibleCent + 1)).toThrow(
      expect.objectContaining({ code: 'MONEY_AMOUNT_OUT_OF_RANGE' }),
    );
  });

  test.each([-1, 1.5, 7, '2', true])(
    'rejects unsupported money scale %p in both conversion directions',
    scale => {
      expect(() => toMinorUnits(1, scale)).toThrow('scale');
      expect(() => fromMinorUnits(1, scale)).toThrow('scale');
    },
  );

  it('ranks extreme largest remainders exactly and breaks true ties by input order', () => {
    expect(allocateMinorUnitsByWeights(1, [
      { key: 'slightly-smaller', weight: '9007199254740991.01' },
      { key: 'slightly-larger', weight: '9007199254740991.02' },
    ])).toEqual(new Map([
      ['slightly-smaller', 0],
      ['slightly-larger', 1],
    ]));

    expect([...allocateMinorUnitsByWeights(
      5,
      Array.from({ length: 10 }, (_, index) => ({ key: index, weight: 1 })),
    ).values()]).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
  });

  test.each([undefined, null, '', true, {}, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'rejects invalid proportional allocation weight %p instead of silently dropping it',
    weight => {
      expect(() => allocateMinorUnitsByWeights(1, [
        { key: 'valid', weight: 1 },
        { key: 'invalid', weight },
      ])).toThrow(expect.objectContaining({ code: 'MONEY_AMOUNT_INVALID' }));
    },
  );

  test.each([-1, '1', true, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid proportional allocation total %p instead of coercing or clamping it',
    total => {
      expect(() => allocateMinorUnitsByWeights(total, [{ key: 'valid', weight: 1 }]))
        .toThrow('safe integer');
    },
  );

  it('rejects proportional and converted allocation totals beyond the reversible cent range', () => {
    expect(() => allocateMinorUnitsByWeights(7036874417766401, [
      { key: 'seller', weight: 1 },
    ])).toThrow(expect.objectContaining({ code: 'MONEY_AMOUNT_OUT_OF_RANGE' }));
    expect(() => allocateConvertedMinorUnitsByRates([
      { key: 'seller', amount: '70368744177664.01', sourceRate: 1 },
    ], 1)).toThrow(expect.objectContaining({ code: 'MONEY_AMOUNT_OUT_OF_RANGE' }));
  });

  it('rounds mixed foreign currencies globally before allocating target cents', () => {
    const underchargeCase = allocateConvertedMinorUnitsByRates([
      { key: 'pkr', amount: 1, sourceRate: 284.6 },
      { key: 'gbp', amount: 0.01, sourceRate: 0.79 },
    ], 1);
    expect(underchargeCase.totalMinorUnits).toBe(2);
    expect([...underchargeCase.allocations.values()].reduce((sum, value) => sum + value, 0)).toBe(2);

    const overchargeCase = allocateConvertedMinorUnitsByRates([
      { key: 'pkr', amount: 2, sourceRate: 284.6 },
      { key: 'gbp', amount: 0.02, sourceRate: 0.79 },
    ], 1);
    expect(overchargeCase.totalMinorUnits).toBe(3);
    expect([...overchargeCase.allocations.values()].reduce((sum, value) => sum + value, 0)).toBe(3);
  });

  it('assigns converted cents by each owner exact fractional remainder', () => {
    const result = allocateConvertedMinorUnitsByRates([
      { key: 'seller-a', amount: 3.27, sourceRate: 284.6 },
      { key: 'seller-b', amount: 1, sourceRate: 284.6 },
    ], 1);

    // Exact target minor units are about 1.14898c and 0.35137c. Their sum
    // rounds to 2c, so floors [1,0] plus the largest remainder produce [1,1].
    expect(result.totalMinorUnits).toBe(2);
    expect(result.allocations).toEqual(new Map([
      ['seller-a', 1],
      ['seller-b', 1],
    ]));
  });

  it('redistributes a global rounding cent without breaking an owner hard cap', () => {
    const result = allocateConvertedMinorUnitsByRates([
      {
        key: 'capped-coupon',
        amount: 3.99,
        sourceRate: 284.6,
        maximumAllocationMinorUnits: 1,
      },
      { key: 'other-coupon', amount: 1.14, sourceRate: 284.6 },
    ], 1);

    // Exact values total about 1.8025 cents => 2 cents. The first coupon's
    // representable max is 1 cent, so the residual cent belongs to the second.
    expect(result.totalMinorUnits).toBe(2);
    expect(result.allocations).toEqual(new Map([
      ['capped-coupon', 1],
      ['other-coupon', 1],
    ]));
  });

  it('allocates cumulative seller exposure monotonically and identically staged or one-shot', () => {
    const entries = [
      { key: 'seller-a', weight: 100 },
      { key: 'seller-b', weight: 300 },
      { key: 'seller-c', weight: 300 },
    ];
    let prior = new Map(entries.map(entry => [entry.key, 0]));
    for (const target of [1, 52, 53, 137, 699, 700]) {
      const oneShot = allocateHouseMonotoneMinorUnits(target, entries);
      expect([...oneShot.values()].reduce((sum, amount) => sum + amount, 0)).toBe(target);
      for (const entry of entries) {
        expect(oneShot.get(entry.key)).toBeGreaterThanOrEqual(prior.get(entry.key));
        expect(oneShot.get(entry.key)).toBeLessThanOrEqual(entry.weight);
      }
      // Calling only at the staged checkpoints yields the exact same map as a
      // fresh one-shot call because the allocation is path-independent.
      expect(allocateHouseMonotoneMinorUnits(target, entries)).toEqual(oneShot);
      prior = oneShot;
    }
    expect(prior).toEqual(new Map([
      ['seller-a', 100],
      ['seller-b', 300],
      ['seller-c', 300],
    ]));
  });

  test.each([
    ['total', '1', [{ key: 'seller', weight: 1 }]],
    ['total', -1, [{ key: 'seller', weight: 1 }]],
    ['weight', 1, [{ key: 'seller', weight: '1' }]],
    ['weight', 1, [{ key: 'seller', weight: -1 }]],
  ])('rejects invalid house-monotone %s input without coercion', (_label, total, entries) => {
    expect(() => allocateHouseMonotoneMinorUnits(total, entries)).toThrow();
  });

  it('rejects house-monotone totals and capacities that cannot round-trip as cents', () => {
    expect(() => allocateHouseMonotoneMinorUnits(7036874417766401, [
      { key: 'seller', weight: 7036874417766401 },
    ])).toThrow(expect.objectContaining({ code: 'MONEY_AMOUNT_OUT_OF_RANGE' }));
    expect(() => allocateHouseMonotoneMinorUnits(1, [
      { key: 'a', weight: 3518437208883201 },
      { key: 'b', weight: 3518437208883201 },
    ])).toThrow(expect.objectContaining({ code: 'MONEY_AMOUNT_OUT_OF_RANGE' }));
  });

  it('canonicalizes an exact D’Hondt boundary tie after divisor acceleration', () => {
    const weights = [75, 41, 51, 89, 85, 31, 34, 44];
    const entries = weights.map((weight, index) => ({ key: `k${index}`, weight }));

    expect([...allocateHouseMonotoneMinorUnits(235, entries).values()]).toEqual([
      39, 21, 27, 47, 45, 16, 17, 23,
    ]);
    expect(allocateHouseMonotoneMinorUnits(235, entries)).toEqual(referenceDhondt(235, entries));
  });

  it('never moves a seller cent backwards between the known adjacent-target counterexample', () => {
    const weights = [112, 263, 5, 216, 176, 251, 22, 132, 77];
    const entries = weights.map((weight, index) => ({ key: `k${index}`, weight }));
    const at337 = allocateHouseMonotoneMinorUnits(337, entries);
    const at338 = allocateHouseMonotoneMinorUnits(338, entries);

    for (const entry of entries) expect(at338.get(entry.key)).toBeGreaterThanOrEqual(at337.get(entry.key));
    expect(at337).toEqual(referenceDhondt(337, entries));
    expect(at338).toEqual(referenceDhondt(338, entries));
  });

  it('property: accelerated allocation equals exact sequential D’Hondt and is adjacent-target monotone', () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 0, max: 300 }), { minLength: 1, maxLength: 10 }),
      fc.integer({ min: 0, max: 100000 }),
      (weights, rawTarget) => {
        const entries = weights.map((weight, index) => ({ key: `k${index}`, weight }));
        const capacity = weights.reduce((sum, weight) => sum + weight, 0);
        const target = capacity ? rawTarget % (capacity + 1) : 0;
        const actual = allocateHouseMonotoneMinorUnits(target, entries);
        expect(actual).toEqual(referenceDhondt(target, entries));
        expect([...actual.values()].reduce((sum, value) => sum + value, 0)).toBe(target);

        if (target < capacity) {
          const adjacent = allocateHouseMonotoneMinorUnits(target + 1, entries);
          expect(adjacent).toEqual(referenceDhondt(target + 1, entries));
          for (const entry of entries) {
            expect(adjacent.get(entry.key)).toBeGreaterThanOrEqual(actual.get(entry.key));
          }
        }
      },
    ), { numRuns: 300 });
  });
});
