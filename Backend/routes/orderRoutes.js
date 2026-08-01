
const express = require('express')
const {
    placeOrder,
    getPaymentStatus,
    getOrders,
    updateStatus,
    getOrderDetail,
    cancelOrder,
    getUserOrders,
    trackGuestOrder,
    exportOrders,
    reorder,
    getInvoice,
    cancelStripePaymentAttempt,
} = require('../controllers/orderController')
const verifyToken = require('../middleware/authMiddleware')
const {
  orderPaymentCreationLimiter,
  paymentStatusPollingLimiter,
} = require('../middleware/paymentCreationLimiter')
const router = express.Router()

router.post('/place', verifyToken, orderPaymentCreationLimiter, placeOrder)
router.get('/track', trackGuestOrder)
router.get('/get', verifyToken, getOrders)
router.get('/export', verifyToken, exportOrders)
router.get('/user-orders', verifyToken, getUserOrders)
router.get('/payment-status/:orderId', verifyToken, paymentStatusPollingLimiter, getPaymentStatus)
router.post('/payment/:orderId/cancel', verifyToken, cancelStripePaymentAttempt)
router.post('/reorder/:id', verifyToken, reorder)
router.get('/invoice/:id', verifyToken, getInvoice)
router.patch('/update-status/:id', verifyToken, updateStatus)
router.get('/detail/:id', verifyToken, getOrderDetail)
router.patch('/cancel/:id', verifyToken, cancelOrder)

module.exports = router
