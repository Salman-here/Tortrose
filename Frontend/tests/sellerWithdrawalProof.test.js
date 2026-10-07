import assert from 'node:assert/strict';
import test from 'node:test';
import { selectSellerWithdrawalProof as webProof } from '../src/utils/sellerWithdrawalProof.js';
import { selectSellerWithdrawalProof as nativeProof } from '../../MobileApp/src/utils/sellerWithdrawalProof.js';

const publicPaidDto = () => ({
  status: 'paid', payoutWorkflowVersion: 1,
  payoutWorkflow: { version: 1, state: 'paid', attemptCount: 2,
    paidPayoutProvider: 'QA simulation - no bank transfer', paidTransferReference: 'QA-NO-BANK-20261007-15' },
});

for (const [client, selectProof] of [['web', webProof], ['native', nativeProof]]) {
  test(`${client}: seller public DTO displays recorded provider/reference without requiring admin proof`, () => {
    const dto = publicPaidDto();
    const original = structuredClone(dto);
    assert.deepEqual(selectProof(dto), {
      provider: 'QA simulation - no bank transfer', transferReference: 'QA-NO-BANK-20261007-15',
    });
    assert.deepEqual(dto, original);
    assert.equal(Object.hasOwn(dto, 'payoutAttempts'), false);
    assert.equal(Object.hasOwn(dto, 'paidPayoutAttemptId'), false);
  });

  test(`${client}: admin-only payload fields are never selected or reinterpreted`, () => {
    const dto = { ...publicPaidDto(), paidPayoutProvider: 'SECRET_PROVIDER',
      paidTransferReference: 'SECRET_REFERENCE', paidPayoutAttemptId: { invalid: true },
      payoutAttempts: [{ status: 'paid', provider: 'SECRET_ATTEMPT_PROVIDER',
        transferReference: 'SECRET_ATTEMPT_REFERENCE', transferredAt: '2026-10-07T00:00:00.000Z',
        evidence: { url: 'javascript:SECRET_URL', note: 'SECRET_NOTE' } }],
      evidenceUrl: 'https://example.com/SECRET_RECEIPT', transferredAt: 'SECRET_DATE',
    };
    const selected = selectProof(dto);
    assert.equal(JSON.stringify(selected).includes('SECRET'), false);
    assert.deepEqual(Object.keys(selected), ['provider', 'transferReference']);
  });

  test(`${client}: legacy and missing proof never inherit current bank or invented transfer fields`, () => {
    for (const dto of [
      { status: 'paid', amount: 15, currency: 'USD' },
      { ...publicPaidDto(), payoutWorkflowVersion: 0 },
      { status: 'paid', payoutWorkflowVersion: 1, paymentAccountSnapshot: { bankName: 'Current Bank' } },
    ]) assert.equal(selectProof(dto), null);
  });

  const corruptions = [
    ['non-paid request', dto => { dto.status = 'processing'; }],
    ['mismatched workflow state', dto => { dto.payoutWorkflow.state = 'failed'; }],
    ['string stored version', dto => { dto.payoutWorkflowVersion = '1'; }],
    ['string workflow version', dto => { dto.payoutWorkflow.version = '1'; }],
    ['future workflow version', dto => { dto.payoutWorkflow.version = 2; }],
    ['zero attempts', dto => { dto.payoutWorkflow.attemptCount = 0; }],
    ['string attempt count', dto => { dto.payoutWorkflow.attemptCount = '1'; }],
    ['fractional attempt count', dto => { dto.payoutWorkflow.attemptCount = 1.5; }],
    ['out-of-range attempt count', dto => { dto.payoutWorkflow.attemptCount = 51; }],
    ['missing provider', dto => { delete dto.payoutWorkflow.paidPayoutProvider; }],
    ['non-text provider', dto => { dto.payoutWorkflow.paidPayoutProvider = { name: 'Bank' }; }],
    ['empty provider', dto => { dto.payoutWorkflow.paidPayoutProvider = ' '; }],
    ['padded provider', dto => { dto.payoutWorkflow.paidPayoutProvider = ' Bank '; }],
    ['control characters in provider', dto => { dto.payoutWorkflow.paidPayoutProvider = 'Bank\nPaid'; }],
    ['oversized provider', dto => { dto.payoutWorkflow.paidPayoutProvider = 'B'.repeat(121); }],
    ['missing reference', dto => { delete dto.payoutWorkflow.paidTransferReference; }],
    ['non-text reference', dto => { dto.payoutWorkflow.paidTransferReference = 12345; }],
    ['short reference', dto => { dto.payoutWorkflow.paidTransferReference = '123'; }],
    ['unsafe URL as reference', dto => { dto.payoutWorkflow.paidTransferReference = 'javascript:alert(1)'; }],
    ['markup reference', dto => { dto.payoutWorkflow.paidTransferReference = '<script>paid</script>'; }],
    ['control characters in reference', dto => { dto.payoutWorkflow.paidTransferReference = 'PAID\nREFERENCE'; }],
    ['oversized reference', dto => { dto.payoutWorkflow.paidTransferReference = 'R'.repeat(201); }],
    ['array workflow', dto => { dto.payoutWorkflow = []; }],
  ];
  for (const [reason, corrupt] of corruptions) {
    test(`${client}: ${reason} cannot appear as recorded proof`, () => {
      const dto = publicPaidDto(); corrupt(dto);
      assert.equal(selectProof(dto), null);
    });
  }

  test(`${client}: malformed top-level payloads safely have no proof`, () => {
    for (const dto of [undefined, null, [], true, 'paid', 15]) assert.equal(selectProof(dto), null);
  });
}
