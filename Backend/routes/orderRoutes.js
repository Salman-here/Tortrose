
const express = require('express')
const { placeOrder, getOrders, updateStatus, getOrderDetail, cancelOrder, getUserOrders, trackGuestOrder, exportOrders } = require('../controllers/orderController')
const verifyToken = require('../middleware/authMiddleware')
const router = express.Router()

router.post('/place', verifyToken, placeOrder)
router.get('/track', trackGuestOrder)
router.get('/get', verifyToken, getOrders)
router.get('/export', verifyToken, exportOrders)
router.get('/user-orders', verifyToken, getUserOrders)
router.patch('/update-status/:id', verifyToken, updateStatus)
router.get('/detail/:id', verifyToken, getOrderDetail)
router.patch('/cancel/:id', verifyToken, cancelOrder)

module.exports = router
