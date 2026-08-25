const {
  routesToSubscriptionWebhook,
} = require('../../services/subscriptionWebhookRoutingService');

describe('subscription webhook routing', () => {
  test.each([
    'checkout.session.completed',
    'checkout.session.expired',
    'customer.subscription.deleted',
    'customer.subscription.updated',
    'customer.subscription.pending_update_applied',
    'customer.subscription.pending_update_expired',
    'invoice.paid',
    'invoice.payment_action_required',
    'invoice.payment_failed',
    'invoice.payment_succeeded',
  ])('routes %s to the subscription state machine', eventType => {
    expect(routesToSubscriptionWebhook(eventType)).toBe(true);
  });

  test.each([
    'charge.refunded',
    'charge.dispute.created',
    'payment_intent.succeeded',
    'invoice.finalized',
    '',
    null,
  ])('does not steal unrelated webhook %s', eventType => {
    expect(routesToSubscriptionWebhook(eventType)).toBe(false);
  });
});
