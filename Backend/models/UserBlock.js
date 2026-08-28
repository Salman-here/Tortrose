const mongoose = require('mongoose');

const userBlockSchema = new mongoose.Schema({
  blocker: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  blocked: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  source: {
    type: String,
    enum: ['seller', 'reviewer', 'user'],
    default: 'user',
  },
}, { timestamps: true });

userBlockSchema.index({ blocker: 1, blocked: 1 }, { unique: true });
userBlockSchema.index({ blocker: 1, createdAt: -1 });

module.exports = mongoose.model('UserBlock', userBlockSchema);
