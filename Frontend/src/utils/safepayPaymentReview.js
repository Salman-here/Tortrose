import { parseExactMoneyInput } from './sellerMoneySafety.js';

const id = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
const minor = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const paymentReviewIsValid = review => Boolean(review && id(review._id) && id(review.paymentId)
  && ['sandbox', 'production'].includes(review.environment)
  && ['order', 'wallet_top_up', 'return_settlement'].includes(review.purpose)
  && ['pending', 'won', 'lost'].includes(review.status) && minor(review.revision)
  && /^[a-f0-9]{64}$/.test(review.providerFingerprint || '')
  && /^track_[a-zA-Z0-9-]+$/.test(review.tracker || '')
  && ['PKR', 'USD', 'EUR', 'GBP'].includes(review.currency)
  && minor(review.originalAmountMinor) && review.originalAmountMinor > 0
  && minor(review.principalMinor) && review.principalMinor <= review.originalAmountMinor
  && Array.isArray(review.sellers) && review.sellers.every(id)
  && Array.isArray(review.orders) && review.orders.every(id)
  && review.providerUrl === `${review.environment === 'sandbox' ? 'https://sandbox.api.getsafepay.com' : 'https://getsafepay.com'}/dashboard/payments-v3/details-v3/${encodeURIComponent(review.tracker)}`);

export function buildPaymentReviewResolution(review, form, operationKey) {
  if (!paymentReviewIsValid(review) || review.status !== 'pending'
      || !['won', 'lost'].includes(form?.outcome) || form.confirmed !== true
      || typeof form.reference !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_. /-]{4,159}$/.test(form.reference.trim())
      || typeof form.evidence !== 'string' || form.evidence.trim().length < 40 || form.evidence.length > 12000
      || !/^[a-zA-Z0-9:_-]{16,160}$/.test(operationKey || '')) return null;
  const amount = form.outcome === 'lost' ? parseExactMoneyInput(form.amount) : { minorUnits: 0 };
  if (!amount || amount.minorUnits < (form.outcome === 'lost' ? 1 : 0) || amount.minorUnits > review.originalAmountMinor) return null;
  return { outcome: form.outcome, bankReportedPrincipalMinor: amount.minorUnits,
    expectedRevision: review.revision, expectedProviderFingerprint: review.providerFingerprint,
    providerCaseReference: form.reference.trim(), evidenceText: form.evidence.trim(), confirmedProviderDecision: true };
}

export function paymentReviewAuditIsValid(value, review) {
  const audit = value?.audit;
  if (!paymentReviewIsValid(review) || value?.version !== 1 || value.reviewId !== review._id || !audit
      || !['won', 'lost'].includes(audit.status) || audit.status !== review.status || audit.currency !== review.currency
      || audit.principalMinor !== review.principalMinor || !minor(audit.platformPrincipalMinor)
      || audit.authority !== 'admin_reviewed_provider_evidence' || !id(audit.resolvedBy)
      || !Number.isFinite(Date.parse(audit.resolvedAt)) || typeof audit.evidence !== 'string'
      || audit.evidence.length < 40 || audit.evidence.length > 12000 || typeof audit.caseReference !== 'string'
      || audit.caseReference.length < 5 || audit.caseReference.length > 160
      || !Array.isArray(audit.sellerAllocations) || !Array.isArray(audit.buyerAllocations)) return false;
  if (audit.sellerAllocations.some(row => !id(row.seller) || !id(row.order) || !minor(row.amountMinor))
      || audit.buyerAllocations.some(row => !id(row.wallet) || !id(row.source) || !minor(row.amountMinor))) return false;
  const total = [...audit.sellerAllocations, ...audit.buyerAllocations].reduce((sum, row) => sum + row.amountMinor, audit.platformPrincipalMinor);
  return minor(total) && total === audit.principalMinor;
}
