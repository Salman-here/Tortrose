import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCheckoutQuoteInput, requireCheckoutQuote } from '../src/utils/checkoutQuote.js';
import { getSellerOnlineDeduction } from '../src/utils/orderItems.js';

const fixture = () => {
  const input = createCheckoutQuoteInput({ actor:'buyerA',currency:'USD',paymentMethod:'wallet',
    cart:[{ product:{ _id:'product',seller:'seller',price:301.2,priceCurrency:'PKR' },qty:1 }],
    selections:{ seller:{ type:'free' } },shippingMethods:{ seller:{ methods:[{ type:'free',cost:0,currency:'PKR' }] } },
    location:{ country:'Pakistan',countryCode:'PK',city:'Lahore',town:'Bahria' } });
  const quote = { success:true,pricingPolicyVersion:1,currency:'USD',
    orderSummary:{ subtotal:1.01,shippingCost:0,tax:0,couponDiscount:0,totalAmount:1.01 },
    orderItems:[{ productId:'product',quantity:1,lineSubtotal:1.01,discountAmount:0 }],
    sellerShipping:[{ seller:'seller',shippingMethod:{ name:'free',price:0 } }],appliedCoupons:[] };
  return { input,quote };
};

test('quote binds owner, currency, cart, delivery, coupons and method without sending contact/card details', () => {
  const { input,quote } = fixture();
  assert.equal(input.ready,true);
  assert.equal(requireCheckoutQuote(quote,input.request),quote);
  assert.equal(input.request.order.buyerLocation.town,'Bahria');
  assert.equal(input.request.order.shippingInfo.phone,undefined);
  assert.equal(input.request.order.savedCardId,undefined);
  const second = createCheckoutQuoteInput({ actor:'buyerB',currency:'USD',cart:[],location:{} });
  assert.notEqual(second.signature,input.signature);
});

test('missing delivery selections cannot produce a ready checkout quote', () => {
  const input = createCheckoutQuoteInput({ actor:'buyer',currency:'USD',cart:[{ product:{ _id:'p',seller:'s' },qty:1 }] });
  assert.equal(input.ready,false);
});

test('currency, ownership, quantities, totals and malformed money fail closed', () => {
  const { input,quote } = fixture();
  for (const mutate of [
    q => { q.currency = 'EUR'; }, q => { q.pricingPolicyVersion = 99; },
    q => { q.orderItems[0].productId = 'other'; }, q => { q.orderItems[0].quantity = 2; },
    q => { q.orderSummary.totalAmount = 1; }, q => { q.orderSummary.subtotal = '1.01'; },
    q => { q.orderSummary.subtotal = 1.005; }, q => { q.orderItems[0].discountAmount = 0.01; },
    q => { q.sellerShipping[0].seller = 'other'; }, q => { q.sellerShipping[0].shippingMethod.name = 'fast'; },
  ]) { const bad = structuredClone(quote); mutate(bad); assert.throws(() => requireCheckoutQuote(bad,input.request)); }
});

test('web and mobile use identical quote input/validation code', () => {
  const web = readFileSync(new URL('../src/utils/checkoutQuote.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
  const mobile = readFileSync(new URL('../../MobileApp/src/utils/checkoutQuote.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
  assert.equal(web,mobile);
});

test('seller order deduction is in original native currency, reconciles exactly and is not a withdrawable balance', () => {
  const native = { currency:'PKR',summary:{ totalAmount:1200 } };
  const order = { paymentMethod:'wallet',sellerOnlineDeduction:{ version:1,basis:'original_order',currency:'PKR',grossAmount:1200,processingFeeAndTax:105.43,netAmount:1094.57 } };
  assert.equal(getSellerOnlineDeduction(order,native).netAmount,1094.57);
  assert.equal(getSellerOnlineDeduction({ paymentMethod:'cash_on_delivery' },native),null);
  for (const bad of [ { ...order.sellerOnlineDeduction,currency:'USD' },{ ...order.sellerOnlineDeduction,netAmount:1094.56 },{ ...order.sellerOnlineDeduction,processingFeeAndTax:'105.43' } ]) {
    assert.throws(() => getSellerOnlineDeduction({ ...order,sellerOnlineDeduction:bad },native));
  }
});
