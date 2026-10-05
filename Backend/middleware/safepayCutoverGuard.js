'use strict';
// Once web cutover is enabled, older clients must refresh rather than create
// a new payment with the retired provider. Existing receipts/read endpoints
// and reconciliation remain intact; this does not migrate any records.
const MESSAGE = 'Card payments now use Safepay. Refresh Rozare or update the app and retry from the current checkout.';
function assertCurrentCardProvider(provider) {
  if (provider === 'stripe' && (process.env.STRIPE_ENABLED !== 'true'
    || process.env.SAFEPAY_WEB_ENABLED === 'true' || process.env.SAFEPAY_MOBILE_ENABLED === 'true')) {
    throw Object.assign(new Error(MESSAGE), { code: 'PAYMENT_PROVIDER_CHANGED', statusCode: 409 });
  }
}
function legacyCheckoutGuard(req, res, next) {
  try { assertCurrentCardProvider('stripe'); return next(); }
  catch (error) { return res.status(error.statusCode).json({ msg: error.message, code: error.code }); }
}
module.exports = { assertCurrentCardProvider, legacyCheckoutGuard };
