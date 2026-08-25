'use strict';

const crypto = require('crypto');
const Store = require('../models/Store');
const SellerSubscription = require('../models/SellerSubscription');
const SellerCheckoutClaim = require('../models/SellerCheckoutClaim');
const StripeEntitlementPayment = require('../models/StripeEntitlementPayment');
const { stripe } = require('../config/stripe');
const { PLAN_PRICING, buildPlanPricing } = require('./subscriptionPricingService');
const {
  enqueueSubdomainPaymentNotification,
  enqueueSubscriptionPaymentNotification,
} = require('./financialNotificationOutboxService');
const {
  ensureStripeEntitlementRiskNotificationsOutboxed,
} = require('./stripeEntitlementRiskNotificationService');
const {
  recordStripePaymentRiskManualReview,
} = require('./stripePaymentRiskNotificationService');
const { addUtcCalendarYears } = require('./utcCalendarService');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_MONTHLY_SUBSCRIPTION_PERIOD_MS = 32 * DAY_MS;
// Retained only to reconstruct the fixed-1095-day grants written by the legacy
// implementation. New purchases use three true UTC calendar years below.
const LEGACY_SUBDOMAIN_GRANT_MS = 3 * 365 * DAY_MS;
const SUBDOMAIN_REMOVAL_GRACE_MS = 7 * DAY_MS;
const SUBDOMAIN_PRICE_MINOR = 1500;
const FUNDED_PLAN_SYNC_LEASE_MS = 10 * 60 * 1000;
const FINANCIAL_DISPUTE_STATUSES = new Set([
  'needs_response',
  'under_review',
  'lost',
]);
const INQUIRY_DISPUTE_STATUSES = new Set([
  'warning_needs_response',
  'warning_under_review',
  'warning_closed',
]);
const ACTIVE_STRIPE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);
const SUBSCRIPTION_BILLING_REASONS = new Set([
  'subscription',
  'subscription_create',
  'subscription_cycle',
  'subscription_threshold',
  'subscription_update',
]);
// These were real production prices before the current pricing catalog. They
// remain permitted only when a signed Stripe subscription invoice is otherwise
// bound to the exact local customer/subscription/plan.
const LEGACY_PLAN_UNIT_AMOUNTS = Object.freeze({
  starter: Object.freeze([500, 599]),
  elite: Object.freeze([1299, 1699]),
});
const MAX_INVOICE_PAYMENT_PAGES = 100;

const stringId = value => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value?.id === 'string') return value.id.trim();
  if (typeof value?._id === 'string') return value._id.trim();
  if (value?._id?.toString) return value._id.toString().trim();
  if (value?.toString) return value.toString().trim();
  return String(value).trim();
};

const retrieveStripeSubscriptionIfPresent = async stripeSubscriptionId => {
  if (!stripeSubscriptionId || !stripe?.subscriptions?.retrieve) return null;
  try {
    return await stripe.subscriptions.retrieve(stripeSubscriptionId);
  } catch (error) {
    if (error?.code === 'resource_missing' || Number(error?.statusCode) === 404) return null;
    throw error;
  }
};

const safeMinor = (value, fallback = null) => {
  if (value === null || value === undefined) {
    if (fallback !== null) return fallback;
  } else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  const error = new Error('Stripe entitlement amount must be a non-negative safe integer.');
  error.code = 'STRIPE_ENTITLEMENT_AMOUNT_INVALID';
  error.statusCode = 400;
  throw error;
};

const stripeSecondsDate = value => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  const milliseconds = value * 1000;
  if (!Number.isSafeInteger(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date : null;
};

const durationMs = payment => Math.max(
  0,
  new Date(payment.grantEnd).getTime() - new Date(payment.grantStart).getTime(),
);

const chargeTracksOf = payment => (
  Array.isArray(payment?.chargeTracks) ? payment.chargeTracks : []
);

const capturedMinorOf = payment => {
  const tracks = chargeTracksOf(payment);
  if (!tracks.length) return safeMinor(payment.capturedMinor, 0);
  return tracks.reduce((sum, track) => {
    const amount = safeMinor(track.capturedMinor, 0);
    if (amount > Number.MAX_SAFE_INTEGER - sum) {
      const error = new Error('Stripe Invoice Payment allocations exceed the safe integer range.');
      error.code = 'STRIPE_ENTITLEMENT_AMOUNT_INVALID';
      error.statusCode = 400;
      throw error;
    }
    return sum + amount;
  }, 0);
};

const refundedMinorOf = payment => {
  const tracks = chargeTracksOf(payment);
  if (!tracks.length) {
    return Math.min(capturedMinorOf(payment), safeMinor(payment.refundedMinor, 0));
  }
  return tracks.reduce((sum, track) => (
    sum + Math.min(safeMinor(track.capturedMinor, 0), safeMinor(track.refundedMinor, 0))
  ), 0);
};

const syncPaymentTrackAggregates = payment => {
  const tracks = chargeTracksOf(payment);
  if (!tracks.length) return payment;
  payment.capturedMinor = capturedMinorOf(payment);
  payment.refundedMinor = refundedMinorOf(payment);
  const intentIds = tracks.map(track => stringId(track.paymentIntentId)).filter(Boolean);
  const chargeIds = tracks.map(track => stringId(track.chargeId)).filter(Boolean);
  if (!payment.paymentIntentId && intentIds.length === 1) payment.paymentIntentId = intentIds[0];
  payment.chargeIds = [...new Set([
    ...(Array.isArray(payment.chargeIds) ? payment.chargeIds.map(stringId) : []),
    ...chargeIds,
  ].filter(Boolean))];
  return payment;
};

const exposureMinor = payment => {
  const captured = capturedMinorOf(payment);
  if (captured === 0 || payment.nonReversibleLegacyBaseline) return 0;
  const disputes = Array.isArray(payment.disputes) ? payment.disputes : [];
  const paymentTracks = chargeTracksOf(payment);
  if (paymentTracks.length) {
    const chargeGroups = new Map();
    for (const chargeTrack of paymentTracks) {
      const trackCaptured = safeMinor(chargeTrack.capturedMinor, 0);
      const chargeId = stringId(chargeTrack.chargeId);
      const groupKey = chargeId
        ? `charge:${chargeId}`
        : `invoice_payment:${stringId(chargeTrack.invoicePaymentId)}`;
      const group = chargeGroups.get(groupKey) || {
        chargeId,
        capturedMinor: 0,
        refundedMinor: 0,
        lostMinor: 0,
      };
      group.capturedMinor = Math.min(captured, group.capturedMinor + trackCaptured);
      group.refundedMinor = Math.min(
        group.capturedMinor,
        group.refundedMinor + Math.min(trackCaptured, safeMinor(chargeTrack.refundedMinor, 0)),
      );
      chargeGroups.set(groupKey, group);
    }

    let unboundLost = 0;
    for (const dispute of disputes) {
      if (dispute.state !== 'lost') continue;
      const amount = safeMinor(dispute.amountMinor, 0);
      const chargeId = stringId(dispute.chargeId);
      const group = chargeId ? chargeGroups.get(`charge:${chargeId}`) : null;
      if (group) {
        group.lostMinor = Math.min(group.capturedMinor, group.lostMinor + amount);
      } else {
        // Rows written before Charge identity was persisted, and defensive
        // unknown-Charge rows, consume the invoice contribution once rather
        // than once per Invoice Payment association.
        unboundLost = Math.min(captured, unboundLost + amount);
      }
    }

    let invalidated = 0;
    for (const group of chargeGroups.values()) {
      invalidated = Math.min(
        captured,
        invalidated + Math.min(
          group.capturedMinor,
          group.refundedMinor + group.lostMinor,
        ),
      );
    }
    // Backward compatibility for dispute rows written before charge identity
    // was persisted. Allocate their loss once against the remaining invoice
    // value instead of multiplying it across every Invoice Payment.
    return Math.min(captured, invalidated + unboundLost);
  }

  const refund = Math.min(captured, safeMinor(payment.refundedMinor, 0));
  const lostDispute = disputes.length
    ? disputes.reduce((sum, dispute) => {
      if (sum >= captured || dispute.state !== 'lost') return sum;
      const amount = Math.min(captured, safeMinor(dispute.amountMinor, 0));
      return amount >= captured - sum ? captured : sum + amount;
    }, 0)
    : payment.disputeState === 'lost'
      ? Math.min(captured, safeMinor(payment.disputeAmountMinor, 0))
      : 0;
  // Refunds and lost disputes are independent Stripe balance exposures. A
  // partially-refunded Charge can still be disputed, so add both tracks and
  // cap only at the amount that originally funded this entitlement.
  return lostDispute >= captured - refund
    ? captured
    : refund + lostDispute;
};

const effectiveDurationMs = payment => {
  const original = durationMs(payment);
  if (original === 0) return 0;
  const captured = capturedMinorOf(payment);
  if (payment.nonReversibleLegacyBaseline || captured === 0) return original;
  const validMinor = Math.max(0, captured - exposureMinor(payment));
  return Number((BigInt(original) * BigInt(validMinor)) / BigInt(captured));
};

const invoiceSubscriptionId = invoice => stringId(
  invoice?.subscription
  || invoice?.parent?.subscription_details?.subscription
  || invoice?.subscription_details?.subscription,
);

const invoiceSellerId = invoice => stringId(
  invoice?.subscription_details?.metadata?.sellerId
  || invoice?.parent?.subscription_details?.metadata?.sellerId
  || (typeof invoice?.subscription === 'object' ? invoice.subscription?.metadata?.sellerId : ''),
);

const invoiceSubscriptionMetadata = invoice => (
  invoice?.parent?.subscription_details?.metadata
  || invoice?.subscription_details?.metadata
  || (typeof invoice?.subscription === 'object' ? invoice.subscription?.metadata : null)
  || {}
);

const subscriptionBindingIsPending = async ({ candidate, invoice, stripeSubscriptionId }) => {
  if (!candidate) return false;
  const metadata = invoiceSubscriptionMetadata(invoice);
  const checkoutClaimToken = stringId(metadata.checkoutClaimToken);
  if (checkoutClaimToken) {
    const pendingCheckout = await SellerCheckoutClaim.exists({
      seller: candidate.seller,
      flow: 'subscription',
      token: checkoutClaimToken,
      expiresAt: { $gt: new Date() },
    });
    if (pendingCheckout) return true;
  }

  const transitionFromSubscriptionId = stringId(metadata.transitionFromSubscriptionId);
  return Boolean(
    transitionFromSubscriptionId
    && transitionFromSubscriptionId === stringId(candidate.stripeSubscriptionId)
    && stripeSubscriptionId !== transitionFromSubscriptionId
    && candidate.pendingDowngrade?.toPlan === 'starter'
    && candidate.pendingDowngrade?.processingToken
  );
};

const resolveInvoiceSubscription = async invoice => {
  const stripeSubscriptionId = invoiceSubscriptionId(invoice);
  const invoiceId = stringId(invoice?.id);
  const sellerId = invoiceSellerId(invoice);
  const findCandidate = async () => {
    if (sellerId) {
      const bySeller = await SellerSubscription.findOne({ seller: sellerId });
      if (bySeller) return bySeller;
    }
    const customerId = stringId(invoice?.customer);
    return customerId
      ? SellerSubscription.findOne({ stripeCustomerId: customerId })
      : null;
  };

  if (!invoiceId) {
    const exact = stripeSubscriptionId
      ? await SellerSubscription.findOne({ stripeSubscriptionId })
      : null;
    const candidate = exact || await findCandidate();
    if (candidate) {
      throw entitlementError(
        'Stripe returned a locally-owned invoice association without an invoice ID.',
        'STRIPE_SUBSCRIPTION_ASSOCIATION_UNRESOLVED',
        503,
      );
    }
    return { handled: false, reason: 'not_subscription_invoice', stripeSubscriptionId, invoiceId };
  }

  if (!stripeSubscriptionId) {
    const candidate = await findCandidate();
    if (candidate) {
      throw entitlementError(
        'Stripe returned a locally-owned invoice without its subscription identity.',
        'STRIPE_SUBSCRIPTION_ASSOCIATION_UNRESOLVED',
        503,
      );
    }
    return { handled: false, reason: 'not_subscription_invoice', stripeSubscriptionId, invoiceId };
  }

  const subscription = await SellerSubscription.findOne({ stripeSubscriptionId });
  if (subscription) return { handled: true, subscription, stripeSubscriptionId, invoiceId };

  const candidate = await findCandidate();
  if (await subscriptionBindingIsPending({ candidate, invoice, stripeSubscriptionId })) {
    const error = new Error('Stripe subscription ownership has not been bound locally yet.');
    error.code = 'STRIPE_SUBSCRIPTION_BINDING_PENDING';
    error.statusCode = 503;
    throw error;
  }
  return {
    handled: false,
    stale: true,
    reason: 'subscription_not_current',
    stripeSubscriptionId,
    invoiceId,
  };
};

const invoicePaymentIntentId = invoice => {
  const direct = stringId(invoice?.payment_intent);
  if (direct) return direct;
  const payments = Array.isArray(invoice?.payments?.data) ? invoice.payments.data : [];
  for (const entry of payments) {
    const candidate = stringId(
      entry?.payment?.payment_intent
      || entry?.payment_intent
      || entry?.payment?.paymentIntent,
    );
    if (candidate) return candidate;
  }
  return '';
};

const invoiceChargeId = invoice => {
  const direct = stringId(invoice?.charge);
  if (direct) return direct;
  const payments = Array.isArray(invoice?.payments?.data) ? invoice.payments.data : [];
  for (const entry of payments) {
    const candidate = stringId(entry?.payment?.charge || entry?.charge);
    if (candidate) return candidate;
  }
  return '';
};

const entitlementError = (message, code, statusCode = 400) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const listAllInvoicePayments = async params => {
  if (!stripe?.invoicePayments?.list) {
    throw entitlementError(
      'Stripe Invoice Payment lookup is unavailable; payment ownership cannot be verified.',
      'STRIPE_INVOICE_PAYMENT_LOOKUP_UNAVAILABLE',
      503,
    );
  }
  const rows = [];
  const seen = new Set();
  let startingAfter;
  for (let pageNumber = 0; pageNumber < MAX_INVOICE_PAYMENT_PAGES; pageNumber += 1) {
    const page = await stripe.invoicePayments.list({
      ...params,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const data = Array.isArray(page?.data) ? page.data : [];
    for (const row of data) {
      const rowId = stringId(row?.id);
      if (!rowId) {
        throw entitlementError(
          'Stripe returned an Invoice Payment without an ID.',
          'STRIPE_INVOICE_PAYMENT_ASSOCIATION_INVALID',
          503,
        );
      }
      if (!seen.has(rowId)) {
        seen.add(rowId);
        rows.push(row);
      }
    }
    if (!page?.has_more) return rows;
    const cursor = stringId(data[data.length - 1]?.id);
    if (!cursor || cursor === startingAfter) {
      throw entitlementError(
        'Stripe Invoice Payment pagination did not make progress.',
        'STRIPE_INVOICE_PAYMENT_ASSOCIATION_INVALID',
        503,
      );
    }
    startingAfter = cursor;
  }
  throw entitlementError(
    'Stripe returned too many Invoice Payment pages to verify safely.',
    'STRIPE_INVOICE_PAYMENT_ASSOCIATION_INVALID',
    503,
  );
};

const loadCompleteInvoiceLines = async invoice => {
  if (invoice?.lines?.has_more !== true) return invoice;
  const invoiceId = stringId(invoice?.id);
  if (!invoiceId || !stripe?.invoices?.listLineItems) {
    throw entitlementError(
      'Stripe invoice line lookup is unavailable; the price snapshot cannot be verified.',
      'STRIPE_SUBSCRIPTION_PRICE_SNAPSHOT_INCOMPLETE',
      503,
    );
  }

  const rows = [];
  const seen = new Set();
  let startingAfter;
  for (let pageNumber = 0; pageNumber < MAX_INVOICE_PAYMENT_PAGES; pageNumber += 1) {
    const page = await stripe.invoices.listLineItems(invoiceId, {
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const data = Array.isArray(page?.data) ? page.data : [];
    for (const row of data) {
      const rowId = stringId(row?.id);
      if (!rowId) {
        throw entitlementError(
          'Stripe returned an invoice line without an ID.',
          'STRIPE_SUBSCRIPTION_PRICE_SNAPSHOT_INCOMPLETE',
          503,
        );
      }
      if (!seen.has(rowId)) {
        seen.add(rowId);
        rows.push(row);
      }
    }
    if (!page?.has_more) {
      return {
        ...invoice,
        lines: { ...invoice.lines, data: rows, has_more: false },
      };
    }
    const cursor = stringId(data[data.length - 1]?.id);
    if (!cursor || cursor === startingAfter) {
      throw entitlementError(
        'Stripe invoice line pagination did not make progress.',
        'STRIPE_SUBSCRIPTION_PRICE_SNAPSHOT_INCOMPLETE',
        503,
      );
    }
    startingAfter = cursor;
  }
  throw entitlementError(
    'Stripe returned too many invoice line pages to verify safely.',
    'STRIPE_SUBSCRIPTION_PRICE_SNAPSHOT_INCOMPLETE',
    503,
  );
};

const invoicePaymentObjectId = row => stringId(
  row?.payment?.payment_intent
  || row?.payment_intent
  || row?.payment?.charge
  || row?.charge
  || row?.payment?.payment_record
  || row?.payment_record,
);

const normalizeInvoicePaymentTracks = ({ invoice, rows, incomingCharge = null }) => {
  const invoiceId = stringId(invoice?.id);
  const invoiceCurrency = String(invoice?.currency || '').trim().toLowerCase();
  const tracks = [];
  const seen = new Map();
  for (const row of rows) {
    if (String(row?.status || '').toLowerCase() !== 'paid') continue;
    const rowId = stringId(row?.id);
    const rowInvoiceId = stringId(row?.invoice);
    const currency = String(row?.currency || '').trim().toLowerCase();
    const capturedMinor = safeMinor(row?.amount_paid);
    const paymentType = String(row?.payment?.type || (
      row?.payment?.payment_intent || row?.payment_intent
        ? 'payment_intent'
        : row?.payment?.charge || row?.charge
          ? 'charge'
          : row?.payment?.payment_record || row?.payment_record
            ? 'payment_record'
            : ''
    )).trim();
    const paymentIntentId = stringId(row?.payment?.payment_intent || row?.payment_intent);
    const paymentRecordId = stringId(row?.payment?.payment_record || row?.payment_record);
    let chargeId = stringId(row?.payment?.charge || row?.charge);
    if (
      incomingCharge
      && paymentIntentId
      && paymentIntentId === stringId(incomingCharge.payment_intent)
    ) chargeId = stringId(incomingCharge.id);

    if (
      !rowId
      || rowInvoiceId !== invoiceId
      || currency !== invoiceCurrency
      || capturedMinor <= 0
      || !['payment_intent', 'charge', 'payment_record'].includes(paymentType)
      || !invoicePaymentObjectId(row)
    ) {
      throw entitlementError(
        'Stripe Invoice Payment details do not match the paid invoice.',
        'STRIPE_INVOICE_PAYMENT_ASSOCIATION_INVALID',
      );
    }
    const normalized = {
      invoicePaymentId: rowId,
      paymentType,
      paymentIntentId,
      paymentRecordId,
      chargeId,
      capturedMinor,
      refundedMinor: 0,
      currency,
      paidAt: stripeSecondsDate(row?.status_transitions?.paid_at || row?.created),
    };
    const prior = seen.get(rowId);
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(normalized)) {
        throw entitlementError(
          'Stripe returned conflicting copies of one Invoice Payment.',
          'STRIPE_INVOICE_PAYMENT_ASSOCIATION_INVALID',
          503,
        );
      }
      continue;
    }
    seen.set(rowId, normalized);
    tracks.push(normalized);
  }
  return tracks;
};

const legacyInvoicePaymentTrack = (invoice, incomingCharge = null) => {
  const invoiceId = stringId(invoice?.id);
  const paymentIntentId = stringId(invoice?.payment_intent || incomingCharge?.payment_intent);
  const chargeId = stringId(invoice?.charge || incomingCharge?.id);
  if (!paymentIntentId && !chargeId) return null;
  return {
    invoicePaymentId: `legacy:${invoiceId}:${paymentIntentId || chargeId}`,
    paymentType: 'legacy',
    paymentIntentId,
    paymentRecordId: '',
    chargeId,
    capturedMinor: safeMinor(invoice?.amount_paid),
    refundedMinor: 0,
    currency: String(invoice?.currency || '').trim().toLowerCase(),
    paidAt: stripeSecondsDate(invoice?.status_transitions?.paid_at),
  };
};

const loadInvoicePaymentTracks = async ({ invoice, incomingCharge = null, knownRows = null }) => {
  let rows = Array.isArray(knownRows) ? knownRows : null;
  let authoritativeRows = Array.isArray(knownRows);
  if (!rows) {
    const embedded = invoice?.payments;
    if (Array.isArray(embedded?.data) && embedded?.has_more !== true) {
      rows = embedded.data;
      authoritativeRows = true;
    } else if (stripe?.invoicePayments?.list) {
      rows = await listAllInvoicePayments({ invoice: stringId(invoice?.id), status: 'paid' });
      authoritativeRows = true;
    }
  }
  const tracks = rows
    ? normalizeInvoicePaymentTracks({ invoice, rows, incomingCharge })
    : [];
  if (!tracks.length && !authoritativeRows) {
    const legacy = legacyInvoicePaymentTrack(invoice, incomingCharge);
    if (legacy) tracks.push(legacy);
  }
  if (!tracks.length) {
    throw entitlementError(
      'The paid subscription invoice has no verifiable payment association.',
      'STRIPE_SUBSCRIPTION_PAYMENT_ASSOCIATION_UNRESOLVED',
      503,
    );
  }
  const captured = tracks.reduce((sum, track) => {
    if (track.capturedMinor > Number.MAX_SAFE_INTEGER - sum) {
      throw entitlementError(
        'Stripe Invoice Payment allocations exceed the safe integer range.',
        'STRIPE_ENTITLEMENT_AMOUNT_INVALID',
      );
    }
    return sum + track.capturedMinor;
  }, 0);
  if (captured !== safeMinor(invoice?.amount_paid)) {
    throw entitlementError(
      'Stripe Invoice Payment allocations do not add up to the settled invoice amount.',
      'STRIPE_INVOICE_PAYMENT_TOTAL_MISMATCH',
    );
  }
  return tracks;
};

const decimalMinor = value => {
  const text = String(value ?? '').trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match || (match[2] && /[1-9]/.test(match[2]))) return null;
  const amount = Number(match[1]);
  return Number.isSafeInteger(amount) ? amount : null;
};

const lineSubscriptionId = line => stringId(
  line?.parent?.subscription_item_details?.subscription
  || line?.parent?.invoice_item_details?.subscription
  || line?.subscription,
);

const lineSubscriptionItemId = line => stringId(
  line?.parent?.subscription_item_details?.subscription_item
  || line?.subscription_item,
);

const lineIsProration = line => Boolean(
  line?.proration
  || line?.parent?.subscription_item_details?.proration
  || line?.parent?.invoice_item_details?.proration,
);

const linePriceSnapshot = line => ({
  priceId: stringId(line?.pricing?.price_details?.price || line?.price),
  productId: stringId(
    line?.pricing?.price_details?.product
    || line?.price?.product,
  ),
  unitAmountMinor: decimalMinor(
    line?.pricing?.unit_amount_decimal
    ?? line?.price?.unit_amount_decimal
    ?? line?.price?.unit_amount,
  ),
});

const historicalCreditUnitAmounts = () => {
  const amounts = new Set();
  for (const plan of Object.keys(PLAN_PRICING)) {
    if (!PLAN_PRICING[plan]) continue;
    const metaOptions = plan === 'elite' ? [false, true] : [false];
    for (const includeMeta of metaOptions) {
      amounts.add(buildPlanPricing(plan, includeMeta, false).unitAmount);
      amounts.add(buildPlanPricing(plan, includeMeta, true).unitAmount);
    }
    for (const legacy of LEGACY_PLAN_UNIT_AMOUNTS[plan] || []) amounts.add(legacy);
  }
  return amounts;
};

const inferHistoricalPlanFromUnitAmounts = amountsInput => {
  const amounts = new Set([...amountsInput].filter(Number.isSafeInteger));
  if (!amounts.size) return null;
  const candidates = Object.keys(PLAN_PRICING).filter(plan => {
    const permitted = new Set();
    const metaOptions = plan === 'elite' ? [false, true] : [false];
    for (const includeMeta of metaOptions) {
      permitted.add(buildPlanPricing(plan, includeMeta, false).unitAmount);
      permitted.add(buildPlanPricing(plan, includeMeta, true).unitAmount);
    }
    for (const legacy of LEGACY_PLAN_UNIT_AMOUNTS[plan] || []) permitted.add(legacy);
    return [...amounts].every(amount => permitted.has(amount));
  });
  if (candidates.length !== 1) return null;
  const plan = candidates[0];
  return {
    plan,
    // The base tier is inferable from immutable Stripe amounts. Meta Ads may
    // not be: some historical Elite base prices overlap newer add-on totals.
    planName: PLAN_PRICING[plan].planName,
    includeMetaAds: null,
  };
};

const currentPlanPriceAuthorization = subscription => {
  const plan = String(subscription?.plan || '').trim().toLowerCase();
  if (!PLAN_PRICING[plan]) {
    throw entitlementError(
      'The seller does not have a paid plan that can own this invoice.',
      'STRIPE_SUBSCRIPTION_PLAN_MISMATCH',
    );
  }
  const pricing = buildPlanPricing(
    plan,
    Boolean(subscription.metaAdsIncluded),
    Boolean(subscription.founderOffer?.active),
  );
  const lockedPriceId = stringId(subscription.stripePriceId);
  const lockedProductId = stringId(subscription.stripeProductId);
  const allowedUnitAmounts = new Set([pricing.unitAmount]);

  // A legacy rate is accepted only when the seller is explicitly marked as a
  // migrated legacy founder *and* the exact immutable Stripe Price has already
  // been bound locally. A broad catalog fallback would let a standard seller's
  // invoice pass at another cohort's discounted rate.
  if (
    lockedPriceId
    && subscription.founderOffer?.active
    && subscription.founderOffer?.source === 'legacy'
  ) {
    for (const legacy of LEGACY_PLAN_UNIT_AMOUNTS[plan] || []) {
      allowedUnitAmounts.add(legacy);
    }
  }

  return {
    plan,
    planName: subscription.planName || pricing.planName,
    includeMetaAds: Boolean(plan === 'elite' && subscription.metaAdsIncluded),
    unitAmountMinor: pricing.unitAmount,
    allowedUnitAmounts,
    lockedPriceId,
    lockedProductId,
  };
};

const normalizedStringSet = values => [...new Set(
  (Array.isArray(values) ? values : []).map(stringId).filter(Boolean),
)].sort();

const normalizedMinorSet = values => [...new Set(
  (Array.isArray(values) ? values : []).map(value => safeMinor(value)),
)].sort((left, right) => left - right);

const sameValues = (left, right) => (
  left.length === right.length && left.every((value, index) => value === right[index])
);

const authorizedPendingPlanChangeForInvoice = ({
  subscription,
  invoiceId,
  stripeSubscriptionId,
  billingReason,
}) => {
  const attempt = subscription?.planChangeAttempt || {};
  const targetAmount = attempt.targetUnitAmountMinor;
  const targetPriceId = stringId(attempt.stripePriceId);
  const targetProductId = stringId(attempt.stripeProductId);
  const targetSubscriptionItemId = stringId(attempt.stripeSubscriptionItemId);
  const expectedInvoiceId = stringId(attempt.stripeInvoiceId);
  const attemptToken = stringId(attempt.idempotencyToken);
  if (
    !['processing', 'pending_payment', 'recoverable'].includes(attempt.state)
    || billingReason !== 'subscription_update'
    || stringId(attempt.stripeSubscriptionId) !== stripeSubscriptionId
    || !expectedInvoiceId
    || expectedInvoiceId !== invoiceId
    || !attemptToken
    || attempt.targetPlan !== 'elite'
    || !targetPriceId
    || !targetProductId
    || !targetSubscriptionItemId
    || !Number.isSafeInteger(targetAmount)
    || targetAmount <= 0
  ) return null;
  return {
    plan: attempt.targetPlan,
    planName: attempt.targetPlanName || buildPlanPricing(
      attempt.targetPlan,
      Boolean(attempt.targetIncludeMetaAds),
      Boolean(subscription.founderOffer?.active),
    ).planName,
    includeMetaAds: Boolean(attempt.targetIncludeMetaAds),
    priceId: targetPriceId,
    productId: targetProductId,
    subscriptionItemId: targetSubscriptionItemId,
    unitAmountMinor: targetAmount,
    planChangeToken: attemptToken,
    predecessor: {
      plan: attempt.sourcePlan || subscription.plan,
      planName: attempt.sourcePlanName || subscription.planName,
      includeMetaAds: attempt.sourceIncludeMetaAds ?? Boolean(subscription.metaAdsIncluded),
      unitAmountMinor: Number.isSafeInteger(attempt.sourceUnitAmountMinor)
        && attempt.sourceUnitAmountMinor > 0
        ? attempt.sourceUnitAmountMinor
        : null,
      priceId: stringId(attempt.sourceStripePriceId || subscription.stripePriceId),
      productId: stringId(attempt.sourceStripeProductId),
      subscriptionItemId: targetSubscriptionItemId,
      bonusFeaturesActive: attempt.sourceBonusFeaturesActive
        ?? Boolean(subscription.bonusFeaturesActive),
      bonusExpiryDate: attempt.sourceBonusExpiryDate || subscription.bonusExpiryDate || null,
      bonusFeaturesExpiredPermanently: attempt.sourceBonusFeaturesExpiredPermanently
        ?? Boolean(subscription.bonusFeaturesExpiredPermanently),
      bonusGraceDeadline: attempt.sourceBonusGraceDeadline || subscription.bonusGraceDeadline || null,
    },
  };
};

const validatePaidSubscriptionInvoice = ({
  invoice,
  subscription,
  stripeSubscriptionId,
  existingPayment = null,
}) => {
  const invoiceId = stringId(invoice?.id);
  const amountPaid = safeMinor(invoice?.amount_paid);
  const amountRemaining = invoice?.amount_remaining === undefined
    ? 0
    : safeMinor(invoice.amount_remaining);
  const status = String(invoice?.status || '').trim().toLowerCase();
  const currency = String(invoice?.currency || '').trim().toLowerCase();
  const customerId = stringId(invoice?.customer);
  const billingReason = String(invoice?.billing_reason || '').trim();
  if (
    !invoiceId
    || status !== 'paid'
    || amountRemaining !== 0
    || currency !== 'usd'
  ) {
    throw entitlementError(
      'Subscription entitlement requires a fully settled paid USD invoice.',
      'STRIPE_SUBSCRIPTION_INVOICE_NOT_SETTLED',
    );
  }
  if (
    !customerId
    || customerId !== stringId(subscription.stripeCustomerId)
    || stripeSubscriptionId !== stringId(subscription.stripeSubscriptionId)
  ) {
    throw entitlementError(
      'Stripe invoice customer/subscription ownership does not match the seller.',
      'STRIPE_SUBSCRIPTION_INVOICE_OWNERSHIP_MISMATCH',
    );
  }
  if (!SUBSCRIPTION_BILLING_REASONS.has(billingReason)) {
    throw entitlementError(
      'Only Stripe-generated subscription billing invoices can grant paid access.',
      'STRIPE_SUBSCRIPTION_BILLING_REASON_INVALID',
    );
  }
  if (existingPayment && (
    amountPaid !== capturedMinorOf(existingPayment)
    || String(existingPayment.currency || '').trim().toLowerCase() !== currency
    || (
      existingPayment.billingReason
      && String(existingPayment.billingReason) !== billingReason
    )
  )) {
    throw entitlementError(
      'Stripe changed the immutable settlement snapshot of a recorded subscription invoice.',
      'STRIPE_SUBSCRIPTION_PRICE_SNAPSHOT_CHANGED',
    );
  }
  const replayUnitAmounts = existingPayment
    ? new Set([
      ...(Array.isArray(existingPayment.unitAmountMinorSnapshots)
        ? existingPayment.unitAmountMinorSnapshots
        : []),
      existingPayment.fundedUnitAmountMinor,
    ].filter(value => (
      value !== null
      && value !== undefined
      && value !== ''
      && Number.isSafeInteger(value)
      && value >= 0
    )))
    : null;
  const replayPlanInference = existingPayment
    ? inferHistoricalPlanFromUnitAmounts(replayUnitAmounts)
    : null;
  const metadata = invoiceSubscriptionMetadata(invoice);
  const pendingPlanChange = existingPayment ? null : authorizedPendingPlanChangeForInvoice({
    subscription,
    invoiceId,
    stripeSubscriptionId,
    billingReason,
  });
  const metadataSellerId = stringId(metadata?.sellerId);
  const metadataPlan = String(metadata?.plan || '').trim().toLowerCase();
  const permittedMetadataPlans = pendingPlanChange
    ? new Set([pendingPlanChange.plan, String(subscription.plan || '').trim().toLowerCase()])
    : new Set([
      String(subscription.plan || '').trim().toLowerCase(),
      String(existingPayment?.fundedPlan || '').trim().toLowerCase(),
      String(replayPlanInference?.plan || '').trim().toLowerCase(),
      String(existingPayment?.predecessorPlan || '').trim().toLowerCase(),
    ].filter(Boolean));
  if (
    (metadataSellerId && metadataSellerId !== stringId(subscription.seller))
    || (metadataPlan && !permittedMetadataPlans.has(metadataPlan))
  ) {
    throw entitlementError(
      'Stripe subscription metadata does not match the seller plan.',
      'STRIPE_SUBSCRIPTION_PLAN_MISMATCH',
    );
  }

  const lineList = invoice?.lines;
  if (lineList?.has_more === true) {
    throw entitlementError(
      'The subscription invoice has more price lines than were available for validation.',
      'STRIPE_SUBSCRIPTION_PRICE_SNAPSHOT_INCOMPLETE',
      503,
    );
  }
  const lines = Array.isArray(lineList?.data) ? lineList.data : [];
  const storedFundedPlan = String(existingPayment?.fundedPlan || '').trim().toLowerCase();
  const storedFundedDefinition = PLAN_PRICING[storedFundedPlan] || null;
  const currentAuthorization = pendingPlanChange
    ? null
    : existingPayment
      ? {
        plan: storedFundedPlan || replayPlanInference?.plan || null,
        planName: existingPayment.fundedPlanName
          || storedFundedDefinition?.planName
          || replayPlanInference?.planName
          || 'Rozare subscription',
        includeMetaAds: existingPayment.fundedMetaAdsIncluded
          ?? replayPlanInference?.includeMetaAds
          ?? null,
        unitAmountMinor: existingPayment.fundedUnitAmountMinor,
        allowedUnitAmounts: replayUnitAmounts.size
          ? replayUnitAmounts
          : historicalCreditUnitAmounts(),
        lockedPriceId: stringId(existingPayment.fundedStripePriceId),
        lockedProductId: stringId(existingPayment.fundedStripeProductId),
        lockedSubscriptionItemId: stringId(existingPayment.fundedSubscriptionItemId),
        replay: true,
      }
      : currentPlanPriceAuthorization(subscription);
  const currentAmounts = pendingPlanChange
    ? new Set([pendingPlanChange.unitAmountMinor])
    : currentAuthorization.allowedUnitAmounts;
  const allAmounts = existingPayment && replayUnitAmounts.size
    ? replayUnitAmounts
    : historicalCreditUnitAmounts();
  const priceValidationCode = existingPayment
    ? 'STRIPE_SUBSCRIPTION_PRICE_SNAPSHOT_CHANGED'
    : 'STRIPE_SUBSCRIPTION_PRICE_INVALID';
  const priceIds = new Set();
  const unitAmounts = new Set();
  const positivePriceIds = new Set();
  const positiveProductIds = new Set();
  const positiveSubscriptionItemIds = new Set();
  const positiveUnitAmounts = new Set();
  let positiveSubscriptionLines = 0;
  let targetPlanChangeLines = 0;
  for (const line of lines) {
    const lineAmount = line?.amount;
    if (typeof lineAmount !== 'number' || !Number.isSafeInteger(lineAmount)) {
      throw entitlementError('Stripe invoice line amount is invalid.', 'STRIPE_SUBSCRIPTION_PRICE_INVALID');
    }
    if (String(line?.currency || currency).toLowerCase() !== 'usd') {
      throw entitlementError('Stripe invoice line currency is invalid.', 'STRIPE_SUBSCRIPTION_PRICE_INVALID');
    }
    if (lineAmount === 0 && !pendingPlanChange) continue;
    const owner = lineSubscriptionId(line);
    if (owner !== stripeSubscriptionId) {
      throw entitlementError(
        'Stripe invoice contains a line from a different subscription.',
        'STRIPE_SUBSCRIPTION_PRICE_INVALID',
      );
    }
    const snapshot = linePriceSnapshot(line);
    if (!snapshot.priceId || !snapshot.productId || snapshot.unitAmountMinor === null) {
      throw entitlementError(
        'Stripe invoice line is missing its immutable price snapshot.',
        'STRIPE_SUBSCRIPTION_PRICE_SNAPSHOT_INCOMPLETE',
      );
    }
    const allowed = lineAmount >= 0 ? currentAmounts : allAmounts;
    if (!allowed.has(snapshot.unitAmountMinor)) {
      throw entitlementError(
        'Stripe invoice price is not permitted for the seller plan.',
        priceValidationCode,
      );
    }
    if (
      lineAmount >= 0
      && pendingPlanChange
      && (
        snapshot.priceId !== pendingPlanChange.priceId
        || snapshot.productId !== pendingPlanChange.productId
        || lineSubscriptionItemId(line) !== pendingPlanChange.subscriptionItemId
      )
    ) {
      throw entitlementError(
        'Stripe invoice item/price does not match the durable pending plan change.',
        'STRIPE_SUBSCRIPTION_PRICE_INVALID',
      );
    }
    if (
      lineAmount > 0
      && !pendingPlanChange
      && currentAuthorization.lockedPriceId
      && snapshot.priceId !== currentAuthorization.lockedPriceId
    ) {
      throw entitlementError(
        'Stripe invoice Price does not match the seller locked recurring Price.',
        priceValidationCode,
      );
    }
    if (
      lineAmount > 0
      && !pendingPlanChange
      && currentAuthorization.lockedSubscriptionItemId
      && lineSubscriptionItemId(line) !== currentAuthorization.lockedSubscriptionItemId
    ) {
      throw entitlementError(
        'Stripe invoice item does not match the recorded recurring subscription item.',
        priceValidationCode,
      );
    }
    if (
      lineAmount > 0
      && !pendingPlanChange
      && currentAuthorization.lockedProductId
      && snapshot.productId !== currentAuthorization.lockedProductId
    ) {
      throw entitlementError(
        'Stripe invoice Product does not match the seller locked recurring Product.',
        priceValidationCode,
      );
    }
    if (lineAmount < 0 && !lineIsProration(line)) {
      throw entitlementError(
        'A non-proration credit cannot fund subscription access.',
        'STRIPE_SUBSCRIPTION_PRICE_INVALID',
      );
    }
    if (line?.quantity !== undefined && line.quantity !== null && line.quantity !== 1) {
      throw entitlementError(
        'Stripe subscription invoice quantity is invalid.',
        'STRIPE_SUBSCRIPTION_PRICE_INVALID',
      );
    }
    if (lineAmount > 0) {
      positiveSubscriptionLines += 1;
      positivePriceIds.add(snapshot.priceId);
      positiveProductIds.add(snapshot.productId);
      positiveSubscriptionItemIds.add(lineSubscriptionItemId(line));
      positiveUnitAmounts.add(snapshot.unitAmountMinor);
    }
    if (lineAmount >= 0 && pendingPlanChange) targetPlanChangeLines += 1;
    priceIds.add(snapshot.priceId);
    unitAmounts.add(snapshot.unitAmountMinor);
  }
  if (!positiveSubscriptionLines && !(pendingPlanChange && amountPaid === 0 && targetPlanChangeLines === 1)) {
    throw entitlementError(
      'Stripe invoice has no validated positive subscription price line.',
      'STRIPE_SUBSCRIPTION_PRICE_INVALID',
    );
  }
  if (pendingPlanChange && targetPlanChangeLines !== 1) {
    throw entitlementError(
      'Stripe invoice does not have exactly one target line for the durable plan-change item.',
      'STRIPE_SUBSCRIPTION_PRICE_INVALID',
    );
  }
  if (!pendingPlanChange && (
    positivePriceIds.size !== 1
    || positiveProductIds.size !== 1
    || positiveSubscriptionItemIds.size !== 1
    || positiveUnitAmounts.size !== 1
  )) {
    throw entitlementError(
      'Stripe invoice does not identify one exact recurring Price and subscription item.',
      'STRIPE_SUBSCRIPTION_PRICE_INVALID',
    );
  }
  const fundedPriceId = pendingPlanChange?.priceId || [...positivePriceIds][0] || '';
  const fundedProductId = pendingPlanChange?.productId || [...positiveProductIds][0] || '';
  const fundedSubscriptionItemId = pendingPlanChange?.subscriptionItemId
    || [...positiveSubscriptionItemIds][0]
    || '';
  const fundedUnitAmountMinor = pendingPlanChange?.unitAmountMinor
    ?? [...positiveUnitAmounts][0]
    ?? null;
  const positivePlanInference = inferHistoricalPlanFromUnitAmounts(positiveUnitAmounts);
  return {
    amountPaid,
    currency,
    billingReason,
    pendingPlanChange,
    fundedPlan: pendingPlanChange?.plan
      || currentAuthorization?.plan
      || positivePlanInference?.plan
      || null,
    fundedPlanName: pendingPlanChange?.planName
      || currentAuthorization?.planName
      || positivePlanInference?.planName
      || 'Rozare subscription',
    fundedMetaAdsIncluded: pendingPlanChange
      ? pendingPlanChange.includeMetaAds
      : currentAuthorization?.includeMetaAds ?? positivePlanInference?.includeMetaAds ?? null,
    fundedPriceId,
    fundedProductId,
    fundedSubscriptionItemId,
    fundedUnitAmountMinor,
    priceIds: [...priceIds],
    unitAmountMinorSnapshots: [...unitAmounts].sort((left, right) => left - right),
  };
};

const invoiceFundingSnapshot = (subscription, validated) => {
  const pending = validated.pendingPlanChange;
  const predecessor = pending?.predecessor || null;
  return {
    fundedPlan: validated.fundedPlan,
    fundedPlanName: validated.fundedPlanName,
    fundedMetaAdsIncluded: validated.fundedMetaAdsIncluded === null
      || validated.fundedMetaAdsIncluded === undefined
      ? null
      : Boolean(validated.fundedMetaAdsIncluded),
    fundedStripePriceId: validated.fundedPriceId || null,
    fundedStripeProductId: validated.fundedProductId || null,
    fundedSubscriptionItemId: validated.fundedSubscriptionItemId || null,
    fundedUnitAmountMinor: validated.fundedUnitAmountMinor,
    fundedBonusFeaturesActive: pending ? true : Boolean(subscription.bonusFeaturesActive),
    fundedBonusExpiryDate: pending ? null : subscription.bonusExpiryDate || null,
    fundedBonusFeaturesExpiredPermanently: pending
      ? false
      : Boolean(subscription.bonusFeaturesExpiredPermanently),
    fundedBonusGraceDeadline: pending ? null : subscription.bonusGraceDeadline || null,
    planChangeToken: pending?.planChangeToken || null,
    predecessorPlan: predecessor?.plan || null,
    predecessorPlanName: predecessor?.planName || null,
    predecessorMetaAdsIncluded: predecessor
      ? Boolean(predecessor.includeMetaAds)
      : null,
    predecessorStripePriceId: predecessor?.priceId || null,
    predecessorStripeProductId: predecessor?.productId || null,
    predecessorSubscriptionItemId: predecessor?.subscriptionItemId || null,
    predecessorUnitAmountMinor: predecessor?.unitAmountMinor ?? null,
    predecessorBonusFeaturesActive: predecessor
      ? Boolean(predecessor.bonusFeaturesActive)
      : null,
    predecessorBonusExpiryDate: predecessor?.bonusExpiryDate || null,
    predecessorBonusFeaturesExpiredPermanently: predecessor
      ? Boolean(predecessor.bonusFeaturesExpiredPermanently)
      : null,
    predecessorBonusGraceDeadline: predecessor?.bonusGraceDeadline || null,
  };
};

const mergeInvoicePaymentTracks = (payment, incomingTracks) => {
  const existingTracks = chargeTracksOf(payment);
  const previousCapturedMinor = safeMinor(payment.capturedMinor, 0);
  const previousRefundedMinor = safeMinor(payment.refundedMinor, 0);
  const incomingCapturedMinor = incomingTracks.reduce((sum, track) => {
    const amount = safeMinor(track.capturedMinor, 0);
    if (amount > Number.MAX_SAFE_INTEGER - sum) {
      throw entitlementError(
        'Stripe Invoice Payment allocations exceed the safe integer range.',
        'STRIPE_ENTITLEMENT_AMOUNT_INVALID',
      );
    }
    return sum + amount;
  }, 0);
  const legacyTracks = existingTracks.filter(track => track.paymentType === 'legacy');
  if (legacyTracks.length && legacyTracks.length !== existingTracks.length) {
    throw entitlementError(
      'The stored Invoice Payment identities mix legacy and authoritative associations.',
      'STRIPE_INVOICE_PAYMENT_ASSOCIATION_INVALID',
      503,
    );
  }
  if (legacyTracks.length && incomingTracks.some(track => track.paymentType !== 'legacy')) {
    if (previousCapturedMinor !== incomingCapturedMinor) {
      throw entitlementError(
        'Stripe changed the settled amount while replacing a legacy payment association.',
        'STRIPE_INVOICE_PAYMENT_ASSOCIATION_INVALID',
      );
    }
    if (previousRefundedMinor > 0 && incomingTracks.length !== 1) {
      throw entitlementError(
        'Legacy aggregate refunds cannot be assigned safely across multiple Invoice Payments.',
        'STRIPE_ENTITLEMENT_LEGACY_ALLOCATION_AMBIGUOUS',
        503,
      );
    }
    payment.chargeTracks = incomingTracks;
    if (previousRefundedMinor > 0) {
      payment.chargeTracks[0].refundedMinor = Math.min(
        payment.chargeTracks[0].capturedMinor,
        previousRefundedMinor,
      );
    }
    syncPaymentTrackAggregates(payment);
    return payment;
  }
  if (
    !existingTracks.length
    && previousCapturedMinor > 0
    && previousCapturedMinor !== incomingCapturedMinor
  ) {
    throw entitlementError(
      'Stripe changed the settled amount while backfilling Invoice Payment identities.',
      'STRIPE_INVOICE_PAYMENT_ASSOCIATION_INVALID',
    );
  }
  if (!existingTracks.length && previousCapturedMinor > 0) {
    const fallback = incomingTracks.length === 1
      ? incomingTracks[0]
      : null;
    if (!fallback && safeMinor(payment.refundedMinor, 0) > 0) {
      throw entitlementError(
        'Legacy aggregate refunds cannot be assigned safely across multiple Invoice Payments.',
        'STRIPE_ENTITLEMENT_LEGACY_ALLOCATION_AMBIGUOUS',
        503,
      );
    }
  }

  if (existingTracks.length) {
    const existingIds = new Set(existingTracks.map(track => stringId(track.invoicePaymentId)));
    const incomingIds = new Set(incomingTracks.map(track => stringId(track.invoicePaymentId)));
    if (
      existingIds.size !== incomingIds.size
      || [...existingIds].some(invoicePaymentId => !incomingIds.has(invoicePaymentId))
    ) {
      throw entitlementError(
        'Stripe changed the Invoice Payment set of an already-settled invoice.',
        'STRIPE_INVOICE_PAYMENT_ASSOCIATION_INVALID',
        503,
      );
    }
  }

  const byId = new Map(existingTracks.map(track => [stringId(track.invoicePaymentId), track]));
  for (const incoming of incomingTracks) {
    const existing = byId.get(incoming.invoicePaymentId);
    if (!existing) {
      payment.chargeTracks.push(incoming);
      byId.set(incoming.invoicePaymentId, payment.chargeTracks[payment.chargeTracks.length - 1]);
      continue;
    }
    if (
      safeMinor(existing.capturedMinor, 0) !== incoming.capturedMinor
      || String(existing.currency || '').toLowerCase() !== incoming.currency
      || String(existing.paymentType || '') !== incoming.paymentType
    ) {
      throw entitlementError(
        'Stripe changed the immutable amount or identity of an Invoice Payment.',
        'STRIPE_INVOICE_PAYMENT_ASSOCIATION_INVALID',
      );
    }
    for (const field of ['paymentIntentId', 'paymentRecordId', 'chargeId']) {
      const current = stringId(existing[field]);
      const next = stringId(incoming[field]);
      if (current && next && current !== next) {
        throw entitlementError(
          'Stripe returned conflicting payment identities for one Invoice Payment.',
          'STRIPE_INVOICE_PAYMENT_ASSOCIATION_INVALID',
        );
      }
      if (!current && next) existing[field] = next;
    }
    if (!existing.paidAt && incoming.paidAt) existing.paidAt = incoming.paidAt;
  }

  const aggregateBeforeTracks = previousRefundedMinor;
  syncPaymentTrackAggregates(payment);
  if (aggregateBeforeTracks > payment.refundedMinor) {
    // Backfill a pre-track aggregate refund monotonically. A single association
    // is exact; multiple associations are intentionally rejected above because
    // assigning that historical refund to a period would otherwise be guesswork.
    payment.chargeTracks[0].refundedMinor = Math.min(
      payment.chargeTracks[0].capturedMinor,
      aggregateBeforeTracks,
    );
    syncPaymentTrackAggregates(payment);
  }
  if (capturedMinorOf(payment) !== incomingCapturedMinor) {
    throw entitlementError(
      'Stored Invoice Payment allocations no longer match the settled invoice.',
      'STRIPE_INVOICE_PAYMENT_ASSOCIATION_INVALID',
      503,
    );
  }
  return payment;
};

const validateFailedSubscriptionInvoice = ({
  invoice,
  subscription,
  stripeSubscriptionId,
}) => {
  const invoiceId = stringId(invoice?.id);
  const status = String(invoice?.status || '').trim().toLowerCase();
  const currency = String(invoice?.currency || '').trim().toLowerCase();
  const customerId = stringId(invoice?.customer);
  const billingReason = String(invoice?.billing_reason || '').trim().toLowerCase();
  const amountDueMinor = safeMinor(invoice?.amount_remaining);

  if (
    !invoiceId
    || !['open', 'uncollectible'].includes(status)
    || currency !== 'usd'
    || amountDueMinor <= 0
  ) {
    throw entitlementError(
      'A subscription payment failure requires an outstanding open USD invoice.',
      'STRIPE_SUBSCRIPTION_FAILURE_MONEY_INVALID',
    );
  }
  if (
    !customerId
    || customerId !== stringId(subscription?.stripeCustomerId)
    || stripeSubscriptionId !== stringId(subscription?.stripeSubscriptionId)
  ) {
    throw entitlementError(
      'Stripe failed-invoice customer/subscription ownership does not match the seller.',
      'STRIPE_SUBSCRIPTION_INVOICE_OWNERSHIP_MISMATCH',
    );
  }
  const metadataSellerId = stringId(invoiceSubscriptionMetadata(invoice)?.sellerId);
  if (metadataSellerId && metadataSellerId !== stringId(subscription?.seller)) {
    throw entitlementError(
      'Stripe failed-invoice metadata does not match the seller.',
      'STRIPE_SUBSCRIPTION_INVOICE_OWNERSHIP_MISMATCH',
    );
  }
  if (!SUBSCRIPTION_BILLING_REASONS.has(billingReason)) {
    throw entitlementError(
      'Only Stripe-generated subscription billing invoices can suspend paid access.',
      'STRIPE_SUBSCRIPTION_BILLING_REASON_INVALID',
    );
  }

  const lineList = invoice?.lines;
  if (lineList?.has_more === true) {
    throw entitlementError(
      'The failed subscription invoice has more lines than were available for validation.',
      'STRIPE_SUBSCRIPTION_FAILURE_EVIDENCE_INVALID',
      503,
    );
  }
  const lines = Array.isArray(lineList?.data) ? lineList.data : [];
  let positiveSubscriptionLines = 0;
  for (const line of lines) {
    const lineAmount = line?.amount;
    if (typeof lineAmount !== 'number' || !Number.isSafeInteger(lineAmount)) {
      throw entitlementError(
        'Stripe failed-invoice line amount is invalid.',
        'STRIPE_SUBSCRIPTION_FAILURE_EVIDENCE_INVALID',
      );
    }
    if (String(line?.currency || '').trim().toLowerCase() !== currency) {
      throw entitlementError(
        'Stripe failed-invoice line currency is invalid.',
        'STRIPE_SUBSCRIPTION_FAILURE_MONEY_INVALID',
      );
    }
    if (lineAmount === 0) continue;
    if (lineSubscriptionId(line) !== stripeSubscriptionId) {
      throw entitlementError(
        'Stripe failed invoice contains a non-zero line from a different subscription.',
        'STRIPE_SUBSCRIPTION_INVOICE_OWNERSHIP_MISMATCH',
      );
    }
    if (lineAmount > 0) positiveSubscriptionLines += 1;
  }
  if (!positiveSubscriptionLines) {
    throw entitlementError(
      'Stripe failed invoice has no positive line owned by the seller subscription.',
      'STRIPE_SUBSCRIPTION_FAILURE_EVIDENCE_INVALID',
    );
  }

  return {
    amountDueMinor,
    billingReason,
    currency: currency.toUpperCase(),
  };
};

const invoicePeriod = invoice => {
  const positiveLines = [];
  for (const line of (Array.isArray(invoice?.lines?.data) ? invoice.lines.data : [])) {
    const lineAmount = line?.amount;
    if (typeof lineAmount !== 'number' || !Number.isSafeInteger(lineAmount)) {
      throw entitlementError(
        'Stripe subscription invoice line amount is invalid.',
        'STRIPE_SUBSCRIPTION_PERIOD_INVALID',
      );
    }
    if (lineAmount <= 0) continue;
    const start = stripeSecondsDate(line?.period?.start);
    const end = stripeSecondsDate(line?.period?.end);
    if (
      !start
      || !end
      || end <= start
      || end.getTime() - start.getTime() > MAX_MONTHLY_SUBSCRIPTION_PERIOD_MS
    ) {
      throw entitlementError(
        'Stripe subscription invoice line has an invalid monthly service period.',
        'STRIPE_SUBSCRIPTION_PERIOD_INVALID',
      );
    }
    positiveLines.push({ start, end });
  }

  if (positiveLines.length) {
    const start = new Date(Math.min(...positiveLines.map(period => period.start.getTime())));
    const end = new Date(Math.max(...positiveLines.map(period => period.end.getTime())));
    if (end.getTime() - start.getTime() > MAX_MONTHLY_SUBSCRIPTION_PERIOD_MS) {
      throw entitlementError(
        'Stripe subscription invoice lines span more than one monthly billing period.',
        'STRIPE_SUBSCRIPTION_PERIOD_INVALID',
      );
    }
    return { start, end };
  }

  const start = stripeSecondsDate(invoice?.period_start);
  const end = stripeSecondsDate(invoice?.period_end);
  if (
    !start
    || !end
    || end <= start
    || end.getTime() - start.getTime() > MAX_MONTHLY_SUBSCRIPTION_PERIOD_MS
  ) {
    const error = new Error('Stripe subscription invoice is missing an authoritative service period.');
    error.code = 'STRIPE_SUBSCRIPTION_PERIOD_INVALID';
    error.statusCode = 400;
    throw error;
  }
  return { start, end };
};

const createIgnoringDuplicate = async document => {
  try {
    return { payment: await StripeEntitlementPayment.create(document), created: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const payment = await StripeEntitlementPayment.findOne({ sourceKey: document.sourceKey });
    if (!payment) throw error;
    return { payment, created: false };
  }
};

const ensureSubdomainLegacyLedger = async storeInput => {
  const store = storeInput?.subdomainPurchase
    ? storeInput
    : await Store.findById(storeInput);
  if (!store) return [];
  const existing = await StripeEntitlementPayment.find({
    entitlementType: 'subdomain',
    store: store._id,
    resourceKey: store.storeSlug,
  });
  if (existing.length) return existing;

  const purchase = store.subdomainPurchase || {};
  const expiryMs = purchase.expiresAt ? new Date(purchase.expiresAt).getTime() : NaN;
  if (!purchase.isPurchased || !Number.isFinite(expiryMs)) return [];

  const paymentIds = [...new Set([
    ...(Array.isArray(purchase.processedPaymentIds) ? purchase.processedPaymentIds : []),
    purchase.stripePaymentId,
  ].map(stringId).filter(Boolean))];
  const fallbackStartMs = expiryMs - Math.max(1, paymentIds.length) * LEGACY_SUBDOMAIN_GRANT_MS;
  const purchaseStartMs = purchase.purchasedAt
    ? new Date(purchase.purchasedAt).getTime()
    : fallbackStartMs;
  const startMs = Number.isFinite(purchaseStartMs) && purchaseStartMs < expiryMs
    ? purchaseStartMs
    : fallbackStartMs;
  const reversibleMs = Math.min(expiryMs - startMs, paymentIds.length * LEGACY_SUBDOMAIN_GRANT_MS);
  const baselineEndMs = expiryMs - reversibleMs;

  if (baselineEndMs > startMs || paymentIds.length === 0) {
    const baselineEnd = paymentIds.length === 0 ? expiryMs : baselineEndMs;
    await createIgnoringDuplicate({
      entitlementType: 'subdomain',
      sourceKey: `subdomain:legacy-baseline:${store._id}:${store.storeSlug}`,
      seller: store.seller,
      store: store._id,
      resourceKey: store.storeSlug,
      capturedMinor: 0,
      currency: 'usd',
      grantStart: new Date(startMs),
      grantEnd: new Date(baselineEnd),
      effectiveGrantEnd: new Date(baselineEnd),
      nonReversibleLegacyBaseline: true,
      completionEventIds: [],
    });
  }

  let cursorMs = baselineEndMs;
  for (let index = 0; index < paymentIds.length && cursorMs < expiryMs; index += 1) {
    const paymentIntentId = paymentIds[index];
    const remainingPayments = paymentIds.length - index;
    const remainingMs = expiryMs - cursorMs;
    const contributionMs = Math.min(
      LEGACY_SUBDOMAIN_GRANT_MS,
      Math.floor(remainingMs / remainingPayments),
    );
    const endMs = index === paymentIds.length - 1
      ? expiryMs
      : cursorMs + contributionMs;
    await createIgnoringDuplicate({
      entitlementType: 'subdomain',
      sourceKey: `subdomain:${paymentIntentId}`,
      seller: store.seller,
      store: store._id,
      resourceKey: store.storeSlug,
      paymentIntentId,
      capturedMinor: SUBDOMAIN_PRICE_MINOR,
      currency: 'usd',
      grantStart: new Date(cursorMs),
      grantEnd: new Date(endMs),
      effectiveGrantEnd: new Date(endMs),
      completionEventIds: [],
    });
    cursorMs = endMs;
  }

  return StripeEntitlementPayment.find({
    entitlementType: 'subdomain',
    store: store._id,
    resourceKey: store.storeSlug,
  });
};

const aggregateSubdomainPayments = payments => {
  const sorted = [...payments].sort((left, right) => (
    new Date(left.grantStart).getTime() - new Date(right.grantStart).getTime()
    || String(left.sourceKey).localeCompare(String(right.sourceKey))
  ));
  const intervals = [];
  let chainStartMs = null;
  let cursorMs = null;
  let previousOriginalEndMs = null;
  for (const payment of sorted) {
    const contributionMs = effectiveDurationMs(payment);
    const originalStartMs = new Date(payment.grantStart).getTime();
    const originalEndMs = new Date(payment.grantEnd).getTime();
    payment.effectiveGrantEnd = new Date(originalStartMs + contributionMs);
    const startsNewChain = previousOriginalEndMs === null || originalStartMs > previousOriginalEndMs;
    if (startsNewChain) {
      if (chainStartMs !== null) intervals.push({ startMs: chainStartMs, endMs: cursorMs });
      chainStartMs = originalStartMs;
      cursorMs = originalStartMs;
    }
    // Renewals in the same original ownership chain remain contiguous when an
    // earlier contribution is shortened/revoked. This avoids a future renewal
    // incorrectly protecting a slug across an unpaid gap.
    cursorMs += contributionMs;
    previousOriginalEndMs = Math.max(previousOriginalEndMs || originalEndMs, originalEndMs);
  }
  if (chainStartMs !== null) intervals.push({ startMs: chainStartMs, endMs: cursorMs });
  const selected = intervals[intervals.length - 1] || null;
  return {
    purchasedAt: selected ? new Date(selected.startMs) : null,
    expiresAt: selected ? new Date(selected.endMs) : null,
    intervals,
  };
};

const recomputeSubdomainEntitlement = async storeId => {
  const store = await Store.findById(storeId);
  if (!store) return null;
  const payments = await StripeEntitlementPayment.find({
    entitlementType: 'subdomain',
    store: store._id,
    resourceKey: store.storeSlug,
    completionState: 'confirmed',
  });
  const aggregate = aggregateSubdomainPayments(payments);
  await Promise.all(payments
    .filter(payment => payment.isModified('effectiveGrantEnd'))
    .map(payment => payment.save()));

  const now = new Date();
  const hasOpenRisk = payments.some(payment => (
    payment.riskSuspended
    || payment.disputeState === 'open'
    || payment.disputes?.some(dispute => dispute.state === 'open')
  ));
  const hasTerminalLoss = payments.some(payment => (
    payment.disputeState === 'lost'
    || payment.disputes?.some(dispute => dispute.state === 'lost')
    || (payment.capturedMinor > 0 && payment.refundedMinor >= payment.capturedMinor)
  ));
  const paymentIds = payments
    .filter(payment => !payment.nonReversibleLegacyBaseline && payment.paymentIntentId)
    .sort((left, right) => new Date(left.grantStart) - new Date(right.grantStart))
    .map(payment => payment.paymentIntentId);
  const latestPaymentId = paymentIds[paymentIds.length - 1] || store.subdomainPurchase?.stripePaymentId || '';
  const isPurchased = Boolean(
    aggregate.purchasedAt
    && aggregate.purchasedAt <= now
    && aggregate.expiresAt
    && aggregate.expiresAt > now,
  );
  const removalScheduledAt = (isPurchased || hasOpenRisk || store.isActive !== false)
    ? null
    : store.subdomainPurchase?.removalScheduledAt
      || new Date(now.getTime() + SUBDOMAIN_REMOVAL_GRACE_MS);

  const updated = await Store.findByIdAndUpdate(store._id, {
    $set: {
      'subdomainPurchase.isPurchased': isPurchased,
      'subdomainPurchase.purchasedAt': aggregate.purchasedAt,
      'subdomainPurchase.expiresAt': aggregate.expiresAt,
      'subdomainPurchase.stripePaymentId': latestPaymentId,
      'subdomainPurchase.processedPaymentIds': paymentIds,
      'subdomainPurchase.paymentRiskState': hasOpenRisk ? 'open' : hasTerminalLoss ? 'lost' : 'none',
      'subdomainPurchase.paymentRiskUpdatedAt': (hasOpenRisk || hasTerminalLoss) ? now : null,
      'subdomainPurchase.removalScheduledAt': removalScheduledAt,
    },
  }, { new: true });
  return updated;
};

const ensureSubdomainPaymentNotificationOutboxed = async ({
  payment,
  store,
  occurredAt,
}) => {
  const receiptAt = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  if (!Number.isFinite(receiptAt.getTime())) {
    throw entitlementError(
      'The subdomain payment receipt has no authoritative provider timestamp.',
      'SUBDOMAIN_PAYMENT_NOTIFICATION_TIMESTAMP_INVALID',
      503,
    );
  }

  let owned = await StripeEntitlementPayment.findOneAndUpdate({
    _id: payment?._id,
    entitlementType: 'subdomain',
    completionState: 'confirmed',
    $or: [
      { 'paymentNotification.kind': null },
      { 'paymentNotification.kind': { $exists: false } },
    ],
  }, {
    $set: {
      'paymentNotification.kind': 'received',
      'paymentNotification.occurredAt': receiptAt,
    },
  }, { new: true, runValidators: true });
  if (!owned) owned = await StripeEntitlementPayment.findById(payment?._id);
  if (
    owned?.entitlementType !== 'subdomain'
    || owned?.completionState !== 'confirmed'
    || owned?.paymentNotification?.kind !== 'received'
    || !owned?.paymentNotification?.occurredAt
  ) {
    throw entitlementError(
      'The subdomain payment receipt ownership snapshot could not be frozen.',
      'SUBDOMAIN_PAYMENT_NOTIFICATION_SNAPSHOT_FAILED',
      503,
    );
  }

  await enqueueSubdomainPaymentNotification(owned, store, {
    occurredAt: owned.paymentNotification.occurredAt,
  });
  const marked = await StripeEntitlementPayment.updateOne({
    _id: owned._id,
    entitlementType: 'subdomain',
    'paymentNotification.kind': 'received',
    'paymentNotification.occurredAt': owned.paymentNotification.occurredAt,
  }, {
    $set: { 'paymentNotification.outboxEnqueuedAt': new Date() },
  });
  if (Number(marked?.matchedCount ?? marked?.n ?? 0) !== 1) {
    throw entitlementError(
      'The subdomain payment receipt outbox marker could not be persisted.',
      'SUBDOMAIN_PAYMENT_NOTIFICATION_MARK_FAILED',
      503,
    );
  }
  return StripeEntitlementPayment.findById(owned._id);
};

const recordSubdomainCheckoutPayment = async session => {
  if (session?.metadata?.type !== 'subdomain_purchase') return { handled: false };
  const storeId = stringId(session.metadata.storeId);
  const sellerId = stringId(session.metadata.sellerId);
  const purchasedSlug = String(session.metadata.storeSlug || '').trim().toLowerCase();
  const paymentIntentId = stringId(session.payment_intent);
  if (!storeId || !sellerId || !paymentIntentId) {
    const error = new Error('Subdomain purchase webhook has incomplete payment metadata.');
    error.code = 'SUBDOMAIN_CHECKOUT_METADATA_INVALID';
    error.statusCode = 400;
    throw error;
  }
  const capturedMinor = safeMinor(session.amount_total);
  if (
    session.mode !== 'payment'
    || session.payment_status !== 'paid'
    || String(session.currency || '').trim().toLowerCase() !== 'usd'
    || capturedMinor !== SUBDOMAIN_PRICE_MINOR
  ) {
    const error = new Error('Subdomain ownership requires the exact paid USD Checkout amount.');
    error.code = 'SUBDOMAIN_PAYMENT_MISMATCH';
    error.statusCode = 400;
    throw error;
  }
  const store = await Store.findOne({
    _id: storeId,
    seller: sellerId,
    ...(purchasedSlug ? { storeSlug: purchasedSlug } : {}),
  });
  if (!store) {
    const error = new Error('The paid subdomain no longer matches the seller and store recorded at Checkout.');
    error.code = 'SUBDOMAIN_CHECKOUT_STORE_MISMATCH';
    error.statusCode = 409;
    throw error;
  }

  await ensureSubdomainLegacyLedger(store);
  const beforePayments = await StripeEntitlementPayment.find({
    entitlementType: 'subdomain',
    store: store._id,
    resourceKey: store.storeSlug,
    completionState: 'confirmed',
  });
  const before = aggregateSubdomainPayments(beforePayments);
  const now = new Date();
  const grantStart = before.expiresAt && before.expiresAt > now ? before.expiresAt : now;
  const grantEnd = addUtcCalendarYears(grantStart, 3);

  const result = await createIgnoringDuplicate({
    entitlementType: 'subdomain',
    sourceKey: `subdomain:${paymentIntentId}`,
    seller: store.seller,
    store: store._id,
    resourceKey: store.storeSlug,
    paymentIntentId,
    currency: String(session.currency || 'usd').toLowerCase(),
    capturedMinor,
    grantStart,
    grantEnd,
    effectiveGrantEnd: grantEnd,
    completionState: 'confirmed',
    completionEventIds: [stringId(session.id)].filter(Boolean),
  });
  const updatedStore = await recomputeSubdomainEntitlement(store._id);
  result.payment = await ensureSubdomainPaymentNotificationOutboxed({
    payment: result.payment,
    store: updatedStore,
    occurredAt: stripeSecondsDate(session.created) || result.payment.createdAt || grantStart,
  });
  return { handled: true, created: result.created, payment: result.payment, store: updatedStore };
};

const latestPaymentForPeriod = payments => [...payments].sort((left, right) => (
  new Date(right.grantStart).getTime() - new Date(left.grantStart).getTime()
  || new Date(right.grantEnd).getTime() - new Date(left.grantEnd).getTime()
))[0] || null;

const failureIsNewerThanPayment = (subscription, payment) => {
  const failureStart = subscription.paymentRisk?.latestFailurePeriodStart;
  if (!failureStart) return false;
  if (!payment) return true;
  const paymentStart = new Date(payment.grantStart);
  if (new Date(failureStart) > paymentStart) return true;
  if (new Date(failureStart) < paymentStart) return false;
  return safeMinor(subscription.paymentRisk?.latestFailureEventCreated, 0)
    > safeMinor(payment.stripeEventCreated, 0);
};

const updateStoreForSubscriptionRisk = async (subscription, suspended, restoreOwnedLock = false) => {
  const stripeSubscriptionId = stringId(subscription.stripeSubscriptionId);
  if (suspended) {
    const existing = await Store.findOne({ seller: subscription.seller })
      .select('isActive blockedAt subscriptionPaymentRiskLock');
    if (!existing) return;
    if (existing.subscriptionPaymentRiskLock?.stripeSubscriptionId === stripeSubscriptionId) {
      const lockTime = existing.subscriptionPaymentRiskLock?.lockedAt?.getTime();
      const blockTime = existing.blockedAt?.getTime();
      if (existing.isActive === false && lockTime && lockTime === blockTime) return;
      if (existing.isActive === true && !existing.blockedAt) {
        const relockedAt = new Date();
        await Store.updateOne({
          _id: existing._id,
          isActive: true,
          blockedAt: null,
          'subscriptionPaymentRiskLock.stripeSubscriptionId': stripeSubscriptionId,
          'subscriptionPaymentRiskLock.lockedAt': existing.subscriptionPaymentRiskLock.lockedAt,
        }, {
          $set: {
            isActive: false,
            blockedAt: relockedAt,
            'subscriptionPaymentRiskLock.lockedAt': relockedAt,
          },
        });
      }
      return;
    }
    // A store already inactive for another reason is not ours to reactivate.
    if (existing.isActive !== true || existing.blockedAt) return;
    const lockedAt = new Date();
    await Store.findOneAndUpdate({
      _id: existing._id,
      isActive: true,
      blockedAt: null,
      $or: [
        { 'subscriptionPaymentRiskLock.stripeSubscriptionId': '' },
        { 'subscriptionPaymentRiskLock.stripeSubscriptionId': { $exists: false } },
      ],
    }, {
      $set: {
        isActive: false,
        blockedAt: lockedAt,
        'subscriptionPaymentRiskLock.stripeSubscriptionId': stripeSubscriptionId,
        'subscriptionPaymentRiskLock.lockedAt': lockedAt,
      },
    });
    return;
  }
  if (!restoreOwnedLock) return;
  const current = await Store.findOne({
    seller: subscription.seller,
    'subscriptionPaymentRiskLock.stripeSubscriptionId': stripeSubscriptionId,
  }).select('isActive blockedAt subscriptionPaymentRiskLock');
  if (!current) return;
  const lockTime = current.subscriptionPaymentRiskLock?.lockedAt?.getTime();
  const blockTime = current.blockedAt?.getTime();
  const ownsExactBlock = current.isActive === false && lockTime && lockTime === blockTime;
  await Store.updateOne({
    _id: current._id,
    isActive: current.isActive,
    blockedAt: current.blockedAt,
    'subscriptionPaymentRiskLock.stripeSubscriptionId': stripeSubscriptionId,
    'subscriptionPaymentRiskLock.lockedAt': current.subscriptionPaymentRiskLock.lockedAt,
  }, {
    ...(ownsExactBlock ? { $set: { isActive: true, blockedAt: null } } : {}),
    $unset: { subscriptionPaymentRiskLock: 1 },
  });
};

const blockStoreForTerminalSubscriptionLoss = async subscription => {
  const stripeSubscriptionId = stringId(subscription.stripeSubscriptionId);
  const current = await Store.findOne({ seller: subscription.seller })
    .select('isActive blockedAt subscriptionPaymentRiskLock');
  if (!current) return;

  const ownsLock = current.subscriptionPaymentRiskLock?.stripeSubscriptionId === stripeSubscriptionId;
  const lockTime = current.subscriptionPaymentRiskLock?.lockedAt?.getTime();
  const blockTime = current.blockedAt?.getTime();
  const ownsExactBlock = ownsLock && lockTime && lockTime === blockTime;
  const shouldApplyTerminalBlock = current.isActive === true || ownsExactBlock;
  const filter = {
    _id: current._id,
    isActive: current.isActive,
    blockedAt: current.blockedAt,
    ...(ownsLock ? {
      'subscriptionPaymentRiskLock.stripeSubscriptionId': stripeSubscriptionId,
      'subscriptionPaymentRiskLock.lockedAt': current.subscriptionPaymentRiskLock.lockedAt,
    } : {}),
  };
  const update = {
    ...(shouldApplyTerminalBlock ? {
      $set: {
        isActive: false,
        blockedAt: subscription.blockedAt || new Date(),
      },
    } : {}),
    ...(ownsLock ? { $unset: { subscriptionPaymentRiskLock: 1 } } : {}),
  };
  if (Object.keys(update).length) await Store.updateOne(filter, update);
};

const restoreStoreFromTerminalSubscriptionLoss = async (subscription, ownedBlockedAt) => {
  if (!ownedBlockedAt) return;
  await Store.updateOne({
    seller: subscription.seller,
    isActive: false,
    blockedAt: ownedBlockedAt,
  }, {
    $set: {
      isActive: true,
      blockedAt: null,
      'subdomainPurchase.removalScheduledAt': null,
    },
    $unset: { subscriptionPaymentRiskLock: 1 },
  });
};

const clearTransientSubscriptionRisk = (subscription, now = new Date()) => {
  subscription.paymentRisk.suspended = false;
  subscription.paymentRisk.reason = '';
  subscription.paymentRisk.previousStatus = null;
  subscription.paymentRisk.stripeSubscriptionId = '';
  subscription.paymentRisk.updatedAt = now;
};

const paymentCoversInstant = (payment, instant) => (
  new Date(payment.grantStart) <= instant
  && new Date(payment.effectiveGrantEnd) > instant
);

const paymentProvidesActivePlanCoverage = (payment, instant) => (
  paymentCoversInstant(payment, instant)
  // A plan-change invoice funds an indivisible feature upgrade/add-on. Any
  // permanent reversal removes that upgraded feature immediately; otherwise a
  // partial refund could leave Elite/Meta enabled forever when no later event
  // happens at the mathematically shortened effectiveGrantEnd.
  && (!payment.planChangeToken || exposureMinor(payment) === 0)
);

const paymentFundingSnapshot = (payment, prefix = 'funded') => {
  const plan = String(payment?.[`${prefix}Plan`] || '').trim().toLowerCase();
  if (!['starter', 'elite'].includes(plan)) return null;
  const rawUnitAmount = payment?.[`${prefix}UnitAmountMinor`];
  return {
    plan,
    planName: payment?.[`${prefix}PlanName`] || (plan === 'elite' ? 'Rozare Elite' : 'Rozare Starter'),
    includeMetaAds: Boolean(payment?.[`${prefix}MetaAdsIncluded`]),
    stripePriceId: stringId(payment?.[`${prefix}StripePriceId`]),
    stripeProductId: stringId(payment?.[`${prefix}StripeProductId`]),
    subscriptionItemId: stringId(payment?.[`${prefix}SubscriptionItemId`]),
    unitAmountMinor: rawUnitAmount !== null
      && rawUnitAmount !== undefined
      && rawUnitAmount !== ''
      && Number.isSafeInteger(rawUnitAmount)
      && rawUnitAmount >= 0
      ? rawUnitAmount
      : null,
    planChangeToken: stringId(payment?.planChangeToken),
    requiresRemotePriceSync: false,
    planChangeDirection: prefix === 'predecessor' ? 'predecessor' : 'funded',
    bonusFeaturesActive: payment?.[`${prefix}BonusFeaturesActive`],
    bonusExpiryDate: payment?.[`${prefix}BonusExpiryDate`] || null,
    bonusFeaturesExpiredPermanently: payment?.[`${prefix}BonusFeaturesExpiredPermanently`],
    bonusGraceDeadline: payment?.[`${prefix}BonusGraceDeadline`] || null,
  };
};

const compareFundingPriority = (left, right) => (
  new Date(right.grantStart).getTime() - new Date(left.grantStart).getTime()
  || safeMinor(right.stripeEventCreated, 0) - safeMinor(left.stripeEventCreated, 0)
  || Number(Boolean(right.planChangeToken)) - Number(Boolean(left.planChangeToken))
  || new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime()
  || String(right.sourceKey || '').localeCompare(String(left.sourceKey || ''))
);

const sameFundedTier = (snapshot, plan, includeMetaAds) => Boolean(
  snapshot
  && snapshot.plan === String(plan || '').trim().toLowerCase()
  && Boolean(snapshot.includeMetaAds) === Boolean(includeMetaAds),
);

const compareFundingChronology = (left, right) => (
  new Date(left.grantStart).getTime() - new Date(right.grantStart).getTime()
  || safeMinor(left.stripeEventCreated, 0) - safeMinor(right.stripeEventCreated, 0)
  || new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime()
  || String(left.sourceKey || '').localeCompare(String(right.sourceKey || ''))
);

const fundedPlanStateAt = (payments, now) => {
  // Full-cycle/non-delta payments are roots. A plan-change invoice contains
  // only the incremental amount and can never establish its target tier on its
  // own. Start from the newest active root, then replay each later delta only
  // when the exact predecessor tier/meta state is still funded.
  const baselinePayment = payments
    .filter(payment => !payment.planChangeToken && paymentCoversInstant(payment, now))
    .filter(payment => paymentFundingSnapshot(payment))
    .sort(compareFundingPriority)[0];
  if (!baselinePayment) {
    return {
      snapshot: null,
      baselinePayment: null,
      appliedPlanChangeIds: new Set(),
      relevantPlanChanges: [],
    };
  }

  let snapshot = paymentFundingSnapshot(baselinePayment);
  const relevantPlanChanges = payments
    .filter(payment => (
      payment.planChangeToken
      && new Date(payment.grantStart) >= new Date(baselinePayment.grantStart)
      && new Date(payment.grantStart) <= now
      && new Date(payment.grantEnd) > now
    ))
    .sort(compareFundingChronology);
  const appliedPlanChangeIds = new Set();
  let directInvalidTransition = null;

  for (const payment of relevantPlanChanges) {
    const predecessorMatches = sameFundedTier(
      snapshot,
      payment.predecessorPlan,
      payment.predecessorMetaAdsIncluded,
    );
    if (!predecessorMatches) continue;
    if (!paymentProvidesActivePlanCoverage(payment, now)) {
      // This is the first broken link from the currently-funded chain. Later
      // dependent rows cannot apply even if their own money is untouched.
      directInvalidTransition = payment;
      continue;
    }
    const target = paymentFundingSnapshot(payment);
    if (!target) continue;
    snapshot = target;
    appliedPlanChangeIds.add(stringId(payment._id));
  }

  if (directInvalidTransition) {
    const exactPredecessor = paymentFundingSnapshot(directInvalidTransition, 'predecessor');
    if (sameFundedTier(
      exactPredecessor,
      snapshot.plan,
      snapshot.includeMetaAds,
    )) snapshot = exactPredecessor;
  }

  const latestRelevant = relevantPlanChanges[relevantPlanChanges.length - 1];
  if (latestRelevant) {
    snapshot.planChangeToken = stringId(latestRelevant.planChangeToken);
    snapshot.subscriptionItemId = stringId(latestRelevant.fundedSubscriptionItemId)
      || snapshot.subscriptionItemId;
    snapshot.requiresRemotePriceSync = true;
    snapshot.planChangeDirection = sameFundedTier(
      snapshot,
      latestRelevant.fundedPlan,
      latestRelevant.fundedMetaAdsIncluded,
    ) ? 'funded' : 'predecessor';
  }

  return {
    snapshot,
    baselinePayment,
    appliedPlanChangeIds,
    relevantPlanChanges,
  };
};

const fundedPlanSyncLeaseFilter = lease => ({
  _id: lease.subscriptionId,
  stripeSubscriptionId: lease.stripeSubscriptionId,
  'planChangeAttempt.idempotencyToken': lease.planChangeToken,
  'planChangeAttempt.state': 'processing',
  'planChangeAttempt.processingToken': lease.processingToken,
  ...(lease.snapshotHash ? {
    'planChangeAttempt.fundedPlanSync.leaseToken': lease.processingToken,
    'planChangeAttempt.fundedPlanSync.snapshotHash': lease.snapshotHash,
  } : {}),
});

const fundedPlanSyncProcessingToken = (previousState, createdAt = Date.now()) => (
  [
    'entitlement-plan-sync',
    'v1',
    previousState === 'applied' ? 'applied' : 'none',
    createdAt,
    crypto.randomUUID(),
  ].join(':')
);

const parseFundedPlanSyncProcessingToken = value => {
  const match = /^entitlement-plan-sync:v1:(applied|none):(\d{1,15}):([0-9a-f-]{36})$/i
    .exec(stringId(value));
  if (!match) return null;
  const createdAt = Number(match[2]);
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return null;
  return {
    previousState: match[1].toLowerCase() === 'applied' ? 'applied' : null,
    createdAt,
  };
};

const fundedPlanSyncDateIso = value => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const fundedPlanSyncIdempotencyKey = binding => {
  // Stripe compares the complete request body for an idempotency-key replay.
  // Include every value that can change that body (plus the local financial
  // direction/rate binding) so a same-Price item or metadata change can never
  // reuse a key with different parameters.
  const mutationHash = crypto.createHash('sha256').update(JSON.stringify({
    version: 2,
    subscriptionId: stringId(binding?.subscriptionId),
    planChangeToken: stringId(binding?.planChangeToken),
    sellerId: stringId(binding?.sellerId),
    stripeSubscriptionId: stringId(binding?.stripeSubscriptionId),
    stripeSubscriptionItemId: stringId(binding?.stripeSubscriptionItemId),
    stripePriceId: stringId(binding?.stripePriceId),
    stripeProductId: stringId(binding?.stripeProductId),
    plan: String(binding?.plan || '').trim().toLowerCase(),
    includeMetaAds: Boolean(binding?.includeMetaAds),
    direction: String(binding?.direction || '').trim().toLowerCase(),
    unitAmountMinor: binding?.unitAmountMinor ?? null,
    quantity: 1,
    clearSubscriptionDiscounts: true,
    clearItemDiscounts: true,
    prorationBehavior: 'none',
  })).digest('hex');
  return [
    'rozare-entitlement-plan-sync-v2',
    stringId(binding?.subscriptionId),
    stringId(binding?.stripePriceId),
    mutationHash,
  ].join('-');
};

const canonicalFundedPlanSyncSnapshot = (subscription, snapshot) => {
  const plan = String(snapshot?.plan || '').trim().toLowerCase();
  const direction = String(snapshot?.planChangeDirection || snapshot?.direction || '').trim().toLowerCase();
  const planChangeToken = stringId(snapshot?.planChangeToken);
  const sellerId = stringId(snapshot?.sellerId || subscription?.seller);
  const stripeSubscriptionId = stringId(
    snapshot?.stripeSubscriptionId || subscription?.stripeSubscriptionId,
  );
  const stripeSubscriptionItemId = stringId(
    snapshot?.subscriptionItemId || snapshot?.stripeSubscriptionItemId,
  );
  const stripePriceId = stringId(snapshot?.stripePriceId);
  const stripeProductId = stringId(snapshot?.stripeProductId);
  const rawUnitAmount = snapshot?.unitAmountMinor;
  const unitAmountMinor = rawUnitAmount === null || rawUnitAmount === undefined || rawUnitAmount === ''
    ? null
    : rawUnitAmount;
  if (
    !['starter', 'elite'].includes(plan)
    || !['funded', 'predecessor'].includes(direction)
    || !planChangeToken
    || !sellerId
    || !stripeSubscriptionId
    || sellerId !== stringId(subscription?.seller)
    || stripeSubscriptionId !== stringId(subscription?.stripeSubscriptionId)
    || !stripeSubscriptionItemId
    || !stripePriceId
    || !stripeProductId
    || (unitAmountMinor !== null && (!Number.isSafeInteger(unitAmountMinor) || unitAmountMinor < 0))
  ) {
    throw entitlementError(
      'The funded-plan reconciliation snapshot is incomplete or invalid.',
      'STRIPE_SUBSCRIPTION_PLAN_SYNC_BINDING_INVALID',
      503,
    );
  }
  const canonical = {
    planChangeToken,
    sellerId,
    stripeSubscriptionId,
    stripeSubscriptionItemId,
    stripePriceId,
    stripeProductId,
    plan,
    planName: String(snapshot?.planName || '').trim(),
    includeMetaAds: Boolean(snapshot?.includeMetaAds),
    direction,
    unitAmountMinor,
    idempotencyKey: fundedPlanSyncIdempotencyKey({
      subscriptionId: subscription?._id,
      planChangeToken,
      sellerId,
      stripeSubscriptionId,
      stripeSubscriptionItemId,
      stripePriceId,
      stripeProductId,
      plan,
      includeMetaAds: Boolean(snapshot?.includeMetaAds),
      direction,
      unitAmountMinor,
    }),
    bonusFeaturesActive: snapshot?.bonusFeaturesActive === null
      || snapshot?.bonusFeaturesActive === undefined
      ? null
      : Boolean(snapshot.bonusFeaturesActive),
    bonusExpiryDate: fundedPlanSyncDateIso(snapshot?.bonusExpiryDate),
    bonusFeaturesExpiredPermanently: snapshot?.bonusFeaturesExpiredPermanently === null
      || snapshot?.bonusFeaturesExpiredPermanently === undefined
      ? null
      : Boolean(snapshot.bonusFeaturesExpiredPermanently),
    bonusGraceDeadline: fundedPlanSyncDateIso(snapshot?.bonusGraceDeadline),
  };
  return {
    ...canonical,
    snapshotHash: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
  };
};

const durableFundedPlanSyncSnapshot = (subscription, snapshot, leaseToken) => ({
  leaseToken,
  ...canonicalFundedPlanSyncSnapshot(subscription, snapshot),
});

const runtimeFundedPlanSyncSnapshot = (subscription, stored, leaseToken) => {
  if (!stored || stringId(stored.leaseToken) !== stringId(leaseToken)) {
    throw entitlementError(
      'The funded-plan reconciliation lease is missing its exact durable snapshot.',
      'STRIPE_SUBSCRIPTION_PLAN_SYNC_BINDING_INVALID',
      503,
    );
  }
  const runtime = {
    planChangeToken: stored.planChangeToken,
    sellerId: stored.sellerId,
    stripeSubscriptionId: stored.stripeSubscriptionId,
    subscriptionItemId: stored.stripeSubscriptionItemId,
    stripePriceId: stored.stripePriceId,
    stripeProductId: stored.stripeProductId,
    plan: stored.plan,
    planName: stored.planName,
    includeMetaAds: stored.includeMetaAds,
    planChangeDirection: stored.direction,
    unitAmountMinor: stored.unitAmountMinor,
    bonusFeaturesActive: stored.bonusFeaturesActive,
    bonusExpiryDate: stored.bonusExpiryDate,
    bonusFeaturesExpiredPermanently: stored.bonusFeaturesExpiredPermanently,
    bonusGraceDeadline: stored.bonusGraceDeadline,
    requiresRemotePriceSync: true,
  };
  const canonical = canonicalFundedPlanSyncSnapshot(subscription, runtime);
  if (
    stringId(stored.snapshotHash) !== canonical.snapshotHash
    || stringId(stored.idempotencyKey) !== canonical.idempotencyKey
  ) {
    throw entitlementError(
      'The funded-plan reconciliation snapshot no longer matches its durable binding.',
      'STRIPE_SUBSCRIPTION_PLAN_SYNC_BINDING_INVALID',
      503,
    );
  }
  return { ...runtime, ...canonical };
};

const ownsFundedPlanSyncLease = async lease => Boolean(
  lease && await SellerSubscription.exists(fundedPlanSyncLeaseFilter(lease)),
);

const releaseFundedPlanSyncLease = async lease => {
  if (!lease) return;
  await SellerSubscription.updateOne(fundedPlanSyncLeaseFilter(lease), {
    $set: {
      'planChangeAttempt.state': lease.previousState,
      'planChangeAttempt.processingToken': lease.previousProcessingToken,
    },
    $unset: { 'planChangeAttempt.fundedPlanSync': 1 },
  });
};

const fundedPlanSyncOutcomeIsIndeterminate = (
  error,
  mutationMayHaveOccurred,
  retainedLeaseReplay = false,
) => {
  const statusCode = Number(error?.statusCode || error?.status || 0);
  const type = String(error?.type || error?.name || '').trim().toLowerCase();
  const code = String(error?.code || '').trim().toLowerCase();
  // Until the original retained POST is replayed to a definitive response,
  // every failure—including a retry-time 4xx read/update failure—must retain
  // ownership. The earlier request may still complete after this response.
  if (retainedLeaseReplay) return true;
  // A first-attempt retrieve/ownership failure happened before this service
  // issued any mutation and is safe to release. An existing service lease may
  // represent an earlier request whose response was lost, so its outcome stays
  // uncertain even if the current retry fails during retrieval.
  if (!mutationMayHaveOccurred) return false;
  const transportFailure = (
    type.includes('connection')
    || type.includes('timeout')
    || ['econnreset', 'econnrefused', 'etimedout', 'ehostunreach', 'enetwork'].includes(code)
  );
  // Stripe can report an idempotency conflict as HTTP 400 even though the
  // original request is still executing or its response was lost. Once the
  // update was attempted, that class is never proof of a non-mutating failure.
  const idempotencyFailure = type.includes('idempotency') || code.includes('idempotency');
  if (
    transportFailure
    || idempotencyFailure
    || statusCode >= 500
    || statusCode === 409
    || statusCode === 429
  ) {
    return true;
  }
  // Stripe/local 4xx validation before or during the update is definitive and
  // non-mutating. Everything else is conservatively uncertain, particularly a
  // post-update response/verification failure with no HTTP status.
  if (statusCode >= 400 && statusCode < 500) return false;
  return true;
};

const stripeDiscountsPresent = value => {
  if (!value) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (Array.isArray(value?.data)) return value.data.length > 0;
  return true;
};

const stripeSubscriptionHasDiscounts = subscription => (
  stripeDiscountsPresent(subscription?.discounts)
  || stripeDiscountsPresent(subscription?.discount)
);

const stripeSubscriptionItemHasDiscounts = item => (
  stripeDiscountsPresent(item?.discounts)
  || stripeDiscountsPresent(item?.discount)
);

const stripeSubscriptionItemQuantity = item => {
  if (item?.quantity === null || item?.quantity === undefined) return 1;
  return typeof item.quantity === 'number' && Number.isSafeInteger(item.quantity)
    ? item.quantity
    : Number.NaN;
};

const syncStripeSubscriptionFundedPlan = async (subscription, desiredSnapshot) => {
  const attempt = subscription.planChangeAttempt || {};
  const observedState = attempt.state ?? null;
  const observedProcessingToken = stringId(attempt.processingToken);
  const tokenHasServicePrefix = observedProcessingToken.startsWith('entitlement-plan-sync:');
  const priorServiceLease = parseFundedPlanSyncProcessingToken(observedProcessingToken);
  if (observedState === 'processing' && tokenHasServicePrefix && !priorServiceLease) {
    throw entitlementError(
      'The funded-plan reconciliation lease token is invalid.',
      'STRIPE_SUBSCRIPTION_PLAN_SYNC_BINDING_INVALID',
      503,
    );
  }
  if (!priorServiceLease && !desiredSnapshot?.requiresRemotePriceSync) {
    return { owned: true, subscription, lease: null, snapshot: desiredSnapshot };
  }

  const attemptToken = stringId(attempt.idempotencyToken);
  if (
    desiredSnapshot?.requiresRemotePriceSync
    && attemptToken !== stringId(desiredSnapshot.planChangeToken)
  ) return { owned: false, subscription, lease: null, snapshot: null };
  if (!stripe?.subscriptions?.update) {
    throw entitlementError(
      'Stripe subscription updates are unavailable for funded-plan reconciliation.',
      'STRIPE_SUBSCRIPTION_PLAN_ROLLBACK_UNAVAILABLE',
      503,
    );
  }

  let previousState = observedState;
  let lease;
  let leasedSubscription;
  let ownedSnapshot;
  if (priorServiceLease) {
    previousState = priorServiceLease.previousState;
    ownedSnapshot = runtimeFundedPlanSyncSnapshot(
      subscription,
      attempt.fundedPlanSync,
      observedProcessingToken,
    );
    lease = {
      subscriptionId: subscription._id,
      stripeSubscriptionId: ownedSnapshot.stripeSubscriptionId,
      planChangeToken: ownedSnapshot.planChangeToken,
      processingToken: observedProcessingToken,
      snapshotHash: ownedSnapshot.snapshotHash,
      previousState,
      previousProcessingToken: null,
    };
    leasedSubscription = subscription;

    if (Date.now() - priorServiceLease.createdAt >= FUNDED_PLAN_SYNC_LEASE_MS) {
      const replacementToken = fundedPlanSyncProcessingToken(previousState);
      const replacementSnapshot = durableFundedPlanSyncSnapshot(
        subscription,
        ownedSnapshot,
        replacementToken,
      );
      const replacementLease = {
        ...lease,
        processingToken: replacementToken,
        snapshotHash: replacementSnapshot.snapshotHash,
      };
      leasedSubscription = await SellerSubscription.findOneAndUpdate(
        fundedPlanSyncLeaseFilter(lease),
        {
          $set: {
            'planChangeAttempt.processingToken': replacementToken,
            'planChangeAttempt.fundedPlanSync': replacementSnapshot,
          },
        },
        { new: true, runValidators: true },
      );
      if (!leasedSubscription) {
        return {
          owned: false,
          subscription: await SellerSubscription.findById(subscription._id),
          lease: null,
          snapshot: null,
        };
      }
      lease = replacementLease;
      ownedSnapshot = runtimeFundedPlanSyncSnapshot(
        leasedSubscription,
        leasedSubscription.planChangeAttempt.fundedPlanSync,
        replacementToken,
      );
    }
  } else {
    if (!['applied', null].includes(observedState) || observedProcessingToken) {
      return { owned: false, subscription, lease: null, snapshot: null };
    }
    const processingToken = fundedPlanSyncProcessingToken(previousState);
    const durableSnapshot = durableFundedPlanSyncSnapshot(
      subscription,
      desiredSnapshot,
      processingToken,
    );
    lease = {
      subscriptionId: subscription._id,
      stripeSubscriptionId: durableSnapshot.stripeSubscriptionId,
      planChangeToken: durableSnapshot.planChangeToken,
      processingToken,
      snapshotHash: durableSnapshot.snapshotHash,
      previousState,
      previousProcessingToken: null,
    };
    leasedSubscription = await SellerSubscription.findOneAndUpdate({
      _id: subscription._id,
      stripeSubscriptionId: durableSnapshot.stripeSubscriptionId,
      'planChangeAttempt.idempotencyToken': durableSnapshot.planChangeToken,
      'planChangeAttempt.state': observedState,
      'planChangeAttempt.processingToken': attempt.processingToken ?? null,
    }, {
      $set: {
        'planChangeAttempt.state': 'processing',
        'planChangeAttempt.processingToken': processingToken,
        'planChangeAttempt.fundedPlanSync': durableSnapshot,
      },
    }, { new: true, runValidators: true });
    if (!leasedSubscription) {
      return {
        owned: false,
        subscription: await SellerSubscription.findById(subscription._id),
        lease: null,
        snapshot: null,
      };
    }
    ownedSnapshot = runtimeFundedPlanSyncSnapshot(
      leasedSubscription,
      leasedSubscription.planChangeAttempt.fundedPlanSync,
      processingToken,
    );
  }

  // A retained mutation can outlive the delta that originally selected it.
  // When the ledger has since fallen back to a non-delta baseline, bind that
  // baseline to the same durable attempt and serialize it after replaying the
  // unresolved request. Otherwise the expired target would be persisted again.
  const reconciliationDesiredSnapshot = (
    priorServiceLease
    && desiredSnapshot
    && !desiredSnapshot.requiresRemotePriceSync
  ) ? {
      ...desiredSnapshot,
      planChangeToken: ownedSnapshot.planChangeToken,
      sellerId: ownedSnapshot.sellerId,
      stripeSubscriptionId: ownedSnapshot.stripeSubscriptionId,
      subscriptionItemId: desiredSnapshot.subscriptionItemId || ownedSnapshot.subscriptionItemId,
      requiresRemotePriceSync: true,
      planChangeDirection: 'predecessor',
    } : desiredSnapshot;

  const stripeSubscriptionId = ownedSnapshot.stripeSubscriptionId;
  const priceId = ownedSnapshot.stripePriceId;
  const productId = ownedSnapshot.stripeProductId;
  const subscriptionItemId = ownedSnapshot.subscriptionItemId;
  let remoteMutationAttempted = false;
  try {
    let remote = null;
    let remoteAlreadyExact = false;
    if (stripe?.subscriptions?.retrieve) {
      remote = await retrieveStripeSubscriptionIfPresent(stripeSubscriptionId);
      if (!remote || ['canceled', 'incomplete_expired'].includes(String(remote.status || ''))) {
        // A fresh reconciliation can accept Stripe's authoritative terminal
        // absence. A retained lease cannot: its earlier POST may still finish,
        // so replay that exact request/key and retain the lease on any failure.
        if (!priorServiceLease) {
          return { owned: true, subscription: leasedSubscription, lease, snapshot: ownedSnapshot };
        }
      }
      if (
        remote
        && stringId(remote.customer)
        && stringId(remote.customer) !== stringId(subscription.stripeCustomerId)
      ) {
        throw entitlementError(
          'Stripe returned a different customer while synchronizing a reversible plan change.',
          'STRIPE_SUBSCRIPTION_INVOICE_OWNERSHIP_MISMATCH',
          503,
        );
      }
      const remoteItemListProvided = Array.isArray(remote?.items?.data);
      const remoteItems = remoteItemListProvided ? remote.items.data : [];
      const remoteItem = remoteItems.find(item => stringId(item?.id) === subscriptionItemId);
      if (
        !priorServiceLease
        && remoteItemListProvided
        && (
          remote?.items?.has_more === true
          || remoteItems.length !== 1
          || !remoteItem
        )
      ) {
        throw entitlementError(
          'Stripe subscription item shape changed outside the exact reversible plan binding.',
          'STRIPE_SUBSCRIPTION_PLAN_ROLLBACK_UNAVAILABLE',
          503,
        );
      }
      const remoteMetadata = remote?.metadata || {};
      remoteAlreadyExact = Boolean(
        remoteItem
        && remoteItems.length === 1
        && remote?.items?.has_more === false
        && stringId(remoteItem.price) === priceId
        && stripeSubscriptionItemQuantity(remoteItem) === 1
        && !stripeSubscriptionHasDiscounts(remote)
        && !stripeSubscriptionItemHasDiscounts(remoteItem)
        && stringId(remoteMetadata.sellerId) === ownedSnapshot.sellerId
        && String(remoteMetadata.plan || '').trim().toLowerCase() === ownedSnapshot.plan
        && String(remoteMetadata.includeMetaAds || '').trim().toLowerCase()
          === String(Boolean(ownedSnapshot.includeMetaAds))
        && stringId(remoteMetadata.entitlementPriceId) === priceId
        && stringId(remoteMetadata.entitlementProductId) === productId
      );
    }

    // A retained lease represents an unresolved POST. Even a coincidental GET
    // match cannot prove that request finished, so replay its exact bound key
    // and payload. A newly-acquired lease may accept an authoritative GET match.
    if (!priorServiceLease && remoteAlreadyExact) {
      return { owned: true, subscription: leasedSubscription, lease, snapshot: ownedSnapshot };
    }
    if (!(await ownsFundedPlanSyncLease(lease))) {
      return {
        owned: false,
        subscription: await SellerSubscription.findById(subscription._id),
        lease: null,
        snapshot: null,
      };
    }
    remoteMutationAttempted = true;
    const updated = await stripe.subscriptions.update(stripeSubscriptionId, {
      items: [{
        id: subscriptionItemId,
        price: priceId,
        quantity: 1,
        discounts: '',
      }],
      discounts: '',
      proration_behavior: 'none',
      metadata: {
        sellerId: ownedSnapshot.sellerId,
        plan: ownedSnapshot.plan,
        includeMetaAds: String(Boolean(ownedSnapshot.includeMetaAds)),
        entitlementPriceId: priceId,
        entitlementProductId: productId,
      },
    }, {
      idempotencyKey: ownedSnapshot.idempotencyKey,
    });
    const updatedItemListProvided = Array.isArray(updated?.items?.data);
    const updatedItems = updatedItemListProvided ? updated.items.data : [];
    const updatedItem = updatedItems.find(item => stringId(item?.id) === subscriptionItemId);
    const updatedMetadata = updated?.metadata;
    const updatedResponseComplete = Boolean(
      stringId(updated?.id) === stripeSubscriptionId
      && updatedItemListProvided
      && updated?.items?.has_more === false
      && updatedItems.length === 1
      && updatedItem
      && stringId(updatedItem.price) === priceId
      && stripeSubscriptionItemQuantity(updatedItem) === 1
      && Object.prototype.hasOwnProperty.call(updated, 'discounts')
      && Object.prototype.hasOwnProperty.call(updatedItem, 'discounts')
      && !stripeSubscriptionHasDiscounts(updated)
      && !stripeSubscriptionItemHasDiscounts(updatedItem)
      && updatedMetadata
      && stringId(updatedMetadata.sellerId) === ownedSnapshot.sellerId
      && String(updatedMetadata.plan || '').trim().toLowerCase() === ownedSnapshot.plan
      && String(updatedMetadata.includeMetaAds || '').trim().toLowerCase()
        === String(Boolean(ownedSnapshot.includeMetaAds))
      && stringId(updatedMetadata.entitlementPriceId) === priceId
      && stringId(updatedMetadata.entitlementProductId) === productId
    );
    if (
      !updatedResponseComplete
    ) {
      throw entitlementError(
        'Stripe did not return an authoritative exact plan-change item, quantity, Price, discounts, and metadata.',
        'STRIPE_SUBSCRIPTION_PLAN_ROLLBACK_UNAVAILABLE',
        503,
      );
    }
    const updatedProductId = stringId(updatedItem?.price?.product);
    if (updatedProductId && updatedProductId !== productId) {
      throw entitlementError(
        'Stripe returned a Product outside the exact funded-plan binding.',
        'STRIPE_SUBSCRIPTION_PLAN_ROLLBACK_UNAVAILABLE',
        503,
      );
    }

    if (reconciliationDesiredSnapshot?.requiresRemotePriceSync) {
      const desiredCanonical = canonicalFundedPlanSyncSnapshot(
        leasedSubscription,
        reconciliationDesiredSnapshot,
      );
      if (desiredCanonical.snapshotHash !== ownedSnapshot.snapshotHash) {
        const nextToken = fundedPlanSyncProcessingToken(previousState);
        const nextDurableSnapshot = durableFundedPlanSyncSnapshot(
          leasedSubscription,
          reconciliationDesiredSnapshot,
          nextToken,
        );
        const nextSubscription = await SellerSubscription.findOneAndUpdate(
          fundedPlanSyncLeaseFilter(lease),
          {
            $set: {
              'planChangeAttempt.processingToken': nextToken,
              'planChangeAttempt.fundedPlanSync': nextDurableSnapshot,
            },
          },
          { new: true, runValidators: true },
        );
        if (!nextSubscription) {
          return {
            owned: false,
            subscription: await SellerSubscription.findById(subscription._id),
            lease: null,
            snapshot: null,
          };
        }
        // State remains `processing`: finish the newly-bound snapshot before
        // exposing any controller claim window or local target persistence.
        return syncStripeSubscriptionFundedPlan(nextSubscription, reconciliationDesiredSnapshot);
      }
    }
    return { owned: true, subscription: leasedSubscription, lease, snapshot: ownedSnapshot };
  } catch (error) {
    if (!fundedPlanSyncOutcomeIsIndeterminate(
      error,
      remoteMutationAttempted || Boolean(priorServiceLease),
      Boolean(priorServiceLease),
    )) {
      try {
        await releaseFundedPlanSyncLease(lease);
      } catch (releaseError) {
        error.planSyncLeaseReleaseError = String(releaseError?.message || releaseError);
      }
    } else if (error && (typeof error === 'object' || typeof error === 'function')) {
      error.planSyncOutcomeIndeterminate = true;
    }
    throw error;
  }
};

const applyFundedPlanSnapshot = (subscription, snapshot, now) => {
  if (!snapshot) return false;
  const before = JSON.stringify({
    plan: subscription.plan,
    planName: subscription.planName,
    metaAdsIncluded: subscription.metaAdsIncluded,
    stripePriceId: subscription.stripePriceId,
    stripeProductId: subscription.stripeProductId,
    bonusFeaturesActive: subscription.bonusFeaturesActive,
    bonusExpiryDate: subscription.bonusExpiryDate,
    bonusFeaturesExpiredPermanently: subscription.bonusFeaturesExpiredPermanently,
    bonusGraceDeadline: subscription.bonusGraceDeadline,
  });

  subscription.plan = snapshot.plan;
  subscription.planName = snapshot.planName;
  subscription.metaAdsIncluded = snapshot.plan === 'elite' && Boolean(snapshot.includeMetaAds);
  if (snapshot.stripePriceId) subscription.stripePriceId = snapshot.stripePriceId;
  if (snapshot.stripeProductId) subscription.stripeProductId = snapshot.stripeProductId;

  if (snapshot.plan === 'elite') {
    subscription.bonusFeaturesActive = true;
    subscription.bonusExpiryDate = null;
    subscription.bonusFeaturesExpiredPermanently = false;
    subscription.bonusGraceDeadline = null;
  } else if (snapshot.bonusFeaturesActive !== null && snapshot.bonusFeaturesActive !== undefined) {
    const expiry = snapshot.bonusExpiryDate ? new Date(snapshot.bonusExpiryDate) : null;
    const bonusStillLive = Boolean(snapshot.bonusFeaturesActive && expiry && expiry > now);
    subscription.bonusFeaturesActive = bonusStillLive;
    subscription.bonusExpiryDate = bonusStillLive ? expiry : null;
    subscription.bonusFeaturesExpiredPermanently = bonusStillLive
      ? false
      : Boolean(
        snapshot.bonusFeaturesExpiredPermanently
        || (snapshot.bonusFeaturesActive && expiry && expiry <= now),
      );
    const graceDeadline = snapshot.bonusGraceDeadline
      ? new Date(snapshot.bonusGraceDeadline)
      : null;
    subscription.bonusGraceDeadline = graceDeadline && graceDeadline > now
      ? graceDeadline
      : null;
  }

  const after = JSON.stringify({
    plan: subscription.plan,
    planName: subscription.planName,
    metaAdsIncluded: subscription.metaAdsIncluded,
    stripePriceId: subscription.stripePriceId,
    stripeProductId: subscription.stripeProductId,
    bonusFeaturesActive: subscription.bonusFeaturesActive,
    bonusExpiryDate: subscription.bonusExpiryDate,
    bonusFeaturesExpiredPermanently: subscription.bonusFeaturesExpiredPermanently,
    bonusGraceDeadline: subscription.bonusGraceDeadline,
  });
  return before !== after;
};

const fundedPlanSyncPersistenceUpdate = subscription => {
  const risk = subscription.paymentRisk || {};
  const attempt = subscription.planChangeAttempt || {};
  return {
    $set: {
      plan: subscription.plan,
      planName: subscription.planName,
      metaAdsIncluded: Boolean(subscription.metaAdsIncluded),
      stripePriceId: subscription.stripePriceId || null,
      stripeProductId: subscription.stripeProductId || null,
      bonusFeaturesActive: Boolean(subscription.bonusFeaturesActive),
      bonusExpiryDate: subscription.bonusExpiryDate || null,
      bonusFeaturesExpiredPermanently: Boolean(subscription.bonusFeaturesExpiredPermanently),
      bonusGraceDeadline: subscription.bonusGraceDeadline || null,
      currentPeriodStart: subscription.currentPeriodStart || null,
      currentPeriodEnd: subscription.currentPeriodEnd || null,
      status: subscription.status,
      blockedAt: subscription.blockedAt || null,
      blockedReason: subscription.blockedReason || '',
      'paymentRisk.suspended': Boolean(risk.suspended),
      'paymentRisk.reason': risk.reason || '',
      'paymentRisk.previousStatus': risk.previousStatus ?? null,
      'paymentRisk.stripeSubscriptionId': risk.stripeSubscriptionId || '',
      'paymentRisk.updatedAt': risk.updatedAt || new Date(),
      'planChangeAttempt.state': attempt.state ?? null,
      'planChangeAttempt.processingToken': attempt.processingToken ?? null,
      'planChangeAttempt.pendingUpdateExpiresAt': attempt.pendingUpdateExpiresAt || null,
      'planChangeAttempt.completedAt': attempt.completedAt || null,
      'planChangeAttempt.lastError': attempt.lastError || '',
    },
    $unset: { 'planChangeAttempt.fundedPlanSync': 1 },
    $inc: { __v: 1 },
  };
};

const recomputeSubscriptionEntitlement = async (subscriptionId, options = {}) => {
  if (!subscriptionId) return null;
  let subscription = await SellerSubscription.findById(subscriptionId);
  if (!subscription) return null;
  const stripeSubscriptionId = stringId(subscription.stripeSubscriptionId);
  const payments = stripeSubscriptionId
    ? await StripeEntitlementPayment.find({
      entitlementType: 'subscription',
      seller: subscription.seller,
      stripeSubscriptionId,
      completionState: 'confirmed',
    })
    : [];
  await Promise.all(payments.map(async payment => {
    const nextEnd = new Date(new Date(payment.grantStart).getTime() + effectiveDurationMs(payment));
    if (nextEnd.getTime() !== new Date(payment.effectiveGrantEnd).getTime()) {
      payment.effectiveGrantEnd = nextEnd;
      await payment.save();
    }
  }));

  const now = new Date();
  const fundedState = fundedPlanStateAt(payments, now);
  const entitlementPayments = payments.filter(payment => (
    !payment.planChangeToken
    || fundedState.appliedPlanChangeIds.has(stringId(payment._id))
  ));
  const latest = latestPaymentForPeriod(entitlementPayments);
  const coverageEnd = entitlementPayments.reduce((latestEnd, payment) => {
    const end = new Date(payment.effectiveGrantEnd);
    return !latestEnd || end > latestEnd ? end : latestEnd;
  }, null);
  const hasCurrentPaidCycleCoverage = entitlementPayments.some(payment => (
    String(payment.billingReason || '') === 'subscription_cycle'
    && Number.isSafeInteger(payment.capturedMinor)
    && payment.capturedMinor > 0
    && new Date(payment.grantStart) <= now
    && new Date(payment.effectiveGrantEnd) > now
  ));
  const openRisk = payments.some(payment => (
    payment.riskSuspended
    || payment.disputeState === 'open'
    || payment.disputes?.some(dispute => dispute.state === 'open')
  ));
  let fundedPlanSyncLease = null;
  let fundedPlanSyncError = null;
  if (options.syncFundedPlan && !openRisk) {
    const fundedSnapshot = fundedState.snapshot;
    try {
      const syncResult = await syncStripeSubscriptionFundedPlan(subscription, fundedSnapshot);
      subscription = syncResult.subscription || subscription;
      if (syncResult.owned) {
        const ownedFundedSnapshot = syncResult.snapshot || fundedSnapshot;
        fundedPlanSyncLease = syncResult.lease;
        applyFundedPlanSnapshot(subscription, ownedFundedSnapshot, now);
        if (ownedFundedSnapshot?.requiresRemotePriceSync) {
          if (ownedFundedSnapshot.planChangeDirection === 'predecessor') {
            subscription.planChangeAttempt.state = null;
            subscription.planChangeAttempt.processingToken = null;
            subscription.planChangeAttempt.pendingUpdateExpiresAt = null;
            subscription.planChangeAttempt.completedAt = now;
            subscription.planChangeAttempt.lastError = 'Stripe reversed the payment funding this plan change.';
          } else {
            subscription.planChangeAttempt.state = 'applied';
            subscription.planChangeAttempt.processingToken = null;
            subscription.planChangeAttempt.pendingUpdateExpiresAt = null;
            subscription.planChangeAttempt.completedAt = now;
            subscription.planChangeAttempt.lastError = '';
          }
        }
      }
    } catch (error) {
      fundedPlanSyncError = error;
      // Financial truth must fail closed even when Stripe's corresponding
      // Price mutation is delayed or outcome-indeterminate. Reload the durable
      // lease acquired above, then remove only the locally-unfunded upgrade.
      // A won dispute (direction=funded) remains restrictive until Stripe is
      // verified exact, so we deliberately do not grant that target here.
      subscription = await SellerSubscription.findById(subscriptionId) || subscription;
      if (fundedSnapshot?.planChangeDirection === 'predecessor') {
        applyFundedPlanSnapshot(subscription, fundedSnapshot, now);
      }
    }
  }
  const hasCurrentCoverage = entitlementPayments.some(
    payment => paymentCoversInstant(payment, now),
  );
  const newerFailure = failureIsNewerThanPayment(subscription, latest);
  const terminalPaymentBlock = subscription.status === 'blocked'
    && !subscription.paymentRisk?.suspended
    && String(subscription.blockedReason || '').startsWith('Stripe payment reversal');
  const locallyEnded = (
    subscription.status === 'cancelled'
    || (subscription.status === 'blocked' && !subscription.paymentRisk?.suspended)
  ) && !(options.allowRestore && terminalPaymentBlock);
  const terminalNoCoverage = Boolean(
    options.terminalRiskEvent
    && !openRisk
    && !hasCurrentCoverage
    && payments.length > 0
  );
  const shouldSuspend = openRisk || (!hasCurrentCoverage && payments.length > 0) || newerFailure;
  const wasSuspended = Boolean(subscription.paymentRisk?.suspended);
  const canRestore = options.allowRestore
    && !locallyEnded
    && !shouldSuspend
    && (hasCurrentCoverage || subscription.status === 'free_period');

  if (latest) {
    subscription.currentPeriodStart = latest.grantStart;
    subscription.currentPeriodEnd = coverageEnd;
  }

  let terminalStoreBlock = false;
  let terminalStoreRestoreBlockedAt = null;
  if (terminalNoCoverage && !locallyEnded) {
    clearTransientSubscriptionRisk(subscription, now);
    subscription.status = 'blocked';
    subscription.blockedAt = now;
    subscription.blockedReason = 'Stripe payment reversal removed the payment funding the current subscription period.';
    terminalStoreBlock = true;
  } else if (shouldSuspend && !locallyEnded) {
    if (!subscription.paymentRisk?.suspended) {
      subscription.paymentRisk.previousStatus = subscription.status;
    }
    subscription.paymentRisk.suspended = true;
    subscription.paymentRisk.reason = openRisk
      ? 'Stripe payment dispute is under financial review.'
      : newerFailure
        ? 'Stripe subscription payment failed.'
        : 'Stripe reversed the payment funding the current subscription period.';
    subscription.paymentRisk.stripeSubscriptionId = stripeSubscriptionId;
    subscription.paymentRisk.updatedAt = now;
    subscription.status = openRisk || newerFailure ? 'past_due' : 'blocked';
    subscription.blockedAt = now;
    subscription.blockedReason = `Stripe payment risk: ${subscription.paymentRisk.reason}`;
  } else if (canRestore && subscription.paymentRisk?.suspended) {
    const previousStatus = subscription.paymentRisk.previousStatus;
    subscription.status = previousStatus === 'free_period' && subscription.freePeriodEndDate > now
      ? 'free_period'
      : 'active';
    clearTransientSubscriptionRisk(subscription, now);
    subscription.blockedAt = null;
    subscription.blockedReason = '';
  } else if (canRestore && terminalPaymentBlock) {
    terminalStoreRestoreBlockedAt = subscription.blockedAt;
    subscription.status = 'active';
    clearTransientSubscriptionRisk(subscription, now);
    subscription.blockedAt = null;
    subscription.blockedReason = '';
  } else if (
    options.allowRestore
    && !locallyEnded
    && hasCurrentCoverage
    && !newerFailure
    && !openRisk
    && subscription.status === 'past_due'
  ) {
    subscription.status = 'active';
    subscription.blockedAt = null;
    subscription.blockedReason = '';
  } else if (
    !locallyEnded
    && !shouldSuspend
    && subscription.status === 'free_period'
    && subscription.freePeriodEndDate
    && subscription.freePeriodEndDate <= now
    && hasCurrentPaidCycleCoverage
  ) {
    // A positive subscription-cycle invoice is the authoritative proof that
    // Stripe funded access after the introductory free period. Prorations and
    // zero-dollar trial invoices must not end that period early.
    subscription.status = 'active';
    subscription.blockedAt = null;
    subscription.blockedReason = '';
  }

  if (fundedPlanSyncLease) {
    try {
      // This is the local ownership re-check and persistence in one MongoDB
      // compare-and-swap. A superseding generation cannot enter between a
      // separate read and save, and an unrelated versioned save is retried from
      // a fresh document rather than overwritten.
      const persisted = await SellerSubscription.findOneAndUpdate({
        ...fundedPlanSyncLeaseFilter(fundedPlanSyncLease),
        __v: Number(subscription.__v || 0),
      }, fundedPlanSyncPersistenceUpdate(subscription), {
        new: true,
        runValidators: true,
      });
      if (!persisted) {
        const stillOwnsLease = await ownsFundedPlanSyncLease(fundedPlanSyncLease);
        if (stillOwnsLease) {
          if (!options._fundedPlanSyncRetried) {
            return recomputeSubscriptionEntitlement(subscriptionId, {
              ...options,
              _fundedPlanSyncRetried: true,
            });
          }
          throw entitlementError(
            'The subscription changed concurrently while persisting its funded plan.',
            'STRIPE_SUBSCRIPTION_PLAN_SYNC_CONFLICT',
            503,
          );
        }
        // A newer generation now owns the document. Recompute risk/status from
        // that generation, but never retry this stale Stripe plan projection.
        return recomputeSubscriptionEntitlement(subscriptionId, {
          ...options,
          syncFundedPlan: false,
        });
      }
      subscription = persisted;
    } catch (error) {
      // Stripe is already authoritative at this point. Keep the lease across
      // database/validation failures so the exact same reconciliation can be
      // retried; releasing here would expose a remote/local split to a new plan.
      if (error && (typeof error === 'object' || typeof error === 'function')) {
        error.planSyncOutcomeIndeterminate = true;
      }
      throw error;
    }
  } else {
    await subscription.save();
  }
  if (terminalStoreBlock) {
    await blockStoreForTerminalSubscriptionLoss(subscription);
  } else if (terminalStoreRestoreBlockedAt) {
    await restoreStoreFromTerminalSubscriptionLoss(subscription, terminalStoreRestoreBlockedAt);
  } else {
    await updateStoreForSubscriptionRisk(
      subscription,
      Boolean(subscription.paymentRisk?.suspended),
      wasSuspended && !subscription.paymentRisk?.suspended,
    );
  }
  if (fundedPlanSyncError) throw fundedPlanSyncError;
  return subscription;
};

const notificationDeliveryIsOutstanding = state => (
  ['pending', 'partial', 'processing'].includes(String(state || '').trim().toLowerCase())
);

const pendingSubscriptionFailureNotification = ({
  invoiceId,
  eventId,
  stripeSubscriptionId,
  planName,
  amountDueMinor,
  currency,
  occurredAt,
}) => ({
  invoiceId,
  eventId: stringId(eventId) || null,
  stripeSubscriptionId,
  planName: String(planName || 'Rozare').trim() || 'Rozare',
  amountDueMinor,
  currency,
  occurredAt,
  state: 'pending',
  token: null,
  startedAt: null,
  completedAt: null,
  lastError: '',
  emailState: 'pending',
  whatsAppState: 'pending',
  inAppState: 'pending',
  pushState: 'pending',
});

const pendingSubscriptionRecoveryNotification = ({ failureInvoiceId, eventId, planName }) => ({
  failureInvoiceId: failureInvoiceId || null,
  eventId: stringId(eventId) || null,
  planName: String(planName || 'Rozare').trim() || 'Rozare',
  state: 'pending',
  token: null,
  startedAt: null,
  completedAt: null,
  lastError: '',
  emailState: 'pending',
  whatsAppState: 'pending',
  inAppState: 'pending',
});

const failureNotificationIntentFor = (subscription, invoiceId) => {
  const notification = subscription?.paymentRisk?.failureNotification;
  if (
    !notificationDeliveryIsOutstanding(notification?.state)
    || stringId(notification?.invoiceId) !== stringId(invoiceId)
    || stringId(subscription?.paymentRisk?.latestFailureInvoiceId) !== stringId(invoiceId)
    || !subscription?.paymentRisk?.suspended
    || !['past_due', 'blocked'].includes(String(subscription?.status || ''))
  ) return null;
  return {
    kind: 'failed',
    subscriptionId: stringId(subscription?._id),
    invoiceId: stringId(invoiceId),
  };
};

const recoveryNotificationIntentFor = (payment, subscription, invoiceId) => {
  const notification = payment?.recoveryNotification;
  if (
    !notificationDeliveryIsOutstanding(notification?.state)
    || stringId(payment?.invoiceId) !== stringId(invoiceId)
    || stringId(subscription?.paymentRisk?.latestSuccessfulInvoiceId) !== stringId(invoiceId)
    || subscription?.paymentRisk?.suspended
    || String(subscription?.status || '') !== 'active'
  ) return null;
  return {
    kind: 'recovered',
    paymentId: stringId(payment?._id),
    subscriptionId: stringId(subscription?._id),
    invoiceId: stringId(invoiceId),
  };
};

const latestCapturedPaymentAt = payment => {
  let latest = null;
  for (const track of chargeTracksOf(payment)) {
    const paidAt = track?.paidAt instanceof Date ? track.paidAt : new Date(track?.paidAt);
    if (!Number.isFinite(paidAt.getTime())) continue;
    if (!latest || paidAt > latest) latest = paidAt;
  }
  return latest;
};

const ensureSubscriptionPaymentNotificationOutboxed = async ({
  payment,
  subscription,
  invoiceId,
}) => {
  const recoveryCurrent = Boolean(
    recoveryNotificationIntentFor(payment, subscription, invoiceId)
  );
  const desiredKind = recoveryCurrent ? 'recovered' : 'received';
  const desiredOccurredAt = latestCapturedPaymentAt(payment)
    || payment?.paymentNotification?.occurredAt
    || payment?.createdAt;
  if (!desiredOccurredAt || !Number.isFinite(new Date(desiredOccurredAt).getTime())) {
    throw entitlementError(
      'The settled subscription payment has no authoritative notification timestamp.',
      'STRIPE_SUBSCRIPTION_PAYMENT_TIMESTAMP_INVALID',
      503,
    );
  }

  // First writer freezes received-vs-recovered wording and its event time.
  // A concurrent Stripe webhook either observes this exact snapshot or retries
  // after the versioned financial ledger write; it cannot reinterpret it.
  let owned = await StripeEntitlementPayment.findOneAndUpdate({
    _id: payment._id,
    $or: [
      { 'paymentNotification.kind': null },
      { 'paymentNotification.kind': { $exists: false } },
    ],
  }, {
    $set: {
      'paymentNotification.kind': desiredKind,
      'paymentNotification.occurredAt': new Date(desiredOccurredAt),
    },
  }, { new: true, runValidators: true });
  if (!owned) owned = await StripeEntitlementPayment.findById(payment._id);
  if (!owned?.paymentNotification?.kind || !owned.paymentNotification?.occurredAt) {
    throw entitlementError(
      'The subscription payment notification snapshot could not be frozen.',
      'STRIPE_SUBSCRIPTION_NOTIFICATION_SNAPSHOT_FAILED',
      503,
    );
  }

  const kind = owned.paymentNotification.kind;
  await enqueueSubscriptionPaymentNotification(owned, {
    kind,
    // A delayed/replayed invoice must never be relabelled with the seller's
    // mutable current plan. fundedPlanName was frozen on this payment record;
    // legacy rows without it receive a deliberately neutral receipt label.
    planName: owned.fundedPlanName || 'Rozare subscription',
    occurredAt: owned.paymentNotification.occurredAt,
  });

  const update = {
    'paymentNotification.outboxEnqueuedAt': new Date(),
  };
  if (
    kind === 'recovered'
    && notificationDeliveryIsOutstanding(owned.recoveryNotification?.state)
  ) {
    // The durable outbox now owns every recovery channel. Mark the legacy
    // direct-delivery state as routed only after enqueue succeeds, preventing
    // duplicate email/in-app/WhatsApp sends without opening a crash window.
    update['recoveryNotification.state'] = 'outboxed';
    update['recoveryNotification.token'] = null;
    update['recoveryNotification.completedAt'] = new Date();
    update['recoveryNotification.lastError'] = '';
  }
  const marked = await StripeEntitlementPayment.updateOne({
    _id: owned._id,
    'paymentNotification.kind': kind,
    'paymentNotification.occurredAt': owned.paymentNotification.occurredAt,
  }, { $set: update });
  if (Number(marked?.matchedCount ?? marked?.n ?? 0) !== 1) {
    throw entitlementError(
      'The subscription payment notification ownership marker could not be persisted.',
      'STRIPE_SUBSCRIPTION_NOTIFICATION_MARK_FAILED',
      503,
    );
  }
  return StripeEntitlementPayment.findById(owned._id);
};

const recordSubscriptionInvoicePayment = async ({
  invoice,
  eventId = '',
  eventCreated = 0,
  knownInvoicePayments = null,
  incomingCharge = null,
}) => {
  const resolved = await resolveInvoiceSubscription(invoice);
  if (!resolved.handled) return resolved;
  invoice = await loadCompleteInvoiceLines(invoice);
  const { stripeSubscriptionId, invoiceId } = resolved;
  let { subscription } = resolved;
  const previousStatus = subscription.status;

  const capturedMinor = safeMinor(invoice?.amount_paid, 0);
  if (capturedMinor === 0) {
    const pendingPlanChange = authorizedPendingPlanChangeForInvoice({
      subscription,
      invoiceId,
      stripeSubscriptionId,
      billingReason: String(invoice?.billing_reason || '').trim(),
      metadata: invoiceSubscriptionMetadata(invoice),
    });
    if (!pendingPlanChange) {
      // Trial invoices and ordinary zero-total prorations do not fund a paid
      // coverage period and must never flip free_period to active.
      return { handled: true, zeroAmount: true, previousStatus, subscription };
    }

    // A pending Stripe update can be applied with no cash capture when a
    // customer balance, discount, or zero proration covers the invoice. It may
    // grant the exact new Price, but it still does not create paid-cycle
    // coverage in the reversible payment ledger.
    const validated = validatePaidSubscriptionInvoice({
      invoice,
      subscription,
      stripeSubscriptionId,
    });
    let zeroPaymentRows = null;
    if (Array.isArray(invoice?.payments?.data) && invoice.payments.has_more !== true) {
      zeroPaymentRows = invoice.payments.data;
    } else if (stripe?.invoicePayments?.list) {
      zeroPaymentRows = await listAllInvoicePayments({ invoice: invoiceId, status: 'paid' });
    }
    for (const row of zeroPaymentRows || []) {
      if (String(row?.status || '').toLowerCase() !== 'paid') continue;
      const rowAmount = safeMinor(row?.amount_paid);
      if (
        stringId(row?.invoice) !== invoiceId
        || String(row?.currency || '').trim().toLowerCase() !== validated.currency
        || rowAmount !== 0
      ) {
        throw entitlementError(
          'Stripe Invoice Payment allocations do not conserve the zero-due invoice amount.',
          'STRIPE_INVOICE_PAYMENT_TOTAL_MISMATCH',
        );
      }
    }
    return {
      handled: true,
      zeroAmount: true,
      planChangeAuthorized: true,
      validated,
      previousStatus,
      subscription,
    };
  }
  const existingPayment = await StripeEntitlementPayment.findOne({
    sourceKey: `subscription:${invoiceId}`,
    entitlementType: 'subscription',
    seller: subscription.seller,
    stripeSubscriptionId,
  });
  const validated = validatePaidSubscriptionInvoice({
    invoice,
    subscription,
    stripeSubscriptionId,
    existingPayment,
  });
  const fundingSnapshot = invoiceFundingSnapshot(subscription, validated);
  const period = invoicePeriod(invoice);
  const currentFailureStart = subscription.paymentRisk?.latestFailurePeriodStart;
  const newerThanFailure = !currentFailureStart
    || period.start > currentFailureStart
    || (
      period.start.getTime() === new Date(currentFailureStart).getTime()
      && safeMinor(eventCreated, 0) >= safeMinor(subscription.paymentRisk?.latestFailureEventCreated, 0)
    );
  const wasPaymentRestricted = Boolean(
    subscription.paymentRisk?.suspended
    || subscription.status === 'past_due'
  );
  const recoveryEligible = wasPaymentRestricted && newerThanFailure;
  const recoveryFailureInvoiceId = stringId(subscription.paymentRisk?.latestFailureInvoiceId);
  const recoveryNotification = recoveryEligible
    ? pendingSubscriptionRecoveryNotification({
      failureInvoiceId: recoveryFailureInvoiceId,
      eventId,
      planName: subscription.planName,
    })
    : undefined;
  const chargeTracks = await loadInvoicePaymentTracks({
    invoice,
    incomingCharge,
    knownRows: knownInvoicePayments,
  });
  const paymentIntentIds = [...new Set(chargeTracks.map(track => track.paymentIntentId).filter(Boolean))];
  const chargeIds = [...new Set(chargeTracks.map(track => track.chargeId).filter(Boolean))];
  const paymentIntentId = paymentIntentIds.length === 1
    ? paymentIntentIds[0]
    : invoicePaymentIntentId(invoice);
  const chargeId = chargeIds.length === 1 ? chargeIds[0] : invoiceChargeId(invoice);
  const result = await createIgnoringDuplicate({
    entitlementType: 'subscription',
    sourceKey: `subscription:${invoiceId}`,
    seller: subscription.seller,
    invoiceId,
    stripeSubscriptionId,
    paymentIntentId,
    chargeIds: [...new Set([...chargeIds, chargeId].filter(Boolean))],
    chargeTracks,
    currency: validated.currency,
    capturedMinor: validated.amountPaid,
    grantStart: period.start,
    grantEnd: period.end,
    effectiveGrantEnd: period.end,
    billingReason: validated.billingReason,
    priceIds: validated.priceIds,
    unitAmountMinorSnapshots: validated.unitAmountMinorSnapshots,
    ...fundingSnapshot,
    stripeEventCreated: safeMinor(eventCreated, 0),
    completionState: 'confirmed',
    completionEventIds: [stringId(eventId)].filter(Boolean),
    ...(recoveryNotification ? { recoveryNotification } : {}),
  });

  if (!result.created) {
    const updates = {};
    const additions = {};
    const incomingEventCreated = safeMinor(eventCreated, 0);
    if (paymentIntentId && !result.payment.paymentIntentId) updates.paymentIntentId = paymentIntentId;
    if (incomingEventCreated > safeMinor(result.payment.stripeEventCreated, 0)) {
      updates.stripeEventCreated = incomingEventCreated;
    }
    const storedPriceIds = normalizedStringSet(result.payment.priceIds);
    const incomingPriceIds = normalizedStringSet(validated.priceIds);
    const storedUnitAmounts = normalizedMinorSet(result.payment.unitAmountMinorSnapshots);
    const incomingUnitAmounts = normalizedMinorSet(validated.unitAmountMinorSnapshots);
    if (
      (storedPriceIds.length && !sameValues(storedPriceIds, incomingPriceIds))
      || (storedUnitAmounts.length && !sameValues(storedUnitAmounts, incomingUnitAmounts))
    ) {
      throw entitlementError(
        'Stripe changed the immutable price snapshot of a settled subscription invoice.',
        'STRIPE_SUBSCRIPTION_PRICE_SNAPSHOT_CHANGED',
      );
    }
    const immutableFundingFields = [
      'fundedPlan',
      'fundedPlanName',
      'fundedMetaAdsIncluded',
      'fundedStripePriceId',
      'fundedStripeProductId',
      'fundedSubscriptionItemId',
      'fundedUnitAmountMinor',
    ];
    for (const field of immutableFundingFields) {
      const stored = result.payment[field];
      const incoming = fundingSnapshot[field];
      const storedPresent = stored !== null && stored !== undefined && stored !== '';
      const incomingPresent = incoming !== null && incoming !== undefined && incoming !== '';
      if (storedPresent && incomingPresent && String(stored) !== String(incoming)) {
        throw entitlementError(
          'Stripe changed the immutable funded-plan snapshot of a settled subscription invoice.',
          'STRIPE_SUBSCRIPTION_PRICE_SNAPSHOT_CHANGED',
        );
      }
      if (!storedPresent && incomingPresent) result.payment[field] = incoming;
    }
    const predecessorFields = [
      'planChangeToken',
      'predecessorPlan',
      'predecessorPlanName',
      'predecessorMetaAdsIncluded',
      'predecessorStripePriceId',
      'predecessorStripeProductId',
      'predecessorSubscriptionItemId',
      'predecessorUnitAmountMinor',
      'predecessorBonusFeaturesActive',
      'predecessorBonusExpiryDate',
      'predecessorBonusFeaturesExpiredPermanently',
      'predecessorBonusGraceDeadline',
    ];
    for (const field of predecessorFields) {
      const stored = result.payment[field];
      const incoming = fundingSnapshot[field];
      const storedPresent = stored !== null && stored !== undefined && stored !== '';
      const incomingPresent = incoming !== null && incoming !== undefined && incoming !== '';
      if (storedPresent && incomingPresent) {
        const storedValue = stored instanceof Date ? stored.getTime() : String(stored);
        const incomingValue = incoming instanceof Date ? incoming.getTime() : String(incoming);
        if (storedValue !== incomingValue) {
          throw entitlementError(
            'Stripe changed the immutable predecessor snapshot of a settled plan-change invoice.',
            'STRIPE_SUBSCRIPTION_PRICE_SNAPSHOT_CHANGED',
          );
        }
      }
      if (!storedPresent && incomingPresent) result.payment[field] = incoming;
    }
    mergeInvoicePaymentTracks(result.payment, chargeTracks);
    if (!storedPriceIds.length) result.payment.priceIds = incomingPriceIds;
    if (!storedUnitAmounts.length) result.payment.unitAmountMinorSnapshots = incomingUnitAmounts;
    for (const candidateChargeId of [...chargeIds, chargeId].filter(Boolean)) {
      result.payment.chargeIds.addToSet(candidateChargeId);
    }
    if (
      recoveryNotification
      && !notificationDeliveryIsOutstanding(result.payment.recoveryNotification?.state)
      && !['sent', 'superseded'].includes(String(result.payment.recoveryNotification?.state || ''))
    ) {
      result.payment.recoveryNotification = recoveryNotification;
    }
    if (stringId(eventId)) additions.completionEventIds = stringId(eventId);
    if (Object.keys(updates).length) Object.assign(result.payment, updates);
    if (additions.completionEventIds) {
      result.payment.completionEventIds.addToSet(additions.completionEventIds);
    }
    if (result.payment.isModified()) {
      await result.payment.save();
      if (updates.paymentIntentId) result.payment.paymentIntentId = updates.paymentIntentId;
      if (updates.stripeEventCreated !== undefined) {
        result.payment.stripeEventCreated = updates.stripeEventCreated;
      }
    }
  }

  if (newerThanFailure) {
    subscription.paymentRisk.latestSuccessfulInvoiceId = invoiceId;
    subscription.paymentRisk.latestSuccessfulPeriodStart = period.start;
    subscription.paymentRisk.latestSuccessfulEventCreated = safeMinor(eventCreated, 0);
  }
  if (
    recoveryEligible
    && recoveryFailureInvoiceId
    && stringId(subscription.paymentRisk?.failureNotification?.invoiceId) === recoveryFailureInvoiceId
    && String(subscription.paymentRisk?.failureNotification?.state || '') !== 'sent'
  ) {
    subscription.paymentRisk.failureNotification.state = 'superseded';
    subscription.paymentRisk.failureNotification.token = null;
    subscription.paymentRisk.failureNotification.completedAt = new Date();
  }
  if (!validated.pendingPlanChange && !stringId(subscription.stripePriceId)) {
    subscription.stripePriceId = validated.fundedPriceId;
  }
  if (!validated.pendingPlanChange && !stringId(subscription.stripeProductId)) {
    subscription.stripeProductId = validated.fundedProductId;
  }
  if (newerThanFailure || subscription.isModified()) await subscription.save();
  subscription = await recomputeSubscriptionEntitlement(subscription._id, { allowRestore: newerThanFailure });
  result.payment = await ensureSubscriptionPaymentNotificationOutboxed({
    payment: result.payment,
    subscription,
    invoiceId,
  });
  return {
    handled: true,
    created: result.created,
    payment: result.payment,
    previousStatus,
    subscription,
    notificationIntent: recoveryNotificationIntentFor(result.payment, subscription, invoiceId),
  };
};

const recordSubscriptionInvoiceFailure = async ({ invoice, eventId = '', eventCreated = 0 }) => {
  const resolved = await resolveInvoiceSubscription(invoice);
  if (!resolved.handled) return resolved;
  const { invoiceId, stripeSubscriptionId } = resolved;
  let { subscription } = resolved;
  invoice = await loadCompleteInvoiceLines(invoice);
  const validatedFailure = validateFailedSubscriptionInvoice({
    invoice,
    subscription,
    stripeSubscriptionId,
  });
  const { billingReason } = validatedFailure;
  const attempt = subscription.planChangeAttempt || {};
  const exactPendingUpdateFailure = Boolean(
    billingReason === 'subscription_update'
    && ['processing', 'pending_payment', 'recoverable'].includes(attempt.state)
    && stringId(attempt.stripeSubscriptionId) === stringId(subscription.stripeSubscriptionId)
    && stringId(attempt.stripeInvoiceId)
    && stringId(attempt.stripeInvoiceId) === invoiceId
  );

  // `pending_if_incomplete` subscription updates leave the already-paid base
  // subscription unchanged when their invoice fails. Treating that one-off
  // update invoice as a failed renewal would falsely suspend the paid base
  // plan and emit the controller's "store suspension" warning. This also
  // repairs rows written by the previous behavior when Stripe retries it.
  if (exactPendingUpdateFailure) {
    const repairsRecordedFailure = (
      subscription.paymentRisk?.latestFailureInvoiceId === invoiceId
    );
    if (repairsRecordedFailure) {
      subscription.paymentRisk.latestFailureInvoiceId = '';
      subscription.paymentRisk.latestFailurePeriodStart = null;
      subscription.paymentRisk.latestFailureEventCreated = 0;
      if (
        stringId(subscription.paymentRisk?.failureNotification?.invoiceId) === invoiceId
        && String(subscription.paymentRisk?.failureNotification?.state || '') !== 'sent'
      ) {
        subscription.paymentRisk.failureNotification.state = 'superseded';
        subscription.paymentRisk.failureNotification.token = null;
        subscription.paymentRisk.failureNotification.completedAt = new Date();
      }
      subscription.paymentRisk.updatedAt = new Date();
      await subscription.save();
      subscription = await recomputeSubscriptionEntitlement(subscription._id, { allowRestore: true });
    }
    return {
      handled: true,
      stale: true,
      nonRenewalFailure: true,
      repaired: repairsRecordedFailure,
      eventId: stringId(eventId),
      subscription,
    };
  }

  const period = invoicePeriod(invoice);
  const previousStart = subscription.paymentRisk?.latestFailurePeriodStart;
  const previousCreated = safeMinor(subscription.paymentRisk?.latestFailureEventCreated, 0);
  const successfulInvoiceId = stringId(subscription.paymentRisk?.latestSuccessfulInvoiceId);
  const successfulStart = subscription.paymentRisk?.latestSuccessfulPeriodStart;
  const successfulCreated = safeMinor(subscription.paymentRisk?.latestSuccessfulEventCreated, 0);
  const incomingCreated = safeMinor(eventCreated, 0);
  const duplicate = subscription.paymentRisk?.latestFailureInvoiceId === invoiceId;
  const staleAgainstFailure = previousStart && (
    period.start < previousStart
    || (period.start.getTime() === new Date(previousStart).getTime() && incomingCreated < previousCreated)
  );
  const staleAgainstSuccess = successfulStart && (
    successfulInvoiceId === invoiceId
    || period.start < successfulStart
    || (
      period.start.getTime() === new Date(successfulStart).getTime()
      && incomingCreated <= successfulCreated
    )
  );
  const stale = Boolean(staleAgainstFailure || staleAgainstSuccess);
  if (stale) return { handled: true, duplicate: false, stale: true, subscription };

  const { amountDueMinor, currency: failureCurrency } = validatedFailure;
  const failureOccurredAt = stripeSecondsDate(eventCreated) || period.start;
  if (duplicate) {
    const notification = subscription.paymentRisk?.failureNotification;
    if (stringId(notification?.invoiceId) === invoiceId) {
      if (
        (notification.amountDueMinor !== null
          && notification.amountDueMinor !== undefined
          && notification.amountDueMinor !== amountDueMinor)
        || (notification.currency && notification.currency !== failureCurrency)
      ) {
        throw entitlementError(
          'Stripe changed the immutable outstanding amount of a recorded failed subscription invoice.',
          'STRIPE_SUBSCRIPTION_FAILURE_MONEY_CHANGED',
        );
      }
      if (notification.amountDueMinor === null || notification.amountDueMinor === undefined) {
        notification.amountDueMinor = amountDueMinor;
      }
      if (!notification.currency) notification.currency = failureCurrency;
      if (!notification.occurredAt) notification.occurredAt = failureOccurredAt;
      if (subscription.isModified()) await subscription.save();
    }
    // The subscription risk marker is saved before its Store projection. If a
    // transient Store write fails, Stripe's retry must re-run the projection
    // instead of returning early forever with an active Store.
    subscription = await recomputeSubscriptionEntitlement(subscription._id, { allowRestore: false });
    return {
      handled: true,
      duplicate: true,
      stale: false,
      subscription,
      notificationIntent: failureNotificationIntentFor(subscription, invoiceId),
    };
  }
  subscription.paymentRisk.latestFailureInvoiceId = invoiceId;
  subscription.paymentRisk.latestFailurePeriodStart = period.start;
  subscription.paymentRisk.latestFailureEventCreated = incomingCreated;
  subscription.paymentRisk.failureNotification = pendingSubscriptionFailureNotification({
    invoiceId,
    eventId,
    stripeSubscriptionId: stringId(subscription.stripeSubscriptionId),
    planName: subscription.planName,
    amountDueMinor,
    currency: failureCurrency,
    occurredAt: failureOccurredAt,
  });
  subscription.paymentRisk.updatedAt = new Date();
  await subscription.save();
  const recomputed = await recomputeSubscriptionEntitlement(subscription._id, { allowRestore: false });
  return {
    handled: true,
    stale: false,
    eventId: stringId(eventId),
    subscription: recomputed,
    notificationIntent: failureNotificationIntentFor(recomputed, invoiceId),
  };
};

const retrieveInvoiceForCharge = async charge => {
  if (charge?.invoice && typeof charge.invoice === 'object') return charge.invoice;
  const invoiceId = stringId(charge?.invoice);
  if (!invoiceId || !stripe?.invoices?.retrieve) return null;
  return stripe.invoices.retrieve(invoiceId, {
    // Invoice.subscription was removed in Stripe's Basil API. Expand the
    // current parent identity so metadata-less historical Charges can still be
    // attributed without relying on deprecated response fields.
    expand: ['parent.subscription_details.subscription', 'lines.data'],
  });
};

const uniquePayments = payments => [...new Map(
  payments.filter(Boolean).map(payment => [stringId(payment._id), payment]),
).values()];

const resolveEntitlementPayments = async charge => {
  const paymentIntentId = stringId(charge?.payment_intent);
  const chargeId = stringId(charge?.id);
  let payments = await StripeEntitlementPayment.find({
    $or: [
      ...(paymentIntentId ? [{ paymentIntentId }] : []),
      ...(chargeId ? [{ chargeIds: chargeId }] : []),
      ...(paymentIntentId ? [{ 'chargeTracks.paymentIntentId': paymentIntentId }] : []),
      ...(chargeId ? [{ 'chargeTracks.chargeId': chargeId }] : []),
    ],
  });
  if (payments.length) return uniquePayments(payments);

  if (paymentIntentId) {
    const historicalStore = await Store.findOne({
      $or: [
        { 'subdomainPurchase.stripePaymentId': paymentIntentId },
        { 'subdomainPurchase.processedPaymentIds': paymentIntentId },
      ],
    });
    if (historicalStore) {
      await ensureSubdomainLegacyLedger(historicalStore);
      const payment = await StripeEntitlementPayment.findOne({
        entitlementType: 'subdomain',
        paymentIntentId,
      });
      if (payment) return [payment];
    }
  }

  const invoice = await retrieveInvoiceForCharge(charge);
  if (invoice) {
    const invoiceResult = await recordSubscriptionInvoicePayment({ invoice, incomingCharge: charge });
    if (invoiceResult.handled && !invoiceResult.zeroAmount) {
      const payment = await StripeEntitlementPayment.findOne({
        entitlementType: 'subscription',
        invoiceId: stringId(invoice.id),
      });
      return payment ? [payment] : [];
    }
    return [];
  }

  if (!paymentIntentId) return [];
  const associations = await listAllInvoicePayments({
    payment: {
      type: 'payment_intent',
      payment_intent: paymentIntentId,
    },
    status: 'paid',
  });
  if (!associations.length) {
    const customerId = stringId(charge?.customer);
    const localSubscription = customerId
      ? await SellerSubscription.findOne({ stripeCustomerId: customerId })
      : null;
    if (localSubscription) {
      throw entitlementError(
        'Stripe could not resolve a locally-owned Charge to its subscription invoice.',
        'STRIPE_SUBSCRIPTION_ASSOCIATION_UNRESOLVED',
        503,
      );
    }
    return [];
  }

  const invoiceIds = [...new Set(associations.map(row => stringId(row?.invoice)))];
  if (invoiceIds.some(id => !id)) {
    throw entitlementError(
      'Stripe linked the PaymentIntent to an Invoice Payment without an invoice ID.',
      'STRIPE_INVOICE_PAYMENT_ASSOCIATION_INVALID',
      503,
    );
  }
  if (!stripe?.invoices?.retrieve) {
    throw entitlementError(
      'Stripe invoice retrieval is unavailable; payment ownership cannot be verified.',
      'STRIPE_INVOICE_LOOKUP_UNAVAILABLE',
      503,
    );
  }
  const resolvedPayments = [];
  for (const invoiceId of invoiceIds) {
    const resolvedInvoice = await stripe.invoices.retrieve(invoiceId, {
      expand: ['parent.subscription_details.subscription', 'lines.data'],
    });
    if (!resolvedInvoice || stringId(resolvedInvoice.id) !== invoiceId) {
      throw entitlementError(
        'Stripe did not return the Invoice linked by its Invoice Payment association.',
        'STRIPE_INVOICE_PAYMENT_ASSOCIATION_INVALID',
        503,
      );
    }
    const invoicePaymentRows = await listAllInvoicePayments({ invoice: invoiceId, status: 'paid' });
    const invoiceResult = await recordSubscriptionInvoicePayment({
      invoice: resolvedInvoice,
      incomingCharge: charge,
      knownInvoicePayments: invoicePaymentRows,
    });
    if (!invoiceResult.handled || invoiceResult.zeroAmount) continue;
    const payment = await StripeEntitlementPayment.findOne({
      entitlementType: 'subscription',
      invoiceId,
    });
    if (payment) resolvedPayments.push(payment);
  }
  return uniquePayments(resolvedPayments);
};

const matchingChargeTracks = (payment, charge) => {
  const chargeId = stringId(charge?.id);
  const paymentIntentId = stringId(charge?.payment_intent);
  const tracks = chargeTracksOf(payment);
  const exactChargeTracks = tracks.filter(
    track => chargeId && stringId(track.chargeId) === chargeId,
  );
  const unboundIntentTracks = tracks.filter(track => (
    paymentIntentId
    && stringId(track.paymentIntentId) === paymentIntentId
    && !stringId(track.chargeId)
  ));
  const matches = exactChargeTracks.length
    ? [...exactChargeTracks, ...unboundIntentTracks]
    : tracks.filter(track => (
      paymentIntentId
      && stringId(track.paymentIntentId) === paymentIntentId
      && (!chargeId || !stringId(track.chargeId))
    ));
  return [...new Map(matches.map(track => [stringId(track.invoicePaymentId), track])).values()]
    .sort((left, right) => {
      const leftTime = new Date(left.paidAt || 0).getTime();
      const rightTime = new Date(right.paidAt || 0).getTime();
      return rightTime - leftTime
        || stringId(right.invoicePaymentId).localeCompare(stringId(left.invoicePaymentId));
    });
};

const matchingChargeCapacity = (payment, charge) => {
  const tracks = matchingChargeTracks(payment, charge);
  if (!tracks.length) return chargeTracksOf(payment).length ? 0 : capturedMinorOf(payment);
  return tracks.reduce((sum, track) => (
    Math.min(capturedMinorOf(payment), sum + safeMinor(track.capturedMinor, 0))
  ), 0);
};

const chargeAllocationCandidates = (payments, charge) => payments
    .map(payment => ({ payment, capacity: matchingChargeCapacity(payment, charge) }))
    .filter(candidate => candidate.capacity > 0)
    .sort((left, right) => (
      new Date(right.payment.grantStart).getTime() - new Date(left.payment.grantStart).getTime()
      || String(right.payment.sourceKey).localeCompare(String(left.payment.sourceKey))
    ));

const allocateChargeAmountAcrossPayments = (payments, charge, amount) => {
  let remaining = safeMinor(amount, 0);
  const candidates = chargeAllocationCandidates(payments, charge);
  const allocations = new Map();
  for (const candidate of candidates) {
    const allocated = Math.min(candidate.capacity, remaining);
    allocations.set(stringId(candidate.payment._id), allocated);
    remaining -= allocated;
  }
  return allocations;
};

const normalizeRiskOccurredAt = ({ eventOccurredAt, charge }) => {
  if (eventOccurredAt instanceof Date && Number.isFinite(eventOccurredAt.getTime())) {
    return new Date(eventOccurredAt);
  }
  const providerEventDate = stripeSecondsDate(eventOccurredAt);
  if (providerEventDate) return providerEventDate;
  const chargeCreatedDate = stripeSecondsDate(charge?.created);
  if (chargeCreatedDate) return chargeCreatedDate;
  // Direct internal repair calls predate provider event timestamps. Keep a
  // deterministic sentinel so their replay fingerprint remains stable; they
  // are deliberately not authorized to emit a seller-facing outcome below.
  return new Date(0);
};

const normalizedRefundEvidence = evidence => {
  if (evidence === null || evidence === undefined) return null;
  if (evidence?.complete !== true) {
    return {
      complete: false,
      reasonCode: String(evidence?.reasonCode || 'STRIPE_REFUND_EVIDENCE_INCOMPLETE').slice(0, 100),
      reason: String(evidence?.reason || 'Stripe refund evidence was incomplete.').slice(0, 500),
      refunds: [],
    };
  }
  const refunds = [...(evidence.refunds || [])].map(refund => ({
    refundId: stringId(refund?.refundId),
    amountMinor: safeMinor(refund?.amountMinor),
    currency: String(refund?.currency || '').trim().toUpperCase(),
    createdAt: refund?.createdAt instanceof Date
      ? new Date(refund.createdAt)
      : new Date(refund?.createdAt),
  })).sort((left, right) => (
    left.createdAt.getTime() - right.createdAt.getTime()
    || left.refundId.localeCompare(right.refundId)
  ));
  if (
    refunds.some(refund => (
      !/^re_[A-Za-z0-9_]+$/.test(refund.refundId)
      || refund.amountMinor <= 0
      || refund.currency !== 'USD'
      || !Number.isFinite(refund.createdAt.getTime())
    ))
    || new Set(refunds.map(refund => refund.refundId)).size !== refunds.length
  ) {
    return {
      complete: false,
      reasonCode: 'STRIPE_ENTITLEMENT_REFUND_EVIDENCE_INVALID',
      reason: 'Provider refund objects were malformed, duplicated, or did not use the entitlement currency.',
      refunds: [],
    };
  }
  const totalMinor = refunds.reduce((sum, refund) => sum + refund.amountMinor, 0);
  if (!Number.isSafeInteger(totalMinor) || totalMinor !== safeMinor(evidence.totalMinor, 0)) {
    return {
      complete: false,
      reasonCode: 'STRIPE_ENTITLEMENT_REFUND_EVIDENCE_TOTAL_INVALID',
      reason: 'Provider refund objects did not conserve the reported cumulative refund amount.',
      refunds: [],
    };
  }
  return { complete: true, refunds, totalMinor };
};

/**
 * Allocate each immutable Refund object across entitlement contributions in
 * the same deterministic order used for cumulative accounting. A Refund may
 * legitimately straddle two Invoice Payment rows, so each row stores only its
 * exact provider-backed slice.
 */
const allocateRefundEvidenceAcrossPayments = (payments, charge, evidence) => {
  const candidates = chargeAllocationCandidates(payments, charge).map(candidate => ({
    ...candidate,
    used: 0,
  }));
  const allocations = new Map(candidates.map(candidate => [
    stringId(candidate.payment._id),
    [],
  ]));
  let unallocatedMinor = 0;
  for (const refund of evidence.refunds) {
    let remaining = refund.amountMinor;
    for (const candidate of candidates) {
      if (remaining <= 0) break;
      const available = candidate.capacity - candidate.used;
      if (available <= 0) continue;
      const amountMinor = Math.min(available, remaining);
      allocations.get(stringId(candidate.payment._id)).push({
        refundId: refund.refundId,
        amountMinor,
        createdAt: refund.createdAt,
      });
      candidate.used += amountMinor;
      remaining -= amountMinor;
    }
    unallocatedMinor += remaining;
  }
  return { allocations, unallocatedMinor };
};

const trimPreviouslyAppliedRefundEvidence = (entries, priorMinor, deltaMinor) => {
  let skip = safeMinor(priorMinor, 0);
  let remainingDelta = safeMinor(deltaMinor, 0);
  const result = [];
  for (const entry of entries || []) {
    if (remainingDelta <= 0) break;
    const availableAfterSkip = Math.max(0, entry.amountMinor - Math.min(skip, entry.amountMinor));
    skip = Math.max(0, skip - entry.amountMinor);
    if (availableAfterSkip <= 0) continue;
    const amountMinor = Math.min(availableAfterSkip, remainingDelta);
    result.push({
      refundId: entry.refundId,
      amountMinor,
      createdAt: entry.createdAt,
    });
    remainingDelta -= amountMinor;
  }
  return remainingDelta === 0 ? result : null;
};

const riskEventFingerprint = ({
  eventId,
  eventType,
  occurredAt,
  charge,
  allocatedRefundMinor,
  allocatedDisputeMinor,
  refundEvidence,
}) => crypto.createHash('sha256').update(JSON.stringify({
  schemaVersion: 1,
  eventId,
  eventType,
  occurredAt: occurredAt.toISOString(),
  chargeId: stringId(charge?.id),
  paymentIntentId: stringId(charge?.payment_intent),
  chargeAmountMinor: safeMinor(charge?.amount, 0),
  chargeCurrency: String(charge?.currency || '').trim().toLowerCase(),
  cumulativeRefundMinor: safeMinor(charge?.amount_refunded, 0),
  allocatedRefundMinor: safeMinor(allocatedRefundMinor, 0),
  disputeId: stringId(charge?.disputeId),
  disputeStatus: String(charge?.disputeStatus || '').trim().toLowerCase(),
  allocatedDisputeMinor: safeMinor(allocatedDisputeMinor, 0),
  refundEvidence: refundEvidence === null ? null : {
    complete: refundEvidence.complete,
    reasonCode: refundEvidence.reasonCode || '',
    refunds: (refundEvidence.refunds || []).map(refund => ({
      refundId: refund.refundId,
      amountMinor: refund.amountMinor,
      currency: refund.currency,
      createdAt: refund.createdAt.toISOString(),
    })),
  },
})).digest('hex');

const mutateRiskPayment = async (paymentId, mutation) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const payment = await StripeEntitlementPayment.findById(paymentId);
    if (!payment) return null;
    try {
      const changed = mutation(payment);
      if (!changed) return payment;
      await payment.save();
      return payment;
    } catch (error) {
      if (error?.name !== 'VersionError' || attempt === 4) throw error;
    }
  }
  return null;
};

const applyEntitlementRiskEvent = async ({
  payment,
  charge,
  eventId,
  eventType,
  allocatedRefundMinor = 0,
  allocatedDisputeMinor = 0,
  occurredAt,
  eventFingerprint,
  providerRefundEvidence = [],
  notificationAuthorized = false,
}) => {
  const normalizedEventId = stringId(eventId);
  const normalizedChargeId = stringId(charge?.id);
  const normalizedPaymentIntentId = stringId(charge?.payment_intent);
  const disputeId = stringId(charge?.disputeId);
  const disputeStatus = String(charge?.disputeStatus || '').trim().toLowerCase();
  const disputeMinor = safeMinor(allocatedDisputeMinor, 0);
  const cumulativeRefundMinor = safeMinor(allocatedRefundMinor, 0);
  if (!normalizedEventId || !normalizedChargeId || !normalizedPaymentIntentId) {
    throw entitlementError(
      'Stripe entitlement risk event ownership references are incomplete.',
      'STRIPE_ENTITLEMENT_RISK_REFERENCE_MISSING',
      400,
    );
  }

  return mutateRiskPayment(payment._id, draft => {
    if (draft.processedRiskEventIds.includes(normalizedEventId)) {
      const evidence = draft.riskEventEvidence?.find(entry => entry.eventId === normalizedEventId);
      if (!evidence || evidence.fingerprint !== eventFingerprint) {
        throw entitlementError(
          'A Stripe entitlement event id was replayed with different or missing provider evidence.',
          'STRIPE_ENTITLEMENT_RISK_IDEMPOTENCY_CONFLICT',
        );
      }
      return false;
    }
    let changed = false;
    let notificationKind = null;
    let notificationDisputeState = null;
    let notificationAmountMinor = 0;
    let notificationRefunds = [];
    if (eventType === 'charge.refunded') {
      if (notificationAuthorized) {
        const priorProviderAmounts = new Map();
        for (const evidence of draft.riskEventEvidence || []) {
          for (const refund of evidence.providerRefunds || []) {
            const prior = priorProviderAmounts.get(refund.refundId);
            if (prior !== undefined && prior !== refund.amountMinor) {
              throw entitlementError(
                'Stored Stripe Refund evidence contains conflicting immutable amounts.',
                'STRIPE_ENTITLEMENT_REFUND_EVIDENCE_CONFLICT',
              );
            }
            priorProviderAmounts.set(refund.refundId, refund.amountMinor);
          }
        }
        const currentProviderAmounts = new Map(
          providerRefundEvidence.map(refund => [refund.refundId, refund.amountMinor]),
        );
        for (const [refundId, priorAmount] of priorProviderAmounts) {
          if (currentProviderAmounts.get(refundId) !== priorAmount) {
            throw entitlementError(
              'Stripe changed or omitted an immutable Refund object across complete Charge deliveries.',
              'STRIPE_ENTITLEMENT_REFUND_EVIDENCE_CONFLICT',
            );
          }
        }
      }
      const priorRefundedMinor = safeMinor(draft.refundedMinor, 0);
      const chargeTracks = matchingChargeTracks(draft, charge);
      if (chargeTracks.length) {
        let remainingRefund = cumulativeRefundMinor;
        for (const chargeTrack of chargeTracks) {
          const didBindCharge = Boolean(!chargeTrack.chargeId && charge?.id);
          if (didBindCharge) chargeTrack.chargeId = stringId(charge.id);
          const desiredRefund = Math.min(
            safeMinor(chargeTrack.capturedMinor, 0),
            remainingRefund,
          );
          remainingRefund -= desiredRefund;
          const priorRefund = safeMinor(chargeTrack.refundedMinor, 0);
          const nextRefund = Math.max(priorRefund, desiredRefund);
          changed = changed || didBindCharge || nextRefund !== priorRefund;
          chargeTrack.refundedMinor = nextRefund;
        }
        syncPaymentTrackAggregates(draft);
      } else {
        const captured = capturedMinorOf(draft);
        const nextRefund = Math.min(
          captured,
          Math.max(safeMinor(draft.refundedMinor, 0), cumulativeRefundMinor),
        );
        changed = nextRefund !== safeMinor(draft.refundedMinor, 0);
        draft.refundedMinor = nextRefund;
      }
      const refundDeltaMinor = safeMinor(draft.refundedMinor, 0) - priorRefundedMinor;
      if (notificationAuthorized && refundDeltaMinor > 0) {
        notificationRefunds = trimPreviouslyAppliedRefundEvidence(
          providerRefundEvidence,
          priorRefundedMinor,
          refundDeltaMinor,
        );
        if (!notificationRefunds) {
          throw entitlementError(
            'Provider Refund evidence could not be conserved to the entitlement refund delta.',
            'STRIPE_ENTITLEMENT_REFUND_EVIDENCE_ALLOCATION_INVALID',
          );
        }
        notificationKind = 'refund';
        notificationAmountMinor = refundDeltaMinor;
      }
    } else if (eventType.startsWith('charge.dispute.')) {
      if (!disputeId) {
        const error = new Error('Stripe entitlement dispute is missing its dispute ID.');
        error.code = 'STRIPE_ENTITLEMENT_DISPUTE_REFERENCE_MISSING';
        error.statusCode = 400;
        throw error;
      }
      if (!draft.disputes.length && draft.disputeId) {
        draft.disputes.push({
          disputeId: draft.disputeId,
          status: draft.disputeStatus,
          state: draft.disputeState === 'none' ? 'inquiry' : draft.disputeState,
          amountMinor: safeMinor(draft.disputeAmountMinor, 0),
          terminalAt: draft.disputeTerminalAt,
          processedEventIds: [],
          lastEventAt: draft.lastRiskEventAt,
        });
      }
      for (const chargeTrack of matchingChargeTracks(draft, charge)) {
        if (!chargeTrack.chargeId && charge?.id) {
          chargeTrack.chargeId = stringId(charge.id);
          changed = true;
        }
      }
      syncPaymentTrackAggregates(draft);
      let track = draft.disputes.find(dispute => dispute.disputeId === disputeId);
      const priorTrackState = track?.state || null;
      const priorTrackAmountMinor = safeMinor(track?.amountMinor, 0);
      if (!track) {
        draft.disputes.push({
          disputeId,
          chargeId: stringId(charge?.id),
          state: 'inquiry',
          status: '',
          amountMinor: 0,
        });
        track = draft.disputes[draft.disputes.length - 1];
      }
      if (track.chargeId && stringId(charge?.id) && track.chargeId !== stringId(charge.id)) {
        throw entitlementError(
          'Stripe dispute identity changed Charges across webhook deliveries.',
          'STRIPE_ENTITLEMENT_DISPUTE_REFERENCE_INVALID',
        );
      }
      if (!track.chargeId && charge?.id) track.chargeId = stringId(charge.id);
      const chargeCapacity = matchingChargeCapacity(draft, charge) || capturedMinorOf(draft);
      const resolvesWon = eventType === 'charge.dispute.funds_reinstated' || disputeStatus === 'won';
      const terminal = ['won', 'lost'].includes(track.state);
      if (
        priorTrackAmountMinor > 0
        && disputeMinor > 0
        && Math.min(chargeCapacity, disputeMinor) !== priorTrackAmountMinor
      ) {
        throw entitlementError(
          'Stripe changed the immutable amount assigned to an existing entitlement dispute.',
          'STRIPE_ENTITLEMENT_DISPUTE_AMOUNT_CHANGED',
        );
      }
      // Stripe can report a rare late win after an initially lost dispute.
      // Accept that one-way recovery, but never let a delayed loss overwrite a
      // dispute that Stripe already finalized as won.
      if (track.state === 'lost' && resolvesWon) {
        track.status = disputeStatus || 'won';
        track.state = 'won';
        track.amountMinor = 0;
        track.terminalAt = occurredAt;
        changed = true;
      } else if (!terminal) {
        if (resolvesWon) {
          track.status = disputeStatus || 'won';
          track.state = 'won';
          track.amountMinor = 0;
          track.terminalAt = occurredAt;
          changed = true;
        } else if (disputeStatus === 'lost') {
          track.status = 'lost';
          track.state = 'lost';
          track.amountMinor = Math.min(chargeCapacity, disputeMinor);
          track.terminalAt = occurredAt;
          changed = true;
        } else if (
          eventType === 'charge.dispute.funds_withdrawn'
          || (eventType === 'charge.dispute.created' && FINANCIAL_DISPUTE_STATUSES.has(disputeStatus))
        ) {
          track.status = disputeStatus;
          track.state = 'open';
          track.amountMinor = Math.min(
            chargeCapacity,
            Math.max(safeMinor(track.amountMinor, 0), disputeMinor),
          );
          changed = true;
        } else if (INQUIRY_DISPUTE_STATUSES.has(disputeStatus) && track.state === 'inquiry') {
          track.status = disputeStatus;
          changed = true;
        }
      }
      track.processedEventIds.addToSet(normalizedEventId);
      track.lastEventAt = occurredAt;

      if (notificationAuthorized) {
        if (track.state === 'won' && priorTrackState !== 'won') {
          notificationKind = 'dispute_won';
          notificationDisputeState = 'won';
          notificationAmountMinor = Math.min(
            chargeCapacity,
            priorTrackAmountMinor || disputeMinor,
          );
        } else if (track.state === 'lost' && priorTrackState !== 'lost') {
          notificationKind = 'dispute_lost';
          notificationDisputeState = 'lost';
          notificationAmountMinor = safeMinor(track.amountMinor, 0);
        } else if (
          ['inquiry', 'open'].includes(track.state)
          && priorTrackState !== track.state
          && (
            INQUIRY_DISPUTE_STATUSES.has(disputeStatus)
            || eventType === 'charge.dispute.funds_withdrawn'
            || FINANCIAL_DISPUTE_STATUSES.has(disputeStatus)
          )
        ) {
          notificationKind = 'dispute_opened';
          notificationDisputeState = track.state;
          notificationAmountMinor = track.state === 'open'
            ? safeMinor(track.amountMinor, 0)
            : Math.min(chargeCapacity, disputeMinor);
        }
        if (notificationKind && notificationAmountMinor <= 0) {
          throw entitlementError(
            'Stripe dispute outcome evidence has no positive entitlement allocation.',
            'STRIPE_ENTITLEMENT_DISPUTE_EVIDENCE_INVALID',
          );
        }
      }

      const openTracks = draft.disputes.filter(dispute => dispute.state === 'open');
      const lostTracks = draft.disputes.filter(dispute => dispute.state === 'lost');
      const wonTracks = draft.disputes.filter(dispute => dispute.state === 'won');
      const inquiryTracks = draft.disputes.filter(dispute => dispute.state === 'inquiry');
      draft.riskSuspended = openTracks.length > 0;
      draft.disputeId = disputeId;
      draft.disputeStatus = track.status;
      if (openTracks.length) {
        draft.disputeState = 'open';
        draft.disputeAmountMinor = Math.min(
          capturedMinorOf(draft),
          openTracks.reduce((sum, dispute) => sum + safeMinor(dispute.amountMinor, 0), 0),
        );
      } else if (lostTracks.length) {
        draft.disputeState = 'lost';
        draft.disputeAmountMinor = Math.min(
          capturedMinorOf(draft),
          lostTracks.reduce((sum, dispute) => sum + safeMinor(dispute.amountMinor, 0), 0),
        );
      } else if (wonTracks.length) {
        draft.disputeState = 'won';
        draft.disputeAmountMinor = 0;
      } else if (inquiryTracks.length) {
        draft.disputeState = 'inquiry';
        draft.disputeAmountMinor = 0;
      }
      draft.disputeTerminalAt = track.terminalAt || null;
    }
    draft.processedRiskEventIds.addToSet(normalizedEventId);
    draft.riskEventEvidence.push({
      eventId: normalizedEventId,
      eventType,
      occurredAt,
      chargeId: normalizedChargeId,
      paymentIntentId: normalizedPaymentIntentId,
      fingerprint: eventFingerprint,
      providerRefunds: providerRefundEvidence,
    });
    if (notificationKind) {
      draft.riskNotificationIntents.push({
        intentKey: crypto.createHash('sha256')
          .update(`${normalizedEventId}:${notificationKind}`)
          .digest('hex'),
        eventId: normalizedEventId,
        eventType,
        kind: notificationKind,
        disputeState: notificationDisputeState,
        occurredAt,
        chargeId: normalizedChargeId,
        paymentIntentId: normalizedPaymentIntentId,
        disputeId: notificationKind === 'refund' ? '' : disputeId,
        amountMinor: notificationAmountMinor,
        currency: draft.currency,
        providerRefunds: notificationRefunds,
        state: 'pending',
        outboxEnqueuedAt: null,
      });
    }
    draft.lastRiskEventAt = occurredAt;
    if (charge?.id) draft.chargeIds.addToSet(stringId(charge.id));
    return changed || Boolean(normalizedEventId);
  });
};

const syncStripeSubscriptionPause = async (subscription, shouldPause, allowRestore) => {
  const stripeSubscriptionId = stringId(subscription?.stripeSubscriptionId);
  if (!stripeSubscriptionId || !stripe?.subscriptions?.update) return;
  if (shouldPause) {
    if (stripe?.subscriptions?.retrieve) {
      const remote = await retrieveStripeSubscriptionIfPresent(stripeSubscriptionId);
      if (
        !remote
        || remote.id !== stripeSubscriptionId
        || ['canceled', 'incomplete_expired'].includes(String(remote.status || ''))
      ) return;
    }
    await stripe.subscriptions.update(stripeSubscriptionId, {
      pause_collection: { behavior: 'void' },
    });
    return;
  }
  if (!allowRestore || !stripe?.subscriptions?.retrieve) return;
  const remote = await retrieveStripeSubscriptionIfPresent(stripeSubscriptionId);
  if (!remote || remote.id !== stripeSubscriptionId || !ACTIVE_STRIPE_SUBSCRIPTION_STATUSES.has(remote.status)) return;
  await stripe.subscriptions.update(stripeSubscriptionId, { pause_collection: '' });
};

const finalizeEntitlementRiskUpdate = async ({ updated, charge, eventType }) => {
  if (!updated) return null;

  if (updated.entitlementType === 'subdomain') {
    const store = await recomputeSubdomainEntitlement(updated.store);
    return { handled: true, sourceType: 'subdomain_purchase', payment: updated, store };
  }

  const eventDisputeId = stringId(charge?.disputeId);
  const eventTrack = updated.disputes?.find(dispute => dispute.disputeId === eventDisputeId);
  const terminalResolved = Boolean(eventTrack && ['won', 'lost'].includes(eventTrack.state));
  // Recompute terminal loss eligibility after every terminal dispute
  // resolution, not only after the event that marked one dispute lost. With
  // multiple disputes, a loss can remain hidden behind another open track; if
  // that second track is later won, the aggregate ledger may still have no
  // coverage and must release the transient Checkout lock.
  const terminalRiskEvent = eventType === 'charge.refunded' || terminalResolved;
  const subscriptionIdentity = await SellerSubscription.findOne({
      seller: updated.seller,
      stripeSubscriptionId: updated.stripeSubscriptionId,
    }).select('_id stripeSubscriptionId');
  let remoteActive = false;
  if (terminalResolved && subscriptionIdentity && stripe?.subscriptions?.retrieve) {
    const remote = await retrieveStripeSubscriptionIfPresent(updated.stripeSubscriptionId);
    remoteActive = Boolean(
      remote
      && remote.id === updated.stripeSubscriptionId
      && ACTIVE_STRIPE_SUBSCRIPTION_STATUSES.has(remote.status),
    );
  }
  const subscription = await recomputeSubscriptionEntitlement(
    subscriptionIdentity?._id,
    {
      allowRestore: terminalResolved && remoteActive,
      terminalRiskEvent,
      syncFundedPlan: terminalRiskEvent,
    },
  );
  if (!subscription) return { handled: true, sourceType: 'subscription_invoice', payment: updated, stale: true };
  const terminalPaymentBlock = subscription.status === 'blocked'
    && !subscription.paymentRisk?.suspended
    && String(subscription.blockedReason || '').startsWith('Stripe payment reversal');
  await syncStripeSubscriptionPause(
    subscription,
    Boolean(subscription.paymentRisk?.suspended) || terminalPaymentBlock,
    terminalResolved && remoteActive && !subscription.paymentRisk?.suspended,
  );
  return { handled: true, sourceType: 'subscription_invoice', payment: updated, subscription };
};

const providerEventTimestampPresent = ({ eventOccurredAt, charge }) => (
  (eventOccurredAt instanceof Date && Number.isFinite(eventOccurredAt.getTime()))
  || (Number.isSafeInteger(eventOccurredAt) && eventOccurredAt > 0)
  || (Number.isSafeInteger(charge?.created) && charge.created > 0)
);

const entitlementSourceType = payment => (
  payment?.entitlementType === 'subdomain' ? 'subdomain_purchase' : 'subscription_invoice'
);

const recordEntitlementRiskEvidenceReview = async ({
  payment,
  charge,
  eventId,
  eventType,
  occurredAt,
  reasonCode,
  reason,
}) => recordStripePaymentRiskManualReview({
  stripeEventId: eventId,
  stripeEventType: eventType,
  occurredAt,
  sourceType: entitlementSourceType(payment),
  sourceReferenceId: stringId(payment?._id),
  paymentIntentId: stringId(charge?.payment_intent),
  chargeId: stringId(charge?.id),
  reasonCode,
  reason,
  currency: String(charge?.currency || '').trim().toUpperCase(),
  chargeAmountMinor: safeMinor(charge?.amount, 0),
  refundExposureMinor: safeMinor(charge?.amount_refunded, 0),
  disputeId: stringId(charge?.disputeId),
  disputeStatus: String(charge?.disputeStatus || '').trim().toLowerCase(),
  disputeExposureMinor: safeMinor(charge?.disputeAmount, 0),
});

const flagStripeEntitlementPaymentRisk = async ({
  charge,
  eventId,
  eventType,
  eventOccurredAt = null,
  refundEvidence = null,
}) => {
  const payments = await resolveEntitlementPayments(charge);
  if (!payments.length) return null;
  const normalizedEventId = stringId(eventId);
  if (!normalizedEventId || !String(eventType || '').trim()) {
    throw entitlementError(
      'Stripe entitlement risk event identity is incomplete.',
      'STRIPE_ENTITLEMENT_RISK_EVENT_INVALID',
      400,
    );
  }
  const sellerIds = new Set(payments.map(payment => stringId(payment.seller)));
  const entitlementTypes = new Set(payments.map(payment => payment.entitlementType));
  if (sellerIds.size !== 1 || sellerIds.has('') || entitlementTypes.size !== 1) {
    throw entitlementError(
      'A Stripe Charge resolved to conflicting entitlement owners.',
      'STRIPE_ENTITLEMENT_RISK_OWNER_AMBIGUOUS',
    );
  }
  const chargeCurrency = String(charge?.currency || '').trim().toLowerCase();
  if (chargeCurrency !== 'usd' || payments.some(payment => payment.currency !== chargeCurrency)) {
    throw entitlementError(
      'Stripe entitlement risk currency does not match the funded ledger.',
      'STRIPE_ENTITLEMENT_RISK_CURRENCY_MISMATCH',
    );
  }
  const metadataType = String(charge?.metadata?.type || '').trim();
  const metadataSellerId = stringId(charge?.metadata?.sellerId);
  const metadataStoreId = stringId(charge?.metadata?.storeId);
  const expectedMetadataType = payments[0].entitlementType === 'subdomain'
    ? 'subdomain_purchase'
    : 'subscription_invoice';
  if (
    (['subdomain_purchase', 'subscription_invoice'].includes(metadataType)
      && metadataType !== expectedMetadataType)
    || (metadataSellerId && metadataSellerId !== [...sellerIds][0])
    || (
      metadataStoreId
      && payments.some(payment => stringId(payment.store) !== metadataStoreId)
    )
  ) {
    throw entitlementError(
      'Stripe entitlement risk metadata conflicts with the durable owner.',
      'STRIPE_ENTITLEMENT_RISK_OWNER_MISMATCH',
    );
  }

  const occurredAt = normalizeRiskOccurredAt({ eventOccurredAt, charge });
  const providerContext = providerEventTimestampPresent({ eventOccurredAt, charge });
  const normalizedEvidence = normalizedRefundEvidence(refundEvidence);
  let reviewReason = null;
  const refundAllocations = allocateChargeAmountAcrossPayments(
    payments,
    charge,
    safeMinor(charge?.amount_refunded, 0),
  );
  const disputeAllocations = allocateChargeAmountAcrossPayments(
    payments,
    charge,
    safeMinor(charge?.disputeAmount, 0),
  );
  const chargeCapacity = chargeAllocationCandidates(payments, charge).reduce(
    (sum, candidate) => sum + candidate.capacity,
    0,
  );
  const chargeAmountMinor = safeMinor(charge?.amount, 0);
  if (providerContext && (chargeAmountMinor <= 0 || chargeCapacity !== chargeAmountMinor)) {
    reviewReason = {
      reasonCode: 'STRIPE_ENTITLEMENT_CHARGE_ALLOCATION_MISMATCH',
      reason: 'The signed Charge amount did not exactly conserve to its resolved entitlement ledger contributions.',
    };
  }

  let providerRefundAllocations = new Map();
  if (eventType === 'charge.refunded' && providerContext) {
    if (!normalizedEvidence?.complete) {
      reviewReason = {
        reasonCode: normalizedEvidence?.reasonCode || 'STRIPE_ENTITLEMENT_REFUND_EVIDENCE_MISSING',
        reason: normalizedEvidence?.reason
          || 'The signed Charge did not contain complete provider Refund objects for an exact seller receipt.',
      };
    } else if (normalizedEvidence.totalMinor !== safeMinor(charge?.amount_refunded, 0)) {
      reviewReason = {
        reasonCode: 'STRIPE_ENTITLEMENT_REFUND_EVIDENCE_TOTAL_MISMATCH',
        reason: 'Provider Refund objects did not equal the signed Charge cumulative refund exposure.',
      };
    } else {
      const evidenceAllocation = allocateRefundEvidenceAcrossPayments(
        payments,
        charge,
        normalizedEvidence,
      );
      providerRefundAllocations = evidenceAllocation.allocations;
      if (evidenceAllocation.unallocatedMinor !== 0) {
        reviewReason = {
          reasonCode: 'STRIPE_ENTITLEMENT_REFUND_OWNER_AMBIGUOUS',
          reason: 'Provider Refund money could not be fully allocated to the resolved entitlement owner.',
        };
      }
    }
  }

  if (eventType.startsWith('charge.dispute.') && providerContext) {
    const exposure = safeMinor(charge?.disputeAmount, 0);
    const allocated = [...disputeAllocations.values()].reduce((sum, value) => sum + value, 0);
    if (exposure <= 0 || allocated !== exposure) {
      reviewReason = {
        reasonCode: 'STRIPE_ENTITLEMENT_DISPUTE_OWNER_AMBIGUOUS',
        reason: 'The signed dispute exposure could not be fully allocated to the resolved entitlement owner.',
      };
    }
  }

  const results = [];
  for (const payment of payments) {
    const paymentKey = stringId(payment._id);
    const allocatedRefundMinor = refundAllocations.get(paymentKey) ?? 0;
    const allocatedDisputeMinor = disputeAllocations.get(paymentKey) ?? 0;
    const hasExistingDispute = payment.disputes?.some(
      dispute => dispute.disputeId === stringId(charge?.disputeId),
    );
    if (
      eventType.startsWith('charge.dispute.')
      && allocatedDisputeMinor === 0
      && !hasExistingDispute
    ) continue;
    const updated = await applyEntitlementRiskEvent({
      payment,
      charge,
      eventId,
      eventType,
      allocatedRefundMinor,
      allocatedDisputeMinor,
      occurredAt,
      eventFingerprint: riskEventFingerprint({
        eventId: normalizedEventId,
        eventType,
        occurredAt,
        charge,
        allocatedRefundMinor,
        allocatedDisputeMinor,
        refundEvidence: normalizedEvidence,
      }),
      providerRefundEvidence: providerRefundAllocations.get(paymentKey) || [],
      notificationAuthorized: providerContext && !reviewReason && (
        eventType !== 'charge.refunded' || normalizedEvidence?.complete === true
      ),
    });
    const result = await finalizeEntitlementRiskUpdate({ updated, charge, eventType });
    if (result) {
      if (!reviewReason) {
        result.payment = await ensureStripeEntitlementRiskNotificationsOutboxed(updated);
      }
      results.push(result);
    }
  }
  let manualReview = null;
  if (reviewReason && providerContext) {
    manualReview = await recordEntitlementRiskEvidenceReview({
      payment: payments[0],
      charge,
      eventId: normalizedEventId,
      eventType,
      occurredAt,
      ...reviewReason,
    });
  }
  if (!results.length) {
    return {
      handled: true,
      sourceType: entitlementSourceType(payments[0]),
      duplicate: true,
      ...(manualReview ? { manualReview: manualReview.review } : {}),
    };
  }
  const response = results.length === 1
    ? results[0]
    : { handled: true, sourceType: 'subscription_invoice', results };
  if (manualReview) response.manualReview = manualReview.review;
  return response;
};

module.exports = {
  LEGACY_SUBDOMAIN_GRANT_MS,
  SUBDOMAIN_PRICE_MINOR,
  aggregateSubdomainPayments,
  effectiveDurationMs,
  ensureSubdomainLegacyLedger,
  flagStripeEntitlementPaymentRisk,
  invoicePeriod,
  invoiceSubscriptionId,
  recomputeSubdomainEntitlement,
  recomputeSubscriptionEntitlement,
  recordSubdomainCheckoutPayment,
  recordSubscriptionInvoiceFailure,
  recordSubscriptionInvoicePayment,
};
