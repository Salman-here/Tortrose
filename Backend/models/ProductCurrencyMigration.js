'use strict';

const mongoose = require('mongoose');

const exchangeRateSnapshotSchema = new mongoose.Schema({
  base: { type: String, enum: ['USD'], required: true },
  rates: {
    USD: { type: Number, required: true },
    PKR: { type: Number, required: true },
    EUR: { type: Number, required: true },
    GBP: { type: Number, required: true },
  },
  capturedAt: { type: Date, required: true },
  source: { type: String, required: true, maxlength: 120 },
  fallback: { type: Boolean, required: true },
}, { _id: false });

const cursorSchema = new mongoose.Schema({
  phase: {
    type: String,
    enum: ['seller', 'orphan', 'done'],
    required: true,
    default: 'seller',
  },
  lastSellerId: { type: mongoose.Schema.Types.ObjectId, default: null },
  activeSellerId: { type: mongoose.Schema.Types.ObjectId, default: null },
  lastProductId: { type: mongoose.Schema.Types.ObjectId, default: null },
  authority: {
    kind: { type: String, enum: ['store', 'seller', 'none'], default: 'none' },
    storeId: { type: mongoose.Schema.Types.ObjectId, default: null },
    storeCurrency: { type: String, enum: ['USD', 'PKR', 'EUR', 'GBP'], default: null },
    targetCurrency: { type: String, enum: ['USD', 'PKR', 'EUR', 'GBP'], default: null },
    sellerCurrency: { type: String, enum: ['USD', 'PKR', 'EUR', 'GBP'], default: null },
    sellerCurrencyExplicit: { type: Boolean, default: false },
    sellerExists: { type: Boolean, default: false },
  },
}, { _id: false });

const productCurrencyMigrationSchema = new mongoose.Schema({
  migrationId: {
    type: String,
    required: true,
    minlength: 8,
    maxlength: 100,
    match: /^[A-Za-z0-9][A-Za-z0-9._:-]+$/,
  },
  status: {
    type: String,
    enum: ['running', 'completed'],
    required: true,
    default: 'running',
  },
  force: { type: Boolean, required: true, default: false },
  batchSize: { type: Number, required: true, min: 1, max: 200 },
  upperBoundProductId: { type: mongoose.Schema.Types.ObjectId, default: null },
  estimatedProducts: { type: Number, required: true, min: 0 },
  rateSnapshot: { type: exchangeRateSnapshotSchema, required: true },
  migratedAt: { type: Date, required: true },
  cursor: { type: cursorSchema, required: true, default: () => ({}) },
  batchesCommitted: { type: Number, required: true, min: 0, default: 0 },
  productsCommitted: { type: Number, required: true, min: 0, default: 0 },
  lastError: {
    code: { type: String, default: '' },
    message: { type: String, default: '' },
    at: { type: Date, default: null },
  },
  lease: {
    owner: { type: String, default: null },
    expiresAt: { type: Date, default: null },
  },
  completedAt: { type: Date, default: null },
}, {
  timestamps: true,
  collection: 'product_currency_migrations',
});

productCurrencyMigrationSchema.index(
  { migrationId: 1 },
  { unique: true, name: 'uniq_product_currency_migration_id' }
);
productCurrencyMigrationSchema.index(
  { 'lease.expiresAt': 1 },
  { name: 'idx_product_currency_migration_lease' }
);

module.exports = mongoose.model('ProductCurrencyMigration', productCurrencyMigrationSchema);
