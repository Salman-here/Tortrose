'use strict';

// Legacy-provider tests must opt in explicitly now that production defaults
// to Safepay. Keep this outside runtime code and restore every flag per test.
module.exports = function retainedStripeTestMode() {
  const keys = ['STRIPE_ENABLED', 'SAFEPAY_WEB_ENABLED', 'SAFEPAY_MOBILE_ENABLED'];
  let previous;
  beforeEach(() => {
    previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.STRIPE_ENABLED = 'true';
    process.env.SAFEPAY_WEB_ENABLED = 'false';
    process.env.SAFEPAY_MOBILE_ENABLED = 'false';
  });
  afterEach(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
};
