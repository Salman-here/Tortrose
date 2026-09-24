'use strict';
const { POLICY_VERSION } = require('../../services/catalogContentPolicy');
// Explicit trusted seed approval for tests of unrelated catalog/money flows.
// Safety tests submit through the real pending -> worker -> approved workflow.
module.exports = () => ({ moderationStatus: 'approved', moderationPolicyVersion: POLICY_VERSION, moderationReviewedAt: new Date(), isBlocked: false });
