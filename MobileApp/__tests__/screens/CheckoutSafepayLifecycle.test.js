import { readFileSync } from 'fs';
import { parse } from '@babel/parser';
const source = readFileSync(require.resolve('../../src/screens/CheckoutScreen.js'), 'utf8');
const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
const declaration = name => {
  let found;
  const walk = node => { if (!node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclarator' && node.id?.name === name) found = node.init;
    Object.values(node).forEach(value => { if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value); }); };
  walk(ast); return found;
};
// Keep the constructor native: Jest's React Native transform rewrites async
// function literals in this test module into ordinary generator wrappers.
const AsyncFunction = new Function('return Object.getPrototypeOf(async function() {}).constructor')();
const id = 'a'.repeat(24);
const pending = () => ({ safepay: true, paymentId: id, owner: 'buyerA', orderId: 'ORD-fixture', expectedPayment: { paymentId: id, environment: 'sandbox', purpose: 'order', currency: 'PKR', amountMinor: 100 },
  checkoutAttemptStorageKey: 'buyerA-key', checkoutAttemptFingerprint: 'frozen-price', checkoutAttemptKey: 'original-key' });

test('confirmed closed payments no longer trap checkout behind Continue payment, while review/refund holds still do', () => {
  const node = declaration('hasPendingSafepayPayment');
  const evaluate = new Function('paymentNotice', `return ${source.slice(node.start, node.end)}`);
  for (const status of ['cancelled', 'failed', 'refunded']) expect(evaluate({ ...pending(), status })).toBe(false);
  for (const status of ['pending', 'manual_review', 'refund_pending', 'reversed']) expect(evaluate({ ...pending(), status })).toBe(true);
});

test('the actual paid-result handler confirms once and clears only its scoped attempt', async () => {
  const node = declaration('applyPendingSafepayResult').arguments[0];
  const body = source.slice(node.body.start + 1, node.body.end - 1);
  const run = new AsyncFunction('verified', 'paymentNoticeRef', 'owner', 'ownerRef', 'completedPaymentsRef',
    'clearCheckoutAttempt', 'AsyncStorage', 'fetchCart', 'navigation', 'setPaymentNotice', body);
  const notice = pending(), clear = jest.fn(async () => true), cart = jest.fn(async () => {}), navigate = jest.fn(), seen = { current: new Set() };
  const invoke = data => run(data, { current: notice }, 'buyerA', { current: 'buyerA' }, seen, clear, {}, cart, { replace: navigate }, jest.fn());
  await invoke({ status: 'paid', paymentId: id }); await invoke({ status: 'paid', paymentId: id });
  expect(navigate).toHaveBeenCalledTimes(1); expect(cart).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledWith('PaymentSuccess', expect.objectContaining({ paymentId: id, orderId: notice.orderId }));
  expect(clear).toHaveBeenCalledWith({}, 'buyerA-key', 'frozen-price', 'original-key');
});
test('a stale payment or account result cannot navigate the actual checkout to success', async () => {
  const node = declaration('applyPendingSafepayResult').arguments[0];
  const run = new AsyncFunction('verified', 'paymentNoticeRef', 'owner', 'ownerRef', 'completedPaymentsRef',
    'clearCheckoutAttempt', 'AsyncStorage', 'fetchCart', 'navigation', 'setPaymentNotice', source.slice(node.body.start + 1, node.body.end - 1));
  const navigate = jest.fn(), clear = jest.fn();
  for (const [result, currentOwner] of [[{ status: 'paid', paymentId: 'b'.repeat(24) }, 'buyerA'], [{ status: 'paid', paymentId: id }, 'buyerB']]) {
    await run(result, { current: pending() }, 'buyerA', { current: currentOwner }, { current: new Set() }, clear, {}, jest.fn(), { replace: navigate }, jest.fn());
  }
  expect(navigate).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
});
test.each([['new-card', 'saved:pm_fixture'], ['saved:pm_fixture', 'new-card'], ['saved:pm_first', 'saved:pm_second']])(
  'the real pending-checkout branch retires %s before starting %s, never resuming the old form', async (from, to) => {
    const node = declaration('handlePlaceOrder');
    const body = source.slice(node.body.start + 1, node.body.end - 1).split("    trackCheckoutStep('place_order_clicked'")[0];
    const run = new AsyncFunction('currentStep', 'submittingRef', 'isProcessing', 'hasPendingSafepayPayment', 'paymentChoiceChanged',
      'canResumeSafepayPayment', 'paymentNotice', 'setIsProcessing', 'retireSafepayCheckout', 'api', 'ownerRef', 'owner',
      'applyPendingSafepayResult', 'resetCheckoutAttempt', 'setPaymentNotice', 'Feedback', 'resumeSafepayCheckout', 'navigation', body + "\n return 'fresh-selected-checkout';");
    const old = { ...pending(), paymentChoice: from }, retire = jest.fn(async () => ({ paymentId: id, checkoutRetired: true }));
    const reset = jest.fn(async () => true), resume = jest.fn(), ref = { current: false };
    expect(await run(2, ref, false, true, from !== to, true, old, jest.fn(), retire, {}, { current: 'buyerA' }, 'buyerA',
      jest.fn(), reset, jest.fn(), { show: jest.fn() }, resume, { navigate: jest.fn() })).toBe('fresh-selected-checkout');
    expect(retire).toHaveBeenCalledWith(expect.objectContaining({ paymentId: id, expectedPayment: old.expectedPayment }));
    expect(reset).toHaveBeenCalledWith({ storageKey: 'buyerA-key', fingerprint: 'frozen-price', attemptKey: 'original-key' });
    expect(resume).not.toHaveBeenCalled(); expect(ref.current).toBe(false);
  });
test('a paid or uncertain old attempt never falls through to fresh checkout on a method change', async () => {
  const node = declaration('handlePlaceOrder');
  const body = source.slice(node.body.start + 1, node.body.end - 1).split("    trackCheckoutStep('place_order_clicked'")[0];
  const run = new AsyncFunction('currentStep', 'submittingRef', 'isProcessing', 'hasPendingSafepayPayment', 'paymentChoiceChanged',
    'canResumeSafepayPayment', 'paymentNotice', 'setIsProcessing', 'retireSafepayCheckout', 'api', 'ownerRef', 'owner',
    'applyPendingSafepayResult', 'resetCheckoutAttempt', 'setPaymentNotice', 'Feedback', body + "\n return 'fresh-selected-checkout';");
  for (const retire of [async () => ({ status: 'paid', paymentId: id, checkoutRetired: false }), async () => { throw new Error('Provider uncertain'); }]) {
    const reset = jest.fn(), ref = { current: false };
    expect(await run(2, ref, false, true, true, true, pending(), jest.fn(), retire, {}, { current: 'buyerA' }, 'buyerA', jest.fn(), reset,
      jest.fn(), { show: jest.fn() })).toBeUndefined();
    expect(reset).not.toHaveBeenCalled(); expect(ref.current).toBe(false);
  }
});
