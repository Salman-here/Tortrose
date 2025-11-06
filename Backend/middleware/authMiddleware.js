const jwt = require('jsonwebtoken')
const User = require('../models/User')

const verifyToken = async (req, res, next) => {
    const authHeader = req.header('Authorization')
    const token = authHeader?.split(' ')[1]
    
    if (!token) return res.status(401).json({ msg: 'No token provided!' })

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET)
        req.user = decoded
        next()
    } catch (error) {
        console.error('Token verification error:', error.message);
        res.status(403).json({ msg: 'Login required' }) 
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

module.exports = verifyToken
module.exports.protect = protect
module.exports.admin = admin
module.exports.seller = seller  