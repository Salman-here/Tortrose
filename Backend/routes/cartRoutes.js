const express = require('express')
const verifyToken = require('../middleware/authMiddleware')
const { addToCart, mergeGuestCart, getCart, qtyIncrement, qtyDecrement, clearCart, removeCartItem } = require('../controllers/cartController')
const router = express.Router()


router.post('/add/:id', verifyToken, addToCart)
router.post('/merge', verifyToken, mergeGuestCart)
router.get('/get', verifyToken, getCart)
router.patch('/qty-inc/:id', verifyToken, qtyIncrement)


router.patch('/qty-dec/:id', verifyToken, qtyDecrement)
router.delete('/remove/:id', verifyToken, removeCartItem)
router.delete('/clear', verifyToken, clearCart)

module.exports = router
