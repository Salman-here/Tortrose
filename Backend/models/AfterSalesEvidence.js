'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, immutable: true },
  kind: { type: String, enum: ['return', 'warranty'], default: 'warranty', immutable: true },
  url: { type: String, required: true, immutable: true, maxlength: 2000 },
  publicId: { type: String, required: true, immutable: true, maxlength: 200, select: false },
  mime: { type: String, enum: ['image/jpeg', 'image/png', 'image/webp'], required: true, immutable: true },
  size: { type: Number, min: 1, max: 5242880, required: true, immutable: true, validate: Number.isSafeInteger },
  claim: { type: mongoose.Schema.Types.ObjectId, ref: 'ReturnRequest', default: null },
}, { timestamps: true });
schema.index({ user: 1, order: 1, createdAt: -1 });
module.exports = mongoose.model('AfterSalesEvidence', schema);
