import test from 'node:test';
import assert from 'node:assert/strict';
import { returnGroupPolicyLabel } from '../src/utils/returns.js';

const noReturns = { returnsEnabled: false, returnDuration: 0, refundType: 'none' };
const fullReturn = { returnsEnabled: true, returnDuration: 14, refundType: 'full_refund' };

test('the frozen item override is displayed even before delivery or after its window closes', () => {
  for (const reason of ['not delivered', 'window closed', 'quantity already returned']) {
    assert.equal(returnGroupPolicyLabel({ policy: noReturns, eligible: false, reason,
      items: [{ returnPolicy: fullReturn }] }), '14-day returns - Rozare Wallet refund');
  }
});

test('mixed item policies are not advertised as one blanket seller policy', () => {
  assert.equal(returnGroupPolicyLabel({ policy: fullReturn, items: [
    { returnPolicy: fullReturn }, { returnPolicy: noReturns },
  ] }), 'Item-specific return policies apply');
  assert.equal(returnGroupPolicyLabel({ items: [
    { returnPolicy: fullReturn }, { returnPolicy: { ...fullReturn, returnDuration: 30 } },
  ] }), 'Item-specific return policies apply');
});

test('a frozen no-return item does not inherit a newer store policy', () => {
  assert.equal(returnGroupPolicyLabel({ policy: fullReturn, items: [{ returnPolicy: noReturns }] }),
    'Returns are not available for these ordered items');
});
