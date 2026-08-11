const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/authMiddleware');
const { admin, seller } = require('../middleware/authMiddleware');
const {
    getSubscriptionStatus,
    createCheckout,
    cancelSubscription,
    resumeSubscription,
    upgradeToElite,
    downgradeToStarter,
    cancelDowngrade,
    getAllSubscriptionsForAdmin,
} = require('../controllers/subscriptionController');
const {
    getSubdomainOwnership,
    purchaseSubdomain,
} = require('../controllers/subdomainPurchaseController');
const { mobileCheckoutReturn } = require('../controllers/mobileCheckoutReturnController');

// Public Stripe return bridge: validates a fixed flow/result and offers an
// app deep link plus a real website fallback. It never accepts a return URL.
router.get('/mobile-return', mobileCheckoutReturn);

router.get('/status', verifyToken, seller, getSubscriptionStatus);
router.post('/create-checkout', verifyToken, seller, createCheckout);
router.post('/cancel', verifyToken, seller, cancelSubscription);
router.post('/resume', verifyToken, seller, resumeSubscription);
router.post('/upgrade-to-elite', verifyToken, seller, upgradeToElite);
router.post('/downgrade-to-starter', verifyToken, seller, downgradeToStarter);
router.post('/cancel-downgrade', verifyToken, seller, cancelDowngrade);

// Subdomain purchase routes
router.get('/subdomain/ownership', verifyToken, seller, getSubdomainOwnership);
router.post('/subdomain/purchase', verifyToken, seller, purchaseSubdomain);

// Admin-only: overview of every seller subscription
router.get('/admin/all', verifyToken, admin, getAllSubscriptionsForAdmin);

module.exports = router;
