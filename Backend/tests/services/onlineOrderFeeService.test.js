'use strict';
const { buildOrderSellerSettlement, buildOrderSellerCurrencyMoney } = require('../../services/orderMoneyService');
const { buildOnlineOrderFee, getOnlineOrderFee, proportionalMinor } = require('../../services/onlineOrderFeeService');
const { computeNativeSellerAccounting } = require('../../services/sellerNativeAccountingService');
const rates = { USD: 1, PKR: 300, EUR: 0.9, GBP: 0.8 };
let seq = 0;
function sale(values = [10000], currencies = values.map(() => 'PKR'), buyer = 'PKR', method = 'safepay') {
  const items = values.map((value, i) => ({ _id: 'line-' + i, productId: 'product-' + i, seller: 'seller-' + i, name: 'QA product', quantity: 1,
    price: Math.round(value / rates[currencies[i]] * rates[buyer] * 100) / 100,
    lineSubtotal: Math.round(value / rates[currencies[i]] * rates[buyer] * 100) / 100,
    sourcePrice: value, sourceLineSubtotal: value, sourceCurrency: currencies[i], returnPolicySnapshotVersion: 1,
    returnPolicy: { returnsEnabled: false, returnDuration: 0, refundType: 'none' } }));
  const total = items.reduce((n, row) => n + Math.round(row.lineSubtotal * 100), 0) / 100;
  const order = { _id: 'order-' + (++seq), orderId: 'ORD-' + seq, currency: buyer, orderItems: items,
    orderSummary: { subtotal: total, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: total },
    sellerPolicies: items.map((row, i) => ({ seller: row.seller, productCurrency: currencies[i] })),
    sellerShipping: items.map((row, i) => ({ seller: row.seller, shippingMethod: { name: 'free', price: 0, sourceCost: 0, sourceCurrency: currencies[i] } })),
    sellerFulfillment: items.map(row => ({ seller: row.seller, status: 'delivered', deliveredAt: new Date('2026-10-01T00:00:00Z') })),
    exchangeRateSnapshot: { base: 'USD', rates, capturedAt: new Date(), source: 'test', fallback: false },
    paymentMethod: method, isPaid: true, orderStatus: 'delivered', createdAt: new Date() };
  order.sellerSettlementVersion = 1; order.sellerSettlement = buildOrderSellerSettlement(order, { requireOrderTotal: true });
  order.sellerCurrencyMoneyVersion = 1; order.sellerCurrencyMoney = buildOrderSellerCurrencyMoney(order);
  order.onlineFeeSnapshot = buildOnlineOrderFee(order);
  return order;
}
const account = (orders, options = {}) => computeNativeSellerAccounting({ sellerId: 'seller-0', reportingCurrency: 'PKR', orders, ...options });
test.each([[1000, 92, 908], [5000, 340, 4660], [10000, 650, 9350], [100000, 6230, 93770]])('fixed policy %s -> fee %s -> net %s', (gross, fee, net) => {
  const order = sale([gross]); expect(getOnlineOrderFee(order).feeMinor).toBe(fee * 100);
  expect(account([order]).revenue.withdrawableBalance).toBe(net);
});
test.each(['safepay', 'wallet'])('five separate %s checkouts match the explained Rs9,230 example', method => {
  const summary = account([1200,1800,2500,3500,1000].map(value => sale([value], ['PKR'], 'PKR', method)));
  expect(summary.revenue).toMatchObject({ onlineGrossEarnings: 10000, processingFeeAndTax: 770, onlineFeeDeductions: 770, withdrawableBalance: 9230 });
});
test('multiple sellers share ONE fixed fee and reconcile exact buyer cents', () => {
  const order = sale([6000,4000]);
  expect(order.onlineFeeSnapshot.sellers.map(row => row.buyerFeeMinor)).toEqual([39000,26000]);
  expect(order.onlineFeeSnapshot.feeMinor).toBe(65000);
});
test.each(Object.keys(rates).flatMap(native => Object.keys(rates).map(buyer => [native,buyer])))('%s seller fees for %s buyer use only original FX', (native,buyer) => {
  const order = sale([10 * rates[native]], [native], buyer);
  const before = JSON.stringify(order), fee = order.onlineFeeSnapshot.sellers[0];
  const summary = account([order], { reportingCurrency: native });
  expect(Math.round(summary.revenue.withdrawableBalance * 100)).toBe(fee.grossMinor - fee.feeMinor);
  expect(summary.balanceByCurrency[native].processingFeeAndTax).toBe(fee.feeMinor / 100);
  expect(JSON.stringify(order)).toBe(before);
});
test('pending return window exposes NET pending funds and zero withdrawable funds', () => {
  const order = sale(); order.orderItems[0].returnPolicy = { returnsEnabled: true, returnDuration: 7, refundType: 'full_refund' };
  const summary = account([order], { at: new Date('2026-10-02T00:00:00Z') });
  expect(summary.revenue).toMatchObject({ pendingOnlineBalance: 10000, pendingOnlineNetBalance: 9350,
    pendingOnlineFeeDeductions: 650, onlineFeeDeductions: 0, processingFeeAndTax: 650, withdrawableBalance: 0 });
  expect(account([order], { at: new Date('2026-10-09T00:00:00Z') }).revenue.withdrawableBalance).toBe(9350);
});
test('withdrawals reserve NET money without charging the fee again', () => {
  const order = sale();
  const request = { balanceVersion: 2, currency: 'PKR', requestedCurrency: 'PKR', payoutCurrency: 'PKR', amount: 9350, requestedAmount: 9350, payoutAmount: 9350, status: 'paid' };
  expect(account([order], { withdrawals: [request] }).revenue).toMatchObject({ onlineGrossEarnings:10000, processingFeeAndTax:650, withdrawableBalance:0, totalWithdrawn:9350, deficit:0 });
});
test.each([5000,10000])('a %s return reverses its proportional revenue and original fee', amount => {
  const order = sale();
  const tx = { order:order._id, sourceAmount:amount, sourceCurrency:'PKR', amountUSD:Math.round(amount / 3) / 100,
    referenceType:'return_request', type:'return_refund', direction:'debit', status:'completed' };
  const result = account([order], { transactions: [tx] });
  expect(result.revenue.processingFeeAndTax).toBe(amount === 5000 ? 325 : 0);
  expect(result.revenue.withdrawableBalance).toBe(amount === 5000 ? 4675 : 0);
});
test('cancelled portions have neither revenue nor a second seller expense', () => {
  const order = sale(); order.sellerFulfillment[0].status = 'cancelled';
  expect(account([order]).revenue).toMatchObject({ onlineGrossEarnings:0, processingFeeAndTax:0, withdrawableBalance:0 });
});
test('old terms and COD stay unchanged; zero-price orders incur zero expense', () => {
  const old = sale(); delete old.onlineFeeSnapshot;
  expect(account([old]).revenue.withdrawableBalance).toBe(10000);
  expect(sale([10000], ['PKR'], 'PKR', 'cash_on_delivery').onlineFeeSnapshot).toBeNull();
  expect(sale([0]).onlineFeeSnapshot.feeMinor).toBe(0);
});
test('tiny order deductions cap at the gross and never create negative money', () => {
  const order = sale([1]); expect(order.onlineFeeSnapshot.feeMinor).toBe(100);
  expect(account([order]).revenue.withdrawableBalance).toBe(0);
});
test('malformed, changed or unsupported snapshots fail closed', () => {
  const order = sale(); order.onlineFeeSnapshot.sellers[0].feeMinor--;
  expect(() => getOnlineOrderFee(order)).toThrow();
  expect(() => proportionalMinor(100, 101, 100)).toThrow();
  expect(() => proportionalMinor('100', 1, 100)).toThrow();
});
test('cross-currency percentage and PKR fixed fee round ONCE after summing exact values',()=>{
  const math=require('../../services/moneyMath');
  // 38.80 * 6.2% + 30 / 277.86 = 2.513569... -> 2.51, not 2.52.
  expect(math.percentagePlusConvertedMoney(38.8,6.2,30,277.86,1)).toBe(2.51);
  expect(()=>math.percentagePlusConvertedMoney(10,6.2,30,0,1)).toThrow();
});
