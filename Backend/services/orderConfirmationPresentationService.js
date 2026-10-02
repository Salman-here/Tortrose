'use strict';

const getConfirmationViaLabel = (source) => {
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

const getAutomaticPaymentConfirmationLabel = (source) => {
  switch (source) {
    case 'safepay_payment': return 'Confirmed after verified Safepay payment';
    case 'wallet_payment': return 'Confirmed after verified Rozare Wallet payment';
    case 'stripe_payment': return 'Confirmed after verified card payment';
    default: return '';
  }
};

module.exports = { getConfirmationViaLabel, getAutomaticPaymentConfirmationLabel };
