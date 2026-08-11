const jwt = require('jsonwebtoken')
const User = require('../models/User')

const sendAuthRequired = res => res.status(401).json({
    msg: 'No token provided!',
    code: 'AUTH_REQUIRED',
})

const sendInvalidSession = res => res.status(401).json({
    msg: 'Login required',
    code: 'AUTH_SESSION_INVALID',
})

const verifyToken = async (req, res, next) => {
    const authHeader = req.header('Authorization')
    const token = authHeader?.split(' ')[1]

    if (!token) return sendAuthRequired(res)

    let decoded
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET)
    } catch (error) {
        console.warn('Token verification failed:', error.name)
        return sendInvalidSession(res)
    }

    const userId = decoded.id || decoded._id;
    if (!userId) return sendInvalidSession(res)

    try {
        const user = await User.findById(userId).select('_id username email role avatar');
        if (!user) return sendInvalidSession(res)

        req.user = {
            ...decoded,
            id: user._id.toString(),
            _id: user._id,
            username: user.username,
            email: user.email,
            role: user.role,
            avatar: user.avatar,
        }
        return next()
    } catch (error) {
        // A database outage is not proof that the session is invalid. Avoid
        // instructing clients to erase a valid local session for a transient
        // backend failure.
        console.error('Session user lookup error:', error.message)
        return res.status(500).json({ msg: 'Unable to verify session' })
    }
}

// Alias for consistency
const protect = verifyToken

// Admin middleware
const admin = async (req, res, next) => {
    try {
        const userId = req.user._id || req.user.id;
        
        if (!userId) {
            return res.status(401).json({ 
                success: false,
                msg: 'Authentication required' 
            })
        }
        
        const user = await User.findById(userId)
        
        if (!user) {
            return res.status(404).json({ 
                success: false,
                msg: 'User not found' 
            })
        }
        
        if (user.role !== 'admin') {
            return res.status(403).json({ 
                success: false,
                msg: 'Access denied. Admin privileges required.' 
            })
        }
        
        next()
    } catch (error) {
        console.error('Admin middleware error:', error)
        res.status(500).json({ 
            success: false,
            msg: 'Server error' 
        })
    }
}

// Seller middleware
const seller = async (req, res, next) => {
    try {
        const userId = req.user._id || req.user.id;
        
        if (!userId) {
            return res.status(401).json({ 
                success: false,
                msg: 'Authentication required' 
            })
        }
        
        const user = await User.findById(userId)
        
        if (!user) {
            return res.status(404).json({ 
                success: false,
                msg: 'User not found' 
            })
        }
        
        if (user.role !== 'seller') {
            return res.status(403).json({ 
                success: false,
                msg: 'Access denied. Seller privileges required.' 
            })
        }
        
        next()
    } catch (error) {
        console.error('Seller middleware error:', error)
        res.status(500).json({ 
            success: false,
            msg: 'Server error' 
        })
    }
}

// Optional auth: sets req.user if a valid token is present, otherwise lets the
// request continue anonymously. Used for endpoints that behave differently for
// logged-in vs anonymous callers (e.g. seller WhatsApp OTP verify during signup
// vs settings change).
const optionalAuth = async (req, res, next) => {
    const authHeader = req.header('Authorization');
    const token = authHeader?.split(' ')[1];
    if (!token) return next();
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id || decoded._id;
        if (!userId) return next();

        const user = await User.findById(userId).select('_id username email role avatar');
        if (!user) return next();

        req.user = {
            ...decoded,
            id: user._id.toString(),
            _id: user._id,
            username: user.username,
            email: user.email,
            role: user.role,
            avatar: user.avatar,
        };
    } catch {
        // Invalid/expired token — proceed without req.user rather than rejecting.
    }
    next();
};

module.exports = verifyToken
module.exports.protect = protect
module.exports.admin = admin
module.exports.seller = seller
module.exports.optionalAuth = optionalAuth
