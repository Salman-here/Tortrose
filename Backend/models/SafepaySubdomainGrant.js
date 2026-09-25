'use strict';
const mongoose = require('mongoose');
const integer = value => typeof value === 'number' && Number.isSafeInteger(value) ? value : Number.NaN;
const schema = new mongoose.Schema({
  entitlementType: { type: String, enum: ['subdomain'], default: 'subdomain', immutable: true },
  payment: { type: mongoose.Schema.Types.ObjectId, ref: 'SafepayPayment', required: true, immutable: true, unique: true },
  environment: { type: String, enum: ['sandbox', 'production'], required: true, immutable: true },
  sourceKey: { type: String, required: true, immutable: true, unique: true },
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, immutable: true },
  resourceKey: { type: String, required: true, immutable: true },
  currency: { type: String, enum: ['USD'], default: 'USD', immutable: true },
  capturedMinor: { type: Number, required: true, min: 1, set: integer, validate: Number.isSafeInteger, immutable: true },
  refundedMinor: { type: Number, default: 0, min: 0, set: integer, validate: Number.isSafeInteger },
  grantStart: { type: Date, required: true, immutable: true },
  grantEnd: { type: Date, required: true, immutable: true },
  effectiveGrantEnd: { type: Date, required: true },
  completionState: { type: String, enum: ['confirmed'], default: 'confirmed' },
  riskSuspended: { type: Boolean, default: false },
  disputeState: { type: String, enum: ['none', 'open', 'lost', 'won'], default: 'none' },
  disputeAmountMinor: { type: Number, default: 0, min: 0, set: integer, validate: Number.isSafeInteger },
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ store: 1, resourceKey: 1, grantStart: 1 });
module.exports = mongoose.model('SafepaySubdomainGrant', schema);
