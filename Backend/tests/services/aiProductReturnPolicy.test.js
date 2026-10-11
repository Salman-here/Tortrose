'use strict';
const { normalizeAIProductReturnPolicy, effectiveAIProductReturnPolicy } = require('../../services/aiProductReturnPolicyService');
const custom = { useStorePolicy: false, returnsEnabled: true, returnDuration: 7, refundType: 'full_refund',
  warrantyEnabled: true, warrantyDuration: 6, warrantyDescription: 'Manufacturer warranty' };
test('explicit seven-day product returns override a store that disables returns', () => {
  const result = normalizeAIProductReturnPolicy({ returnsEnabled: true, returnDuration: 7, refundType: 'full_refund' }, { storePolicy: { returnsEnabled: false } });
  expect(result).toMatchObject({ useStorePolicy: false, returnsEnabled: true, returnDuration: 7, refundType: 'full_refund' });
});
test('a partial window edit preserves refund resolution and warranty', () => {
  const result = normalizeAIProductReturnPolicy({ returnDuration: 14 }, { previousPolicy: custom });
  expect(result).toMatchObject({ useStorePolicy: false, returnsEnabled: true, returnDuration: 14, refundType: 'full_refund', warrantyEnabled: true, warrantyDuration: 6 });
});
test('explicit inheritance is retained and effective facts use the store policy', () => {
  const inherited = normalizeAIProductReturnPolicy({ useStorePolicy: true }, { previousPolicy: custom });
  expect(inherited.useStorePolicy).toBe(true);
  expect(effectiveAIProductReturnPolicy(inherited, { returnsEnabled: false })).toMatchObject({ returnsEnabled: false, returnDuration: 0, refundType: 'none' });
});
test('switching from inheritance to custom copies the effective policy for omitted fields', () => {
  const result = normalizeAIProductReturnPolicy({ useStorePolicy: false, returnDuration: 14 }, { previousPolicy: { useStorePolicy: true }, storePolicy: custom });
  expect(result).toMatchObject({ useStorePolicy: false, returnsEnabled: true, returnDuration: 14, refundType: 'full_refund', warrantyDuration: 6 });
});
test('invalid custom windows and string inheritance flags are rejected', () => {
  expect(() => normalizeAIProductReturnPolicy({ returnsEnabled: true, returnDuration: 0, refundType: 'full_refund' })).toThrow('Return window');
  expect(() => normalizeAIProductReturnPolicy({ useStorePolicy: 'false' })).toThrow('true or false');
});
test('empty policy edits preserve existing custom choices instead of disabling returns', () => {
  expect(normalizeAIProductReturnPolicy({}, { previousPolicy: custom })).toMatchObject(custom);
});
test('an explicit keep-warranty instruction overrides unrequested model warranty defaults', () => {
  const result = normalizeAIProductReturnPolicy({ returnDuration: 7, warrantyEnabled: true, warrantyDuration: 0 }, {
    previousPolicy: { ...custom, returnDuration: 14, warrantyEnabled: false, warrantyDuration: 0, warrantyDescription: '' },
    userText: 'Change only the product return period to 7 days. Keep returns enabled, full-refund resolution, warranty, price, stock and options unchanged.',
  });
  expect(result).toMatchObject({ useStorePolicy: false, returnsEnabled: true, returnDuration: 7, warrantyEnabled: false, warrantyDuration: 0 });
});
test('an actual warranty change is not mistaken for a preservation instruction', () => {
  const result = normalizeAIProductReturnPolicy({ warrantyEnabled: true, warrantyDuration: 12 }, {
    previousPolicy: custom, userText: 'Keep return terms the same and extend warranty to 12 months.',
  });
  expect(result.warrantyDuration).toBe(12);
});
