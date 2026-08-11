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
    
    // Seller information
    sellerInfo: {
        phoneNumber: { type: String },
        whatsappNumber: { type: String },           // separate WhatsApp number, E.164 format
        whatsappDigits: { type: String, select: false }, // canonical uniqueness key, digits only
        whatsappVerified: { type: Boolean, default: false }, // verified via OTP
        address: { type: String },
        city: { type: String },
        state: { type: String },
        stateCode: { type: String },
        country: { type: String },
        countryCode: { type: String },
        businessName: { type: String },
        lastWhatsAppChange: { type: Date },         // Last time WhatsApp number was changed (30-day cooldown)
        lastEmailChange: { type: Date }             // Last time email was changed (30-day cooldown)
    },

    // Seller WhatsApp notification preferences
    // Controls which notification categories get sent via WhatsApp
    // Critical notifications (account blocked, subscription warnings) are ALWAYS sent regardless
    whatsappNotificationPrefs: {
        enabled: { type: Boolean, default: true },            // master toggle
        newOrders: { type: Boolean, default: true },          // new order placed
        orderUpdates: { type: Boolean, default: true },       // order confirmed/cancelled by buyer
        subscriptionAlerts: { type: Boolean, default: true }, // subscription activated, ending, payment failed
        bonusAlerts: { type: Boolean, default: true },        // bonus expiring, expired
        storeAlerts: { type: Boolean, default: true },        // store verification status changes
    },
    
    // Currency preference
    currency: { type: String, enum: ['USD', 'PKR', 'EUR', 'GBP'], default: 'USD' },

    // Buyer-commerce Stripe Customers are separated by mode. Seller recurring
    // subscriptions can adopt these IDs, but test resources must never be sent
    // to the live API (or vice versa). These fields are never serialized by
    // default and contain IDs only, never card data or secrets.
    stripeCustomers: {
        test: { type: String, trim: true, select: false },
        live: { type: String, trim: true, select: false },
    },

    // Saved shipping/address info for auto-fill (legacy default address)
    savedShippingInfo: {
        fullName: { type: String, default: '' },
        email: { type: String, default: '' },
        phone: { type: String, default: '' },
        address: { type: String, default: '' },
        city: { type: String, default: '' },
        state: { type: String, default: '' },
        stateCode: { type: String, default: '' },
        postalCode: { type: String, default: '' },
        country: { type: String, default: 'Pakistan' },
        countryCode: { type: String, default: 'PK' },
    },

    // Multiple saved shipping addresses (address book)
    savedAddresses: [
        {
            label: { type: String, default: 'Home' }, // Home, Work, etc.
            fullName: { type: String, required: true },
            email: { type: String, default: '' },
            phone: { type: String, default: '' },
            address: { type: String, required: true },
            city: { type: String, required: true },
            state: { type: String, default: '' },
            stateCode: { type: String, default: '' },
            postalCode: { type: String, default: '' },
            country: { type: String, default: 'Pakistan' },
            countryCode: { type: String, default: 'PK' },
            isDefault: { type: Boolean, default: false },
            createdAt: { type: Date, default: Date.now },
        }
    ],

    // Notification preferences
    notificationPrefs: {
        stockAlerts: { type: Boolean, default: true },
        lowStockAlerts: { type: Boolean, default: true },
        orderAlerts: { type: Boolean, default: true },
        paymentAlerts: { type: Boolean, default: true },
        deliveryAlerts: { type: Boolean, default: true },
        storeCreation: { type: Boolean, default: true },
        storeVerification: { type: Boolean, default: true },
    },

    // Expo push notification tokens (one user may have multiple devices)
    expoPushTokens: { type: [String], default: [] },

    // User WhatsApp linking (for buyer AI chat via the WhatsApp gateway)
    // Distinct from sellerInfo.whatsappNumber which is for seller notifications
    whatsappInfo: {
        number: { type: String, default: '' },          // E.164 format e.g. "+923028588506"
        verified: { type: Boolean, default: false },     // verified via OTP
        verifiedAt: { type: Date, default: null },
        lastChange: { type: Date, default: null },       // cooldown tracking
    },
}, { timestamps: true })



userSchema.pre('save', async function (next) {
    // Skip hashing if password is not modified or is null (OAuth users)
    if (!this.isModified('password') || !this.password) return next()

    try {
        const salt = await bcrypt.genSalt(10)
        this.password = await bcrypt.hash(this.password, salt)
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

// Unique sparse index: only one user can link a given WhatsApp number
userSchema.index(
    { 'whatsappInfo.number': 1 },
    { unique: true, partialFilterExpression: { 'whatsappInfo.number': { $gt: '' } } }
);
userSchema.index(
    { 'sellerInfo.whatsappDigits': 1 },
    {
        unique: true,
        partialFilterExpression: { 'sellerInfo.whatsappDigits': { $type: 'string', $gt: '' } },
    }
);
userSchema.index(
    { 'stripeCustomers.test': 1 },
    { unique: true, partialFilterExpression: { 'stripeCustomers.test': { $type: 'string' } } }
);
userSchema.index(
    { 'stripeCustomers.live': 1 },
    { unique: true, partialFilterExpression: { 'stripeCustomers.live': { $type: 'string' } } }
);

// Ensure virtuals are included when converting to JSON
userSchema.set('toJSON', { virtuals: true });
userSchema.set('toObject', { virtuals: true });


module.exports = mongoose.model('User', userSchema)

