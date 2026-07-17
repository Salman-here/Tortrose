const {
  normalizeReturnPolicy,
  normalizeProductReturnPolicy,
  returnEligibilityDeadline,
  isReturnWindowOpen,
  canTransitionReturnStatus,
} = require('../../services/returnPolicyService');

describe('returnPolicyService', () => {
  test('normalizes disabled legacy policies safely', () => {
    expect(normalizeReturnPolicy({ returnsEnabled: false, returnDuration: 30, refundType: 'full_refund' }))
      .toMatchObject({ returnsEnabled: false, returnDuration: 0, refundType: 'none' });
  });

  test('requires a valid window and resolution when returns are enabled', () => {
    expect(() => normalizeReturnPolicy({ returnsEnabled: true, returnDuration: 0, refundType: 'full_refund' }, { strict: true }))
      .toThrow('between 1 and 365 days');
    expect(() => normalizeReturnPolicy({ returnsEnabled: true, returnDuration: 14, refundType: 'none' }, { strict: true }))
      .toThrow('Choose a refund or replacement resolution');
  });

  test('preserves store inheritance without requiring hidden override fields', () => {
    expect(normalizeProductReturnPolicy({ useStorePolicy: true }, { strict: true }))
      .toMatchObject({ useStorePolicy: true, returnsEnabled: false, returnDuration: 0, refundType: 'none' });
  });

  test('strictly validates product-specific return overrides', () => {
    expect(() => normalizeProductReturnPolicy({
      useStorePolicy: false,
      returnsEnabled: true,
      returnDuration: 0,
      refundType: 'full_refund',
    }, { strict: true })).toThrow('between 1 and 365 days');

    expect(normalizeProductReturnPolicy({
      useStorePolicy: false,
      returnsEnabled: true,
      returnDuration: 21,
      refundType: 'full_refund',
      policyDescription: 'Unopened items only.',
    }, { strict: true })).toMatchObject({
      useStorePolicy: false,
      returnsEnabled: true,
      returnDuration: 21,
      refundType: 'full_refund',
      policyDescription: 'Unopened items only.',
    });
  });

  test('computes an inclusive deadline from the seller delivery timestamp', () => {
    const deliveredAt = new Date('2026-07-01T12:00:00.000Z');
    const deadline = returnEligibilityDeadline(deliveredAt, 14);
    expect(deadline.toISOString()).toBe('2026-07-15T12:00:00.000Z');
    expect(isReturnWindowOpen(deliveredAt, 14, deadline)).toBe(true);
    expect(isReturnWindowOpen(deliveredAt, 14, new Date(deadline.getTime() + 1))).toBe(false);
  });

  test('only permits forward lifecycle transitions', () => {
    expect(canTransitionReturnStatus('requested', 'approved')).toBe(true);
    expect(canTransitionReturnStatus('picked_up', 'in_transit_to_seller')).toBe(true);
    expect(canTransitionReturnStatus('received_by_seller', 'under_review')).toBe(true);
    expect(canTransitionReturnStatus('returned', 'under_review')).toBe(false);
    expect(canTransitionReturnStatus('requested', 'returned')).toBe(false);
  });
});
