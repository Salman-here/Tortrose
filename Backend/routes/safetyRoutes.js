const express = require('express');
const rateLimit = require('express-rate-limit');
const verifyToken = require('../middleware/authMiddleware');
const { optionalAuth } = require('../middleware/authMiddleware');
const {
  createReport,
  listBlocks,
  createBlock,
  deleteBlock,
} = require('../controllers/safetyController');

const router = express.Router();
const reportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { msg: 'Too many reports. Please wait before trying again.' },
});

router.post('/reports', reportLimiter, optionalAuth, createReport);
router.get('/blocks', verifyToken, listBlocks);
router.post('/blocks', verifyToken, createBlock);
router.delete('/blocks/:userId', verifyToken, deleteBlock);

module.exports = router;
