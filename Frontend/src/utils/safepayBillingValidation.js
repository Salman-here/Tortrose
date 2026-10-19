export const SAFEPAY_BILLING_NAME_MESSAGE = 'Enter your first and last name as shown on your card.';

// Only first-time Safepay customer creation needs a billing name. Do not impose
// this rule on delivery recipients using COD, Wallet or an existing profile.
export function getSafepayCheckoutNameError(fullName, { paymentMethod, billingProfileReady, selectedCardId, paymentRequired = true } = {}) {
  if (!paymentRequired || !['card', 'safepay'].includes(paymentMethod) || billingProfileReady !== false
    || (selectedCardId && selectedCardId !== 'raast')) return null;
  const name = typeof fullName === 'string' ? fullName.trim().replace(/\s+/g, ' ') : '';
  if (!name.includes(' ')) return SAFEPAY_BILLING_NAME_MESSAGE;
  return name.length > 160 ? 'Use no more than 160 characters for your billing name.' : null;
}

export function getSafepayBillingFieldErrors(error) {
  const data = error?.response?.data;
  if (data?.code !== 'SAFEPAY_BILLING_PROFILE_REQUIRED' || !Array.isArray(data.fields)) return {};
  return Object.fromEntries(data.fields.filter(field => ['fullName', 'phone', 'country'].includes(field))
    .map(field => [field, field === 'fullName' ? SAFEPAY_BILLING_NAME_MESSAGE
      : data.msg || 'Check this billing detail before continuing with Safepay.']));
}
