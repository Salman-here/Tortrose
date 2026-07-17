const express = require('express');
const verifyToken = require('../middleware/authMiddleware');
const controller = require('../controllers/returnController');

const router = express.Router();

router.get('/order/:orderId/eligibility', verifyToken, controller.getOrderReturnEligibility);
router.get('/mine', verifyToken, controller.listMyReturns);
router.get('/seller', verifyToken, controller.listSellerReturns);
router.post('/', verifyToken, controller.createReturn);
router.patch('/:id/status', verifyToken, controller.updateStatus);
router.post('/:id/accept', verifyToken, controller.acceptReturn);
router.post('/:id/cancel', verifyToken, controller.cancelReturn);
router.get('/:id', verifyToken, controller.getReturn);

module.exports = router;
