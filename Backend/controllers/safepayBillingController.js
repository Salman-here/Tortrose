'use strict';
const mongoose = require('mongoose');
const billing = require('../services/safepayBillingService');
const lifecycle = require('../services/safepayBillingLifecycleService');
const payments = require('../services/safepayPaymentService');
const Operation = require('../models/SafepayBillingOperation');
const fail = (res, error) => res.status(error.statusCode || 503).json({
  msg: error.statusCode ? error.message : 'Billing is temporarily unavailable. Your existing payment attempt is retained.',
  code: error.code || 'SAFEPAY_BILLING_UNAVAILABLE',
});
exports.quote = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { payments.requireMobileSafepay(req.body?.clientSurface); return res.json(await billing.createQuote(req.user.id, req.body)); }
  catch (error) { return fail(res, error); }
};
exports.accept = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { payments.requireMobileSafepay(req.body?.clientSurface); return res.json(await billing.acceptQuote(req.user.id, req.body)); }
  catch (error) { return fail(res, error); }
};
exports.status = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (!mongoose.isValidObjectId(req.params.operationId)) return res.status(404).json({ msg: 'Billing operation not found.' });
    const op = await Operation.findOne({ _id: req.params.operationId, seller: req.user.id });
    if (!op) return res.status(404).json({ msg: 'Billing operation not found.' });
    if (op.payment && op.status === 'awaiting_payment') await payments.reconcilePayment(op.payment);
    return res.json(await billing.operationStatus(req.user.id, op._id));
  } catch (error) { return fail(res, error); }
};
const action = name => async (req, res) => {
  try { payments.requireMobileSafepay(req.body?.clientSurface); return res.json(await lifecycle[name](req.user.id)); }
  catch (error) { return fail(res, error); }
};
exports.cancel = action('cancel');
exports.resume = action('resume');
exports.downgrade = action('scheduleDowngrade');
exports.cancelDowngrade = action('cancelDowngrade');
exports.retryQuote = async (req, res) => {
  try { payments.requireMobileSafepay(req.body?.clientSurface); return res.json(await require('../services/safepayBillingRecoveryService').retryQuote(req.user.id, req.body)); }
  catch (error) { return fail(res, error); }
};
exports.changeCard = async (req, res) => {
  try { payments.requireMobileSafepay(req.body?.clientSurface); return res.json(await require('../services/safepayBillingRecoveryService').changeCard(req.user.id, req.body)); }
  catch (error) { return fail(res, error); }
};
