const mongoose = require('mongoose');
const { roundMoney } = require('../services/moneyMath');

const strictActualNumberSetter = value => {
  if (value === null || value === undefined) return value;
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
};

const isExactStoredMoney = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
  try {
    return roundMoney(value) === value;
  } catch (_) {
    return false;
  }
};

const shippingMethodSchema = mongoose.Schema({
  seller: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  methods: [
    {
      type: {
        type: String,
        enum: ['free', 'standard', 'fast'],
        required: true
      },
      cost: {
        type: Number,
        required: true,
        min: 0,
        set: strictActualNumberSetter,
        validate: {
          validator(value) {
            return isExactStoredMoney(value)
              && (this.type === 'free'
                ? value === 0
                : this.isActive === false
                  ? value >= 0
                  : value > 0);
          },
          message: 'Free shipping must cost 0; active paid shipping must use an exact positive cent amount',
        },
      },
      currency: {
        type: String,
        enum: ['USD', 'PKR', 'EUR', 'GBP'],
        default: null,
      },
      costCurrency: {
        type: String,
        enum: ['USD', 'PKR', 'EUR', 'GBP'],
        default: null,
      },
      costInputAmount: {
        type: Number,
        default: null,
        min: 0,
        set: strictActualNumberSetter,
        validate: {
          validator(value) {
            if (value === null || value === undefined) return true;
            return isExactStoredMoney(value)
              && (this.type === 'free'
                ? value === 0
                : this.isActive === false
                  ? value >= 0
                  : value > 0);
          },
          message: 'Shipping input amount must be an exact valid cent amount',
        },
      },
      deliveryDays: {
        type: Number,
        required: true,
        min: 1,
        set: strictActualNumberSetter,
        validate: {
          validator: value => Number.isSafeInteger(value) && value > 0,
          message: 'Delivery days must be a positive safe whole number',
        },
      },
      isActive: {
        type: Boolean,
        default: true
      }
    }
  ],
}, { timestamps: true });

shippingMethodSchema.path('methods').validate(
  methods => Array.isArray(methods)
    && methods.length > 0
    && methods.some(method => method.isActive !== false)
    && new Set(methods.map(method => method.type)).size === methods.length,
  'Shipping methods must be unique and at least one method must be active',
);

module.exports = mongoose.model('ShippingMethod', shippingMethodSchema);
