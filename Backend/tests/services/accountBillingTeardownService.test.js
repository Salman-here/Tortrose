jest.mock('../../config/stripe', () => ({
  stripe: null,
  STRIPE_MODE: 'test',
}));

const {
  teardownAccountBilling,
  __private,
} = require('../../services/accountBillingTeardownService');

describe('account billing teardown', () => {
  test('is a no-op when the account has no Stripe resources', async () => {
    await expect(teardownAccountBilling({
      stripeClient: null,
      subscription: null,
      stripeCustomers: {},
    })).resolves.toEqual({
      cancelledSubscription: false,
      deletedCustomers: 0,
    });
  });

  test('cancels recurring billing before deleting unique customer records', async () => {
    const calls = [];
    const stripeClient = {
      subscriptions: {
        cancel: jest.fn(async (id) => {
          calls.push(`subscription:${id}`);
          return { id, status: 'canceled' };
        }),
      },
      customers: {
        del: jest.fn(async (id) => {
          calls.push(`customer:${id}`);
          return { id, deleted: true };
        }),
      },
    };

    const result = await teardownAccountBilling({
      stripeClient,
      stripeMode: 'live',
      subscription: {
        stripeSubscriptionId: 'sub_live_account',
        stripeCustomerId: 'cus_shared_account',
      },
      stripeCustomers: {
        live: 'cus_shared_account',
        test: 'cus_test_other_mode',
      },
    });

    expect(calls).toEqual([
      'subscription:sub_live_account',
      'customer:cus_shared_account',
    ]);
    expect(result).toEqual({ cancelledSubscription: true, deletedCustomers: 1 });
    expect(stripeClient.customers.del).not.toHaveBeenCalledWith('cus_test_other_mode');
  });

  test('is retry-safe after Stripe resources have already disappeared', async () => {
    const missing = Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
    const stripeClient = {
      subscriptions: { cancel: jest.fn().mockRejectedValue(missing) },
      customers: { del: jest.fn().mockRejectedValue(Object.assign(new Error('No such customer'), { code: 'resource_missing' })) },
    };

    await expect(teardownAccountBilling({
      stripeClient,
      subscription: {
        stripeSubscriptionId: 'sub_gone',
        stripeCustomerId: 'cus_gone',
      },
    })).resolves.toEqual({ cancelledSubscription: true, deletedCustomers: 1 });
  });

  test('fails closed when billing IDs exist but Stripe is unavailable', async () => {
    await expect(teardownAccountBilling({
      stripeClient: null,
      subscription: { stripeSubscriptionId: 'sub_must_cancel' },
    })).rejects.toMatchObject({ code: 'STRIPE_ACCOUNT_TEARDOWN_UNAVAILABLE' });
  });

  test('does not suppress real Stripe failures', () => {
    expect(__private.isAlreadyGoneStripeError({ code: 'api_connection_error' })).toBe(false);
  });
});
