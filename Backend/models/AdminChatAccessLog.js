const mongoose = require('mongoose');

// Access metadata only: never duplicate chat bodies, attachments or credentials.
const schema = new mongoose.Schema({
  admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  subject: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  conversation: { type: mongoose.Schema.Types.ObjectId, required: true },
  source: { type: String, enum: ['web', 'mobile', 'whatsapp', 'unknown'], required: true },
  action: { type: String, enum: ['view_conversation'], default: 'view_conversation' },
}, { timestamps: { createdAt: true, updatedAt: false } });

module.exports = mongoose.model('AdminChatAccessLog', schema);
