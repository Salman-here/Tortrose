'use strict';

function renderSafepayWebReturnHtml({ paymentId, nonce }) {
  if (typeof paymentId !== 'string' || !/^[a-f0-9]{24}$/i.test(paymentId)
    || typeof nonce !== 'string' || !/^[A-Za-z0-9+/]{24}$/.test(nonce)) {
    throw new Error('Invalid web payment return screen.');
  }
  const webUrl = `https://rozare.com/safepay/return?paymentId=${paymentId}`;
  // This message is navigation only. The parent must bind its source, origin
  // and payment reference, then ask the authenticated payment status endpoint.
  const signal = JSON.stringify({ type: 'rozare-safepay-return', paymentId });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Return to Rozare</title>
<style>body{margin:0;padding:36px;font-family:system-ui,sans-serif;color:#172435;background:#f8fafc}main{max-width:480px;margin:auto}p{line-height:1.6}a{display:inline-block;padding:14px 20px;background:#4f46e5;color:white;border-radius:12px;text-decoration:none}</style></head><body><main><h1>Returning to Rozare</h1><p>Rozare will securely check this payment. You can close this payment screen and return to checkout.</p><a href="${webUrl}" target="_blank" rel="noopener noreferrer">Open payment status in Rozare</a></main>
<script nonce="${nonce}">(()=>{'use strict';if(window.parent===window){window.location.replace(${JSON.stringify(webUrl)});return;}const signal=${signal};window.parent.postMessage(signal,'https://rozare.com');window.parent.postMessage(signal,'https://www.rozare.com');})();</script></body></html>`;
}

module.exports = { renderSafepayWebReturnHtml };
