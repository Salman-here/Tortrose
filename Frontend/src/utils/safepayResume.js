import { validateSafepayCheckout, validateSafepayPayment } from './safepayContract.js';

export const canResumeSafepayPayment = payment => {
  try { return validateSafepayPayment(payment).status === 'pending'; }
  catch { return false; }
};

// Reopening refreshes the secure form for an existing, server-owned attempt.
// It must never replace the original reference, currency, purpose or amount.
export const resumeOwnedSafepayPayment = async (payment, { reopen, present, verify }) => {
  const expected = validateSafepayPayment(payment);
  if (!canResumeSafepayPayment(expected)) throw new Error('This payment cannot be resumed. Check its current status.');
  const reopened = validateSafepayCheckout(await reopen(expected.paymentId));
  validateSafepayPayment(reopened, expected);
  if (reopened.status === 'pending') await present(reopened);
  // An iframe return, closure or presenter result is not payment evidence.
  return validateSafepayPayment(await verify(expected), expected);
};
