const express = require('express');
const verifyToken = require('../middleware/authMiddleware');
const controller = require('../controllers/returnController');
const upload = require('../middleware/upload');
const uploadEvidence = require('../controllers/afterSalesEvidenceController').createUploader('return');
const evidenceLimiter = require('express-rate-limit')({ windowMs: 3600000, max: 30, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => `return-photo:${req.user.id}`, message: { msg: 'Photo upload limit reached. Please try again later.' } });

const router = express.Router();
router.post('/evidence', verifyToken, evidenceLimiter, (req, res, next) => upload.single('photo')(req, res, error => error
    ? res.status(400).json({ msg: 'Upload one JPEG, PNG or WebP photo up to 5 MB.' }) : next()), uploadEvidence);

router.get('/order/:orderId/eligibility', verifyToken, controller.getOrderReturnEligibility);
router.get('/mine', verifyToken, controller.listMyReturns);
router.get('/seller', verifyToken, controller.listSellerReturns);
router.post('/', verifyToken, controller.createReturn);
router.post('/:id/decision', verifyToken, controller.requireWorkflow, controller.decideReturn);
router.patch('/:id/status', verifyToken, controller.requireWorkflow, controller.updateStatus);
router.post('/:id/accept', verifyToken, controller.requireWorkflow, controller.acceptReturn);
router.post('/:id/cancel', verifyToken, controller.requireWorkflow, controller.cancelReturn);
router.post('/:id/replacement/dispatch', verifyToken, controller.requireWorkflow, controller.dispatchReplacement);
router.post('/:id/replacement/receive', verifyToken, controller.requireWorkflow, controller.receiveReplacement);
router.get('/:id', verifyToken, controller.requireWorkflow, controller.getReturn);

module.exports = router;
