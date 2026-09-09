'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  requestKey: { type: String, required: true },
  targetCurrency: { type: String, enum: ['USD', 'PKR', 'EUR', 'GBP'], required: true },
  sourceCurrency: { type: String, enum: ['USD', 'PKR', 'EUR', 'GBP'], required: true },
  // Server-built, never accepted as a model/client-supplied price plan.
  plan: { type: mongoose.Schema.Types.Mixed, required: true },
  notice: { type: String, required: true },
  cooldownDays: { type: Number, required: true },
  status: { type: String, enum: ['quoted', 'committed'], default: 'quoted' },
  result: { type: mongoose.Schema.Types.Mixed },
  expiresAt: { type: Date, required: true },
  committedAt: { type: Date, default: null },
  purgeAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });

module.exports = mongoose.model('AIStoreCurrencyPreview', schema);
