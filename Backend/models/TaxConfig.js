const mongoose = require('mongoose');
const { roundMoney } = require('../services/moneyMath');

const strictActualNumberSetter = value => {
  if (value === null || value === undefined) return value;
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
};

const isValidStoredTaxValue = function(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
  // Both document saves and atomic CAS updates include the final tax type.
  // Mongoose binds an update validator to Query, where sibling update fields
  // are available via Query#get() rather than direct properties.
  const taxType = typeof this?.get === 'function' ? this.get('type') : this?.type;
  if (taxType === 'none') return value === 0;
  if (taxType === 'percentage') {
    if (value > 100) return false;
    try {
      return roundMoney(value, 6) === value;
    } catch (_) {
      return false;
    }
  }
  if (taxType !== 'fixed') return false;
  try {
    return roundMoney(value) === value;
  } catch (_) {
    return false;
  }
};

const taxConfigSchema = mongoose.Schema({
  type: {
    type: String,
    enum: ['none', 'percentage', 'fixed'],
    default: 'none',
    required: true
  },
  value: {
    type: Number,
    default: 0,
    min: 0,
    set: strictActualNumberSetter,
    validate: {
      validator: isValidStoredTaxValue,
      message: 'Tax value must match its type, percentages may use at most six decimals, and fixed tax must use exact cents'
    }
  },
  // Percentage tax is currency-independent. A fixed tax is stored in this
  // explicit native currency and converted into the checkout currency.
  currency: {
    type: String,
    enum: ['USD', 'PKR', 'EUR', 'GBP'],
    default: 'USD',
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { timestamps: true, optimisticConcurrency: true });

// Ensure only one tax config document exists
taxConfigSchema.index({ isActive: 1 }, { unique: true, partialFilterExpression: { isActive: true } });

module.exports = mongoose.model('TaxConfig', taxConfigSchema);
