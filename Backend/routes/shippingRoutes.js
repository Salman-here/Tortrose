const express = require('express');
const router = express.Router();
const { 
  getSellerShippingMethods, 
  updateShippingMethods, 
  getShippingMethodsForCart 
} = require('../controllers/shippingController');
const { protect, seller } = require('../middleware/authMiddleware');

// Get shipping methods for a specific seller (public)
router.get('/seller/:sellerId', getSellerShippingMethods);

// Update seller's shipping methods (seller only)
router.put('/methods', protect, seller, updateShippingMethods);

// Get shipping methods for cart items (public/authenticated)
router.post('/cart', getShippingMethodsForCart);

module.exports = router;
