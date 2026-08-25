import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  calendarMonthsRemaining,
  canRetryPlanChangeAfterStripeAction,
  getPlanChangeActionClientSecret,
  isPaymentIntentClientSecret,
  isPlanChangeActionRequired,
  isStripePublishableKey,
  subscriptionStatusConfirmsEntitlement,
} from '../src/utils/subscriptionPlanChange.js';

test('subscription bonus countdown uses calendar months instead of 30-day buckets', () => {
  assert.equal(
    calendarMonthsRemaining('2027-07-31T12:00:00.000Z', '2027-01-31T12:00:00.000Z'),
    6,
  );
  assert.equal(
    calendarMonthsRemaining('2028-08-29T12:00:00.000Z', '2028-02-29T12:00:00.000Z'),
    6,
  );
  assert.equal(
    calendarMonthsRemaining('2027-07-31T12:00:00.000Z', '2027-02-01T12:00:00.000Z'),
    6,
  );
  assert.equal(
    calendarMonthsRemaining('2027-07-31T12:00:00.000Z', '2027-07-01T12:00:00.000Z'),
    1,
  );
  assert.equal(
    calendarMonthsRemaining('2027-07-31T12:00:00.000Z', '2027-07-31T12:00:00.000Z'),
    0,
  );
  assert.equal(calendarMonthsRemaining('not-a-date', '2027-01-31T12:00:00.000Z'), 0);
});

const actionRequiredError = (clientSecret = 'pi_3Example_secret_4Example') => ({
  response: {
    status: 409,
    data: {
      code: 'PLAN_CHANGE_ACTION_REQUIRED',
      actionRequired: true,
      clientSecret,
    },
  },
});

test('subscription plan changes accept only exact PaymentIntent client secrets', () => {
  assert.equal(isPaymentIntentClientSecret('pi_3Example_secret_4Example'), true);
  [
    '',
    ' pi_3Example_secret_4Example',
    'pi_3Example_secret_4Example ',
    'seti_3Example_secret_4Example',
    'pi_3Example',
    'pi__secret_value',
    'pi_3Example_secret_',
    true,
    {},
  ].forEach((value) => assert.equal(isPaymentIntentClientSecret(value), false));
});

test('subscription action-required parsing fails closed on spoofed or malformed responses', () => {
  const valid = actionRequiredError();
  assert.equal(isPlanChangeActionRequired(valid), true);
  assert.equal(getPlanChangeActionClientSecret(valid), 'pi_3Example_secret_4Example');
  assert.equal(getPlanChangeActionClientSecret(actionRequiredError('seti_bad_secret_value')), null);
  assert.equal(isPlanChangeActionRequired({
    response: { status: 400, data: valid.response.data },
  }), false);
  assert.equal(isPlanChangeActionRequired({
    response: { status: 409, data: { ...valid.response.data, actionRequired: false } },
  }), false);
  assert.equal(isPlanChangeActionRequired({
    response: { status: 409, data: { ...valid.response.data, code: 'PLAN_CHANGE_PAYMENT_REQUIRED' } },
  }), false);
});

test('subscription Stripe configuration and next-action results remain fail closed', () => {
  assert.equal(isStripePublishableKey('pk_test_51Example'), true);
  assert.equal(isStripePublishableKey('pk_live_51Example'), true);
  assert.equal(isStripePublishableKey('sk_test_51Example'), false);
  assert.equal(isStripePublishableKey(' pk_test_51Example'), false);

  assert.equal(canRetryPlanChangeAfterStripeAction({
    paymentIntent: { status: 'succeeded' },
  }), true);
  assert.equal(canRetryPlanChangeAfterStripeAction({
    paymentIntent: { status: 'processing' },
  }), true);
  assert.equal(canRetryPlanChangeAfterStripeAction({
    paymentIntent: { status: 'requires_payment_method' },
  }), false);
  assert.equal(canRetryPlanChangeAfterStripeAction({
    error: { message: 'Authentication failed' },
    paymentIntent: { status: 'succeeded' },
  }), false);
});

test('seller subscription resolves Stripe action then retries the identical server intent', () => {
  const source = readFileSync(
    new URL('../src/components/layout/SellerSubscription.jsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /import \{ loadStripe \} from '@stripe\/stripe-js'/);
  assert.match(source, /stripe\.handleNextAction\(\{ clientSecret \}\)/);
  assert.match(source, /stripe\.confirmPayment\(\{/);
  assert.match(source, /const payload = \{ includeMetaAds: eliteMetaAds \}/);
  assert.match(source, /const submitPlanChange = \(\) => axios\.post\(/);
  assert.equal((source.match(/res = await submitPlanChange\(\)/g) || []).length, 2);
  assert.match(source, /await resolvePlanChangePaymentAction\(error, token\)/);
  assert.match(source, /await fetchSubscription\(\)/);
  assert.doesNotMatch(source, /setSubscription\(res\.data/);
});

test('hosted checkout return never grants entitlement from the success query parameter', () => {
  assert.equal(subscriptionStatusConfirmsEntitlement({ status: 'active' }), true);
  assert.equal(subscriptionStatusConfirmsEntitlement({ status: 'free_period' }), true);
  ['trial', 'blocked', 'past_due', 'cancelled', '', null].forEach((status) => {
    assert.equal(subscriptionStatusConfirmsEntitlement({ status }), false);
  });

  const source = readFileSync(
    new URL('../src/components/layout/SellerSubscription.jsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /Subscription activated! Your store is now live\./);
  assert.match(source, /const nextSubscription = await fetchSubscription\(\)/);
  assert.match(source, /subscriptionStatusConfirmsEntitlement\(nextSubscription\)/);
  assert.match(source, /Rozare has not yet confirmed an active entitlement/);
});
