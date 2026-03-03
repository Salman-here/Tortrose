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

// Web Google OAuth
router.get("/google", passport.authenticate("google", { scope: ["profile", "email"] }));

// Mobile Google OAuth — passes state=mobile so callback can redirect to deep link
router.get("/google/mobile", passport.authenticate("google", { scope: ["profile", "email"], state: "mobile" }));

// callback route (shared for web + mobile, distinguished by state)
router.get("/google/callback", passport.authenticate("google", { failureRedirect: "/login", session: false }), googleCallback);

module.exports = router