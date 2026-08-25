import {
  getPlanChangeActionClientSecret,
  runSubscriptionPlanChange,
} from '../../src/utils/subscriptionPlanChange';

const actionRequiredError = (clientSecret = 'pi_plan123_secret_auth456') => Object.assign(
  new Error('Authentication required'),
  {
    response: {
      status: 409,
      data: {
        code: 'PLAN_CHANGE_ACTION_REQUIRED',
        actionRequired: true,
        clientSecret,
      },
    },
  },
);

describe('mobile subscription plan-change authentication', () => {
  test('authenticates a valid PaymentIntent and retries the same server request', async () => {
    const response = { data: { subscription: { plan: 'elite' } } };
    const request = jest.fn()
      .mockRejectedValueOnce(actionRequiredError())
      .mockResolvedValueOnce(response);
    const handleNextAction = jest.fn().mockResolvedValue({
      paymentIntent: { id: 'pi_plan123', status: 'succeeded' },
    });

    await expect(runSubscriptionPlanChange({ request, handleNextAction })).resolves.toBe(response);
    expect(handleNextAction).toHaveBeenCalledWith('pi_plan123_secret_auth456');
    expect(request).toHaveBeenCalledTimes(2);
  });

  test.each([
    [''],
    ['seti_plan123_secret_auth456'],
    ['pi_plan123'],
    ['pi_plan123_secret_auth456 extra'],
    ['https://example.com/pi_plan123_secret_auth456'],
  ])('rejects malformed action client secret %p without invoking Stripe', async (clientSecret) => {
    const request = jest.fn().mockRejectedValue(actionRequiredError(clientSecret));
    const handleNextAction = jest.fn();

    await expect(runSubscriptionPlanChange({ request, handleNextAction }))
      .rejects.toMatchObject({ code: 'PLAN_CHANGE_ACTION_SECRET_INVALID' });
    expect(handleNextAction).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('does not retry the server mutation when payment authentication fails', async () => {
    const request = jest.fn().mockRejectedValue(actionRequiredError());
    const handleNextAction = jest.fn().mockResolvedValue({
      error: { code: 'Canceled', localizedMessage: 'Authentication was cancelled.' },
    });

    await expect(runSubscriptionPlanChange({ request, handleNextAction }))
      .rejects.toMatchObject({ code: 'Canceled', message: 'Authentication was cancelled.' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('passes ordinary server errors through without invoking Stripe', async () => {
    const error = Object.assign(new Error('Payment declined'), {
      response: { status: 402, data: { code: 'PLAN_CHANGE_PAYMENT_REQUIRED' } },
    });
    const request = jest.fn().mockRejectedValue(error);
    const handleNextAction = jest.fn();

    await expect(runSubscriptionPlanChange({ request, handleNextAction })).rejects.toBe(error);
    expect(getPlanChangeActionClientSecret(error)).toBeNull();
    expect(handleNextAction).not.toHaveBeenCalled();
  });

  test('fails closed if the server still cannot confirm the plan after authentication', async () => {
    const pending = Object.assign(new Error('Still processing'), {
      response: { status: 409, data: { code: 'PLAN_CHANGE_PENDING' } },
    });
    const request = jest.fn()
      .mockRejectedValueOnce(actionRequiredError())
      .mockRejectedValueOnce(pending);

    await expect(runSubscriptionPlanChange({
      request,
      handleNextAction: jest.fn().mockResolvedValue({ paymentIntent: { status: 'succeeded' } }),
    })).rejects.toBe(pending);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
