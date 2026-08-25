'use strict';

const {
  isSupportedCurrency,
  normalizeCurrency,
  convertAmount,
  convertAmountSync,
} = require('./currencyService');
const { percentageOfMoney, roundMoney, sumMoney } = require('./moneyMath');

const productPercentageRangeError = () => {
  const error = new RangeError('Percentage price change is too large. Use a value from -100% up to the supported safe numeric range.');
  error.code = 'PRODUCT_PRICE_UPDATE_OUT_OF_RANGE';
  error.status = 400;
  error.statusCode = 400;
  return error;
};

const productCurrencyRepresentationError = ({
  sourceCurrency = 'USD',
  targetCurrency = 'USD',
  productLabel = 'A product',
  field = 'price',
} = {}) => {
  const error = new Error(
    field === 'discountedPrice'
      ? `${productLabel}'s discount cannot be represented to the nearest cent when converting from ${sourceCurrency} to ${targetCurrency}. Adjust or remove the discount before converting product currency.`
      : `${productLabel}'s positive price cannot be represented exactly to the nearest cent when converting from ${sourceCurrency} to ${targetCurrency}. Enter an exact-cent amount or keep the current product currency.`,
  );
  error.code = 'PRODUCT_CURRENCY_PRICE_UNREPRESENTABLE';
  error.status = 409;
  error.statusCode = 409;
  return error;
};

const storedProductCurrencyError = (product, message = 'Stored product currency metadata is invalid.') => {
  const error = new Error(
    `${product?.name || 'A product'} has invalid stored currency metadata. ${message}`
  );
  error.code = 'PRODUCT_CURRENCY_METADATA_INVALID';
  error.status = 409;
  error.statusCode = 409;
  return error;
};

const explicitStoredCurrencyField = (product, field) => {
  if (!product || typeof product !== 'object') return { present: false };
  if (typeof product.$isDefault === 'function' && product.$isDefault(field)) return { present: false };
  const plain = product?.toObject ? product.toObject() : product;
  if (!Object.prototype.hasOwnProperty.call(plain, field)) return { present: false };
  const value = plain[field];
  // Only a genuinely absent legacy field may use the USD fallback. Persisted
  // null/blank metadata is present but corrupt and must not be relabelled.
  return value === undefined ? { present: false } : { present: true, value };
};

const isCanonicalSupportedCurrency = value => (
  typeof value === 'string'
  && Boolean(value)
  && value === value.trim().toUpperCase()
  && isSupportedCurrency(value)
);

function requireStoredProductCurrency(product, fallbackCurrency = 'USD') {
  const explicit = [
    explicitStoredCurrencyField(product, 'currency'),
    explicitStoredCurrencyField(product, 'priceCurrency'),
  ].filter(entry => entry.present).map(entry => entry.value);
  if (explicit.some(value => !isCanonicalSupportedCurrency(value))) {
    throw storedProductCurrencyError(product, 'Use USD, PKR, EUR, or GBP.');
  }
  const normalized = [...new Set(explicit.map(normalizeCurrency))];
  if (normalized.length > 1) {
    throw storedProductCurrencyError(product, 'The price currency fields do not agree.');
  }
  if (normalized.length === 1) return normalized[0];
  if (!isCanonicalSupportedCurrency(fallbackCurrency)) {
    throw storedProductCurrencyError(product, 'The legacy fallback currency is unsupported.');
  }
  return normalizeCurrency(fallbackCurrency);
}

function requireStoredProductDiscountCurrency(product, fallbackCurrency = 'USD') {
  const explicit = [
    explicitStoredCurrencyField(product, 'discountedPriceCurrency'),
    explicitStoredCurrencyField(product, 'discountedCurrency'),
  ].filter(entry => entry.present).map(entry => entry.value);
  if (explicit.some(value => !isCanonicalSupportedCurrency(value))) {
    throw storedProductCurrencyError(product, 'Use USD, PKR, EUR, or GBP for the discount.');
  }
  const normalized = [...new Set(explicit.map(normalizeCurrency))];
  if (normalized.length > 1) {
    throw storedProductCurrencyError(product, 'The discount currency fields do not agree.');
  }
  return normalized[0] || requireStoredProductCurrency(product, fallbackCurrency);
}

const storedProductMoneyError = (product, field) => {
  const error = new Error(`${product?.name || 'A product'} has invalid stored ${field} money.`);
  error.code = 'PRODUCT_PRICE_INVALID';
  error.status = 409;
  error.statusCode = 409;
  return error;
};

function requireStoredProductBasePrice(product) {
  const rawPrice = product?.price;
  if (typeof rawPrice !== 'number' || !Number.isFinite(rawPrice) || rawPrice < 0) {
    throw storedProductMoneyError(product, 'price');
  }
  try {
    if (roundMoney(rawPrice) !== rawPrice) {
      throw storedProductMoneyError(product, 'price precision');
    }
  } catch (error) {
    if (error?.code === 'PRODUCT_PRICE_INVALID') throw error;
    throw storedProductMoneyError(product, 'price');
  }
  return rawPrice;
}

function requireStoredProductDiscountPrice(product) {
  const discountIsSchemaDefault = typeof product?.$isDefault === 'function'
    && product.$isDefault('discountedPrice');
  const plain = product?.toObject ? product.toObject() : product;
  const hasStoredDiscount = !discountIsSchemaDefault
    && plain
    && Object.prototype.hasOwnProperty.call(plain, 'discountedPrice')
    && plain.discountedPrice !== undefined;
  // A genuinely absent legacy discount and the schema's historical null
  // sentinel mean no discount. Every other present value must already be
  // finite, non-negative, and exact to cents.
  if (!hasStoredDiscount || product.discountedPrice === null) return 0;
  const rawDiscount = product.discountedPrice;
  if (typeof rawDiscount !== 'number' || !Number.isFinite(rawDiscount) || rawDiscount < 0) {
    throw storedProductMoneyError(product, 'discounted price');
  }
  try {
    if (roundMoney(rawDiscount) !== rawDiscount) {
      throw storedProductMoneyError(product, 'discounted price precision');
    }
  } catch (error) {
    if (error?.code === 'PRODUCT_PRICE_INVALID') throw error;
    throw storedProductMoneyError(product, 'discounted price');
  }
  return rawDiscount;
}

function requireStoredProductEffectivePrice(product) {
  const price = requireStoredProductBasePrice(product);
  const discountedPrice = requireStoredProductDiscountPrice(product);
  if (discountedPrice > 0 && (price <= 0 || discountedPrice >= price)) {
    throw storedProductMoneyError(product, 'discounted price');
  }
  return discountedPrice > 0 ? discountedPrice : price;
}

function assertRepresentablePositiveProductAmount({
  sourceAmount,
  convertedAmount,
  sourceCurrency = 'USD',
  targetCurrency = 'USD',
  productLabel = 'A product',
  field = 'price',
} = {}) {
  const numericSourceAmount = Number(sourceAmount);
  const amount = roundMoney(convertedAmount);
  const sourceAmountAtCurrencyPrecision = Number.isFinite(numericSourceAmount)
    ? roundMoney(numericSourceAmount)
    : null;
  if (
    Number.isFinite(numericSourceAmount)
    && numericSourceAmount > 0
    && (sourceAmountAtCurrencyPrecision !== numericSourceAmount || amount <= 0)
  ) {
    throw productCurrencyRepresentationError({
      sourceCurrency,
      targetCurrency,
      productLabel,
      field,
    });
  }
  return amount;
}

function assertRepresentableProductAdjustment({
  sourceAmount,
  convertedAmount,
  sourceCurrency = 'USD',
  targetCurrency = 'USD',
  productLabel = 'A product',
} = {}) {
  const numericSourceAmount = Number(sourceAmount);
  const amount = roundMoney(convertedAmount);
  const sourceAmountAtCurrencyPrecision = Number.isFinite(numericSourceAmount)
    ? roundMoney(numericSourceAmount)
    : null;
  if (
    Number.isFinite(numericSourceAmount)
    && numericSourceAmount !== 0
    && (sourceAmountAtCurrencyPrecision !== numericSourceAmount || amount === 0)
  ) {
    const error = new Error(
      `${productLabel}'s requested price adjustment is too small to represent to the nearest cent when converting from ${sourceCurrency} to ${targetCurrency}. Increase the adjustment or use ${targetCurrency}.`,
    );
    error.code = 'PRODUCT_CURRENCY_ADJUSTMENT_UNREPRESENTABLE';
    error.status = 409;
    error.statusCode = 409;
    throw error;
  }
  return amount;
}

function assertEffectiveProductDiscount({
  regularPrice,
  discountedPrice,
  productLabel = 'A product',
} = {}) {
  const price = roundMoney(regularPrice);
  const discount = roundMoney(discountedPrice);
  if (price <= 0 || discount <= 0 || discount >= price) {
    const error = new Error(
      `${productLabel}'s discount is not representable at the current currency precision. Use a smaller discount that leaves a price of at least 0.01 and below the regular price.`,
    );
    error.code = 'PRODUCT_DISCOUNT_UNREPRESENTABLE';
    error.status = 409;
    error.statusCode = 409;
    throw error;
  }
  return discount;
}

function normalizeProductPricePercentage(value) {
  const percentage = Number(value);
  if (
    !Number.isFinite(percentage)
    || percentage < -100
    || Math.abs(percentage) > Number.MAX_SAFE_INTEGER
  ) {
    throw productPercentageRangeError();
  }
  return percentage;
}

function applyProductPricePercentage(price, value) {
  const percentage = normalizeProductPricePercentage(value);
  try {
    const change = percentageOfMoney(price, percentage);
    return Math.max(0, sumMoney([price, change]));
  } catch (error) {
    if (error?.code === 'MONEY_AMOUNT_OUT_OF_RANGE') {
      throw productPercentageRangeError();
    }
    throw error;
  }
}

// Persisted product-currency conversion must never silently turn a positive
// product into a free product, or erase a real discount because both values
// collapse onto the same target cent. Failing the whole conversion lets the
// seller adjust the source price instead of committing a materially different
// catalog. Price and discount can carry different legacy currencies, so their
// raw numeric values must never be compared before conversion.
function normalizeRepresentableConvertedProductPricing({
  sourcePrice,
  convertedPrice,
  sourceDiscountedPrice = 0,
  convertedDiscountedPrice = 0,
  sourceCurrency = 'USD',
  targetCurrency = 'USD',
  productLabel = 'A product',
} = {}) {
  const numericSourcePrice = Number(sourcePrice);
  const numericSourceDiscount = Number(sourceDiscountedPrice);
  const price = assertRepresentablePositiveProductAmount({
    sourceAmount: numericSourcePrice,
    convertedAmount: convertedPrice,
    sourceCurrency,
    targetCurrency,
    productLabel,
    field: 'price',
  });

  const hasSourceDiscount = Number.isFinite(numericSourceDiscount)
    && numericSourceDiscount > 0;
  if (!hasSourceDiscount) return { price, discountedPrice: 0 };

  const discountedPrice = assertRepresentablePositiveProductAmount({
    sourceAmount: numericSourceDiscount,
    convertedAmount: convertedDiscountedPrice,
    sourceCurrency,
    targetCurrency,
    productLabel,
    field: 'discountedPrice',
  });
  if (discountedPrice >= price) {
    throw productCurrencyRepresentationError({
      sourceCurrency,
      targetCurrency,
      productLabel,
      field: 'discountedPrice',
    });
  }
  return { price, discountedPrice };
}

function getProductCurrency(product, _fallbackCurrency = 'USD') {
  // Currency-less legacy Product.price is canonically USD. Display or account
  // currency is never allowed to redefine the denomination of stored money.
  return requireStoredProductCurrency(product, 'USD');
}

function getProductDiscountCurrency(product, _fallbackCurrency = 'USD') {
  const currency = getProductCurrency(product);
  return requireStoredProductDiscountCurrency(product, currency);
}

function getProductBasePrice(product) {
  return requireStoredProductBasePrice(product);
}

function getProductEffectivePrice(product) {
  const effectivePrice = requireStoredProductEffectivePrice(product);
  if (requireStoredProductDiscountPrice(product) > 0) {
    const currency = getProductCurrency(product);
    const discountCurrency = getProductDiscountCurrency(product);
    if (discountCurrency !== currency) {
      throw storedProductCurrencyError(product, 'The active discount currency does not match the product currency.');
    }
  }
  return effectivePrice;
}

async function convertProductAmount(product, amount, targetCurrency = 'USD') {
  return convertAmount(amount, getProductCurrency(product), targetCurrency);
}

function convertProductAmountSync(product, amount, targetCurrency = 'USD') {
  return convertAmountSync(amount, getProductCurrency(product), targetCurrency);
}

function normalizeNativeProductPricing(product, fallbackCurrency = 'USD') {
  if (!product || typeof product !== 'object') return product;

  // This is a stored-product normalizer, not an input parser. Legacy missing
  // metadata has always meant USD; a caller-supplied display/store fallback
  // must not relabel it. Present currency aliases must already agree.
  void fallbackCurrency;
  const currency = requireStoredProductCurrency(product, 'USD');
  const discountSourceCurrency = requireStoredProductDiscountCurrency(product, currency);
  const price = requireStoredProductBasePrice(product);
  const rawDiscountedPrice = requireStoredProductDiscountPrice(product);
  let discountedPrice = 0;
  if (rawDiscountedPrice > 0) {
    const convertedDiscount = discountSourceCurrency === currency
      ? rawDiscountedPrice
      : convertAmountSync(rawDiscountedPrice, discountSourceCurrency, currency);
    discountedPrice = assertRepresentablePositiveProductAmount({
      sourceAmount: rawDiscountedPrice,
      convertedAmount: convertedDiscount,
      sourceCurrency: discountSourceCurrency,
      targetCurrency: currency,
      productLabel: product?.name || 'A product',
      field: 'discountedPrice',
    });
    if (price <= 0 || discountedPrice >= price) {
      throw productCurrencyRepresentationError({
        sourceCurrency: discountSourceCurrency,
        targetCurrency: currency,
        productLabel: product?.name || 'A product',
        field: 'discountedPrice',
      });
    }
  }

  return {
    ...product,
    price,
    discountedPrice,
    currency,
    priceCurrency: currency,
    priceInputAmount: price,
    discountedPriceCurrency: currency,
    discountedPriceInputAmount: discountedPrice,
    priceVersion: 2,
  };
}

module.exports = {
  roundMoney,
  normalizeProductPricePercentage,
  applyProductPricePercentage,
  assertRepresentablePositiveProductAmount,
  assertRepresentableProductAdjustment,
  assertEffectiveProductDiscount,
  normalizeRepresentableConvertedProductPricing,
  requireStoredProductCurrency,
  requireStoredProductDiscountCurrency,
  requireStoredProductBasePrice,
  requireStoredProductDiscountPrice,
  requireStoredProductEffectivePrice,
  getProductCurrency,
  getProductDiscountCurrency,
  getProductBasePrice,
  getProductEffectivePrice,
  convertProductAmount,
  convertProductAmountSync,
  normalizeNativeProductPricing,
};
