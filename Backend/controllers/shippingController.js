const ShippingMethod = require('../models/ShippingMethod');
const Product = require('../models/Product');
const User = require('../models/User');
const { normalizeCurrency, convertAmount } = require('../services/currencyService');
const { publicProductFilter } = require('../services/productModerationService');

const roundMoney = (value) => {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
};

const getSellerCurrency = async (sellerId, fallbackCurrency = 'USD') => {
  const seller = sellerId
    ? await User.findById(sellerId).select('currency').lean()
    : null;
  return normalizeCurrency(seller?.currency || fallbackCurrency);
};

const serializeShippingMethod = (method, fallbackCurrency = 'USD') => {
  const raw = method?.toObject ? method.toObject() : { ...(method || {}) };
  const currency = normalizeCurrency(raw.currency || raw.costCurrency || fallbackCurrency);
  const cost = roundMoney(raw.cost);
  return {
    ...raw,
    cost,
    currency,
    costCurrency: currency,
    costInputAmount: raw.costInputAmount != null ? roundMoney(raw.costInputAmount) : cost,
  };
};

const normalizeShippingMethodInput = async (method, fallbackCurrency = 'USD') => {
  const currency = normalizeCurrency(method.currency || method.costCurrency || fallbackCurrency);
  const sourceCurrency = normalizeCurrency(method.costCurrency || method.currency || currency);
  const rawCost = method.type === 'free' ? 0 : roundMoney(method.cost);
  const deliveryDays = Number(method.deliveryDays);
  const cost = method.type === 'free'
    ? 0
    : sourceCurrency === currency
      ? rawCost
      : await convertAmount(rawCost, sourceCurrency, currency);

  return {
    type: method.type,
    cost,
    currency,
    costCurrency: currency,
    costInputAmount: cost,
    deliveryDays: Number.isFinite(deliveryDays) ? deliveryDays : 1,
    isActive: method.isActive !== false,
  };
};

// Get shipping methods for a specific seller
const getSellerShippingMethods = async (req, res) => {
  try {
    const { sellerId } = req.params;
    
    const sellerCurrency = await getSellerCurrency(sellerId);
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
    response.methods = (response.methods || []).map(method => serializeShippingMethod(method, sellerCurrency));
    
    res.status(200).json({
      success: true,
      shippingMethods: response
    });
  } catch (error) {
    console.error('Error fetching seller shipping methods:', error);
    res.status(500).json({
      success: false,
      msg: 'Failed to fetch shipping methods'
    });
  }
};

// Update seller's shipping methods (seller only)
const updateShippingMethods = async (req, res) => {
  try {
    const { methods, currency } = req.body;
    const sellerId = req.user._id || req.user.id;
    const sellerCurrency = await getSellerCurrency(sellerId, req.user.currency || currency || 'USD');
    const inputCurrency = normalizeCurrency(currency || req.user.currency || sellerCurrency);
    
    // Validation
    if (!methods || !Array.isArray(methods)) {
      return res.status(400).json({
        success: false,
        msg: 'Methods must be an array'
      });
    }
    
    // Validate each method
    const normalizedMethods = [];
    for (const method of methods) {
      if (!['free', 'standard', 'fast'].includes(method.type)) {
        return res.status(400).json({
          success: false,
          msg: 'Invalid shipping method type'
        });
      }
      const normalizedMethod = await normalizeShippingMethodInput(
        { ...method, currency: method.currency || inputCurrency, costCurrency: method.costCurrency || method.currency || inputCurrency },
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
      
      if (normalizedMethod.deliveryDays < 1) {
        return res.status(400).json({
          success: false,
          msg: 'Delivery days must be at least 1'
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
    console.error('Error updating shipping methods:', error);
    res.status(500).json({
      success: false,
      msg: 'Failed to update shipping methods'
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
    
    // Fetch shipping methods for all sellers
    const shippingMethods = await ShippingMethod.find({
      seller: { $in: sellerIds }
    }).populate('seller', 'username currency');
    
    // Create a map of seller to their shipping methods
    const sellerShippingMap = {};
    
    for (const sellerId of sellerIds) {
      const sellerShipping = shippingMethods.find(
        sm => sm.seller._id.toString() === sellerId
      );
      
      if (sellerShipping) {
        const sellerCurrency = normalizeCurrency(sellerShipping.seller?.currency || 'USD');
        sellerShippingMap[sellerId] = {
          seller: sellerShipping.seller,
          methods: sellerShipping.methods
            .filter(m => m.isActive)
            .map(method => serializeShippingMethod(method, sellerCurrency))
        };
      } else {
        const sellerCurrency = await getSellerCurrency(sellerId);
        // Default shipping methods if seller hasn't configured any
        sellerShippingMap[sellerId] = {
          seller: { _id: sellerId, currency: sellerCurrency },
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
    console.error('Error fetching cart shipping methods:', error);
    res.status(500).json({
      success: false,
      msg: 'Failed to fetch shipping methods for cart'
    });
  }
};

module.exports = {
  getSellerShippingMethods,
  updateShippingMethods,
  getShippingMethodsForCart
};
