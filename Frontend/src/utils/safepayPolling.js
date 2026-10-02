// Fast initial verification, then bounded background polling. A long-running
// form must not exhaust the authenticated account's 180 checks / 15 minutes.
export function safepayPollingDelay(elapsedMs = 0) {
  if (elapsedMs < 60000) return 4000;
  if (elapsedMs < 300000) return 10000;
  return 30000;
}

export function safepayRetryAfterMs(error, now = Date.now()) {
  if (error?.response?.status !== 429) return 0;
  const headers = error.response.headers;
  const value = headers?.get?.('retry-after') ?? headers?.['retry-after'];
  const seconds = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  const parsedDate = typeof value === 'string' && !Number.isFinite(seconds) ? Date.parse(value) : NaN;
  const duration = value != null && Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000 : Number.isFinite(parsedDate) ? parsedDate - now : 60000;
  return Math.min(2147483647, Math.max(1000, duration));
}
