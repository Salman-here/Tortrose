const ShippingMethod = require('../models/ShippingMethod');
const Product = require('../models/Product');

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
    
    res.status(200).json({
      success: true,
      shippingMethods
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
    const { methods } = req.body;
    const sellerId = req.user._id || req.user.id;
    
    // Validation
    if (!methods || !Array.isArray(methods)) {
      return res.status(400).json({
        success: false,
        msg: 'Methods must be an array'
      });
    }
    
    // Validate each method
    for (const method of methods) {
      if (!['free', 'standard', 'fast'].includes(method.type)) {
        return res.status(400).json({
          success: false,
          msg: 'Invalid shipping method type'
        });
      }
      
      if (method.type === 'free' && method.cost !== 0) {
        return res.status(400).json({
          success: false,
          msg: 'Free shipping must have 0 cost'
        });
      }
      
      if (method.type !== 'free' && method.cost <= 0) {
        return res.status(400).json({
          success: false,
          msg: 'Paid shipping methods must have cost > 0'
        });
      }
      
      if (method.deliveryDays < 1) {
        return res.status(400).json({
          success: false,
          msg: 'Delivery days must be at least 1'
        });
      }
    }
    
    // Ensure at least one method is active
    const hasActiveMethod = methods.some(m => m.isActive);
    if (!hasActiveMethod) {
      return res.status(400).json({
        success: false,
        msg: 'At least one shipping method must be active'
      });
    }
    
    // Find existing or create new
    let shippingMethods = await ShippingMethod.findOne({ seller: sellerId });
    
    if (shippingMethods) {
      shippingMethods.methods = methods;
      await shippingMethods.save();
    } else {
      shippingMethods = await ShippingMethod.create({
        seller: sellerId,
        methods
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
    const products = await Product.find({ _id: { $in: productIds } }).select('seller');
    
    const sellerIds = [...new Set(products.map(p => p.seller.toString()))];
    
    // Fetch shipping methods for all sellers
    const shippingMethods = await ShippingMethod.find({
      seller: { $in: sellerIds }
    }).populate('seller', 'username');
    
    // Create a map of seller to their shipping methods
    const sellerShippingMap = {};
    
    for (const sellerId of sellerIds) {
      const sellerShipping = shippingMethods.find(
        sm => sm.seller._id.toString() === sellerId
      );
      
      if (sellerShipping) {
        sellerShippingMap[sellerId] = {
          seller: sellerShipping.seller,
          methods: sellerShipping.methods.filter(m => m.isActive)
        };
      } else {
        // Default shipping methods if seller hasn't configured any
        sellerShippingMap[sellerId] = {
          seller: { _id: sellerId },
          methods: [
            { type: 'standard', cost: 5.99, deliveryDays: 5, isActive: true }
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
