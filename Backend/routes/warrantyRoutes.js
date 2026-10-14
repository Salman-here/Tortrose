'use strict';
const router = require('express').Router();
const verifyToken = require('../middleware/authMiddleware');
const upload = require('../middleware/upload');
const warranty = require('../controllers/warrantyController');
const shared = require('../controllers/returnController');
const evidenceLimiter = require('express-rate-limit')({ windowMs: 3600000, max: 30,
  standardHeaders: true, legacyHeaders: false, keyGenerator: req => `warranty-photo:${req.user.id}`,
  message: { msg: 'Photo upload limit reached. Please try again later.', code: 'WARRANTY_PHOTO_RATE_LIMITED' } });
router.use(verifyToken, (req, _res, next) => { req.afterSalesKind = 'warranty'; next(); });
router.get('/order/:orderId/eligibility', warranty.eligibility);
router.post('/evidence', evidenceLimiter, (req, res, next) => upload.single('photo')(req, res, error => error
  ? res.status(400).json({ msg: 'Upload one JPEG, PNG or WebP photo up to 5 MB.' }) : next()), warranty.uploadEvidence);
router.get('/mine', shared.listMyReturns);
router.get('/seller', shared.listSellerReturns);
router.post('/', warranty.create);
router.use('/:id', shared.requireWorkflow);
router.post('/:id/decision', warranty.decide);
router.post('/:id/appeal', warranty.appeal);
router.patch('/:id/status', shared.updateStatus);
router.post('/:id/accept', shared.acceptReturn);
router.post('/:id/cancel', shared.cancelReturn);
router.post('/:id/replacement/dispatch', shared.dispatchReplacement);
router.post('/:id/replacement/receive', shared.receiveReplacement);
router.get('/:id', shared.getReturn);
module.exports = router;
