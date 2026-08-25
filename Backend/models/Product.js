const mongoose = require('mongoose');
const {
    PRODUCT_NAME_MAX_LENGTH,
    PRODUCT_DESCRIPTION_MAX_LENGTH,
    sanitizeProductName,
    sanitizeProductDescription,
} = require('../services/productTextService');
const { roundMoney } = require('../services/moneyMath');

const strictActualNumberSetter = value => {
    if (value === null || value === undefined) return value;
    return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
};

const PRODUCT_CURRENCIES = ['USD', 'PKR', 'EUR', 'GBP'];

const isExactNonNegativeMoney = value => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
    try {
        return roundMoney(value) === value;
    } catch (_) {
        return false;
    }
};

const isNullableExactNonNegativeMoney = value => (
    value === null || value === undefined || isExactNonNegativeMoney(value)
);

const strictNonNegativeSafeIntegerField = (defaultValue, { required = false } = {}) => ({
    type: Number,
    default: defaultValue,
    ...(required ? { required: true } : {}),
    min: 0,
    set: strictActualNumberSetter,
    validate: {
        validator: value => Number.isSafeInteger(value) && value >= 0,
        message: 'Value must be a non-negative safe whole number',
    },
});

const nullableExactMoneyField = defaultValue => ({
    type: Number,
    default: defaultValue,
    min: 0,
    set: strictActualNumberSetter,
    validate: {
        validator: isNullableExactNonNegativeMoney,
        message: 'Stored product money must be finite, safe, non-negative, and exact to cents',
    },
});

// Review schema definition
const reviewSchema = mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        rating: { type: Number, required: true, min: 1, max: 5 },
        comment: { type: String, required: true, trim: true, maxlength: 1000 },
        order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
        isVerifiedPurchase: { type: Boolean, default: false },
    },
    { timestamps: true }
);

// Product schema definition
const productSchema = mongoose.Schema(
    {
        name: {
            type: String,
            trim: true,
            default: '',
            maxlength: [PRODUCT_NAME_MAX_LENGTH, `Product name cannot exceed ${PRODUCT_NAME_MAX_LENGTH} characters`],
            set: sanitizeProductName,
        },
        description: {
            type: String,
            trim: true,
            default: '',
            maxlength: [PRODUCT_DESCRIPTION_MAX_LENGTH, `Description cannot exceed ${PRODUCT_DESCRIPTION_MAX_LENGTH} characters`],
            set: sanitizeProductDescription,
        },
        price: {
            type: Number,
            required: true,
            min: 0,
            set: strictActualNumberSetter,
            validate: {
                validator: isExactNonNegativeMoney,
                message: 'Product price must be finite, safe, non-negative, and exact to cents',
            },
        },
        discountedPrice: {
            type: Number,
            default: 0,
            min: 0,
            set: strictActualNumberSetter,
            validate: {
                validator(value) {
                    if (value === null || value === undefined) return true;
                    // Mongoose binds update validators to a Query. Query#get()
                    // exposes sibling values from the same atomic $set, while
                    // Document#get() exposes the final document value. Using
                    // either context preserves the discount < price invariant
                    // without rejecting a valid CAS update merely because
                    // `this.price` is undefined on Query objects.
                    const regularPrice = typeof this?.get === 'function'
                        ? this.get('price')
                        : this?.price;
                    if (!isExactNonNegativeMoney(value)) return false;
                    // Removing a discount is always safe without loading the
                    // base price. A positive discount must carry the final
                    // price in the same atomic update so the invariant cannot
                    // be checked against stale or unavailable query state.
                    if (value === 0) return true;
                    return isExactNonNegativeMoney(regularPrice) && value < regularPrice;
                },
                message: 'Discounted price must use exact cents and be zero or lower than the regular price',
            },
        },
        currency: { type: String, enum: PRODUCT_CURRENCIES, default: 'USD', required: true, index: true },
        priceCurrency: { type: String, enum: PRODUCT_CURRENCIES, default: 'USD', required: true },
        priceInputAmount: nullableExactMoneyField(null),
        discountedPriceCurrency: { type: String, enum: PRODUCT_CURRENCIES, default: 'USD', required: true },
        discountedPriceInputAmount: nullableExactMoneyField(null),
        // Legacy mirrors from the previous USD-normalized experiment. Kept only
        // so migrations can recover the seller-entered amount; product.price is
        // the native stored amount going forward.
        priceOriginal: nullableExactMoneyField(null),
        discountedPriceOriginal: nullableExactMoneyField(null),
        priceVersion: { ...strictNonNegativeSafeIntegerField(2), index: true },
        priceMigratedAt: { type: Date, default: null },
        category: { type: String, required: true },
        brand: { type: String, required: true },
        stock: strictNonNegativeSafeIntegerField(0, { required: true }),
        image: { type: String, required: true },
        images: [
            {
                url: { type: String, required: true },
            },
        ],
        reviews: [reviewSchema],
        rating: { type: Number, default: 0 },
        numReviews: strictNonNegativeSafeIntegerField(0),
        isFeatured: { type: Boolean, default: false },
        isBlocked: { type: Boolean, default: false, index: true },
        blockedAt: { type: Date, default: null },
        blockedReason: { type: String, default: '' },
        moderationStatus: {
            type: String,
            enum: ['approved', 'blocked'],
            default: 'approved',
            index: true,
        },
        moderationReason: { type: String, default: '' },
        moderationSignals: [{ type: String }],
        moderationReviewedAt: { type: Date, default: null },
        // Frozen source marker for a newly-blocked transition. Notification
        // delivery is recovered from this marker if a request exits after the
        // Product write but before the outbox insert.
        moderationNotice: {
            reviewedAt: { type: Date, default: null },
            productName: { type: String, trim: true, maxlength: 200, default: '' },
            reason: { type: String, trim: true, maxlength: 1000, default: '' },
            notificationEnqueuedAt: { type: Date, default: null },
        },
        createdVia: {
            type: String,
            enum: ['manual', 'ai', 'admin', 'import'],
            default: 'manual',
            index: true,
        },
        tags: [String],
        colors: [{ type: String }], // Legacy: kept for backward compatibility
        // Flexible seller-defined option groups (Size, Color, Material, etc.)
        // Each group: { name: 'Size', values: ['S','M','L'], default: 'M' }
        optionGroups: [{
            _id: false,
            name: { type: String, required: true },
            values: [{ type: String }],
            default: { type: String, default: '' }, // Default selected value for this option group
        }],
        seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Track who created the product
        views: strictNonNegativeSafeIntegerField(0), // Track product views for popularity
        totalSales: strictNonNegativeSafeIntegerField(0), // Track total sales for ranking
        returnPolicy: {
            useStorePolicy: { type: Boolean, default: true }, // true = inherit from store
            returnsEnabled: { type: Boolean, default: false },
            returnDuration: strictNonNegativeSafeIntegerField(0),
            refundType: { type: String, enum: ['none', 'full_refund', 'replacement_only', 'store_credit'], default: 'none' },
            warrantyEnabled: { type: Boolean, default: false },
            warrantyDuration: strictNonNegativeSafeIntegerField(0),
            warrantyDescription: { type: String, default: '' },
            policyDescription: { type: String, default: '' },
        },
    },
    {
        timestamps: true
    }
);

productSchema.index({ moderationStatus: 1, isBlocked: 1 });
productSchema.index(
    {
        isBlocked: 1,
        'moderationNotice.notificationEnqueuedAt': 1,
        'moderationNotice.reviewedAt': 1,
    },
    {
        partialFilterExpression: {
            isBlocked: true,
            'moderationNotice.reviewedAt': { $type: 'date' },
        },
    }
);

const bulkPricingError = message => {
    const error = new Error(message);
    error.code = 'PRODUCT_BULK_PRICING_INVALID';
    error.status = 409;
    error.statusCode = 409;
    return error;
};

const own = (value, field) => Object.prototype.hasOwnProperty.call(value || {}, field);

// Mongoose casts bulk update operations but does not run update validators.
// Every bulk operation that changes a base price must therefore include the
// complete final price/discount pair. A zero-only discount removal is safe;
// a positive discount without its final base price is not provable and fails.
const assertSafeBulkPricingOperations = (operations = []) => {
    if (!Array.isArray(operations)) throw bulkPricingError('Product bulk operations must be an array.');
    operations.forEach((operation, index) => {
        const update = operation?.updateOne?.update || operation?.updateMany?.update;
        if (!update) return;
        if (Array.isArray(update)) {
            throw bulkPricingError(`Product bulk operation ${index + 1} cannot use a pricing pipeline.`);
        }
        const set = update.$set || {};
        const pricingFields = [
            'price', 'discountedPrice', 'priceInputAmount', 'discountedPriceInputAmount',
            'currency', 'priceCurrency', 'discountedPriceCurrency', 'priceVersion',
        ];
        if (pricingFields.some(field => own(update, field))) {
            throw bulkPricingError(`Product bulk operation ${index + 1} must use an explicit validated $set for pricing.`);
        }
        const unsafeOperator = Object.entries(update).find(([operator, values]) => (
            operator !== '$set'
            && values
            && typeof values === 'object'
            && pricingFields.some(field => own(values, field))
        ));
        if (unsafeOperator) {
            throw bulkPricingError(`Product bulk operation ${index + 1} uses an unsafe pricing operator.`);
        }

        const hasPrice = own(set, 'price');
        const hasDiscount = own(set, 'discountedPrice');
        const touchesPricing = pricingFields.some(field => own(set, field));
        if (!touchesPricing) return;

        const zeroDiscountRemoval = (
            hasDiscount
            && !hasPrice
            && set.discountedPrice === 0
            && own(set, 'discountedPriceInputAmount')
            && set.discountedPriceInputAmount === 0
            && pricingFields.every(field => (
                ['discountedPrice', 'discountedPriceInputAmount'].includes(field)
                || !own(set, field)
            ))
        );
        if (!zeroDiscountRemoval) {
            // A bulk write cannot read the stored sibling fields through
            // Mongoose validators. Require one self-contained final pricing
            // snapshot so currency metadata or priceVersion can never relabel
            // an old amount independently of its exact price/discount pair.
            const missingFinalField = pricingFields.find(field => !own(set, field));
            if (missingFinalField) {
                throw bulkPricingError(`Product bulk operation ${index + 1} must include the complete final pricing snapshot.`);
            }
        }
        if (hasPrice && !isExactNonNegativeMoney(set.price)) {
            throw bulkPricingError(`Product bulk operation ${index + 1} has invalid price money.`);
        }
        if (hasDiscount && !isExactNonNegativeMoney(set.discountedPrice)) {
            throw bulkPricingError(`Product bulk operation ${index + 1} has invalid discount money.`);
        }
        if (
            hasPrice
            && hasDiscount
            && set.discountedPrice > 0
            && (set.price <= 0 || set.discountedPrice >= set.price)
        ) {
            throw bulkPricingError(`Product bulk operation ${index + 1} has a discount that is not below its price.`);
        }

        if (own(set, 'priceInputAmount')) {
            if (!hasPrice || !isExactNonNegativeMoney(set.priceInputAmount) || set.priceInputAmount !== set.price) {
                throw bulkPricingError(`Product bulk operation ${index + 1} has inconsistent price input money.`);
            }
        }
        if (own(set, 'discountedPriceInputAmount')) {
            if (
                !hasDiscount
                || !isExactNonNegativeMoney(set.discountedPriceInputAmount)
                || set.discountedPriceInputAmount !== set.discountedPrice
            ) {
                throw bulkPricingError(`Product bulk operation ${index + 1} has inconsistent discount input money.`);
            }
        }

        const currencyFields = ['currency', 'priceCurrency', 'discountedPriceCurrency'];
        const suppliedCurrencies = currencyFields.filter(field => own(set, field));
        if (suppliedCurrencies.length) {
            if (suppliedCurrencies.length !== currencyFields.length) {
                throw bulkPricingError(`Product bulk operation ${index + 1} must include complete currency metadata.`);
            }
            const codes = currencyFields.map(field => set[field]);
            if (codes.some(code => typeof code !== 'string' || !PRODUCT_CURRENCIES.includes(code))) {
                throw bulkPricingError(`Product bulk operation ${index + 1} has invalid currency metadata.`);
            }
            if (new Set(codes).size !== 1) {
                throw bulkPricingError(`Product bulk operation ${index + 1} has conflicting currency metadata.`);
            }
        }
        if (own(set, 'priceVersion') && (!Number.isSafeInteger(set.priceVersion) || set.priceVersion < 0)) {
            throw bulkPricingError(`Product bulk operation ${index + 1} has an invalid price version.`);
        }
    });
    return operations;
};

productSchema.statics.assertSafeBulkPricingOperations = assertSafeBulkPricingOperations;
productSchema.pre('bulkWrite', function validateBulkPricing(next, operations) {
    try {
        this.assertSafeBulkPricingOperations(operations);
        next();
    } catch (error) {
        next(error);
    }
});

// Method to calculate rating based on reviews
productSchema.methods.calculateRating = function () {
    if (this.reviews.length > 0) {
        const totalRating = this.reviews.reduce((acc, review) => acc + review.rating, 0);
        this.rating = totalRating / this.reviews.length;
        this.numReviews = this.reviews.length;
    } else {
        this.rating = 0;
        this.numReviews = 0;
    }
};

module.exports = mongoose.model('Product', productSchema);
