jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
import { validateSafepayCheckout, normalizeSafepayStatus, openSafepayCheckout, verifySafepayPayment, resumeSafepayCheckout,
  retireSafepayCheckout, getSafepayCheckoutChoice, safepayPaymentExpectation } from '../../src/utils/safepayCheckout';
const paymentId = 'a'.repeat(24);
const payment = { paymentId, paymentMethod: 'safepay', paymentFlow: 'safepay_hosted', environment: 'sandbox',
  checkoutUrl: 'https://sandbox.api.getsafepay.com/embedded/?tracker=track_fixture', status: 'pending', isPaid: false };

test('new-card and distinct saved-card choices cannot be confused with the original frozen attempt', () => {
  expect(getSafepayCheckoutChoice('card', '')).toBe('new-card');
  expect(getSafepayCheckoutChoice('card', 'raast')).toBe('new-card');
  expect(getSafepayCheckoutChoice('card', 'pm_card-one')).toBe('saved:pm_card-one');
  expect(getSafepayCheckoutChoice('card', 'pm_card-two')).not.toBe(getSafepayCheckoutChoice('card', 'pm_card-one'));
  expect(getSafepayCheckoutChoice('wallet')).toBe('wallet');
});
test('pending verification expectations contain no provider URL, session ticket or grant', () => {
  expect(safepayPaymentExpectation({ ...payment, purpose: 'order', currency: 'PKR', amountMinor: 100,
    checkoutSessionGrant: 'private-grant', user: 'buyerA' })).toEqual({ paymentId, purpose: 'order', environment: 'sandbox', currency: 'PKR', amountMinor: 100 });
});
test('retirement closes an explicitly owned idle purchase without falsely confirming financial cancellation', async () => {
  const pending = { ...payment, purpose: 'order', amountMinor: 100, currency: 'PKR', checkoutRetired: true };
  const apiClient = { post: jest.fn(async () => ({ data: pending })) };
  expect(await retireSafepayCheckout({ apiClient, paymentId, expectedPayment: pending })).toMatchObject({ checkoutRetired: true, isPaid: false, status: 'pending' });
  expect(apiClient.post).toHaveBeenCalledTimes(1);
  expect(apiClient.post).toHaveBeenCalledWith(`/api/safepay/payments/${paymentId}/retire-checkout`, { clientSurface: 'mobile' });
});
test('payment racing a method change is confirmed, never returned as retired permission for a new charge', async () => {
  const pending = { ...payment, purpose: 'order', amountMinor: 100, currency: 'PKR' };
  const paid = { ...pending, status: 'paid', isPaid: true, webhookProcessed: true, checkoutRetired: false };
  const apiClient = { post: jest.fn(async () => ({ data: paid })) };
  expect(await retireSafepayCheckout({ apiClient, paymentId, expectedPayment: pending })).toMatchObject({ status: 'paid', checkoutRetired: false });
  apiClient.post.mockResolvedValue({ data: { ...paid, checkoutRetired: true } });
  await expect(retireSafepayCheckout({ apiClient, paymentId, expectedPayment: pending })).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_INVALID' });
});
test('a foreign payment/money response cannot authorize switching the original checkout', async () => {
  const pending = { ...payment, purpose: 'order', amountMinor: 100, currency: 'PKR' };
  for (const change of [{ paymentId: 'b'.repeat(24) }, { amountMinor: 101 }, { environment: 'production' }, { purpose: 'wallet_top_up' }]) {
    await expect(retireSafepayCheckout({ apiClient: { post: async () => ({ data: { ...pending, checkoutRetired: true, ...change } }) },
      paymentId, expectedPayment: pending })).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_INVALID' });
  }
});
test('aborting a status read cancels the request and removes its bounded timer without reporting a financial outcome', async () => {
  jest.useFakeTimers();
  try {
    const controller = new AbortController(), apiClient = { get: jest.fn(() => new Promise(() => {})) };
    const promise = verifySafepayPayment({ apiClient, paymentId, signal: controller.signal, attempts: 6 });
    const rejection = expect(promise).rejects.toMatchObject({ code: 'SAFEPAY_VERIFICATION_ABORTED' });
    await jest.advanceTimersByTimeAsync(0); controller.abort(); await jest.advanceTimersByTimeAsync(0); await rejection;
    expect(apiClient.get).toHaveBeenCalledTimes(1); expect(apiClient.get.mock.calls[0][1].signal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test('continue payment reopens the original provider checkout without creating another order', async () => {
  const apiClient = { post: jest.fn().mockResolvedValue({ data: payment }), get: jest.fn().mockResolvedValue({ data: payment }) };
  const openSheet = jest.fn().mockResolvedValue({ type: 'dismiss' });
  await expect(resumeSafepayCheckout({ apiClient, paymentId, openSheet })).resolves.toMatchObject({ paymentId, status: 'pending' });
  expect(apiClient.post).toHaveBeenCalledTimes(1); expect(apiClient.post).toHaveBeenCalledWith(`/api/safepay/payments/${paymentId}/reopen`, { clientSurface: 'mobile' });
  expect(openSheet).toHaveBeenCalledWith(expect.objectContaining({ paymentId }));
});

test('reopening a different payment never opens a provider form', async () => {
  const apiClient = { post: jest.fn().mockResolvedValue({ data: { ...payment, paymentId: 'b'.repeat(24) } }) }, openSheet = jest.fn();
  await expect(resumeSafepayCheckout({ apiClient, paymentId, openSheet })).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_INVALID' }); expect(openSheet).not.toHaveBeenCalled();
});
test('a verified zero-amount non-reusable card setup closes without reopening the completed provider form', async () => {
  const failed = { paymentId, paymentMethod: 'safepay', paymentFlow: 'safepay_hosted', environment: 'sandbox',
    purpose: 'card_setup', currency: 'PKR', amountMinor: 0, status: 'failed', isPaid: false, completed: false, cardSaved: false,
    failureCode: 'SAFEPAY_CARD_SETUP_NOT_REUSABLE' };
  const openSheet = jest.fn(), apiClient = { get: jest.fn(async () => ({ data: failed })) };
  await expect(openSafepayCheckout({ apiClient, response: failed, openSheet })).resolves.toMatchObject({ status: 'failed', cardSaved: false });
  expect(openSheet).not.toHaveBeenCalled(); expect(apiClient.get).toHaveBeenCalledTimes(1);
  expect(() => validateSafepayCheckout({ ...failed, purpose: 'order' })).toThrow();
});
test('accepts only the exact configured provider host and HTTPS checkout path', () => {
  expect(validateSafepayCheckout({ data: payment }).paymentId).toBe(paymentId);
  for (const checkoutUrl of ['http://sandbox.api.getsafepay.com/embedded/', 'https://sandbox.api.getsafepay.com.evil.example/embedded/',
    'https://sandbox.api.getsafepay.com@evil.example/embedded/', 'https://getsafepay.com/embedded/',
    'https://sandbox.api.getsafepay.com/dashboard/home', 'javascript:alert(1)']) {
    expect(() => validateSafepayCheckout({ ...payment, checkoutUrl })).toThrow();
  }
});

test('saved-card bank verification is restricted to the original payment and fixed backend path', () => {
  const checkoutUrl = `https://rozare.up.railway.app/api/safepay/saved-checkout/${paymentId}#ticket=fixture.signed.ticket`;
  expect(validateSafepayCheckout({ ...payment, checkoutUrl, checkoutPresentation: 'saved-card', checkoutSessionGrant: 'fixture.signed.grant' }).paymentId).toBe(paymentId);
  for (const url of [checkoutUrl.replace('rozare.up.railway.app', 'evil.example'), checkoutUrl.replace(paymentId, 'b'.repeat(24)),
    checkoutUrl.replace('#ticket=', '?ticket='), checkoutUrl.replace('https:', 'http:'), checkoutUrl.replace('/saved-checkout/', '/other/')]) {
    expect(() => validateSafepayCheckout({ ...payment, checkoutUrl: url, checkoutPresentation: 'saved-card', checkoutSessionGrant: 'fixture.signed.grant' })).toThrow();
  }
  expect(() => validateSafepayCheckout({ ...payment, checkoutUrl, checkoutPresentation: 'saved-card' })).toThrow();
  expect(() => validateSafepayCheckout({ ...payment, checkoutUrl })).toThrow();
});
test('return URLs and a lone paid flag cannot grant a payment', () => {
  expect(normalizeSafepayStatus({ ...payment, status: 'paid', isPaid: true }, paymentId).status).toBe('pending');
  expect(() => normalizeSafepayStatus({ ...payment, paymentId: 'b'.repeat(24) }, paymentId)).toThrow();
  expect(normalizeSafepayStatus({ ...payment, status: 'paid', isPaid: true, webhookProcessed: true }, paymentId).status).toBe('paid');
});

test('native rail validation accepts unknown and verified PKR Raast without trusting an invalid declaration', () => {
  expect(normalizeSafepayStatus(payment, paymentId).paymentRail).toBe('unknown');
  expect(normalizeSafepayStatus({ ...payment, paymentRail: 'raast', currency: 'PKR' }, paymentId).paymentRail).toBe('raast');
  for (const extra of [{ paymentRail: 'other' }, { paymentRail: 'raast', currency: 'USD' },
    { paymentRail: 'raast', currency: 'PKR', purpose: 'card_setup' }]) {
    expect(() => normalizeSafepayStatus({ ...payment, ...extra }, paymentId)).toThrow();
  }
});

test('native pending card selection may switch to Raast, but captured and saved-card evidence remains bound', async () => {
  const pending = { ...payment, currency: 'PKR', amountMinor: 10000, purpose: 'order', paymentRail: 'card' };
  const paid = { ...pending, paymentRail: 'raast', status: 'paid', isPaid: true, webhookProcessed: true };
  expect(normalizeSafepayStatus(paid, paymentId, pending).status).toBe('paid');
  expect(normalizeSafepayStatus(paid, paymentId, { ...pending, status: 'paid', isPaid: true }).status).toBe('paid');
  for (const expected of [{ ...pending, status: 'paid', isPaid: true, webhookProcessed: true },
    ...['refund_pending', 'refunded', 'manual_review'].map(status => ({ ...pending, status, providerState: 'TRACKER_ENDED' })),
    { ...pending, status: 'manual_review', capturedMinor: 10000 }, { ...pending, checkoutPresentation: 'saved-card' }]) {
    expect(() => normalizeSafepayStatus(paid, paymentId, expected)).toThrow();
  }
  expect(normalizeSafepayStatus({ ...paid, webhookProcessed: false }, paymentId, pending).status).toBe('pending');
  expect(normalizeSafepayStatus(paid, paymentId, { ...pending, checkoutPresentation: 'saved-card', cardEntryRequired: true }).status).toBe('paid');
  expect(() => validateSafepayCheckout({ ...paid, checkoutPresentation: 'saved-card' })).toThrow();
  const apiClient = { get: jest.fn(async () => ({ data: paid })) };
  const result = await openSafepayCheckout({ apiClient, response: pending, openBrowser: async () => ({ type: 'dismiss' }) });
  expect(result.status).toBe('paid'); expect(result.paymentRail).toBe('raast');
  await expect(verifySafepayPayment({ apiClient, paymentId, expectedPayment: { ...pending, checkoutPresentation: 'saved-card' } })).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_INVALID' });
});
test('browser cancellation can race success: trust only authenticated backend verification', async () => {
  const apiClient = { get: jest.fn(async () => ({ data: { ...payment, status: 'paid', isPaid: true, webhookProcessed: true } })) };
  const openBrowser = jest.fn(async () => ({ type: 'cancel' }));
  const result = await openSafepayCheckout({ apiClient, response: payment, openBrowser });
  expect(result.status).toBe('paid');
  expect(result.browserDismissed).toBe(true);
  expect(apiClient.get).toHaveBeenCalledWith(`/api/safepay/payments/${paymentId}`,
    expect.objectContaining({ timeout: 2000, signal: expect.any(Object) }));
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

test.each(['dismiss', 'cancel', 'return'])('a closed sheet (%s) performs one quick check, not blocking polling', async type => {
  const apiClient = { get: jest.fn(async () => ({ data: payment })) };
  const result = await openSafepayCheckout({ apiClient, response: payment, openSheet: async () => ({ type }) });
  expect(result.status).toBe('pending');
  expect(result.paymentId).toBe(paymentId);
  expect(apiClient.get).toHaveBeenCalledTimes(1);
});

test('a stalled status request cannot keep a closed payment button busy or report cancellation', async () => {
  jest.useFakeTimers();
  try {
    let complete;
    const apiClient = { get: jest.fn(() => new Promise(resolve => { complete = resolve; })) };
    const result = openSafepayCheckout({ apiClient, response: payment, openSheet: async () => ({ type: 'cancel' }) });
    await jest.advanceTimersByTimeAsync(2000);
    await expect(result).resolves.toMatchObject({ status: 'pending', paymentId, isPaid: false, browserDismissed: true });
    expect(apiClient.get.mock.calls[0][1].signal.aborted).toBe(true);
    // A late response cannot mutate the already-returned result or create a retry.
    complete({ data: { ...payment, status: 'paid', isPaid: true, webhookProcessed: true } });
    await jest.runAllTimersAsync();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
