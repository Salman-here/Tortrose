const express = require('express')
const { registerr, login, googleCallback, sendOTP, verifyOTPAndRegister } = require('../controllers/authController')
const passport = require('passport')
const router = express.Router()

// New OTP-based registration
router.post('/send-otp', sendOTP)
router.post('/verify-otp', verifyOTPAndRegister)

// Old registration (keep for backward compatibility)
router.post('/registerr', registerr)
router.post('/login', login)

router.get("/google", passport.authenticate("google", { scope: ["profile", "email"] }));

// callback route
router.get("/google/callback", passport.authenticate("google", { failureRedirect: "/login", session: false }), googleCallback);

module.exports = router