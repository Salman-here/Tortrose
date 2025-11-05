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
                role: 'user'
            }
        });
        await otpDoc.save();

        // Send OTP email
        const html = `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 20px auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; }
        .content { padding: 40px 30px; }
        .otp-box { background: #f8f9fa; border: 2px dashed #667eea; border-radius: 10px; padding: 20px; text-align: center; margin: 30px 0; }
        .otp-code { font-size: 32px; font-weight: bold; color: #667eea; letter-spacing: 5px; }
        .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
        .button { display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Email Verification</h1>
            <p>genZ Winners</p>
        </div>
        <div class="content">
            <h2>Hello ${username}!</h2>
            <p>Thank you for signing up with genZ Winners. To complete your registration, please verify your email address using the OTP below:</p>
            
            <div class="otp-box">
                <p style="margin: 0; color: #666; font-size: 14px;">Your OTP Code</p>
                <div class="otp-code">${otp}</div>
                <p style="margin: 10px 0 0 0; color: #999; font-size: 12px;">Valid for 10 minutes</p>
            </div>
            
            <p>If you didn't request this verification, please ignore this email.</p>
            <p style="color: #999; font-size: 14px; margin-top: 30px;">
                <strong>Security Tip:</strong> Never share your OTP with anyone. genZ Winners will never ask for your OTP.
            </p>
        </div>
        <div class="footer">
            <p>&copy; ${new Date().getFullYear()} genZ Winners. All rights reserved.</p>
            <p>This is an automated email. Please do not reply.</p>
        </div>
    </div>
</body>
</html>
        `;

        await sendEmail({
            to: email,
            subject: 'Verify Your Email - genZ Winners',
            text: `Your OTP for email verification is: ${otp}. Valid for 10 minutes.`,
            html: html
        });

        res.status(200).json({ 
            msg: 'OTP sent to your email. Please verify to complete registration.',
            email: email 
        });
    } catch (error) {
        console.error('Send OTP error:', error);
        res.status(500).json({ msg: 'Failed to send OTP. Please try again.' });
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
        const newUser = new User(otpDoc.userData);
        await newUser.save();

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

        console.log('=== SIGNUP TOKEN GENERATION ===');
        console.log('User registered successfully:', newUser);
        console.log('Payload:', payload);
        console.log('Generated token:', token);
        console.log('JWT_SECRET exists:', !!process.env.JWT_SECRET);
        
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
    console.log('shazib', req.body);
    const { username, email, password } = req.body

    try {

        const existingUser = await User.findOne({ email })
        if (existingUser) {
            console.log('existingUser:::', existingUser);
            return res.status(409).json({ msg: 'E-mail is already taken.' })
        }

        const newUser = new User({ ...req.body, role: 'user' });
        await newUser.save();
        console.log(newUser);
        res.status(200).json({ msg: 'Sign up successfull.' })
    } catch (error) {
        console.error(error);
        res.status(409).json({ msg: 'sign up failed.' })
    }



}

exports.login = async (req, res) => {
    console.log('shazib', req.body);
    const { email, password } = req.body

    try {

        const userFound = await User.findOne({ email })
        console.log('userFound:', userFound);
        if (!userFound) return res.status(404).json({ msg: 'User not Found!' })

        if (userFound.status === 'blocked') return res.status(403).json({ msg: 'Your account is blocked. For further details contact support.' })

        // Check if user has a password (not OAuth user)
        if (!userFound.password) {
            return res.status(400).json({ msg: 'This account uses Google Sign-In. Please sign in with Google.' })
        }

        const isMatched = await bcrypt.compare(password, userFound.password)
        console.log('isMatched:', isMatched);
        if (!isMatched) return res.status(401).json({ msg: 'Incorrect password!' })

        const payload = {
            id: userFound._id,
            username: userFound.username,
            email: userFound.email,
            role: userFound.role,
            avatar: userFound.avatar  
        }

        const token = jwt.sign(payload, process.env.JWT_SECRET)
        console.log('token:', token);

        res.status(200).json({ msg: 'Log in successfull.', token: token, user: payload })
    } catch (error) {
        console.error(error);
        res.status(409).json({ msg: 'Log in failed.' })
    }
}

exports.googleCallback = async (req, res) => {
    try {
        const user = req.user;
        
        const payload = {
            id: user._id,
            username: user.username,
            email: user.email,
            role: user.role,
            avatar: user.profilePicture || user.avatar
        }

        const token = jwt.sign(payload, process.env.JWT_SECRET);
        
        // Redirect to frontend with token
        res.redirect(`${process.env.FRONTEND_URL}/auth/google/success?token=${token}`);
    } catch (error) {
        console.error('Google callback error:', error);
        res.redirect(`${process.env.FRONTEND_URL}/login?error=auth_failed`);
    }
}