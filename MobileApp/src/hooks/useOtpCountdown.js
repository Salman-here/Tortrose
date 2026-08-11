import { useCallback, useEffect, useMemo, useState } from 'react';

export const secondsUntil = (deadline, now = Date.now()) => {
  const target = Number(deadline || 0);
  if (!target) return 0;
  return Math.max(0, Math.ceil((target - now) / 1000));
};

export const formatOtpCountdown = (seconds) => {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`;
};

/**
 * Deadline-based OTP timer. Deadlines keep counting correctly while the app is
 * backgrounded, unlike decrement-only intervals which pause or drift.
 */
export default function useOtpCountdown({
  expirySeconds = 120,
  resendSeconds = 30,
  startImmediately = false,
} = {}) {
  const initialNow = Date.now();
  const [deadlines, setDeadlines] = useState(() => startImmediately ? {
    expiry: initialNow + expirySeconds * 1000,
    resend: initialNow + resendSeconds * 1000,
  } : { expiry: 0, resend: 0 });
  const [now, setNow] = useState(initialNow);

  const expiryRemaining = secondsUntil(deadlines.expiry, now);
  const resendRemaining = secondsUntil(deadlines.resend, now);

  useEffect(() => {
    if (!expiryRemaining && !resendRemaining) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [expiryRemaining, resendRemaining]);

  const start = useCallback((options = {}) => {
    const startedAt = Date.now();
    const nextExpiry = Number(options.expirySeconds ?? expirySeconds);
    const nextResend = Number(options.resendSeconds ?? resendSeconds);
    setNow(startedAt);
    setDeadlines({
      expiry: nextExpiry > 0 ? startedAt + nextExpiry * 1000 : 0,
      resend: nextResend > 0 ? startedAt + nextResend * 1000 : 0,
    });
  }, [expirySeconds, resendSeconds]);

  const clear = useCallback(() => {
    setDeadlines({ expiry: 0, resend: 0 });
    setNow(Date.now());
  }, []);

  return useMemo(() => ({
    expiryRemaining,
    resendRemaining,
    isExpired: Boolean(deadlines.expiry) && expiryRemaining === 0,
    canResend: resendRemaining === 0,
    expiryLabel: formatOtpCountdown(expiryRemaining),
    start,
    clear,
  }), [clear, deadlines.expiry, expiryRemaining, resendRemaining, start]);
}
