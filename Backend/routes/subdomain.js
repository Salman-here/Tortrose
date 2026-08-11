const express = require('express');
const router = express.Router();
const subdomainController = require('../controllers/subdomainController');
const subdomainDetector = require('../middleware/subdomainDetector');
const verifyToken = require('../middleware/authMiddleware');
const { admin, seller } = require('../middleware/authMiddleware');

// Seller subdomain analytics (authenticated)
router.get('/analytics/seller', verifyToken, seller, subdomainController.getSellerSubdomainAnalytics);

// Admin subdomain management (authenticated)
router.get('/admin/all', verifyToken, admin, subdomainController.getAllSubdomains);
router.put('/admin/:storeId/update-slug', verifyToken, admin, subdomainController.adminUpdateSubdomain);

// Apply subdomain detector middleware to public routes
router.use(subdomainDetector);

// Get store info for current subdomain
router.get('/store', subdomainController.getSubdomainStore);

// Get products for current subdomain store
router.get('/products', subdomainController.getSubdomainProducts);

module.exports = router;
