'use strict';
const mongoose = require('mongoose');
const integer = value => typeof value === 'number' && Number.isSafeInteger(value) ? value : Number.NaN;
const money = { type: Number, required: true, min: 0, set: integer, validate: Number.isSafeInteger, immutable: true };
const schema = new mongoose.Schema({
  payment: { type: mongoose.Schema.Types.ObjectId, ref: 'SafepayPayment', required: true, immutable: true },
  environment: { type: String, enum: ['sandbox', 'production'], required: true, immutable: true },
  currency: { type: String, enum: ['USD', 'PKR', 'EUR', 'GBP'], required: true, immutable: true },
  cumulativeMinor: money,
  deltaMinor: money,
  occurredAt: { type: Date, required: true, immutable: true },
  sellerAllocations: [{ _id: false, seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true }, amountMinor: money }],
}, { timestamps: true });
schema.index({ payment: 1, cumulativeMinor: 1 }, { unique: true });
module.exports = mongoose.model('SafepayRefundEvent', schema);
