import React from 'react';
import fs from 'fs';
import path from 'path';
import { fireEvent, render } from '@testing-library/react-native';
import SearchAutocomplete from '../../src/components/common/SearchAutocomplete';
import api from '../../src/config/api';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-image', () => ({ Image: require('react-native').View }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: require('react-native').View }));
jest.mock('../../src/components/common/GlassBlurFill', () => () => null);
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ palette: require('../../src/styles/palettes').lightPalette }) }));
jest.mock('../../src/config/api', () => ({ get: jest.fn() }));
jest.mock('../../src/utils/searchHistory', () => ({
  getSearchHistory: jest.fn(async () => []),
  removeSearchHistoryItem: jest.fn(async () => []),
  clearSearchHistory: jest.fn(async () => []),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

test('Home does not consume the first result tap to dismiss the keyboard', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/screens/HomeScreen.js'), 'utf8');
  const homeList = source.split('<FlatList')[1]?.split('removeClippedSubviews')[0] || '';
  expect(homeList).toContain('keyboardShouldPersistTaps="handled"');
});

test('a store suggestion opens the matching storefront on one press', async () => {
  const store = { _id: 'store-fixture', storeSlug: 'safepay-qa-store', storeName: 'Safepay QA Store', sellerType: 'store' };
  api.get.mockImplementation(async route => ({ data: route.includes('/stores/') ? { suggestions: [store] } : { products: [] } }));
  const navigation = { navigate: jest.fn() };
  const onClose = jest.fn();
  const screen = render(<SearchAutocomplete visible query="safe" navigation={navigation} onClose={onClose} />);
  fireEvent.press(await screen.findByLabelText('View Safepay QA Store', {}, { timeout: 3000 }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(navigation.navigate).toHaveBeenCalledTimes(1);
  expect(navigation.navigate).toHaveBeenCalledWith('Store', { storeSlug: store.storeSlug, storeName: store.storeName });
});
