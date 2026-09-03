'use strict';

const express = require('express');
const controller = require('../controllers/seoController');

const router = express.Router();

router.get('/store-status/:slug', controller.getStoreIndexStatus);
router.get('/render/home', controller.renderHome);
router.get('/render/products', controller.renderProducts);
router.get('/render/marketplace', controller.renderMarketplace);
router.get('/render/store/:slug', controller.renderStore);
router.get('/render/product/:id', controller.renderProduct);

module.exports = router;
