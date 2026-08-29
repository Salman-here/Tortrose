const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/authMiddleware');
const { admin } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/whatsappController');
const testInboxCtrl = require('../controllers/adminWhatsAppTestInboxController');

// Admin-only management
router.get('/status', verifyToken, admin, ctrl.getStatus);
router.post('/connect', verifyToken, admin, ctrl.connect);
router.post('/disconnect', verifyToken, admin, ctrl.disconnect);
router.post('/reset', verifyToken, admin, ctrl.reset);
router.post('/pairing-code', verifyToken, admin, ctrl.requestPairingCode);
router.get('/queue', verifyToken, admin, ctrl.getQueue);
router.post('/queue/:id/retry', verifyToken, admin, ctrl.retryQueueItem);
router.get('/stats', verifyToken, admin, ctrl.getStats);

// Fixed fictional-number test pool and virtual inbox (admin only). These
// routes never accept arbitrary phone numbers, so real recipients cannot be
// redirected into the test transport.
router.post('/test-inbox/provision', verifyToken, admin, testInboxCtrl.provisionPool);
router.get('/test-inbox/numbers', verifyToken, admin, testInboxCtrl.getNumbers);
router.patch('/test-inbox/numbers/:id', verifyToken, admin, testInboxCtrl.setNumberActive);
router.get('/test-inbox/messages', verifyToken, admin, testInboxCtrl.getMessages);
router.post('/test-inbox/messages/:id/action', verifyToken, admin, testInboxCtrl.applyMessageAction);

// Seller-instance management (admin only)
router.get('/seller/status', verifyToken, admin, ctrl.getSellerStatus);
router.post('/seller/connect', verifyToken, admin, ctrl.sellerConnect);
router.post('/seller/disconnect', verifyToken, admin, ctrl.sellerDisconnect);
router.post('/seller/reset', verifyToken, admin, ctrl.sellerReset);
router.post('/seller/pairing-code', verifyToken, admin, ctrl.sellerRequestPairingCode);
router.get('/seller/queue', verifyToken, admin, ctrl.getSellerQueue);
router.get('/seller/stats', verifyToken, admin, ctrl.getSellerStats);

// Admin WhatsApp AI chat number management (admin only)
const adminNumberCtrl = require('../controllers/adminWhatsappNumberController');
router.get('/admin-numbers', verifyToken, admin, adminNumberCtrl.getAdminNumbers);
router.post('/admin-numbers', verifyToken, admin, adminNumberCtrl.addAdminNumber);
router.delete('/admin-numbers/:id', verifyToken, admin, adminNumberCtrl.removeAdminNumber);
router.patch('/admin-numbers/:id', verifyToken, admin, adminNumberCtrl.toggleAdminNumber);

// Public webhook. server.js authenticates and rate-limits it before its large
// JSON body parser; the handler repeats the shared-secret check defensively.
router.post('/webhook', ctrl.webhook);

module.exports = router;
