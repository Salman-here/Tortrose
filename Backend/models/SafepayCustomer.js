'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  environment: { type: String, enum: ['sandbox', 'production'], required: true, immutable: true },
  customerId: { type: String, default: null, match: /^cus_[a-zA-Z0-9-]+$/ },
  defaultCardId: { type: String, default: null, match: /^pm_[a-zA-Z0-9-]+$/, select: false },
  deletingCardId: { type: String, default: null, match: /^pm_[a-zA-Z0-9-]+$/, select: false },
  deletionStartedAt: { type: Date, default: null },
  status: { type: String, enum: ['new', 'creating', 'ready', 'deleted'], default: 'new' },
  leaseToken: { type: String, default: '', select: false },
  leaseUntil: { type: Date, default: null },
  createdForCardConsentAt: { type: Date, default: null },
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ environment: 1, user: 1 }, { unique: true });
schema.index({ environment: 1, customerId: 1 }, { unique: true, partialFilterExpression: { customerId: { $type: 'string' } } });
module.exports = mongoose.model('SafepayCustomer', schema);
