'use strict';

const mockStripeFactory = jest.fn(() => ({ retainedStripeClient: true }));
jest.mock('stripe', () => mockStripeFactory);

const keys = ['STRIPE_ENABLED', 'STRIPE_MODE', 'STRIPE_TEST_SECRET_KEY'];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
beforeEach(() => {
  mockStripeFactory.mockClear();
  process.env.STRIPE_MODE = 'test';
  process.env.STRIPE_TEST_SECRET_KEY = 'sk_test_dormant_fixture';
  delete process.env.STRIPE_ENABLED;
});
afterEach(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

test.each([undefined, 'false', '1', 'TRUE'])('retained keys cannot activate Stripe with flag %s', flag => {
  if (flag !== undefined) process.env.STRIPE_ENABLED = flag;
  jest.isolateModules(() => {
    const config = require('../../config/stripe');
    expect(config.STRIPE_ENABLED).toBe(false);
    expect(config.stripe).toBeNull();
    expect(mockStripeFactory).not.toHaveBeenCalled();
  });
});

test('an explicit future switch can still load the preserved SDK', () => {
  process.env.STRIPE_ENABLED = 'true';
  const logging = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    jest.isolateModules(() => {
      const config = require('../../config/stripe');
      expect(config.STRIPE_ENABLED).toBe(true);
      expect(config.stripe).toEqual({ retainedStripeClient: true });
      expect(mockStripeFactory).toHaveBeenCalledTimes(1);
    });
  } finally { logging.mockRestore(); }
});
