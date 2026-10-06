export function hasPendingCancellationRefund(order) {
  return [...(order?.sellerFulfillment || []), ...(order?.sellerGroups || [])].some(row =>
    row.cancellation?.reference && ['pending', 'processing'].includes(row.cancellation.refundStatus));
}

// One request at a time; inactive screens do not poll and stopping never
// schedules another request after an in-flight result returns.
export function startCancellationRefundRefresh(request, isActive, interval = 5000, timers = globalThis) {
  let stopped = false;
  let timer;
  const tick = async () => {
    if (stopped) return;
    try { if (isActive()) await request(); } catch { /* Preserve last verified state. */ }
    if (!stopped) timer = timers.setTimeout(tick, interval);
  };
  timer = timers.setTimeout(tick, interval);
  return () => { stopped = true; timers.clearTimeout(timer); };
}

export function cancellationRefundPresentation(value, currency, totalAmount) {
  if (!value?.reference) return null;
  if (!['not_required', 'pending', 'processing', 'refunded', 'manual_review'].includes(value.refundStatus)
    || !['none', 'wallet', 'original_card'].includes(value.destination) || value.currency !== currency
    || !Number.isSafeInteger(value.amountMinor) || value.amountMinor < 0 || value.amountMinor > Math.round(totalAmount * 100))
    return { label: 'Refund status unavailable', valid: false };
  if (value.policyVersion !== undefined && (value.policyVersion !== 1 || !Number.isSafeInteger(value.grossAmountMinor)
    || !Number.isSafeInteger(value.deductionMinor) || value.grossAmountMinor < 0 || value.deductionMinor < 0
    || value.grossAmountMinor > Math.round(totalAmount * 100)
    || value.destination !== 'none' && value.amountMinor + value.deductionMinor !== value.grossAmountMinor
    || value.destination !== 'original_card' && value.deductionMinor !== 0)) return { label: 'Refund status unavailable', valid: false };
  return { valid: true, amount: value.amountMinor / 100, deduction: (value.deductionMinor || 0) / 100,
    destination: value.destination === 'wallet' ? 'Rozare Wallet' : value.destination === 'original_card' ? 'original card' : null,
    label: value.refundStatus === 'not_required' ? 'No refund required' : value.refundStatus === 'refunded' ? 'Refund completed'
      : value.refundStatus === 'manual_review' ? 'Refund under review' : 'Refund in progress',
    message: value.destination === 'original_card' && value.refundStatus === 'refunded' ? 'Your bank may take additional time to display the refund.' : '' };
}
