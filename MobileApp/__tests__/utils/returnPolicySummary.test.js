import { returnGroupPolicyLabel } from '../../src/utils/returns';

const disabled = { returnsEnabled: false, returnDuration: 0, refundType: 'none' };
const full = { returnsEnabled: true, returnDuration: 14, refundType: 'full_refund' };

test('item-specific frozen return terms do not disappear when the item is not yet eligible', () => {
  expect(returnGroupPolicyLabel({ policy: disabled, eligible: false, items: [{ returnPolicy: full }] }))
    .toBe('14-day returns - Full refund to Rozare Wallet');
});

test('mixed windows or return availability have an honest mixed-policy label', () => {
  expect(returnGroupPolicyLabel({ policy: full, items: [
    { returnPolicy: full }, { returnPolicy: disabled },
  ] })).toBe('Item-specific return policies apply');
  expect(returnGroupPolicyLabel({ items: [
    { returnPolicy: full }, { returnPolicy: { ...full, returnDuration: 30 } },
  ] })).toBe('Item-specific return policies apply');
});

test('a no-return snapshot stays no-return after a store policy change', () => {
  expect(returnGroupPolicyLabel({ policy: full, items: [{ returnPolicy: disabled }] }))
    .toBe('Returns are not available for these ordered items');
});
