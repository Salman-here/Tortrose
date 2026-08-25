'use strict';

const StripeEntitlementPayment = require('../models/StripeEntitlementPayment');
const { escapeHtml } = require('../utils/orderPresentation');
const {
  enqueueNotificationEvent,
  outboxError,
} = require('./notificationOutboxService');
const { snapshotMinorMoney } = require('./notificationMoneySnapshotService');

const stringId = value => value?._id?.toString?.() || value?.toString?.() || '';

const eventTypeFor = (entitlementType, kind) => {
  const prefix = entitlementType === 'subscription' ? 'subscription' : 'subdomain';
  return `${prefix}.${{
    refund: 'refund_confirmed',
    dispute_opened: 'dispute_opened',
    dispute_won: 'dispute_won',
    dispute_lost: 'dispute_lost',
  }[kind]}`;
};

const outcomeCopy = ({ entitlementType, intent }) => {
  const resource = entitlementType === 'subscription'
    ? 'seller subscription'
    : 'purchased subdomain';
  const dashboard = entitlementType === 'subscription'
    ? 'Seller Dashboard > Subscription'
    : 'Seller Dashboard > Subdomain';
  if (intent.kind === 'refund') {
    return {
      title: entitlementType === 'subscription'
        ? 'Subscription refund confirmed'
        : 'Subdomain refund confirmed',
      detail: `Stripe confirmed an additional {{money.risk_amount}} refund allocated to your ${resource}. Access and ownership were recalculated from the remaining funded amount. Bank posting times may vary.`,
      whatsapp: `${entitlementType === 'subscription' ? 'Subscription' : 'Subdomain'} Refund Confirmed\n\nRefund allocated to this entitlement: {{money.risk_amount}}\n\nStripe confirmed this refund. Access and ownership were recalculated from the remaining funded amount. Bank posting times may vary.\n\nOpen ${dashboard} for details.`,
    };
  }
  if (intent.kind === 'dispute_opened') {
    const inquiry = intent.disputeState === 'inquiry';
    return {
      title: inquiry ? 'Stripe dispute inquiry opened' : 'Stripe dispute opened - funds held',
      detail: inquiry
        ? `Stripe opened an inquiry concerning {{money.risk_amount}} of your ${resource} payment. No funded amount was removed by this inquiry, and no final outcome has been decided.`
        : `Stripe opened a dispute concerning {{money.risk_amount}} of your ${resource} payment. That funded amount is held while Stripe reviews the case; no final outcome has been decided.`,
      whatsapp: inquiry
        ? `Stripe Dispute Inquiry Opened\n\nAmount under inquiry: {{money.risk_amount}}\nNo funded amount was removed by this inquiry, and no final outcome has been decided.\n\nOpen ${dashboard} for details.`
        : `Stripe Dispute Opened\n\nFunded amount held: {{money.risk_amount}}\nStripe is reviewing the case. This is not a refund and no final outcome has been decided.\n\nOpen ${dashboard} for details.`,
    };
  }
  if (intent.kind === 'dispute_won') {
    return {
      title: 'Stripe dispute won - funding restored',
      detail: `Stripe resolved the {{money.risk_amount}} dispute in favor of the original ${resource} charge, so its payment funding was restored. Any temporary entitlement restriction was recalculated. This is a dispute resolution, not a new payment or refund.`,
      whatsapp: `Stripe Dispute Won\n\nDispute amount: {{money.risk_amount}}\nAny temporary entitlement restriction was recalculated. This is a dispute resolution, not a new payment or refund.\n\nOpen ${dashboard} for details.`,
    };
  }
  return {
    title: 'Stripe dispute lost - reversal finalized',
    detail: `Stripe finalized the {{money.risk_amount}} dispute against the original ${resource} charge. That payment funding is permanently reversed and the entitlement was recalculated. This dispute result is not a separate refund.`,
    whatsapp: `Stripe Dispute Lost\n\nFinalized reversal: {{money.risk_amount}}\nThe entitlement was recalculated. This dispute result is not a separate refund.\n\nOpen ${dashboard} for details.`,
  };
};

const templatesFor = ({ entitlementType, intent }) => {
  const copy = outcomeCopy({ entitlementType, intent });
  return {
    inapp: { title: copy.title, body: copy.detail },
    push: { title: copy.title, body: copy.detail },
    email: {
      subject: copy.title,
      text: `${copy.detail} Open ${entitlementType === 'subscription' ? 'Seller Dashboard > Subscription' : 'Seller Dashboard > Subdomain'} for details.`,
      html: `<p>${escapeHtml(copy.detail).replace('{{money.risk_amount}}', '<strong>{{money.risk_amount}}</strong>')}</p><p>Open <strong>${entitlementType === 'subscription' ? 'Seller Dashboard &gt; Subscription' : 'Seller Dashboard &gt; Subdomain'}</strong> for details.</p>`,
    },
    whatsapp: { message: copy.whatsapp },
  };
};

const assertIntent = (payment, intent, index) => {
  if (!['subscription', 'subdomain'].includes(payment?.entitlementType)) {
    throw outboxError('Stripe entitlement outcome notification has an invalid entitlement type.');
  }
  if (!stringId(payment?.seller)) {
    throw outboxError('Stripe entitlement outcome notification is missing its seller owner.');
  }
  if (
    !intent
    || !intent.intentKey
    || !intent.eventId
    || !intent.chargeId
    || !intent.paymentIntentId
    || !Number.isSafeInteger(intent.amountMinor)
    || intent.amountMinor <= 0
    || intent.currency !== 'usd'
    || !Number.isSafeInteger(index)
    || index < 0
  ) {
    throw outboxError('Stripe entitlement outcome notification intent is incomplete.');
  }
};

const enqueueIntent = async (payment, intent, index) => {
  assertIntent(payment, intent, index);
  const paymentId = stringId(payment._id);
  const entitlementType = payment.entitlementType;
  const linkTo = entitlementType === 'subscription'
    ? '/seller-dashboard/subscription'
    : '/seller-dashboard/subdomain';
  const money = snapshotMinorMoney({
    key: 'risk_amount',
    label: intent.kind === 'refund'
      ? 'Provider-confirmed entitlement refund allocation'
      : 'Stripe entitlement dispute allocation',
    amountMinor: intent.amountMinor,
    currency: intent.currency,
    stripeCurrency: true,
    sourceModel: 'StripeEntitlementPayment',
    sourceDocumentId: payment._id,
    sourcePath: `riskNotificationIntents[${index}].amountMinor`,
  });
  const providerReferences = intent.kind === 'refund'
    ? intent.providerRefunds.map(refund => refund.refundId)
    : [intent.disputeId];

  return enqueueNotificationEvent({
    eventKey: `stripe-entitlement-risk:${paymentId}:${intent.intentKey}:seller:v1`,
    eventType: eventTypeFor(entitlementType, intent.kind),
    aggregateType: 'StripeEntitlementPayment',
    aggregateId: payment._id,
    occurredAt: intent.occurredAt,
    financial: true,
    recipient: {
      kind: 'user',
      audienceRole: 'seller',
      user: payment.seller,
      destinationPolicy: 'current_user',
      allowBlocked: true,
    },
    channels: ['inapp', 'push', 'email', 'whatsapp'],
    templates: templatesFor({ entitlementType, intent }),
    metadata: {
      category: 'payment',
      linkTo,
      channelId: 'seller',
      whatsappCategory: 'payment_risk',
      data: {
        type: eventTypeFor(entitlementType, intent.kind).replace(/\./g, '_'),
        entitlementPaymentId: paymentId,
        providerEvent: intent.eventId,
        providerReferences,
        outcome: intent.kind,
      },
    },
    money: [money],
  });
};

/**
 * Resume every durable seller outcome intent. The outbox event key is stable,
 * so concurrent webhook retries can race here without creating another
 * delivery. We mark the intent only after all four channel rows exist.
 */
async function ensureStripeEntitlementRiskNotificationsOutboxed(paymentOrId) {
  const paymentId = stringId(paymentOrId?._id || paymentOrId);
  let payment = await StripeEntitlementPayment.findById(paymentId);
  if (!payment) return null;

  for (let index = 0; index < payment.riskNotificationIntents.length; index += 1) {
    const intent = payment.riskNotificationIntents[index];
    if (intent.state === 'outboxed' && intent.outboxEnqueuedAt) continue;
    await enqueueIntent(payment, intent, index);
    await StripeEntitlementPayment.updateOne({
      _id: payment._id,
      riskNotificationIntents: {
        $elemMatch: {
          intentKey: intent.intentKey,
          state: 'pending',
          outboxEnqueuedAt: null,
        },
      },
    }, {
      $set: {
        'riskNotificationIntents.$.state': 'outboxed',
        'riskNotificationIntents.$.outboxEnqueuedAt': new Date(),
      },
    }, { runValidators: true });
    payment = await StripeEntitlementPayment.findById(payment._id);
    const persisted = payment?.riskNotificationIntents?.find(
      candidate => candidate.intentKey === intent.intentKey,
    );
    if (!persisted || persisted.state !== 'outboxed' || !persisted.outboxEnqueuedAt) {
      throw outboxError(
        'Stripe entitlement outcome notification could not be marked outboxed.',
        'STRIPE_ENTITLEMENT_NOTIFICATION_STATE_CONFLICT',
      );
    }
  }
  return payment;
}

module.exports = {
  ensureStripeEntitlementRiskNotificationsOutboxed,
};
