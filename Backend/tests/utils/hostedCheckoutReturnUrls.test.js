const {
    getHostedCheckoutReturnUrls,
} = require('../../utils/hostedCheckoutReturnUrls');

describe('hosted Checkout return URLs', () => {
    test('keeps the existing website subscription return for web and unknown clients', () => {
        expect(getHostedCheckoutReturnUrls({
            client: 'web',
            flow: 'subscription',
            frontendUrl: 'https://rozare.com/',
        })).toEqual({
            successUrl: 'https://rozare.com/seller-dashboard/subscription?success=true',
            cancelUrl: 'https://rozare.com/seller-dashboard/subscription?cancelled=true',
        });

        expect(getHostedCheckoutReturnUrls({
            client: 'attacker-controlled-value',
            flow: 'subscription',
            frontendUrl: 'https://rozare.com',
        }).successUrl.startsWith('https://rozare.com/')).toBe(true);
    });

    test('returns registered HTTPS app links with website fallbacks for mobile', () => {
        expect(getHostedCheckoutReturnUrls({
            client: 'mobile',
            flow: 'subscription',
            frontendUrl: 'https://rozare.com',
            backendUrl: 'https://rozare.up.railway.app/',
            couponCode: 'FIRST100',
        })).toEqual({
            successUrl: 'https://rozare.up.railway.app/api/subscription/mobile-return?flow=subscription&result=success',
            cancelUrl: 'https://rozare.up.railway.app/api/subscription/mobile-return?flow=subscription&result=cancelled&coupon=FIRST100',
        });

        expect(getHostedCheckoutReturnUrls({
            client: 'mobile',
            flow: 'subdomain',
            frontendUrl: 'https://rozare.com',
            backendUrl: 'https://rozare.up.railway.app',
        })).toEqual({
            successUrl: 'https://rozare.up.railway.app/api/subscription/mobile-return?flow=subdomain&result=success',
            cancelUrl: 'https://rozare.up.railway.app/api/subscription/mobile-return?flow=subdomain&result=cancelled',
        });
    });

    test('encodes a coupon value before placing it in a return URL', () => {
        const urls = getHostedCheckoutReturnUrls({
            client: 'mobile',
            flow: 'subscription',
            frontendUrl: 'https://rozare.com',
            backendUrl: 'https://rozare.up.railway.app',
            couponCode: 'FIRST 100&more',
        });
        expect(urls.cancelUrl).toBe(
            'https://rozare.up.railway.app/api/subscription/mobile-return?flow=subscription&result=cancelled&coupon=FIRST%20100%26more',
        );
    });

    test('never reflects an unsafe backend origin into Stripe return URLs', () => {
        const urls = getHostedCheckoutReturnUrls({
            client: 'mobile',
            flow: 'subdomain',
            frontendUrl: 'https://rozare.com',
            backendUrl: 'javascript:alert(1)',
        });
        expect(urls.successUrl.startsWith('https://rozare.up.railway.app/')).toBe(true);
    });

    test('rejects unsupported flows instead of constructing an unsafe URL', () => {
        expect(() => getHostedCheckoutReturnUrls({
            client: 'mobile',
            flow: 'other',
            frontendUrl: 'https://rozare.com',
        })).toThrow('Unsupported hosted checkout flow');
    });
});
