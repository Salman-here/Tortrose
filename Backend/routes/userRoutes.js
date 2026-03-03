
const express = require('express')
const { getUsers, toggleBlockUser, toggleAdminUser, deleteUser, deleteOwnAccount, getSingle, updateUser, /* saveSpinResult, getSpinResult, updateSpinProducts, markSpinCheckedOut, */ becomeSeller } = require('../controllers/userController') // SPIN WHEEL DISABLED
const verifyToken = require('../middleware/authMiddleware')
const router = express.Router()

router.get('/get', verifyToken, getUsers)
router.patch('/block-toggle/:id' , verifyToken, toggleBlockUser)
router.patch('/admin-toggle/:id' , verifyToken, toggleAdminUser)
router.delete('/delete/:id' , verifyToken, deleteUser)
router.get('/single' , verifyToken, getSingle)
router.patch('/update' , verifyToken, updateUser)

// SPIN WHEEL DISABLED
// router.post('/spin/save', verifyToken, saveSpinResult)
// router.get('/spin/get', verifyToken, getSpinResult)
// router.patch('/spin/products', verifyToken, updateSpinProducts)
// router.patch('/spin/checkout', verifyToken, markSpinCheckedOut)

// Self-deletion (any logged-in user can delete their own account)
router.delete('/delete-account', verifyToken, deleteOwnAccount)

// Become a seller
router.post('/become-seller', verifyToken, becomeSeller)

module.exports = router