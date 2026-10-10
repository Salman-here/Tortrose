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
  expect(screen.getByText(/funds held from that original order/)).toBeTruthy();
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
  const terms = commercePolicies.terms.sections.find(row => row.title === '5. Payments and currency').content;
  const subscriptions = commercePolicies.terms.sections.find(row => row.title === '6. Seller subscriptions and saved cards').content;
  const cancellation = commercePolicies.cancellation.sections.find(row => row.title === 'Cancelling before shipment').content;
  const refundCancellation = commercePolicies.refunds.sections.find(row => row.title === 'Before-shipment cancellations').content;
  const fee = commercePolicies.cancellation.sections.find(row => row.title === 'Buyer-requested card cancellation processing fee').content;
  expect(terms).toContain('eligible PKR Raast payments');
  expect(terms).toContain('requires a supported Pakistani banking or wallet app');
  expect(subscriptions).toContain('Raast is not available for these flows');
  expect(cancellation).toContain('Wallet-paid or Raast-paid cancellation receives a full Rozare Wallet refund, without a buyer deduction or original-card option');
  for (const content of [cancellation, refundCancellation]) {
    expect(content).toContain('Raast cancellations do not offer an automatic refund to the original bank account');
    expect(content).toContain('original-card refund less the processing');
  }
  expect(refundCancellation).toContain('the original-card deduction is 6.2%');
  expect(fee).toContain('plus PKR30 once per checkout');
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
