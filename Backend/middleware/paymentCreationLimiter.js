'use strict';

const rateLimit = require('express-rate-limit');

const createPaymentLimiter = ({ max, message }) => rateLimit({
  windowMs: 15 * 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => String(
    req.user?.id
    || req.headers['cf-connecting-ip']
    || req.ip
    || req.socket?.remoteAddress
    || 'unknown'
  ),
  message: { msg: message, code: 'PAYMENT_RATE_LIMITED' },
});

module.exports = {
  orderPaymentCreationLimiter: createPaymentLimiter({
    max: 30,
    message: 'Too many checkout attempts. Please wait before trying again.',
  }),
  walletTopUpCreationLimiter: createPaymentLimiter({
    max: 20,
    message: 'Too many Wallet top-up attempts. Please wait before trying again.',
  }),
  cardSetupCreationLimiter: createPaymentLimiter({
    max: 15,
    message: 'Too many card setup attempts. Please wait before trying again.',
  }),
  paymentStatusPollingLimiter: createPaymentLimiter({
    max: 180,
    message: 'Payment status is being checked too often. Please wait a moment.',
  }),
};
