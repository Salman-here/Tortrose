const mongoose = require('mongoose');

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
        min: 0
      },
      deliveryDays: {
        type: Number,
        required: true,
        min: 1
      },
      isActive: {
        type: Boolean,
        default: true
      }
    }
  ]
}, { timestamps: true });

// Index for efficient seller lookups
shippingMethodSchema.index({ seller: 1 });

module.exports = mongoose.model('ShippingMethod', shippingMethodSchema);
