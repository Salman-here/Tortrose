export const getConfirmationViaLabel = (source) => {
  switch (source) {
    case 'email': return 'email';
    case 'whatsapp': return 'WhatsApp';
    case 'dashboard': return 'your Rozare account';
    case 'manual': return 'the seller';
    case 'admin': return 'a Rozare administrator';
    case 'safepay_payment': return 'Safepay payment verification';
    case 'wallet_payment': return 'Rozare Wallet payment verification';
    case 'stripe_payment': return 'card payment verification';
    default: return 'Rozare';
  }
};

export const getAutomaticPaymentConfirmationLabel = (source) => {
  switch (source) {
    case 'safepay_payment': return 'Confirmed after verified Safepay payment';
    case 'wallet_payment': return 'Confirmed after verified Rozare Wallet payment';
    case 'stripe_payment': return 'Confirmed after verified card payment';
    default: return '';
  }
};

export const getBuyerConfirmationMessage = (order) => {
  const confirmation = order?.confirmation;
  if (!confirmation?.confirmedAt) return '';
  const source = confirmation.decidedVia || confirmation.confirmedVia;
  const automaticLabel = getAutomaticPaymentConfirmationLabel(source);
  return automaticLabel
    ? `${automaticLabel}. Follow delivery updates below.`
    : `This order was confirmed via ${getConfirmationViaLabel(source)}. Follow delivery updates below.`;
};

// Cancellation alone does not prove that no payment was captured or that a
// refund has reached the buyer's bank. Do not make either financial promise.
export const getCancellationPaymentMessage = () =>
  'Review the payment and refund details for the latest status.';
