export function assertCancellationQuote(quote, { orderId, currency, paymentMethod, paymentRail, sellerIds, grossMinor }) {
  const safe = n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const equalIds = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
    && new Set(a).size === a.length && a.every(v => typeof v === 'string' && b.includes(v));
  const fail = () => { throw new Error('The cancellation refund amounts could not be verified. Refresh and try again.'); };
  const rail = quote?.paymentRail ?? 'unknown';
  if (!['unknown', 'card', 'raast'].includes(rail) || rail === 'raast' && currency !== 'PKR'
    || paymentMethod !== 'safepay' && rail !== 'unknown'
    || paymentRail !== undefined && (!['unknown', 'card', 'raast'].includes(paymentRail)
      || paymentRail !== 'unknown' && rail !== paymentRail)) fail();
  if (quote?.version !== 1 || quote.orderId !== orderId || quote.currency !== currency || quote.paymentMethod !== paymentMethod
    || !/^[a-f0-9]{64}$/.test(quote.quoteId) || !equalIds(quote.sellerIds, sellerIds)
    || !Array.isArray(quote.activeSellerIds) || !quote.activeSellerIds.length
    || new Set(quote.activeSellerIds).size !== quote.activeSellerIds.length
    || quote.activeSellerIds.some(v => !sellerIds.includes(v))
    || !safe(quote.grossMinor) || quote.grossMinor !== grossMinor || ![0, 1].includes(quote.policyVersion)
    || !Array.isArray(quote.options)) fail();
  const expected = grossMinor === 0 || paymentMethod === 'cash_on_delivery' ? ['none']
    : paymentMethod === 'safepay' ? ['wallet', 'original_card'] : paymentMethod === 'wallet' ? ['wallet'] : [];
  if (quote.options.length !== expected.length || !expected.length || quote.defaultDestination !== expected[0]) fail();
  for (let i = 0; i < expected.length; i++) {
    const option = quote.options[i];
    if (option.destination !== expected[i] || !safe(option.amountMinor) || !safe(option.deductionMinor)
      || typeof option.available !== 'boolean' || typeof option.label !== 'string'
      || (option.destination === 'none' ? option.amountMinor !== 0 || option.deductionMinor !== 0
        : option.amountMinor + option.deductionMinor !== grossMinor)
      || option.destination !== 'original_card' && option.deductionMinor !== 0
      || option.destination === 'original_card' && (rail === 'card'
        ? option.available !== (option.amountMinor > 0)
        : option.available !== false || typeof option.reason !== 'string' || !option.reason.trim())
      || option.destination === 'wallet' && (!option.available || option.amountMinor !== grossMinor)) fail();
  }
  return quote;
}
