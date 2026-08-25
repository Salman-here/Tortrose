const ShippingMethod = require('../models/ShippingMethod');
const Product = require('../models/Product');
const User = require('../models/User');
const Store = require('../models/Store');
const {
  isSupportedCurrency,
  normalizeCurrency,
  convertAmountUsingTrustedRates,
} = require('../services/currencyService');
const { roundMoney } = require('../services/moneyMath');
const {
  parsePositiveSafeInteger,
  parseStrictFiniteNumber,
} = require('../services/numericInputService');
const { publicProductFilter } = require('../services/productModerationService');
const {
  normalizeStorePaymentPolicy,
  storeAllowsCashOnDelivery,
  PAYMENT_POLICY_LABELS,
} = require('../services/storePaymentPolicyService');

const shippingDataError = (message, code = 'SHIPPING_DATA_INVALID') => {
  const error = new Error(message);
  error.status = 409;
  error.statusCode = 409;
  error.code = code;
  return error;
};

const requireCanonicalCurrency = (value, { input = false, label = 'Currency' } = {}) => {
  if (input) {
    if (typeof value !== 'string' || !value.trim() || !isSupportedCurrency(value)) {
      throw shippingInputError(`${label} must be USD, PKR, EUR, or GBP`);
    }
    return normalizeCurrency(value);
  }
  if (
    typeof value !== 'string'
    || !value.trim()
    || value !== value.trim().toUpperCase()
    || !isSupportedCurrency(value)
  ) {
    if (input) throw shippingInputError(`${label} must be USD, PKR, EUR, or GBP`);
    throw shippingDataError(`${label} contains invalid stored currency metadata.`, 'SHIPPING_CURRENCY_METADATA_INVALID');
  }
  return normalizeCurrency(value);
};

const getSellerCurrency = async (sellerId, fallbackCurrency = 'USD') => {
  const [store, seller] = sellerId
    ? await Promise.all([
      Store.findOne({ seller: sellerId }).select('productCurrency').lean(),
      User.findById(sellerId).select('currency').lean(),
    ])
    : [null, null];
  const rawCurrency = store?.productCurrency ?? seller?.currency ?? fallbackCurrency;
  return requireCanonicalCurrency(rawCurrency, { label: 'Seller currency' });
};

const shippingInputError = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'SHIPPING_INPUT_INVALID';
  return error;
};

const normalizeShippingCostInput = (method = {}) => {
  const rawCost = method.cost;
  if (method.type === 'free') {
    if (rawCost === undefined || rawCost === null || rawCost === '') return 0;
    if (
      typeof rawCost === 'boolean'
      || (typeof rawCost === 'string' && !rawCost.trim())
      || parseStrictFiniteNumber(rawCost) !== 0
    ) {
      throw shippingInputError('Free shipping must have 0 cost');
    }
    return 0;
  }

  if (
    rawCost === undefined
    || rawCost === null
    || typeof rawCost === 'boolean'
    || (typeof rawCost === 'string' && !rawCost.trim())
    || parseStrictFiniteNumber(rawCost) === null
  ) {
    throw shippingInputError('Paid shipping cost must be a positive number');
  }
  try {
    const parsedCost = parseStrictFiniteNumber(rawCost);
    const cost = roundMoney(parsedCost);
    if (cost !== parsedCost) {
      throw shippingInputError('Paid shipping cost must use exact cents');
    }
    if (cost <= 0) throw shippingInputError('Paid shipping methods must have cost > 0');
    return cost;
  } catch (error) {
    if (String(error?.code || '').startsWith('MONEY_')) {
      throw shippingInputError('Shipping cost is too large');
    }
    throw error;
  }
};

const normalizeDeliveryDaysInput = (rawDays) => {
  if (
    rawDays === undefined
    || rawDays === null
    || typeof rawDays === 'boolean'
    || (typeof rawDays === 'string' && !rawDays.trim())
  ) {
    throw shippingInputError('Delivery days must be a whole number of at least 1');
  }
  const deliveryDays = parsePositiveSafeInteger(rawDays);
  if (deliveryDays === null) {
    throw shippingInputError('Delivery days must be a whole number of at least 1');
  }
  return deliveryDays;
};

const serializeShippingMethod = (method, fallbackCurrency = 'USD') => {
  const raw = method?.toObject ? method.toObject() : { ...(method || {}) };
  const storedCurrencies = [raw.currency, raw.costCurrency]
    .filter(value => value !== null && value !== undefined)
    .map(value => requireCanonicalCurrency(value, { label: 'Shipping method' }));
  const currencies = [...new Set(storedCurrencies)];
  if (currencies.length > 1) {
    throw shippingDataError(
      'Shipping method contains conflicting stored currency metadata.',
      'SHIPPING_CURRENCY_METADATA_INVALID',
    );
  }
  const currency = currencies[0]
    || requireCanonicalCurrency(fallbackCurrency, { label: 'Shipping fallback currency' });

  let cost;
  let costInputAmount;
  try {
    cost = roundMoney(raw.cost);
    costInputAmount = raw.costInputAmount == null ? cost : roundMoney(raw.costInputAmount);
  } catch (_) {
    throw shippingDataError('Shipping method contains an invalid stored cost.', 'SHIPPING_COST_INVALID');
  }
  if (
    !['free', 'standard', 'fast'].includes(raw.type)
    || typeof raw.cost !== 'number'
    || cost !== raw.cost
    || (raw.type === 'free' ? cost !== 0 : cost <= 0)
    || (raw.costInputAmount != null && (
      typeof raw.costInputAmount !== 'number'
      || costInputAmount !== raw.costInputAmount
      || (raw.type === 'free' ? costInputAmount !== 0 : costInputAmount <= 0)
    ))
  ) {
    throw shippingDataError('Shipping method contains an invalid stored cost.', 'SHIPPING_COST_INVALID');
  }
  if (!Number.isSafeInteger(raw.deliveryDays) || raw.deliveryDays < 1) {
    throw shippingDataError('Shipping method contains invalid stored delivery days.');
  }
  return {
    ...raw,
    cost,
    currency,
    costCurrency: currency,
    costInputAmount,
  };
};

const normalizeShippingMethodInput = async (method, fallbackCurrency = 'USD') => {
  const currency = requireCanonicalCurrency(
    method.currency ?? method.costCurrency ?? fallbackCurrency,
    { input: true, label: 'Shipping currency' },
  );
  const sourceCurrency = requireCanonicalCurrency(
    method.costCurrency ?? method.currency ?? currency,
    { input: true, label: 'Shipping cost currency' },
  );
  const rawCost = normalizeShippingCostInput(method);
  const deliveryDays = normalizeDeliveryDaysInput(method.deliveryDays);
  const cost = method.type === 'free'
    ? 0
    : sourceCurrency === currency
      ? rawCost
      : await convertAmountUsingTrustedRates(rawCost, sourceCurrency, currency);

  return {
    type: method.type,
    cost,
    currency,
    costCurrency: currency,
    costInputAmount: cost,
    deliveryDays,
    isActive: method.isActive !== false,
  };
};

// Get shipping methods for a specific seller
const getSellerShippingMethods = async (req, res) => {
  try {
    const { sellerId } = req.params;
    
    let shippingMethods = await ShippingMethod.findOne({ seller: sellerId });
    
    // If seller has no shipping methods, return default structure
    if (!shippingMethods) {
      return res.status(200).json({
        success: true,
        shippingMethods: {
          seller: sellerId,
          methods: []
        }
      });
    }

    const response = shippingMethods.toObject();
    response.methods = (response.methods || []).map(method => serializeShippingMethod(method, 'USD'));
    
    res.status(200).json({
      success: true,
      shippingMethods: response
    });
  } catch (error) {
    const statusCode = error.statusCode || error.status || 500;
    if (statusCode >= 500) console.error('Error fetching seller shipping methods:', error);
    res.status(statusCode).json({
      success: false,
      msg: statusCode < 500 ? error.message : 'Failed to fetch shipping methods',
      code: error.code,
    });
  }
};

// Update seller's shipping methods (seller only)
const updateShippingMethods = async (req, res) => {
  try {
    const { methods, currency } = req.body;
    const sellerId = req.user._id || req.user.id;
    const sellerCurrency = await getSellerCurrency(sellerId, req.user.currency || currency || 'USD');
    const inputCurrency = requireCanonicalCurrency(currency ?? sellerCurrency, { input: true });
    
    // Validation
    if (!methods || !Array.isArray(methods)) {
      return res.status(400).json({
        success: false,
        msg: 'Methods must be an array'
      });
    }
    if (methods.length < 1 || methods.length > 3) {
      return res.status(400).json({
        success: false,
        msg: 'Provide between one and three shipping methods',
      });
    }
    if (currency !== undefined && currency !== null) {
      try {
        requireCanonicalCurrency(currency, { input: true });
      } catch (error) {
        return res.status(error.statusCode).json({ success: false, msg: error.message, code: error.code });
      }
    }
    
    // Validate each method
    const normalizedMethods = [];
    const seenMethodTypes = new Set();
    for (const method of methods) {
      for (const field of ['currency', 'costCurrency']) {
        if (method[field] !== undefined && method[field] !== null) {
          try {
            requireCanonicalCurrency(method[field], { input: true, label: field });
          } catch (error) {
            return res.status(error.statusCode).json({ success: false, msg: error.message, code: error.code });
          }
        }
      }
      if (!['free', 'standard', 'fast'].includes(method.type)) {
        return res.status(400).json({
          success: false,
          msg: 'Invalid shipping method type'
        });
      }
      if (seenMethodTypes.has(method.type)) {
        return res.status(400).json({
          success: false,
          msg: 'Each shipping method type can be configured only once',
        });
      }
      seenMethodTypes.add(method.type);
      const normalizedMethod = await normalizeShippingMethodInput(
        {
          ...method,
          currency: method.currency ?? inputCurrency,
          costCurrency: method.costCurrency ?? method.currency ?? inputCurrency,
        },
        inputCurrency
      );
      
      if (normalizedMethod.type === 'free' && normalizedMethod.cost !== 0) {
        return res.status(400).json({
          success: false,
          msg: 'Free shipping must have 0 cost'
        });
      }
      
      if (normalizedMethod.type !== 'free' && normalizedMethod.cost <= 0) {
        return res.status(400).json({
          success: false,
          msg: 'Paid shipping methods must have cost > 0'
        });
      }
      
      if (!Number.isInteger(normalizedMethod.deliveryDays) || normalizedMethod.deliveryDays < 1) {
        return res.status(400).json({
          success: false,
          msg: 'Delivery days must be a whole number of at least 1'
        });
      }
      normalizedMethods.push(normalizedMethod);
    }
    
    // Ensure at least one method is active
    const hasActiveMethod = normalizedMethods.some(m => m.isActive);
    if (!hasActiveMethod) {
      return res.status(400).json({
        success: false,
        msg: 'At least one shipping method must be active'
      });
    }
    
    // Find existing or create new
    let shippingMethods = await ShippingMethod.findOne({ seller: sellerId });
    
    if (shippingMethods) {
      shippingMethods.methods = normalizedMethods;
      await shippingMethods.save();
    } else {
      shippingMethods = await ShippingMethod.create({
        seller: sellerId,
        methods: normalizedMethods
      });
    }
    
    res.status(200).json({
      success: true,
      msg: 'Shipping methods updated successfully',
      shippingMethods
    });
  } catch (error) {
    const statusCode = error.statusCode || error.status || 500;
    if (statusCode >= 500) console.error('Error updating shipping methods:', error);
    res.status(statusCode).json({
      success: false,
      msg: error.statusCode || error.status ? error.message : 'Failed to update shipping methods',
      code: error.code,
    });
  }
};

// Get shipping methods for cart items (grouped by seller)
const getShippingMethodsForCart = async (req, res) => {
  try {
    const { cartItems } = req.body;
    
    if (!cartItems || !Array.isArray(cartItems)) {
      return res.status(400).json({
        success: false,
        msg: 'Cart items must be provided as an array'
      });
    }
    
    // Extract unique seller IDs from cart items
    const productIds = cartItems.map(item => item.productId || item.product?._id);
    const products = await Product.find(publicProductFilter({ _id: { $in: productIds } })).select('seller');
    
    const sellerIds = [...new Set(products.map(p => p.seller.toString()))];
    
    // Fetch shipping methods and store payment policies for all sellers.
    const [shippingMethods, stores] = await Promise.all([
      ShippingMethod.find({
        seller: { $in: sellerIds }
      }).populate('seller', 'username currency'),
      Store.find({ seller: { $in: sellerIds } }).select('seller storeName storeSlug paymentPolicy productCurrency').lean(),
    ]);
    const storeBySeller = new Map(stores.map(store => [store.seller.toString(), store]));
    
    // Create a map of seller to their shipping methods
    const sellerShippingMap = {};
    
    for (const sellerId of sellerIds) {
      const sellerShipping = shippingMethods.find(
        sm => sm.seller._id.toString() === sellerId
      );
      const store = storeBySeller.get(sellerId) || null;
      const paymentPolicy = normalizeStorePaymentPolicy(store?.paymentPolicy);
      const paymentInfo = {
        store: store ? { _id: store._id, storeName: store.storeName, storeSlug: store.storeSlug } : null,
        paymentPolicy,
        paymentPolicyLabel: PAYMENT_POLICY_LABELS[paymentPolicy],
        allowsCashOnDelivery: storeAllowsCashOnDelivery(store),
      };
      
      if (sellerShipping) {
        sellerShippingMap[sellerId] = {
          seller: sellerShipping.seller,
          ...paymentInfo,
          methods: sellerShipping.methods
            .filter(m => m.isActive)
            .map(method => serializeShippingMethod(method, 'USD'))
        };
      } else {
        const sellerCurrency = await getSellerCurrency(sellerId);
        // Default shipping methods if seller hasn't configured any
        sellerShippingMap[sellerId] = {
          seller: { _id: sellerId, currency: sellerCurrency },
          ...paymentInfo,
          methods: [
            { type: 'free', cost: 0, currency: sellerCurrency, costCurrency: sellerCurrency, costInputAmount: 0, deliveryDays: 5, isActive: true }
          ]
        };
      }
    }
    
    res.status(200).json({
      success: true,
      shippingMethods: sellerShippingMap
    });
  } catch (error) {
    const statusCode = error.statusCode || error.status || 500;
    if (statusCode >= 500) console.error('Error fetching cart shipping methods:', error);
    res.status(statusCode).json({
      success: false,
      msg: statusCode < 500 ? error.message : 'Failed to fetch shipping methods for cart',
      code: error.code,
    });
  }
};

module.exports = {
  getSellerShippingMethods,
  updateShippingMethods,
  getShippingMethodsForCart
};
