'use strict';

jest.mock('../../services/currencyService', () => ({
  ...jest.requireActual('../../services/currencyService'),
  getExchangeRateSnapshot: jest.fn(() => { throw new Error('Live FX must not revalue saved checkout money'); }),
}));

const { getExchangeRateSnapshot } = require('../../services/currencyService');
const { buildOrderSellerSettlement, buildOrderSellerCurrencyMoney } = require('../../services/orderMoneyService');
const { buildOnlineOrderFee } = require('../../services/onlineOrderFeeService');
const { computeNativeSellerAccounting } = require('../../services/sellerNativeAccountingService');

const rates = { USD: 1, PKR: 277.86, EUR: 0.9173, GBP: 0.7882 };
const seller = 'fee-conservation-seller';
const deliveredAt = new Date('2026-10-01T00:00:00Z');
const duringWindow = new Date('2026-10-02T00:00:00Z');
const afterWindow = new Date('2026-10-09T00:00:00Z');
const cents = amount => Math.round(amount * 100);
const scales = [[10000, 3000], [0.1, 0.06], [7.7, 13.33], [1, 1], [999.9, 17.99]];
const cases = Object.keys(rates).flatMap(native => Object.keys(rates)
  .flatMap(buyer => scales.map(values => [native, buyer, ...values])));

function checkout(native, buyer, returnableValue, noReturnValue, paymentMethod = 'safepay') {
  const orderItems = [returnableValue, noReturnValue].map((value, index) => {
    const quantity = index === 0 ? 10 : 1;
    const lineSubtotal = Math.round(value / rates[native] * rates[buyer] * 100) / 100;
    return {
      _id: `line-${index}`, productId: `product-${index}`, seller, name: 'Fee conservation product',
      quantity, price: Math.round(lineSubtotal / quantity * 100) / 100, lineSubtotal,
      sourcePrice: value / quantity, sourceLineSubtotal: value, sourceCurrency: native,
      returnPolicySnapshotVersion: 1,
      returnPolicy: { returnsEnabled: index === 0, returnDuration: index === 0 ? 7 : 0,
        refundType: index === 0 ? 'full_refund' : 'none' },
    };
  });
  const total = orderItems.reduce((sum, item) => sum + cents(item.lineSubtotal), 0) / 100;
  const order = {
    _id: 'fee-conservation-order', orderId: 'ORD-FEE-CONSERVATION', currency: buyer, orderItems,
    orderSummary: { subtotal: total, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: total },
    sellerPolicies: [{ seller, productCurrency: native }],
    sellerShipping: [{ seller, shippingMethod: { name: 'free', price: 0, sourceCost: 0, sourceCurrency: native } }],
    sellerFulfillment: [{ seller, status: 'delivered', deliveredAt }],
    exchangeRateSnapshot: { base: 'USD', rates, capturedAt: deliveredAt, source: 'saved-checkout', fallback: false },
    paymentMethod, isPaid: true, orderStatus: 'delivered', createdAt: deliveredAt,
  };
  order.sellerSettlementVersion = 1;
  order.sellerSettlement = buildOrderSellerSettlement(order, { requireOrderTotal: true });
  order.sellerCurrencyMoneyVersion = 1;
  order.sellerCurrencyMoney = buildOrderSellerCurrencyMoney(order);
  order.onlineFeeSnapshot = buildOnlineOrderFee(order);
  return order;
}

function accounting(order, { returns = [], transactions = [], at = duringWindow } = {}) {
  return computeNativeSellerAccounting({ sellerId: seller, orders: [order], reportingCurrency: order.sellerCurrencyMoney[0].currency,
    returns, transactions, at }).revenue;
}

function refundTransaction(order, amount) {
  return { order: order._id, sourceAmount: amount, sourceCurrency: order.currency,
    amountUSD: Math.round(amount / rates[order.currency] * 100) / 100,
    type: 'return_refund', referenceType: 'return_request', direction: 'debit', status: 'completed' };
}

test.each(cases)('%s seller / %s buyer conserves mixed-policy earnings at %s + %s through cumulative partial returns',
  (native, buyer, returnableValue, noReturnValue) => {
    const order = checkout(native, buyer, returnableValue, noReturnValue);
    const saved = JSON.stringify(order);
    const fee = order.onlineFeeSnapshot.sellers[0];
    let previousRefundDebit = 0;
    let previousFee = fee.feeMinor;

    // Sixteen currency pairs, five scales and eleven cumulative quantities:
    // 880 scenarios, including tiny buyer allocations and capped deductions.
    for (let returnedQuantity = 0; returnedQuantity <= 10; returnedQuantity++) {
      const refund = Math.round(cents(order.orderItems[0].lineSubtotal) * returnedQuantity / 10) / 100;
      const returns = returnedQuantity ? [{ order: order._id, seller, status: 'returned',
        items: [{ orderItemId: order.orderItems[0]._id, quantity: returnedQuantity }], refund: { totalAmount: refund } }] : [];
      const result = accounting(order, { returns, transactions: returnedQuantity ? [refundTransaction(order, refund)] : [] });

      expect(cents(result.returnRefundDebits + result.processingFeeAndTax
        + result.withdrawableBalance + result.pendingOnlineNetBalance)).toBe(fee.grossMinor);
      expect(cents(result.onlineFeeDeductions + result.pendingOnlineFeeDeductions)).toBe(cents(result.processingFeeAndTax));
      expect(cents(result.pendingOnlineBalance - result.pendingOnlineFeeDeductions)).toBe(cents(result.pendingOnlineNetBalance));
      expect(result.withdrawableBalance).toBeGreaterThanOrEqual(0);
      expect(result.pendingOnlineNetBalance).toBeGreaterThanOrEqual(0);
      expect(result.deficit).toBe(0);
      expect(cents(result.returnRefundDebits)).toBeGreaterThanOrEqual(previousRefundDebit);
      expect(cents(result.processingFeeAndTax)).toBeLessThanOrEqual(previousFee);
      previousRefundDebit = cents(result.returnRefundDebits);
      previousFee = cents(result.processingFeeAndTax);

      if (returnedQuantity === 10) expect(result.returnWindowHeldAmount).toBe(0);
    }

    const released = accounting(order, { at: afterWindow });
    expect(cents(released.withdrawableBalance)).toBe(fee.grossMinor - fee.feeMinor);
    expect(released.pendingOnlineNetBalance).toBe(0);
    expect(JSON.stringify(order)).toBe(saved);
    expect(getExchangeRateSnapshot).not.toHaveBeenCalled();
  });

test.each(['wallet', 'safepay'])('%s releases only no-return net earnings while a timely return remains unresolved', paymentMethod => {
  const order = checkout('PKR', 'PKR', 6000, 4000, paymentMethod);
  const before = accounting(order);
  expect(before).toMatchObject({ processingFeeAndTax: 650, returnWindowHeldAmount: 6000,
    pendingOnlineNetBalance: 5610, withdrawableBalance: 3740 });
  const request = { order: order._id, seller, status: 'under_review', requestedAt: new Date('2026-10-07T23:59:59Z'),
    items: [{ orderItemId: order.orderItems[0]._id, quantity: 10 }], refund: { totalAmount: 6000 } };
  expect(accounting(order, { returns: [request], at: afterWindow })).toMatchObject({
    returnWindowHeldAmount: 6000, pendingOnlineNetBalance: 5610, withdrawableBalance: 3740 });
  expect(accounting(order, { returns: [{ ...request, status: 'returned' }],
    transactions: [refundTransaction(order, 6000)], at: afterWindow })).toMatchObject({
    returnRefundDebits: 6000, processingFeeAndTax: 260, returnWindowHeldAmount: 0,
    pendingOnlineNetBalance: 0, withdrawableBalance: 3740 });
});

test.each(Object.keys(rates).flatMap(native => Object.keys(rates).map(buyer => [native, buyer])))(
  '%s seller / %s buyer full refund reverses the original fee and legacy absence stays fee-free', (native, buyer) => {
    const order = checkout(native, buyer, 10000, 3000);
    expect(accounting(order, { transactions: [refundTransaction(order, order.orderSummary.totalAmount)] })).toMatchObject({
      processingFeeAndTax: 0, pendingOnlineNetBalance: 0, withdrawableBalance: 0, deficit: 0 });
    const originalGross = order.onlineFeeSnapshot.sellers[0].grossMinor;
    delete order.onlineFeeSnapshot;
    expect(accounting(order, { at: afterWindow })).toMatchObject({
      processingFeeAndTax: 0, withdrawableBalance: originalGross / 100 });
    expect(getExchangeRateSnapshot).not.toHaveBeenCalled();
  });
