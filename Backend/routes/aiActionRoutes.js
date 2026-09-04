const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/authMiddleware');
const { optionalAuth } = require('../middleware/authMiddleware');
const ai = require('../controllers/aiActionController');
const aiRateLimit = require('../controllers/aiRateLimitController');

// Rate Limit
router.get('/rate-limit', optionalAuth, aiRateLimit.getRateLimit);
router.post('/rate-limit/increment', optionalAuth, aiRateLimit.preflightRateLimit);

// Seller actions (require auth)
router.post('/add-product', verifyToken, ai.addProduct);
router.post('/edit-product', verifyToken, ai.editProduct);
router.post('/delete-product', verifyToken, ai.deleteProduct);
router.post('/feature-product', verifyToken, ai.featureProduct);
router.get('/my-products', verifyToken, ai.listMyProducts);
router.post('/bulk-discount', verifyToken, ai.bulkDiscount);
router.post('/bulk-price-update', verifyToken, ai.bulkPriceUpdate);
router.post('/remove-discount', verifyToken, ai.removeDiscount);
router.get('/seller-analytics', verifyToken, ai.getSellerAnalytics);
router.get('/seller-orders', verifyToken, ai.getSellerOrders);
router.post('/update-order-status', verifyToken, ai.updateOrderStatus);
router.get('/my-store', verifyToken, ai.getMyStore);
router.post('/update-store', verifyToken, ai.updateStore);
router.get('/store-analytics', verifyToken, ai.getStoreAnalytics);
router.post('/apply-verification', verifyToken, ai.applyForVerification);
router.get('/shipping-methods', verifyToken, ai.getShippingMethods);
router.post('/update-shipping', verifyToken, ai.updateShipping);

// Admin actions
router.get('/all-users', verifyToken, ai.getAllUsers);
router.post('/delete-user', verifyToken, ai.deleteUser);
router.post('/block-user', verifyToken, ai.blockUser);
router.post('/change-user-role', verifyToken, ai.changeUserRole);
router.get('/admin-analytics', verifyToken, ai.getAdminAnalytics);
router.get('/all-orders', verifyToken, ai.getAllOrders);
router.get('/order-detail', verifyToken, ai.getOrderDetail);
router.post('/cancel-order', verifyToken, ai.cancelOrder);
router.get('/all-complaints', verifyToken, ai.getAllComplaints);
router.post('/update-complaint', verifyToken, ai.updateComplaint);
router.get('/pending-verifications', verifyToken, ai.getPendingVerifications);
router.post('/approve-verification', verifyToken, ai.approveVerification);
router.post('/reject-verification', verifyToken, ai.rejectVerification);
router.post('/remove-verification', verifyToken, ai.removeVerification);
router.get('/all-stores', verifyToken, ai.getAllStores);
router.post('/update-tax', verifyToken, ai.updateTaxConfig);
router.get('/tax-config', verifyToken, ai.getTaxConfig);

// User actions (require auth)
router.get('/wishlist', verifyToken, ai.getWishlist);
router.post('/add-to-wishlist', verifyToken, ai.addToWishlist);
router.post('/remove-from-wishlist', verifyToken, ai.removeFromWishlist);
router.get('/addresses', verifyToken, ai.getAddresses);
router.post('/add-address', verifyToken, ai.addAddress);
router.post('/update-profile', verifyToken, ai.updateProfile);
router.get('/notifications', verifyToken, ai.getNotifications);
router.post('/mark-notifications-read', verifyToken, ai.markNotificationsRead);
router.get('/available-coupons', optionalAuth, ai.getAvailableCoupons);
router.post('/validate-coupon', optionalAuth, ai.validateCoupon);

// Seller coupon management
router.post('/create-coupon', verifyToken, ai.createCoupon);
router.get('/my-coupons', verifyToken, ai.getMyCoupons);
router.post('/update-coupon', verifyToken, ai.updateCoupon);
router.post('/delete-coupon', verifyToken, ai.deleteCoupon);
router.post('/toggle-coupon', verifyToken, ai.toggleCoupon);
router.get('/subscription-status', verifyToken, ai.getSubscriptionStatus);

// Admin broadcast & subscription management
router.post('/send-broadcast', verifyToken, ai.sendBroadcast);
router.get('/broadcasts', verifyToken, ai.getBroadcasts);
router.post('/cancel-broadcast', verifyToken, ai.cancelBroadcast);
router.get('/all-subscriptions', verifyToken, ai.getAllSubscriptions);
router.get('/verified-stores', verifyToken, ai.getVerifiedStores);
router.get('/store-details', verifyToken, ai.getStoreDetails);
router.get('/search-stores', verifyToken, ai.searchStores);

// Public route (no auth required)
router.get('/search-products', ai.searchProducts);
router.get('/subscription-catalog', ai.getSubscriptionCatalog);

module.exports = router;
