import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import CommercePolicyScreen from '../../src/screens/CommercePolicyScreen';
import { commercePolicies, policyConfig, policyPublicationReady, refundTimeline, supportTimeline } from '../../src/content/commercePolicies';
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ palette: require('../../src/styles/palettes').lightPalette }) }));
jest.mock('../../src/components/common/GlassBackground', () => ({ children }) => children);
jest.mock('../../src/components/common/GlassPanel', () => 'GlassPanel');
jest.mock('../../src/components/common/PremiumBackHeader', () => 'Header');
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
const navigation = { navigate: jest.fn(), goBack: jest.fn() };
const policySection = (policy, id) => commercePolicies[policy].sections.find(row => row.id === id).content;
afterEach(() => jest.clearAllMocks());
test.each(Object.entries(commercePolicies))('%s screen renders every shared policy section', (key, policy) => {
  const screen = render(<CommercePolicyScreen route={{ name: policy.screen }} navigation={navigation} />);
  expect(screen.UNSAFE_getByType('Header').props.title).toBe(policy.title);
  for (const section of policy.sections) {
    expect(screen.getByText(section.title)).toBeTruthy(); expect(screen.getByText(section.content)).toBeTruthy();
  }
  expect(screen.getByText(policyConfig.supportEmail)).toBeTruthy();
  fireEvent.press(screen.getByText('Contact us →')); expect(navigation.navigate).toHaveBeenCalledWith('Contact');
});
test('refund page distinguishes Wallet and card destinations and initiation from arrival', () => {
  const screen = render(<CommercePolicyScreen route={{ name: 'RefundPolicy' }} navigation={navigation} />);
  expect(screen.getByText(refundTimeline)).toBeTruthy();
  expect(refundTimeline).toContain(`${policyConfig.approvedRefundInitiationBusinessDays} business days`);
  expect(screen.getByText(/credited to your Rozare Wallet in the saved order currency/)).toBeTruthy();
  expect(screen.getByText(/funds held from the original Safepay or Wallet order/)).toBeTruthy();
  expect(screen.getByText(/additional time to appear/)).toBeTruthy();
  fireEvent.press(screen.getByText('Cancellation Policy →'));
  expect(navigation.navigate).toHaveBeenCalledWith('CancellationPolicy');
});
test('terms include legal entity, governing law, complaints and no unsupported payment branding', () => {
  const all = commercePolicies.terms.sections.map(row => row.content).join('\n');
  expect(all).toContain('ROZARE (SMC-PRIVATE) LIMITED');
  expect(all).toContain('Islamic Republic of Pakistan');
  expect(all).toContain(supportTimeline); expect(all).toContain('Safepay');
  expect(all).not.toContain('Stripe');
});

test('Raast policies preserve full Wallet cancellations and restrict original-card deductions to cards', () => {
  const terms = policySection('terms', 'payments');
  const subscriptions = policySection('terms', 'subscriptions');
  const cancellation = policySection('cancellation', 'refund-choices');
  const refundCancellation = policySection('refunds', 'before-shipment');
  const fee = policySection('cancellation', 'card-deduction');
  expect(terms).toContain('eligible PKR Raast payments');
  expect(terms).toContain('Raast requires a supported Pakistani banking or wallet app');
  expect(subscriptions).toContain('use card payments, not Raast');
  expect(cancellation).toContain('Raast-paid cancellations receive the full eligible amount in Rozare Wallet, with no buyer processing deduction');
  for (const content of [cancellation, refundCancellation]) {
    expect(content).toContain('Raast cancellation flow is Wallet-only');
    expect(content).toContain('original-card refund less the');
  }
  expect(refundCancellation).toContain('the original-card deduction is 6.2%');
  expect(fee).toContain('plus PKR30 once per checkout');
});

test('returns require photos and a decision before dispatch, with no rejection after approval', () => {
  expect(policySection('refunds', 'request-review')).toContain('Both refund and replacement requests require photos');
  expect(policySection('refunds', 'request-review')).toContain('before collection or return shipment');
  expect(policySection('refunds', 'approved-return')).toContain('does not allow the seller to reject an already approved return');
  expect(policySection('refunds', 'replacements')).toContain('does not also create a money refund');
});

test('warranty policy states delivery clock, declared resolution, appeals and no automatic hold', () => {
  expect(policySection('refunds', 'warranty-claims')).toContain('duration starts from delivery');
  expect(policySection('refunds', 'warranty-claims')).toContain('Before approving, the seller declares the resolution');
  expect(policySection('refunds', 'warranty-appeals')).toContain('even if the warranty expires');
  expect(policySection('refunds', 'warranty-appeals')).toContain('Replacements and appeals do not restart');
  expect(policySection('refunds', 'warranty-funding')).toContain('claim alone does not reserve or hold seller earnings');
});

test('seller disclosure distinguishes order fees, available funds, historical reports and reviewed loss', () => {
  expect(policySection('terms', 'seller-fees')).toContain('PKR30 once per checkout');
  expect(policySection('terms', 'seller-fees')).toContain('Withdrawals do not charge this deduction again');
  expect(policySection('terms', 'seller-funds')).toContain('selected-period revenue uses orders placed');
  expect(policySection('terms', 'seller-funds')).not.toContain('Payments shows gross');
  expect(policySection('terms', 'payment-reviews')).toContain('final provider decision with supporting evidence');
  expect(policySection('terms', 'payment-reviews')).toContain('Future eligible earnings first cover that shortfall');
});

test('saved-card disclosure preserves optional checkout consent and separate recurring authorisation', () => {
  const cards = policySection('terms', 'saved-cards');
  expect(cards).toContain('after successful payment');
  expect(cards).toContain('Leaving it unchecked does not add that card');
  expect(cards).toContain('not your full card number or CVV');
  expect(cards).toContain('does not automatically change a subscription’s billing card');
  expect(policySection('terms', 'subscriptions')).toContain('separate recurring-payment agreement');
});
test('confirmed legal details and service commitments are complete and the draft notice is removed', () => {
  expect(policyPublicationReady).toBe(true);
  expect(policyConfig.registeredAddress).toBe('House/Plot No. 143, Street 8, Jinnah Block, Bahria Town, Lahore, Punjab 54000, Pakistan');
  expect(policyConfig.sameOperatingAddress).toBe(true);
  expect(policyConfig.supportPhone).toBe('+92 320 1166402');
  expect(policyConfig.companyEmail).toBe('hello@rozare.com');
  expect(policyConfig.complaintAcknowledgementBusinessDays).toBe(2);
  expect(policyConfig.complaintResolutionTargetBusinessDays).toBe(7);
  expect(policyConfig.approvedRefundInitiationBusinessDays).toBe(3);
  const all = commercePolicies.terms.sections.map(row => row.content).join('\n');
  expect(all).toContain('courts of Lahore, Punjab, Pakistan, including applicable consumer courts where required by law');
  expect(all).toContain('principal place of business is the same');
  const screen = render(<CommercePolicyScreen route={{ name: 'TermsOfService' }} navigation={navigation} />);
  expect(screen.queryByText(/Draft policy update/)).toBeNull();
});
