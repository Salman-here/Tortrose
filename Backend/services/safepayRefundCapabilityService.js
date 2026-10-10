'use strict';
const { normalizeSafepayPaymentRail, safepayPaymentRailFacts, safepayPaymentRailObservation } = require('./safepayPaymentRailService');

function originalPaymentLabel(rail) {
  return rail === 'card' ? 'Original card' : rail === 'raast' ? 'Original Raast account' : 'Original payment method';
}

// Ordinary hosted-merchant Raast refunds are not documented as enabled by the
// card refund API. Never manufacture aggregator access or a refund reason.
function externalRefundCapability(rail) {
  const paymentRail = normalizeSafepayPaymentRail(rail);
  return { paymentRail, available: paymentRail === 'card', label: originalPaymentLabel(paymentRail),
    reason: paymentRail === 'card' ? '' : paymentRail === 'raast'
      ? 'Automatic refunds to the original Raast account are not enabled. Choose a full Rozare Wallet refund or contact support.'
      : 'The original payment method must be verified before an external refund is available. Choose a full Rozare Wallet refund or contact support.',
  };
}

function requireExternalRefundRail(tracker, payment) {
  safepayPaymentRailObservation(payment, tracker); // Reject a conflicting confirmed rail.
  const rail = safepayPaymentRailFacts(tracker, payment).paymentRail;
  const capability = externalRefundCapability(rail);
  if (!capability.available) throw Object.assign(new Error(capability.reason), {
    code: rail === 'raast' ? 'SAFEPAY_RAAST_REFUND_UNAVAILABLE' : 'SAFEPAY_REFUND_RAIL_UNVERIFIED',
    statusCode: 409, definitiveNoMutation: true,
  });
  return capability;
}

module.exports = { externalRefundCapability, originalPaymentLabel, requireExternalRefundRail };
