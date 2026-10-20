import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import api from '../config/api';
import { verifySafepayPayment } from '../utils/safepayCheckout';

// A short initial return check keeps the payment button responsive. Follow it
// with bounded, cancellable reads so a delayed webhook/network response still
// confirms automatically without another tap, presenter or payment creation.
export default function useSafepayPendingVerification({ payment, owner, enabled = true, paused = false, onVerified }) {
  const [foreground, setForeground] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  const [checking, setChecking] = useState(false);
  const callback = useRef(onVerified); callback.current = onVerified;
  const scope = `${owner || ''}:${payment?.paymentId || ''}`;
  const latest = useRef(scope); latest.current = scope;
  const eligible = Boolean(owner && enabled && !paused && foreground && payment?.safepay && payment.status === 'pending'
    && (!payment.owner || payment.owner === String(owner)));
  const expectation = JSON.stringify(payment?.expectedPayment || {});
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => setForeground(state === 'active'));
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (!eligible) { setChecking(false); return undefined; }
    const controller = new AbortController(); let alive = true;
    setChecking(true);
    verifySafepayPayment({ apiClient: api, paymentId: payment.paymentId, expectedPayment: JSON.parse(expectation),
      attempts: 6, delayMs: 1500, requestTimeoutMs: 6000, signal: controller.signal }).then(result => {
      if (alive && !controller.signal.aborted && latest.current === scope) callback.current?.(result);
    }).catch(() => { /* Offline/uncertain is never payment failure or permission for a new charge. */ })
      .finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; controller.abort(); };
  }, [eligible, scope, expectation]);
  return checking;
}
