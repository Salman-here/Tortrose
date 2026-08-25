'use strict';

const {
  allocateOrderLineAmountForQuantity,
  getOrderItemLineSubtotal,
  getOrderItemSourceLineSubtotal,
  priceOrderItemLines,
} = require('../../services/orderLinePricingService');
const { sumMoney } = require('../../services/moneyMath');

const rates = { USD: 1, PKR: 280, EUR: 0.8, GBP: 0.7 };

describe('orderLinePricingService', () => {
  it('converts a native line before cent rounding instead of multiplying a rounded FX unit', () => {
    const [oneRupee, twoRupees] = priceOrderItemLines({
      targetCurrency: 'USD',
      exchangeRates: rates,
      items: [
        { name: 'PKR 1', sourcePrice: 1, sourceCurrency: 'PKR', quantity: 1000 },
        { name: 'PKR 2', sourcePrice: 2, sourceCurrency: 'PKR', quantity: 1000 },
      ],
    });

    expect(oneRupee.price).toBe(0);
    expect(twoRupees.price).toBe(0.01);
    expect(oneRupee.sourceLineSubtotal).toBe(1000);
    expect(twoRupees.sourceLineSubtotal).toBe(2000);
    // The PKR 3,000 bucket is USD 10.714..., conserved across both lines.
    expect(oneRupee.lineSubtotal).toBe(3.57);
    expect(twoRupees.lineSubtotal).toBe(7.14);
    expect(sumMoney([oneRupee.lineSubtotal, twoRupees.lineSubtotal])).toBe(10.71);
  });

  it('aggregates same-source low-value lines before conversion and allocates every target cent', () => {
    const priced = priceOrderItemLines({
      targetCurrency: 'USD',
      exchangeRates: rates,
      items: [
        { name: 'A', sourcePrice: 1, sourceCurrency: 'PKR', quantity: 140 },
        { name: 'B', sourcePrice: 1, sourceCurrency: 'PKR', quantity: 140 },
      ],
    });

    expect(priced.map(item => item.lineSubtotal)).toEqual([0.5, 0.5]);
    expect(sumMoney(priced.map(item => item.lineSubtotal))).toBe(1);
  });

  it('keeps native-currency lines exact and supports every mixed source bucket', () => {
    const priced = priceOrderItemLines({
      targetCurrency: 'PKR',
      exchangeRates: rates,
      items: [
        { name: 'Native', sourcePrice: 1.25, sourceCurrency: 'PKR', quantity: 4 },
        { name: 'USD', sourcePrice: 0.01, sourceCurrency: 'USD', quantity: 1000 },
        { name: 'EUR', sourcePrice: 0.8, sourceCurrency: 'EUR', quantity: 2 },
        { name: 'GBP', sourcePrice: 0.7, sourceCurrency: 'GBP', quantity: 3 },
      ],
    });

    expect(priced.map(item => item.lineSubtotal)).toEqual([5, 2800, 560, 840]);
    expect(sumMoney(priced.map(item => item.lineSubtotal))).toBe(4205);
  });

  it.each(['USD', 'PKR', 'EUR', 'GBP'])(
    'prices every supported seller currency into a %s order exactly once',
    (targetCurrency) => {
      const sourceCurrencies = ['USD', 'PKR', 'EUR', 'GBP'];
      const priced = priceOrderItemLines({
        targetCurrency,
        exchangeRates: rates,
        items: sourceCurrencies.map(sourceCurrency => ({
          name: `${sourceCurrency} seller`,
          // One USD of value in each seller's native denomination. Every line
          // must therefore become exactly one target-rate unit, including the
          // target-native line which must remain unchanged.
          sourcePrice: rates[sourceCurrency],
          sourceCurrency,
          quantity: 1,
        })),
      });

      expect(priced.map(item => item.sourceCurrency)).toEqual(sourceCurrencies);
      expect(priced.map(item => item.sourceLineSubtotal)).toEqual(
        sourceCurrencies.map(sourceCurrency => rates[sourceCurrency]),
      );
      expect(priced.map(item => item.lineSubtotal)).toEqual(
        sourceCurrencies.map(() => rates[targetCurrency]),
      );
      expect(sumMoney(priced.map(item => item.lineSubtotal))).toBe(
        rates[targetCurrency] * sourceCurrencies.length,
      );
    },
  );

  it('rounds all foreign source currencies globally while preserving target-native cents', () => {
    const exactRates = { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 };
    const priced = priceOrderItemLines({
      targetCurrency: 'USD',
      exchangeRates: exactRates,
      items: [
        { name: 'Native cent', sourcePrice: 0.01, sourceCurrency: 'USD', quantity: 1 },
        { name: 'PKR', sourcePrice: 1, sourceCurrency: 'PKR', quantity: 1 },
        { name: 'GBP', sourcePrice: 0.01, sourceCurrency: 'GBP', quantity: 1 },
      ],
    });

    // Native USD 0.01 remains untouched. The two foreign exact values sum to
    // USD 0.01617..., so they round together to USD 0.02 (not USD 0.01).
    expect(priced[0].lineSubtotal).toBe(0.01);
    expect(priced.slice(1).map(item => item.lineSubtotal)).toEqual([0.01, 0.01]);
    expect(sumMoney(priced.map(item => item.lineSubtotal))).toBe(0.03);

    const overchargeCase = priceOrderItemLines({
      targetCurrency: 'USD',
      exchangeRates: exactRates,
      items: [
        { name: 'PKR', sourcePrice: 2, sourceCurrency: 'PKR', quantity: 1 },
        { name: 'GBP', sourcePrice: 0.02, sourceCurrency: 'GBP', quantity: 1 },
      ],
    });
    expect(overchargeCase.map(item => item.lineSubtotal)).toEqual([0.01, 0.02]);
    expect(sumMoney(overchargeCase.map(item => item.lineSubtotal))).toBe(0.03);
  });

  it('fails closed when a foreign line only has fallback exchange rates', () => {
    expect(() => priceOrderItemLines({
      targetCurrency: 'USD',
      exchangeRates: rates,
      exchangeRatesFallback: true,
      items: [{ sourcePrice: 100, sourceCurrency: 'PKR', quantity: 1 }],
    })).toThrow(expect.objectContaining({ code: 'EXCHANGE_RATES_UNAVAILABLE' }));
  });

  it('rejects unsupported target and source currencies instead of treating them as USD', () => {
    expect(() => priceOrderItemLines({
      targetCurrency: 'CAD',
      exchangeRates: rates,
      items: [{ sourcePrice: 10, sourceCurrency: 'USD', quantity: 1 }],
    })).toThrow(expect.objectContaining({ code: 'ORDER_CURRENCY_NOT_SUPPORTED' }));

    expect(() => priceOrderItemLines({
      targetCurrency: 'USD',
      exchangeRates: rates,
      items: [{ sourcePrice: 10, sourceCurrency: 'CAD', quantity: 1 }],
    })).toThrow(expect.objectContaining({ code: 'ORDER_LINE_CURRENCY_NOT_SUPPORTED' }));
  });

  it.each([
    ['usd', 'USD', 'ORDER_CURRENCY_NOT_SUPPORTED'],
    [' USD ', 'USD', 'ORDER_CURRENCY_NOT_SUPPORTED'],
    ['', 'USD', 'ORDER_CURRENCY_NOT_SUPPORTED'],
    ['USD', 'pkr', 'ORDER_LINE_CURRENCY_NOT_SUPPORTED'],
    ['USD', ' PKR ', 'ORDER_LINE_CURRENCY_NOT_SUPPORTED'],
    ['USD', '', 'ORDER_LINE_CURRENCY_NOT_SUPPORTED'],
  ])(
    'rejects non-canonical currency input target=%p source=%p',
    (targetCurrency, sourceCurrency, code) => {
      expect(() => priceOrderItemLines({
        targetCurrency,
        exchangeRates: rates,
        items: [{ sourcePrice: 10, sourceCurrency, quantity: 1 }],
      })).toThrow(expect.objectContaining({ code }));
    },
  );

  it('uses the target currency only for a nullish legacy source currency', () => {
    const [legacyLine] = priceOrderItemLines({
      targetCurrency: 'PKR',
      exchangeRates: rates,
      items: [{ sourcePrice: 10, quantity: 1 }],
    });

    expect(legacyLine.sourceCurrency).toBe('PKR');
    expect(legacyLine.lineSubtotal).toBe(10);
  });

  it.each(['2', true, new Number(2), 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects a non-numeric or non-safe order quantity %p without coercion',
    (quantity) => {
      expect(() => priceOrderItemLines({
        targetCurrency: 'USD',
        exchangeRates: rates,
        items: [{ sourcePrice: 1, sourceCurrency: 'USD', quantity }],
      })).toThrow(expect.objectContaining({ code: 'ORDER_QUANTITY_INVALID' }));
    },
  );

  it.each(['1.25', true, false, new Number(1.25), 1.001, Number.POSITIVE_INFINITY, -0.01])(
    'rejects malformed or non-cent source money %p without coercion or rounding',
    (sourcePrice) => {
      expect(() => priceOrderItemLines({
        targetCurrency: 'USD',
        exchangeRates: rates,
        items: [{ sourcePrice, sourceCurrency: 'USD', quantity: 1 }],
      })).toThrow(expect.objectContaining({ code: 'ORDER_PRICE_INVALID' }));
    },
  );

  it('prefers the persisted line snapshot while preserving legacy fallback', () => {
    expect(getOrderItemLineSubtotal({ price: 0, quantity: 1000, lineSubtotal: 3.57 })).toBe(3.57);
    expect(getOrderItemLineSubtotal({ price: 0.00357, quantity: 1000, lineSubtotal: 3.57 })).toBe(3.57);
    expect(getOrderItemLineSubtotal({ price: 1.23, quantity: 3 })).toBe(3.69);
  });

  it.each([true, '', Number.POSITIVE_INFINITY, -1, {}, 1.001])(
    'fails closed for malformed authoritative line subtotal %p',
    (lineSubtotal) => {
      expect(() => getOrderItemLineSubtotal({ price: 10, quantity: 1, lineSubtotal }))
        .toThrow(expect.objectContaining({ code: 'ORDER_LINE_MONEY_INVALID', statusCode: 409 }));
    },
  );

  it('fails closed for malformed legacy unit, source, and quantity snapshots', () => {
    expect(() => getOrderItemLineSubtotal({ price: true, quantity: 1 }))
      .toThrow(expect.objectContaining({ code: 'ORDER_LINE_MONEY_INVALID' }));
    expect(() => getOrderItemLineSubtotal({ price: 10, quantity: 1.5 }))
      .toThrow(expect.objectContaining({ code: 'ORDER_LINE_MONEY_INVALID' }));
    expect(() => getOrderItemSourceLineSubtotal({
      price: 10,
      quantity: 1,
      sourceLineSubtotal: Number.POSITIVE_INFINITY,
    })).toThrow(expect.objectContaining({ code: 'ORDER_LINE_MONEY_INVALID' }));
  });

  it('conserves a line across repeated partial-quantity allocations', () => {
    const parts = [
      allocateOrderLineAmountForQuantity(0.02, 3, 0, 1),
      allocateOrderLineAmountForQuantity(0.02, 3, 1, 1),
      allocateOrderLineAmountForQuantity(0.02, 3, 2, 1),
    ];
    expect(parts).toEqual([0.01, 0.01, 0]);
    expect(sumMoney(parts)).toBe(0.02);
    expect(allocateOrderLineAmountForQuantity(-0.02, 3, 0, 2)).toBe(-0.02);
  });

  it.each([
    ['3', 0, 1],
    [true, 0, 1],
    [3, '0', 1],
    [3, false, 1],
    [3, 0, '1'],
    [3, 0, true],
    [3, 0, 0],
    [Number.MAX_SAFE_INTEGER + 1, 0, 1],
  ])(
    'rejects coerced or invalid return quantities purchased=%p previous=%p selected=%p',
    (purchasedQuantity, previouslyAllocatedQuantity, selectedQuantity) => {
      expect(() => allocateOrderLineAmountForQuantity(
        0.02,
        purchasedQuantity,
        previouslyAllocatedQuantity,
        selectedQuantity,
      )).toThrow(expect.objectContaining({ code: 'RETURN_QUANTITY_INVALID' }));
    },
  );

  it.each(['0.02', true, new Number(0.02), 0.001, Number.NaN])(
    'rejects malformed or non-cent return line money %p',
    (fullAmount) => {
      expect(() => allocateOrderLineAmountForQuantity(fullAmount, 3, 0, 1))
        .toThrow(expect.objectContaining({ code: 'ORDER_LINE_MONEY_INVALID', statusCode: 409 }));
    },
  );
});
