
const express = require('express')
const { rateLimit } = require('express-rate-limit')
const { getUsers, toggleBlockUser, unblockSellerSubscription, toggleAdminUser, deleteUser, deleteOwnAccount, getSingle, updateUser, becomeSeller, getShippingInfo, updateShippingInfo, getAddresses, addAddress, updateAddress, deleteAddress, setDefaultAddress, savePushToken, removePushToken, revokePushToken, initiateWhatsAppChange, verifyWhatsAppChange, initiateEmailChange, verifyEmailChange } = require('../controllers/userController')
const verifyToken = require('../middleware/authMiddleware')
const {
    emailChangeInitiateLimiter,
    emailChangeVerifyLimiter,
} = require('../middleware/sellerProfileVerificationLimiter')
const router = express.Router()
const pushTokenRevokeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { msg: 'Too many push-token revocation attempts. Please try again later.' },
})

router.get('/get', verifyToken, getUsers)
router.patch('/block-toggle/:id' , verifyToken, toggleBlockUser)
router.patch('/seller/:id/unblock-subscription' , verifyToken, unblockSellerSubscription)
router.patch('/admin-toggle/:id' , verifyToken, toggleAdminUser)
router.delete('/delete/:id' , verifyToken, deleteUser)
router.get('/single' , verifyToken, getSingle)
router.patch('/update' , verifyToken, updateUser)

// Self-deletion (any logged-in user can delete their own account)
router.delete('/delete-account', verifyToken, deleteOwnAccount)

// Become a seller
router.post('/become-seller', verifyToken, becomeSeller)

// Seller profile — change WhatsApp number
router.post('/seller/change-whatsapp/initiate', verifyToken, initiateWhatsAppChange)
router.post('/seller/change-whatsapp/verify', verifyToken, verifyWhatsAppChange)

// Seller profile — change email
router.post('/seller/change-email/initiate', verifyToken, emailChangeInitiateLimiter, initiateEmailChange)
router.post('/seller/change-email/verify', verifyToken, emailChangeVerifyLimiter, verifyEmailChange)

// Shipping info (single default for back-compat)
router.get('/shipping-info', verifyToken, getShippingInfo)
router.patch('/shipping-info', verifyToken, updateShippingInfo)

// Saved Addresses (address book) — multi-address CRUD
router.get('/addresses', verifyToken, getAddresses)
router.post('/addresses', verifyToken, addAddress)
router.patch('/addresses/:addressId', verifyToken, updateAddress)
router.delete('/addresses/:addressId', verifyToken, deleteAddress)
router.patch('/addresses/:addressId/default', verifyToken, setDefaultAddress)

// Expo push notification token registration
router.post('/push-token', verifyToken, savePushToken)
router.delete('/push-token', verifyToken, removePushToken)
router.post('/push-token/revoke', pushTokenRevokeLimiter, revokePushToken)

module.exports = router
