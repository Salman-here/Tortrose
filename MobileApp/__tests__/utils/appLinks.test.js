import { createAppLinkHandlers, normalizeRozareAppLink, trustedRozareWebUrl } from '../../src/utils/appLinks';
const product = '6a931a9dfac20b9d5e05841e';
describe('verified Rozare web-link navigation', () => {
  test.each([
    ['https://rozare.com/', 'rozare://'],
    ['https://www.rozare.com/', 'rozare://'],
    ['https://novanest-qa-20261008.rozare.com/', 'rozare://store/novanest-qa-20261008'],
    [`https://rozare.com/single-product/${product}?currency=PKR`, `rozare://single-product/${product}`],
    [`https://novanest-qa-20261008.rozare.com/single-product/${product}`, `rozare://single-product/${product}`],
    ['https://rozare.com/store/nova-nest', 'rozare://store/nova-nest'],
    ['https://rozare.com/marketplace', 'rozare://marketplace'],
    ['https://rozare.com/user-dashboard/orders', 'rozare://orders'],
    [`https://rozare.com/user-dashboard/order/detail/${product}`, `rozare://order/${product}`],
    [`https://rozare.com/orders/confirm/${'a'.repeat(64)}?intent=cancel`, `rozare://orders/confirm/${'a'.repeat(64)}?intent=cancel`],
  ])('%s selects the matching screen, not an unrelated homepage', (input, target) => expect(normalizeRozareAppLink(input)).toBe(target));

  test.each(['https://evil.example/single-product/' + product, 'https://rozare.com.evil.example/',
    'https://username:password@rozare.com/', 'https://rozare.com:8443/', 'http://rozare.com/', 'file:///private', 'javascript:alert(1)',
    'https://rozare.com/single-product/not-an-id', 'https://docs.rozare.com/', 'https://ai-automations.rozare.com/',
    'https://rozare.com/admin-dashboard/chats', 'https://rozare.com/safepay/return', 'https://rozare.com/single-product/%2Fbad'])('does not turn %s into an app content route', input => expect(normalizeRozareAppLink(input)).toBeNull());

  test('custom cold payment returns remain supported, while active payment returns belong only to their presenter', async () => {
    const callback = 'rozare://safepay-return?paymentId=' + product;
    expect(normalizeRozareAppLink(callback)).toBe(callback);
    const linking = { getInitialURL: jest.fn().mockResolvedValue(callback), addEventListener: jest.fn() };
    const browser = jest.fn();
    const handlers = createAppLinkHandlers({ linking, openBrowser: browser, ownsReturn: value => value === callback });
    expect(await handlers.getInitialURL()).toBeNull(); expect(browser).not.toHaveBeenCalled();
  });

  test('cold starts and warm URL events normalize identically, and subscriptions are removed', async () => {
    const input = `https://nova-nest.rozare.com/single-product/${product}`;
    let listener; const remove = jest.fn();
    const linking = { getInitialURL: jest.fn().mockResolvedValue(input), addEventListener: jest.fn((_event, callback) => { listener = callback; return { remove }; }) };
    const handlers = createAppLinkHandlers({ linking, openBrowser: jest.fn() });
    expect(await handlers.getInitialURL()).toBe(`rozare://single-product/${product}`);
    const navigate = jest.fn(), unsubscribe = handlers.subscribe(navigate);
    listener({ url: input }); expect(navigate).toHaveBeenCalledWith(`rozare://single-product/${product}`);
    unsubscribe(); expect(remove).toHaveBeenCalledTimes(1);
  });

  test('unsupported owned pages open one explicit browser session; arbitrary foreign links are ignored', async () => {
    const browser = jest.fn().mockResolvedValue({ type: 'dismiss' });
    const linking = { getInitialURL: jest.fn().mockResolvedValue('https://rozare.com/admin-dashboard/chats') };
    const handlers = createAppLinkHandlers({ linking, openBrowser: browser });
    expect(await handlers.getInitialURL()).toBeNull(); await Promise.resolve();
    expect(browser).toHaveBeenCalledTimes(1); expect(browser).toHaveBeenCalledWith('https://rozare.com/admin-dashboard/chats');
    expect(trustedRozareWebUrl('https://foreign.example/')).toBeNull();
  });
});
