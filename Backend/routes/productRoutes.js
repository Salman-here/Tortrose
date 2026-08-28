
const express = require('express')
const { getProducts, getSingleProduct, getFilters, addReview, deleteProduct, bulkDeleteProducts, editProduct, addProduct, bulkDiscount, bulkPriceUpdate, removeDiscount, getSellerProducts, getAdminProducts, getFeaturedStats } = require('../controllers/productController')
const verifyToken = require('../middleware/authMiddleware')
const { optionalAuth } = require('../middleware/authMiddleware')
const { addToWishlist, getWishlist, deleteFromWishlist } = require('../controllers/wishlistController')
const router = express.Router()

router.get('/get-single-product/:id', optionalAuth, getSingleProduct)
router.get('/get-filters', optionalAuth, getFilters)


router.post('/add-review/:id', verifyToken, addReview)




router.post('/add', verifyToken, addProduct)
router.post('/bulk-discount', verifyToken, bulkDiscount)
router.post('/bulk-price-update', verifyToken, bulkPriceUpdate)
router.post('/bulk-delete', verifyToken, bulkDeleteProducts)
router.post('/remove-discount', verifyToken, removeDiscount)
router.get('/add-to-wishlist/:id', verifyToken, addToWishlist)
router.get('/get-wishlist', verifyToken, getWishlist)
router.delete('/delete-from-wishlist/:id', verifyToken, deleteFromWishlist)
router.delete('/delete/:id', verifyToken, deleteProduct)
router.put('/edit/:id', verifyToken, editProduct)
router.get('/get-products', optionalAuth, getProducts)
router.get('/get-seller-products', verifyToken, getSellerProducts)
router.get('/admin-products', verifyToken, getAdminProducts)
router.get('/featured-stats', verifyToken, getFeaturedStats)

module.exports = router
