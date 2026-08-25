const mongoose = require('mongoose');

// Inserted and completed in the same transaction as a retry-sensitive AI
// mutation. A lost stream/HTTP response can therefore replay the stored result
// without applying relative money math a second time.
const aiActionReceiptSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  action: { type: String, required: true, trim: true },
  requestKey: { type: String, required: true, trim: true },
  toolOrdinal: { type: Number, required: true, min: 0 },
  requestFingerprint: { type: String, required: true },
  status: {
    type: String,
    enum: ['processing', 'completed'],
    default: 'processing',
  },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  },
}, { timestamps: true, versionKey: false });

aiActionReceiptSchema.index({ user: 1, requestKey: 1, toolOrdinal: 1 }, { unique: true });
aiActionReceiptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AIActionReceipt', aiActionReceiptSchema);
