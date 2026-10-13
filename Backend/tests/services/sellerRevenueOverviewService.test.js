const { revenuePeriod, computeSellerPeriodRevenue } = require('../../services/sellerRevenueOverviewService');
const { computeNativeSellerAccounting } = require('../../services/sellerNativeAccountingService');
const { buildOrderSellerSettlement, buildOrderSellerCurrencyMoney } = require('../../services/orderMoneyService');
const { buildOnlineOrderFee } = require('../../services/onlineOrderFeeService');
const now = new Date('2026-10-13T12:00:00.000Z');
const rates = { USD: 1, PKR: 300, EUR: 0.9, GBP: 0.8 };
let seq = 0;

function sale(amount, createdAt, method = 'safepay', status = 'delivered', seller = 'seller-a', native = 'PKR', buyer = 'PKR') {
  const buyerAmount = Math.round(amount / rates[native] * rates[buyer] * 100) / 100;
  const item = { _id: 'line-' + seq, productId: 'product-' + seq, seller, name: 'Revenue test', quantity: 1,
    price: buyerAmount, lineSubtotal: buyerAmount, sourcePrice: amount, sourceLineSubtotal: amount, sourceCurrency: native,
    returnPolicySnapshotVersion: 1, returnPolicy: { returnsEnabled: false, returnDuration: 0, refundType: 'none' } };
  const order = { _id: 'order-' + seq++, orderId: 'ORD-' + seq, currency: buyer, orderItems: [item],
    orderSummary: { subtotal: buyerAmount, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: buyerAmount },
    sellerPolicies: [{ seller, productCurrency: native }],
    sellerShipping: [{ seller, shippingMethod: { name: 'Free', price: 0, sourceCost: 0, sourceCurrency: native } }],
    sellerFulfillment: [{ seller, status, deliveredAt: createdAt }],
    exchangeRateSnapshot: { base: 'USD', rates, capturedAt: new Date(createdAt), source: 'test', fallback: false },
    paymentMethod: method, isPaid: true, orderStatus: status, createdAt: new Date(createdAt) };
  order.sellerSettlementVersion = 1; order.sellerSettlement = buildOrderSellerSettlement(order, { requireOrderTotal: true });
  order.sellerCurrencyMoneyVersion = 1; order.sellerCurrencyMoney = buildOrderSellerCurrencyMoney(order);
  order.onlineFeeSnapshot = buildOnlineOrderFee(order);
  return order;
}
const report = (orders, days = '7', extra = {}) => computeSellerPeriodRevenue({ sellerId: 'seller-a', currency: 'PKR', days, at: now, orders, ...extra });
const refund = (order, amount) => ({ order: order._id, sourceAmount: amount, sourceCurrency: order.currency,
  amountUSD: Math.round(amount / rates[order.currency] * 100) / 100, referenceType: 'return_request', type: 'return_refund', direction: 'debit', status: 'completed' });

test('uses inclusive UTC placement dates and an exclusive next-day boundary', () => {
  expect(revenuePeriod('7', now)).toEqual({ days: 7, startDate: '2026-10-07T00:00:00.000Z', endDateExclusive: '2026-10-14T00:00:00.000Z', timezone: 'UTC', basis: 'order_created_at' });
  const orders = [sale(1000, '2026-10-06T23:59:59.999Z'), sale(2000, '2026-10-07T00:00:00.000Z'),
    sale(3000, '2026-10-13T23:59:59.999Z'), sale(4000, '2026-10-14T00:00:00.000Z')];
  expect(report(orders)).toMatchObject({ onlineGrossEarnings: 5000, totalDeliveredRevenue: 5000, estimatedRevenue: 5000 });
});

test('7, 30, 90 days and all-time totals differ correctly without mixing cohorts', () => {
  const orders = [sale(1000, '2026-10-12'), sale(2000, '2026-09-20', 'wallet'),
    sale(3000, '2026-08-01', 'cash_on_delivery'), sale(4000, '2026-01-01')];
  expect(report(orders, '7')).toMatchObject({ onlineGrossEarnings: 1000, totalDeliveredRevenue: 1000 });
  expect(report(orders, '30')).toMatchObject({ onlineGrossEarnings: 3000, totalDeliveredRevenue: 3000 });
  expect(report(orders, '90')).toMatchObject({ onlineGrossEarnings: 3000, codDeliveredRevenue: 3000, totalDeliveredRevenue: 6000 });
  expect(report(orders, 'all')).toMatchObject({ onlineGrossEarnings: 7000, totalDeliveredRevenue: 10000 });
});

test('distinguishes delivered and pending COD, paid online, unpaid and cancelled portions', () => {
  const online = sale(1000, '2026-10-12');
  const wallet = sale(2000, '2026-10-12', 'wallet', 'processing');
  const cod = sale(3000, '2026-10-12', 'cash_on_delivery');
  const codPending = sale(4000, '2026-10-12', 'cash_on_delivery', 'shipped');
  const unpaid = sale(5000, '2026-10-12'); unpaid.isPaid = false;
  const waiting = sale(6000, '2026-10-12'); waiting.awaitingPayment = true;
  const cancelled = sale(7000, '2026-10-12', 'wallet', 'cancelled');
  expect(report([online, wallet, cod, codPending, unpaid, waiting, cancelled])).toMatchObject({
    onlineGrossEarnings: 3000, codDeliveredRevenue: 3000, totalDeliveredRevenue: 4000, estimatedRevenue: 10000,
  });
});

test('applies only selected-order refund liabilities, including legacy return lineage', () => {
  const selected = sale(10000, '2026-10-12'), old = sale(20000, '2026-01-01');
  const tx = refund(selected, 2500); delete tx.order; tx.referenceId = 'return-a';
  const unrelated = refund(old, 10000);
  const input = { transactions: [tx, unrelated], returns: [{ _id: 'return-a', seller: 'seller-a', order: selected._id, status: 'returned' }] };
  const before = JSON.stringify(input);
  expect(report([selected, old], '7', input).onlineGrossEarnings).toBe(7500);
  expect(JSON.stringify(input)).toBe(before);
});

test('native-currency online earnings are not revalued from other balances', () => {
  const pkr = sale(3000, '2026-10-12'), usd = sale(10, '2026-10-12', 'wallet', 'delivered', 'seller-a', 'USD', 'USD');
  const result = report([pkr, usd]);
  expect(result.onlineGrossEarnings).toBe(3000);
  expect(result.totalDeliveredRevenue).toBe(6000);
});

test('unresolved legacy refund provenance fails closed; a known out-of-period refund is excluded', () => {
  const selected = sale(1000, '2026-10-12'), old = sale(2000, '2026-01-01');
  const tx = refund(old, 500); delete tx.order; tx.referenceId = 'old-return';
  expect(() => report([selected, old], '7', { transactions: [tx] })).toThrow(/original order/);
  expect(report([selected, old], '7', { transactions: [tx], returns: [{ _id: 'old-return', order: old._id }] }).onlineGrossEarnings).toBe(1000);
});

test.each(Object.keys(rates).flatMap(native => Object.keys(rates).map(buyer => [native, buyer])))('%s / %s matches original accounting exactly', (native, buyer) => {
  const order = sale(10 * rates[native], '2026-10-12', 'wallet', 'delivered', 'seller-a', native, buyer);
  const before = JSON.stringify(order);
  const expected = computeNativeSellerAccounting({ sellerId: 'seller-a', reportingCurrency: native, orders: [order], at: now });
  const actual = computeSellerPeriodRevenue({ sellerId: 'seller-a', currency: native, days: '7', at: now, orders: [order] });
  expect(actual.onlineGrossEarnings).toBe(expected.balanceByCurrency[native].onlineGrossEarnings);
  expect(actual.totalDeliveredRevenue).toBe(expected.displayRevenue.totalDeliveredRevenue);
  expect(JSON.stringify(order)).toBe(before);
});

test('never counts another seller and never exports spendable balance or bank data', () => {
  const actual = report([sale(1000, '2026-10-12'), sale(9000, '2026-10-12', 'wallet', 'delivered', 'seller-b')]);
  expect(actual.onlineGrossEarnings).toBe(1000);
  expect(actual.withdrawableBalance).toBeUndefined(); expect(actual.paymentAccount).toBeUndefined();
});

test.each(['0', '-1', '366', '7.5', '7oops', '', null, true])('rejects invalid period %s', days => {
  expect(() => revenuePeriod(days, now)).toThrow();
});
test('leap-day calendar windows remain exact', () => {
  expect(revenuePeriod('7', new Date('2028-03-01T12:00:00Z')).startDate).toBe('2028-02-24T00:00:00.000Z');
});
test('missing dates are never guessed as the Unix epoch for a period report', () => {
  const order = sale(1000, '2026-10-12'); order.createdAt = null;
  expect(() => report([order])).toThrow(/placement date/);
});
