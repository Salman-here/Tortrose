'use strict';

const mongoose = require('mongoose');

/**
 * Revocation metadata for one Expo installation token. Neither the Expo token
 * nor its revocation credential is stored here; both are represented by
 * one-way SHA-256 hashes.
 */
const expoPushTokenRegistrationSchema = new mongoose.Schema({
    tokenHash: { type: String, required: true, unique: true },
    revocationHash: { type: String, required: true, select: false },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    revokedAt: { type: Date, default: null },
    rotatedAt: { type: Date, default: Date.now },
}, {
    timestamps: true,
    versionKey: false,
});

module.exports = mongoose.model('ExpoPushTokenRegistration', expoPushTokenRegistrationSchema);
