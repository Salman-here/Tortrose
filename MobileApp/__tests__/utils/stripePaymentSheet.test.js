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
  runSetupIntentPaymentSheetAttempt,
  runWalletPaymentSheetAttempt,
  toStripeHexColor,
  verifyWalletTopUp,
} from '../../src/utils/stripePaymentSheet';
import { darkPalette, lightPalette } from '../../src/styles/palettes';

const testStripeConfig = {
  publishableKey: 'pk_test_123',
  mode: 'test',
  merchantCountryCode: 'PK',
  customerSessionEnabled: true,
  customerAccessMode: 'customer_session',
  ephemeralKeyEnabled: false,
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
      customerSessionEnabled: false, customerAccessMode: '', ephemeralKeyEnabled: false,
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
      customerSessionEnabled: false, customerAccessMode: '', ephemeralKeyEnabled: false,
    });
    expect(assertUsableStripeConfig(normalizeStripeConfig({ data: {
      publishableKey: 'pk_live_123', stripeMode: 'live', merchantCountryCode: 'ae',
      customerSessionEnabled: true, customerAccessMode: 'customer_session',
      ephemeralKeyEnabled: false, googlePayEnabled: true,
    } }))).toEqual(expect.objectContaining({
      customerSessionEnabled: true,
      customerAccessMode: 'customer_session',
      ephemeralKeyEnabled: false,
      googlePayEnabled: true,
    }));
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
      customerSessionClientSecret: 'cuss_123_secret_abc',
    } });
    expect(payment).toEqual(expect.objectContaining({
      orderId: 'order-1', paymentIntentId: 'pi_123', customerId: 'cus_123',
      customerSessionClientSecret: 'cuss_123_secret_abc',
    }));
    expect(assertPaymentSheetPayload(payment, 'payment')).toEqual(payment);

    expect(normalizePaymentSheetPayload({ data: {
      transaction: { _id: 'top-up-1', status: 'pending' },
      paymentIntentClientSecret: 'pi_topup_secret_abc',
      paymentIntentId: 'pi_topup',
      customerId: 'cus_123',
      customerSessionClientSecret: 'cuss_123_secret_abc',
    } })).toEqual(expect.objectContaining({ topUpId: 'top-up-1', paymentIntentId: 'pi_topup' }));
  });

  it('builds branded PaymentSheet options with CustomerSession only', () => {
    const options = buildPaymentSheetOptions({
      payment: {
        paymentIntentClientSecret: 'pi_123_secret_abc',
        customerId: 'cus_123',
        customerSessionClientSecret: 'cuss_123_secret_abc',
      },
      config: testStripeConfig,
      currentUser: { name: 'Buyer', email: 'buyer@example.com' },
      currency: 'PKR',
      palette: lightPalette,
    });
    expect(options).toEqual(expect.objectContaining({
      merchantDisplayName: 'Rozare',
      customerId: 'cus_123',
      customerSessionClientSecret: 'cuss_123_secret_abc',
      paymentIntentClientSecret: 'pi_123_secret_abc',
      allowsDelayedPaymentMethods: false,
    }));
    expect(options.customerEphemeralKeySecret).toBeUndefined();
    expect(options.googlePay).toBeUndefined();
    expectValidAppearanceColors(options.appearance);
  });

  it('rejects an Ephemeral Key-only payload', () => {
    expect(() => buildPaymentSheetOptions({
      payment: {
        paymentIntentClientSecret: 'pi_123_secret_abc',
        customerId: 'cus_123',
        customerEphemeralKeySecret: 'ek_test_secret_abc',
      },
      config: testStripeConfig,
      currentUser: { name: 'Buyer', email: 'buyer@example.com' },
      currency: 'PKR',
      palette: darkPalette,
      isDark: true,
    })).toThrow('CustomerSession');
  });

  it('adds Android Google Pay only when the backend enables it', () => {
    const options = buildPaymentSheetOptions({
      payment: {
        paymentIntentClientSecret: 'pi_123_secret_abc',
        customerId: 'cus_123',
        customerSessionClientSecret: 'cuss_123_secret_abc',
      },
      config: {
        ...testStripeConfig,
        googlePayEnabled: true,
      },
      currentUser: { name: 'Buyer', email: 'buyer@example.com' },
      currency: 'PKR',
      palette: lightPalette,
    });
    expect(options.googlePay).toEqual({ merchantCountryCode: 'PK', currencyCode: 'PKR', testEnv: true });
  });

  it('uses the live Google Pay environment for production wallet and checkout sheets', () => {
    const options = buildPaymentSheetOptions({
      payment: {
        paymentIntentClientSecret: 'pi_live_secret_abc',
        customerId: 'cus_live',
        customerSessionClientSecret: 'cuss_live_secret_abc',
      },
      config: {
        ...testStripeConfig,
        publishableKey: 'pk_live_123',
        mode: 'live',
        merchantCountryCode: 'AE',
        googlePayEnabled: true,
      },
      currentUser: { name: 'Buyer', email: 'buyer@example.com' },
      currency: 'AED',
      palette: darkPalette,
      isDark: true,
    });

    expect(options.googlePay).toEqual({ merchantCountryCode: 'AE', currencyCode: 'AED', testEnv: false });
    expectValidAppearanceColors(options.appearance);
  });

  it('cancels a Wallet top-up immediately when PaymentSheet initialization fails', async () => {
    const initError = {
      code: 'Failed',
      localizedMessage: 'Expected hex string of length 6 or 8',
    };
    const initPaymentSheet = jest.fn().mockResolvedValue({ error: initError });
    const presentPaymentSheet = jest.fn();
    const apiClient = { post: jest.fn().mockResolvedValue({ data: { status: 'cancelled' } }) };

    await expect(runWalletPaymentSheetAttempt({
      initPaymentSheet,
      presentPaymentSheet,
      options: {},
      apiClient,
      topUpId: 'top-up/1',
      paymentIntentId: 'pi_topup',
    })).resolves.toEqual(expect.objectContaining({
      status: 'failed', error: initError, stage: 'initialize', cleanupError: null,
    }));
    expect(presentPaymentSheet).not.toHaveBeenCalled();
    expect(apiClient.post).toHaveBeenCalledWith('/api/wallet/top-ups/top-up%2F1/cancel', {
      paymentIntentId: 'pi_topup',
      closeReason: 'payment_sheet_initialize',
    });
  });

  it('cancels an Add Card SetupIntent when PaymentSheet initialization throws', async () => {
    const initError = new Error('Native bridge unavailable');
    const apiClient = { post: jest.fn().mockResolvedValue({ data: { status: 'canceled' } }) };

    await expect(runSetupIntentPaymentSheetAttempt({
      initPaymentSheet: jest.fn().mockRejectedValue(initError),
      presentPaymentSheet: jest.fn(),
      options: {},
      apiClient,
      setupIntentId: 'seti_123',
    })).resolves.toEqual(expect.objectContaining({
      status: 'failed', error: initError, stage: 'initialize', cleanupError: null,
    }));
    expect(apiClient.post).toHaveBeenCalledWith('/api/payment-methods/setup/seti_123/cancel', {
      closeReason: 'payment_sheet_initialize',
    });
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
    const pending = { data: { wallet: { balances: { USD: 1000 } }, transactions: [
      { paymentIntentId: 'pi_topup', status: 'pending' },
      { paymentIntentId: 'pi_unrelated', status: 'completed', amount: 990 },
    ] } };
    const paid = { data: { wallet: { balances: { USD: 25 } }, transactions: [
      { paymentIntentId: 'pi_topup', status: 'completed' },
    ] } };
    expect(normalizeWalletTopUpStatus({
      payload: pending, paymentIntentId: 'pi_topup', currency: 'USD', startingBalance: 10, amount: 15,
    }).status).toBe('pending');
    expect(normalizeWalletTopUpStatus({
      payload: { data: { wallet: { balances: { USD: 25 } }, transactions: [
        { paymentIntentId: 'pi_unrelated', status: 'completed', amount: 15 },
      ] } },
      paymentIntentId: 'pi_missing', currency: 'USD', startingBalance: 10, amount: 15,
    }).status).toBe('pending');
    expect(normalizeWalletTopUpStatus({
      payload: { data: { wallet: { balances: { USD: 1000 } }, transactions: [
        { paymentIntentId: 'pi_topup', status: 'failed' },
      ] } },
      paymentIntentId: 'pi_topup', currency: 'USD', startingBalance: 10, amount: 15,
    }).status).toBe('failed');

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
