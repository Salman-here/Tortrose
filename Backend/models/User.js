const mongoose = require('mongoose')
const bcrypt = require('bcrypt')
const crypto = require('crypto')



const userSchema = mongoose.Schema({
    username: { type: String, required: true },
    avatar: { type: String, default: 'https://res.cloudinary.com/dus5sac8g/image/upload/v1756983317/Profile_Picture_dxq4w8.jpg' },
    email: { type: String, required: true }, 
    password: { type: String, required: false }, // Not required for OAuth users
    role: { type: String, enum: ['user', 'admin', 'seller'], default: 'user' },
    status: { type: String, enum: ['active', 'blocked'], default: 'active' },
    wishlist: [
        { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true }
    ],
    resetPasswordToken: { type: String },
    resetPasswordTokenExpiry: { type: String },
    profilePicture: { type: String }, // For Google OAuth profile picture
    isVerified: { type: Boolean, default: false }, // For email verification
    
    // Spin wheel data
    spinResult: {
        label: { type: String },
        value: { type: Number },
        type: { type: String }, // 'percentage', 'fixed', 'free'
        hasCheckedOut: { type: Boolean, default: false }
    },
    spinTimestamp: { type: Number }, // Timestamp when user spun
    spinSelectedProducts: [{ type: String }] // Product IDs selected for spin discount
})



userSchema.pre('save', async function (next) {
    // Skip hashing if password is not modified or is null (OAuth users)
    if (!this.isModified('password') || !this.password) return next()

    try {
        const salt = await bcrypt.genSalt(10)
        this.password = await bcrypt.hash(this.password, salt)
        console.log('hashed:', this.password);
        next()
    } catch (error) {
        next(error)
    }
})

userSchema.methods.getResetPasswordToken = function () {
    const resetToken = crypto.randomBytes(20).toString('hex')

    this.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex')
    this.resetPasswordTokenExpiry = Date.now() + 60 * 60 * 1000 // 1 hour

    return resetToken
}

// Virtual field for store relationship
userSchema.virtual('store', {
    ref: 'Store',
    localField: '_id',
    foreignField: 'seller',
    justOne: true
});

// Ensure virtuals are included when converting to JSON
userSchema.set('toJSON', { virtuals: true });
userSchema.set('toObject', { virtuals: true });


module.exports = mongoose.model('User', userSchema)

