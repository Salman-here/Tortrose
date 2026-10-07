'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const service = require('../services/safepaySavedCardCheckoutService');
const errorResponse = (res, error) => res.status(error.statusCode || 503).json({
  msg: error.statusCode ? error.message : 'Saved-card verification is temporarily unavailable. Keep this payment and retry.',
  code: error.code || 'SAFEPAY_SAVED_CARD_UNAVAILABLE' });
exports.page = (req, res) => {
  if (!/^[a-f0-9]{24}$/i.test(req.params.paymentId || '')) return res.sendStatus(404);
  const nonce = crypto.randomBytes(18).toString('base64');
  let initialGrant = '';
  if (req.get('X-Rozare-Checkout-Grant')) {
    try { service.verifySessionGrant(req.params.paymentId, req.get('X-Rozare-Checkout-Grant')); initialGrant = req.get('X-Rozare-Checkout-Grant'); }
    catch (_) { /* A public/copied URL does not get account or card access. */ }
  }
  res.set({ 'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src https://sandbox.api.getsafepay.com https://getsafepay.com; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors https://rozare.com https://www.rozare.com https://*.rozare.com` });
  return res.type('html').send(require('../services/safepaySavedCardCheckoutHtml').renderSavedCardCheckout({ nonce, initialGrant }));
};
exports.asset = (req, res) => {
  res.set({ 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  return res.type('application/javascript').sendFile(path.join(__dirname, '../node_modules/@sfpy/atoms/dist/components/index.global.js'));
};
exports.context = async (req, res) => {
  res.set('Cache-Control', 'no-store, private');
  try {
    const context = await service.viewContext(req.params.paymentId, req.get('Authorization'), req.get('X-Rozare-Checkout-Grant'));
    return res.json(context);
  } catch (error) { return errorResponse(res, error); }
};
exports.authenticate = async (req, res) => {
  res.set('Cache-Control', 'no-store, private');
  try { return res.json(await service.authenticate(req.params.paymentId, req.get('Authorization'), req.body?.billing, req.get('X-Rozare-Checkout-Grant'), { restartAuthentication: req.body?.restartAuthentication === true })); }
  catch (error) { return errorResponse(res, error); }
};
