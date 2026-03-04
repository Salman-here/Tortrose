const User = require("../models/User");
const OTP = require("../models/OTP");
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const { sendEmail } = require('./mailController')


// Step 1: Send OTP to email
exports.sendOTP = async (req, res) => {
    const { username, email, password } = req.body;

    try {
        // Check if user already exists
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(409).json({ msg: 'E-mail is already taken.' });
        }

        // Generate 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        // Delete any existing OTP for this email
        await OTP.deleteMany({ email });

        // Save OTP with user data
        const otpDoc = new OTP({
            email,
            otp,
            userData: {
                username,
                email,
                password, // Will be hashed during user creation
                role: 'user',
                isVerified: true // Will be set to true after OTP verification
            }
        });
        await otpDoc.save();

        // Send OTP email with improved deliverability
        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Verify Your Email</title>
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background-color: #f4f4f4; 
            margin: 0; 
            padding: 0;
            line-height: 1.6;
        }
        .container { 
            max-width: 600px; 
            margin: 20px auto; 
            background: white; 
            border-radius: 8px; 
            overflow: hidden; 
            box-shadow: 0 2px 4px rgba(0,0,0,0.1); 
        }
        .header { 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
            color: white; 
            padding: 30px 20px; 
            text-align: center; 
        }
        .header h1 {
            margin: 0;
            font-size: 24px;
            font-weight: 600;
        }
        .content { 
            padding: 30px 20px; 
            color: #333;
        }
        .otp-box { 
            background: #f8f9fa; 
            border: 2px solid #667eea; 
            border-radius: 8px; 
            padding: 20px; 
            text-align: center; 
            margin: 25px 0; 
        }
        .otp-code { 
            font-size: 36px; 
            font-weight: bold; 
            color: #667eea; 
            letter-spacing: 8px;
            font-family: 'Courier New', monospace;
        }
        .footer { 
            background: #f8f9fa; 
            padding: 20px; 
            text-align: center; 
            font-size: 12px; 
            color: #666; 
            border-top: 1px solid #e0e0e0;
        }
        .company-info {
            margin-top: 15px;
            font-size: 11px;
            color: #999;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Verify Your Email Address</h1>
        </div>
        <div class="content">
            <p>Hello <strong>${username}</strong>,</p>
            
            <p>Thank you for creating an account with Tortrose. To complete your registration and verify your email address, please use the verification code below:</p>
            
            <div class="otp-box">
                <p style="margin: 0 0 10px 0; color: #666; font-size: 14px; font-weight: 600;">VERIFICATION CODE</p>
                <div class="otp-code">${otp}</div>
                <p style="margin: 10px 0 0 0; color: #999; font-size: 12px;">This code expires in 10 minutes</p>
            </div>
            
            <p style="color: #666; font-size: 14px;">Enter this code on the verification page to activate your account.</p>
            
            <p style="color: #999; font-size: 13px; margin-top: 25px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
                <strong>Didn't request this?</strong> If you didn't create an account with Tortrose, you can safely ignore this email.
            </p>
            
            <p style="color: #999; font-size: 12px; margin-top: 15px;">
                <strong>Security reminder:</strong> Never share this code with anyone. Tortrose staff will never ask for your verification code.
            </p>
        </div>
        <div class="footer">
            <p style="margin: 0 0 5px 0;">&copy; ${new Date().getFullYear()} Tortrose. All rights reserved.</p>
            <div class="company-info">
                <p style="margin: 5px 0;">This is an automated message, please do not reply to this email.</p>
            </div>
        </div>
    </div>
</body>
</html>
        `;

        await sendEmail({
            to: email,
            subject: 'Verify Your Email - Tortrose',
            text: `Your OTP for email verification is: ${otp}. Valid for 10 minutes.`,
            html: html
        });

        res.status(200).json({ 
            msg: 'OTP sent to your email. Please verify to complete registration.',
            email: email 
        });
    } catch (error) {
        console.error('Send OTP error:', error.message);
        
        // Delete the OTP document if email fails
        await OTP.deleteMany({ email });
        
        res.status(500).json({ 
            msg: 'Failed to send OTP. Please try again.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

// Step 2: Verify OTP and create user
exports.verifyOTPAndRegister = async (req, res) => {
    const { email, otp } = req.body;

    try {
        // Find OTP document
        const otpDoc = await OTP.findOne({ email, otp });

        if (!otpDoc) {
            return res.status(400).json({ msg: 'Invalid or expired OTP.' });
        }

        // Check if user already exists (double check)
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            await OTP.deleteOne({ _id: otpDoc._id });
            return res.status(409).json({ msg: 'E-mail is already taken.' });
        }

        // Create user with data from OTP document
        console.log('Creating user with userData:', otpDoc.userData);
        
        // Explicitly set isVerified to true since email was verified via OTP
        const userData = { ...otpDoc.userData, isVerified: true };
        const newUser = new User(userData);
        await newUser.save();
        
        console.log('User created with isVerified:', newUser.isVerified);

        // Delete OTP document
        await OTP.deleteOne({ _id: otpDoc._id });

        // Generate JWT token and return user data (same as login)
        const payload = {
            id: newUser._id,
            username: newUser.username,
            email: newUser.email,
            role: newUser.role,
            avatar: newUser.avatar
        }

        const token = jwt.sign(payload, process.env.JWT_SECRET);
        
        res.status(200).json({ 
            msg: 'Email verified! Sign up successful.', 
            token: token, 
            user: payload 
        });
    } catch (error) {
        console.error('Verify OTP error:', error);
        res.status(500).json({ msg: 'Verification failed. Please try again.' });
    }
};

// Keep old register for backward compatibility (can be removed later)
exports.registerr = async (req, res) => {
    const { username, email, password } = req.body

    try {
        const existingUser = await User.findOne({ email })
        if (existingUser) {
            return res.status(409).json({ msg: 'E-mail is already taken.' })
        }

        const newUser = new User({ ...req.body, role: 'user' });
        await newUser.save();
        res.status(200).json({ msg: 'Sign up successfull.' })
    } catch (error) {
        console.error(error);
        res.status(409).json({ msg: 'sign up failed.' })
    }
}

exports.login = async (req, res) => {
    try {
        const { email, password } = req.body || {}

        if (!email || !password) {
            return res.status(400).json({ msg: 'Email and password are required.' })
        }

        const userFound = await User.findOne({ email }).select('+password')
        if (!userFound) return res.status(404).json({ msg: 'User not Found!' })

        if (userFound.status === 'blocked') {
            return res.status(403).json({ msg: 'Your account is blocked. For further details contact support.' })
        }

        // Check if user has a password (not OAuth user)
        if (!userFound.password) {
            return res.status(400).json({ msg: 'This account uses Google Sign-In. Please sign in with Google.' })
        }

        const isMatched = await bcrypt.compare(password, userFound.password)
        if (!isMatched) return res.status(401).json({ msg: 'Incorrect password!' })

        const payload = {
            id: userFound._id,
            username: userFound.username,
            email: userFound.email,
            role: userFound.role,
            avatar: userFound.avatar
        }

        const token = jwt.sign(payload, process.env.JWT_SECRET)

        return res.status(200).json({ msg: 'Log in successfull.', token: token, user: payload })
    } catch (error) {
        console.error('Login error:', error)
        return res.status(500).json({ msg: 'Log in failed. Please try again.' })
    }
}

exports.googleCallback = async (req, res) => {
    try {
        const user = req.user;
        // When initiated from mobile, passport preserves state=mobile through OAuth flow
        const isMobile = req.query.state === 'mobile';

        const payload = {
            id: user._id,
            username: user.username,
            email: user.email,
            role: user.role,
            avatar: user.profilePicture || user.avatar
        }

        const token = jwt.sign(payload, process.env.JWT_SECRET);

        if (isMobile) {
            // Redirect to app deep link — WebBrowser.openAuthSessionAsync will intercept this
            return res.redirect(`tortrose://auth/google/success?token=${encodeURIComponent(token)}`);
        }

        // Web redirect
        res.redirect(`${process.env.FRONTEND_URL}/auth/google/success?token=${token}`);
    } catch (error) {
        console.error('Google callback error:', error);
        const isMobile = req.query.state === 'mobile';
        if (isMobile) {
            return res.redirect('tortrose://auth/google/error');
        }
        res.redirect(`${process.env.FRONTEND_URL}/login?error=auth_failed`);
    }
}