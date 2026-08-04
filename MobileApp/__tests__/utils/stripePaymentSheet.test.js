jest.mock('expo-linking', () => ({
  createURL: jest.fn((path = '') => `rozare://${String(path).replace(/^\//, '')}`),
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { appOwnership: 'standalone' },
}));

import { Platform } from 'react-native';
import {
  assertPaymentSheetPayload,
  assertUsableStripeConfig,
  buildPaymentSheetAppearance,
  buildPaymentSheetOptions,
  normalizePaymentSheetPayload,
  normalizeSavedCards,
  normalizeStripeConfig,
  normalizeWalletTopUpStatus,
  runPaymentSheet,
  toStripeHexColor,
  verifyWalletTopUp,
} from '../../src/utils/stripePaymentSheet';
import { darkPalette, lightPalette } from '../../src/styles/palettes';

const palette = {
  colors: {
    primary: '#6366F1', surface: '#FFFFFF', surfaceElevated: '#FFFFFF',
    borderStrong: '#E5E7EB', border: '#EEF2F7', text: '#111827',
    textSecondary: '#6B7280', textLight: '#9CA3AF', error: '#EF4444',
  },
};

const STRIPE_HEX = /^#[0-9A-F]{6}$/;
const expectValidAppearanceColors = (appearance) => {
  Object.values(appearance.colors).forEach((color) => expect(color).toMatch(STRIPE_HEX));
  Object.values(appearance.primaryButton.colors).forEach((color) => expect(color).toMatch(STRIPE_HEX));
};

describe('native Stripe PaymentSheet contracts', () => {
  beforeAll(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
  });

  it('normalizes and validates only publishable client keys', () => {
    expect(normalizeStripeConfig({ data: {
      publishableKey: 'pk_test_123', mode: 'test', merchantCountryCode: 'pk',
    } })).toEqual({
      publishableKey: 'pk_test_123', mode: 'test', merchantCountryCode: 'PK',
      merchantDisplayName: 'Rozare', googlePayEnabled: false,
    });
    expect(() => assertUsableStripeConfig({
      publishableKey: 'sk_live_secret', merchantCountryCode: 'US',
    })).toThrow('temporarily unavailable');
    expect(() => assertUsableStripeConfig(normalizeStripeConfig({
      publishableKey: 'pk_test_123', mode: 'test',
    }))).toThrow('merchant country');
    expect(normalizeStripeConfig({ data: {
      publishableKey: 'pk_live_123', stripeMode: 'live', merchantCountryCode: 'gb',
    } })).toEqual({
      publishableKey: 'pk_live_123', mode: 'live', merchantCountryCode: 'GB',
      merchantDisplayName: 'Rozare', googlePayEnabled: false,
    });
  });

  it('converts React Native rgba colors into Stripe-safe opaque hex colors', () => {
    expect(toStripeHexColor('rgba(0,0,0,0.16)', '#E5E7EB', '#FFFFFF')).toBe('#D6D6D6');
    expect(toStripeHexColor('rgba(0,0,0,0.08)', '#EEF2F7', '#FFFFFF')).toBe('#EBEBEB');
    expect(toStripeHexColor('rgba(255,255,255,0.18)', '#374151', '#1E2540')).toBe('#474C62');
    expect(toStripeHexColor('not-a-color', '#6366F1', '#FFFFFF')).toBe('#6366F1');
  });

  it('builds valid native appearance colors from the real light and dark palettes', () => {
    const lightAppearance = buildPaymentSheetAppearance(lightPalette, false);
    const darkAppearance = buildPaymentSheetAppearance(darkPalette, true);

    expectValidAppearanceColors(lightAppearance);
    expectValidAppearanceColors(darkAppearance);
    expect(lightAppearance.colors.componentBorder).toBe('#D6D6D6');
    expect(lightAppearance.colors.componentDivider).toBe('#EBEBEB');
    expect(darkAppearance.colors.componentBorder).toBe('#474C62');
    expect(darkAppearance.colors.componentDivider).toBe('#30364F');
  });

  it('accepts the order and wallet PaymentSheet response contract', () => {
    const payment = normalizePaymentSheetPayload({ data: {
      orderId: 'order-1',
      paymentIntentClientSecret: 'pi_123_secret_abc',
      customerId: 'cus_123',
      customerEphemeralKeySecret: 'ek_test_secret_abc',
    } });
    expect(payment).toEqual(expect.objectContaining({
      orderId: 'order-1', paymentIntentId: 'pi_123', customerId: 'cus_123',
      customerEphemeralKeySecret: 'ek_test_secret_abc',
    }));
    expect(assertPaymentSheetPayload(payment, 'payment')).toEqual(payment);

    expect(normalizePaymentSheetPayload({ data: {
      transaction: { _id: 'top-up-1', status: 'pending' },
      paymentIntentClientSecret: 'pi_topup_secret_abc',
      paymentIntentId: 'pi_topup',
      customerId: 'cus_123',
      customerEphemeralKeySecret: 'ek_test_secret_abc',
    } })).toEqual(expect.objectContaining({ topUpId: 'top-up-1', paymentIntentId: 'pi_topup' }));
  });

  it('builds branded PaymentSheet options with the stable ephemeral-key access path', () => {
    const options = buildPaymentSheetOptions({
      payment: {
        paymentIntentClientSecret: 'pi_123_secret_abc',
        customerId: 'cus_123',
        customerEphemeralKeySecret: 'ek_test_secret_abc',
      },
      config: { publishableKey: 'pk_test_123', mode: 'test', merchantCountryCode: 'PK' },
      currentUser: { name: 'Buyer', email: 'buyer@example.com' },
      currency: 'PKR',
      palette: lightPalette,
    });
    expect(options).toEqual(expect.objectContaining({
      merchantDisplayName: 'Rozare',
      customerId: 'cus_123',
      customerEphemeralKeySecret: 'ek_test_secret_abc',
      paymentIntentClientSecret: 'pi_123_secret_abc',
      allowsDelayedPaymentMethods: false,
    }));
    expect(options.customerSessionClientSecret).toBeUndefined();
    expect(options.googlePay).toBeUndefined();
    expectValidAppearanceColors(options.appearance);
  });

  it('still supports CustomerSession when the backend explicitly sends it', () => {
    const options = buildPaymentSheetOptions({
      payment: {
        paymentIntentClientSecret: 'pi_123_secret_abc',
        customerId: 'cus_123',
        customerSessionClientSecret: 'cuss_123_secret_abc',
      },
      config: { publishableKey: 'pk_test_123', mode: 'test', merchantCountryCode: 'PK' },
      currentUser: { name: 'Buyer', email: 'buyer@example.com' },
      currency: 'PKR',
      palette,
    });
    expect(options).toEqual(expect.objectContaining({
      customerId: 'cus_123',
      customerSessionClientSecret: 'cuss_123_secret_abc',
      paymentIntentClientSecret: 'pi_123_secret_abc',
    }));
    expect(options.customerEphemeralKeySecret).toBeUndefined();
  });

  it('adds Android Google Pay only when the backend enables it', () => {
    const options = buildPaymentSheetOptions({
      payment: {
        paymentIntentClientSecret: 'pi_123_secret_abc',
        customerId: 'cus_123',
        customerEphemeralKeySecret: 'ek_test_secret_abc',
      },
      config: {
        publishableKey: 'pk_test_123',
        mode: 'test',
        merchantCountryCode: 'PK',
        googlePayEnabled: true,
      },
      currentUser: { name: 'Buyer', email: 'buyer@example.com' },
      currency: 'PKR',
      palette,
    });
    expect(options.googlePay).toEqual({ merchantCountryCode: 'PK', currencyCode: 'PKR', testEnv: true });
  });

  it('reports native initialization failures without presenting the sheet', async () => {
    const initError = {
      code: 'Failed',
      localizedMessage: 'Expected hex string of length 6 or 8',
    };
    const initPaymentSheet = jest.fn().mockResolvedValue({ error: initError });
    const presentPaymentSheet = jest.fn();

    await expect(runPaymentSheet({ initPaymentSheet, presentPaymentSheet, options: {} }))
      .resolves.toEqual({ status: 'failed', error: initError, stage: 'initialize' });
    expect(presentPaymentSheet).not.toHaveBeenCalled();
  });

  it('distinguishes a user cancellation from a PaymentSheet failure', async () => {
    const initPaymentSheet = jest.fn().mockResolvedValue({});
    const presentPaymentSheet = jest.fn().mockResolvedValue({ error: { code: 'Canceled' } });
    await expect(runPaymentSheet({ initPaymentSheet, presentPaymentSheet, options: {} }))
      .resolves.toEqual(expect.objectContaining({ status: 'cancelled', stage: 'present' }));
  });

  it('treats didCancel as cancellation even without a Stripe error object', async () => {
    const initPaymentSheet = jest.fn().mockResolvedValue({});
    const presentPaymentSheet = jest.fn().mockResolvedValue({ didCancel: true });
    await expect(runPaymentSheet({ initPaymentSheet, presentPaymentSheet, options: {} }))
      .resolves.toEqual(expect.objectContaining({ status: 'cancelled', stage: 'present' }));
  });

  it('normalizes cards and marks the backend default', () => {
    expect(normalizeSavedCards({ data: {
      defaultPaymentMethodId: 'pm_2',
      cards: [
        { id: 'pm_1', card: { brand: 'visa', last4: '4242', exp_month: 8, exp_year: 2030 } },
        { id: 'pm_2', brand: 'mastercard', last4: '4444', expMonth: 4, expYear: 2031 },
      ],
    } })).toEqual(expect.objectContaining({
      defaultPaymentMethodId: 'pm_2',
      cards: expect.arrayContaining([
        expect.objectContaining({ id: 'pm_1', brand: 'visa', last4: '4242', isDefault: false }),
        expect.objectContaining({ id: 'pm_2', brand: 'mastercard', last4: '4444', isDefault: true }),
      ]),
    }));
  });

  it('treats the backend wallet ledger as the top-up source of truth', async () => {
    const pending = { data: { wallet: { balances: { USD: 10 } }, transactions: [
      { paymentIntentId: 'pi_topup', status: 'pending' },
    ] } };
    const paid = { data: { wallet: { balances: { USD: 25 } }, transactions: [
      { paymentIntentId: 'pi_topup', status: 'completed' },
    ] } };
    expect(normalizeWalletTopUpStatus({
      payload: pending, paymentIntentId: 'pi_topup', currency: 'USD', startingBalance: 10, amount: 15,
    }).status).toBe('pending');

    const apiClient = { get: jest.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(paid) };
    const result = await verifyWalletTopUp({
      apiClient,
      paymentIntentId: 'pi_topup',
      currency: 'USD',
      startingBalance: 10,
      amount: 15,
      attempts: 3,
      delayMs: 0,
      sleep: jest.fn().mockResolvedValue(undefined),
    });
    expect(result.status).toBe('paid');
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('polls the owner-scoped top-up status route and waits for webhook settlement', async () => {
    const apiClient = { get: jest.fn()
      .mockResolvedValueOnce({ data: {
        transactionId: 'top-up-1', status: 'pending', stripePaymentReceived: true, webhookProcessed: false,
      } })
      .mockResolvedValueOnce({ data: {
        transactionId: 'top-up-1', status: 'completed', stripePaymentReceived: true, webhookProcessed: true,
      } }) };

    const result = await verifyWalletTopUp({
      apiClient,
      topUpId: 'top-up-1',
      paymentIntentId: 'pi_topup',
      currency: 'USD',
      startingBalance: 10,
      amount: 15,
      attempts: 2,
      delayMs: 0,
      sleep: jest.fn().mockResolvedValue(undefined),
    });

    expect(result.status).toBe('paid');
    expect(apiClient.get).toHaveBeenNthCalledWith(
      1,
      '/api/wallet/top-ups/top-up-1/status',
      { params: { paymentIntentId: 'pi_topup' } }
    );
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });
});
