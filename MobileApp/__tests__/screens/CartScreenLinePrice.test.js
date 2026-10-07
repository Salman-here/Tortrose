import React from 'react';
import { render } from '@testing-library/react-native';
import CartScreen from '../../src/screens/CartScreen';

let mockCart = [];
let mockCurrency = 'USD';
let mockRates = { USD: 1, PKR: 276.74, EUR: 0.9, GBP: 0.8 };

jest.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'buyer' } }),
}));
jest.mock('../../src/contexts/GlobalContext', () => ({
  useGlobal: () => ({
    cartItems: { cart: mockCart },
    fetchCart: jest.fn().mockResolvedValue(undefined),
    handleRemoveCartItem: jest.fn(),
    handleQtyInc: jest.fn(),
    handleQtyDec: jest.fn(),
    isCartLoading: false,
    isCartReady: true,
    cartHydrationStatus: 'ready',
    retryCartHydration: jest.fn(),
  }),
}));
jest.mock('../../src/contexts/CurrencyContext', () => ({
  useCurrency: () => {
    const money = require('../../src/utils/currencySafety');
    return {
      currency: mockCurrency,
      convertAmount: (amount, source) => (
        money.convertCurrencyAmount(amount, source, mockCurrency, mockRates)
      ),
      convertLineAmounts: (lines) => (
        money.convertCurrencyLineAmounts(lines, mockCurrency, mockRates)
      ),
      formatAmount: amount => `${mockCurrency} ${amount.toFixed(2)}`,
      getProductCurrency: product => product.currency,
      exchangeRatesLoading: false,
      exchangeRatesFallback: false,
      refreshExchangeRates: jest.fn().mockResolvedValue(undefined),
    };
  },
}));
jest.mock('../../src/contexts/ThemeContext', () => ({
  useTheme: () => ({ palette: require('../../src/styles/palettes').lightPalette, isDark: false }),
}));
jest.mock('@react-navigation/native', () => ({ useFocusEffect: jest.fn() }));
jest.mock('@react-navigation/bottom-tabs', () => ({ useBottomTabBarHeight: () => 66 }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
jest.mock('expo-image', () => ({ Image: 'Image' }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'Gradient' }));
jest.mock('../../src/components/common', () => ({
  CartItemSkeleton: 'CartItemSkeleton', EmptyCart: 'EmptyCart', InlineLoader: 'InlineLoader',
}));
jest.mock('../../src/components/common/GlassBackground', () => ({ children }) => children);
jest.mock('../../src/components/common/GlassPanel', () => ({ children }) => children);
jest.mock('../../src/components/common/PremiumTopBar', () => ({
  __esModule: true, default: 'PremiumTopBar', PremiumTopBarAction: 'PremiumTopBarAction',
}));

const navigation = { navigate: jest.fn(), goBack: jest.fn(), canGoBack: () => false };
const line = (price, currency, qty) => ({
  _id: 'cart-line', qty,
  product: { _id: 'product', name: 'Blue Mug', price, currency, selectedColor: 'Blue' },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCart = [];
  mockCurrency = 'USD';
  mockRates = { USD: 1, PKR: 276.74, EUR: 0.9, GBP: 0.8 };
});

test('C4 shows the complete USD 7.23 line without an inaccurate USD 3.61 each equation', () => {
  mockCart = [line(1000, 'PKR', 2)];
  const screen = render(<CartScreen navigation={navigation} />);
  expect(screen.getByText('Complete line price')).toBeTruthy();
  expect(screen.getByText('USD 7.23 line total')).toBeTruthy();
  expect(screen.queryByText('USD 3.61')).toBeNull();
  expect(screen.queryByText('each')).toBeNull();
  expect(screen.getByText('2')).toBeTruthy();
});

test.each([
  ['USD', 0.1, 3, 'USD 0.10', 'USD 0.30 line total'],
  ['PKR', 1000, 2, 'PKR 1000.00', 'PKR 2000.00 line total'],
  ['EUR', 1.25, 4, 'EUR 1.25', 'EUR 5.00 line total'],
  ['GBP', 3.61, 2, 'GBP 3.61', 'GBP 7.22 line total'],
])('keeps exact native %s each prices without floating-point equation errors', (currency, price, qty, unit, total) => {
  mockCurrency = currency;
  mockCart = [line(price, currency, qty)];
  const screen = render(<CartScreen navigation={navigation} />);
  expect(screen.getByText(unit)).toBeTruthy();
  expect(screen.getByText('each')).toBeTruthy();
  expect(screen.getByText(total)).toBeTruthy();
  expect(screen.queryByText('Complete line price')).toBeNull();
});

test('keeps an exact converted unit price when its cents reproduce the line', () => {
  mockRates.PKR = 250;
  mockCart = [line(1000, 'PKR', 2)];
  const screen = render(<CartScreen navigation={navigation} />);
  expect(screen.getByText('USD 4.00')).toBeTruthy();
  expect(screen.getByText('each')).toBeTruthy();
  expect(screen.getByText('USD 8.00 line total')).toBeTruthy();
  expect(screen.queryByText('Complete line price')).toBeNull();
});

test('does not describe a positive converted line as zero each', () => {
  mockRates.PKR = 280;
  mockCart = [line(1, 'PKR', 1000)];
  const screen = render(<CartScreen navigation={navigation} />);
  expect(screen.getByText('Complete line price')).toBeTruthy();
  expect(screen.getByText('USD 3.57 line total')).toBeTruthy();
  expect(screen.queryByText('USD 0.00')).toBeNull();
  expect(screen.queryByText('each')).toBeNull();
});
