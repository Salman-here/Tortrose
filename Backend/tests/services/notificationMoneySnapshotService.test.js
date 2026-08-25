'use strict';

const mongoose = require('mongoose');
const {
  formatMoneySnapshot,
  orderSellerTotalSnapshot,
  orderStockRefundSnapshot,
  orderTotalSnapshot,
  returnRefundSnapshot,
  sellerSettlementUsdSnapshot,
  snapshotMajorMoney,
  subscriptionCapturedSnapshot,
  walletTransactionSnapshot,
  withdrawalPayoutSnapshot,
  withdrawalRequestedSnapshot,
} = require('../../services/notificationMoneySnapshotService');

const id = () => new mongoose.Types.ObjectId();

describe('notification immutable money snapshots', () => {
  test.each([
    ['USD', 12.34, '$12.34'],
    ['PKR', 1880, 'Rs1,880.00 PKR'],
    ['EUR', 9.01, '€9.01 EUR'],
    ['GBP', 0, '£0.00 GBP'],
  ])('formats exact persisted %s without invoking FX conversion', (currency, amount, expected) => {
    const snapshot = snapshotMajorMoney({
      key: 'total',
      amount,
      currency,
      sourceModel: 'Order',
      sourceDocumentId: id(),
      sourcePath: 'orderSummary.totalAmount',
    });
    expect(formatMoneySnapshot(snapshot)).toBe(expected);
  });

  test('formats the largest supported minor-unit integer without losing its final cent', () => {
    expect(formatMoneySnapshot({
      key: 'total',
      amountMinor: Number.MAX_SAFE_INTEGER,
      currency: 'USD',
      sourceModel: 'Order',
      sourceDocumentId: id().toString(),
      sourcePath: 'orderSummary.totalAmount',
    })).toBe('$90,071,992,547,409.91');
  });

  test.each([undefined, null, '', '12.34', true, false, Number.NaN, Infinity, -1, 1.005])(
    'rejects malformed or non-exact persisted major money %p',
    value => {
      expect(() => snapshotMajorMoney({
        key: 'total',
        amount: value,
        currency: 'USD',
        sourceModel: 'Order',
        sourceDocumentId: id(),
        sourcePath: 'orderSummary.totalAmount',
      })).toThrow(expect.objectContaining({ code: 'NOTIFICATION_MONEY_INVALID' }));
    }
  );

  test.each([undefined, null, '', 'usd', ' USD', 'CAD', true])(
    'rejects corrupt application currency %p rather than relabeling it',
    currency => {
      expect(() => snapshotMajorMoney({
        key: 'total',
        amount: 1,
        currency,
        sourceModel: 'Order',
        sourceDocumentId: id(),
        sourcePath: 'orderSummary.totalAmount',
      })).toThrow(expect.objectContaining({ code: 'NOTIFICATION_MONEY_INVALID' }));
    }
  );

  test('maps each financial domain to its persisted accounting field', () => {
    const seller = id();
    const order = {
      _id: id(),
      currency: 'PKR',
      orderSummary: { totalAmount: 1880 },
      exchangeRateSnapshot: {
        rates: { USD: 1, PKR: 280, EUR: 0.92, GBP: 0.79 },
        fallback: false,
      },
      sellerSettlementVersion: 1,
      sellerSettlement: [{
        seller,
        sourceCurrency: 'PKR',
        sourceAmountMinor: 188000,
        amountUSDMinor: 671,
      }],
      paymentResult: {
        stockRefundAmountMinor: 188000,
        stockRefundCurrency: 'PKR',
      },
    };
    const returnRequest = {
      _id: id(), currency: 'PKR', refund: { totalAmount: 200 },
    };
    const withdrawal = {
      _id: id(),
      requestedAmount: 27750,
      requestedCurrency: 'PKR',
      payoutAmount: 100,
      payoutCurrency: 'USD',
    };
    const payment = { _id: id(), currency: 'usd', capturedMinor: 1299 };
    const wallet = { _id: id(), currency: 'EUR', amount: 5.25 };

    expect(orderTotalSnapshot(order)).toEqual(expect.objectContaining({
      amountMinor: 188000,
      currency: 'PKR',
      sourcePath: 'orderSummary.totalAmount',
    }));
    expect(orderStockRefundSnapshot(order)).toEqual(expect.objectContaining({
      key: 'refund_total',
      amountMinor: 188000,
      currency: 'PKR',
      sourcePath: 'paymentResult.stockRefundAmountMinor',
    }));
    expect(orderSellerTotalSnapshot(order, seller)).toEqual(expect.objectContaining({
      amountMinor: 188000,
      currency: 'PKR',
    }));
    expect(sellerSettlementUsdSnapshot(order, seller)).toEqual(expect.objectContaining({
      amountMinor: 671,
      currency: 'USD',
    }));
    expect(returnRefundSnapshot(returnRequest)).toEqual(expect.objectContaining({
      amountMinor: 20000,
      currency: 'PKR',
    }));
    expect(withdrawalRequestedSnapshot(withdrawal)).toEqual(expect.objectContaining({
      amountMinor: 2775000,
      currency: 'PKR',
    }));
    expect(withdrawalPayoutSnapshot(withdrawal)).toEqual(expect.objectContaining({
      amountMinor: 10000,
      currency: 'USD',
    }));
    expect(subscriptionCapturedSnapshot(payment)).toEqual(expect.objectContaining({
      amountMinor: 1299,
      currency: 'USD',
    }));
    expect(walletTransactionSnapshot(wallet)).toEqual(expect.objectContaining({
      amountMinor: 525,
      currency: 'EUR',
    }));
  });

  test('fails closed when a seller notification lacks its frozen settlement ownership', () => {
    expect(() => orderSellerTotalSnapshot({
      _id: id(),
      currency: 'USD',
      orderSummary: { totalAmount: 0 },
      sellerSettlementVersion: 1,
      sellerSettlement: [],
    }, id())).toThrow(expect.objectContaining({
      code: 'NOTIFICATION_SELLER_SETTLEMENT_MISSING',
    }));
  });

  test.each([
    [true, 'PKR'],
    ['188000', 'PKR'],
    [188000.5, 'PKR'],
    [-1, 'PKR'],
    [188000, 'pkr'],
    [188000, 'CAD'],
  ])('stock-refund snapshot rejects corrupt persisted minor money %p %p', (amountMinor, currency) => {
    expect(() => orderStockRefundSnapshot({
      _id: id(),
      paymentResult: {
        stockRefundAmountMinor: amountMinor,
        stockRefundCurrency: currency,
      },
    })).toThrow(expect.objectContaining({ code: 'NOTIFICATION_MONEY_INVALID' }));
  });

  const validUsdOrder = seller => ({
    _id: id(),
    currency: 'USD',
    orderSummary: { totalAmount: 10 },
    sellerSettlementVersion: 1,
    sellerSettlement: [{
      seller,
      sourceCurrency: 'USD',
      sourceAmountMinor: 1000,
      amountUSDMinor: 1000,
    }],
  });

  test.each([
    ['missing version', order => { delete order.sellerSettlementVersion; }],
    ['malformed entry', order => { order.sellerSettlement[0].sourceAmountMinor = true; }],
    ['mismatched currency', order => { order.sellerSettlement[0].sourceCurrency = 'PKR'; }],
    ['duplicate seller', order => { order.sellerSettlement.push({ ...order.sellerSettlement[0] }); }],
    ['nonconserving source total', order => { order.sellerSettlement[0].sourceAmountMinor = 999; }],
    ['nonconserving USD allocation', order => { order.sellerSettlement[0].amountUSDMinor = 999; }],
  ])('seller snapshots reject a %s across the complete frozen allocation', (_label, corrupt) => {
    const seller = id();
    const order = validUsdOrder(seller);
    corrupt(order);

    expect(() => orderSellerTotalSnapshot(order, seller)).toThrow();
    expect(() => sellerSettlementUsdSnapshot(order, seller)).toThrow();
  });
});
