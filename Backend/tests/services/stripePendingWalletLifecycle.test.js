'use strict';

const mockRetrievePaymentIntent = jest.fn();
const mockCancelPaymentIntent = jest.fn();
const mockRetrieveCheckoutSession = jest.fn();
const mockExpireCheckoutSession = jest.fn();
const mockOrderFind = jest.fn();
const mockWalletFind = jest.fn();
const mockCloseWithoutReference = jest.fn();
const mockCancelFromPaymentIntent = jest.fn();
const mockCompleteFromPaymentIntent = jest.fn();
const mockCompleteFromCheckout = jest.fn();
const mockFailFromCheckout = jest.fn();
const mockRecoverSetup = jest.fn();
const mockValidatePaymentIntent = jest.fn();
const mockValidateCheckout = jest.fn();

jest.mock('../../config/stripe', () => ({
  stripe: {
    paymentIntents: {
      retrieve: mockRetrievePaymentIntent,
      cancel: mockCancelPaymentIntent,
    },
    checkout: {
      sessions: {
        retrieve: mockRetrieveCheckoutSession,
        expire: mockExpireCheckoutSession,
      },
    },
  },
}));

jest.mock('../../models/Order', () => ({ find: mockOrderFind }));
jest.mock('../../models/WalletTransaction', () => ({ find: mockWalletFind }));
jest.mock('../../services/stripeOrderPaymentService', () => ({
  attachStripeOrderReference: jest.fn(),
  fulfillStripeOrder: jest.fn(),
  fulfillStripeOrderPaymentIntent: jest.fn(),
  validateStripeOrderPaymentIntent: jest.fn(),
  validateStripeOrderSession: jest.fn(),
}));
jest.mock('../../services/stripeOrderSetupService', () => ({
  createHostedOrderCheckoutSession: jest.fn(),
  createNativeOrderPaymentIntent: jest.fn(),
}));
jest.mock('../../services/stripePaymentIntentFactory', () => ({
  isDefinitiveStripeCreationError: jest.fn(),
}));
jest.mock('../../services/couponUsageService', () => ({
  deleteUnpaidOrderAndReleaseCoupons: jest.fn(),
}));
jest.mock('../../services/orderCancellationService', () => ({
  cancelUnpaidOrderLocally: jest.fn(),
}));
jest.mock('../../services/walletService', () => ({
  cancelWalletTopUpFromPaymentIntent: mockCancelFromPaymentIntent,
  closeWalletTopUpWithoutStripeReference: mockCloseWithoutReference,
  completeWalletTopUp: mockCompleteFromCheckout,
  completeWalletTopUpFromPaymentIntent: mockCompleteFromPaymentIntent,
  failWalletTopUp: mockFailFromCheckout,
  recoverWalletTopUpStripeSetup: mockRecoverSetup,
  validateWalletTopUpCheckoutSession: mockValidateCheckout,
  validateWalletTopUpPaymentIntent: mockValidatePaymentIntent,
}));

const {
  cleanupStaleStripePaymentIntents,
  closeWalletTopUpPaymentIntent,
} = require('../../services/stripePendingPaymentService');

const topUp = (overrides = {}) => ({
  _id: 'wallet_top_up_123',
  type: 'top_up',
  user: 'user_123',
  status: 'pending',
  paymentFlow: 'payment_sheet',
  paymentSetupState: 'ready',
  stripePaymentIntentId: 'pi_wallet_123',
  stripeSessionId: null,
  paymentExpiresAt: new Date(Date.now() - 60_000),
  ...overrides,
});

const setQueries = (walletTopUps = []) => {
  mockOrderFind.mockReturnValue({
    sort: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
  });
  mockWalletFind.mockReturnValue({ limit: jest.fn().mockResolvedValue(walletTopUps) });
};

describe('Wallet top-up pending Stripe reconciliation', () => {
  let consoleError;

  beforeEach(() => {
    jest.clearAllMocks();
    setQueries();
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  test('fails closed while a no-reference PaymentSheet setup is still being recovered', async () => {
    const transaction = topUp({
      paymentSetupState: 'creating',
      stripePaymentIntentId: null,
    });
    mockCloseWithoutReference.mockResolvedValue({
      status: 'setup_recovery_pending',
      transaction,
    });

    const result = await closeWalletTopUpPaymentIntent(transaction);

    expect(result.status).toBe('setup_recovery_pending');
    expect(mockRetrievePaymentIntent).not.toHaveBeenCalled();
    expect(mockCancelFromPaymentIntent).not.toHaveBeenCalled();
  });

  test('continues against Stripe when reference attachment wins the no-reference close race', async () => {
    const stale = topUp({ stripePaymentIntentId: null, paymentSetupState: 'not_started' });
    const current = topUp();
    const cancelled = { id: 'pi_wallet_123', status: 'canceled' };
    mockCloseWithoutReference.mockResolvedValue({ status: 'reference_attached', transaction: current });
    mockRetrievePaymentIntent.mockResolvedValue(cancelled);
    mockCancelFromPaymentIntent.mockResolvedValue({ ...current, status: 'expired' });

    const result = await closeWalletTopUpPaymentIntent(stale, {
      status: 'expired',
      requireExpired: true,
    });

    expect(mockValidatePaymentIntent).toHaveBeenCalledWith(current, cancelled);
    expect(mockCancelFromPaymentIntent).toHaveBeenCalledWith(cancelled, {
      status: 'expired',
      reason: 'Payment was cancelled by the buyer.',
    });
    expect(result.status).toBe('expired');
  });

  test('expires and durably closes an open hosted card-only Session', async () => {
    const transaction = topUp({
      paymentFlow: 'checkout_session',
      stripePaymentIntentId: null,
      stripeSessionId: 'cs_wallet_123',
    });
    const open = { id: 'cs_wallet_123', status: 'open', payment_status: 'unpaid' };
    const expired = { id: 'cs_wallet_123', status: 'expired', payment_status: 'unpaid' };
    setQueries([transaction]);
    mockRetrieveCheckoutSession.mockResolvedValue(open);
    mockExpireCheckoutSession.mockResolvedValue(expired);
    mockFailFromCheckout.mockResolvedValue({ ...transaction, status: 'expired' });

    const result = await cleanupStaleStripePaymentIntents();

    expect(mockExpireCheckoutSession).toHaveBeenCalledWith('cs_wallet_123');
    expect(mockValidateCheckout).toHaveBeenNthCalledWith(1, transaction, open);
    expect(mockValidateCheckout).toHaveBeenNthCalledWith(2, transaction, expired);
    expect(mockFailFromCheckout).toHaveBeenCalledWith(
      expired,
      'The secure hosted Wallet top-up window expired.',
      'scheduled-recovery:cs_wallet_123',
    );
    expect(result.walletTopUps).toBe(1);
  });

  test('credits captured hosted payment discovered in the Session-expiry race', async () => {
    const transaction = topUp({
      paymentFlow: 'checkout_session',
      stripePaymentIntentId: null,
      stripeSessionId: 'cs_wallet_paid',
    });
    const open = { id: 'cs_wallet_paid', status: 'open', payment_status: 'unpaid' };
    const paid = { id: 'cs_wallet_paid', status: 'complete', payment_status: 'paid' };
    setQueries([transaction]);
    mockRetrieveCheckoutSession.mockResolvedValueOnce(open).mockResolvedValueOnce(paid);
    mockExpireCheckoutSession.mockRejectedValue(new Error('Session completed during expiration'));

    const result = await cleanupStaleStripePaymentIntents();

    expect(mockCompleteFromCheckout).toHaveBeenCalledWith(
      paid,
      'scheduled-recovery:cs_wallet_paid',
    );
    expect(mockFailFromCheckout).not.toHaveBeenCalled();
    expect(result.walletTopUps).toBe(0);
  });

  test('recovers a lost PaymentIntent reference and credits captured payment instead of expiring it', async () => {
    const pending = topUp({
      paymentSetupState: 'creating',
      stripePaymentIntentId: null,
    });
    const attached = topUp();
    const succeeded = { id: 'pi_wallet_123', status: 'succeeded' };
    setQueries([pending]);
    mockRecoverSetup.mockResolvedValue({ transaction: attached, stripeObject: succeeded });
    mockRetrievePaymentIntent.mockResolvedValue(succeeded);

    const result = await cleanupStaleStripePaymentIntents();

    expect(mockCompleteFromPaymentIntent).toHaveBeenCalledWith(
      succeeded,
      'scheduled-recovery:pi_wallet_123',
    );
    expect(mockCancelFromPaymentIntent).not.toHaveBeenCalled();
    expect(result.walletTopUps).toBe(0);
  });

  test('keeps ambiguous lost-reference recovery pending without local expiration', async () => {
    const transaction = topUp({
      paymentSetupState: 'creating',
      stripePaymentIntentId: null,
    });
    setQueries([transaction]);
    mockRecoverSetup.mockRejectedValue(Object.assign(new Error('network reset'), {
      code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING',
    }));

    const result = await cleanupStaleStripePaymentIntents();

    expect(mockCloseWithoutReference).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      `[stripe-cleanup] Wallet top-up ${transaction._id}:`,
      'network reset',
    );
    expect(result.walletTopUps).toBe(0);
  });

  test('safely expires a setup that durably never started', async () => {
    const transaction = topUp({
      paymentSetupState: 'not_started',
      stripePaymentIntentId: null,
    });
    setQueries([transaction]);
    mockCloseWithoutReference.mockResolvedValue({ status: 'expired', transaction: { ...transaction, status: 'expired' } });

    const result = await cleanupStaleStripePaymentIntents();

    expect(mockCloseWithoutReference).toHaveBeenCalledWith(transaction, expect.objectContaining({
      status: 'expired',
      requireExpired: true,
    }));
    expect(result.walletTopUps).toBe(1);
  });
});
