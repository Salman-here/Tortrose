const trimTrailingSlashes = (value) => String(value || '').replace(/\/+$/, '');

/**
 * Build Stripe-hosted Checkout return URLs without accepting an arbitrary URL
 * from the client. Only the explicit `mobile` client receives the extra app
 * result parameter. Both clients use real HTTPS pages that are also registered
 * universal/app links, so the website remains a safe fallback.
 */
function getHostedCheckoutReturnUrls({
    client,
    flow,
    frontendUrl,
    backendUrl,
    couponCode = '',
}) {
    const isMobile = client === 'mobile';
    const safeFrontendUrl = trimTrailingSlashes(frontendUrl || 'https://rozare.com');
    const requestedBackendUrl = trimTrailingSlashes(backendUrl);
    const safeBackendUrl = /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(requestedBackendUrl)
        ? requestedBackendUrl
        : 'https://rozare.up.railway.app';

    if (flow === 'subscription') {
        const coupon = couponCode
            ? `&coupon=${encodeURIComponent(String(couponCode))}`
            : '';
        return isMobile
            ? {
                successUrl: `${safeBackendUrl}/api/subscription/mobile-return?flow=subscription&result=success`,
                cancelUrl: `${safeBackendUrl}/api/subscription/mobile-return?flow=subscription&result=cancelled${coupon}`,
            }
            : {
                successUrl: `${safeFrontendUrl}/seller-dashboard/subscription?success=true`,
                cancelUrl: `${safeFrontendUrl}/seller-dashboard/subscription?cancelled=true${coupon}`,
            };
    }

    if (flow === 'subdomain') {
        return isMobile
            ? {
                successUrl: `${safeBackendUrl}/api/subscription/mobile-return?flow=subdomain&result=success`,
                cancelUrl: `${safeBackendUrl}/api/subscription/mobile-return?flow=subdomain&result=cancelled`,
            }
            : {
                successUrl: `${safeFrontendUrl}/seller-dashboard/subdomain?purchase=success`,
                cancelUrl: `${safeFrontendUrl}/seller-dashboard/subdomain?purchase=cancelled`,
            };
    }

    throw new Error(`Unsupported hosted checkout flow: ${flow}`);
}

module.exports = {
    getHostedCheckoutReturnUrls,
};
