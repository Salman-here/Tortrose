import { selectSubscriptionBillingCard as select } from '../../src/utils/subscriptionBillingCard';
const data = { cards: [{ id: 'pm_shopping', last4: '1111', usable: true }, { id: 'pm_billing', last4: '1111', usable: true }],
  defaultPaymentMethodId: 'pm_shopping', billingPaymentMethodId: 'pm_billing' };
test('native retry uses the refreshed current billing reference rather than shopping default', () => {
  expect(select(data, { preferBilling: true })).toBe('pm_billing');
  expect(select({ ...data, billingPaymentMethodId: 'pm_shopping' }, { preferBilling: true })).toBe('pm_shopping');
});
test.each([null, undefined, 'pm_foreign'])('unavailable billing reference %p requires explicit selection', id => {
  expect(select({ ...data, billingPaymentMethodId: id }, { preferBilling: true })).toBe('');
});
test('expired billing cards never become a retry default and enrollment still uses shopping preference', () => {
  expect(select({ ...data, cards: data.cards.map(c => ({ ...c, usable: c.id !== 'pm_billing' })) }, { preferBilling: true })).toBe('');
  expect(select(data)).toBe('pm_shopping'); expect(select({ cards: [] })).toBe('');
});
