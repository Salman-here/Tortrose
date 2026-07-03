const express = require('express');
const verifyToken = require('../middleware/authMiddleware');
const {
    getSellerAdsOverview,
    submitSellerAdRequest,
    getAdminAdRequests,
    reviewAdRequest,
} = require('../controllers/sellerAdController');

const router = express.Router();

router.get('/seller/overview', verifyToken, getSellerAdsOverview);
router.post('/seller/request', verifyToken, submitSellerAdRequest);
router.get('/admin/requests', verifyToken, getAdminAdRequests);
router.patch('/admin/requests/:id/review', verifyToken, reviewAdRequest);

module.exports = router;
