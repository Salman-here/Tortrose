'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  environment: { type: String, enum: ['sandbox', 'production'], required: true, immutable: true },
  eventId: { type: String, required: true, immutable: true, maxlength: 180 },
  type: { type: String, required: true, immutable: true, maxlength: 120 },
  fingerprint: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  payload: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true, select: false },
  status: { type: String, enum: ['pending', 'processing', 'processed', 'ignored', 'manual_review'], default: 'pending', index: true },
  attempts: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  nextAttemptAt: { type: Date, default: Date.now },
  leaseUntil: { type: Date, default: null },
  leaseToken: { type: String, default: '', select: false },
  processedAt: { type: Date, default: null },
  lastErrorCode: { type: String, default: '', maxlength: 120 },
}, { timestamps: true });
schema.index({ environment: 1, eventId: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });
module.exports = mongoose.model('SafepayWebhookEvent', schema);
