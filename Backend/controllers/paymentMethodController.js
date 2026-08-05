'use strict';

const crypto = require('crypto');
const SellerSubscription = require('../models/SellerSubscription');
const { stripe, STRIPE_MODE } = require('../config/stripe');
const {
  ensureStripeCustomerForUser,
  createMobileCustomerAccess,
  getStripeMobileConfig,
  sanitizePaymentMethod,
  verifyPaymentMethodOwnership,
  PAYMENT_METHOD_FILTERS,
  SAVED_CARD_CONSENT_VERSION,
  selectRedisplayableReplacement,
  stripeError,
} = require('../services/stripeCustomerService');

const noStore = (res) => res.set('Cache-Control', 'no-store, private, max-age=0');
const SETUP_INTENT_ID_PATTERN = /^seti_[A-Za-z0-9]+$/;
const CANCELLABLE_SETUP_INTENT_STATUSES = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
]);
const EXPLICIT_CUSTOMER_CLOSE_REASONS = new Set([
  'buyer_cancelled_payment_sheet',
  'requested_by_customer',
]);

const setupIntentCustomerId = (setupIntent) => (
  typeof setupIntent?.customer === 'string'
    ? setupIntent.customer
    : setupIntent?.customer?.id || ''
);

const setupIntentBelongsToUser = ({ setupIntent, customerId, userId }) => (
  setupIntentCustomerId(setupIntent) === customerId
  && setupIntent?.metadata?.type === 'saved_payment_method_setup'
  && setupIntent?.metadata?.userId === String(userId)
  && setupIntent?.metadata?.stripeMode === STRIPE_MODE
);

const setupIntentCancellationReason = (closeReason) => (
  EXPLICIT_CUSTOMER_CLOSE_REASONS.has(String(closeReason || '').trim().toLowerCase())
    ? 'requested_by_customer'
    : 'abandoned'
);

const sendSetupIntentNotFound = (res) => res.status(404).json({
  msg: 'Card setup not found.',
  code: 'SETUP_INTENT_NOT_FOUND',
});

const sendSetupIntentCancelled = (res, setupIntent, { alreadyCancelled = false } = {}) => (
  res.status(200).json({
    success: true,
    cancelled: true,
    alreadyCancelled,
    setupIntentId: setupIntent.id,
    status: 'canceled',
    cancellationReason: setupIntent.cancellation_reason || null,
  })
);

const requestKey = (req) => {
  const key = String(
    req.headers['idempotency-key']
    || req.headers['x-idempotency-key']
    || req.body?.requestKey
    || crypto.randomUUID()
  ).trim();
  if (!key || key.length > 160 || !/^[A-Za-z0-9:_\-.]+$/.test(key)) {
    throw stripeError('Invalid card setup requestKey.', 'INVALID_IDEMPOTENCY_KEY', 400);
  }
  return key;
};

const sendError = (res, error, fallback) => {
  if ((error.statusCode || 500) >= 500 || String(error.type || '').startsWith('Stripe')) {
    console.error('[payment-methods] request error:', {
      code: error.code,
      type: error.type,
      statusCode: error.statusCode,
      param: error.param,
      message: error.message,
    });
  }
  return res.status(error.statusCode || 500).json({
    msg: error.statusCode ? error.message : fallback,
    ...(error.code ? { code: error.code } : {}),
  });
};

exports.getConfig = async (req, res) => {
  try {
    noStore(res);
    return res.status(200).json({ success: true, ...getStripeMobileConfig() });
  } catch (error) {
    return sendError(res, error, 'Could not load payment configuration.');
  }
};

exports.listPaymentMethods = async (req, res) => {
  try {
    noStore(res);
    const { customer } = await ensureStripeCustomerForUser(req.user.id);
    const [methods, freshCustomer] = await Promise.all([
      stripe.paymentMethods.list({ customer: customer.id, type: 'card', limit: 100 }),
      stripe.customers.retrieve(customer.id),
    ]);
    const defaultId = typeof freshCustomer.invoice_settings?.default_payment_method === 'string'
      ? freshCustomer.invoice_settings.default_payment_method
      : freshCustomer.invoice_settings?.default_payment_method?.id || null;
    return res.status(200).json({
      success: true,
      customerId: customer.id,
      defaultPaymentMethodId: defaultId,
      paymentMethods: (methods.data || [])
        .filter(method => PAYMENT_METHOD_FILTERS.includes(method.allow_redisplay || 'unspecified'))
        .map(method => sanitizePaymentMethod(method, defaultId)),
    });
  } catch (error) {
    return sendError(res, error, 'Could not load saved payment methods.');
  }
};

exports.createSetup = async (req, res) => {
  try {
    noStore(res);
    if (
      req.body?.consentAccepted !== true
      || req.body?.consentVersion !== SAVED_CARD_CONSENT_VERSION
    ) {
      return res.status(400).json({
        msg: 'Confirm that Stripe may save this card for future customer-initiated payments.',
        code: 'PAYMENT_METHOD_CONSENT_REQUIRED',
        consentVersion: SAVED_CARD_CONSENT_VERSION,
      });
    }
    const { customer } = await ensureStripeCustomerForUser(req.user.id);
    const key = requestKey(req);
    const isMobile = req.body?.clientSurface === 'mobile';
    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      usage: 'on_session',
      payment_method_types: ['card'],
      metadata: {
        type: 'saved_payment_method_setup',
        userId: String(req.user.id),
        stripeMode: STRIPE_MODE,
        consent: 'customer_initiated_on_session',
        consentAccepted: 'true',
        consentVersion: SAVED_CARD_CONSENT_VERSION,
        clientSurface: isMobile ? 'mobile' : 'web',
      },
    }, { idempotencyKey: `rozare-setup:${STRIPE_MODE}:${req.user.id}:${key}` });
    let customerAccess = null;
    if (isMobile) {
      try {
        customerAccess = await createMobileCustomerAccess(customer.id);
      } catch (customerSessionError) {
        try {
          await stripe.setupIntents.cancel(
            setupIntent.id,
            { cancellation_reason: 'abandoned' },
            { idempotencyKey: `rozare-setup-access-failure:${STRIPE_MODE}:${setupIntent.id}` },
          );
        } catch (cleanupError) {
          console.error('[payment-methods] SetupIntent cleanup after CustomerSession failure:', {
            code: cleanupError.code,
            type: cleanupError.type,
            statusCode: cleanupError.statusCode,
            message: cleanupError.message,
          });
          const recoveryError = stripeError(
            'Secure card setup cleanup is still being confirmed. Please wait before retrying.',
            'SETUP_INTENT_CLEANUP_PENDING',
            503,
          );
          recoveryError.cause = cleanupError;
          throw recoveryError;
        }
        const preparationError = stripeError(
          'Secure card setup could not open. The incomplete SetupIntent was cancelled.',
          'PAYMENT_SHEET_PREPARATION_FAILED',
          503,
        );
        preparationError.cause = customerSessionError;
        throw preparationError;
      }
    }
    return res.status(201).json({
      success: true,
      setupIntentId: setupIntent.id,
      setupIntentClientSecret: setupIntent.client_secret,
      customerId: customer.id,
      ...(customerAccess || {}),
      ...getStripeMobileConfig(),
      consent: {
        accepted: true,
        version: SAVED_CARD_CONSENT_VERSION,
        usage: 'on_session',
        message: 'The customer must explicitly choose to save this card for future purchases.',
      },
    });
  } catch (error) {
    return sendError(res, error, 'Could not start secure card setup.');
  }
};

exports.cancelSetup = async (req, res) => {
  try {
    noStore(res);
    const setupIntentId = String(req.params?.setupIntentId || '').trim();
    if (!SETUP_INTENT_ID_PATTERN.test(setupIntentId)) {
      return res.status(400).json({
        msg: 'Invalid card setup reference.',
        code: 'SETUP_INTENT_INVALID',
      });
    }

    const { customer } = await ensureStripeCustomerForUser(req.user.id);
    let setupIntent;
    try {
      setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
    } catch (error) {
      if (error?.code === 'resource_missing') return sendSetupIntentNotFound(res);
      throw error;
    }

    if (!setupIntentBelongsToUser({
      setupIntent,
      customerId: customer.id,
      userId: req.user.id,
    })) {
      return sendSetupIntentNotFound(res);
    }

    if (setupIntent.status === 'canceled') {
      return sendSetupIntentCancelled(res, setupIntent, { alreadyCancelled: true });
    }
    if (setupIntent.status === 'succeeded') {
      return res.status(409).json({
        msg: 'This card setup already succeeded and cannot be cancelled.',
        code: 'SETUP_INTENT_ALREADY_SUCCEEDED',
      });
    }
    if (!CANCELLABLE_SETUP_INTENT_STATUSES.has(setupIntent.status)) {
      return res.status(409).json({
        msg: 'This card setup is no longer in a cancellable state.',
        code: 'SETUP_INTENT_NOT_CANCELLABLE',
        status: setupIntent.status,
      });
    }

    const cancellationReason = setupIntentCancellationReason(req.body?.closeReason);
    let cancelledSetupIntent;
    try {
      cancelledSetupIntent = await stripe.setupIntents.cancel(
        setupIntentId,
        { cancellation_reason: cancellationReason },
        { idempotencyKey: `rozare-setup-cancel:${STRIPE_MODE}:${setupIntentId}` },
      );
    } catch (cancelError) {
      // A concurrent retry may have cancelled the same SetupIntent after this
      // request retrieved it. Re-read Stripe once so that cancellation remains
      // idempotent even when requests overlap.
      let refreshedSetupIntent = null;
      try {
        refreshedSetupIntent = await stripe.setupIntents.retrieve(setupIntentId);
      } catch {}
      if (
        refreshedSetupIntent?.status === 'canceled'
        && setupIntentBelongsToUser({
          setupIntent: refreshedSetupIntent,
          customerId: customer.id,
          userId: req.user.id,
        })
      ) {
        return sendSetupIntentCancelled(res, refreshedSetupIntent, { alreadyCancelled: true });
      }
      throw cancelError;
    }

    return sendSetupIntentCancelled(res, cancelledSetupIntent);
  } catch (error) {
    return sendError(res, error, 'Could not cancel secure card setup.');
  }
};

const subscriptionUsingCustomer = (userId, customerId) => SellerSubscription.findOne({
  seller: userId,
  stripeCustomerId: customerId,
  stripeSubscriptionId: { $nin: [null, ''] },
}).lean();
const ACTIVE_STRIPE_SUBSCRIPTION_STATUSES = new Set([
  'active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused',
]);

exports.deletePaymentMethod = async (req, res) => {
  try {
    noStore(res);
    const { customer } = await ensureStripeCustomerForUser(req.user.id);
    const paymentMethod = await verifyPaymentMethodOwnership(req.params.id, customer.id);
    const [subscription, methods, freshCustomer] = await Promise.all([
      subscriptionUsingCustomer(req.user.id, customer.id),
      stripe.paymentMethods.list({ customer: customer.id, type: 'card', limit: 100 }),
      stripe.customers.retrieve(customer.id),
    ]);
    const customerDefault = typeof freshCustomer.invoice_settings?.default_payment_method === 'string'
      ? freshCustomer.invoice_settings.default_payment_method
      : freshCustomer.invoice_settings?.default_payment_method?.id;

    if (subscription) {
      let stripeSubscription;
      try {
        stripeSubscription = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
      } catch (error) {
        if (error?.code !== 'resource_missing') throw error;
        stripeSubscription = null;
      }
      const subscriptionIsActive = ACTIVE_STRIPE_SUBSCRIPTION_STATUSES.has(stripeSubscription?.status);
      const subscriptionDefault = typeof stripeSubscription?.default_payment_method === 'string'
        ? stripeSubscription.default_payment_method
        : stripeSubscription?.default_payment_method?.id;
      if (subscriptionIsActive && (
        subscriptionDefault === paymentMethod.id
        || (!subscriptionDefault && customerDefault === paymentMethod.id)
        || (!subscriptionDefault && (methods.data || []).length <= 1)
      )) {
        return res.status(409).json({
          msg: 'This card is used for an active seller subscription. Add another card and make it default before removing this one.',
          code: 'PAYMENT_METHOD_IN_USE',
        });
      }
    }

    if (customerDefault === paymentMethod.id) {
      const replacement = selectRedisplayableReplacement(methods.data, paymentMethod.id);
      await stripe.customers.update(customer.id, {
        invoice_settings: { default_payment_method: replacement?.id || null },
      });
    }
    await stripe.paymentMethods.detach(paymentMethod.id);
    return res.status(200).json({ success: true, removedPaymentMethodId: paymentMethod.id });
  } catch (error) {
    return sendError(res, error, 'Could not remove this payment method.');
  }
};

exports.setDefaultPaymentMethod = async (req, res) => {
  try {
    noStore(res);
    const { customer } = await ensureStripeCustomerForUser(req.user.id);
    const paymentMethod = await verifyPaymentMethodOwnership(req.params.id, customer.id);
    if (paymentMethod.allow_redisplay !== 'always') {
      return res.status(409).json({
        msg: 'This card was not saved with the current consent flow. Add it again before making it default.',
        code: 'PAYMENT_METHOD_CONSENT_REQUIRED',
      });
    }
    const subscription = await subscriptionUsingCustomer(req.user.id, customer.id);
    const freshCustomer = await stripe.customers.retrieve(customer.id);
    const previousCustomerDefault = typeof freshCustomer.invoice_settings?.default_payment_method === 'string'
      ? freshCustomer.invoice_settings.default_payment_method
      : freshCustomer.invoice_settings?.default_payment_method?.id || null;
    if (subscription && previousCustomerDefault !== paymentMethod.id) {
      const stripeSubscription = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
      const subscriptionIsActive = ACTIVE_STRIPE_SUBSCRIPTION_STATUSES.has(stripeSubscription?.status);
      const explicitSubscriptionDefault = typeof stripeSubscription.default_payment_method === 'string'
        ? stripeSubscription.default_payment_method
        : stripeSubscription.default_payment_method?.id || null;
      if (subscriptionIsActive && !explicitSubscriptionDefault) {
        if (!previousCustomerDefault) {
          return res.status(409).json({
            msg: 'The active seller subscription billing card could not be preserved safely. Contact support before changing the commerce default.',
            code: 'SUBSCRIPTION_BILLING_METHOD_UNPINNED',
          });
        }
        // Pin the current effective recurring-billing card before changing the
        // customer's separate commerce preference.
        await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
          default_payment_method: previousCustomerDefault,
        });
      }
    }
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: paymentMethod.id },
    });
    return res.status(200).json({
      success: true,
      paymentMethod: sanitizePaymentMethod(paymentMethod, paymentMethod.id),
    });
  } catch (error) {
    return sendError(res, error, 'Could not update the default payment method.');
  }
};
