'use strict';
const mongoose = require('mongoose');
// Guest contact references used only to prefill standard hosted checkout.
// Deliberately separate from SafepayCustomer and its card-storage consent.
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  environment: { type: String, enum: ['sandbox', 'production'], required: true, immutable: true },
  contactHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  customerId: { type: String, default: null, match: /^cus_[a-zA-Z0-9-]+$/ },
  status: { type: String, enum: ['new', 'creating', 'ready'], default: 'new' },
  leaseToken: { type: String, default: '', select: false },
  leaseUntil: { type: Date, default: null },
  lastErrorCode: { type: String, default: '', maxlength: 100 },
  outcomeUnknown: { type: Boolean, default: false },
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ environment: 1, user: 1, contactHash: 1 }, { unique: true });
schema.index({ environment: 1, customerId: 1 }, { unique: true, partialFilterExpression: { customerId: { $type: 'string' } } });
module.exports = mongoose.model('SafepayCheckoutContact', schema);
