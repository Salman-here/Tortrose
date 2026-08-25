import {
  exactWalletMoneyIsValid,
  inspectWalletSummaryPresentation,
  walletTransactionPresentationIsValid,
} from '../../src/utils/walletPresentationSafety';

const validSummary = () => ({
  wallet: {
    balances: { USD: 0, PKR: 1880, EUR: 1.25, GBP: 2 },
    status: 'active',
    paymentRisk: {
      restricted: false,
      provisionalCount: 0,
      canTopUpForSettlement: false,
      byCurrency: {},
    },
  },
  transactions: [{
    _id: 'tx-1',
    type: 'top_up',
    direction: 'credit',
    status: 'completed',
    amount: 1880,
    currency: 'PKR',
    balanceAfter: 1880,
    creditedAmount: 1880,
    appliedToLiability: 0,
    remainingLiability: 0,
  }],
});

describe('wallet presentation safety', () => {
  it('accepts an exact complete multi-currency Wallet summary', () => {
    const summary = validSummary();
    expect(inspectWalletSummaryPresentation(summary)).toEqual(summary);
  });

  it.each([undefined, null, true, '0', -1, 0.001, Infinity, Number.MAX_VALUE])(
    'rejects a corrupt balance instead of presenting it as zero: %p',
    (value) => {
      const summary = validSummary();
      summary.wallet.balances.USD = value;
      expect(inspectWalletSummaryPresentation(summary)).toBeNull();
    },
  );

  it('requires every supported balance bucket explicitly', () => {
    const summary = validSummary();
    delete summary.wallet.balances.GBP;
    expect(inspectWalletSummaryPresentation(summary)).toBeNull();
  });

  it('rejects coercible transaction amounts and currencies', () => {
    ['1880', true, null, 0, 0.001].forEach((amount) => {
      expect(walletTransactionPresentationIsValid({
        ...validSummary().transactions[0],
        amount,
      })).toBe(false);
    });
    expect(walletTransactionPresentationIsValid({
      ...validSummary().transactions[0],
      currency: 'pkr',
    })).toBe(false);
  });

  it('rejects duplicate activity identities that would make verification ambiguous', () => {
    const summary = validSummary();
    summary.transactions.push({ ...summary.transactions[0] });
    expect(inspectWalletSummaryPresentation(summary)).toBeNull();
  });

  it('requires risk minor and major units to agree exactly', () => {
    const summary = validSummary();
    summary.wallet.paymentRisk.byCurrency.PKR = {
      heldMinor: 100,
      held: 1,
      outstandingMinor: 250,
      outstanding: 2.5,
    };
    expect(inspectWalletSummaryPresentation(summary)).not.toBeNull();
    summary.wallet.paymentRisk.byCurrency.PKR.outstanding = 2.49;
    expect(inspectWalletSummaryPresentation(summary)).toBeNull();
  });

  it('rejects Wallet status and risk combinations that could expose an unsafe top-up', () => {
    const activeRestricted = validSummary();
    activeRestricted.wallet.paymentRisk.restricted = true;
    expect(inspectWalletSummaryPresentation(activeRestricted)).toBeNull();

    const lockedSettlement = validSummary();
    lockedSettlement.wallet.status = 'locked';
    lockedSettlement.wallet.paymentRisk.restricted = true;
    lockedSettlement.wallet.paymentRisk.canTopUpForSettlement = true;
    lockedSettlement.wallet.paymentRisk.byCurrency.PKR = {
      heldMinor: 0,
      held: 0,
      outstandingMinor: 250,
      outstanding: 2.5,
    };
    expect(inspectWalletSummaryPresentation(lockedSettlement)).not.toBeNull();
    lockedSettlement.wallet.paymentRisk.byCurrency.PKR.outstandingMinor = 0;
    lockedSettlement.wallet.paymentRisk.byCurrency.PKR.outstanding = 0;
    expect(inspectWalletSummaryPresentation(lockedSettlement)).toBeNull();
  });

  it('recognizes only reversible exact-cent Wallet money', () => {
    expect(exactWalletMoneyIsValid(0)).toBe(true);
    expect(exactWalletMoneyIsValid(12.34)).toBe(true);
    expect(exactWalletMoneyIsValid(12.345)).toBe(false);
  });
});
