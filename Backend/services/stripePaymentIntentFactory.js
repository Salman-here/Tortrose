'use strict';

/**
 * Build a customer-initiated PaymentIntent without pre-authorizing future use.
 * Stripe PaymentSheet adds setup_future_usage only when the buyer explicitly
 * checks its save-card control, as configured by the CustomerSession.
 */
const buildCustomerInitiatedPaymentIntentParams = ({
  amountMinor,
  currency,
  customerId,
  receiptEmail,
  metadata,
}) => ({
  amount: Number(amountMinor),
  currency: String(currency || '').toLowerCase(),
  customer: customerId,
  ...(receiptEmail ? { receipt_email: receiptEmail } : {}),
  automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
  metadata,
});

const isDefinitiveStripeCreationError = (error) => {
  const type = String(error?.type || '');
  if (['StripeAPIError', 'StripeConnectionError', 'StripeUnknownError'].includes(type)) return false;
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EAI_AGAIN'].includes(error?.code)) return false;
  return type.startsWith('Stripe') && (
    ['StripeInvalidRequestError', 'StripeAuthenticationError', 'StripePermissionError', 'StripeIdempotencyError'].includes(type)
    || (Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 500)
  );
};

module.exports = {
  buildCustomerInitiatedPaymentIntentParams,
  isDefinitiveStripeCreationError,
};
