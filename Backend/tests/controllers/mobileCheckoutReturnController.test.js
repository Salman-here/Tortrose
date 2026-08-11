const {
    buildMobileCheckoutReturn,
    mobileCheckoutReturn,
} = require('../../controllers/mobileCheckoutReturnController');

function responseMock() {
    const response = {};
    response.status = jest.fn().mockReturnValue(response);
    response.set = jest.fn().mockReturnValue(response);
    response.type = jest.fn().mockReturnValue(response);
    response.send = jest.fn().mockReturnValue(response);
    return response;
}

describe('mobile hosted Checkout return bridge', () => {
    const previousFrontendUrl = process.env.FRONTEND_URL;

    afterAll(() => {
        if (previousFrontendUrl === undefined) delete process.env.FRONTEND_URL;
        else process.env.FRONTEND_URL = previousFrontendUrl;
    });

    test('builds only fixed app destinations and preserves the founder coupon', () => {
        expect(buildMobileCheckoutReturn({
            flow: 'subscription',
            result: 'cancelled',
            coupon: 'first100',
            frontendUrl: 'https://rozare.com',
        })).toMatchObject({
            appUrl: 'rozare://seller-subscription?checkout=cancelled&coupon=FIRST100',
            webUrl: 'https://rozare.com/seller-dashboard/subscription?cancelled=true&coupon=FIRST100',
        });

        expect(buildMobileCheckoutReturn({
            flow: 'subdomain',
            result: 'success',
            frontendUrl: 'https://rozare.com',
        })).toMatchObject({
            appUrl: 'rozare://seller-subdomain?purchase=success',
            webUrl: 'https://rozare.com/seller-dashboard/subdomain?purchase=success',
        });
    });

    test.each([
        ['other', 'success'],
        ['subscription', 'other'],
        [undefined, 'success'],
    ])('rejects unsupported flow/result %s %s', (flow, result) => {
        expect(buildMobileCheckoutReturn({ flow, result, frontendUrl: 'https://rozare.com' })).toBeNull();
    });

    test('ignores unknown coupons and an unsafe website fallback', () => {
        const destination = buildMobileCheckoutReturn({
            flow: 'subscription',
            result: 'cancelled',
            coupon: 'FIRST100&next=javascript:alert(1)',
            frontendUrl: 'javascript:alert(1)',
        });
        expect(destination.appUrl).toBe('rozare://seller-subscription?checkout=cancelled');
        expect(destination.webUrl).toBe('https://rozare.com/seller-dashboard/subscription?cancelled=true');
    });

    test('serves a no-store, hardened app bridge with a website fallback', () => {
        process.env.FRONTEND_URL = 'https://rozare.com';
        const request = { query: { flow: 'subdomain', result: 'success' } };
        const response = responseMock();

        mobileCheckoutReturn(request, response);

        expect(response.set).toHaveBeenCalledWith(expect.objectContaining({
            'Cache-Control': 'no-store, max-age=0',
            'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff',
        }));
        expect(response.type).toHaveBeenCalledWith('html');
        expect(response.send).toHaveBeenCalledWith(expect.stringContaining('rozare://seller-subdomain?purchase=success'));
        expect(response.send).toHaveBeenCalledWith(expect.stringContaining('https://rozare.com/seller-dashboard/subdomain?purchase=success'));
    });

    test('returns 400 for a manipulated return request', () => {
        const request = { query: { flow: 'https://attacker.test', result: 'success' } };
        const response = responseMock();

        mobileCheckoutReturn(request, response);

        expect(response.status).toHaveBeenCalledWith(400);
        expect(response.send).toHaveBeenCalledWith('Invalid mobile checkout return.');
        expect(response.type).not.toHaveBeenCalled();
    });
});
