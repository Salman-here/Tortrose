const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/authMiddleware');
const ctrl = require('../controllers/notificationController');

// User-facing
router.get('/me', verifyToken, ctrl.listMine);
router.patch('/:id/read', verifyToken, ctrl.markRead);
router.post('/read-all', verifyToken, ctrl.markAllRead);
router.post('/dismiss', verifyToken, ctrl.dismissMine);

// Admin broadcasts
router.post('/broadcast', verifyToken, ctrl.createBroadcast);
router.get('/broadcasts', verifyToken, ctrl.listBroadcasts);
router.post('/broadcasts/:id/cancel', verifyToken, ctrl.cancelBroadcast);
router.get('/audience-preview', verifyToken, ctrl.audiencePreview);
router.get('/users-search', verifyToken, ctrl.searchUsers);

module.exports = router;
