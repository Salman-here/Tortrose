import { act, renderHook } from '@testing-library/react-native';
import useCheckoutQuote from '../../src/hooks/useCheckoutQuote';
import { createCheckoutQuoteInput } from '../../src/utils/checkoutQuote';

const input = actor => createCheckoutQuoteInput({ actor,currency:'USD',paymentMethod:'wallet',
  cart:[{ product:{ _id:'p',seller:'s' },qty:1 }],
  selections:{ s:{ type:'free' } },shippingMethods:{ s:{ methods:[{ type:'free' }] } } });
const quote = () => ({ success:true,pricingPolicyVersion:1,currency:'USD',
  orderSummary:{ subtotal:1.01,shippingCost:0,tax:0,couponDiscount:0,totalAmount:1.01 },
  orderItems:[{ productId:'p',quantity:1,lineSubtotal:1.01,discountAmount:0 }],
  sellerShipping:[{ seller:'s',shippingMethod:{ name:'free',price:0 } }],appliedCoupons:[] });

beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

test('checkout remains unavailable until its validated quote arrives', async () => {
  const requestQuote = jest.fn().mockResolvedValue({ data:quote() });
  const hook = renderHook(() => useCheckoutQuote({ input:input('a'),enabled:true,requestQuote }));
  expect(hook.result.current.ready).toBe(false);
  await act(async () => { jest.advanceTimersByTime(250); await Promise.resolve(); });
  expect(requestQuote).toHaveBeenCalledTimes(1);
  expect(hook.result.current.ready).toBe(true);
  expect(hook.result.current.quote.orderSummary.totalAmount).toBe(1.01);
  hook.unmount();
});

test('late responses after an account switch are discarded and cannot enable another buyer checkout', async () => {
  let resolveA,resolveB;
  const requestQuote = jest.fn().mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { resolveB = resolve; }));
  const hook = renderHook(({ actor }) => useCheckoutQuote({ input:input(actor),enabled:true,requestQuote }),{ initialProps:{ actor:'a' } });
  await act(async () => { jest.advanceTimersByTime(250); });
  hook.rerender({ actor:'b' });
  await act(async () => { jest.advanceTimersByTime(250); });
  await act(async () => { resolveA({ data:quote() }); await Promise.resolve(); });
  expect(hook.result.current.ready).toBe(false);
  expect(requestQuote.mock.calls[0][1].aborted).toBe(true);
  await act(async () => { resolveB({ data:quote() }); await Promise.resolve(); });
  expect(hook.result.current.ready).toBe(true);
  hook.unmount();
});

test('invalid totals produce an error and never enable checkout', async () => {
  const bad = quote(); bad.orderSummary.totalAmount = 1;
  const hook = renderHook(() => useCheckoutQuote({ input:input('a'),enabled:true,requestQuote:async () => ({ data:bad }) }));
  await act(async () => { jest.advanceTimersByTime(250); await Promise.resolve(); });
  expect(hook.result.current.ready).toBe(false);
  expect(hook.result.current.error).toContain('do not add up');
  hook.unmount();
});
