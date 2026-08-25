'use strict';

const {
  isSupportedCurrency,
  normalizeCurrency,
  convertAmountWithRates,
  exchangeRatesUnavailableError,
} = require('./currencyService');
const {
  allocateConvertedMinorUnitsByRates,
  fromMinorUnits,
  multiplyMoney,
  roundMoney,
  toMinorUnits,
} = require('./moneyMath');

const storedMoneyIsMissing = value => value === null || value === undefined;

const storedLineMoneyError = label => {
  const error = new Error(`The stored ${label} is invalid.`);
  error.statusCode = 409;
  error.code = 'ORDER_LINE_MONEY_INVALID';
  return error;
};

const requireExactStoredLineMoney = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw storedLineMoneyError(label);
  }
  try {
    if (roundMoney(value) !== value) throw storedLineMoneyError(label);
  } catch (error) {
    if (error?.code === 'ORDER_LINE_MONEY_INVALID') throw error;
    throw storedLineMoneyError(label);
  }
  return value;
};

const requireStoredLineQuantity = item => {
  const quantity = item?.quantity;
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw storedLineMoneyError('order line quantity');
  }
  return quantity;
};

// New orders persist a line-level subtotal in the buyer's order currency.
// That snapshot is authoritative because an FX-converted unit price may be
// smaller than one buyer-currency cent. Legacy orders fall back to their
// historical rounded unit price multiplied by quantity.
const getOrderItemLineSubtotal = item => {
  if (!storedMoneyIsMissing(item?.lineSubtotal)) {
    return requireExactStoredLineMoney(item.lineSubtotal, 'order line subtotal');
  }
  const price = requireExactStoredLineMoney(item?.price, 'legacy order line unit price');
  return multiplyMoney(price, requireStoredLineQuantity(item));
};

const getOrderItemSourceLineSubtotal = item => {
  if (!storedMoneyIsMissing(item?.sourceLineSubtotal)) {
    return requireExactStoredLineMoney(item.sourceLineSubtotal, 'source order line subtotal');
  }
  const rawSourcePrice = !storedMoneyIsMissing(item?.sourcePrice)
    ? item.sourcePrice
    : item?.priceOriginal;
  if (storedMoneyIsMissing(rawSourcePrice)) return null;
  const sourcePrice = requireExactStoredLineMoney(rawSourcePrice, 'legacy source order line unit price');
  return multiplyMoney(sourcePrice, requireStoredLineQuantity(item));
};

const linePricingError = (message, code) => {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
};

const requireOrderQuantity = (
  value,
  { allowZero = false, returnContext = false } = {},
) => {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || (allowZero ? value < 0 : value < 1)
  ) {
    throw linePricingError(
      returnContext
        ? 'Return quantities are invalid.'
        : 'Order quantity must be a positive safe integer.',
      returnContext ? 'RETURN_QUANTITY_INVALID' : 'ORDER_QUANTITY_INVALID',
    );
  }
  return value;
};

// Product-native source prices are persisted currency amounts, not request
// strings or derived FX display units. Reject malformed/sub-cent values at this
// boundary instead of silently coercing or rounding them before allocation.
const requireExactSourcePrice = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw linePricingError('A product price is invalid.', 'ORDER_PRICE_INVALID');
  }
  try {
    if (roundMoney(value) !== value) {
      throw linePricingError('A product price is invalid.', 'ORDER_PRICE_INVALID');
    }
  } catch (error) {
    if (error?.code === 'ORDER_PRICE_INVALID') throw error;
    throw linePricingError('A product price is invalid.', 'ORDER_PRICE_INVALID');
  }
  return value;
};

const requireSupportedLineCurrency = (value, fallback, code) => {
  const raw = value === null || value === undefined
    ? fallback
    : value;
  if (
    typeof raw !== 'string'
    || !isSupportedCurrency(raw)
    || normalizeCurrency(raw) !== raw
  ) {
    throw linePricingError(
      'An order line uses an unsupported currency.',
      code,
    );
  }
  return normalizeCurrency(raw);
};

const requireExactSignedLineAmount = value => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw storedLineMoneyError('return line amount');
  }
  try {
    if (roundMoney(value) !== value) {
      throw storedLineMoneyError('return line amount');
    }
  } catch (error) {
    if (error?.code === 'ORDER_LINE_MONEY_INVALID') throw error;
    throw storedLineMoneyError('return line amount');
  }
  return value;
};

/**
 * Price native-currency product lines into one order currency.
 *
 * Target-native lines remain exact. All foreign lines are converted as exact
 * rational target values, their combined target total is rounded once, and its
 * minor units are allocated by exact converted weights. This prevents both
 * unit-FX rounding and cross-source bucket rounding from making cheap lines
 * free or overcharging them, while persisted lines sum to the exact subtotal.
 */
const priceOrderItemLines = ({
  items = [],
  targetCurrency,
  exchangeRates,
  exchangeRatesFallback = false,
}) => {
  const target = requireSupportedLineCurrency(
    targetCurrency,
    'USD',
    'ORDER_CURRENCY_NOT_SUPPORTED',
  );
  const priced = items.map((item, index) => {
    const quantity = requireOrderQuantity(item?.quantity);
    const sourcePrice = requireExactSourcePrice(item?.sourcePrice);
    const sourceCurrency = requireSupportedLineCurrency(
      item?.sourceCurrency,
      target,
      'ORDER_LINE_CURRENCY_NOT_SUPPORTED',
    );
    if (exchangeRatesFallback && sourceCurrency !== target) {
      throw exchangeRatesUnavailableError();
    }
    const sourceLineSubtotal = multiplyMoney(sourcePrice, quantity);
    const price = sourceCurrency === target
      ? sourcePrice
      : convertAmountWithRates(sourcePrice, sourceCurrency, target, exchangeRates);
    return {
      ...item,
      price,
      sourcePrice,
      sourceCurrency,
      sourceLineSubtotal,
      // A target-native line is already an exact target-cent amount and must
      // remain unchanged. Only foreign lines participate in FX allocation.
      lineSubtotal: sourceCurrency === target ? sourceLineSubtotal : 0,
      __linePricingIndex: index,
    };
  });

  const foreignItems = priced.filter(item => item.sourceCurrency !== target);
  if (foreignItems.length) {
    const { allocations } = allocateConvertedMinorUnitsByRates(
      foreignItems.map(item => ({
        key: item.__linePricingIndex,
        amount: item.sourceLineSubtotal,
        sourceRate: exchangeRates?.[item.sourceCurrency],
      })),
      exchangeRates?.[target],
    );
    foreignItems.forEach((item) => {
      item.lineSubtotal = fromMinorUnits(allocations.get(item.__linePricingIndex) || 0);
    });
  }

  return priced
    .sort((left, right) => left.__linePricingIndex - right.__linePricingIndex)
    .map(({ __linePricingIndex, ...item }) => item);
};

// Allocate a signed, rounded line component to a deterministic quantity range.
// Repeated partial returns therefore conserve the original line cent-for-cent.
const allocateOrderLineAmountForQuantity = (
  fullAmount,
  purchasedQuantity,
  previouslyAllocatedQuantity,
  selectedQuantity,
) => {
  const totalQuantity = requireOrderQuantity(purchasedQuantity, { returnContext: true });
  const previous = requireOrderQuantity(previouslyAllocatedQuantity, {
    allowZero: true,
    returnContext: true,
  });
  const selected = requireOrderQuantity(selectedQuantity, { returnContext: true });
  if (previous + selected > totalQuantity) {
    throw linePricingError('Return quantities are invalid.', 'RETURN_QUANTITY_INVALID');
  }

  const signedMinor = toMinorUnits(requireExactSignedLineAmount(fullAmount));
  const sign = signedMinor < 0 ? -1 : 1;
  const absoluteMinor = Math.abs(signedMinor);
  const baseMinor = Math.floor(absoluteMinor / totalQuantity);
  const remainder = absoluteMinor % totalQuantity;
  const prefix = count => (baseMinor * count) + Math.min(count, remainder);
  return fromMinorUnits(sign * (prefix(previous + selected) - prefix(previous)));
};

module.exports = {
  getOrderItemLineSubtotal,
  getOrderItemSourceLineSubtotal,
  priceOrderItemLines,
  allocateOrderLineAmountForQuantity,
};
