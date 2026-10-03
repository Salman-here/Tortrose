'use strict';
jest.mock('../../config/stripe', () => ({ stripe: null, STRIPE_MODE: 'test' }));
const { __private: { selectReturnPolicyForDisplay } } = require('../../services/returnService');

test('an ineligible item retains its frozen product policy rather than the store default', () => {
  const disabled = Object.freeze({ returnsEnabled: false, returnDuration: 0, refundType: 'none' });
  const frozen = Object.freeze({ returnsEnabled: true, returnDuration: 14, refundType: 'full_refund' });
  for (const reason of ['not delivered', 'expired', 'already returned']) {
    expect(selectReturnPolicyForDisplay([{ returnPolicy: frozen, reason }], [], disabled)).toBe(frozen);
  }
});

test('eligible selection remains the operational policy and empty legacy groups keep their fallback', () => {
  const first = { returnsEnabled: false };
  const eligible = { returnsEnabled: true, returnDuration: 30, refundType: 'full_refund' };
  const fallback = { returnsEnabled: true, returnDuration: 7 };
  expect(selectReturnPolicyForDisplay([{ returnPolicy: first }], [{ returnPolicy: eligible }], fallback)).toBe(eligible);
  expect(selectReturnPolicyForDisplay([], [], fallback)).toBe(fallback);
});
