import { cancelSafepayBrowser, isSafepayBrowserReturn, presentSafepayBrowser, validateSafepayBrowserPayment } from '../../src/utils/safepayBrowser';
const id = 'a'.repeat(24);
const fixture = () => {
  const url = new URL('https://sandbox.api.getsafepay.com/embedded/');
  url.searchParams.set('environment', 'sandbox'); url.searchParams.set('source', 'hosted');
  for (const [key, outcome] of [['redirect_url', 'return'], ['cancel_url', 'cancel']]) {
    const target = new URL('https://rozare.up.railway.app/api/safepay/return');
    target.search = new URLSearchParams({ browser: '1', attempt: id, purpose: 'order', surface: 'mobile', outcome }).toString();
    url.searchParams.set(key, target.toString());
  }
  return { paymentId: id, purpose: 'order', environment: 'sandbox', checkoutPresentation: 'browser', checkoutUrl: url.toString() };
};
afterEach(() => cancelSafepayBrowser());

test('validating a hosted link does not launch or claim a browser session', () => {
  const payment = fixture();
  expect(validateSafepayBrowserPayment(payment)).toBe(payment.checkoutUrl);
  expect(isSafepayBrowserReturn(`rozare://safepay-return?paymentId=${id}&purpose=order`)).toBe(false);
});
test('opens the supported system session, not an incognito WebView; a close is not cancellation proof', async () => {
  const open = jest.fn().mockResolvedValue({ type: 'cancel' }), payment = fixture();
  await expect(presentSafepayBrowser(payment, open)).resolves.toEqual({ type: 'dismiss' });
  expect(open).toHaveBeenCalledWith(payment.checkoutUrl, 'rozare://safepay-return', { preferEphemeralSession: false, showTitle: true });
});
test('one active payment owns its callback and repeated opens share the same browser session', async () => {
  let finish; const open = jest.fn(() => new Promise(resolve => { finish = resolve; })), payment = fixture();
  const first = presentSafepayBrowser(payment, open), second = presentSafepayBrowser(payment, open);
  expect(first).toBe(second); await Promise.resolve();
  expect(isSafepayBrowserReturn(`rozare://safepay-return?paymentId=${id}&purpose=order`)).toBe(true);
  expect(isSafepayBrowserReturn(`rozare://safepay-return?paymentId=${'b'.repeat(24)}&purpose=order`)).toBe(false);
  finish({ type: 'success', url: `rozare://safepay-return?paymentId=${id}&purpose=order&outcome=return` });
  await expect(first).resolves.toEqual({ type: 'return' }); expect(open).toHaveBeenCalledTimes(1);
});
test.each(['http://sandbox.api.getsafepay.com/embedded/', 'https://evil.example/embedded/'])('rejects a foreign browser URL before opening it: %s', async checkoutUrl => {
  const open = jest.fn(); await expect(presentSafepayBrowser({ ...fixture(), checkoutUrl }, open)).rejects.toMatchObject({ code: 'SAFEPAY_BROWSER_INVALID' }); expect(open).not.toHaveBeenCalled();
});
test('rejects a checkout redirect bound to another payment', async () => {
  const payment = fixture(), url = new URL(payment.checkoutUrl);
  url.searchParams.set('redirect_url', 'https://evil.example/collect');
  const open = jest.fn(); await expect(presentSafepayBrowser({ ...payment, checkoutUrl: url.toString() }, open)).rejects.toMatchObject({ code: 'SAFEPAY_BROWSER_INVALID' }); expect(open).not.toHaveBeenCalled();
});

test.each([['b'.repeat(24), 'order'], [id, 'wallet_top_up']])('a foreign return never completes the owned browser checkout (%s, %s)', async (paymentId, purpose) => {
  const open = jest.fn().mockResolvedValue({ type: 'success', url: `rozare://safepay-return?paymentId=${paymentId}&purpose=${purpose}` });
  await expect(presentSafepayBrowser(fixture(), open)).rejects.toMatchObject({ code: 'SAFEPAY_BROWSER_INVALID' });
});

test('a failed browser launch releases its session so the same original attempt can be retried', async () => {
  const payment = fixture();
  await expect(presentSafepayBrowser(payment, () => { throw new Error('Browser unavailable'); })).rejects.toThrow('unavailable');
  await expect(presentSafepayBrowser(payment, async () => ({ type: 'cancel' }))).resolves.toEqual({ type: 'dismiss' });
});
