'use strict';
// Web and mobile share reconciliation and recurring billing. Turning off one
// checkout surface must not stop financial work for the other active surface.
const safepayWorkersEnabled = (env = process.env) => env.SAFEPAY_MOBILE_ENABLED === 'true'
  || env.SAFEPAY_WEB_ENABLED === 'true';
module.exports = { safepayWorkersEnabled };
