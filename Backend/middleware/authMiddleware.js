const jwt = require('jsonwebtoken')

const verifyToken = async (req, res, next) => {
    const authHeader = req.header('Authorization')
    console.log('=== AUTH MIDDLEWARE ===');
    console.log('Authorization header:', authHeader);
    
    const token = authHeader?.split(' ')[1]
    console.log('Extracted token:', token);
    
    if (!token) return res.status(401).json({ msg: 'No token provided!' })

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET)
        console.log('=== TOKEN DECODED ===');
        console.log('Decoded user:', decoded);
        req.user = decoded
        next()
    } catch (error) {
        console.error('Token verification error:', error);
        console.error('Error name:', error.name);
        console.error('Error message:', error.message);
        res.status(403).json({ msg: 'Login required' }) 
    }  
}

module.exports = verifyToken  