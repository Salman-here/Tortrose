const User = require("../models/User");
const OTP = require("../models/OTP");
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const { sendEmail } = require('./mailController')
const { welcomeEmail, sellerAccountCreatedEmail } = require('../utils/emailTemplates');
const { trackCompleteRegistration } = require('../services/tiktokEventsApi');
const { trackSellerLead } = require('../services/metaConversionsApi');
const { normalizeSocialLinks } = require('../services/socialLinksService');
const { notifySeller } = require('../services/whatsapp/sellerNotificationService');
const sellerTemplates = require('../services/whatsapp/sellerMessageTemplates');


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

        // Send OTP email with professional branded template
        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Verify Your Email</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;line-height:1.6;">
    <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        
        <!-- Header with Logo -->
        <div style="background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 50%,#a78bfa 100%);padding:48px 32px;text-align:center;">
            <div style="margin-bottom:16px;">
                <div style="display:inline-block;width:56px;height:56px;background:rgba(255,255,255,0.2);border-radius:16px;line-height:56px;text-align:center;">
                    <span style="font-size:28px;color:#ffffff;">&#9993;</span>
                </div>
            </div>
            <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;letter-spacing:-0.5px;">Verify Your Email</h1>
            <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:15px;">One more step to get started</p>
        </div>
        
        <!-- Body Content -->
        <div style="padding:40px 32px;">
            <p style="color:#334155;font-size:16px;margin:0 0 20px;">Hi <strong>${username}</strong>,</p>
            
            <p style="color:#475569;font-size:15px;margin:0 0 28px;">
                Thanks for signing up for Rozare! Please enter the verification code below to confirm your email address and activate your account.
            </p>
            
            <!-- OTP Code Box -->
            <div style="background:linear-gradient(135deg,#f8faff 0%,#f0f4ff 100%);border:2px solid #e0e7ff;border-radius:12px;padding:28px 20px;text-align:center;margin:0 0 28px;">
                <p style="margin:0 0 12px;color:#64748b;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;">Verification Code</p>
                <div style="font-size:38px;font-weight:800;color:#6366f1;letter-spacing:10px;font-family:'Courier New',monospace;padding:8px 0;">${otp}</div>
                <div style="margin-top:12px;display:inline-block;background:#fef3c7;border-radius:20px;padding:6px 14px;">
                    <span style="color:#92400e;font-size:12px;font-weight:600;">&#9202; Expires in 10 minutes</span>
                </div>
            </div>
            
            <!-- Instructions -->
            <div style="background:#f8fafc;border-radius:10px;padding:16px 20px;margin:0 0 24px;">
                <p style="color:#475569;font-size:14px;margin:0;line-height:1.7;">
                    <strong style="color:#334155;">How to use:</strong><br/>
                    Enter this 6-digit code on the verification page to complete your registration.
                </p>
            </div>
            
            <!-- Security Notice -->
            <div style="border-top:1px solid #e2e8f0;padding-top:20px;margin-top:24px;">
                <p style="color:#94a3b8;font-size:13px;margin:0 0 8px;">
                    <strong style="color:#64748b;">&#128274; Security Notice</strong>
                </p>
                <p style="color:#94a3b8;font-size:13px;margin:0;line-height:1.6;">
                    If you didn't create an account with Rozare, please ignore this email. Never share this code with anyone — our team will never ask for it.
                </p>
            </div>
        </div>
        
        <!-- Footer -->
        <div style="background:#f8fafc;padding:24px 32px;text-align:center;border-top:1px solid #e2e8f0;">
            <p style="margin:0 0 8px;color:#6366f1;font-size:16px;font-weight:700;">Rozare</p>
            <p style="margin:0 0 4px;color:#94a3b8;font-size:12px;">&copy; ${new Date().getFullYear()} Rozare. All rights reserved.</p>
            <p style="margin:0;color:#cbd5e1;font-size:11px;">This is an automated message — please do not reply.</p>
        </div>
    </div>
</body>
</html>
        `;

        await sendEmail({
            to: email,
            subject: 'Verify Your Email - Rozare',
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

        // Send welcome email
        try {
            const emailData = welcomeEmail(newUser.username);
            await sendEmail({ to: newUser.email, ...emailData });
        } catch (emailErr) {
            console.error('Failed to send welcome email:', emailErr.message);
        }
        
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
        const state = req.query.state || '';
        const isMobile = state === 'mobile';
        const isSeller = state === 'seller';

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
            return res.redirect(`rozare://auth/google/success?token=${encodeURIComponent(token)}`);
        }

        // Web redirect — include redirect param for seller flow
        const redirectParam = isSeller ? `&redirect=${encodeURIComponent('/become-seller?from=google')}` : '';
        res.redirect(`${process.env.FRONTEND_URL}/auth/google/success?token=${token}${redirectParam}`);
    } catch (error) {
        console.error('Google callback error:', error);
        const state = req.query.state || '';
        if (state === 'mobile') {
            return res.redirect('rozare://auth/google/error');
        }
        res.redirect(`${process.env.FRONTEND_URL}/login?error=auth_failed`);
    }
};

// Send OTP for seller registration
exports.sendSellerOTP = async (req, res) => {
    const { username, email, password, phoneNumber, address, city, state, stateCode, country, countryCode, businessName } = req.body;

    try {
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(409).json({ msg: 'E-mail is already taken.' });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        await OTP.deleteMany({ email });

        const otpDoc = new OTP({
            email,
            otp,
            userData: {
                username,
                email,
                password,
                role: 'seller',
                isVerified: true
            }
        });
        // Store seller info in a separate field via the OTP doc
        otpDoc._sellerInfo = { phoneNumber, address, city, state, stateCode, country, countryCode, businessName };
        await otpDoc.save();

        // Professional seller OTP email template
        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Verify Your Seller Account</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;line-height:1.6;">
    <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        
        <!-- Header -->
        <div style="background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 50%,#a78bfa 100%);padding:48px 32px;text-align:center;">
            <div style="margin-bottom:16px;">
                <div style="display:inline-block;width:56px;height:56px;background:rgba(255,255,255,0.2);border-radius:16px;line-height:56px;text-align:center;">
                    <span style="font-size:28px;color:#ffffff;">&#127979;</span>
                </div>
            </div>
            <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;letter-spacing:-0.5px;">Verify Your Seller Account</h1>
            <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:15px;">Almost ready to start selling</p>
        </div>
        
        <!-- Body Content -->
        <div style="padding:40px 32px;">
            <p style="color:#334155;font-size:16px;margin:0 0 20px;">Hi <strong>${username}</strong>,</p>
            
            <p style="color:#475569;font-size:15px;margin:0 0 28px;">
                Thank you for signing up as a seller on Rozare! Enter the verification code below to confirm your email and complete your seller registration.
            </p>
            
            <!-- OTP Code Box -->
            <div style="background:linear-gradient(135deg,#f8faff 0%,#f0f4ff 100%);border:2px solid #e0e7ff;border-radius:12px;padding:28px 20px;text-align:center;margin:0 0 28px;">
                <p style="margin:0 0 12px;color:#64748b;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;">Verification Code</p>
                <div style="font-size:38px;font-weight:800;color:#6366f1;letter-spacing:10px;font-family:'Courier New',monospace;padding:8px 0;">${otp}</div>
                <div style="margin-top:12px;display:inline-block;background:#fef3c7;border-radius:20px;padding:6px 14px;">
                    <span style="color:#92400e;font-size:12px;font-weight:600;">&#9202; Expires in 10 minutes</span>
                </div>
            </div>
            
            <!-- What's Next -->
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px 20px;margin:0 0 24px;">
                <p style="color:#166534;font-size:14px;margin:0;font-weight:600;">&#127881; What happens next?</p>
                <p style="color:#15803d;font-size:13px;margin:8px 0 0;line-height:1.6;">
                    After verification, you'll be able to set up your store, list products, and start selling to customers worldwide — all for free!
                </p>
            </div>
            
            <!-- Security Notice -->
            <div style="border-top:1px solid #e2e8f0;padding-top:20px;margin-top:24px;">
                <p style="color:#94a3b8;font-size:13px;margin:0 0 8px;">
                    <strong style="color:#64748b;">&#128274; Security Notice</strong>
                </p>
                <p style="color:#94a3b8;font-size:13px;margin:0;line-height:1.6;">
                    If you didn't sign up as a seller on Rozare, please ignore this email. Never share this code with anyone — our team will never ask for it.
                </p>
            </div>
        </div>
        
        <!-- Footer -->
        <div style="background:#f8fafc;padding:24px 32px;text-align:center;border-top:1px solid #e2e8f0;">
            <p style="margin:0 0 8px;color:#6366f1;font-size:16px;font-weight:700;">Rozare</p>
            <p style="margin:0 0 4px;color:#94a3b8;font-size:12px;">&copy; ${new Date().getFullYear()} Rozare. All rights reserved.</p>
            <p style="margin:0;color:#cbd5e1;font-size:11px;">This is an automated message — please do not reply.</p>
        </div>
    </div>
</body>
</html>`;

        await sendEmail({ to: email, subject: 'Verify Your Seller Account - Rozare', text: `Your OTP: ${otp}. Valid for 10 minutes.`, html });

        res.status(200).json({ msg: 'OTP sent to your email. Please verify to complete seller registration.', email });
    } catch (error) {
        console.error('Send seller OTP error:', error.message);
        await OTP.deleteMany({ email });
        res.status(500).json({ msg: 'Failed to send OTP. Please try again.' });
    }
};

// Verify OTP and create seller
exports.verifySellerOTPAndRegister = async (req, res) => {
    const { email, otp, phoneNumber, address, city, state, stateCode, country, countryCode, businessName, storeName, storeDescription, socialLinks, sellerType, whatsappNumber } = req.body;

    try {
        const otpDoc = await OTP.findOne({ email, otp });
        if (!otpDoc) return res.status(400).json({ msg: 'Invalid or expired OTP.' });

        const existingUser = await User.findOne({ email });
        if (existingUser) {
            await OTP.deleteOne({ _id: otpDoc._id });
            return res.status(409).json({ msg: 'E-mail is already taken.' });
        }

        // Verify WhatsApp against server-side OTP record (if a number was provided).
        // We DO NOT trust a client-sent `whatsappVerified` flag — the client could
        // simply set it to true without ever going through OTP.
        let whatsappVerifiedServerSide = false;
        if (whatsappNumber) {
            const { consumeVerifiedWhatsAppNumber } = require('./sellerWhatsappController');
            whatsappVerifiedServerSide = await consumeVerifiedWhatsAppNumber(whatsappNumber);
        }
        if (!whatsappVerifiedServerSide) {
            return res.status(400).json({
                msg: 'Please verify your WhatsApp number before creating your seller account.'
            });
        }

        const userData = { ...otpDoc.userData, isVerified: true };
        const newUser = new User(userData);
        newUser.sellerInfo = {
            phoneNumber: phoneNumber?.trim() || '',
            whatsappNumber: whatsappVerifiedServerSide ? whatsappNumber.trim() : '',
            whatsappVerified: whatsappVerifiedServerSide,
            address: address?.trim() || '',
            city: city?.trim() || '',
            state: state?.trim() || '',
            stateCode: stateCode?.trim() || '',
            country: country?.trim() || '',
            countryCode: countryCode?.trim() || '',
            businessName: businessName?.trim() || ''
        };
        await newUser.save();
        await OTP.deleteOne({ _id: otpDoc._id });

        let createdStoreName = '';

        // Auto-create store if storeName is provided
        if (storeName && storeName.trim().length >= 3) {
            try {
                const Store = require('../models/Store');
                const { initializeSubscription } = require('./subscriptionController');
                
                // Generate unique slug
                let slug = storeName.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');
                let existingStore = await Store.findOne({ storeSlug: slug });
                let counter = 1;
                while (existingStore) {
                    slug = `${slug}-${counter}`;
                    existingStore = await Store.findOne({ storeSlug: slug });
                    counter++;
                }

                const newStore = new Store({
                    seller: newUser._id,
                    storeName: storeName.trim(),
                    storeSlug: slug,
                    sellerType: sellerType === 'brand' ? 'brand' : 'store',
                    description: storeDescription?.trim() || '',
                    socialLinks: normalizeSocialLinks(socialLinks),
                    address: {
                        street: address?.trim() || '',
                        city: city?.trim() || '',
                        state: state?.trim() || '',
                        stateCode: stateCode?.trim() || '',
                        country: country?.trim() || '',
                        countryCode: countryCode?.trim() || ''
                    }
                });
                await newStore.save();
                await initializeSubscription(newUser._id);
                createdStoreName = newStore.storeName;
            } catch (storeErr) {
                console.error('Auto-create store error:', storeErr.message);
                // Don't fail registration if store creation fails
            }
        }

        notifySeller(newUser._id, 'seller_welcome', sellerTemplates.seller_welcome(createdStoreName)).catch(e =>
            console.error('Seller WhatsApp welcome failed:', e.message)
        );

        const payload = { id: newUser._id, username: newUser.username, email: newUser.email, role: newUser.role, avatar: newUser.avatar };
        const token = jwt.sign(payload, process.env.JWT_SECRET);

        // Send seller welcome email
        try {
            const emailData = sellerAccountCreatedEmail(newUser.username);
            await sendEmail({ to: newUser.email, ...emailData });
        } catch (emailErr) {
            console.error('Failed to send seller welcome email:', emailErr.message);
        }

        trackCompleteRegistration({
            req,
            user: newUser,
            storeName: storeName?.trim(),
            phone: whatsappNumber || phoneNumber,
            eventId: req.body?.tracking?.tiktokCompleteRegistrationEventId,
            tracking: req.body?.tracking || {},
        }).catch(() => {});
        trackSellerLead({
            req,
            user: newUser,
            storeName: storeName?.trim(),
            phone: whatsappNumber || phoneNumber,
            eventId: req.body?.tracking?.metaLeadEventId,
            tracking: req.body?.tracking || {},
        }).catch(() => {});

        res.status(200).json({ msg: 'Seller account created successfully!', token, user: payload });
    } catch (error) {
        console.error('Verify seller OTP error:', error);
        res.status(500).json({ msg: 'Verification failed. Please try again.' });
    }
};
