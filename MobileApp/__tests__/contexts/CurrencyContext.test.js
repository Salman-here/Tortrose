import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import api from '../../src/config/api';
import {
  CurrencyProvider,
  requireCanonicalPresentationCurrency,
  requireExactPresentationMoney,
  resolveOrderItemPresentationMoney,
  resolveProductPresentationCurrency,
  resolveProductPresentationMoney,
  useCurrency,
} from '../../src/contexts/CurrencyContext';

let mockCurrentUser = null;
let mockToken = null;
let mockAuthLoading = false;

jest.mock('react-native', () => {
  return {
    AppState: {
      currentState: 'active',
      addEventListener: jest.fn(() => ({ remove: jest.fn() })),
    },
    NativeModules: {},
    Platform: { OS: 'android' },
  };
});

jest.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({
    currentUser: mockCurrentUser,
    token: mockToken,
    isLoading: mockAuthLoading,
  }),
}));

jest.mock('../../src/config/api', () => ({
  __esModule: true,
  API_BASE_URL: 'https://api.example.test',
  default: {
    get: jest.fn(),
    patch: jest.fn(),
  },
}));

const RATES = { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 };

let latestCurrency;
const CurrencyProbe = () => {
  latestCurrency = useCurrency();
  return null;
};

const flushEffects = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const expectIntegrityFailure = (run, code) => {
  expect(run).toThrow(expect.objectContaining({ code, statusCode: 409 }));
};

describe('CurrencyContext strict presentation contract', () => {
  let root;

  const renderProvider = async ({ fallback = false } = {}) => {
    api.get.mockImplementation(async (path) => {
      if (path === '/api/currency/rates') {
        return {
          data: {
            success: true,
            rates: RATES,
            fallback,
            source: fallback ? 'fallback' : 'live',
          },
        };
      }
      return { data: {} };
    });
    axios.get.mockResolvedValue({ data: { success: false } });

    await act(async () => {
      root = TestRenderer.create(
        <CurrencyProvider>
          <CurrencyProbe />
        </CurrencyProvider>
      );
      await flushEffects();
    });
  };

  beforeEach(async () => {
    latestCurrency = null;
    mockCurrentUser = null;
    mockToken = null;
    mockAuthLoading = false;
    jest.clearAllMocks();
    await AsyncStorage.clear();
  });

  afterEach(() => {
    if (root) {
      act(() => root.unmount());
      root = null;
    }
  });

  it('preserves exact zero and rejects bool/string/nonfinite/negative/sub-cent money', () => {
    expect(requireExactPresentationMoney(0)).toBe(0);
    expect(requireExactPresentationMoney(12.34)).toBe(12.34);

    [false, '', '12.34', NaN, Infinity, -1, 0.001, 1.004].forEach((corrupt) => {
      expectIntegrityFailure(
        () => requireExactPresentationMoney(corrupt),
        'CURRENCY_PRESENTATION_DATA_INVALID'
      );
    });
  });

  it('requires exact canonical supported currency codes', () => {
    ['USD', 'PKR', 'EUR', 'GBP'].forEach((code) => {
      expect(requireCanonicalPresentationCurrency(code)).toBe(code);
    });
    ['', '   ', 'CAD', 'usd', ' USD ', false, 1].forEach((corrupt) => {
      expectIntegrityFailure(
        () => requireCanonicalPresentationCurrency(corrupt),
        'CURRENCY_PRESENTATION_DATA_INVALID'
      );
    });
  });

  it('uses only genuine product legacy fallbacks and surfaces corrupt stored fields', () => {
    expect(resolveProductPresentationCurrency({ price: 10 })).toBe('USD');
    expect(resolveProductPresentationCurrency({ currency: 'PKR', priceCurrency: 'PKR' })).toBe('PKR');
    expect(resolveProductPresentationMoney({ price: 0 })).toBe(0);
    expect(resolveProductPresentationMoney({ price: null, priceOriginal: 12.5 })).toBe(12.5);
    expect(resolveProductPresentationMoney({}, 'discountedPrice')).toBe(0);

    [null, '', 'usd', ' USD ', 'CAD', false].forEach((corrupt) => {
      expectIntegrityFailure(
        () => resolveProductPresentationCurrency({ currency: corrupt }),
        'PRODUCT_CURRENCY_METADATA_INVALID'
      );
    });
    [false, '', '10.00', NaN, Infinity, -1, 0.001].forEach((corrupt) => {
      expectIntegrityFailure(
        () => resolveProductPresentationMoney({ price: corrupt }),
        'PRODUCT_PRICE_INVALID'
      );
    });
  });

  it('uses null order snapshot fallbacks but rejects present corrupt aliases', () => {
    expect(resolveOrderItemPresentationMoney({ price: 0, currency: null }, 'USD')).toEqual({
      amount: 0,
      sourceCurrency: 'USD',
    });
    expect(resolveOrderItemPresentationMoney({
      price: null,
      sourcePrice: 1,
      priceOriginal: 1,
      sourceCurrency: null,
      priceCurrency: 'PKR',
    }, 'USD')).toEqual({ amount: 1, sourceCurrency: 'PKR' });
    expect(resolveOrderItemPresentationMoney({ price: null, sourcePrice: 2.5 }, null)).toEqual({
      amount: 2.5,
      sourceCurrency: 'USD',
    });

    [false, '', '1.00', NaN, Infinity, -1, 0.001].forEach((corrupt) => {
      expectIntegrityFailure(
        () => resolveOrderItemPresentationMoney({ price: corrupt }, 'USD'),
        'ORDER_PRESENTATION_DATA_INVALID'
      );
      expectIntegrityFailure(
        () => resolveOrderItemPresentationMoney({ price: null, sourcePrice: corrupt }, 'USD'),
        'ORDER_PRESENTATION_DATA_INVALID'
      );
    });
    ['', 'CAD', 'usd', ' USD '].forEach((corrupt) => {
      expectIntegrityFailure(
        () => resolveOrderItemPresentationMoney({ price: 10, currency: corrupt }, 'USD'),
        'ORDER_PRESENTATION_DATA_INVALID'
      );
      expectIntegrityFailure(
        () => resolveOrderItemPresentationMoney({
          price: null,
          sourcePrice: 10,
          sourceCurrency: corrupt,
        }, 'USD'),
        'ORDER_PRESENTATION_DATA_INVALID'
      );
    });
  });

  it('keeps visible stale-rate approximation while blocking cross-currency money actions', async () => {
    await renderProvider({ fallback: true });

    expect(latestCurrency.formatPrice(1, {
      sourceCurrency: 'USD',
      targetCurrency: 'PKR',
    })).toBe('≈Rs284.60');
    expect(latestCurrency.formatAmount(0)).toBe('$0.00');
    expect(latestCurrency.convertAmountForMoneyAction(0, 'USD', 'USD')).toBe(0);
    expect(() => latestCurrency.convertAmountForMoneyAction(0, 'USD', 'PKR'))
      .toThrow('Live exchange rates are unavailable for this conversion.');
    expect(latestCurrency.canConvertCurrency('USD', 'PKR')).toBe(false);
    expect(latestCurrency.canConvertCurrency('USD', 'USD')).toBe(true);
    expect(latestCurrency.canConvertCurrency('usd', 'USD')).toBe(false);
  });

  it('routes public conversion, product, and order-item formatters through strict reads', async () => {
    await renderProvider();

    expect(latestCurrency.convertAmount(0, 'USD', 'USD')).toBe(0);
    expect(latestCurrency.getProductPriceNumber({ price: 0 })).toBe(0);
    expect(latestCurrency.formatOrderItemPrice({ price: 0, currency: null }, {
      orderCurrency: 'USD',
    })).toBe('$0.00');
    expect(latestCurrency.formatOrderItemPrice({
      price: null,
      sourcePrice: 284.6,
      sourceCurrency: 'PKR',
    }, { orderCurrency: 'USD' })).toBe('$1.00');

    [false, '', '10', NaN, Infinity, -1, 0.001].forEach((corrupt) => {
      expectIntegrityFailure(
        () => latestCurrency.convertAmount(corrupt, 'USD', 'USD'),
        'CURRENCY_PRESENTATION_DATA_INVALID'
      );
      expectIntegrityFailure(
        () => latestCurrency.formatAmount(corrupt),
        'CURRENCY_PRESENTATION_DATA_INVALID'
      );
      expectIntegrityFailure(
        () => latestCurrency.formatOrderItemPrice({ price: corrupt }, { orderCurrency: 'USD' }),
        'ORDER_PRESENTATION_DATA_INVALID'
      );
    });
    expectIntegrityFailure(
      () => latestCurrency.convertAmount(10, 'usd', 'USD'),
      'CURRENCY_PRESENTATION_DATA_INVALID'
    );
    expectIntegrityFailure(
      () => latestCurrency.getProductPriceNumber({ price: '0', currency: 'USD' }),
      'PRODUCT_PRICE_INVALID'
    );
  });
});
