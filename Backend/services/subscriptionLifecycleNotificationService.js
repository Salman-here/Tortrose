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
  const introAvailable = !subscription?.hasUsedFreePeriod;
  const introText = introAvailable
    ? ` A one-time ${freePeriodDays}-day Starter introductory period is still available after Checkout.`
    : ' This seller has already used the one-time introductory period.';
  const stateText = `Your seller trial ends on ${endDate}. Subscribe to keep your store visible.${introText} Starter is {{money.starter_standard}} per month. If FIRST100 is available and accepted at Checkout, the founder rate is {{money.starter_founder}} per month.`;
  const title = 'Seller trial ending soon';
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
        text: `${stateText} Open Seller Dashboard > Subscription to subscribe.`,
        html: `<p>${escapeHtml(stateText)}</p><p>Open <strong>Seller Dashboard &gt; Subscription</strong> to subscribe.</p>`,
      },
      whatsapp: { message: `Trial Ending Soon\n\n${stateText}\n\nOpen Seller Dashboard > Subscription to subscribe.` },
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
    ? 'The one-time subscription introductory period was already used.'
    : 'Your one-time Starter introductory period remains available at Checkout.';
  const stateText = `Your seller trial ended and your store is hidden until you subscribe. ${introText}`;
  const title = 'Store blocked - seller trial ended';
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
        text: `${stateText} Open Seller Dashboard > Subscription to reactivate your store.`,
        html: `<p>${escapeHtml(stateText)}</p><p>Open <strong>Seller Dashboard &gt; Subscription</strong> to reactivate your store.</p>`,
      },
      whatsapp: { message: `Store Blocked\n\n${stateText}\n\nOpen Seller Dashboard > Subscription to reactivate your store.` },
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
} = {}) {
  if (
    !['active', 'free_period'].includes(subscription?.status)
    || !subscription?.cancelledAt
    || subscription?.pendingDowngrade?.toPlan
  ) throw outboxError('Ending warning requires one ordinary scheduled subscription cancellation.');
  const id = stringId(subscription?._id);
  const periodEnd = requireDate(subscription?.currentPeriodEnd, 'Subscription period end');
  const stripeSubscriptionId = safeText(subscription?.stripeSubscriptionId, 255);
  const founderText = subscription?.founderOffer?.active
    ? ' The FIRST100 founder rate is forfeited only when this subscription actually ends.'
    : '';
  const stateText = `Your subscription is scheduled to end on ${dateLabel(periodEnd)}. Your store will be hidden after the current access period ends.${founderText}`;
  const title = 'Subscription ending soon';
  return enqueueNotificationEvent({
    eventKey: `subscription:${id}:ending:${eventHash(stripeSubscriptionId, periodEnd.toISOString())}:seller:v2`,
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
        text: `${stateText} Open Seller Dashboard > Subscription if you want to resume.`,
        html: `<p>${escapeHtml(stateText)}</p><p>Open <strong>Seller Dashboard &gt; Subscription</strong> if you want to resume.</p>`,
      },
      whatsapp: { message: `Subscription Ending Soon\n\n${stateText}\n\nOpen Seller Dashboard > Subscription if you want to resume.` },
    },
    metadata: {
      category: 'subscription',
      linkTo: '/seller-dashboard/subscription',
      channelId: 'seller',
      whatsappCategory: 'subscription_ending',
      data: {
        type: 'subscription_ending_soon',
        subscriptionId: id,
        stripeSubscriptionId,
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
  const introText = subscription?.hasUsedFreePeriod
    ? 'No new introductory period will be added.'
    : `A one-time ${freePeriodDays}-day Elite introductory period remains available at Checkout.`;
  const titleByKind = {
    expiring: 'Bonus features ending soon',
    expired: 'Bonus features expired',
    removed: 'Bonus features permanently removed',
  };
  const stateByKind = {
    expiring: `Your Starter bonus features end on ${dateLabel(anchor)}.`,
    expired: 'Your Starter bonus features ended; core Starter features remain available while the subscription is active.',
    removed: 'The bonus grace period ended. Bonus features are no longer available on Starter.',
  };
  const title = titleByKind[kind];
  const stateText = `${stateByKind[kind]} Rozare Elite is {{money.elite_price}} per month for your persisted pricing eligibility. ${introText}`;
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
        text: `${stateText} Open Seller Dashboard > Subscription to review Elite.`,
        html: `<p>${escapeHtml(stateText)}</p><p>Open <strong>Seller Dashboard &gt; Subscription</strong> to review Elite.</p>`,
      },
      whatsapp: { message: `${title}\n\n${stateText}\n\nOpen Seller Dashboard > Subscription to review Elite.` },
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
    ? `Your ${planName} plan change is active at {{money.target_monthly_price}} per month.`
    : `Your requested ${planName} change at {{money.target_monthly_price}} per month is waiting for Stripe payment authentication. Your current plan remains unchanged.`;
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
        text: `${stateText} Open Seller Dashboard > Subscription for details.`,
        html: `<p>${escapeHtml(stateText)}</p><p>Open <strong>Seller Dashboard &gt; Subscription</strong> for details.</p>`,
      },
      whatsapp: { message: `${title}\n\n${stateText}\n\nOpen Seller Dashboard > Subscription for details.` },
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
  const stateText = `Stripe could not collect {{money.amount_outstanding}} for your ${planName} subscription. Subscription access is paused until payment succeeds.`;
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
        text: `${stateText} Open Seller Dashboard > Subscription to update payment.`,
        html: `<p>${escapeHtml(stateText)}</p><p>Open <strong>Seller Dashboard &gt; Subscription</strong> to update payment.</p>`,
      },
      whatsapp: { message: `Subscription Payment Failed\n\n${stateText}\n\nOpen Seller Dashboard > Subscription to update payment.` },
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
    ? `Your ${planName} subscription is active with a ${freePeriodDays}-day introductory period. The recurring price afterward is {{money.recurring_price}} per month.`
    : `Your ${planName} subscription is active at {{money.recurring_price}} per month.`;
  const templates = {
    inapp: { title, body: stateText },
    push: { title, body: stateText },
    email: {
      subject: title,
      text: `${stateText} Open Seller Dashboard > Subscription for billing details.`,
      html: `<p>${escapeHtml(stateText).replace(
        escapeHtml('{{money.recurring_price}}'),
        '<strong>{{money.recurring_price}}</strong>'
      )}</p><p>Open <strong>Seller Dashboard &gt; Subscription</strong> for billing details.</p>`,
    },
    whatsapp: {
      message: `${title}\n\n${stateText}\n\nOpen Seller Dashboard > Subscription for billing details.`,
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
    ? ` Your locked founder-rate basis (${pending.founderDiscountPercent}% offer) is included in this quote.`
    : '';
  const bonusSentence = pending.starterBonusEligible
    ? ' Your one-time six-month Starter bonus will begin only after the first Starter payment succeeds.'
    : ' No new Starter bonus period will be added because the one-time bonus was already used.';
  const stateText = `Your downgrade from Rozare Elite to ${planName} is scheduled for the end of the current Elite billing period. The frozen Starter recurring price is {{money.recurring_price}} per month.${founderSentence}${bonusSentence}`;
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
      message: `Downgrade Scheduled\n\n${stateText}\n\nOpen Seller Dashboard > Subscription to review or cancel it.`,
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
