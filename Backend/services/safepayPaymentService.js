'use strict';

const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Payment = require('../models/SafepayPayment');
const Customer = require('../models/SafepayCustomer');
const Order = require('../models/Order');
const { readSafepayConfig } = require('../config/safepay');
const { createSafepayClient, requireMoney, requireReusableCard } = require('./safepayClient');
const { safepayPaymentFacts, assertSafepayOrderBinding } = require('./safepayPaymentFacts');
const { normalizeSafepayPaymentRail, normalizeRaastAttemptStatus, safepayPaymentRailObservation } = require('./safepayPaymentRailService');
const { buildReturnUrl } = require('./safepayReturnNavigation');

const fail = (message, code, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof mongoose.Types.ObjectId)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const PAID_PURPOSES = new Set(['order', 'wallet_top_up', 'subdomain', 'return_settlement']);
const SETUP_PURPOSES = new Set([...PAID_PURPOSES, 'card_setup', 'subscription']);

function requireSafepayConfiguration(surface) {
  if (!['mobile', 'web'].includes(surface)) throw fail('Choose a supported checkout surface.', 'SAFEPAY_SURFACE_INVALID', 400);
  return readSafepayConfig(process.env, { requireWebhook: true });
}

function requireMobileSafepay(surface) {
  if (!['mobile', 'web'].includes(surface)) throw fail('Choose a supported checkout surface.', 'SAFEPAY_SURFACE_INVALID', 400);
  const enabled = surface === 'web' ? process.env.SAFEPAY_WEB_ENABLED : process.env.SAFEPAY_MOBILE_ENABLED;
  if (enabled !== 'true') throw fail('Card payments are temporarily unavailable on this surface.', 'SAFEPAY_NOT_ENABLED', 503);
  return requireSafepayConfiguration(surface);
}

function createSafepayPaymentService({
  configFor = () => readSafepayConfig(process.env, { requireWebhook: true }),
  clientFor = config => createSafepayClient({ config }),
  settle = (payment, tracker, session) => require('./safepaySettlementService').settleSafepayPayment(payment, tracker, session),
  close = (payment, session) => require('./safepaySettlementService').closeSafepayPayment(payment, session),
  quarantine = (payment, tracker, session, options) => require('./safepaySettlementService').quarantineSafepayPayment(payment, tracker, session, options),
  claimRecurring = paymentId => require('./safepayBillingService').claimRecurringCharge(paymentId),
  savedCheckoutFor = (payment, surface) => require('./safepaySavedCardCheckoutService').buildCheckoutContext(payment, surface),
  now = () => new Date(),
} = {}) {
  const ownedConfig = payment => {
    const config = configFor();
    if (payment.environment !== config.environment) throw fail('This payment belongs to a different Safepay environment.', 'SAFEPAY_ENVIRONMENT_MISMATCH');
    return config;
  };

  async function ensurePayment(input, { session = null } = {}) {
    const config = configFor();
    if (!SETUP_PURPOSES.has(input.purpose)) throw fail('Invalid payment purpose.', 'SAFEPAY_PURPOSE_INVALID', 400);
    const providerMode = input.purpose === 'card_setup' ? 'instrument' : input.purpose === 'subscription' ? 'subscription' : 'payment';
    requireMoney(input.amountMinor, input.currency, { allowZero: providerMode === 'instrument' });
    if (providerMode === 'instrument' && input.amountMinor !== 0) throw fail('Card verification must not charge money.', 'SAFEPAY_MONEY_INVALID', 400);
    if (providerMode !== 'payment' && !/^cus_[a-zA-Z0-9-]{8,100}$/.test(input.customerId || '')) throw fail('An owned customer is required.', 'SAFEPAY_CUSTOMER_REQUIRED', 400);
    if (providerMode === 'subscription' && !/^pm_[a-zA-Z0-9-]{8,100}$/.test(input.cardId || '')) throw fail('A verified reusable card is required.', 'SAFEPAY_REUSABLE_CARD_REQUIRED', 400);
    if (!input.user && input.purpose !== 'order') throw fail('Sign in to start this payment.', 'SAFEPAY_LOGIN_REQUIRED', 401);
    if (!/^[a-zA-Z0-9:_-]{8,160}$/.test(input.requestKey || '') || !/^[a-zA-Z0-9:_-]{8,160}$/.test(input.reference || '')) {
      throw fail('A valid payment attempt key is required.', 'INVALID_IDEMPOTENCY_KEY', 400);
    }
    const identity = { environment: config.environment, user: input.user || null, purpose: input.purpose, requestKey: input.requestKey };
    let existing = await Payment.findOne(identity).session(session);
    let customerId = input.customerId || null;
    if (providerMode === 'payment') {
      // Attach a merchant-owned profile only for an explicitly selected saved
      // card. A normal new-card purchase must use the hosted guest flow, even
      // when this account already has saved cards. Passing user_id without a
      // selected card makes hosted checkout request card-on-file enrollment
      // with a shopper JWT, which the provider rejects as merchant-only.
      // Reopening retains the original binding, including a guest/null binding:
      // creating a profile later must never change an existing payment attempt.
      const link = !existing && input.user && input.cardId ? await Customer.findOne({ user: input.user,
        environment: config.environment, status: 'ready', createdForCardConsentAt: { $ne: null } })
        .select('customerId').session(session) : null;
      const ownedId = existing ? existing.customerId : link?.customerId || null;
      if (customerId && customerId !== ownedId) throw fail('This checkout payment profile does not belong to this account.', 'SAFEPAY_CUSTOMER_MISMATCH');
      customerId = ownedId;
      if (input.cardId) {
        if (!input.user || !customerId || !/^pm_[a-zA-Z0-9-]{8,100}$/.test(input.cardId)) throw fail('Choose a saved card belonging to your account.', 'SAFEPAY_CARD_SELECTION_INVALID', 400);
        const cardLink = await Customer.findOne({ user: input.user, environment: config.environment,
          customerId, status: 'ready' }).select('+deletingCardId').session(session);
        if (!cardLink || cardLink.deletingCardId === input.cardId) throw fail('This saved card is unavailable. Choose another payment method.', 'SAFEPAY_CARD_SELECTION_INVALID');
        requireReusableCard(await clientFor(config).getCard(customerId, input.cardId));
      }
    }
    const terms = { user: String(input.user || ''), purpose: input.purpose, reference: input.reference,
      amountMinor: input.amountMinor, currency: input.currency, order: String(input.order || ''),
      store: String(input.store || ''), returnRequest: String(input.returnRequest || ''), terms: input.terms || {},
      ...(customerId ? { customerId } : {}), ...(input.cardId ? { cardId: input.cardId } : {}) };
    const expectedFingerprint = fingerprint(terms);
    if (!existing) {
      try {
        const [created] = await Payment.create([{ ...identity, reference: input.reference, amountMinor: input.amountMinor,
          currency: input.currency, order: input.order || null, store: input.store || null, returnRequest: input.returnRequest || null,
          terms: input.terms || {}, fingerprint: expectedFingerprint, providerMode,
          providerEntryMode: providerMode === 'payment' && input.cardId ? 'tms' : '', customerId, cardId: input.cardId || null }], { session });
        existing = created;
      } catch (error) {
        if (error.code !== 11000 || session) throw error;
        existing = await Payment.findOne(identity);
        if (!existing) throw error;
      }
    }
    if (existing.fingerprint !== expectedFingerprint) throw fail('This payment attempt was already used with different details.', 'IDEMPOTENCY_CONFLICT');
    return existing;
  }

  async function attachTracker(payment, tracker) {
    const attached = await Payment.findOneAndUpdate({ _id: payment._id, environment: payment.environment,
      status: { $in: ['creating', 'ready'] }, $or: [{ tracker: null }, { tracker: tracker.token }] },
    { $set: { tracker: tracker.token, status: 'ready', providerState: tracker.state, lastErrorCode: '', nextReconcileAt: now() } }, { new: true });
    if (!attached) throw fail('This payment changed while checkout was prepared.', 'SAFEPAY_SETUP_CONFLICT');
    if (attached.purpose === 'order') {
      // The transaction creating the attempt already bound this exact order.
      const result = await Order.updateOne({ _id: attached.order, safepayPaymentId: attached._id,
        paymentMethod: 'safepay', safepayEnvironment: attached.environment, isPaid: false },
      { $set: { safepayTrackerId: tracker.token, paymentSetupState: 'ready', paymentSetupCompletedAt: now() } });
      if (!result.matchedCount) {
        const order = await Order.findById(attached.order).select('safepayPaymentId isPaid');
        if (!order?.isPaid || String(order.safepayPaymentId) !== String(attached._id)) throw fail('The checkout order could not be bound.', 'SAFEPAY_ORDER_BINDING_INVALID');
      }
    }
    return attached;
  }

  async function recoverTracker(payment, client) {
    if (payment.tracker) return payment;
    if (payment.status !== 'creating' || !payment.creationStartedAt) throw fail('The payment has no recoverable provider request.', 'SAFEPAY_SETUP_CONFLICT');
    if (now().getTime() - new Date(payment.creationStartedAt).getTime() < 25000) {
      throw fail('Secure checkout is still being prepared. Retry this same attempt shortly.', 'CHECKOUT_IN_PROGRESS');
    }
    const tracker = await client.findTrackerByReference(payment);
    if (!tracker) throw fail('Payment setup is being reconciled. Please keep this payment attempt and retry shortly.', 'SAFEPAY_RECOVERY_PENDING', 503);
    return attachTracker(payment, tracker);
  }

  async function prepareTracker(payment, { clientSurface = 'mobile' } = {}) {
    const config = ownedConfig(payment);
    const client = clientFor(config);
    if (payment.status === 'new') {
      const claim = await Payment.findOneAndUpdate({ _id: payment._id, status: 'new' },
        { $set: { status: 'creating', creationStartedAt: now() } }, { new: true });
      if (!claim) throw fail('Secure checkout is being prepared by another request.', 'CHECKOUT_IN_PROGRESS');
      payment = claim;
      if (payment.purpose === 'order') await Order.updateOne({ _id: payment.order, safepayPaymentId: payment._id, isPaid: false },
        { $set: { paymentSetupState: 'creating', paymentSetupStartedAt: now() } });
      let tracker;
      try {
        tracker = await client.createTracker(payment, { clientSurface });
      } catch (error) {
        // Never retry a provider mutation after a timeout, 5xx, or malformed
        // response. Recovery searches by our immutable correlation instead.
        await Payment.updateOne({ _id: payment._id, status: 'creating' }, { $set: {
          lastErrorCode: error.code || 'SAFEPAY_SETUP_FAILED', nextReconcileAt: new Date(now().getTime() + 30000),
        } });
        throw error;
      }
      payment = await attachTracker(payment, tracker);
    } else if (!payment.tracker && payment.status === 'creating') {
      payment = await recoverTracker(payment, client);
    }
    return payment;
  }

  async function prepareCheckout(paymentId, { clientSurface = 'mobile' } = {}) {
    if (!['mobile', 'web'].includes(clientSurface)) throw fail('Invalid checkout surface.', 'SAFEPAY_SURFACE_INVALID', 400);
    let payment = await Payment.findById(paymentId).select('+cardId');
    if (!payment) throw fail('Payment not found.', 'PAYMENT_NOT_FOUND', 404);
    const config = ownedConfig(payment);
    const client = clientFor(config);
    if (!PAID_PURPOSES.has(payment.purpose) && payment.purpose !== 'card_setup') throw fail('Unsupported hosted checkout purpose.', 'SAFEPAY_PURPOSE_INVALID');
    payment = await prepareTracker(payment, { clientSurface });
    if (payment.tracker) payment = await reconcilePayment(payment._id);
    if (['paid', 'authorized'].includes(payment.status) && payment.appliedAt) return paymentResponse(payment);
    if (!['ready'].includes(payment.status)) throw fail('This checkout can no longer accept payment. Check its current status.', 'SAFEPAY_CHECKOUT_CLOSED');
    if (payment.purpose === 'order' && payment.terms?.settlementPolicy === 'revalidate-on-payment-v1') {
      await mongoose.connection.transaction(session => require('./safepayOrderAvailabilityService').assertOrderAvailable(payment, session));
    }

    if (payment.providerEntryMode === 'tms') {
      const saved = savedCheckoutFor(payment, clientSurface);
      const checkoutUrl = typeof saved === 'string' ? saved : saved.checkoutUrl;
      return { ...paymentResponse(payment), ...(typeof saved === 'object' ? saved : {}), checkoutPresentation: 'saved-card', checkoutUrl, url: checkoutUrl };
    }
    const authToken = await client.createAuthToken();
    const returnContext = { backendOrigin: process.env.PUBLIC_BACKEND_URL || 'https://rozare.up.railway.app',
      attempt: String(payment._id), purpose: payment.purpose, surface: clientSurface };
    const redirectUrl = buildReturnUrl({ ...returnContext, outcome: 'return' });
    const cancelUrl = buildReturnUrl({ ...returnContext, outcome: 'cancel' });
    const checkoutUrl = client.buildPaymentCheckoutUrl({ tracker: payment.tracker, authToken, reference: payment.reference,
      redirectUrl, cancelUrl, customerId: payment.customerId,
      source: clientSurface === 'web' ? 'hosted' : 'mobile' });
    // The URL is returned only to the authenticated owner; it is neither
    // logged nor included in order serializers/notification payloads.
    return { ...paymentResponse(payment), checkoutPresentation: 'embedded', checkoutUrl, url: checkoutUrl };
  }

  async function submitRecurringPayment(paymentId) {
    let payment = await Payment.findById(paymentId).select('+cardId');
    if (!payment || payment.purpose !== 'subscription' || payment.providerMode !== 'subscription') {
      throw fail('Recurring payment not found.', 'SAFEPAY_RECURRING_BINDING_INVALID', 404);
    }
    const client = clientFor(ownedConfig(payment));
    payment = await prepareTracker(payment);
    payment = await reconcilePayment(payment._id);
    if (payment.appliedAt || !['ready'].includes(payment.status)) return paymentResponse(payment);
    // The billing service claims the frozen invoice while holding the same
    // subscription transaction fence used by cancellation and plan changes.
    // A lost network response never causes another automatic capture request.
    const claimed = await claimRecurring(payment._id);
    if (!claimed) return paymentResponse(await Payment.findById(payment._id));
    try {
      await client.chargeRecurring(claimed.tracker, claimed, claimed.cardId);
      await Payment.updateOne({ _id: claimed._id }, { $set: { chargeCompletedAt: now() } });
    } catch (error) {
      await Payment.updateOne({ _id: claimed._id, appliedAt: null }, { $set: {
        lastErrorCode: error.outcomeUnknown ? 'SAFEPAY_CHARGE_OUTCOME_UNKNOWN' : error.code || 'SAFEPAY_CHARGE_FAILED',
        chargeOutcome: error.outcomeUnknown ? 'unknown' : 'declined',
        nextReconcileAt: now(),
      } });
      // Read-only reconciliation may discover a captured payment despite an
      // HTTP failure. It must never resend the authorization as a fallback.
      try { return paymentResponse(await reconcilePayment(claimed._id)); }
      catch (_) { throw error; }
    }
    return paymentResponse(await reconcilePayment(claimed._id));
  }

  async function reconcilePayment(paymentId) {
    await require('../models/SafepayRefundEvent').init();
    const lease = crypto.randomUUID();
    const at = now();
    let payment = await Payment.findOneAndUpdate({ _id: paymentId,
      $or: [{ leaseUntil: null }, { leaseUntil: { $lt: at } }] },
    { $set: { processingToken: lease, leaseUntil: new Date(at.getTime() + 90000) }, $inc: { reconcileAttempts: 1 } }, { new: true });
    if (!payment) {
      const current = await Payment.findById(paymentId);
      if (!current) throw fail('Payment not found.', 'PAYMENT_NOT_FOUND', 404);
      return current;
    }
    let tracker;
    try {
      const config = ownedConfig(payment);
      const client = clientFor(config);
      if (!payment.tracker) {
        if (payment.status === 'new') return payment;
        payment = await recoverTracker(payment, client);
      }
      tracker = await client.getTracker(payment.tracker, payment);
      let observation;
      try { observation = safepayPaymentRailObservation(payment, tracker, at); }
      catch (error) {
        if (error.code !== 'SAFEPAY_PAYMENT_RAIL_CHANGED') throw error;
        await mongoose.connection.transaction(async session => {
          const current = await Payment.findOne({ _id: payment._id, processingToken: lease }).session(session);
          if (!current) throw fail('Payment reconciliation lease changed.', 'SAFEPAY_RECONCILE_CONFLICT');
          await quarantine(current, tracker, session, { skipRefundReconciliation: true });
          current.status = 'manual_review'; current.riskPending = true;
          current.lastErrorCode = error.code; current.lastReconciledAt = at;
          current.nextReconcileAt = new Date(at.getTime() + 60000);
          await current.save({ session });
        });
        return await Payment.findById(payment._id);
      }
      // Keep trusted evidence even if the following financial transaction rolls
      // back because stock, price or local cancellation prevented fulfillment.
      const observed = await Payment.updateOne({ _id: payment._id, processingToken: lease }, { $set: observation });
      if (observed.matchedCount !== 1) throw fail('Payment reconciliation lease changed.', 'SAFEPAY_RECONCILE_CONFLICT');
      const facts = safepayPaymentFacts(tracker);
      await mongoose.connection.transaction(async session => {
        const current = await Payment.findOne({ _id: payment._id, processingToken: lease }).session(session);
        if (!current) throw fail('Payment reconciliation lease changed.', 'SAFEPAY_RECONCILE_CONFLICT');
        const previousErrorCode = current.lastErrorCode;
        current.providerState = facts.state;
        current.lastReconciledAt = at;
        current.lastErrorCode = '';
        if (current.appliedAt && current.purpose === 'order') {
          const order = await Order.findById(current.order).session(session);
          const orderMinor = require('./stripeOrderPaymentService').getExpectedStripeTotalMinor(order);
          assertSafepayOrderBinding(order, current, orderMinor);
          if (normalizeSafepayPaymentRail(order.safepayPaymentRail) !== normalizeSafepayPaymentRail(current.paymentRail)) {
            const updated = await Order.updateOne({ _id: order._id, user: current.user, paymentMethod: 'safepay',
              safepayPaymentId: current._id, safepayEnvironment: current.environment, currency: current.currency },
            { $set: { safepayPaymentRail: normalizeSafepayPaymentRail(current.paymentRail) } }, { session });
            if (updated.matchedCount !== 1) throw fail('The order payment binding changed.', 'SAFEPAY_ORDER_BINDING_INVALID');
          }
        }
        if (facts.outcome === 'risk') {
          const result = await quarantine(current, tracker, session);
          current.riskPending = result?.resolved !== true;
          current.status = result?.resolved ? result.status : 'manual_review';
          if (Number.isSafeInteger(result?.refundedMinor)) current.refundedMinor = result.refundedMinor;
        } else if (facts.outcome === 'paid') {
          if (!current.appliedAt) {
            if (['refund_pending', 'manual_review'].includes(current.status) && current.safetyRefund?.requestedAt) {
              current.nextReconcileAt = new Date(at.getTime() + 60000);
              current.lastErrorCode = current.status === 'manual_review' ? previousErrorCode || 'SAFEPAY_REFUND_NEEDS_REVIEW'
                : current.safetyRefund.outcome === 'failed' ? 'SAFEPAY_REFUND_NEEDS_REVIEW' : 'SAFEPAY_SAFETY_REFUND_PENDING';
              await current.save({ session });
              return;
            }
            if (['cancelled', 'cancel_requested', 'failed', 'refund_pending', 'refunded', 'manual_review'].includes(current.status)) {
              await quarantine(current, tracker, session);
              current.status = 'manual_review';
              current.riskPending = true;
              current.lastErrorCode = 'SAFEPAY_LATE_PAYMENT_REVIEW';
            } else {
              if (current.purpose !== 'card_setup') await settle(current, tracker, session);
              current.status = current.purpose === 'card_setup' ? 'authorized' : 'paid';
              current.capturedMinor = current.purpose === 'card_setup' ? 0 : current.amountMinor;
              if (current.purpose === 'subscription') current.chargeOutcome = 'paid';
              if (current.purpose !== 'card_setup') current.paidAt = current.paidAt || at;
              current.appliedAt = at;
            }
          }
        } else if (facts.outcome === 'closed' && !current.appliedAt) {
          await close(current, session);
          current.status = 'cancelled';
          current.cancelledAt = current.cancelledAt || at;
        } else if (facts.state === 'TRACKER_STARTED' && current.purpose === 'subscription' && current.chargeOutcome === 'declined' && !current.appliedAt) {
          await require('./safepayBillingService').failBillingPayment(current, session);
          current.status = 'failed';
          current.chargeCompletedAt = current.chargeCompletedAt || at;
          current.lastErrorCode = 'SAFEPAY_RECURRING_PAYMENT_DECLINED';
        }
        const ageMs = at.getTime() - new Date(current.createdAt).getTime();
        const delayMs = ['paid', 'authorized', 'refunded'].includes(current.status) ? 24 * 60 * 60000
          : ageMs > 24 * 60 * 60000 ? 60 * 60000 : ageMs > 60 * 60000 ? 10 * 60000 : 60000;
        current.nextReconcileAt = new Date(at.getTime() + delayMs);
        await current.save({ session });
      });
      if (facts.outcome === 'paid') {
        const pendingRefund = await Payment.findById(paymentId);
        if (pendingRefund.status === 'refund_pending' && pendingRefund.safetyRefund?.requestedAt) {
          await require('./safepaySafetyRefundService').submit(pendingRefund, client);
        }
      }
      return await Payment.findById(payment._id);
    } catch (error) {
      if (tracker?.state === 'TRACKER_ENDED' && payment.purpose === 'order'
          && require('./safepaySafetyRefundService').isFulfillmentFailure(error)) {
        const pending = await require('./safepaySafetyRefundService').schedule(payment._id, error.code);
        await require('./safepaySafetyRefundService').submit(pending, clientFor(ownedConfig(pending)));
        return await Payment.findById(payment._id);
      }
      await Payment.updateOne({ _id: paymentId, processingToken: lease }, { $set: {
        lastErrorCode: error.code || 'SAFEPAY_RECONCILE_FAILED', nextReconcileAt: new Date(now().getTime() + 60000),
      } });
      throw error;
    } finally {
      await Payment.updateOne({ _id: paymentId, processingToken: lease }, { $set: { processingToken: '', leaseUntil: null } });
    }
  }

  return { ensurePayment, prepareCheckout, reconcilePayment, recoverTracker, submitRecurringPayment };
}

function paymentResponse(payment) {
  const paid = payment.status === 'paid' && !!payment.appliedAt && !payment.riskPending;
  const cardSaved = payment.purpose === 'card_setup' && payment.status === 'authorized' && !!payment.appliedAt;
  return { paymentMethod: 'safepay', paymentFlow: 'safepay_hosted', paymentId: String(payment._id),
    purpose: payment.purpose, environment: payment.environment, currency: payment.currency,
    amountMinor: payment.amountMinor, mongoOrderId: payment.order || null,
    refundedMinor: payment.refundedMinor,
    paymentRail: normalizeSafepayPaymentRail(payment.paymentRail),
    raastAttemptStatus: normalizeSafepayPaymentRail(payment.paymentRail) === 'raast' ? normalizeRaastAttemptStatus(payment.raastAttemptStatus) : null,
    status: cardSaved ? 'authorized' : paid ? 'paid' : ['cancelled', 'failed', 'refunded', 'refund_pending', 'manual_review'].includes(payment.status) ? payment.status : 'pending',
    isPaid: paid, completed: paid || cardSaved, cardSaved, webhookProcessed: paid || cardSaved, providerState: payment.providerState, failureCode: payment.lastErrorCode || '' };
}

module.exports = { createSafepayPaymentService, requireMobileSafepay, requireSafepayConfiguration, paymentResponse, fingerprint,
  ...createSafepayPaymentService() };
