'use strict';
const { readSafepayConfig } = require('../config/safepay');

// Checkout switches control NEW payment agreements, not already accepted
// liabilities. Signed callbacks, refunds and consented renewals must drain even
// when both storefronts are paused. Never fall back to another environment.
const safepayWorkersEnabled = (env = process.env) => {
  try {
    readSafepayConfig(env, { requireWebhook: true });
    return true;
  } catch (_) {
    return false;
  }
};
module.exports = { safepayWorkersEnabled };
