'use strict';

const mongoose = require('mongoose');

const orderPublicIdCounterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  value: {
    type: Number,
    required: true,
    min: 1,
    validate: {
      validator: Number.isSafeInteger,
      message: 'Order public-id counter must be a safe whole number.',
    },
  },
}, {
  timestamps: true,
  versionKey: false,
});

module.exports = mongoose.model('OrderPublicIdCounter', orderPublicIdCounterSchema);
