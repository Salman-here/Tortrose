const express = require('express');
const verifyToken = require('../middleware/authMiddleware');
const { getMyWallet, createTopUpCheckout } = require('../controllers/walletController');

const router = express.Router();

router.get('/me', verifyToken, getMyWallet);
router.post('/top-ups', verifyToken, createTopUpCheckout);

module.exports = router;
