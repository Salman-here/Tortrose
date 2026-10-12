'use strict';

const crypto = require('crypto');
const { enqueueNotificationEvent, outboxError } = require('./notificationOutboxService');
const { FOUNDER_PROMOTION } = require('./founderPromotionService');
const { isExactDecimalAtScale } = require('./moneyMath');

const stringId = value => value?._id?.toString?.() || value?.toString?.() || '';

const safeText = (value, maxLength) => {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength) throw outboxError('Subscription activation text is invalid.');
  return text;
};

const escapeHtml = value => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const requireDate = (value, field) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw outboxError(`${field} is invalid.`);
  return date;
};

const dateLabel = value => requireDate(value, 'Subscription lifecycle date')
  .toISOString()
  .slice(0, 10);

const eventHash = (...parts) => crypto.createHash('sha256')
  .update(parts.map(part => String(part || '')).join(':'))
  .digest('hex');

const sellerRecipient = subscription => ({
  kind: 'user',
  audienceRole: 'seller',
  user: subscription?.seller,
  destinationPolicy: 'current_user',
});

const subscriptionMoney = ({ key, label, amountMinor, subscription, sourcePath, currency = 'USD' }) => {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw outboxError(`${label} snapshot is invalid.`);
  }
  return {
    key,
    label,
    amountMinor,
    currency,
    sourceModel: 'SellerSubscription',
    sourceDocumentId: stringId(subscription?._id),
    sourcePath,
  };
};

const requirePeriodDays = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 365) {
    throw outboxError(`${label} snapshot is invalid.`);
  }
  return value;
};

const sameInstant = (left, right) => {
  if (!left || !right) return false;
  const leftDate = left instanceof Date ? left : new Date(left);
  const rightDate = right instanceof Date ? right : new Date(right);
  return Number.isFinite(leftDate.getTime())
    && Number.isFinite(rightDate.getTime())
    && leftDate.getTime() === rightDate.getTime();
};

async function enqueueTrialExpiringNotification(subscription, {
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
} = {}) {
  if (subscription?.status !== 'trial') throw outboxError('Trial warning requires a live seller trial.');
  const id = stringId(subscription?._id);
  const trialEnd = requireDate(subscription?.trialEndDate, 'Trial end');
  const pricing = subscription?.lifecyclePricing?.trialExpiring;
  if (!sameInstant(pricing?.eventAt, trialEnd)) {
    throw outboxError('Trial warning pricing does not own this expiry.', 'SUBSCRIPTION_LIFECYCLE_PRICE_STALE');
  }
  const freePeriodDays = requirePeriodDays(pricing.starterFreePeriodDays, 'Starter introductory period');
  const endDate = dateLabel(trialEnd);
  const introAvailable = !subscription?.hasUsedFreePeriod && freePeriodDays > 0;
  const introText = introAvailable
    ? ` You can still start a one-time ${freePeriodDays}-day free introductory period on Starter.`
    : subscription?.hasUsedFreePeriod ? ' Your one-time introductory period has already been used.' : '';
  const stateText = `Your seller trial ends on ${endDate}. Choose a subscription to keep your store visible.${introText} Starter costs {{money.starter_standard}} per month. If you qualify for the FIRST100 offer at checkout, your monthly rate will be {{money.starter_founder}}.`;
  const title = 'Your seller trial is ending soon';
  return enqueueNotificationEvent({
    eventKey: `subscription:${id}:trial-expiring:${eventHash(trialEnd.toISOString())}:seller:v2`,
    eventType: 'subscription.trial_expiring',
    aggregateType: 'SellerSubscription',
    aggregateId: id,
    occurredAt: trialEnd,
    financial: true,
    recipient: sellerRecipient(subscription),
    channels,
    templates: {
      inapp: { title, body: stateText },
      push: { title, body: stateText },
      email: {
        subject: title,
        text: `${stateText}\n\nReview your plans in Subscription.`,
        html: `<p>${escapeHtml(stateText)}</p><p>Review your plans in <strong>Subscription</strong>.</p>`,
      },
      whatsapp: { message: `*Your seller trial is ending soon*\n\n${stateText}\n\nReview your plans in Subscription.` },
    },
    metadata: {
      category: 'subscription',
      linkTo: '/seller-dashboard/subscription',
      channelId: 'seller',
      whatsappCategory: 'trial_expiring',
      data: {
        type: 'subscription_trial_expiring',
        subscriptionId: id,
        trialEndAt: trialEnd.toISOString(),
      },
    },
    money: [
      subscriptionMoney({
        key: 'starter_standard',
        label: 'Starter standard monthly price',
        amountMinor: pricing.starterStandardAmountMinor,
        subscription,
        sourcePath: 'lifecyclePricing.trialExpiring.starterStandardAmountMinor',
      }),
      subscriptionMoney({
        key: 'starter_founder',
        label: 'Starter founder monthly price',
        amountMinor: pricing.starterFounderAmountMinor,
        subscription,
        sourcePath: 'lifecyclePricing.trialExpiring.starterFounderAmountMinor',
      }),
    ],
    session,
  });
}

async function enqueueTrialBlockedNotification(subscription, {
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
} = {}) {
  if (subscription?.status !== 'blocked' || !/trial period expired/i.test(String(subscription?.blockedReason || ''))) {
    throw outboxError('Trial-block notification requires the persisted expired-trial block.');
  }
  const id = stringId(subscription?._id);
  const trialEnd = requireDate(subscription?.trialEndDate, 'Trial end');
  const introText = subscription?.hasUsedFreePeriod
    ? 'Your one-time introductory period has already been used.'
    : 'Your one-time Starter introductory period is still available when you subscribe.';
  const stateText = `Your seller trial ended and your store is hidden until you subscribe. ${introText}`;
  const title = 'Your seller trial has ended';
  return enqueueNotificationEvent({
    eventKey: `subscription:${id}:trial-blocked:${eventHash(trialEnd.toISOString())}:seller:v2`,
    eventType: 'subscription.trial_blocked',
    aggregateType: 'SellerSubscription',
    aggregateId: id,
    occurredAt: trialEnd,
    financial: false,
    recipient: { ...sellerRecipient(subscription), allowBlocked: true },
    channels,
    templates: {
      inapp: { title, body: stateText },
      push: { title, body: stateText },
      email: {
        subject: title,
        text: `${stateText}\n\nChoose a plan in Subscription to reactivate your store.`,
        html: `<p>${escapeHtml(stateText)}</p><p>Choose a plan in <strong>Subscription</strong> to reactivate your store.</p>`,
      },
      whatsapp: { message: `*Your seller trial has ended*\n\n${stateText}\n\nChoose a plan in Subscription to reactivate your store.` },
    },
    metadata: {
      category: 'subscription',
      linkTo: '/seller-dashboard/subscription',
      channelId: 'seller',
      whatsappCategory: 'account_blocked',
      data: {
        type: 'subscription_trial_blocked',
        subscriptionId: id,
        trialEndAt: trialEnd.toISOString(),
      },
    },
    session,
  });
}

async function enqueueSubscriptionEndingNotification(subscription, {
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
  now = new Date(),
} = {}) {
  if (
    !['active', 'free_period'].includes(subscription?.status)
    || !subscription?.cancelledAt
    || subscription?.pendingDowngrade?.toPlan
    || subscription?.pendingDowngrade?.scheduledAt
  ) throw outboxError('Ending warning requires one ordinary scheduled subscription cancellation.');
  const id = stringId(subscription?._id);
  const periodEnd = requireDate(subscription?.currentPeriodEnd, 'Subscription period end');
  const cancelledAt = requireDate(subscription.cancelledAt, 'Subscription cancellation');
  if (periodEnd <= requireDate(now, 'Subscription warning time')) {
    throw outboxError('Ending warning requires a future subscription period boundary.');
  }
  const safepay = subscription.billingProvider === 'safepay';
  let identity;
  let providerData;
  if (safepay) {
    const contractId = safeText(subscription.safepayBilling?.contractId, 255);
    const environment = subscription.safepayBilling?.environment;
    if (
      !['sandbox', 'production'].includes(environment)
      || subscription.safepayBilling?.autoRenew !== false
      || subscription.safepayBilling?.endedAt
    ) throw outboxError('Ending warning requires a current cancelled Safepay renewal.');
    // Unrelated card changes increment the billing version. This warning owns
    // the cancellation and funded period, not the current payment method.
    identity = eventHash('safepay', environment, contractId, cancelledAt.toISOString(), periodEnd.toISOString());
    providerData = { billingProvider: 'safepay', safepayContractId: contractId,
      safepayEnvironment: environment, cancelledAtAt: cancelledAt.toISOString() };
  } else {
    // Retain the original event identity for dormant Stripe rows and retries.
    const stripeSubscriptionId = safeText(subscription?.stripeSubscriptionId, 255);
    identity = eventHash(stripeSubscriptionId, periodEnd.toISOString());
    providerData = { stripeSubscriptionId };
  }
  const founderText = subscription?.founderOffer?.active
    ? ' Your FIRST100 founder rate will end with this subscription.'
    : '';
  const stateText = `Your subscription is scheduled to end on ${dateLabel(periodEnd)} because automatic renewal is turned off. Your store will be hidden when this period ends.${founderText}`;
  const title = 'Subscription ending soon';
  return enqueueNotificationEvent({
    eventKey: `subscription:${id}:ending:${identity}:seller:v2`,
    eventType: 'subscription.ending_soon',
    aggregateType: 'SellerSubscription',
    aggregateId: id,
    occurredAt: periodEnd,
    financial: false,
    recipient: sellerRecipient(subscription),
    channels,
    templates: {
      inapp: { title, body: stateText },
      push: { title, body: stateText },
      email: {
        subject: title,
        text: `${stateText}\n\nResume automatic renewal in Subscription before the end date to keep your plan.`,
        html: `<p>${escapeHtml(stateText)}</p><p>Resume automatic renewal in <strong>Subscription</strong> before the end date to keep your plan.</p>`,
      },
      whatsapp: { message: `*Subscription ending soon*\n\n${stateText}\n\nResume automatic renewal in Subscription before the end date to keep your plan.` },
    },
    metadata: {
      category: 'subscription',
      linkTo: '/seller-dashboard/subscription',
      channelId: 'seller',
      whatsappCategory: 'subscription_ending',
      data: {
        type: 'subscription_ending_soon',
        subscriptionId: id,
        ...providerData,
        currentPeriodEndAt: periodEnd.toISOString(),
      },
    },
    session,
  });
}

async function enqueueBonusLifecycleNotification(subscription, {
  kind,
  sourceDate,
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
} = {}) {
  if (!['expiring', 'expired', 'removed'].includes(kind)) {
    throw outboxError('Bonus lifecycle notification kind is invalid.');
  }
  const id = stringId(subscription?._id);
  const anchor = requireDate(sourceDate, 'Bonus lifecycle source date');
  const pricingKey = {
    expiring: 'bonusExpiring',
    expired: 'bonusExpired',
    removed: 'bonusRemoved',
  }[kind];
  const pricing = subscription?.lifecyclePricing?.[pricingKey];
  if (!sameInstant(pricing?.eventAt, anchor)) {
    throw outboxError('Bonus lifecycle pricing does not own this transition.', 'SUBSCRIPTION_LIFECYCLE_PRICE_STALE');
  }
  const freePeriodDays = requirePeriodDays(pricing.eliteFreePeriodDays, 'Elite introductory period');
  const introText = subscription?.hasUsedFreePeriod || freePeriodDays === 0
    ? ''
    : ` A one-time ${freePeriodDays}-day Elite introductory period is still available when you subscribe.`;
  const titleByKind = {
    expiring: 'Bonus features ending soon',
    expired: 'Bonus features expired',
    removed: 'Starter bonus features no longer available',
  };
  const stateByKind = {
    expiring: `Your included Starter bonus features end on ${dateLabel(anchor)}. Your core Starter features will remain available while your subscription is active.`,
    expired: 'Your Starter bonus features have ended. Your core Starter features remain available while your subscription is active.',
    removed: 'The grace period for your Starter bonus features has ended. These features are no longer available on Starter.',
  };
  const title = titleByKind[kind];
  const stateText = `${stateByKind[kind]} You can access these features with Rozare Elite at {{money.elite_price}} per month.${introText}`;
  return enqueueNotificationEvent({
    eventKey: `subscription:${id}:bonus-${kind}:${eventHash(anchor.toISOString())}:seller:v2`,
    eventType: `subscription.bonus_${kind}`,
    aggregateType: 'SellerSubscription',
    aggregateId: id,
    occurredAt: anchor,
    financial: true,
    recipient: sellerRecipient(subscription),
    channels,
    templates: {
      inapp: { title, body: stateText },
      push: { title, body: stateText },
      email: {
        subject: title,
        text: `${stateText}\n\nReview the Elite plan in Subscription.`,
        html: `<p>${escapeHtml(stateText)}</p><p>Review the Elite plan in <strong>Subscription</strong>.</p>`,
      },
      whatsapp: { message: `*${title}*\n\n${stateText}\n\nReview the Elite plan in Subscription.` },
    },
    metadata: {
      category: 'subscription',
      linkTo: '/seller-dashboard/subscription',
      channelId: 'seller',
      whatsappCategory: kind === 'expiring' ? 'bonus_expiring' : 'bonus_expired',
      data: {
        type: `subscription_bonus_${kind}`,
        subscriptionId: id,
        sourceDateAt: anchor.toISOString(),
      },
    },
    money: [subscriptionMoney({
      key: 'elite_price',
      label: 'Eligible Elite monthly price',
      amountMinor: pricing.eliteAmountMinor,
      subscription,
      sourcePath: `lifecyclePricing.${pricingKey}.eliteAmountMinor`,
    })],
    session,
  });
}

async function enqueuePlanChangeNotification(subscription, {
  kind,
  attemptToken,
  invoiceId = '',
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
} = {}) {
  if (!['completed', 'action_required'].includes(kind)) {
    throw outboxError('Plan-change notification kind is invalid.');
  }
  const attempt = subscription?.planChangeAttempt;
  const id = stringId(subscription?._id);
  if (
    !attemptToken
    || String(attempt?.idempotencyToken || '') !== String(attemptToken)
    || (kind === 'completed' && attempt?.state !== 'applied')
    || (kind === 'action_required' && (
      attempt?.state !== 'pending_payment'
      || !invoiceId
      || String(attempt?.stripeInvoiceId || '') !== String(invoiceId)
    ))
  ) throw outboxError('Plan-change notification no longer owns the durable attempt.', 'SUBSCRIPTION_PLAN_CHANGE_STALE');
  const planName = safeText(attempt?.targetPlanName || 'Rozare Elite', 120);
  const occurredAt = requireDate(
    kind === 'completed' ? attempt?.completedAt : attempt?.notificationStartedAt || attempt?.startedAt,
    'Plan-change notification timestamp',
  );
  const title = kind === 'completed' ? `${planName} activated` : 'Payment authentication required';
  const stateText = kind === 'completed'
    ? `Your ${planName} plan is now active at {{money.target_monthly_price}} per month.`
    : `Complete the payment verification to switch to ${planName} at {{money.target_monthly_price}} per month. Your current plan has not changed.`;
  const eventIdentity = kind === 'completed' ? attemptToken : `${attemptToken}:${invoiceId}`;
  return enqueueNotificationEvent({
    eventKey: `subscription:${id}:plan-change-${kind}:${eventHash(eventIdentity)}:seller:v2`,
    eventType: `subscription.plan_change_${kind}`,
    aggregateType: 'SellerSubscription',
    aggregateId: id,
    occurredAt,
    financial: true,
    recipient: sellerRecipient(subscription),
    channels,
    templates: {
      inapp: { title, body: stateText },
      push: { title, body: stateText },
      email: {
        subject: title,
        text: `${stateText}\n\nReview your plan in Subscription.`,
        html: `<p>${escapeHtml(stateText)}</p><p>Review your plan in <strong>Subscription</strong>.</p>`,
      },
      whatsapp: { message: `*${title}*\n\n${stateText}\n\nReview your plan in Subscription.` },
    },
    metadata: {
      category: 'subscription',
      linkTo: '/seller-dashboard/subscription',
      channelId: 'seller',
      whatsappCategory: kind === 'completed' ? 'upgrade_completed' : 'plan_change_action_required',
      data: {
        type: `subscription_plan_change_${kind}`,
        subscriptionId: id,
        attemptToken: String(attemptToken),
        ...(invoiceId ? { invoiceId: String(invoiceId) } : {}),
      },
    },
    money: [subscriptionMoney({
      key: 'target_monthly_price',
      label: 'Requested monthly subscription price',
      amountMinor: attempt?.targetUnitAmountMinor,
      subscription,
      sourcePath: 'planChangeAttempt.targetUnitAmountMinor',
    })],
    session,
  });
}

async function enqueueSubscriptionPaymentFailureNotification(subscription, {
  invoiceId,
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
} = {}) {
  const id = stringId(subscription?._id);
  const failure = subscription?.paymentRisk?.failureNotification;
  if (
    !['past_due', 'blocked'].includes(subscription?.status)
    || subscription?.paymentRisk?.suspended !== true
    || String(subscription?.paymentRisk?.latestFailureInvoiceId || '') !== String(invoiceId || '')
    || String(failure?.invoiceId || '') !== String(invoiceId || '')
  ) throw outboxError('Payment-failure notification no longer owns subscription risk.', 'SUBSCRIPTION_PAYMENT_FAILURE_STALE');
  const occurredAt = requireDate(failure?.occurredAt, 'Payment failure timestamp');
  const planName = safeText(failure?.planName || 'Rozare subscription', 120);
  const stateText = `Your payment of {{money.amount_outstanding}} for ${planName} was unsuccessful. Subscription access is paused until payment is completed.`;
  const title = 'Subscription payment failed';
  return enqueueNotificationEvent({
    eventKey: `subscription:${id}:payment-failed:${eventHash(invoiceId)}:seller:v2`,
    eventType: 'subscription.payment_failed',
    aggregateType: 'SellerSubscription',
    aggregateId: id,
    occurredAt,
    financial: true,
    recipient: { ...sellerRecipient(subscription), allowBlocked: true },
    channels,
    templates: {
      inapp: { title, body: stateText },
      push: { title, body: stateText },
      email: {
        subject: title,
        text: `${stateText}\n\nReview your payment method and retry in Subscription.`,
        html: `<p>${escapeHtml(stateText)}</p><p>Review your payment method and retry in <strong>Subscription</strong>.</p>`,
      },
      whatsapp: { message: `*Subscription payment unsuccessful*\n\n${stateText}\n\nReview your payment method and retry in Subscription.` },
    },
    metadata: {
      category: 'subscription',
      linkTo: '/seller-dashboard/subscription',
      channelId: 'seller',
      whatsappCategory: 'payment_failed',
      data: {
        type: 'subscription_payment_failed',
        subscriptionId: id,
        invoiceId: String(invoiceId),
        stripeSubscriptionId: String(failure?.stripeSubscriptionId || ''),
      },
    },
    money: [subscriptionMoney({
      key: 'amount_outstanding',
      label: 'Failed subscription amount outstanding',
      amountMinor: failure?.amountDueMinor,
      currency: failure?.currency,
      subscription,
      sourcePath: 'paymentRisk.failureNotification.amountDueMinor',
    })],
    session,
  });
}

async function enqueueSubscriptionActivationNotification(subscription, {
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
} = {}) {
  const id = stringId(subscription?._id);
  const activation = subscription?.activationNotification;
  const kind = activation?.kind;
  const sourceReference = safeText(activation?.sourceReference, 255);
  const stripeSubscriptionId = safeText(activation?.stripeSubscriptionId, 255);
  if (!['checkout_activation', 'automatic_downgrade'].includes(kind)) {
    throw outboxError('Subscription activation notification kind is invalid.');
  }
  if (
    String(subscription?.stripeSubscriptionId || '') !== stripeSubscriptionId
    || !['active', 'free_period'].includes(subscription?.status)
  ) {
    throw outboxError(
      'The subscription activation notification no longer owns the active entitlement.',
      'SUBSCRIPTION_ACTIVATION_STALE'
    );
  }
  const occurredAt = activation?.occurredAt instanceof Date
    ? activation.occurredAt
    : new Date(activation?.occurredAt);
  if (!Number.isFinite(occurredAt.getTime())) {
    throw outboxError('Subscription activation timestamp is invalid.');
  }
  if (!Number.isSafeInteger(activation?.recurringAmountMinor) || activation.recurringAmountMinor <= 0) {
    throw outboxError('Subscription recurring price snapshot is invalid.');
  }
  if (activation?.currency !== 'USD') {
    throw outboxError('Subscription recurring price currency is invalid.');
  }
  const freePeriodDays = activation?.freePeriodDays;
  if (!Number.isSafeInteger(freePeriodDays) || freePeriodDays < 0 || freePeriodDays > 365) {
    throw outboxError('Subscription introductory period snapshot is invalid.');
  }

  const planName = safeText(activation?.planName, 120);
  const title = kind === 'automatic_downgrade'
    ? `Switched to ${planName}`
    : `${planName} activated`;
  const stateText = freePeriodDays > 0
    ? `Your ${planName} subscription is active with a ${freePeriodDays}-day free introductory period. Your monthly price afterward will be {{money.recurring_price}}.`
    : `Your ${planName} subscription is active at {{money.recurring_price}} per month.`;
  const templates = {
    inapp: { title, body: stateText },
    push: { title, body: stateText },
    email: {
      subject: title,
      text: `${stateText}\n\nReview your billing dates and payment method in Subscription.`,
      html: `<p>${escapeHtml(stateText).replace(
        escapeHtml('{{money.recurring_price}}'),
        '<strong>{{money.recurring_price}}</strong>'
      )}</p><p>Review your billing dates and payment method in <strong>Subscription</strong>.</p>`,
    },
    whatsapp: {
      message: `*${title}*\n\n${stateText}\n\nReview your billing dates and payment method in Subscription.`,
    },
  };
  const sourceHash = crypto.createHash('sha256').update(sourceReference).digest('hex');
  return enqueueNotificationEvent({
    eventKey: `subscription:${id}:activation:${sourceHash}:seller:v1`,
    eventType: 'subscription.activated',
    aggregateType: 'SellerSubscription',
    aggregateId: id,
    occurredAt,
    financial: true,
    recipient: {
      kind: 'user',
      audienceRole: 'seller',
      user: subscription?.seller,
      destinationPolicy: 'current_user',
    },
    channels,
    templates,
    metadata: {
      category: 'subscription',
      linkTo: '/seller-dashboard/subscription',
      channelId: 'seller',
      whatsappCategory: kind === 'automatic_downgrade'
        ? 'downgrade_scheduled'
        : 'subscription_activated',
      data: { type: 'subscription_activated', subscriptionId: id, kind },
    },
    money: [{
      key: 'recurring_price',
      label: 'Monthly recurring subscription price',
      amountMinor: activation.recurringAmountMinor,
      currency: activation.currency,
      sourceModel: 'SellerSubscription',
      sourceDocumentId: id,
      sourcePath: 'activationNotification.recurringAmountMinor',
    }],
    session,
  });
}

async function enqueueSubscriptionDowngradeScheduledNotification(subscription, {
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
} = {}) {
  const id = stringId(subscription?._id);
  const pending = subscription?.pendingDowngrade;
  if (pending?.toPlan !== 'starter') {
    throw outboxError('A scheduled downgrade notification requires an active Starter downgrade intent.');
  }
  const operationKey = safeText(pending?.operationKey, 128);
  const sourceStripeSubscriptionId = safeText(pending?.sourceStripeSubscriptionId, 255);
  if (String(subscription?.stripeSubscriptionId || '') !== sourceStripeSubscriptionId) {
    throw outboxError(
      'The scheduled downgrade no longer owns the source subscription.',
      'SUBSCRIPTION_DOWNGRADE_SCHEDULE_STALE'
    );
  }
  const scheduledAt = pending?.scheduledAt instanceof Date
    ? pending.scheduledAt
    : new Date(pending?.scheduledAt);
  const stripeScheduledAt = pending?.stripeScheduledAt instanceof Date
    ? pending.stripeScheduledAt
    : new Date(pending?.stripeScheduledAt);
  if (!Number.isFinite(scheduledAt.getTime()) || !Number.isFinite(stripeScheduledAt.getTime())) {
    throw outboxError('Scheduled downgrade timestamps are invalid.');
  }
  if (!Number.isSafeInteger(pending?.targetUnitAmountMinor) || pending.targetUnitAmountMinor <= 0) {
    throw outboxError('Scheduled downgrade recurring price snapshot is invalid.');
  }
  if (pending?.targetCurrency !== 'usd') {
    throw outboxError('Scheduled downgrade recurring currency snapshot is invalid.');
  }
  if (typeof pending?.founderRateApplied !== 'boolean') {
    throw outboxError('Scheduled downgrade founder-rate basis is invalid.');
  }
  if (
    !isExactDecimalAtScale(
      pending?.founderDiscountPercent,
      { scale: 2, min: 0, max: 100 },
    )
    || (pending.founderRateApplied
      ? pending.founderDiscountPercent !== FOUNDER_PROMOTION.discountPercent
      : pending.founderDiscountPercent !== 0)
  ) {
    throw outboxError('Scheduled downgrade founder discount snapshot is invalid.');
  }
  if (typeof pending?.starterBonusEligible !== 'boolean') {
    throw outboxError('Scheduled downgrade bonus eligibility snapshot is invalid.');
  }

  const planName = safeText(pending?.targetPlanName, 120);
  const founderSentence = pending.founderRateApplied
    ? ` Your ${pending.founderDiscountPercent}% founder discount is included.`
    : '';
  const bonusSentence = pending.starterBonusEligible
    ? ' Your one-time six-month Starter bonus will begin only after the first Starter payment succeeds.'
    : ' Your one-time Starter bonus has already been used.';
  const stateText = `Your plan will switch from Rozare Elite to ${planName} at the end of your current billing period. Your new monthly price will be {{money.recurring_price}}.${founderSentence}${bonusSentence}`;
  const title = 'Downgrade to Starter scheduled';
  const templates = {
    inapp: { title, body: stateText },
    push: { title, body: `Starter is scheduled at {{money.recurring_price}} per month after your Elite period ends.` },
    email: {
      subject: title,
      text: `${stateText} You can cancel the downgrade from Seller Dashboard before the Elite period ends.`,
      html: `<p>${escapeHtml(stateText).replace(
        escapeHtml('{{money.recurring_price}}'),
        '<strong>{{money.recurring_price}}</strong>'
      )}</p><p>You can cancel the downgrade from <strong>Seller Dashboard &gt; Subscription</strong> before the Elite period ends.</p>`,
    },
    whatsapp: {
      message: `*Downgrade to Starter scheduled*\n\n${stateText}\n\nReview or cancel this change in Subscription before your Elite period ends.`,
    },
  };
  const operationHash = crypto.createHash('sha256').update(operationKey).digest('hex');
  return enqueueNotificationEvent({
    eventKey: `subscription:${id}:downgrade-scheduled:${operationHash}:seller:v1`,
    eventType: 'subscription.downgrade_scheduled',
    aggregateType: 'SellerSubscription',
    aggregateId: id,
    occurredAt: scheduledAt,
    financial: true,
    recipient: {
      kind: 'user',
      audienceRole: 'seller',
      user: subscription?.seller,
      destinationPolicy: 'current_user',
    },
    channels,
    templates,
    metadata: {
      category: 'subscription',
      linkTo: '/seller-dashboard/subscription',
      channelId: 'seller',
      whatsappCategory: 'downgrade_scheduled',
      data: { type: 'subscription_downgrade_scheduled', subscriptionId: id },
    },
    money: [{
      key: 'recurring_price',
      label: 'Frozen Starter monthly recurring price',
      amountMinor: pending.targetUnitAmountMinor,
      currency: 'USD',
      sourceModel: 'SellerSubscription',
      sourceDocumentId: id,
      sourcePath: 'pendingDowngrade.targetUnitAmountMinor',
    }],
    session,
  });
}

module.exports = {
  enqueueBonusLifecycleNotification,
  enqueuePlanChangeNotification,
  enqueueSubscriptionActivationNotification,
  enqueueSubscriptionDowngradeScheduledNotification,
  enqueueSubscriptionEndingNotification,
  enqueueSubscriptionPaymentFailureNotification,
  enqueueTrialBlockedNotification,
  enqueueTrialExpiringNotification,
};
