'use strict';
jest.mock('../../services/currencyService', () => ({ ...jest.requireActual('../../services/currencyService'), getExchangeRateSnapshot: jest.fn(() => { throw new Error('Live FX must not be consulted'); }) }));
const { computeNativeSellerAccounting, nativeLiabilityMinor, WITHDRAWAL_MINIMUMS } = require('../../services/sellerNativeAccountingService');
const { buildOrderSellerSettlement, buildOrderSellerCurrencyMoney, sumCurrencyAmountsInCurrency, sellerReportingItemAllocations } = require('../../services/orderMoneyService');
const { getExchangeRateSnapshot } = require('../../services/currencyService');

const rates = { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 };
const seller = 'seller-native';
let sequence = 0;
function order(native = 'PKR', buyer = native, valueUSD = 10, options = {}) {
  const price = valueUSD * rates[buyer], source = valueUSD * rates[native];
  const o = { _id: 'order-' + (++sequence), orderId: 'ORDER-' + sequence, currency: buyer,
    orderItems: [{ _id: 'line-' + sequence, productId: 'product-' + sequence, seller, name: 'Travel Cup', quantity: 1,
      price, lineSubtotal: price, sourcePrice: source, sourceLineSubtotal: source, sourceCurrency: native }],
    orderSummary: { subtotal: price, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: price },
    sellerPolicies: [{ seller, productCurrency: native }], sellerShipping: [{ seller, shippingMethod: { name: 'free', price: 0, sourceCost: 0, sourceCurrency: native } }],
    exchangeRateSnapshot: { base: 'USD', rates, capturedAt: new Date('2026-09-01T00:00:00Z'), source: 'test-historical', fallback: false },
    paymentMethod: 'stripe', isPaid: true, orderStatus: 'delivered', sellerFulfillment: [{ seller, status: 'delivered' }], createdAt: new Date(), ...options };
  o.sellerSettlementVersion = 1; o.sellerSettlement = buildOrderSellerSettlement(o, { requireOrderTotal: true });
  o.sellerCurrencyMoneyVersion = 1; o.sellerCurrencyMoney = buildOrderSellerCurrencyMoney(o);
  return o;
}
const summary = (orders, rest = {}) => computeNativeSellerAccounting({ sellerId: seller, orders, reportingCurrency: 'PKR', ...rest });

test.each(Object.keys(rates).flatMap(native => Object.keys(rates).map(buyer => [native, buyer])))('%s seller / %s buyer credits only the frozen seller currency', (native, buyer) => {
  const o = order(native, buyer), before = JSON.stringify(o), s = summary([o], { reportingCurrency: native });
  expect(s.balanceByCurrency[native].withdrawableBalance).toBe(10 * rates[native]);
  for (const currency of Object.keys(rates).filter(code => code !== native)) expect(s.balanceByCurrency[currency].withdrawableBalance).toBe(0);
  expect(JSON.stringify(o)).toBe(before);
  expect(getExchangeRateSnapshot).not.toHaveBeenCalled();
});
test('store change keeps old PKR and new USD earnings separately withdrawable', () => {
  const s = summary([order('PKR'), order('USD')], { reportingCurrency: 'USD' });
  expect(s.balanceByCurrency.PKR.withdrawableBalance).toBe(2800);
  expect(s.balanceByCurrency.USD.withdrawableBalance).toBe(10);
  expect(s.displayRevenue.totalDeliveredRevenue).toBe(20);
  expect(s.displayRevenue.withdrawableBalance).toBe(10);
  expect(s.withdrawalLimits.availableDisplayAmount).toBe(10);
});
test('pending and delivered eligibility, unpaid online and COD separation', () => {
  const pending = order('PKR', 'PKR', 10, { sellerFulfillment: [{ seller, status: 'processing' }] });
  const cod = order('USD', 'PKR', 10, { paymentMethod: 'cash_on_delivery', isPaid: false });
  const unpaid = order('PKR', 'PKR', 10, { isPaid: false });
  const s = summary([pending, cod, unpaid]);
  expect(s.balanceByCurrency.PKR.onlinePendingRevenue).toBe(2800);
  expect(s.balanceByCurrency.PKR.withdrawableBalance).toBe(0);
  expect(s.balanceByCurrency.USD.codDeliveredRevenue).toBe(10);
  expect(s.balanceByCurrency.USD.withdrawableBalance).toBe(0);
});
test.each(['pending','approved','processing','manual_review','paid','failed','rejected','cancelled'])('native withdrawal %s reserves exactly one currency', status => {
  const s = summary([order('PKR'), order('USD')], { withdrawals: [{ balanceVersion: 2, currency: 'PKR', amount: 2000,
    requestedCurrency: 'PKR', requestedAmount: 2000, payoutCurrency: 'PKR', payoutAmount: 2000, status }] });
  expect(s.balanceByCurrency.PKR.withdrawableBalance).toBe(['failed','rejected','cancelled'].includes(status) ? 2800 : 800);
  expect(s.balanceByCurrency.USD.withdrawableBalance).toBe(10);
});
test('cumulative refund and reversal debits cancel the exact original seller credit', () => {
  const o = order('PKR', 'USD');
  const transaction = (sourceAmount, type) => ({ order: o._id, sourceAmount, sourceCurrency: 'USD', amountUSD: sourceAmount,
    type, direction: 'debit', status: 'completed', referenceType: type === 'return_refund' ? 'return_request' : 'stripe_payment' });
  const s = summary([o, order('USD')], { transactions: [transaction(3.33,'return_refund'),transaction(6.67,'reversal')] });
  expect(s.balanceByCurrency.PKR.withdrawableBalance).toBe(0);
  expect(s.balanceByCurrency.PKR.returnRefundDebits + s.balanceByCurrency.PKR.paymentReversalDebits).toBe(2800);
  expect(s.balanceByCurrency.USD.withdrawableBalance).toBe(10);
});
test('a post-payout refund creates a same-currency deficit, not a debit from another balance', () => {
  const o = order('PKR');
  const s = summary([o, order('USD')], { transactions: [{ order:o._id, sourceAmount:2800, sourceCurrency:'PKR', amountUSD:10,
    type:'reversal', direction:'debit', status:'completed', referenceType:'stripe_payment' }], withdrawals:[{
    balanceVersion:2, amount:2800, currency:'PKR', requestedAmount:2800, requestedCurrency:'PKR', payoutAmount:2800, payoutCurrency:'PKR', status:'paid' }] });
  expect(s.balanceByCurrency.PKR.deficit).toBe(2800);
  expect(s.balanceByCurrency.USD.withdrawableBalance).toBe(10);
});
test('native partial refund allocation is monotonic and conserves full entitlement', () => {
  let previous=0;
  for(let i=0;i<=1000;i++){ const current=nativeLiabilityMinor(i,1000,280001);expect(current).toBeGreaterThanOrEqual(previous);previous=current; }
  expect(previous).toBe(280001);
  expect(() => nativeLiabilityMinor(1001,1000,280001)).toThrow();
});
test('historical reporting uses each order snapshot, never current rates', async () => {
  const first=order('PKR'); const second=order('PKR');
  second.exchangeRateSnapshot={...second.exchangeRateSnapshot,rates:{...rates,PKR:350}};
  const total=await sumCurrencyAmountsInCurrency([{order:first,amount:2800,currency:'PKR'},{order:second,amount:2800,currency:'PKR'}],'USD');
  expect(total).toBe(18);
  expect(getExchangeRateSnapshot).not.toHaveBeenCalled();
});
test('fixed withdrawal minimums have no FX dependency',()=>expect(WITHDRAWAL_MINIMUMS).toEqual({USD:5,PKR:2000,EUR:5,GBP:5}));
test('a reporting currency change never mutates frozen order or balance records',()=>{
  const o=order('EUR','USD'), saved=JSON.stringify(o);
  expect(summary([o],{reportingCurrency:'GBP'}).balanceByCurrency.EUR.withdrawableBalance).toBe(9);
  expect(JSON.stringify(o)).toBe(saved);
});

test('administrative credits stay in their source currency without inflating sales revenue', () => {
  const s=summary([order('PKR'),order('USD')],{transactions:[{referenceType:'admin',sourceAmount:100,sourceCurrency:'PKR',amountUSD:0.36,type:'admin_adjustment',direction:'credit',status:'completed'}]});
  expect(s.balanceByCurrency.PKR.withdrawableBalance).toBe(2900);
  expect(s.balanceByCurrency.PKR.onlineDeliveredRevenue).toBe(2800);
  expect(s.balanceByCurrency.PKR.balanceAdjustmentCredits).toBe(100);
  expect(s.balanceByCurrency.USD.withdrawableBalance).toBe(10);
});
