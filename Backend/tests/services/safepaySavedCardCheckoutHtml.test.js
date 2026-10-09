'use strict';
const vm = require('node:vm');
const { renderSavedCardCheckout } = require('../../services/safepaySavedCardCheckoutHtml');

function screen(fetchImpl) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: true, disabled: false, textContent: '',
      replaceChildren: jest.fn() });
    return elements.get(id);
  };
  const pageWindow = { addEventListener: jest.fn() }; pageWindow.parent = pageWindow;
  const html = renderSavedCardCheckout({ nonce: 'abcdefghijklmnopqrstuvwx', initialGrant: 'test-signed-in-grant' });
  const script = html.match(/<script nonce="[^"]+">([\s\S]+?)<\/script>/)[1];
  vm.runInNewContext(script, { document: { getElementById: element, createElement: () => ({}) }, window: pageWindow,
    location: { hash: '#ticket=test-ticket', pathname: '/api/safepay/saved-checkout/test-payment', replace: jest.fn() },
    fetch: fetchImpl, customElements: { get: () => true }, URLSearchParams, URL, Intl, setTimeout });
  return { element };
}
const context = overrides => ({ currency: 'USD', amountMinor: 200, environment: 'sandbox', card: { brand: 'Visa', last4: '1111' },
  billing: { street_1: '1 Test Lane', city: 'Lahore', country: 'PK', state: '', postal_code: '' },
  canAuthenticate: true, canRestartAuthentication: false, returnUrl: 'https://rozare.com', ...overrides });
const response = (data, ok = true) => ({ ok, json: async () => data });
const settled = () => new Promise(resolve => setImmediate(resolve));

test('lost first setup reply refreshes authoritative context and offers explicit retry without automatically replaying setup', async () => {
  const fetchImpl = jest.fn()
    .mockResolvedValueOnce(response(context()))
    .mockResolvedValueOnce(response({ msg: 'First bank setup reply was lost.' }, false))
    .mockResolvedValueOnce(response(context({ canRestartAuthentication: true })))
    .mockResolvedValueOnce(response({ environment: 'sandbox', tracker: 'track_same-fixture', user: 'cus_same-fixture',
      authToken: 'test-auth-token', billing: { country: 'PK' }, returnUrl: 'https://rozare.com',
      deviceDataCollectionJWT: 'test-device-jwt', deviceDataCollectionURL: 'https://centinelapistag.cardinalcommerce.com/V1/Cruise/Collect' }));
  const { element } = screen(fetchImpl); await settled();
  element('street').value = 'Changed Test Lane';
  await element('form').onsubmit({ preventDefault() {} });
  expect(fetchImpl.mock.calls.map(([url]) => url.split('/').pop())).toEqual(['context', 'authenticate', 'context']);
  expect(JSON.parse(fetchImpl.mock.calls[1][1].body).restartAuthentication).toBe(false);
  expect(element('pay').textContent).toBe('Retry bank verification · $2.00');
  expect(element('street').value).toBe('Changed Test Lane');
  expect(element('pay').disabled).toBe(false); expect(element('form').hidden).toBe(false);
  await element('form').onsubmit({ preventDefault() {} });
  expect(JSON.parse(fetchImpl.mock.calls[3][1].body)).toMatchObject({ restartAuthentication: true,
    billing: { street_1: 'Changed Test Lane', country: 'PK' } });
  expect(element('form').hidden).toBe(true); expect(element('bank').replaceChildren).toHaveBeenCalledTimes(1);
});

test('owned context reporting an active recovery disables further approval instead of claiming the payment is completed', async () => {
  const fetchImpl = jest.fn().mockResolvedValue(response(context({ canAuthenticate: false, authenticationInProgress: true })));
  const { element } = screen(fetchImpl); await settled();
  expect(element('form').hidden).toBe(true); expect(element('pay').disabled).toBe(true);
  expect(element('status').textContent).toContain('Bank verification is being checked');
  await element('form').onsubmit({ preventDefault() {} });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('a failed refreshed identity read keeps payment disabled rather than trusting the earlier screen state', async () => {
  const fetchImpl = jest.fn().mockResolvedValueOnce(response(context()))
    .mockResolvedValueOnce(response({ msg: 'Payment is being checked.' }, false))
    .mockRejectedValueOnce(new Error('test refreshed context request failed'));
  const { element } = screen(fetchImpl); await settled();
  await element('form').onsubmit({ preventDefault() {} });
  expect(element('pay').disabled).toBe(true);
  expect(element('status').textContent).toContain('reopen the same payment');
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});
