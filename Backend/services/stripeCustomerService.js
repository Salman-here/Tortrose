'use strict';

const User = require('../models/User');
const SellerSubscription = require('../models/SellerSubscription');
const {
  stripe,
  STRIPE_MODE,
  STRIPE_PUBLISHABLE_KEY,
  STRIPE_MERCHANT_COUNTRY_CODE,
  STRIPE_MERCHANT_DISPLAY_NAME,
  STRIPE_GOOGLE_PAY_ENABLED,
  STRIPE_CUSTOMER_SESSION_ENABLED,
  STRIPE_API_VERSION,
} = require('../config/stripe');

// Only cards for which Stripe captured an explicit redisplay choice are shown.
// Legacy `unspecified` methods require a new customer-consent setup flow.
const PAYMENT_METHOD_FILTERS = ['always'];
const SAVED_CARD_CONSENT_VERSION = '2026-08-01';

const selectRedisplayableReplacement = (paymentMethods, excludedId) => (
  (paymentMethods || []).find(method => (
    method?.id !== excludedId && method?.allow_redisplay === 'always'
  )) || null
);

const stripeError = (message, code, statusCode = 400) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const assertStripeServerConfigured = () => {
  if (!stripe) {
    throw stripeError('Card payments are temporarily unavailable.', 'STRIPE_NOT_CONFIGURED', 503);
  }
  if (!['test', 'live'].includes(STRIPE_MODE)) {
    throw stripeError('Stripe mode is invalid.', 'STRIPE_MODE_INVALID', 503);
  }
};

const assertStripeMobileConfigured = () => {
  assertStripeServerConfigured();
  if (!STRIPE_PUBLISHABLE_KEY) {
    throw stripeError('Mobile card payments are not configured.', 'STRIPE_PUBLISHABLE_KEY_MISSING', 503);
  }
  if (!STRIPE_MERCHANT_COUNTRY_CODE) {
    throw stripeError('Stripe merchant country is not configured.', 'STRIPE_MERCHANT_COUNTRY_MISSING', 503);
  }
};

const stripeCustomerPath = () => `stripeCustomers.${STRIPE_MODE}`;

const retrieveUsableCustomer = async (customerId) => {
  if (!customerId) return null;
  try {
    const customer = await stripe.customers.retrieve(customerId);
    return customer?.deleted ? null : customer;
  } catch (error) {
    if (error?.code === 'resource_missing') return null;
    throw error;
  }
};

const customerBelongsToUser = (customer, userId) => {
  const owner = String(customer?.metadata?.rozareUserId || customer?.metadata?.userId || '');
  return !owner || owner === String(userId);
};

const updateCustomerIdentity = async (customer, user) => {
  if (!customerBelongsToUser(customer, user._id)) return null;
  const metadata = {
    ...(customer.metadata || {}),
    rozareUserId: String(user._id),
    customerScope: 'rozare_buyer_commerce',
    stripeMode: STRIPE_MODE,
  };
  const name = user.username || user.email;
  if (
    customer.email !== user.email
    || customer.name !== name
    || customer.metadata?.rozareUserId !== String(user._id)
    || customer.metadata?.customerScope !== 'rozare_buyer_commerce'
    || customer.metadata?.stripeMode !== STRIPE_MODE
  ) {
    return stripe.customers.update(customer.id, { email: user.email, name, metadata });
  }
  return customer;
};

const findAdoptableSubscriptionCustomer = async (userId) => {
  const subscription = await SellerSubscription.findOne({ seller: userId })
    .select('stripeCustomerId stripeSubscriptionId status')
    .lean();
  if (!subscription?.stripeCustomerId) return null;
  const customer = await retrieveUsableCustomer(subscription.stripeCustomerId);
  if (!customer || !customerBelongsToUser(customer, userId)) return null;
  return { customer, subscription };
};

const persistCustomerId = async ({ userId, customerId, expectedCurrent }) => {
  const path = stripeCustomerPath();
  const query = { _id: userId };
  if (expectedCurrent) query[path] = expectedCurrent;
  else query.$or = [{ [path]: { $exists: false } }, { [path]: null }, { [path]: '' }];

  const updated = await User.findOneAndUpdate(
    query,
    { $set: { [path]: customerId } },
    { new: true },
  ).select(`+${path}`);
  if (updated) return customerId;

  const current = await User.findById(userId).select(`+${path}`).lean();
  return current?.stripeCustomers?.[STRIPE_MODE] || null;
};

/**
 * Returns the mode-scoped Customer for buyer commerce. When a seller already
 * has a usable subscription Customer and no unified Customer yet, it is
 * adopted so saved cards and recurring billing remain on one Customer.
 */
const ensureStripeCustomerForUser = async (
  userId,
  { requireActiveUser = true, preferredCustomerId = null } = {},
) => {
  assertStripeServerConfigured();
  const path = stripeCustomerPath();
  const user = await User.findById(userId)
    .select(`username email status role +${path}`);
  if (!user) throw stripeError('User not found.', 'USER_NOT_FOUND', 404);
  if (requireActiveUser && user.status !== 'active') {
    throw stripeError('This account cannot start a payment.', 'ACCOUNT_BLOCKED', 403);
  }

  const storedId = user.stripeCustomers?.[STRIPE_MODE];
  if (preferredCustomerId) {
    const preferred = await retrieveUsableCustomer(preferredCustomerId);
    const updatedPreferred = preferred && await updateCustomerIdentity(preferred, user);
    if (updatedPreferred) {
      if (storedId !== updatedPreferred.id) {
        await User.updateOne(
          { _id: user._id },
          { $set: { [path]: updatedPreferred.id } },
        );
      }
      return { customer: updatedPreferred, user, adoptedPreferredCustomer: true };
    }
  }
  if (storedId) {
    const stored = await retrieveUsableCustomer(storedId);
    const updated = stored && await updateCustomerIdentity(stored, user);
    if (updated) return { customer: updated, user };
  }

  const adoptable = await findAdoptableSubscriptionCustomer(user._id);
  if (adoptable) {
    const adopted = await updateCustomerIdentity(adoptable.customer, user);
    if (adopted) {
      const persistedId = await persistCustomerId({
        userId: user._id,
        customerId: adopted.id,
        expectedCurrent: storedId,
      });
      const winner = persistedId === adopted.id ? adopted : await retrieveUsableCustomer(persistedId);
      if (winner) return { customer: winner, user, adoptedSubscriptionCustomer: true };
    }
  }

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.username || user.email,
    metadata: {
      rozareUserId: String(user._id),
      customerScope: 'rozare_buyer_commerce',
      stripeMode: STRIPE_MODE,
    },
  }, {
    idempotencyKey: storedId
      ? `rozare-customer-replacement:${STRIPE_MODE}:${user._id}:${storedId}`
      : `rozare-customer:${STRIPE_MODE}:${user._id}`,
  });

  const persistedId = await persistCustomerId({
    userId: user._id,
    customerId: customer.id,
    expectedCurrent: storedId,
  });
  if (persistedId === customer.id) return { customer, user };

  const winner = await retrieveUsableCustomer(persistedId);
  if (!winner || !customerBelongsToUser(winner, user._id)) {
    throw stripeError('Could not establish a secure Stripe customer.', 'STRIPE_CUSTOMER_CONFLICT', 409);
  }
  await stripe.customers.del(customer.id).catch(() => {});
  return { customer: winner, user };
};

const createMobileCustomerSession = async (customerId) => {
  assertStripeMobileConfigured();
  return stripe.customerSessions.create({
    customer: customerId,
    components: {
      mobile_payment_element: {
        enabled: true,
        features: {
          payment_method_save: 'enabled',
          payment_method_redisplay: 'enabled',
          // Removal must pass through Rozare's authenticated DELETE endpoint so
          // active seller-subscription billing cards cannot be detached.
          payment_method_remove: 'disabled',
          payment_method_allow_redisplay_filters: PAYMENT_METHOD_FILTERS,
        },
      },
    },
  });
};

const createMobileEphemeralKey = async (customerId) => {
  assertStripeMobileConfigured();
  return stripe.ephemeralKeys.create(
    { customer: customerId },
    { apiVersion: STRIPE_API_VERSION },
  );
};

const createMobileCustomerAccess = async (customerId) => {
  assertStripeMobileConfigured();

  if (STRIPE_CUSTOMER_SESSION_ENABLED) {
    try {
      const customerSession = await createMobileCustomerSession(customerId);
      return {
        customerAccessMode: 'customer_session',
        customerSessionClientSecret: customerSession.client_secret,
      };
    } catch (error) {
      console.error('[stripe-mobile] CustomerSession failed; using ephemeral key fallback:', {
        code: error.code,
        type: error.type,
        statusCode: error.statusCode,
        message: error.message,
      });
    }
  }

  const ephemeralKey = await createMobileEphemeralKey(customerId);
  return {
    customerAccessMode: 'ephemeral_key',
    customerEphemeralKeySecret: ephemeralKey.secret,
  };
};

const finalizeSavedPaymentMethodSetup = async (setupIntent) => {
  assertStripeServerConfigured();
  if (setupIntent?.status !== 'succeeded') return null;
  const metadata = setupIntent.metadata || {};
  if (
    metadata.type !== 'saved_payment_method_setup'
    || metadata.consent !== 'customer_initiated_on_session'
    || metadata.consentAccepted !== 'true'
    || metadata.consentVersion !== SAVED_CARD_CONSENT_VERSION
    || metadata.stripeMode !== STRIPE_MODE
    || !metadata.userId
  ) {
    throw stripeError('Saved-card SetupIntent metadata is invalid.', 'SETUP_INTENT_METADATA_INVALID');
  }
  if (
    typeof setupIntent.livemode === 'boolean'
    && setupIntent.livemode !== (STRIPE_MODE === 'live')
  ) {
    throw stripeError('Saved-card SetupIntent mode is invalid.', 'SETUP_INTENT_MODE_MISMATCH');
  }

  const customerId = typeof setupIntent.customer === 'string'
    ? setupIntent.customer
    : setupIntent.customer?.id;
  const paymentMethodId = typeof setupIntent.payment_method === 'string'
    ? setupIntent.payment_method
    : setupIntent.payment_method?.id;
  if (!customerId || !paymentMethodId) {
    throw stripeError('Saved-card SetupIntent is incomplete.', 'SETUP_INTENT_INCOMPLETE');
  }

  const { customer } = await ensureStripeCustomerForUser(metadata.userId, {
    requireActiveUser: false,
  });
  if (customer.id !== customerId) {
    throw stripeError('Saved-card SetupIntent customer is invalid.', 'SETUP_INTENT_CUSTOMER_MISMATCH');
  }
  const paymentMethod = await verifyPaymentMethodOwnership(paymentMethodId, customer.id);
  if (paymentMethod.allow_redisplay === 'always') return paymentMethod;

  // This promotion is intentionally limited to Rozare-created SetupIntents
  // carrying the exact versioned opt-in contract validated above. It never
  // broadens consent for legacy or externally-created payment methods.
  return stripe.paymentMethods.update(paymentMethod.id, {
    allow_redisplay: 'always',
    metadata: {
      rozareSavedCardConsent: 'true',
      rozareSavedCardConsentVersion: SAVED_CARD_CONSENT_VERSION,
      rozareSavedCardSetupIntentId: String(setupIntent.id || ''),
    },
  });
};

const getStripeMobileConfig = () => {
  assertStripeMobileConfigured();
  return {
    publishableKey: STRIPE_PUBLISHABLE_KEY,
    merchantDisplayName: STRIPE_MERCHANT_DISPLAY_NAME,
    merchantCountryCode: STRIPE_MERCHANT_COUNTRY_CODE,
    googlePayEnabled: STRIPE_GOOGLE_PAY_ENABLED,
    customerSessionEnabled: STRIPE_CUSTOMER_SESSION_ENABLED,
    stripeMode: STRIPE_MODE,
  };
};

const sanitizePaymentMethod = (paymentMethod, defaultPaymentMethodId = null) => ({
  id: paymentMethod.id,
  type: paymentMethod.type,
  card: paymentMethod.card ? {
    brand: paymentMethod.card.brand,
    displayBrand: paymentMethod.card.display_brand || paymentMethod.card.brand,
    last4: paymentMethod.card.last4,
    expMonth: paymentMethod.card.exp_month,
    expYear: paymentMethod.card.exp_year,
    funding: paymentMethod.card.funding,
    country: paymentMethod.card.country || null,
    walletType: paymentMethod.card.wallet?.type || null,
  } : null,
  billingName: paymentMethod.billing_details?.name || '',
  allowRedisplay: paymentMethod.allow_redisplay || 'unspecified',
  isDefault: paymentMethod.id === defaultPaymentMethodId,
  createdAt: paymentMethod.created ? new Date(paymentMethod.created * 1000) : null,
});

const verifyPaymentMethodOwnership = async (paymentMethodId, customerId) => {
  if (!/^pm_[A-Za-z0-9]+$/.test(String(paymentMethodId || ''))) {
    throw stripeError('Invalid payment method.', 'PAYMENT_METHOD_INVALID', 400);
  }
  let paymentMethod;
  try {
    paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
  } catch (error) {
    if (error?.code === 'resource_missing') {
      throw stripeError('Payment method not found.', 'PAYMENT_METHOD_NOT_FOUND', 404);
    }
    throw error;
  }
  const owner = typeof paymentMethod.customer === 'string'
    ? paymentMethod.customer
    : paymentMethod.customer?.id;
  if (owner !== customerId) {
    // Deliberately return 404 so IDs cannot be probed across users.
    throw stripeError('Payment method not found.', 'PAYMENT_METHOD_NOT_FOUND', 404);
  }
  return paymentMethod;
};

module.exports = {
  PAYMENT_METHOD_FILTERS,
  SAVED_CARD_CONSENT_VERSION,
  selectRedisplayableReplacement,
  stripeError,
  assertStripeServerConfigured,
  assertStripeMobileConfigured,
  ensureStripeCustomerForUser,
  createMobileCustomerSession,
  createMobileEphemeralKey,
  createMobileCustomerAccess,
  getStripeMobileConfig,
  sanitizePaymentMethod,
  verifyPaymentMethodOwnership,
  finalizeSavedPaymentMethodSetup,
};
