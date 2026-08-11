const FOUNDER_CODE = 'FIRST100';

const escapeHtml = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

function buildMobileCheckoutReturn({ flow, result, coupon, frontendUrl }) {
    if (!['subscription', 'subdomain'].includes(flow)) return null;
    if (!['success', 'cancelled'].includes(result)) return null;

    const requestedFrontendUrl = String(frontendUrl || '').replace(/\/+$/, '');
    const safeFrontendUrl = /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(requestedFrontendUrl)
        ? requestedFrontendUrl
        : 'https://rozare.com';
    if (flow === 'subscription') {
        const safeCoupon = String(coupon || '').trim().toUpperCase() === FOUNDER_CODE
            ? `&coupon=${FOUNDER_CODE}`
            : '';
        return {
            appUrl: `rozare://seller-subscription?checkout=${result}${safeCoupon}`,
            webUrl: result === 'success'
                ? `${safeFrontendUrl}/seller-dashboard/subscription?success=true`
                : `${safeFrontendUrl}/seller-dashboard/subscription?cancelled=true${safeCoupon}`,
            title: result === 'success' ? 'Subscription payment complete' : 'Subscription checkout cancelled',
            message: result === 'success'
                ? 'Return to Rozare while Stripe confirms your subscription.'
                : 'No charge was made. Return to Rozare to continue.',
        };
    }

    return {
        appUrl: `rozare://seller-subdomain?purchase=${result}`,
        webUrl: `${safeFrontendUrl}/seller-dashboard/subdomain?purchase=${result}`,
        title: result === 'success' ? 'Subdomain payment complete' : 'Subdomain checkout cancelled',
        message: result === 'success'
            ? 'Return to Rozare while Stripe confirms your ownership.'
            : 'No charge was made. Your subdomain is unchanged.',
    };
}

function mobileCheckoutReturn(req, res) {
    const destination = buildMobileCheckoutReturn({
        flow: req.query?.flow,
        result: req.query?.result,
        coupon: req.query?.coupon,
        frontendUrl: process.env.FRONTEND_URL,
    });
    if (!destination) {
        return res.status(400).send('Invalid mobile checkout return.');
    }

    res.set({
        'Cache-Control': 'no-store, max-age=0',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
    });
    res.type('html');

    const appUrl = escapeHtml(destination.appUrl);
    const webUrl = escapeHtml(destination.webUrl);
    const scriptUrl = JSON.stringify(destination.appUrl).replace(/</g, '\\u003c');
    return res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${escapeHtml(destination.title)} | Rozare</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, system-ui, -apple-system, sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: linear-gradient(145deg,#eef2ff,#e0f2fe,#f5f3ff); color:#172033; }
    main { width:min(88vw,420px); padding:30px; border:1px solid rgba(255,255,255,.75); border-radius:26px; background:rgba(255,255,255,.7); box-shadow:0 24px 70px rgba(30,64,175,.16); text-align:center; }
    .mark { width:58px; height:58px; margin:0 auto 18px; display:grid; place-items:center; border-radius:19px; color:white; font-size:26px; background:linear-gradient(135deg,#14b8a6,#0ea5e9,#6366f1); }
    h1 { margin:0; font-size:22px; } p { margin:10px 0 22px; color:#64748b; line-height:1.55; }
    a { display:block; padding:14px 18px; border-radius:15px; font-weight:800; text-decoration:none; }
    .primary { color:white; background:#6366f1; } .secondary { margin-top:10px; color:#4f46e5; background:rgba(99,102,241,.1); }
  </style>
</head>
<body>
  <main>
    <div class="mark">R</div>
    <h1>${escapeHtml(destination.title)}</h1>
    <p>${escapeHtml(destination.message)}</p>
    <a class="primary" href="${appUrl}">Open Rozare app</a>
    <a class="secondary" href="${webUrl}">Continue on website</a>
  </main>
  <script>window.location.replace(${scriptUrl});</script>
</body>
</html>`);
}

module.exports = {
    buildMobileCheckoutReturn,
    mobileCheckoutReturn,
};
