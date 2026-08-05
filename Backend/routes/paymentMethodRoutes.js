'use strict';

const express = require('express');
const verifyToken = require('../middleware/authMiddleware');
const { cardSetupCreationLimiter } = require('../middleware/paymentCreationLimiter');
const {
  getConfig,
  listPaymentMethods,
  createSetup,
  cancelSetup,
  deletePaymentMethod,
  setDefaultPaymentMethod,
} = require('../controllers/paymentMethodController');

const router = express.Router();
router.get('/config', getConfig);
router.use(verifyToken);
router.get('/', listPaymentMethods);
router.post('/setup', cardSetupCreationLimiter, createSetup);
router.post('/setup/:setupIntentId/cancel', cancelSetup);
router.delete('/:id', deletePaymentMethod);
router.patch('/:id/default', setDefaultPaymentMethod);

module.exports = router;
