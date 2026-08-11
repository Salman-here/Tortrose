const express = require('express')
const { profileImage, productImage, storeImage } = require('../controllers/uploadController')
const upload = require('../middleware/upload')
const verifyToken = require('../middleware/authMiddleware')
const { seller } = require('../middleware/authMiddleware')
const router = express.Router()

router.post('/profile-image', verifyToken, upload.single('profileImage'), profileImage)
router.post('/product-image', verifyToken, upload.single('productImage'), productImage)
router.post('/store-image', verifyToken, seller, upload.single('storeImage'), storeImage)

module.exports = router
