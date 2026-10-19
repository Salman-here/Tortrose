'use strict';
const mongoose = require('mongoose');
// References to merchant-created billing addresses. No raw address is cached.
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  environment: { type: String, enum: ['sandbox', 'production'], required: true, immutable: true },
  addressHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  addressId: { type: String, default: null, match: /^address_[a-zA-Z0-9-]+$/ },
  status: { type: String, enum: ['new', 'creating', 'ready'], default: 'new' },
  leaseToken: { type: String, default: '', select: false },
  leaseUntil: { type: Date, default: null },
  outcomeUnknown: { type: Boolean, default: false },
  lastErrorCode: { type: String, default: '', maxlength: 100 },
}, { timestamps: true });
schema.index({ environment: 1, user: 1, addressHash: 1 }, { unique: true });
schema.index({ environment: 1, addressId: 1 }, { unique: true, partialFilterExpression: { addressId: { $type: 'string' } } });
module.exports = mongoose.model('SafepayCheckoutAddress', schema);
