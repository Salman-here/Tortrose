import {
  canTopUpWalletCurrency,
  findWalletTransaction,
  getTopUpCompletionBreakdown,
  getWalletCurrencyRisk,
  isWalletRiskSettlementTopUp,
  shouldRetainWalletTopUpAttempt,
} from '../../src/utils/walletPaymentRisk';

describe('wallet payment-risk client contract', () => {
  test('active wallets can top up but missing wallets fail closed', () => {
    expect(canTopUpWalletCurrency({ status: 'active' }, 'USD')).toBe(true);
    expect(canTopUpWalletCurrency(null, 'USD')).toBe(false);
  });

  test('an arbitrary lock never gains top-up permission', () => {
    const wallet = {
      status: 'locked',
      lockedReason: 'Administrative review',
      paymentRisk: {
        byCurrency: { USD: { outstandingMinor: 5000, outstanding: 50 } },
      },
    };
    expect(canTopUpWalletCurrency(wallet, 'USD')).toBe(false);
    expect(isWalletRiskSettlementTopUp(wallet, 'USD')).toBe(false);
  });

  test('a risk lock requires explicit permission and positive liability in the selected currency', () => {
    const wallet = {
      status: 'locked',
      paymentRisk: {
        canTopUpForSettlement: true,
        byCurrency: {
          USD: { heldMinor: 125, outstandingMinor: 5000, held: 1.25, outstanding: 50 },
          PKR: { heldMinor: 0, outstandingMinor: 0, held: 0, outstanding: 0 },
        },
      },
    };
    expect(canTopUpWalletCurrency(wallet, 'usd')).toBe(true);
    expect(isWalletRiskSettlementTopUp(wallet, 'USD')).toBe(true);
    expect(canTopUpWalletCurrency(wallet, 'PKR')).toBe(false);
    expect(canTopUpWalletCurrency(wallet, 'EUR')).toBe(false);
    expect(getWalletCurrencyRisk(wallet, 'USD')).toEqual({ held: 1.25, outstanding: 50 });
  });

  test('invalid exact-minor fields fail closed even if a decimal fallback is present', () => {
    const wallet = {
      status: 'locked',
      paymentRisk: {
        canTopUpForSettlement: true,
        byCurrency: { USD: { outstandingMinor: 1.5, outstanding: 100 } },
      },
    };
    expect(getWalletCurrencyRisk(wallet, 'USD').outstanding).toBeNull();
    expect(canTopUpWalletCurrency(wallet, 'USD')).toBe(false);
  });

  test('minor-unit risk snapshots that cannot round-trip exactly fail closed', () => {
    const wallet = {
      status: 'locked',
      paymentRisk: {
        canTopUpForSettlement: true,
        byCurrency: { USD: { outstandingMinor: 7036874417766401 } },
      },
    };
    expect(getWalletCurrencyRisk(wallet, 'USD').outstanding).toBeNull();
    expect(canTopUpWalletCurrency(wallet, 'USD')).toBe(false);
    expect(getTopUpCompletionBreakdown({
      status: 'completed',
      amount: 70368744177664.02,
      currency: 'USD',
      creditedAmount: 70368744177664.02,
      appliedToLiability: 0,
      remainingLiability: 0,
    })).toBeNull();
  });

  test('completed surplus top-ups expose exact credited, applied, and cleared amounts', () => {
    expect(getTopUpCompletionBreakdown({
      status: 'completed',
      amount: 12.34,
      currency: 'usd',
      creditedAmount: 2.34,
      appliedToLiability: 10,
      remainingLiability: 0,
    })).toEqual({
      creditedAmount: 2.34,
      appliedToLiability: 10,
      remainingLiability: 0,
      currency: 'USD',
    });
  });

  test('partial payments remain unavailable while liability is still outstanding', () => {
    expect(getTopUpCompletionBreakdown({
      status: 'completed',
      amount: 12.34,
      currency: 'USD',
      creditedAmount: 0,
      appliedToLiability: 12.34,
      remainingLiability: 4.56,
    })).toEqual({
      creditedAmount: 0,
      appliedToLiability: 12.34,
      remainingLiability: 4.56,
      currency: 'USD',
    });
  });

  test('legacy defaults and inconsistent completion totals are not presented as available credit', () => {
    expect(getTopUpCompletionBreakdown({
      status: 'completed',
      amount: 25,
      currency: 'USD',
      creditedAmount: 0,
      appliedToLiability: 0,
      remainingLiability: 0,
    })).toBeNull();
    expect(getTopUpCompletionBreakdown({
      status: 'completed',
      amount: 25,
      currency: 'USD',
      creditedAmount: 20,
      appliedToLiability: 6,
      remainingLiability: 0,
    })).toBeNull();
    expect(getTopUpCompletionBreakdown({
      status: 'completed',
      amount: 25,
      currency: 'USD',
      creditedAmount: 5,
      appliedToLiability: 20,
      remainingLiability: 1,
    })).toBeNull();
  });

  test('finds the authoritative serialized transaction without guessing', () => {
    const transaction = { _id: 'topup-1', status: 'completed' };
    expect(findWalletTransaction({ transactions: [transaction] }, 'topup-1')).toBe(transaction);
    expect(findWalletTransaction({ transaction }, 'topup-1')).toBe(transaction);
    expect(findWalletTransaction({ transactions: [transaction] }, 'missing')).toBeNull();
  });

  test('rotates a terminal top-up retry key while retaining ambiguous conflicts', () => {
    expect(shouldRetainWalletTopUpAttempt({
      response: { status: 409, data: { code: 'WALLET_TOP_UP_RETRY_REQUIRED' } },
    })).toBe(false);
    expect(shouldRetainWalletTopUpAttempt({
      response: { status: 409, data: { code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING' } },
    })).toBe(true);
    expect(shouldRetainWalletTopUpAttempt({
      response: { status: 409, data: { code: 'TOP_UP_CREATION_IN_PROGRESS' } },
    })).toBe(true);
    expect(shouldRetainWalletTopUpAttempt({
      response: { status: 400, data: { code: 'WALLET_TOP_UP_INVALID' } },
    })).toBe(false);
  });
});
