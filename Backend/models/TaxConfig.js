const mongoose = require('mongoose');

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
    validate: {
      validator: function(v) {
        if (this.type === 'percentage') return v <= 100;
        return true;
      },
      message: 'Percentage value cannot exceed 100'
    }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { timestamps: true });

// Ensure only one tax config document exists
taxConfigSchema.index({ isActive: 1 }, { unique: true, partialFilterExpression: { isActive: true } });

module.exports = mongoose.model('TaxConfig', taxConfigSchema);
