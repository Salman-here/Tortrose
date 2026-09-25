'use strict';
const mongoose = require('mongoose');
const Payment = require('../models/SafepayPayment');
const { readSafepayConfig } = require('../config/safepay');
const { reconcilePayment, prepareCheckout, paymentResponse, requireMobileSafepay } = require('../services/safepayPaymentService');
const cards = require('../services/safepayCustomerService');

async function ownedPayment(req) {
  const id = String(req.params.paymentId || '');
  if (!mongoose.isValidObjectId(id)) return null;
  // A payment URL/reference cannot authorize access to another customer's
  // order or wallet. Even polling and reopening require the signed-in owner.
  return Payment.findOne({ _id: id, user: req.user.id });
}
const reportError = (res, error) => res.status(error.statusCode || 503).json({
  msg: error.statusCode ? error.message : 'Payment verification is temporarily unavailable. Please retry.',
  code: error.code || 'SAFEPAY_UNAVAILABLE',
});

exports.getConfig = (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const config = readSafepayConfig(process.env, { requireWebhook: true });
    return res.json({ provider: 'safepay', enabled: process.env.SAFEPAY_MOBILE_ENABLED === 'true',
      environment: config.environment, paymentFlow: 'safepay_hosted', currencies: ['PKR', 'USD', 'EUR', 'GBP'] });
  } catch (_) {
    return res.status(503).json({ provider: 'safepay', enabled: false, msg: 'Mobile card payments are not available yet.' });
  }
};

exports.getPayment = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const owned = await ownedPayment(req);
    if (!owned) return res.status(404).json({ msg: 'Payment not found.' });
    const payment = await reconcilePayment(owned._id);
    const body = paymentResponse(payment);
    if (body.isPaid && payment.purpose === 'wallet_top_up') {
      const transaction = await require('../models/WalletTransaction').findOne({ safepayPaymentId: payment._id,
        user: req.user.id, safepayEnvironment: payment.environment, status: 'completed' }).lean();
      if (!transaction) throw Object.assign(new Error('Wallet payment is still being reconciled.'), { code: 'SAFEPAY_WALLET_RECONCILE_PENDING', statusCode: 503 });
      body.transaction = require('../services/walletService').serializeWalletTransaction(transaction);
      body.transactionId = String(transaction._id);
    }
    return res.json(body);
  } catch (error) { return reportError(res, error); }
};
exports.reopenPayment = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const owned = await ownedPayment(req);
    if (!owned) return res.status(404).json({ msg: 'Payment not found.' });
    return res.json(await prepareCheckout(owned._id));
  } catch (error) { return reportError(res, error); }
};

exports.listCards = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { return res.json(await cards.listCards(req.user.id)); }
  catch (error) { return reportError(res, error); }
};
exports.purchaseSubdomain = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    requireMobileSafepay(req.body?.clientSurface);
    return res.json(await require('../services/safepaySubdomainService').startPurchase(req.user.id, req.body));
  } catch (error) { return reportError(res, error); }
};
exports.startCardSetup = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    requireMobileSafepay(req.body?.clientSurface);
    return res.json(await cards.startCardSetup(req.user.id, req.body));
  } catch (error) { return reportError(res, error); }
};
exports.setDefaultCard = async (req, res) => {
  try {
    requireMobileSafepay(req.body?.clientSurface);
    return res.json(await cards.setDefaultCard(req.user.id, req.params.cardId));
  } catch (error) { return reportError(res, error); }
};
exports.deleteCard = async (req, res) => {
  try {
    requireMobileSafepay(req.body?.clientSurface);
    return res.json(await cards.deleteCard(req.user.id, req.params.cardId));
  } catch (error) { return reportError(res, error); }
};

exports.returnToApp = (req, res) => {
  // Navigation only. Neither the incoming outcome/tracker nor a return URL
  // updates financial state; the app must poll the authenticated status API.
  const attempt = String(req.query.attempt || '');
  const purpose = String(req.query.purpose || '');
  if (!mongoose.isValidObjectId(attempt) || !['order', 'wallet_top_up', 'subdomain', 'subscription', 'return_settlement', 'card_setup'].includes(purpose)) return res.sendStatus(400);
  const query = new URLSearchParams({ paymentId: attempt, purpose, outcome: req.query.outcome === 'cancel' ? 'cancel' : 'return' });
  const appUrl = `rozare://safepay-return?${query}`;
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
  res.status(200).type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Return to Rozare</title></head><body style="font-family:system-ui;padding:36px;max-width:480px;margin:auto"><h1>Continue in Rozare</h1><p>Your app will securely check the payment status.</p><a href="${appUrl.replace(/&/g, '&amp;')}" style="display:inline-block;padding:14px 20px;background:#4f46e5;color:white;border-radius:12px;text-decoration:none">Open Rozare</a><p>You can also close this page and return to the app.</p></body></html>`);
};
