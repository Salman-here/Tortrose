const express = require('express');
const router = express.Router();
const { getTaxConfig, updateTaxConfig } = require('../controllers/taxController');
const { protect, admin } = require('../middleware/authMiddleware');

// Public route - get current tax configuration
router.get('/config', getTaxConfig);

// Admin only route - update tax configuration
router.put('/config', protect, admin, updateTaxConfig);

module.exports = router;
