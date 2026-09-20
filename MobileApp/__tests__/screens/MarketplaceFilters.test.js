import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import StoresListingScreen from '../../src/screens/StoresListingScreen';
import api from '../../src/config/api';

jest.setTimeout(30000);
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }) => children }));
jest.mock('../../src/config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => ({ currentUser: null }) }));
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ palette: require('../../src/styles/palettes').lightPalette }) }));
jest.mock('../../src/contexts/BuyerLocationContext', () => ({ useBuyerLocation: () => ({ buyerLocation: { mode: 'country', country: 'Pakistan', countryCode: 'PK' }, locationKey: 'pk', updateBuyerLocation: async value => value }) }));
jest.mock('../../src/components/common/ShoppingLocationFields', () => () => null);
jest.mock('../../src/components/common/GlassBackground', () => ({ children }) => children);
jest.mock('../../src/components/common/GlassPanel', () => ({ children }) => children);
jest.mock('../../src/components/common/GlassBlurFill', () => () => null);
jest.mock('../../src/components/common/StoreCard', () => {
  const R = require('react'), { Text } = require('react-native');
  return ({ store, animateEntrance }) => R.createElement(Text, { testID: 'store-card', animateEntrance }, store.storeName);
});
jest.mock('../../src/components/common/EmptyState', () => {
  const R = require('react'), { Text } = require('react-native');
  return { EmptyStores: () => R.createElement(Text, null, 'No stores found'), EmptySearch: () => R.createElement(Text, null, 'No search matches') };
});
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const response = (names, { page = 1, pages = 1, total = names.length } = {}) => ({ data: { stores: names.map(name => ({ _id: name, storeName: name })), counts: { all: total, brand: 0, store: total }, pagination: { page, pages, total } } });
const mount = () => render(<StoresListingScreen navigation={{ navigate: jest.fn() }} />);
beforeEach(() => jest.clearAllMocks());

test('the header remains visible with store-shaped skeletons until results arrive', async () => {
  const pending = deferred(); api.get.mockReturnValueOnce(pending.promise);
  const screen = mount();
  expect(screen.getByText('Marketplace')).toBeTruthy();
  expect(screen.getByTestId('store-grid-skeleton')).toBeTruthy();
  expect(screen.queryByText('No stores found')).toBeNull();
  await act(async () => pending.resolve(response(['Atlas'])));
  expect(await screen.findByText('Atlas')).toBeTruthy();
  expect(screen.queryByTestId('store-grid-skeleton')).toBeNull();
  expect(screen.getByTestId('store-card').props.animateEntrance).toBe(false);
});

test('sort, verification and trust are drafts until Apply, then sent together to page one', async () => {
  api.get.mockResolvedValue(response(['Store'])); const screen = mount(); await screen.findByText('Store');
  fireEvent.press(screen.getByLabelText('Open filters'));
  fireEvent.press(screen.getByLabelText('Verified Stores Only'));
  fireEvent.press(screen.getByLabelText('50+ trusters'));
  fireEvent.press(screen.getByLabelText('Highest Rated'));
  expect(api.get).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByLabelText('Apply marketplace filters'));
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  const query = new URL('https://example.com' + api.get.mock.calls[1][0]).searchParams;
  expect(query.get('verifiedOnly')).toBe('true'); expect(query.get('minTrust')).toBe('50');
  expect(query.get('sort')).toBe('rating'); expect(query.get('page')).toBe('1');
});

test('closing the sheet discards draft filters', async () => {
  api.get.mockResolvedValue(response(['Store'])); const screen = mount(); await screen.findByText('Store');
  fireEvent.press(screen.getByLabelText('Open filters')); fireEvent.press(screen.getByLabelText('Verified Stores Only'));
  fireEvent.press(screen.getByLabelText('Close')); fireEvent.press(screen.getByLabelText('Open filters'));
  expect(screen.getByLabelText('Verified Stores Only').props.accessibilityState.checked).toBe(false);
  expect(api.get).toHaveBeenCalledTimes(1);
});

test('an old response cannot hide the skeleton or replace a newer search', async () => {
  const old = deferred(), latest = deferred(); api.get.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
  const screen = mount(); fireEvent.changeText(screen.getByPlaceholderText('Search stores & brands...'), 'new');
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2), { timeout: 4000 });
  await act(async () => old.resolve(response(['Wrong old store'])));
  expect(screen.getByTestId('store-grid-skeleton')).toBeTruthy(); expect(screen.queryByText('Wrong old store')).toBeNull();
  await act(async () => latest.resolve(response(['New match'])));
  expect(await screen.findByText('New match')).toBeTruthy();
});

test('request failures show retry, not a successful empty Marketplace', async () => {
  api.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response(['Recovered']));
  const screen = mount(); await screen.findByText(/Could not load stores/);
  expect(screen.queryByText('No stores found')).toBeNull();
  fireEvent.press(screen.getByLabelText('Retry loading stores'));
  expect(await screen.findByText('Recovered')).toBeTruthy();
});

test('pagination is locked while an append is pending and a new filter cancels that append', async () => {
  const oldPage = deferred();
  api.get.mockResolvedValueOnce(response(['First'], { pages: 3, total: 30 })).mockReturnValueOnce(oldPage.promise).mockResolvedValueOnce(response(['Brand match']));
  const screen = mount(); await screen.findByText('First');
  fireEvent.press(screen.getByText('Load More Stores'));
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  expect(screen.getByTestId('store-grid-skeleton')).toBeTruthy();
  fireEvent.press(screen.getByText('Brands'));
  expect(await screen.findByText('Brand match')).toBeTruthy();
  await act(async () => oldPage.resolve(response(['Stale second page'], { page: 2, pages: 3, total: 30 })));
  expect(screen.queryByText('Stale second page')).toBeNull();
  expect(api.get.mock.calls[2][0]).toContain('page=1'); expect(api.get.mock.calls[2][0]).toContain('type=brand');
});
