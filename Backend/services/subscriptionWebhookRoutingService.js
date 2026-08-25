const SUBSCRIPTION_WEBHOOK_EVENT_TYPES = new Set([
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
]);

const routesToSubscriptionWebhook = eventType => (
    SUBSCRIPTION_WEBHOOK_EVENT_TYPES.has(String(eventType || ''))
);

module.exports = {
    SUBSCRIPTION_WEBHOOK_EVENT_TYPES,
    routesToSubscriptionWebhook,
};
