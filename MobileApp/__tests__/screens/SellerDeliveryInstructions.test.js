import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import OrderDetailManagementScreen from '../../src/screens/shared/OrderDetailManagementScreen';
import api from '../../src/config/api';
jest.mock('../../src/config/api', () => ({ __esModule: true, default: { get: jest.fn() }, API_ENDPOINTS: { ORDERS: { DETAIL: '/api/order/detail' } } }));
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ palette: require('../../src/styles/palettes').lightPalette }) }));
jest.mock('../../src/contexts/CurrencyContext', () => ({ useCurrency: () => ({ formatPrice: amount => `PKR ${amount}` }) }));
jest.mock('../../src/hooks/useResponsiveLayout', () => () => ({ isTablet: false }));
jest.mock('../../src/components/common/GlassBackground', () => ({ children }) => children);
jest.mock('../../src/components/common/GlassPanel', () => 'GlassPanel');
jest.mock('../../src/components/seller/SellerUI', () => ({ SellerInlineError: 'Error', SellerScreenHeader: 'Header', SellerScreenSkeleton: 'Skeleton' }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
jest.mock('expo-image', () => ({ Image: 'Image' }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
const order = { _id: 'owned-order', orderId: 'ORD-QA', currency: 'PKR', orderStatus: 'pending', createdAt: '2026-10-20T00:00:00Z', paymentMethod: 'cash_on_delivery',
  shippingInfo: { fullName: 'QA Buyer', email: 'qa@example.com', address: 'QA street', city: 'Lahore', country: 'Pakistan' }, orderItems: [],
  orderSummary: { subtotal: 100, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 100 } };
beforeEach(() => jest.clearAllMocks());
test.each(['Ring once.\nLeave with reception.', 'براہ کرم دروازے کی گھنٹی بجائیں', '<script>not executable</script>'])('seller details preserve the complete buyer-authored text: %s', async instructions => {
  api.get.mockResolvedValue({ data: { order: { ...order, instructions } } });
  const screen = render(<OrderDetailManagementScreen route={{ params: { orderId: 'owned-order' } }} navigation={{ goBack: jest.fn() }} />);
  await waitFor(() => expect(screen.getByText(instructions)).toBeTruthy());
  expect(screen.getByText(instructions).props.selectable).toBe(true);
  expect(screen.getByText(instructions).props.numberOfLines).toBeUndefined();
  expect(api.get).toHaveBeenCalledWith('/api/order/detail/owned-order');
});
test.each([undefined, '', '  ', {}])('no empty instruction box for %s', async instructions => {
  api.get.mockResolvedValue({ data: { order: { ...order, instructions } } });
  const screen = render(<OrderDetailManagementScreen route={{ params: { orderId: 'owned-order' } }} navigation={{ goBack: jest.fn() }} />);
  await waitFor(() => expect(screen.getByText('Customer')).toBeTruthy());
  expect(screen.queryByText('Delivery instructions')).toBeNull();
});
