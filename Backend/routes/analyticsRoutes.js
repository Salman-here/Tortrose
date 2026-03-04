const express = require('express');
const { getSellerAnalytics, getSellerNotifications } = require('../controllers/analyticsController');
const verifyToken = require('../middleware/authMiddleware');
const router = express.Router();

router.get('/seller', verifyToken, getSellerAnalytics);
router.get('/notifications', verifyToken, getSellerNotifications);

module.exports = router;
