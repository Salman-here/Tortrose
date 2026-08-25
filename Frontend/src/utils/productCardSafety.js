import {
  exactCurrencyCode,
  isExactNonNegativeJsonMoney,
  parseExactMoneyInput,
} from './sellerMoneySafety.js';

const safeProductId = value => typeof value === 'string' && /^[a-f\d]{24}$/iu.test(value);
const exactJsonMoney = value => (
  isExactNonNegativeJsonMoney(value) ? parseExactMoneyInput(value) : null
);

export const inspectSellerProductPresentation = (product) => {
  const value = product && typeof product === 'object' && !Array.isArray(product) ? product : {};
  const currency = exactCurrencyCode(value.currency);
  const priceCurrency = exactCurrencyCode(value.priceCurrency);
  const discountedPriceCurrency = exactCurrencyCode(value.discountedPriceCurrency);
  const price = exactJsonMoney(value.price);
  const discountedPrice = exactJsonMoney(value.discountedPrice);
  const currenciesValid = Boolean(currency)
    && priceCurrency === currency
    && discountedPriceCurrency === currency;
  const discountValid = Boolean(discountedPrice)
    && (discountedPrice.minorUnits === 0 || (
      Boolean(price)
      && discountedPrice.minorUnits < price.minorUnits
    ));
  const moneyValid = Boolean(price) && currenciesValid && discountValid;
  const stockValid = Number.isSafeInteger(value.stock) && value.stock >= 0;
  const ratingValid = typeof value.rating === 'number'
    && Number.isFinite(value.rating)
    && value.rating >= 0
    && value.rating <= 5;
  const reviewCountValid = Number.isSafeInteger(value.numReviews) && value.numReviews >= 0;
  const discountPercent = moneyValid
    && discountedPrice.minorUnits > 0
    && price.minorUnits > 0
    ? Number((
      ((BigInt(price.minorUnits) - BigInt(discountedPrice.minorUnits)) * 100n)
      + (BigInt(price.minorUnits) / 2n)
    ) / BigInt(price.minorUnits))
    : 0;
  const errors = [];
  if (!currenciesValid) errors.push('currency');
  if (!price) errors.push('price');
  if (!discountValid) errors.push('discountedPrice');
  if (!stockValid) errors.push('stock');

  return {
    valid: moneyValid && stockValid,
    errors,
    managementSafe: safeProductId(value._id),
    moneyValid,
    currency: moneyValid ? currency : null,
    price: moneyValid ? price.amount : null,
    discountedPrice: moneyValid && discountedPrice.minorUnits > 0
      ? discountedPrice.amount
      : null,
    hasDiscount: moneyValid && discountedPrice.minorUnits > 0,
    discountPercent,
    stockValid,
    stock: stockValid ? value.stock : null,
    ratingValid,
    rating: ratingValid ? value.rating : null,
    reviewCountValid,
    reviewCount: reviewCountValid ? value.numReviews : null,
  };
};

export const inspectSellerProductCard = inspectSellerProductPresentation;

export const inspectProductPagination = (pagination, {
  productCount,
  expectedPage,
  expectedLimit,
} = {}) => {
  if (!pagination || typeof pagination !== 'object' || Array.isArray(pagination)) {
    return { valid: false };
  }
  const { page, limit, totalProducts, totalPages, hasMore } = pagination;
  const valuesAreValid = Number.isSafeInteger(page) && page >= 1
    && Number.isSafeInteger(limit) && limit >= 1
    && Number.isSafeInteger(totalProducts) && totalProducts >= 0
    && Number.isSafeInteger(totalPages) && totalPages >= 1
    && typeof hasMore === 'boolean'
    && Number.isSafeInteger(productCount) && productCount >= 0 && productCount <= limit
    && (expectedPage === undefined || page === expectedPage)
    && (expectedLimit === undefined || limit === expectedLimit);
  if (!valuesAreValid) return { valid: false };

  const calculatedPages = Math.max(1, Math.ceil(totalProducts / limit));
  const pageStartsAt = (page - 1) * limit;
  const countFitsPage = page <= totalPages
    ? pageStartsAt + productCount <= totalProducts
    : productCount === 0;
  if (
    totalPages !== calculatedPages
    || hasMore !== (page < totalPages)
    || !countFitsPage
  ) return { valid: false };

  return {
    valid: true,
    page,
    limit,
    totalProducts,
    totalPages,
    hasMore,
  };
};

export const sellerInventoryOverviewIsValid = (inventory) => {
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) return false;
  const countKeys = ['totalProducts', 'outOfStock', 'lowStock', 'featuredProducts'];
  if (!countKeys.every(key => Number.isSafeInteger(inventory[key]) && inventory[key] >= 0)) {
    return false;
  }
  if (
    inventory.outOfStock + inventory.lowStock > inventory.totalProducts
    || inventory.featuredProducts > inventory.totalProducts
  ) return false;
  if (
    !Array.isArray(inventory.categories)
    || inventory.categories.length > 5
    || !inventory.categories.every(row => (
      row
      && typeof row.category === 'string'
      && Boolean(row.category.trim())
      && Number.isSafeInteger(row.count)
      && row.count > 0
    ))
    || inventory.categories.reduce((sum, row) => sum + BigInt(row.count), 0n) > BigInt(inventory.totalProducts)
  ) return false;
  if (
    !Array.isArray(inventory.recentProducts)
    || inventory.recentProducts.length > 5
    || !inventory.recentProducts.every(product => inspectSellerProductPresentation(product).valid)
  ) return false;
  if (
    !Array.isArray(inventory.topRatedProducts)
    || inventory.topRatedProducts.length > 4
    || !inventory.topRatedProducts.every((product) => {
      const presentation = inspectSellerProductPresentation(product);
      return presentation.valid
        && presentation.ratingValid
        && presentation.rating >= 4
        && presentation.reviewCountValid;
    })
  ) return false;
  return true;
};
