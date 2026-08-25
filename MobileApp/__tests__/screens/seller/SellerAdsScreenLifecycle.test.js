import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import SellerAdsScreen from '../../../src/screens/seller/SellerAdsScreen';
import api from '../../../src/config/api';
import Feedback from '../../../src/utils/feedback';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-image', () => ({ Image: () => null }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }) => children }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }) => children,
}));

jest.mock('../../../src/config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));

jest.mock('../../../src/utils/feedback', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));

jest.mock('../../../src/components/common/GlassBackground', () => ({ children }) => children);
jest.mock('../../../src/components/common/GlassPanel', () => ({ children }) => children);
jest.mock('../../../src/components/common/KeyboardAwareFormScrollView', () => ({ children }) => children);

jest.mock('../../../src/components/seller/SellerUI', () => {
  const ReactModule = require('react');
  const { Text, TouchableOpacity, View } = require('react-native');
  return {
    SellerEmptyState: ({ title }) => ReactModule.createElement(Text, null, title),
    SellerInlineError: ({ title, message, onRetry }) => ReactModule.createElement(
      View,
      null,
      ReactModule.createElement(Text, null, title),
      ReactModule.createElement(Text, null, message),
      ReactModule.createElement(TouchableOpacity, { testID: 'ads-inline-retry', onPress: onRetry })
    ),
    SellerScreenHeader: ({ onRightPress }) => ReactModule.createElement(
      TouchableOpacity,
      { testID: 'ads-header-action', onPress: onRightPress }
    ),
    SellerScreenSkeleton: () => ReactModule.createElement(Text, { testID: 'ads-skeleton' }, 'Loading ads'),
    SellerSectionHeader: ({ title }) => ReactModule.createElement(Text, null, title),
  };
});

jest.mock('../../../src/contexts/CurrencyContext', () => ({
  useCurrency: () => ({
    formatPrice: (amount, options) => `${options.sourceCurrency} ${amount.toFixed(2)}`,
  }),
}));

jest.mock('../../../src/contexts/ThemeContext', () => ({
  useTheme: () => ({
    palette: {
      colors: {
        primary: '#4338ca', primarySubtle: '#eef2ff', text: '#111827', textSecondary: '#64748b',
        textLight: '#94a3b8', success: '#15803d', successSubtle: '#dcfce7', warning: '#d97706',
        warningDark: '#92400e', warningSubtle: '#fef3c7', error: '#dc2626', errorSubtle: '#fee2e2',
        info: '#2563eb', infoSubtle: '#dbeafe', white: '#fff', grayLighter: '#e2e8f0',
      },
      gradients: { cta: ['#4338ca', '#7c3aed'] },
      glass: {
        bgSubtle: '#f8fafc', bgStrong: '#fff', borderSubtle: '#e2e8f0', borderStrong: '#cbd5e1',
      },
    },
  }),
}));

const IDS = Object.freeze({
  seller: '64b000000000000000000001',
  store: '64b000000000000000000003',
  product: '64b000000000000000000004',
  request: '64b000000000000000000006',
});

const makeProduct = (name = 'Product A') => ({
  _id: IDS.product,
  seller: IDS.seller,
  name,
  category: 'Accessories',
  image: 'https://cdn.test/product.jpg',
  images: [{ url: 'https://cdn.test/product.jpg' }],
  price: 200,
  discountedPrice: 0,
  currency: 'PKR',
  priceCurrency: 'PKR',
  isFeatured: true,
});

const makePendingRequest = (product = makeProduct()) => ({
  _id: IDS.request,
  seller: IDS.seller,
  store: IDS.store,
  products: [product],
  productIds: [product._id],
  requestType: 'start',
  status: 'pending',
  active: false,
  channels: { tiktok: true, meta: false },
  sellerNote: '',
  adminNote: '',
  reviewedBy: null,
  reviewedAt: null,
  createdAt: '2026-08-25T10:00:00.000Z',
  updatedAt: '2026-08-25T10:00:00.000Z',
});

const makeOverview = ({ productName = 'Product A', pending = false } = {}) => {
  const product = makeProduct(productName);
  const request = makePendingRequest(product);
  return {
    subscription: {
      plan: 'elite', status: 'active', planName: 'Rozare Elite', metaAdsIncluded: false,
    },
    isElite: true,
    metaAdsAddonCents: 400,
    store: {
      _id: IDS.store,
      seller: IDS.seller,
      storeName: 'Safe Store',
      storeSlug: 'safe-store',
      logo: '',
    },
    featuredProducts: [product],
    activeRequest: null,
    pendingRequests: pending ? [request] : [],
    recentRequests: pending ? [request] : [],
  };
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('SellerAdsScreen verified lifecycle', () => {
  let focusHandler;
  let navigation;

  beforeEach(() => {
    focusHandler = null;
    navigation = {
      navigate: jest.fn(),
      addListener: jest.fn((event, handler) => {
        if (event === 'focus') focusHandler = handler;
        return jest.fn();
      }),
    };
    api.get.mockReset();
    api.post.mockReset();
    Feedback.show.mockReset();
  });

  test('clears the old snapshot immediately and ignores an older refresh that finishes last', async () => {
    const slow = deferred();
    const fast = deferred();
    api.get
      .mockResolvedValueOnce({ data: makeOverview({ productName: 'Product A' }) })
      .mockImplementationOnce(() => slow.promise)
      .mockImplementationOnce(() => fast.promise);

    const screen = render(<SellerAdsScreen navigation={navigation} />);
    await screen.findByText('Product A');

    act(() => focusHandler());
    await waitFor(() => expect(screen.getByTestId('ads-skeleton')).toBeTruthy());
    expect(screen.queryByText('Product A')).toBeNull();

    act(() => focusHandler());
    await act(async () => {
      fast.resolve({ data: makeOverview({ productName: 'Newest Product' }) });
      await fast.promise;
    });
    await screen.findByText('Newest Product');

    await act(async () => {
      slow.resolve({ data: makeOverview({ productName: 'Stale Product' }) });
      await slow.promise;
    });
    expect(screen.queryByText('Stale Product')).toBeNull();
    expect(screen.getByText('Newest Product')).toBeTruthy();
  });

  test('keeps the workspace non-actionable when the latest refresh fails', async () => {
    api.get
      .mockResolvedValueOnce({ data: makeOverview() })
      .mockRejectedValueOnce(new Error('network unavailable'));

    const screen = render(<SellerAdsScreen navigation={navigation} />);
    await screen.findByText('Product A');
    act(() => focusHandler());

    await screen.findByText('Ads workspace unavailable');
    expect(screen.queryByText('Product A')).toBeNull();
    expect(screen.queryByLabelText('Run Rozare ads')).toBeNull();
  });

  test('shows mutation success only after a fresh verified overview contains that request', async () => {
    const refreshed = deferred();
    const pendingRequest = makePendingRequest();
    api.get
      .mockResolvedValueOnce({ data: makeOverview() })
      .mockImplementationOnce(() => refreshed.promise);
    api.post.mockResolvedValue({
      data: { msg: 'Ads request sent for admin approval.', request: pendingRequest },
    });

    const screen = render(<SellerAdsScreen navigation={navigation} />);
    await screen.findByText('Product A');
    fireEvent.press(screen.getByLabelText('Select Product A for ads'));
    fireEvent.press(screen.getByLabelText('Run Rozare ads'));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(Feedback.show).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(screen.getByTestId('ads-skeleton')).toBeTruthy();

    await act(async () => {
      refreshed.resolve({ data: makeOverview({ pending: true }) });
      await refreshed.promise;
    });
    await waitFor(() => expect(Feedback.show).toHaveBeenCalledWith({
      type: 'success',
      text1: 'Ads request sent',
      text2: 'Ads request sent for admin approval.',
    }));
    expect(screen.getByText('Approval pending')).toBeTruthy();
  });

  test('lets a legacy active Meta campaign toggle Meta off after the add-on is removed', async () => {
    const product = makeProduct();
    const activeRequest = {
      ...makePendingRequest(product),
      requestType: 'start',
      status: 'approved',
      active: true,
      channels: { tiktok: true, meta: true },
      reviewedBy: '64b000000000000000000008',
      reviewedAt: '2026-08-25T10:05:00.000Z',
      updatedAt: '2026-08-25T10:05:00.000Z',
    };
    const pendingUpdate = {
      ...makePendingRequest(product),
      _id: '64b000000000000000000007',
      requestType: 'update',
    };
    const initialOverview = {
      ...makeOverview(),
      activeRequest,
      pendingRequests: [],
      recentRequests: [activeRequest],
    };
    const refreshedOverview = {
      ...initialOverview,
      pendingRequests: [pendingUpdate],
      recentRequests: [pendingUpdate, activeRequest],
    };
    api.get
      .mockResolvedValueOnce({ data: initialOverview })
      .mockResolvedValueOnce({ data: refreshedOverview });
    api.post.mockResolvedValue({
      data: { msg: 'Ads request sent for admin approval.', request: pendingUpdate },
    });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    const screen = render(<SellerAdsScreen navigation={navigation} />);
    const removeMeta = await screen.findByLabelText('Remove Meta ads from this request');
    fireEvent.press(removeMeta);
    expect(alertSpy).not.toHaveBeenCalled();
    fireEvent.press(screen.getByLabelText('Submit campaign product changes'));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/ads/seller/request',
      expect.objectContaining({
        requestType: 'update',
        includeMeta: false,
        productIds: [IDS.product],
      })
    ));
    await waitFor(() => expect(Feedback.show).toHaveBeenCalledWith(expect.objectContaining({
      type: 'success',
    })));
    alertSpy.mockRestore();
  });

  test('does not restore actions when a successful POST returns an invalid request contract', async () => {
    api.get
      .mockResolvedValueOnce({ data: makeOverview() })
      .mockResolvedValueOnce({ data: makeOverview({ pending: true }) });
    api.post.mockResolvedValue({
      data: {
        msg: 'Ads request sent for admin approval.',
        request: { ...makePendingRequest(), _id: 'not-an-object-id' },
      },
    });

    const screen = render(<SellerAdsScreen navigation={navigation} />);
    await screen.findByText('Product A');
    fireEvent.press(screen.getByLabelText('Select Product A for ads'));
    fireEvent.press(screen.getByLabelText('Run Rozare ads'));

    await screen.findByText('Ads workspace unavailable');
    expect(screen.queryByText('Product A')).toBeNull();
    expect(Feedback.show).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(Feedback.show).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      text1: 'Request status unverified',
    }));
  });
});
