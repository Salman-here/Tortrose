'use strict';

const { stripe, STRIPE_MODE } = require('../config/stripe');

const isAlreadyGoneStripeError = (error) => {
    const code = String(error?.code || error?.raw?.code || '').toLowerCase();
    const message = String(error?.message || error?.raw?.message || '').toLowerCase();
    return code === 'resource_missing' ||
        message.includes('no such subscription') ||
        message.includes('no such customer') ||
        message.includes('already canceled') ||
        message.includes('already cancelled');
};

const runIdempotentStripeDelete = async (operation) => {
    try {
        return await operation();
    } catch (error) {
        if (isAlreadyGoneStripeError(error)) return null;
        throw error;
    }
};

/**
 * Immediately stops recurring billing and removes the account's customer in
 * the currently configured Stripe mode. This deliberately runs before the
 * local subscription/User rows are removed, so a transient Stripe failure is
 * retryable and can never leave an untraceable recurring charge behind.
 */
async function teardownAccountBilling({
    subscription = null,
    stripeCustomers = null,
    stripeClient = stripe,
    stripeMode = STRIPE_MODE,
} = {}) {
    const subscriptionId = String(subscription?.stripeSubscriptionId || '').trim();
    const currentModeCustomerId = String(stripeCustomers?.[stripeMode] || '').trim();
    const subscriptionCustomerId = String(subscription?.stripeCustomerId || '').trim();
    const customerIds = [...new Set([
        subscriptionCustomerId,
        currentModeCustomerId,
    ].filter(Boolean))];

    if (!subscriptionId && customerIds.length === 0) {
        return { cancelledSubscription: false, deletedCustomers: 0 };
    }
    if (!stripeClient) {
        const error = new Error('Stripe is not configured; account billing teardown cannot be verified.');
        error.code = 'STRIPE_ACCOUNT_TEARDOWN_UNAVAILABLE';
        throw error;
    }

    if (subscriptionId) {
        await runIdempotentStripeDelete(() => stripeClient.subscriptions.cancel(subscriptionId));
    }

    for (const customerId of customerIds) {
        await runIdempotentStripeDelete(() => stripeClient.customers.del(customerId));
    }

    return {
        cancelledSubscription: Boolean(subscriptionId),
        deletedCustomers: customerIds.length,
    };
}

module.exports = {
    teardownAccountBilling,
    __private: {
        isAlreadyGoneStripeError,
        runIdempotentStripeDelete,
    },
};
