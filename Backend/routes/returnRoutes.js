const express = require('express');
const verifyToken = require('../middleware/authMiddleware');
const controller = require('../controllers/returnController');

const router = express.Router();

router.get('/order/:orderId/eligibility', verifyToken, controller.getOrderReturnEligibility);
router.get('/mine', verifyToken, controller.listMyReturns);
router.get('/seller', verifyToken, controller.listSellerReturns);
router.post('/', verifyToken, controller.createReturn);
router.patch('/:id/status', verifyToken, controller.requireWorkflow, controller.updateStatus);
router.post('/:id/accept', verifyToken, controller.requireWorkflow, controller.acceptReturn);
router.post('/:id/cancel', verifyToken, controller.requireWorkflow, controller.cancelReturn);
router.post('/:id/replacement/dispatch', verifyToken, controller.requireWorkflow, controller.dispatchReplacement);
router.post('/:id/replacement/receive', verifyToken, controller.requireWorkflow, controller.receiveReplacement);
router.get('/:id', verifyToken, controller.requireWorkflow, controller.getReturn);

module.exports = router;
