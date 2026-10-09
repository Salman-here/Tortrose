import { createCheckoutQuoteInput, requireCheckoutQuote } from '../../src/utils/checkoutQuote';
import { getSellerOnlineDeduction } from '../../src/utils/orderPresentation';

const fixture = actor => {
  const input = createCheckoutQuoteInput({ actor,currency:'USD',paymentMethod:'wallet',
    cart:[{ product:{ _id:'product',seller:'seller',price:301.2,priceCurrency:'PKR' },qty:1 }],
    selections:{ seller:{ type:'free' } },shippingMethods:{ seller:{ methods:[{ type:'free',cost:0,currency:'PKR' }] } } });
  const quote = { success:true,pricingPolicyVersion:1,currency:'USD',
    orderSummary:{ subtotal:1.01,shippingCost:0,tax:0,couponDiscount:0,totalAmount:1.01 },
    orderItems:[{ productId:'product',quantity:1,lineSubtotal:1.01,discountAmount:0 }],
    sellerShipping:[{ seller:'seller',shippingMethod:{ name:'free',price:0 } }],appliedCoupons:[] };
  return { input,quote };
};

test('native checkout validates the actual rounded quote and binds actor identity', () => {
  const { input,quote } = fixture('a');
  expect(requireCheckoutQuote(quote,input.request)).toBe(quote);
  expect(input.signature).not.toBe(fixture('b').input.signature);
  expect(input.ready).toBe(true);
});

test.each(['EUR','CAD'])('wrong/unsupported %s response cannot fund a native checkout', currency => {
  const { input,quote } = fixture('a'); quote.currency = currency;
  expect(() => requireCheckoutQuote(quote,input.request)).toThrow();
});

test.each(['money','quantity','seller','discount'])('invalid %s quote data fails closed', field => {
  const { input,quote } = fixture('a');
  if (field === 'money') quote.orderSummary.totalAmount = '1.01';
  if (field === 'quantity') quote.orderItems[0].quantity = 2;
  if (field === 'seller') quote.sellerShipping[0].seller = 'other';
  if (field === 'discount') quote.orderItems[0].discountAmount = 0.01;
  expect(() => requireCheckoutQuote(quote,input.request)).toThrow();
});

test('native seller deduction stays in the original order currency and agrees with net amount', () => {
  const money = { currency:'PKR',summary:{ totalAmount:1200 } };
  const order = { paymentMethod:'safepay',sellerOnlineDeduction:{ version:1,basis:'original_order',currency:'PKR',grossAmount:1200,processingFeeAndTax:105.43,netAmount:1094.57 } };
  expect(getSellerOnlineDeduction(order,money).netAmount).toBe(1094.57);
  order.sellerOnlineDeduction.netAmount = 1094.56;
  expect(() => getSellerOnlineDeduction(order,money)).toThrow();
});
