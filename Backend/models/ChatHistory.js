const mongoose = require('mongoose');

// ─── Individual message in a conversation ───
const messageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
  content: { type: String, default: '' },
  attachments: {
    type: [{
      type: { type: String, default: 'image' },
      url: { type: String, required: true },
      name: { type: String, default: 'Product image' },
    }],
    default: undefined,
  },
  toolEvents: { type: [mongoose.Schema.Types.Mixed], default: undefined }, // tool results, client actions, etc.
}, { timestamps: true });

// ─── A single conversation (chat session) ───
const conversationSchema = new mongoose.Schema({
  title: { type: String, default: 'New Chat' },
  messages: [messageSchema],
  isActive: { type: Boolean, default: true },
  lastActive: { type: Date, default: Date.now },
  source: { type: String, enum: ['web', 'whatsapp', 'mobile'], default: 'web' },
}, { timestamps: true });

// Cap messages per conversation
conversationSchema.pre('save', function (next) {
  if (this.messages && this.messages.length > 200) {
    this.messages = this.messages.slice(-200);
  }
  this.lastActive = new Date();
  next();
});

// ─── Chat History: one per user, holds multiple conversations ───
const chatHistorySchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },
  conversations: [conversationSchema],
  activeConversationId: { type: mongoose.Schema.Types.ObjectId, default: null },
  totalConversations: { type: Number, default: 0 },
}, { timestamps: true });

// Keep max 50 conversations, prune oldest
chatHistorySchema.pre('save', function (next) {
  if (this.conversations && this.conversations.length > 50) {
    this.conversations = this.conversations.slice(-50);
  }
  this.totalConversations = this.conversations?.length || 0;
  next();
});

module.exports = mongoose.model('ChatHistory', chatHistorySchema);
