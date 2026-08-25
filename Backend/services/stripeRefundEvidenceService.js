'use strict';

const STRIPE_REFUND_PAGE_SIZE = 100;
const STRIPE_REFUND_MAX_EVIDENCE_OBJECTS = 10_000;

const refundEvidenceError = (message, code) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 503;
  return error;
};

const stripeId = value => (
  typeof value === 'string' ? value.trim() : (typeof value?.id === 'string' ? value.id.trim() : '')
);

const succeededRefundMinor = refunds => {
  let total = 0;
  for (const refund of refunds) {
    if (String(refund?.status || '') !== 'succeeded') continue;
    if (!Number.isSafeInteger(refund?.amount) || refund.amount <= 0) {
      throw refundEvidenceError(
        'Stripe returned malformed succeeded Refund money while hydrating provider evidence.',
        'STRIPE_REFUND_EVIDENCE_PAGE_INVALID',
      );
    }
    total += refund.amount;
    if (!Number.isSafeInteger(total)) {
      throw refundEvidenceError(
        'Stripe Refund evidence exceeds safe integer accounting limits.',
        'STRIPE_REFUND_EVIDENCE_TOTAL_INVALID',
      );
    }
  }
  return total;
};

/**
 * Charge.refunds embeds only a limited first page. Hydrate every Refund that
 * existed by the signed event timestamp before accounting or notifying. The
 * final succeeded-refund sum must equal the Charge snapshot exactly; a newer
 * or changing provider snapshot is retried/manual-reviewed rather than guessed.
 */
async function hydrateStripeChargeRefundEvidence({
  stripe,
  charge,
  eventCreatedAt,
  maxRefunds = STRIPE_REFUND_MAX_EVIDENCE_OBJECTS,
} = {}) {
  const cumulativeMinor = charge?.amount_refunded;
  if (!Number.isSafeInteger(maxRefunds) || maxRefunds < 1) {
    throw new RangeError('Stripe Refund evidence maxRefunds must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(cumulativeMinor) || cumulativeMinor <= 0) {
    throw refundEvidenceError(
      'The signed refunded Charge has an invalid cumulative refund snapshot.',
      'STRIPE_REFUND_EVIDENCE_SNAPSHOT_INVALID',
    );
  }
  if (!Number.isSafeInteger(eventCreatedAt) || eventCreatedAt <= 0) {
    throw refundEvidenceError(
      'The signed Stripe event timestamp is invalid for Refund evidence hydration.',
      'STRIPE_REFUND_EVIDENCE_EVENT_TIME_INVALID',
    );
  }
  const chargeId = stripeId(charge?.id);
  if (!/^ch_[A-Za-z0-9_]+$/.test(chargeId)) {
    throw refundEvidenceError(
      'The Charge id is invalid for Refund evidence hydration.',
      'STRIPE_REFUND_EVIDENCE_CHARGE_INVALID',
    );
  }

  const refunds = [];
  const seen = new Set();
  const appendRefunds = entries => {
    for (const refund of entries) {
      const refundId = stripeId(refund?.id);
      if (!/^re_[A-Za-z0-9_]+$/.test(refundId) || seen.has(refundId)) {
        throw refundEvidenceError(
          'Stripe Refund evidence contained an invalid or duplicate Refund id.',
          'STRIPE_REFUND_EVIDENCE_PAGE_INVALID',
        );
      }
      seen.add(refundId);
      refunds.push(refund);
      if (refunds.length > maxRefunds) {
        throw refundEvidenceError(
          'Stripe Refund evidence exceeded the bounded hydration limit.',
          'STRIPE_REFUND_EVIDENCE_LIMIT_EXCEEDED',
        );
      }
    }
    return succeededRefundMinor(refunds);
  };

  if (Array.isArray(charge?.refunds?.data) && charge.refunds.has_more === false) {
    const succeededMinor = appendRefunds(charge.refunds.data);
    if (succeededMinor !== cumulativeMinor) {
      throw refundEvidenceError(
        'Embedded Stripe Refund objects do not exactly equal the signed Charge refund snapshot.',
        'STRIPE_REFUND_EVIDENCE_SNAPSHOT_MISMATCH',
      );
    }
    return charge;
  }
  if (!stripe?.refunds || typeof stripe.refunds.list !== 'function') {
    throw refundEvidenceError(
      'Stripe Refund listing is unavailable for incomplete Charge evidence.',
      'STRIPE_REFUND_EVIDENCE_PROVIDER_UNAVAILABLE',
    );
  }
  let startingAfter = '';
  while (true) {
    const page = await stripe.refunds.list({
      charge: chargeId,
      created: { lte: eventCreatedAt },
      limit: STRIPE_REFUND_PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    if (
      !page
      || !Array.isArray(page.data)
      || page.data.length > STRIPE_REFUND_PAGE_SIZE
      || typeof page.has_more !== 'boolean'
    ) {
      throw refundEvidenceError(
        'Stripe returned an invalid Refund evidence page.',
        'STRIPE_REFUND_EVIDENCE_PAGE_INVALID',
      );
    }
    if (page.has_more && page.data.length === 0) {
      throw refundEvidenceError(
        'Stripe Refund pagination did not advance.',
        'STRIPE_REFUND_EVIDENCE_PAGINATION_STALLED',
      );
    }
    const succeededMinor = appendRefunds(page.data);
    if (succeededMinor > cumulativeMinor) {
      throw refundEvidenceError(
        'Current Stripe Refund objects exceed the signed Charge refund snapshot.',
        'STRIPE_REFUND_EVIDENCE_SNAPSHOT_MISMATCH',
      );
    }
    if (!page.has_more) {
      if (succeededMinor !== cumulativeMinor) {
        throw refundEvidenceError(
          'Stripe Refund objects do not exactly equal the signed Charge refund snapshot.',
          'STRIPE_REFUND_EVIDENCE_SNAPSHOT_MISMATCH',
        );
      }
      break;
    }
    startingAfter = stripeId(page.data[page.data.length - 1]?.id);
    if (!startingAfter) {
      throw refundEvidenceError(
        'Stripe Refund pagination did not provide a valid cursor.',
        'STRIPE_REFUND_EVIDENCE_PAGINATION_STALLED',
      );
    }
  }

  return {
    ...charge,
    refunds: {
      object: 'list',
      data: refunds,
      has_more: false,
    },
  };
}

module.exports = {
  STRIPE_REFUND_MAX_EVIDENCE_OBJECTS,
  STRIPE_REFUND_PAGE_SIZE,
  hydrateStripeChargeRefundEvidence,
};
