'use strict';

const { validateStoreSlug } = require('./storeSlug');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const textToHtml = (value) => String(value ?? '').trim().split(/\n\s*\n/).filter(Boolean)
  .map(paragraph => `<p style="margin:0 0 16px;line-height:1.65;color:#475569;">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
  .join('');

const isHtmlDocument = (html) => /^\s*(?:<!doctype\s+html|<html\b)/i.test(String(html ?? ''));

const trustedRozareUrl = value => {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (host === 'rozare.com' || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.rozare\.com$/.test(host))
      ? url.href : '';
  } catch (_) { return ''; }
};

const outboundNotificationUrl = path => {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u001f]/.test(path)) return '';
  const store = path.match(/^\/store\/([^/?#]+)([?#].*)?$/);
  if (store) {
    let slug;
    try { slug = decodeURIComponent(store[1]); } catch (_) { return ''; }
    const validated = validateStoreSlug(slug);
    return validated.valid ? `https://${validated.slug}.rozare.com/${store[2] || ''}` : '';
  }
  const destination = new URL(path, 'https://rozare.com');
  return destination.origin === 'https://rozare.com' ? destination.href : '';
};

const notificationActionLabel = (path = '') => {
  if (/^\/store\/[^/?#]+#store-reviews$/.test(path)) return 'View store reviews';
  if (/^\/orders\/confirm\//.test(path)) return 'Review order';
  if (/^\/seller-dashboard\/order-management.*[?&]tab=returns/.test(path)) return 'View returns';
  if (/^\/seller-dashboard\/order\//.test(path)) return 'Manage order';
  if (/^\/user-dashboard\/order\/detail\//.test(path)) return 'View order';
  if (/^\/user-dashboard\/wallet/.test(path)) return 'Open Rozare Wallet';
  if (/^\/seller-dashboard\/subscription/.test(path)) return 'Manage subscription';
  if (/^\/seller-dashboard\/payments/.test(path)) return 'View payments';
  if (/^\/seller-dashboard\/store-settings/.test(path)) return 'Open store settings';
  if (/^\/seller-dashboard\/product-management/.test(path)) return 'View products';
  if (/^\/seller-dashboard\/subdomain/.test(path)) return 'Manage store address';
  if (/^\/seller-dashboard\/store-overview/.test(path)) return 'Open seller dashboard';
  return 'View details';
};

const renderTransactionalEmail = ({ title = '', body = '', preheader = '', actionUrl = '', actionLabel = 'View in Rozare' }) => {
  const safeTitle = escapeHtml(title);
  const safePreview = escapeHtml(preheader || title || 'An update from Rozare');
  const safeActionUrl = trustedRozareUrl(actionUrl);
  const action = safeActionUrl
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0 8px;"><tr><td bgcolor="#0ea5e9" style="background:#0ea5e9;background-image:linear-gradient(110deg,#14b8a6,#0ea5e9,#6366f1);border-radius:12px;"><a href="${escapeHtml(safeActionUrl)}" style="display:inline-block;padding:14px 22px;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;">${escapeHtml(actionLabel)}</a></td></tr></table>`
    : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${safeTitle || 'Rozare'}</title></head>
<body style="margin:0;padding:0;background:#eef3fb;color:#1e293b;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
  <div style="display:none!important;visibility:hidden;mso-hide:all;max-height:0;overflow:hidden;opacity:0;color:transparent;">${safePreview}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#eef3fb" style="background:#eef3fb;background-image:linear-gradient(120deg,#e0f1ff,#efebfa);"><tr><td align="center" style="padding:28px 12px 40px;">
    <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;border-collapse:separate;">
      <tr><td bgcolor="#e5effe" style="background:#e5effe;background-image:linear-gradient(110deg,#cce9fb,#e4e8fa,#efdff6);border:1px solid #dce6f5;border-bottom:0;border-radius:20px 20px 0 0;padding:28px 32px 26px;">
        <table role="presentation" cellspacing="0" cellpadding="0"><tr>
          <td style="width:42px;height:42px;"><img src="https://rozare.com/favicon-512.png" alt="R" width="42" height="42" style="display:block;width:42px;height:42px;border:0;border-radius:11px;"></td>
          <td style="padding-left:13px;color:#24324f;font-size:25px;font-weight:800;letter-spacing:-.6px;">Rozare</td>
        </tr></table>
      </td></tr>
      <tr><td bgcolor="#f8faff" style="background:#f8faff;padding:30px 26px 32px;border-left:1px solid #dce6f5;border-right:1px solid #dce6f5;">
        ${safeTitle ? `<h1 style="margin:0 0 20px;color:#1f2937;font-size:24px;line-height:1.25;letter-spacing:-.35px;">${safeTitle}</h1>` : ''}
        <div style="color:#475569;font-size:15px;line-height:1.65;word-break:break-word;">${body}</div>
        ${action}
      </td></tr>
      <tr><td bgcolor="#f7f9ff" style="background:#f7f9ff;border:1px solid #dce6f5;border-top:2px solid #dce8fa;border-radius:0 0 20px 20px;padding:23px 26px;">
        <div style="color:#596680;font-size:12px;line-height:1.7;">Need help? <a href="mailto:support@rozare.com" style="color:#4f46e5;text-decoration:underline;">support@rozare.com</a> · <a href="https://rozare.com" style="color:#4f46e5;text-decoration:underline;">rozare.com</a></div>
        <div style="color:#8090a8;font-size:11px;line-height:1.7;margin-top:8px;"><a href="https://rozare.com/terms" style="color:#6b7295;text-decoration:underline;">Terms</a> · <a href="https://rozare.com/privacy" style="color:#6b7295;text-decoration:underline;">Privacy</a></div>
        <div style="color:#8090a8;font-size:11px;line-height:1.6;margin-top:10px;">ROZARE (SMC-PRIVATE) LIMITED<br>© ${new Date().getUTCFullYear()} Rozare. This is an automated message.</div>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
};

const prepareTransactionalEmail = ({ subject, html, text, actionUrl, actionLabel }) => {
  const content = String(html ?? '').trim();
  if (isHtmlDocument(content)) return content;
  const safeActionUrl = trustedRozareUrl(actionUrl);
  const hasAction = safeActionUrl && [
    `href="${escapeHtml(safeActionUrl)}"`, `href='${escapeHtml(safeActionUrl)}'`,
  ].some(href => content.includes(href));
  return renderTransactionalEmail({
    title: subject,
    body: content || textToHtml(text),
    actionUrl: hasAction ? '' : safeActionUrl,
    actionLabel,
  });
};

module.exports = { escapeHtml, isHtmlDocument, notificationActionLabel, outboundNotificationUrl, prepareTransactionalEmail, renderTransactionalEmail, textToHtml, trustedRozareUrl };
