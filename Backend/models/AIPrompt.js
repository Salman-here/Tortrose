const mongoose = require('mongoose');

// Admin-editable AI prompt storage.
//
// Two kinds of documents live here:
//   - type "builtin": an OVERRIDE of a code-shipped prompt (key must exist in
//     the aiPromptService registry). Only present when an admin has customized
//     that prompt — deleting the doc resets the prompt to the code default.
//   - type "custom": admin-created knowledge/instruction blocks (new features,
//     policies, FAQs) appended to the chat system prompt for the selected
//     roles/channels so the AI knows about them without a deploy.
const historyEntrySchema = new mongoose.Schema({
    content: { type: String, default: '' },
    version: { type: Number, default: 1 },
    updatedAt: { type: Date, default: Date.now },
    updatedByName: { type: String, default: '' },
}, { _id: false });

const aiPromptSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true, index: true },
    type: { type: String, enum: ['builtin', 'custom'], required: true },

    // Display metadata. For builtin prompts the registry supplies these, but we
    // persist a copy so listings stay stable even if registry labels change.
    title: { type: String, default: '' },
    description: { type: String, default: '' },
    category: { type: String, default: 'knowledge' },

    content: { type: String, default: '' },

    // Custom knowledge targeting: which chat roles receive this block and on
    // which channels. Builtin prompts ignore these fields.
    appliesTo: { type: [String], default: ['user', 'seller', 'admin'] },
    channels: { type: [String], default: ['web', 'whatsapp'] },

    // Custom prompts can be toggled off without deleting; builtin overrides are
    // always active (reset removes them instead).
    isActive: { type: Boolean, default: true },

    version: { type: Number, default: 1 },
    history: { type: [historyEntrySchema], default: [] },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedByName: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('AIPrompt', aiPromptSchema);
