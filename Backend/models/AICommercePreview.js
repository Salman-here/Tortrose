'use strict';
const mongoose = require('mongoose');

// A reviewed action, not an authentication token or a model-created amount.
// Kept long enough to fence interrupted/duplicate confirmations. No TTL purge
// of processing/completed intents: recovery must never execute them twice.
const schema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  role: { type: String, enum: ['user', 'seller'], required: true },
  conversation: { type: mongoose.Schema.Types.ObjectId, default: null },
  action: { type: String, required: true },
  requestKey: { type: String, required: true },
  fingerprint: { type: String, required: true },
  input: { type: mongoose.Schema.Types.Mixed, required: true },
  contract: { type: mongoose.Schema.Types.Mixed, required: true },
  notice: { type: String, required: true },
  status: { type: String, enum: ['quoted', 'processing', 'completed', 'failed'], default: 'quoted' },
  expiresAt: { type: Date, required: true },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  completedAt: { type: Date, default: null },
}, { timestamps: true });
schema.index({ user: 1, action: 1, requestKey: 1, fingerprint: 1 }, { unique: true });
module.exports = mongoose.model('AICommercePreview', schema);
