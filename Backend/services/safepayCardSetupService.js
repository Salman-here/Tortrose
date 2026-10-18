'use strict';
const Customer = require('../models/SafepayCustomer');
const { requireOwnedCard, requireReusableCard } = require('./safepayClient');
const fail = (message, code) => Object.assign(new Error(message), { code, statusCode: 409 });
const POLICY = 'new-card-default-v1';
const identity = payment => ({ user: payment.user, environment: payment.environment,
  customerId: payment.customerId, status: 'ready' });

async function snapshotCardSetup(input, config, client, session) {
  const link = await Customer.findOne(identity({ ...input, environment: config.environment })).session(session);
  if (!link) throw fail('This payment profile is unavailable.', 'SAFEPAY_CUSTOMER_MISMATCH');
  const cards = await client.listCards(link.customerId);
  return { selectionPolicy: POLICY, existingCardIds: cards.map(card => requireOwnedCard(card, link.customerId, config).token),
    manualRevision: link.defaultCardManualRevision || 0 };
}

function successfulCardDetails(payment, tracker, mode = 'instrument') {
  // Reporter attempts are fetched server-side, not taken from a return URL.
  // Each successful attempt must belong to this exact instrument/customer.
  const details = (Array.isArray(tracker.attempts) ? tracker.attempts : []).filter(attempt => attempt.is_success === true
    && attempt.tracker === payment.tracker && attempt.mode === mode
    && (mode !== 'payment' || attempt.payment_method?.do_card_on_file === true)
    && attempt.customer?.token === payment.customerId
    && attempt.payment_method?.tracker === payment.tracker
    && attempt.payment_method?.attempt === attempt.token).map(attempt => attempt.payment_method);
  const key = card => [card.bin, card.last_four, Number(card.expiration_month), Number(card.expiration_year)].join(':');
  if (!details.length || new Set(details.map(key)).size !== 1
      || !/^\d{4}$/.test(details[0].last_four || '')
      || !/^\d{6,8}$/.test(details[0].bin || '')
      || !Number.isInteger(Number(details[0].expiration_month))
      || Number(details[0].expiration_month) < 1 || Number(details[0].expiration_month) > 12
      || !/^\d{4}$/.test(details[0].expiration_year || '')) {
    throw fail('Your saved card is still being verified. Check this same setup again.', 'SAFEPAY_SAVED_CARD_PENDING');
  }
  return details[0];
}

async function verifySavedSetupCard(payment, tracker, config, client, at, mode = 'instrument') {
  const details = successfulCardDetails(payment, tracker, mode);
  const cards = await client.listCards(payment.customerId);
  const detailMatches = cards.filter(card => {
    requireOwnedCard(card, payment.customerId, config);
    return card.cybersource?.bin === details.bin && card.cybersource.last_four === details.last_four
      && Number(card.cybersource.expiry_month) === Number(details.expiration_month)
      && Number(card.cybersource.expiry_year) === Number(details.expiration_year);
  });
  const matches = detailMatches.filter(card => { try { requireReusableCard(card, at); return true; } catch (_) { return false; } });
  const newLimited = detailMatches.filter(card => !payment.cardSetup.existingCardIds.includes(card.token));
  if (mode === 'instrument' && !matches.length && newLimited.length
    && newLimited.every(card => Number.isSafeInteger(card.max_usage) && card.max_usage >= 0)) {
    throw fail('Safepay verified the card but did not save a reusable payment method. Start a new secure card setup.', 'SAFEPAY_CARD_SETUP_NOT_REUSABLE');
  }
  const newCards = matches.filter(card => !payment.cardSetup.existingCardIds.includes(card.token));
  // Safepay may reuse an existing token when the same card is added again.
  // Never pick an unrelated card or guess between duplicate matching tokens.
  const candidates = newCards.length ? newCards : matches;
  if (candidates.length !== 1) throw fail('Your saved card is still being verified. Check this same setup again.', 'SAFEPAY_SAVED_CARD_PENDING');
  const card = requireOwnedCard(await client.getCard(payment.customerId, candidates[0].token), payment.customerId, config, candidates[0].token);
  if (card.cybersource?.bin !== details.bin || card.cybersource?.last_four !== details.last_four
      || Number(card.cybersource?.expiry_month) !== Number(details.expiration_month)
      || Number(card.cybersource?.expiry_year) !== Number(details.expiration_year)) {
    throw fail('Your saved card is still being verified. Check this same setup again.', 'SAFEPAY_SAVED_CARD_PENDING');
  }
  return requireReusableCard(card, at);
}

async function applyCardSetupDefault(payment, card, session, at) {
  const link = await Customer.findOne(identity(payment)).select('+deletingCardId').session(session);
  if (!link || link.deletingCardId === card.token) throw fail('This saved card is unavailable. Check your payment methods.', 'SAFEPAY_SAVED_CARD_PENDING');
  const order = `${payment.createdAt.toISOString()}:${payment._id}`;
  const revision = payment.cardSetup.manualRevision;
  const result = await Customer.updateOne({ ...identity(payment), deletingCardId: { $ne: card.token }, $and: [
    { $or: [{ defaultCardManualRevision: revision }, ...(revision === 0 ? [{ defaultCardManualRevision: { $exists: false } }] : [])] },
    { $or: [{ defaultCardSetupOrder: { $lte: order } }, { defaultCardSetupOrder: { $exists: false } }] },
  ] }, { $set: { defaultCardId: card.token, defaultCardSetupOrder: order } }, { session });
  payment.cardSetup.savedCardId = card.token;
  if (result.matchedCount === 1) payment.cardSetup.defaultAppliedAt = at;
}

const verifySavedCheckoutCard = (payment, tracker, config, client, at) => verifySavedSetupCard(payment, tracker, config, client, at, 'payment');
module.exports = { POLICY, snapshotCardSetup, verifySavedSetupCard, verifySavedCheckoutCard, applyCardSetupDefault };
