import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentReviewIsValid, buildPaymentReviewResolution, paymentReviewAuditIsValid } from '../src/utils/safepayPaymentReview.js';
import { getPaymentReviewPresentation } from '../src/utils/safepayPaymentReviewPresentation.js';
import { validateSafepayPayment } from '../src/utils/safepayContract.js';
import { readFileSync } from 'node:fs';
const review = () => ({ _id: '64b000000000000000000001', paymentId: '64b000000000000000000002',
  environment: 'sandbox', purpose: 'order', status: 'pending', revision: 0, providerFingerprint: 'a'.repeat(64),
  tracker: 'track_owned-review-fixture', currency: 'PKR', originalAmountMinor: 100000, principalMinor: 0,
  sellers: ['64b000000000000000000003'], orders: ['64b000000000000000000004'],
  providerUrl: 'https://sandbox.api.getsafepay.com/dashboard/payments-v3/details-v3/track_owned-review-fixture' });
const form = () => ({ outcome: 'lost', amount: '1000.00', reference: 'CASE-REFERENCE-123',
  evidence: 'Verified final provider decision and original-currency principal for this exact payment.', confirmed: true });
const key = 'review-resolution-fixture-key';
test('reviewed bank principal is exact, bounded and separate from editable seller deductions', () => {
  const source = review();
  assert.equal(paymentReviewIsValid(source), true);
  const payload = buildPaymentReviewResolution(source, form(), key);
  assert.equal(payload.bankReportedPrincipalMinor, 100000);
  assert.equal(payload.expectedProviderFingerprint, source.providerFingerprint);
  assert.equal(payload.expectedRevision, 0);
  assert.equal(payload.sellerAllocations, undefined);
  assert.equal(payload.nativeDeduction, undefined);
  assert.equal(buildPaymentReviewResolution(source, { ...form(), amount: '1.01' }, key).bankReportedPrincipalMinor, 101);
});
test('won decision cannot carry a bank loss amount', () => {
  assert.equal(buildPaymentReviewResolution(review(), { ...form(), outcome: 'won', amount: '1000' }, key).bankReportedPrincipalMinor, 0);
});
test('malformed responses, phishing destinations and stale state cannot authorize a decision', () => {
  for (const change of [{ currency: 'CAD' }, { originalAmountMinor: '100000' }, { originalAmountMinor: 0 },
    { principalMinor: 100001 }, { revision: 0.1 }, { sellers: ['other'] }, { providerFingerprint: '' },
    { providerUrl: 'https://evil.example/pay' }, { environment: 'preview' }]) assert.equal(paymentReviewIsValid({ ...review(), ...change }), false);
  assert.equal(buildPaymentReviewResolution({ ...review(), status: 'lost' }, form(), key), null);
});
test('invalid money, missing evidence and absent human confirmation cannot create a request', () => {
  for (const amount of ['0', '-1', '1000.01', '1.001', '1e2', 'NaN', '99999999999999999999']) {
    assert.equal(buildPaymentReviewResolution(review(), { ...form(), amount }, key), null);
  }
  for (const change of [{ evidence: '' }, { reference: '' }, { confirmed: false }, { outcome: 'pending' }]) {
    assert.equal(buildPaymentReviewResolution(review(), { ...form(), ...change }, key), null);
  }
});
test('buyer and seller review presentation cannot show a reviewed loss as paid or trust corrupt amounts', () => {
  const order = { _id: '64b000000000000000000004', currency: 'PKR', safepayPaymentReview: { version: 1,
    orderId: '64b000000000000000000004', currency: 'PKR', status: 'lost', lostMinor: 101,
    authority: 'admin_reviewed_provider_evidence' } };
  assert.equal(getPaymentReviewPresentation(order).label, 'Payment reversed');
  for (const lostMinor of [-1, '101', 1.1, Number.MAX_SAFE_INTEGER + 1]) assert.equal(getPaymentReviewPresentation({ ...order,
    safepayPaymentReview: { ...order.safepayPaymentReview, lostMinor } }).status, 'unavailable');
  const web = readFileSync(new URL('../src/utils/safepayPaymentReviewPresentation.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const native = readFileSync(new URL('../../MobileApp/src/utils/safepayPaymentReviewPresentation.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(web, native);
});
test('a reversed payment is terminal and never normalizes into a resumable pending checkout', () => {
  const payment = { paymentMethod: 'safepay', paymentFlow: 'safepay_hosted', paymentId: '64b000000000000000000002',
    purpose: 'order', environment: 'sandbox', currency: 'PKR', amountMinor: 100000, status: 'reversed', capturedMinor: 100000, paymentRail: 'card' };
  assert.equal(validateSafepayPayment(payment).status, 'reversed');
  assert.equal(validateSafepayPayment(payment).isPaid, false);
});
test('saved evidence requires exact original-currency allocations, final authority and the correct review identity', () => {
  const source = { ...review(), status: 'lost', principalMinor: 100000 };
  const value = { version: 1, reviewId: source._id, audit: { status: 'lost', currency: 'PKR', principalMinor: 100000,
    platformPrincipalMinor: 0, authority: 'admin_reviewed_provider_evidence', resolvedBy: '64b000000000000000000005',
    resolvedAt: '2026-10-14T01:00:00Z', evidence: form().evidence, caseReference: form().reference,
    sellerAllocations: [{ seller: source.sellers[0], order: source.orders[0], amountMinor: 100000 }], buyerAllocations: [] } };
  assert.equal(paymentReviewAuditIsValid(value, source), true);
  for (const changes of [{ currency: 'USD' }, { platformPrincipalMinor: 1 }, { principalMinor: '100000' }, { evidence: '' },
    { resolvedBy: 'other' }, { sellerAllocations: [{ seller: source.sellers[0], order: source.orders[0], amountMinor: '100000' }] }]) {
    assert.equal(paymentReviewAuditIsValid({ ...value, audit: { ...value.audit, ...changes } }, source), false);
  }
  assert.equal(paymentReviewAuditIsValid({ ...value, reviewId: source.paymentId }, source), false);
});
