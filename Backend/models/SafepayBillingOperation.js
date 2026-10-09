'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'SellerSubscription', required: true, immutable: true },
  environment: { type: String, enum: ['sandbox', 'production'], required: true, immutable: true },
  kind: { type: String, enum: ['enrollment', 'renewal', 'upgrade', 'meta_removal', 'downgrade'], required: true, immutable: true },
  requestKey: { type: String, required: true, maxlength: 160, immutable: true },
  fingerprint: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  sourceVersion: { type: Number, required: true, min: 0, immutable: true, validate: Number.isSafeInteger },
  terms: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  status: { type: String, enum: ['quoted', 'accepted', 'awaiting_payment', 'applied', 'failed', 'cancelled', 'expired', 'manual_review'], default: 'quoted', index: true },
  expiresAt: { type: Date, default: null },
  acceptedAt: { type: Date, default: null },
  appliedAt: { type: Date, default: null },
  consentVersion: { type: String, default: '' },
  cardId: { type: String, default: null, select: false },
  payment: { type: mongoose.Schema.Types.ObjectId, ref: 'SafepayPayment', default: null },
  failureCode: { type: String, default: '' },
  // Polling state is separate from immutable invoices and capture fences.
  // Missing fields on previously accepted invoices are eligible immediately.
  workerNextAttemptAt: { type: Date, default: null },
  workerLastAttemptAt: { type: Date, default: null },
  workerAttempts: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  workerLeaseToken: { type: String, default: null, select: false },
  workerLeaseUntil: { type: Date, default: null },
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ environment: 1, seller: 1, requestKey: 1 }, { unique: true });
schema.index({ subscription: 1, status: 1, createdAt: -1 });
schema.index({ environment: 1, status: 1, workerNextAttemptAt: 1, acceptedAt: 1, _id: 1 });
module.exports = mongoose.model('SafepayBillingOperation', schema);
