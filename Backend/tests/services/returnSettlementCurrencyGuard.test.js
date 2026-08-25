'use strict';

jest.mock('../../models/ReturnRequest', () => ({ findOne: jest.fn(), find: jest.fn() }));
jest.mock('../../models/Order', () => ({ findById: jest.fn() }));
jest.mock('../../models/Product', () => ({}));
jest.mock('../../models/Store', () => ({}));
jest.mock('../../models/User', () => ({}));
jest.mock('../../models/SellerBalanceTransaction', () => ({ create: jest.fn(), find: jest.fn() }));
jest.mock('../../models/SellerSettlementLock', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../../services/financialNotificationOutboxService', () => ({
  enqueueReturnSettlementNotifications: jest.fn().mockResolvedValue({ buyer: [], seller: [] }),
}));
jest.mock('../../config/stripe', () => ({ stripe: {} }));
jest.mock('../../services/currencyService', () => ({
  isSupportedCurrency: value => ['USD', 'PKR', 'EUR', 'GBP'].includes(String(value || '').toUpperCase()),
  normalizeCurrency: value => String(value || 'USD').toUpperCase(),
}));
jest.mock('../../services/returnPolicyService', () => ({
  normalizeReturnPolicy: jest.fn(),
  returnEligibilityDeadline: jest.fn(),
  canTransitionReturnStatus: jest.fn(),
}));
jest.mock('../../services/walletService', () => ({
  runInTransaction: jest.fn(async work => work({ id: 'session-1' })),
  creditWalletInSession: jest.fn(),
  toStripeMinorUnits: jest.fn(),
  roundMoney: value => Math.round((Number(value) || 0) * 100) / 100,
}));
jest.mock('../../services/stripePaymentRiskMarkerService', () => ({
  claimStripePaymentCompletion: jest.fn().mockResolvedValue({}),
  markStripePaymentCompletionDone: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../services/walletOrderFundingRiskService', () => ({
  assertWalletOrderFundingReturnable: jest.fn().mockResolvedValue({ returnable: true, sourceIds: [] }),
  attachReturnedWalletFundingProvenance: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../services/orderDiscountService', () => ({
  buildOrderItemDiscountAllocations: jest.fn(),
}));
jest.mock('../../services/orderMoneyService', () => ({
  buildOrderItemMoneyAllocations: jest.fn(),
  ensureOrderSellerSettlement: jest.fn(),
  getAccountingOrderCurrency: jest.fn(order => order.currency || 'USD'),
  sellerSettlementEntry: jest.fn((entries, sellerId) => (
    entries.find(entry => String(entry.seller) === String(sellerId)) || null
  )),
  sellerSettlementUsdTargetForSource: jest.fn(),
  sellerOrderSummaryForItems: jest.fn(),
}));
jest.mock('../../controllers/PaymentController', () => ({
  buildSellerPaymentSummary: jest.fn(),
}));

const ReturnRequest = require('../../models/ReturnRequest');
const Order = require('../../models/Order');
const SellerBalanceTransaction = require('../../models/SellerBalanceTransaction');
const SellerSettlementLock = require('../../models/SellerSettlementLock');
const { creditWalletInSession } = require('../../services/walletService');
const {
  ensureOrderSellerSettlement,
  sellerSettlementUsdTargetForSource,
} = require('../../services/orderMoneyService');
const { buildSellerPaymentSummary } = require('../../controllers/PaymentController');
const { settleFromSellerBalance } = require('../../services/returnService');

const makeRequest = () => ({
  _id: 'return-1',
  order: 'order-1',
  orderId: 'ORDER-1',
  buyer: 'buyer-1',
  seller: 'seller-1',
  returnNumber: 'RET-1',
  currency: 'PKR',
  status: 'under_review',
  refund: { totalAmount: 280 },
  settlement: {},
  statusHistory: [],
  save: jest.fn().mockResolvedValue(undefined),
});

const mockSessionQuery = value => ({ session: jest.fn().mockResolvedValue(value) });
const mockSelectLeanSessionQuery = value => ({
  select: jest.fn().mockReturnThis(),
  lean: jest.fn().mockReturnThis(),
  session: jest.fn().mockResolvedValue(value),
});

describe('seller-balance return settlement currency guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ensureOrderSellerSettlement.mockReset();
    sellerSettlementUsdTargetForSource.mockReset();
    SellerSettlementLock.findOneAndUpdate.mockResolvedValue({});
    buildSellerPaymentSummary.mockResolvedValue({ revenue: { withdrawableBalance: 100 } });
    ReturnRequest.find.mockReturnValue(mockSelectLeanSessionQuery([]));
    SellerBalanceTransaction.find.mockReturnValue(mockSelectLeanSessionQuery([]));
  });

  test('rejects a legacy non-USD settlement before debit when no trustworthy snapshot can be frozen', async () => {
    const request = makeRequest();
    const order = { _id: 'order-1', currency: 'PKR' };
    ReturnRequest.findOne.mockReturnValue(mockSessionQuery(request));
    Order.findById.mockReturnValue({
      select: jest.fn(() => mockSessionQuery(order)),
    });
    ensureOrderSellerSettlement.mockRejectedValue(Object.assign(
      new Error('rates unavailable'),
      { code: 'SELLER_SETTLEMENT_EXCHANGE_RATE_MISSING' },
    ));

    await expect(settleFromSellerBalance({
      returnRequestId: request._id,
      sellerId: request.seller,
    })).rejects.toMatchObject({
      statusCode: 503,
      code: 'EXCHANGE_RATES_UNAVAILABLE',
    });

    expect(ensureOrderSellerSettlement).toHaveBeenCalledWith(order, {
      session: { id: 'session-1' },
      requireOrderTotal: true,
    });
    expect(SellerBalanceTransaction.create).not.toHaveBeenCalled();
    expect(creditWalletInSession).not.toHaveBeenCalled();
    expect(request.save).not.toHaveBeenCalled();
  });

  test('requires audited historical FX backfill instead of retrying against a later live rate', async () => {
    const request = makeRequest();
    const order = { _id: 'order-1', currency: 'PKR' };
    ReturnRequest.findOne.mockReturnValue(mockSessionQuery(request));
    Order.findById.mockReturnValue({
      select: jest.fn(() => mockSessionQuery(order)),
    });
    ensureOrderSellerSettlement.mockRejectedValue(Object.assign(
      new Error('historical rate missing'),
      { code: 'SELLER_SETTLEMENT_HISTORICAL_RATE_MISSING' },
    ));

    await expect(settleFromSellerBalance({
      returnRequestId: request._id,
      sellerId: request.seller,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'LEGACY_ORDER_FX_BACKFILL_REQUIRED',
    });

    expect(SellerBalanceTransaction.create).not.toHaveBeenCalled();
    expect(creditWalletInSession).not.toHaveBeenCalled();
  });

  test('uses the frozen checkout rate before creating the seller debit', async () => {
    const request = makeRequest();
    const order = { _id: 'order-1', currency: 'PKR' };
    ReturnRequest.findOne.mockReturnValue(mockSessionQuery(request));
    Order.findById.mockReturnValue({
      select: jest.fn(() => mockSessionQuery(order)),
    });
    ensureOrderSellerSettlement.mockResolvedValue([{
      seller: 'seller-1',
      sourceCurrency: 'PKR',
      sourceAmountMinor: 28000,
      amountUSDMinor: 100,
    }]);
    sellerSettlementUsdTargetForSource.mockReturnValue(100);
    SellerBalanceTransaction.create.mockResolvedValue([{ _id: 'debit-1' }]);
    creditWalletInSession.mockResolvedValue({ _id: 'wallet-1' });

    await expect(settleFromSellerBalance({
      returnRequestId: request._id,
      sellerId: request.seller,
    })).resolves.toBe(request);

    expect(sellerSettlementUsdTargetForSource).toHaveBeenCalledWith(
      expect.objectContaining({ amountUSDMinor: 100 }),
      28000,
    );
    expect(SellerBalanceTransaction.create).toHaveBeenCalledWith([
      expect.objectContaining({ amountUSD: 1, sourceAmount: 280, sourceCurrency: 'PKR' }),
    ], { session: { id: 'session-1' } });
    expect(request.status).toBe('returned');
    expect(request.save).toHaveBeenCalledWith({ session: { id: 'session-1' } });
  });

  test('converts cumulative source refunds and debits only the remaining USD cent', async () => {
    const request = makeRequest();
    request._id = 'return-2';
    request.refund.totalAmount = 2;
    const order = { _id: 'order-1', currency: 'PKR' };
    ReturnRequest.findOne.mockReturnValue(mockSessionQuery(request));
    ReturnRequest.find.mockReturnValue(mockSelectLeanSessionQuery([
      { _id: 'return-1', refund: { totalAmount: 2 } },
    ]));
    SellerBalanceTransaction.find.mockReturnValue(mockSelectLeanSessionQuery([
      { amountUSD: 0.01 },
    ]));
    Order.findById.mockReturnValue({
      select: jest.fn(() => mockSessionQuery(order)),
    });
    ensureOrderSellerSettlement.mockResolvedValue([{
      seller: 'seller-1',
      sourceCurrency: 'PKR',
      sourceAmountMinor: 400,
      amountUSDMinor: 1,
    }]);
    sellerSettlementUsdTargetForSource.mockReturnValue(1);
    SellerBalanceTransaction.create.mockResolvedValue([{ _id: 'source-only-debit' }]);
    creditWalletInSession.mockResolvedValue({ _id: 'wallet-2' });

    await expect(settleFromSellerBalance({
      returnRequestId: request._id,
      sellerId: request.seller,
    })).resolves.toBe(request);

    expect(sellerSettlementUsdTargetForSource).toHaveBeenCalledWith(
      expect.objectContaining({ sourceAmountMinor: 400 }),
      400,
    );
    expect(SellerBalanceTransaction.create).toHaveBeenCalledWith([
      expect.objectContaining({ amountUSD: 0, sourceAmount: 2, sourceCurrency: 'PKR' }),
    ], { session: { id: 'session-1' } });
    expect(request.settlement.sellerBalanceTransaction).toBe('source-only-debit');
    expect(request.status).toBe('returned');
    expect(creditWalletInSession).toHaveBeenCalledWith(expect.objectContaining({ amount: 2 }), {
      id: 'session-1',
    });
  });
});
