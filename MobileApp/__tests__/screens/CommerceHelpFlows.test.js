import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import CheckoutPolicyNotice from '../../src/components/common/CheckoutPolicyNotice';
import FAQScreen from '../../src/screens/FAQScreen';
import DocsScreen from '../../src/screens/DocsScreen';
import PrivacyPolicyScreen from '../../src/screens/PrivacyPolicyScreen';
import { checkoutPolicyNotice } from '../../src/content/commercePolicies';
import { commerceFaqById, commerceGuides } from '../../src/content/commerceHelpContent';
import { privacySections, paymentPrivacyNotice } from '../../src/content/privacyContent';
import { lightPalette, darkPalette } from '../../src/styles/palettes';

let mockPalette;
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ palette: mockPalette }) }));
jest.mock('../../src/components/common/GlassBackground', () => ({ children }) => children);
jest.mock('../../src/components/common/GlassPanel', () => 'GlassPanel');
jest.mock('../../src/components/common/PremiumBackHeader', () => 'Header');
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
jest.mock('../../src/config/api', () => ({ __esModule: true, default: { get: jest.fn().mockResolvedValue({ data: { catalog: null } }) }, API_ENDPOINTS: { SUBSCRIPTION: { CATALOG: '/api/subscription/catalog' } } }));
const navigation = { navigate: jest.fn(), goBack: jest.fn() };

describe.each([['light', lightPalette], ['dark', darkPalette]])('%s commerce information', (_name, palette) => {
  beforeEach(() => { mockPalette = palette; jest.clearAllMocks(); });
  test('compact checkout links open all five public policy screens without detailed fee paragraphs', () => {
    const open = jest.fn(), screen = render(<CheckoutPolicyNotice onOpenPolicy={open} />);
    for (const link of [checkoutPolicyNotice.terms, ...checkoutPolicyNotice.links]) { fireEvent.press(screen.getByText(link.label)); expect(open).toHaveBeenLastCalledWith(link.screen); }
    expect(screen.getAllByRole('link')).toHaveLength(5);
    expect(screen.queryByText(/PKR30|processing deduction|approved product return/i)).toBeNull();
  });
  test('FAQ expands current saved-card and warranty answers and opens the correct policies', () => {
    const screen = render(<FAQScreen navigation={navigation} />);
    expect(screen.queryByText(commerceFaqById.cards.a)).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: commerceFaqById.cards.q }));
    expect(screen.getByText(commerceFaqById.cards.a)).toBeTruthy();
    fireEvent.press(screen.getByText('Terms and Conditions')); expect(navigation.navigate).toHaveBeenLastCalledWith('TermsOfService');
    fireEvent.press(screen.getByRole('button', { name: commerceFaqById['warranty-appeal'].q }));
    expect(screen.getByText(commerceFaqById['warranty-appeal'].a)).toBeTruthy();
    fireEvent.press(screen.getByText('Return and Refund Policy')); expect(navigation.navigate).toHaveBeenLastCalledWith('RefundPolicy');
  });
  test('privacy renders the exact shared evidence, retention and card disclosures', () => {
    const screen = render(<PrivacyPolicyScreen navigation={navigation} />);
    expect(screen.getByText(paymentPrivacyNotice)).toBeTruthy();
    for (const section of privacySections) { expect(screen.getByText(section.title)).toBeTruthy(); expect(screen.getByText(section.content)).toBeTruthy(); }
    fireEvent.press(screen.getByText('Terms and Conditions')); expect(navigation.navigate).toHaveBeenCalledWith('TermsOfService');
  });
  test('documentation search, warranty guide and policy navigation work with shared content', async () => {
    const screen = render(<DocsScreen navigation={navigation} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Warranty Claims & Appeals' })).toBeTruthy());
    fireEvent.changeText(screen.getByPlaceholderText('Search documentation...'), 'warranty');
    fireEvent.press(screen.getByRole('button', { name: 'Warranty Claims & Appeals' }));
    expect(screen.getByText(commerceGuides.warranties.topics[2].text)).toBeTruthy();
    fireEvent.press(screen.getByText('Return and Refund Policy')); expect(navigation.navigate).toHaveBeenCalledWith('RefundPolicy');
    fireEvent.changeText(screen.getByPlaceholderText('Search documentation...'), 'no-topic-exists-qa');
    expect(screen.getByText('No matching topics')).toBeTruthy();
  });
});
