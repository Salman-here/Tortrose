const express = require('express');
const { getSellerAnalytics, getSellerNotifications, getAdminAnalytics, getAdminNotifications, getNotificationPrefs, updateNotificationPrefs } = require('../controllers/analyticsController');
const verifyToken = require('../middleware/authMiddleware');
const router = express.Router();

router.get('/seller', verifyToken, getSellerAnalytics);
router.get('/notifications', verifyToken, getSellerNotifications);
router.get('/admin', verifyToken, getAdminAnalytics);
router.get('/admin/notifications', verifyToken, getAdminNotifications);
router.get('/notification-prefs', verifyToken, getNotificationPrefs);
router.put('/notification-prefs', verifyToken, updateNotificationPrefs);

module.exports = router;
