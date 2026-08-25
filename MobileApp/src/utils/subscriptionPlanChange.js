const PLAN_CHANGE_CLIENT_SECRET_PATTERN = /^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/;

export const getPlanChangeActionClientSecret = (error = {}) => {
  const status = Number(error?.response?.status ?? error?.status);
  const payload = error?.response?.data || error?.data || {};
  if (status !== 409 || String(payload?.code || '') !== 'PLAN_CHANGE_ACTION_REQUIRED') {
    return null;
  }

  const clientSecret = String(payload?.clientSecret || '').trim();
  if (!PLAN_CHANGE_CLIENT_SECRET_PATTERN.test(clientSecret)) {
    const invalidSecretError = new Error(
      'Stripe did not return a valid payment authentication reference. No plan features were changed.'
    );
    invalidSecretError.code = 'PLAN_CHANGE_ACTION_SECRET_INVALID';
    throw invalidSecretError;
  }
  return clientSecret;
};

export const runSubscriptionPlanChange = async ({ request, handleNextAction }) => {
  if (typeof request !== 'function') {
    throw new Error('A server plan-change request is required.');
  }

  try {
    return await request();
  } catch (error) {
    const clientSecret = getPlanChangeActionClientSecret(error);
    if (!clientSecret) throw error;
    if (typeof handleNextAction !== 'function') {
      throw new Error('Secure payment authentication is unavailable. No plan features were changed.');
    }

    const actionResult = await handleNextAction(clientSecret);
    if (actionResult?.error) {
      const actionError = new Error(
        actionResult.error.localizedMessage
        || actionResult.error.message
        || 'Payment authentication was not completed. No plan features were changed.'
      );
      actionError.code = actionResult.error.code || 'PLAN_CHANGE_ACTION_FAILED';
      throw actionError;
    }

    // Re-submit the same server intent. The backend owns the durable plan-change
    // fingerprint and grants features only after Stripe confirms payment.
    return request();
  }
};
