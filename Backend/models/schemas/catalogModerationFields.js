'use strict';
const mongoose = require('mongoose');

const violationSchema = new mongoose.Schema({
  field: { type: String, maxlength: 160 }, code: { type: String, maxlength: 80 }, reason: { type: String, maxlength: 400 },
}, { _id: false });
const catalogModerationSchema = new mongoose.Schema({
  policyVersion: { type: String, default: '' },
  contentHash: { type: String, default: '' },
  revision: { type: String, default: '' },
  submittedAt: { type: Date, default: null },
  violations: { type: [violationSchema], default: [] },
  attempts: { type: Number, default: 0, min: 0 },
  nextAttemptAt: { type: Date, default: null },
  leaseUntil: { type: Date, default: null },
  leaseToken: { type: String, default: '' },
  lastError: { type: String, default: '', maxlength: 160 },
  assets: { type: [new mongoose.Schema({ sourceUrl: String, reviewUrl: String, publicId: String }, { _id: false })], default: [] },
  lastApprovedName: { type: String, default: '' },
  noticeId: { type: String, default: '' },
  noticeAt: { type: Date, default: null },
  noticeStatus: { type: String, enum: ['', 'approved', 'blocked', 'pending'], default: '' },
  noticeReason: { type: String, default: '', maxlength: 1000 },
  noticeEnqueuedAt: { type: Date, default: null },
}, { _id: false });

module.exports = { catalogModerationSchema };
