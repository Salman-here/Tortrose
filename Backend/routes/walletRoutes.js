const express = require('express');
const verifyToken = require('../middleware/authMiddleware');
const {
  walletTopUpCreationLimiter,
  paymentStatusPollingLimiter,
} = require('../middleware/paymentCreationLimiter');
const {
  getMyWallet,
  createTopUpCheckout,
  getTopUpStatus,
  cancelTopUpPayment,
} = require('../controllers/walletController');

const router = express.Router();

router.get('/me', verifyToken, getMyWallet);
router.post('/top-ups', verifyToken, walletTopUpCreationLimiter, createTopUpCheckout);
router.get('/top-ups/:transactionId/status', verifyToken, paymentStatusPollingLimiter, getTopUpStatus);
router.post('/top-ups/:transactionId/cancel', verifyToken, cancelTopUpPayment);

module.exports = router;
