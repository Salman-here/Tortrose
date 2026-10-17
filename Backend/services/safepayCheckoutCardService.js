'use strict';
const mongoose = require('mongoose');
const Payment = require('../models/SafepayPayment');
const Customer = require('../models/SafepayCustomer');
const POLICY = 'merchant-checkout-card-v1';
const isCheckoutCard = payment => payment?.purpose === 'order' && payment?.terms?.checkoutCardPolicy === POLICY
  && !!payment.user && !!payment.customerId && !payment.cardId && payment.providerEntryMode !== 'tms';
const fail = (message, code = 'SAFEPAY_CARD_ENTRY_UNAVAILABLE', statusCode = 409) => Object.assign(new Error(message), { code, statusCode });

async function synchronizeCheckoutCard(payment, tracker, config, client, at = new Date()) {
  if (!isCheckoutCard(payment) || payment.status !== 'paid' || !payment.appliedAt || payment.riskPending
      || !payment.checkoutCard?.consentToSave || ['saved', 'unavailable'].includes(payment.checkoutCard.syncStatus)) return payment;
  try {
    // Recheck the full provider binding here as well as at the reconciler boundary.
    require('./safepayClient').requireTracker(tracker, { tracker: payment.tracker, reference: payment.reference,
      amountMinor: payment.amountMinor, currency: payment.currency, customerId: payment.customerId,
      providerMode: 'payment', purpose: payment.purpose }, config);
    if (tracker.state !== 'TRACKER_ENDED') throw fail('Card verification is not complete.', 'SAFEPAY_SAVED_CARD_PENDING');
    const { verifySavedCheckoutCard, applyCardSetupDefault } = require('./safepayCardSetupService');
    const card = await verifySavedCheckoutCard(payment, tracker, config, client, at);
    await mongoose.connection.transaction(async session => {
      const current = await Payment.findOne({ _id: payment._id, status: 'paid', appliedAt: { $ne: null },
        riskPending: false, 'checkoutCard.consentToSave': true, 'checkoutCard.syncStatus': { $ne: 'saved' } }).session(session);
      if (!current || !isCheckoutCard(current)) return;
      await applyCardSetupDefault(current, card, session, at);
      current.checkoutCard.syncStatus = 'saved'; current.checkoutCard.lastSyncErrorCode = ''; await current.save({ session });
      await Customer.updateOne({ user: current.user, customerId: current.customerId, environment: current.environment,
        status: 'ready', createdForCardConsentAt: null }, { $set: { createdForCardConsentAt: current.checkoutCard.consentRecordedAt || at } }, { session });
    });
  } catch (error) {
    // Card-list propagation must never roll back a captured order or cause another charge.
    const securityFailure = ['SAFEPAY_PAYMENT_MISMATCH', 'SAFEPAY_CARD_MISMATCH'].includes(error.code);
    const expired = at.getTime() - new Date(payment.checkoutCard.consentRecordedAt || payment.createdAt).getTime() > 86400000;
    await Payment.updateOne({ _id: payment._id, status: 'paid', 'checkoutCard.syncStatus': { $ne: 'saved' } },
      { $set: { 'checkoutCard.syncStatus': securityFailure || expired ? 'unavailable' : 'pending',
        'checkoutCard.lastSyncErrorCode': /^[A-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'SAFEPAY_CARD_SYNC_PENDING',
        nextReconcileAt: new Date(at.getTime() + (securityFailure || expired ? 86400000 : 60000)) } });
  }
  return Payment.findById(payment._id);
}

async function prepareCardEntry({ payment, client, billing, saveCard, restartAuthentication, operationToken }) {
  if (!isCheckoutCard(payment) || payment.checkoutCard?.hostedCheckoutAt || typeof saveCard !== 'boolean') throw fail('Choose whether to save this card for future Rozare purchases.', 'SAFEPAY_CARD_CONSENT_INVALID', 400);
  const link = await Customer.findOne({ user: payment.user, environment: payment.environment, customerId: payment.customerId, status: 'ready' });
  if (!link) throw fail('This checkout profile does not belong to your account.', 'SAFEPAY_CUSTOMER_MISMATCH');
  const tracker = await client.getTracker(payment.tracker, payment);
  const initial = tracker.state === 'TRACKER_STARTED' && !tracker.charge
    && ['GENERATE_CAPTURE_CONTEXT', 'PAYER_AUTH_SETUP'].includes(tracker.next_actions?.CYBERSOURCE?.kind);
  const resettable = require('./safepayClient').canResetSavedCardAuthentication(tracker);
  if (payment.checkoutCard?.approvalStartedAt && !restartAuthentication) throw fail('Check this same payment before retrying card entry.', 'SAFEPAY_AUTHENTICATION_IN_PROGRESS');
  if (!initial) {
    if (!restartAuthentication || !resettable || !payment.checkoutCard?.approvalStartedAt) throw fail('This payment has advanced. Check its status before retrying.', 'SAFEPAY_AUTHENTICATION_IN_PROGRESS');
    // Explicit retry only; this resets authentication, never creates/captures another payment.
    const prior = payment.savedCardAuthentication;
    if (prior.resetStartedAt && (prior.resetLeaseUntil > new Date()
        || prior.resetFromState !== tracker.state || prior.resetFromAction !== tracker.next_actions?.CYBERSOURCE?.kind)) {
      throw fail('The previous reset is still being verified. Check the same payment shortly.', 'SAFEPAY_AUTHENTICATION_IN_PROGRESS');
    }
    const resetFilter = { _id: payment._id, status: 'ready', appliedAt: null,
      'savedCardAuthentication.operationToken': operationToken, 'savedCardAuthentication.operationLeaseUntil': { $gt: new Date() } };
    const resetAt = new Date();
    if ((await Payment.updateOne(resetFilter, { $set: { 'savedCardAuthentication.resetStartedAt': resetAt,
      'savedCardAuthentication.resetLeaseUntil': new Date(resetAt.getTime() + 300000),
      'savedCardAuthentication.resetFromState': tracker.state,
      'savedCardAuthentication.resetFromAction': tracker.next_actions.CYBERSOURCE.kind } })).matchedCount !== 1) {
      throw fail('This payment is being checked in another session.', 'SAFEPAY_AUTHENTICATION_IN_PROGRESS');
    }
    try { await client.resetCheckoutCardAuthentication(payment.tracker, payment); }
    catch (error) {
      if (!error.outcomeUnknown) await Payment.updateOne(resetFilter, { $set: {
        'savedCardAuthentication.resetStartedAt': null, 'savedCardAuthentication.resetLeaseUntil': null,
        'savedCardAuthentication.resetFromState': '', 'savedCardAuthentication.resetFromAction': '' } });
      throw error;
    }
  }
  const started = new Date();
  const updated = await Payment.findOneAndUpdate({ _id: payment._id, status: 'ready', appliedAt: null,
    localCancelledAt: null, riskPending: false, capturedMinor: 0, 'checkoutCard.hostedCheckoutAt': null,
    'savedCardAuthentication.operationToken': operationToken, 'savedCardAuthentication.operationLeaseUntil': { $gt: started } },
  { $set: { 'checkoutCard.consentToSave': saveCard, 'checkoutCard.consentRecordedAt': saveCard ? started : null,
    'checkoutCard.approvalStartedAt': started, 'checkoutCard.syncStatus': saveCard ? 'pending' : 'not_requested',
    'savedCardAuthentication.resetStartedAt': null, 'savedCardAuthentication.resetLeaseUntil': null,
    'savedCardAuthentication.resetFromState': '', 'savedCardAuthentication.resetFromAction': '' } }, { new: true });
  if (!updated) throw fail('This payment has advanced. Check its status.', 'SAFEPAY_CHECKOUT_CLOSED');
  const authToken = await client.createAuthToken();
  return { authToken, tracker: payment.tracker, environment: payment.environment, billing,
    saveCard: updated.checkoutCard.consentToSave, cardEntryRequired: true };
}
module.exports = { POLICY, isCheckoutCard, synchronizeCheckoutCard, prepareCardEntry };
