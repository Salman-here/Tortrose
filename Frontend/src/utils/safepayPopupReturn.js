export const SAFEPAY_RETURN_MESSAGE = 'rozare-safepay-return';
export const SAFEPAY_BACKEND_ORIGIN = 'https://rozare.up.railway.app';
export const SAFEPAY_STATUS_TIMEOUT_MS = 45000;
const validPaymentId = value => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);

// A return message is navigation only. It cannot supply payment status or
// replace the authenticated, exact-payment verification performed by Rozare.
export function isSafepayPopupReturn(event, { paymentId, frameWindow, appOrigin }) {
  return !!frameWindow && event.source === frameWindow
    && [SAFEPAY_BACKEND_ORIGIN, appOrigin].filter(Boolean).includes(event.origin)
    && event.data?.type === SAFEPAY_RETURN_MESSAGE
    && validPaymentId(paymentId) && event.data.paymentId === paymentId;
}

export function notifySafepayParent(browserWindow, paymentId) {
  if (!browserWindow || browserWindow.parent === browserWindow || !validPaymentId(paymentId)) return false;
  browserWindow.parent.postMessage({ type: SAFEPAY_RETURN_MESSAGE, paymentId }, browserWindow.location.origin);
  return true;
}

export function safepayVerificationError(error) {
  if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT'
    || /timeout.*exceeded/i.test(error?.message || '')) {
    return 'Payment verification is taking longer than expected. Check this same payment again; do not pay twice.';
  }
  if (!error?.response) return 'Payment verification is temporarily unavailable. Check this same payment again; do not pay twice.';
  return error.response.data?.msg || 'Payment verification is unavailable. Check this same payment again; do not pay twice.';
}

// Coalesce a popup close/return with an already-running check. Closing must not
// start a competing poll, lose the close request, or resolve a later session.
export async function checkSafepayPopupSession(session, {
  closing = false, verify, finish, notice, checking, isCurrent, retryAfter, now = Date.now,
}) {
  if (!session || !isCurrent(session)) return;
  if (closing) session.closeRequested = true;
  if (session.checking) return;
  const pending = () => ({ status: 'pending', paymentId: session.payment.paymentId, isPaid: false });
  if (now() < session.retryNotBefore) {
    if (session.closeRequested) finish(pending());
    else notice('Verification is temporarily paused. Rozare will check this same payment again automatically; do not pay twice.');
    return;
  }
  session.checking = true;
  checking(true);
  try {
    const result = await verify(session.payment);
    if (!isCurrent(session)) return;
    if (result.status !== 'pending' || session.closeRequested) finish(result);
    else notice('Payment is not confirmed yet. Complete the secure form or close and resume this same attempt later.');
  } catch (error) {
    if (!isCurrent(session)) return;
    const delay = retryAfter(error);
    if (delay) session.retryNotBefore = now() + delay;
    if (session.closeRequested) finish(pending());
    else notice(delay
      ? 'Verification is temporarily paused. Rozare will check this same payment again automatically; do not pay twice.'
      : safepayVerificationError(error));
  } finally {
    session.checking = false;
    if (isCurrent(session)) checking(false);
  }
}
