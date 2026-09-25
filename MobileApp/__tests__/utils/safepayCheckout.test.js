jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
import { validateSafepayCheckout, normalizeSafepayStatus, openSafepayCheckout, verifySafepayPayment } from '../../src/utils/safepayCheckout';
const paymentId = 'a'.repeat(24);
const payment = { paymentId, paymentMethod: 'safepay', paymentFlow: 'safepay_hosted', environment: 'sandbox',
  checkoutUrl: 'https://sandbox.api.getsafepay.com/embedded/?tracker=track_fixture', status: 'pending', isPaid: false };
test('accepts only the exact configured provider host and HTTPS checkout path', () => {
  expect(validateSafepayCheckout({ data: payment }).paymentId).toBe(paymentId);
  for (const checkoutUrl of ['http://sandbox.api.getsafepay.com/embedded/', 'https://sandbox.api.getsafepay.com.evil.example/embedded/',
    'https://sandbox.api.getsafepay.com@evil.example/embedded/', 'https://getsafepay.com/embedded/',
    'https://sandbox.api.getsafepay.com/dashboard/home', 'javascript:alert(1)']) {
    expect(() => validateSafepayCheckout({ ...payment, checkoutUrl })).toThrow();
  }
});
test('return URLs and a lone paid flag cannot grant a payment', () => {
  expect(normalizeSafepayStatus({ ...payment, status: 'paid', isPaid: true }, paymentId).status).toBe('pending');
  expect(() => normalizeSafepayStatus({ ...payment, paymentId: 'b'.repeat(24) }, paymentId)).toThrow();
  expect(normalizeSafepayStatus({ ...payment, status: 'paid', isPaid: true, webhookProcessed: true }, paymentId).status).toBe('paid');
});
test('browser cancellation can race success: trust only authenticated backend verification', async () => {
  const apiClient = { get: jest.fn(async () => ({ data: { ...payment, status: 'paid', isPaid: true, webhookProcessed: true } })) };
  const openBrowser = jest.fn(async () => ({ type: 'cancel' }));
  const result = await openSafepayCheckout({ apiClient, response: payment, openBrowser });
  expect(result.status).toBe('paid');
  expect(result.browserDismissed).toBe(true);
  expect(apiClient.get).toHaveBeenCalledWith(`/api/safepay/payments/${paymentId}`);
});
test('an interrupted browser still checks backend state without creating another payment', async () => {
  const apiClient = { get: jest.fn(async () => ({ data: { ...payment, status: 'cancelled' } })) };
  const result = await openSafepayCheckout({ apiClient, response: payment, openBrowser: async () => { throw new Error('interrupted'); } });
  expect(result.status).toBe('cancelled');
  expect(apiClient.get).toHaveBeenCalledTimes(1);
});
test('network uncertainty retains pending instead of declaring a failed payment', async () => {
  const apiClient = { get: jest.fn(async () => { throw new Error('offline'); }) };
  expect((await verifySafepayPayment({ apiClient, paymentId, attempts: 2, sleep: async () => {} })).status).toBe('pending');
  expect(apiClient.get).toHaveBeenCalledTimes(2);
});
test('another owner or an invalid reference fails closed', async () => {
  const error = { response: { status: 403 } };
  await expect(verifySafepayPayment({ apiClient: { get: async () => { throw error; } }, paymentId })).rejects.toEqual(error);
  const apiClient = { get: jest.fn() };
  await expect(verifySafepayPayment({ apiClient, paymentId: '../someone' })).rejects.toThrow();
  expect(apiClient.get).not.toHaveBeenCalled();
});
