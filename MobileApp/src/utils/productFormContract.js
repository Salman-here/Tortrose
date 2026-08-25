import { MAX_DESCRIPTION_LENGTH } from './categories';
import { parseExactMoneyInput } from './sellerMoneySafety';

export const DEFAULT_PRODUCT_RETURN_POLICY = Object.freeze({
  useStorePolicy: true,
  returnsEnabled: false,
  returnDuration: '',
  refundType: 'none',
  warrantyEnabled: false,
  warrantyDuration: '',
  warrantyDescription: '',
  policyDescription: '',
});

export const getProductFormMode = (product) => (product?._id ? 'edit' : 'create');

const SUPPORTED_PRODUCT_CURRENCIES = new Set(['USD', 'PKR', 'EUR', 'GBP']);

const invalidProductCurrencyMetadata = () => {
  const error = new Error('Product currency metadata is invalid. Refresh the product before editing it.');
  error.code = 'PRODUCT_CURRENCY_METADATA_INVALID';
  return error;
};

const requireProductCurrency = (value) => {
  if (typeof value !== 'string' || !value.trim()) throw invalidProductCurrencyMetadata();
  const normalized = value.trim().toUpperCase();
  if (!SUPPORTED_PRODUCT_CURRENCIES.has(normalized)) throw invalidProductCurrencyMetadata();
  return normalized;
};

export const resolveProductFormCurrency = (product, accountCurrency = 'USD') => {
  const explicitCurrencies = [...new Set(
    ['currency', 'priceCurrency']
      .filter(field => Object.prototype.hasOwnProperty.call(product || {}, field))
      .map(field => product[field])
      // Only absent fields are legacy. Explicit null/undefined/blank and
      // unsupported values are corrupt and must fail closed.
      .map(requireProductCurrency)
  )];
  if (explicitCurrencies.length > 1) throw invalidProductCurrencyMetadata();
  // Persisted currency-less products are legacy canonical USD. Only a new
  // product inherits the currently selected seller/account currency.
  return explicitCurrencies[0] || requireProductCurrency(
    getProductFormMode(product) === 'edit' ? 'USD' : accountCurrency
  );
};

export const normalizeProductImageUri = (image) => {
  if (!image) return '';
  if (typeof image === 'string') return image.trim();
  return String(image.url || image.secure_url || image.imageUrl || image.uri || '').trim();
};

export const normalizeInitialProductImages = (product) => {
  const candidates = [product?.image, ...(Array.isArray(product?.images) ? product.images : [])]
    .map(normalizeProductImageUri)
    .filter(Boolean);
  return [...new Set(candidates)].slice(0, 5);
};

export const buildProductImagePayload = (uploadedImages = []) => {
  const source = Array.isArray(uploadedImages) ? uploadedImages : [];
  const urls = [...new Set(source.map(normalizeProductImageUri).filter(Boolean))].slice(0, 5);
  return {
    image: urls[0] || '',
    images: urls.map((url) => ({ url })),
  };
};

export const buildProductReturnPolicy = (policy = DEFAULT_PRODUCT_RETURN_POLICY) => {
  if (policy?.useStorePolicy !== false) return { useStorePolicy: true };
  return {
    useStorePolicy: false,
    returnsEnabled: policy.returnsEnabled === true,
    returnDuration: policy.returnsEnabled ? Math.trunc(Number(policy.returnDuration) || 0) : 0,
    refundType: policy.returnsEnabled ? policy.refundType : 'none',
    warrantyEnabled: policy.warrantyEnabled === true,
    warrantyDuration: policy.warrantyEnabled ? Math.trunc(Number(policy.warrantyDuration) || 0) : 0,
    warrantyDescription: String(policy.warrantyDescription || '').trim().slice(0, 200),
    policyDescription: String(policy.policyDescription || '').trim().slice(0, 500),
  };
};

export const buildProductPayload = ({
  data,
  uploadedImages,
  currency,
  tags = [],
  optionGroups = [],
  returnPolicy,
  isFeatured = false,
}) => {
  const imagePayload = buildProductImagePayload(uploadedImages);
  const priceValue = parseExactMoneyInput(data?.price);
  const discountedPriceText = String(data?.discountedPrice ?? '').trim();
  const discountedPriceValue = discountedPriceText
    ? parseExactMoneyInput(discountedPriceText)
    : { amount: 0, minorUnits: 0 };
  const stockText = String(data?.stock ?? '').trim();
  const stock = /^\d+$/.test(stockText) ? Number(stockText) : Number.NaN;
  if (
    !priceValue
    || !discountedPriceValue
    || !Number.isSafeInteger(stock)
    || stock < 0
    || (discountedPriceValue.minorUnits > 0 && (
      priceValue.minorUnits === 0
      || discountedPriceValue.minorUnits >= priceValue.minorUnits
    ))
  ) {
    const error = new Error('Product price, sale price, or stock is invalid.');
    error.code = 'PRODUCT_FORM_MONEY_INVALID';
    throw error;
  }
  const price = priceValue.amount;
  const discountedPrice = discountedPriceValue.amount;
  const cleanTags = [...new Set((Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag || '').trim())
    .filter(Boolean))].slice(0, 15);
  const cleanOptionGroups = (Array.isArray(optionGroups) ? optionGroups : [])
    .map((group) => {
      const values = [...new Set((Array.isArray(group?.values) ? group.values : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean))];
      return {
        name: String(group?.name || '').trim(),
        values,
        default: values.includes(group?.default) ? group.default : '',
      };
    })
    .filter((group) => group.name && group.values.length > 0);

  return {
    name: String(data?.name || '').trim(),
    description: String(data?.description || '').trim().slice(0, MAX_DESCRIPTION_LENGTH),
    price,
    discountedPrice,
    currency,
    priceCurrency: currency,
    priceInputAmount: price,
    discountedPriceCurrency: currency,
    discountedPriceInputAmount: discountedPrice,
    stock,
    category: String(data?.category || '').trim(),
    brand: String(data?.brand || '').trim(),
    ...imagePayload,
    tags: cleanTags,
    optionGroups: cleanOptionGroups,
    returnPolicy: buildProductReturnPolicy(returnPolicy),
    isFeatured: isFeatured === true,
  };
};

export const validateProductFormContract = (data, options = {}) => {
  const errors = {};
  const name = String(data?.name || '').trim();
  const description = String(data?.description || '').trim();
  const category = String(data?.category || '').trim();
  const brand = String(data?.brand || '').trim();
  const priceText = String(data?.price ?? '').trim();
  const stockText = String(data?.stock ?? '').trim();
  const discountedPriceText = String(data?.discountedPrice ?? '').trim();
  const price = parseExactMoneyInput(priceText);
  const discountedPrice = discountedPriceText
    ? parseExactMoneyInput(discountedPriceText)
    : { amount: 0, minorUnits: 0 };
  const stock = /^\d+$/.test(stockText) ? Number(stockText) : Number.NaN;

  if (!name) errors.name = 'Product name is required';
  else if (name.length < 3) errors.name = 'Use at least 3 characters';
  else if (name.length > 140) errors.name = 'Keep the name under 140 characters';

  if (!description) errors.description = 'Product description is required';
  else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.description = `Keep the description under ${MAX_DESCRIPTION_LENGTH} characters`;
  }

  if (!category) errors.category = 'Choose a product category';
  if (!brand) errors.brand = 'Brand is required';
  if (!price) {
    errors.price = 'Enter a non-negative price with no more than two decimal places';
  }
  if (!stockText || !Number.isSafeInteger(stock) || stock < 0) {
    errors.stock = 'Enter a whole stock quantity of zero or more';
  }
  if (
    !discountedPrice
    || (discountedPrice.minorUnits > 0 && (
      !price
      || price.minorUnits === 0
      || discountedPrice.minorUnits >= price.minorUnits
    ))
  ) {
    errors.discountedPrice = 'Sale price must be zero/blank or lower than a positive regular price';
  }

  if (Object.prototype.hasOwnProperty.call(options, 'images')) {
    const imageCount = Array.isArray(options.images)
      ? new Set(options.images.map(normalizeProductImageUri).filter(Boolean)).size
      : 0;
    if (imageCount === 0) errors.images = 'Add at least one clear product image';
    else if (imageCount > 5) errors.images = 'You can add up to 5 product images';
  }

  const policy = options.returnPolicy;
  if (policy && policy.useStorePolicy === false) {
    const returnDuration = Number(policy.returnDuration);
    const warrantyDuration = Number(policy.warrantyDuration);
    if (policy.returnsEnabled) {
      if (!Number.isInteger(returnDuration) || returnDuration < 1 || returnDuration > 365) {
        errors.returnDuration = 'Return window must be between 1 and 365 days';
      }
      if (!['full_refund', 'store_credit', 'replacement_only'].includes(policy.refundType)) {
        errors.refundType = 'Choose how approved returns are resolved';
      }
    }
    if (policy.warrantyEnabled && (!Number.isInteger(warrantyDuration) || warrantyDuration < 1 || warrantyDuration > 120)) {
      errors.warrantyDuration = 'Warranty must be between 1 and 120 months';
    }
  }

  return { isValid: Object.keys(errors).length === 0, errors };
};
