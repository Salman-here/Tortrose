import { presentSafepaySheet, registerSafepayPresenter, safepayNavigationAction } from '../../src/utils/safepaySheet';
test('the embedded completion URL is navigation, not a proof of payment', () => {
  expect(safepayNavigationAction('https://sandbox.api.getsafepay.com/embedded/external/complete?paid=true', 'sandbox')).toBe('complete');
  expect(safepayNavigationAction('https://sandbox.api.getsafepay.com/embedded/external/error', 'sandbox')).toBe('complete');
  expect(safepayNavigationAction('https://sandbox.api.getsafepay.com.evil.example/embedded/external/complete', 'sandbox')).not.toBe('complete');
});
test.each(['javascript:alert(1)', 'file:///secret', 'http://unsecured.example', 'intent://bank', 'https://user:pass@example.com'])('blocks unsafe or external-app navigation: %s', url => {
  expect(safepayNavigationAction(url, 'sandbox')).toBe('block');
});
test('permits HTTPS bank authentication and empty provider frames', () => {
  expect(safepayNavigationAction('https://issuer.example/3ds', 'sandbox')).toBe('allow');
  expect(safepayNavigationAction('about:blank', 'sandbox')).toBe('allow');
});
test('presenter is in-memory and cannot be reused after unmount', async () => {
  const show = jest.fn(async () => ({ type: 'dismiss' }));
  const stop = registerSafepayPresenter(show);
  const payment = { paymentId: 'test' };
  await expect(presentSafepaySheet(payment)).resolves.toEqual({ type: 'dismiss' });
  expect(show).toHaveBeenCalledWith(payment);
  stop();
  await expect(presentSafepaySheet(payment)).rejects.toThrow('not ready');
});
