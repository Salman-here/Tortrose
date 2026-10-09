'use strict';

const { priceOrderItemLines } = require('../../services/orderLinePricingService');
const { priceSellerNativeCheckout } = require('../../services/sellerCheckoutRoundingService');
const { buildOrderSellerSettlement, getFrozenSellerCurrencyMoney, buildOrderSellerCurrencyMoney, sellerCurrencyMoneyPresentation } = require('../../services/orderMoneyService');
const { buildOnlineOrderFee } = require('../../services/onlineOrderFeeService');
const { sumMoney, fromMinorUnits, allocateConvertedMinorUnitsByRates } = require('../../services/moneyMath');
const { nativeReturnFundingMinor, nativeLiabilityMinor } = require('../../services/sellerNativeAccountingService');
const { selectedReturnMoney } = require('../../services/returnService');
const rates = { USD: 1, PKR: 300, EUR: 0.9, GBP: 0.8 };
const seller = index => `00000000000000000000000${index}`;

function fixture({ prices = [301.2, 301.2], currencies = ['PKR', 'PKR'], buyerCurrency = 'USD', shipping = [0, 0], method = 'cash_on_delivery', fx = rates } = {}) {
  const orderItems = priceOrderItemLines({ items: prices.map((price, index) => ({ productId: `10000000000000000000000${index + 1}`,
    _id: `20000000000000000000000${index + 1}`, seller: seller(index + 1), sourcePrice: price, sourceCurrency: currencies[index], quantity: 1 })),
    targetCurrency: buyerCurrency, exchangeRates: fx });
  const allocatedShipping = allocateConvertedMinorUnitsByRates(shipping.map((amount, index) => ({ key: seller(index + 1), amount, sourceRate: fx[currencies[index]] })), fx[buyerCurrency]);
  const sellerShipping = shipping.map((amount, index) => ({ seller: seller(index + 1), shippingMethod: { name: amount ? 'standard' : 'free',
    sourceCost: amount, sourceCurrency: currencies[index], price: fromMinorUnits(allocatedShipping.allocations.get(seller(index + 1))), estimatedDays: 5 } }));
  const subtotal = sumMoney(orderItems.map(row => row.lineSubtotal)), shippingCost = sumMoney(sellerShipping.map(row => row.shippingMethod.price));
  return { currency: buyerCurrency, paymentMethod: method, orderItems, sellerShipping,
    sellerPolicies: currencies.map((currency, index) => ({ seller: seller(index + 1), productCurrency: currency })),
    exchangeRateSnapshot: { base: 'USD', rates: fx, fallback: false, capturedAt: new Date(), source: 'test' },
    orderSummary: { subtotal, shippingCost, tax: 0, couponDiscount: 0, totalAmount: sumMoney([subtotal, shippingCost]) }, appliedCoupons: [] };
}

function freeze(order) {
  const quoted = priceSellerNativeCheckout(order);
  const frozen = { ...order, ...quoted, sellerCurrencyMoneyVersion: 2, sellerSettlementVersion: 1 };
  frozen.sellerSettlement = buildOrderSellerSettlement(frozen, { requireOrderTotal: true });
  frozen.onlineFeeSnapshot = buildOnlineOrderFee(frozen);
  return frozen;
}

test('each complete seller portion is rounded up, while both native prices stay exact', () => {
  const order = freeze(fixture());
  expect(order.orderSummary.totalAmount).toBe(2.02);
  expect(getFrozenSellerCurrencyMoney(order).map(row => [row.totalMinor, row.buyerTotalMinor, row.adjustmentMinor])).toEqual([[30120,101,0],[30120,101,0]]);
  expect(order.checkoutRoundingSnapshot.collector).toBe('seller');
  expect(order.checkoutRoundingSnapshot.sellers.every(row => BigInt(row.remainderMinor.numerator) > 0n)).toBe(true);
});

test.each(['wallet', 'safepay', 'cash_on_delivery'])('PKR seller -> EUR buyer %s keeps Rs1200 without USD or seller FX adjustment', method => {
  const fx = { USD:1, PKR:277.08, EUR:0.893, GBP:0.757 };
  const order = freeze(fixture({ prices:[1000], currencies:['PKR'], shipping:[200], buyerCurrency:'EUR', fx, method }));
  expect(order.orderSummary).toEqual({ subtotal:3.22, shippingCost:0.65, tax:0, couponDiscount:0, totalAmount:3.87 });
  const native = sellerCurrencyMoneyPresentation(order, seller(1), order.orderItems);
  expect(native.summary).toEqual({ subtotal:1000, shippingCost:200, tax:0, couponDiscount:0, reconciliationAdjustment:0, totalAmount:1200 });
  expect(native.buyerSummary.totalAmount).toBe(3.87);
  expect(order.checkoutRoundingSnapshot.collector).toBe(method === 'cash_on_delivery' ? 'seller' : 'platform');
  if (method !== 'cash_on_delivery') expect(order.onlineFeeSnapshot.sellers[0].grossMinor).toBe(120000);
});

test('PKR/USD/EUR mixed sellers stay in their frozen currencies and native buyer prices remain exact', () => {
  const order = freeze(fixture({ prices:[301.2,29.5,5], currencies:['PKR','USD','EUR'], shipping:[0,5,0], buyerCurrency:'PKR', method:'wallet' }));
  const rows = getFrozenSellerCurrencyMoney(order);
  expect(rows.map(row => row.currency)).toEqual(['PKR','USD','EUR']);
  expect(rows.map(row => row.totalMinor)).toEqual([30120,3450,500]);
  expect(rows[0].buyerTotalMinor).toBe(30120);
  expect(rows.every(row => row.adjustmentMinor === 0)).toBe(true);
  expect(order.orderSummary.totalAmount).toBe(sumMoney(rows.map(row => fromMinorUnits(row.buyerTotalMinor))));
  expect(order.orderItems[0].lineSubtotal).toBe(301.2);
});

test.each(['USD','PKR','EUR','GBP'].flatMap(currency => ['wallet','safepay','cash_on_delivery'].map(method => [currency,method])))(
  'four mixed native sellers reconcile in %s for %s, without converting the matching-currency item', (buyerCurrency,method) => {
    const currencies = ['USD','PKR','EUR','GBP'], prices = [4.31,301.2,2.59,1.77], shipping = [0.21,12.37,0.12,0.18];
    const order = freeze(fixture({ prices,currencies,shipping,buyerCurrency,method }));
    const native = getFrozenSellerCurrencyMoney(order);
    expect(native.map(row => fromMinorUnits(row.totalMinor))).toEqual(prices.map((price,index) => sumMoney([price,shipping[index]])));
    const index = currencies.indexOf(buyerCurrency);
    expect(order.orderItems[index].lineSubtotal).toBe(prices[index]);
    expect(native.every(row => row.adjustmentMinor === 0)).toBe(true);
    for (const row of order.checkoutRoundingSnapshot.sellers) {
      const over = BigInt(row.buyerTotalMinor) * BigInt(row.exactBuyerMinor.denominator) - BigInt(row.exactBuyerMinor.numerator);
      expect(over >= 0n && over < BigInt(row.exactBuyerMinor.denominator)).toBe(true);
    }
    expect(sumMoney(native.map(row => fromMinorUnits(row.buyerTotalMinor)))).toBe(order.orderSummary.totalAmount);
  });

test('same-currency orders keep every amount unchanged and record zero remainder', () => {
  const input = fixture({ prices:[29.5], currencies:['USD'], shipping:[5], buyerCurrency:'USD' });
  const order = freeze(input);
  expect(order.orderSummary).toEqual(input.orderSummary);
  expect(order.checkoutRoundingSnapshot.sellers[0].remainderMinor).toEqual({ numerator:'0', denominator:'1' });
});

test.each(['wallet','safepay','cash_on_delivery'])('%s partial returns refund the full frozen item cents, even when the remaining native item is slightly short', method => {
  const input = fixture({ method });
  input.orderItems[1].seller = seller(1);
  input.sellerShipping = input.sellerShipping.slice(0,1);
  input.sellerPolicies = input.sellerPolicies.slice(0,1);
  const order = freeze(input);
  expect(order.orderSummary.totalAmount).toBe(2.01);
  expect(order.orderItems.map(item => item.lineSubtotal)).toEqual([1.01,1]);
  const sellerItems = order.orderItems.map(item => ({ orderItemId:item._id, purchasedQuantity:1, unitPrice:item.price }));
  const first = selectedReturnMoney({ order,sellerId:seller(1),sellerItems,
    selected:[{ ...sellerItems[0],quantity:1 }],consumed:new Map(),shippingAlreadyRefunded:false,sellerRefundedAmount:0 });
  expect(first.totalAmount).toBe(1.01);
  const final = selectedReturnMoney({ order,sellerId:seller(1),sellerItems,
    selected:[{ ...sellerItems[1],quantity:1 }],consumed:new Map([[sellerItems[0].orderItemId,1]]),
    shippingAlreadyRefunded:false,sellerRefundedAmount:first.totalAmount });
  expect(final.totalAmount).toBe(1);
  expect(sumMoney([first.totalAmount,final.totalAmount])).toBe(order.orderSummary.totalAmount);
  expect(order.sellerCurrencyMoney[0].totalMinor).toBe(60240);
  // This accepted partial-return FX effect must NOT be passed back to the buyer
  // as a lower refund. Full online refunds reverse the exact original credit.
  expect(nativeReturnFundingMinor(order,101,201,60240,'PKR')).toBe(method === 'cash_on_delivery' ? 30300 : 30270);
  expect(nativeReturnFundingMinor(order,201,201,60240,'PKR')).toBe(method === 'cash_on_delivery' ? 60300 : 60240);
});

test('seller view includes only its original fee/net calculation, never private rounding or another seller fee', () => {
  const order = freeze(fixture({ method:'wallet' }));
  const view = require('../../controllers/orderController')._buildSellerOrderView(order,new Set(),seller(1));
  expect(view.checkoutRoundingSnapshot).toBeUndefined();
  expect(view.onlineFeeSnapshot).toBeUndefined();
  expect(view.sellerShipping).toHaveLength(1);
  expect(view.sellerSettlement).toHaveLength(1);
  expect(view.sellerOnlineDeduction).toMatchObject({ version:1,basis:'original_order',currency:'PKR',grossAmount:301.2 });
  expect(sumMoney([view.sellerOnlineDeduction.netAmount,view.sellerOnlineDeduction.processingFeeAndTax])).toBe(301.2);
  expect(view.sellerCurrencyMoney.summary.reconciliationAdjustment).toBe(0);
});

test('buyer view exposes actual paid seller portions, without native reconciliation, rounding or seller deduction fields', () => {
  const order = freeze({ ...fixture({ method:'safepay' }),orderStatus:'confirmed' });
  const buyer = require('../../services/buyerOrderPresentationService').buildBuyerOrderView(order);
  expect(buyer.checkoutRoundingSnapshot).toBeUndefined();
  expect(buyer.onlineFeeSnapshot).toBeUndefined();
  expect(buyer.sellerCurrencyMoney).toBeUndefined();
  expect(buyer.sellerOnlineDeduction).toBeUndefined();
  expect(buyer.orderSummary.totalAmount).toBe(2.02);
  expect(buyer.sellerGroups.map(group => group.summary.totalAmount)).toEqual([1.01,1.01]);
});

test('admin tax cents are preserved instead of being converted out and back through the native seller currency', () => {
  const input = fixture({ prices:[0],currencies:['PKR'],shipping:[0],buyerCurrency:'USD',fx:{ USD:1,PKR:277.08,EUR:0.893,GBP:0.757 } });
  input.orderSummary.tax = 0.11; input.orderSummary.totalAmount = 0.11;
  const order = freeze(input);
  expect(order.orderSummary).toEqual({ subtotal:0,shippingCost:0,tax:0.11,couponDiscount:0,totalAmount:0.11 });
  expect(order.sellerCurrencyMoney[0]).toMatchObject({ taxMinor:3048,totalMinor:3048,adjustmentMinor:0 });
});

test('COD return funding includes the actual collected buyer amount; held online refunds reverse only native earnings', () => {
  const cod = freeze(fixture({ prices:[301.2],currencies:['PKR'],shipping:[0],method:'cash_on_delivery' }));
  const online = freeze(fixture({ prices:[301.2],currencies:['PKR'],shipping:[0],method:'wallet' }));
  expect(nativeReturnFundingMinor(cod,101,101,30120,'PKR')).toBe(30300);
  expect(nativeReturnFundingMinor(online,101,101,30120,'PKR')).toBe(30120);
  expect(nativeLiabilityMinor(101,101,30120)).toBe(30120);
  expect(() => nativeReturnFundingMinor(cod,102,101,30120,'PKR')).toThrow();
});

test('full native coupon discounts remain zero-earning sellers and preserve shipping ownership', () => {
  const input = fixture({ prices:[1000], currencies:['PKR'], shipping:[200], buyerCurrency:'USD' });
  input.appliedCoupons = [{ couponId:'300000000000000000000001', seller:seller(1), code:'FREEPRODUCT', discountType:'fixed', discountValue:3.33,
    appliedDiscountAmount:3.33, sourceDiscountValue:1000, sourceAppliedDiscountAmount:1000, sourceCurrency:'PKR', currency:'USD', applicableProductIds:[input.orderItems[0].productId] }];
  input.orderSummary.couponDiscount = 3.33; input.orderSummary.totalAmount = sumMoney([input.orderSummary.subtotal, input.orderSummary.shippingCost, -3.33]);
  const order = freeze(input);
  expect(order.sellerCurrencyMoney[0]).toMatchObject({ subtotalMinor:100000, shippingMinor:20000, discountMinor:100000, totalMinor:20000, adjustmentMinor:0, buyerTotalMinor:67 });
  expect(order.orderSummary.totalAmount).toBe(0.67);
  expect(sumMoney([order.orderSummary.subtotal,order.orderSummary.shippingCost,-order.orderSummary.couponDiscount])).toBe(0.67);
});

test('a free seller stays represented without inventing a payment or processing deduction', () => {
  const order = freeze(fixture({ prices:[0], currencies:['PKR'], shipping:[0], method:'wallet' }));
  expect(order.orderSummary.totalAmount).toBe(0);
  expect(order.onlineFeeSnapshot.feeMinor).toBe(0);
  expect(order.sellerCurrencyMoney[0].totalMinor).toBe(0);
});

test('legacy native snapshots retain the old signed FX reconciliation instead of being rewritten', () => {
  const order = fixture({ prices:[1000], currencies:['PKR'], shipping:[200], buyerCurrency:'EUR', fx:{ USD:1,PKR:277.08,EUR:0.893,GBP:0.757 } });
  order.sellerSettlementVersion = 1; order.sellerSettlement = buildOrderSellerSettlement(order, { requireOrderTotal:true });
  order.sellerCurrencyMoneyVersion = 1; order.sellerCurrencyMoney = buildOrderSellerCurrencyMoney(order);
  expect(getFrozenSellerCurrencyMoney(order)[0]).toMatchObject({ totalMinor:119699, adjustmentMinor:-301 });
  expect(order.checkoutRoundingSnapshot).toBeUndefined();
});

test('tampered collector, remainder, native totals, buyer totals and unexpected seller adjustments fail closed', () => {
  const frozen = freeze(fixture());
  for (const mutate of [
    order => { order.checkoutRoundingSnapshot.collector = 'platform'; },
    order => { order.checkoutRoundingSnapshot.sellers[0].remainderMinor.numerator = '0'; },
    order => { order.sellerCurrencyMoney[0].totalMinor--; },
    order => { order.sellerCurrencyMoney[0].buyerTotalMinor--; },
    order => { order.sellerCurrencyMoney[0].adjustmentMinor = -1; order.sellerCurrencyMoney[0].totalMinor--; },
  ]) { const order = structuredClone(frozen); mutate(order); expect(() => getFrozenSellerCurrencyMoney(order)).toThrow(); }
});
