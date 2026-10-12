'use strict';

const { notificationActionLabel, outboundNotificationUrl, prepareTransactionalEmail, renderTransactionalEmail, trustedRozareUrl } = require('../../utils/transactionalEmail');
const { verificationCodeEmail, passwordResetEmail } = require('../../utils/accountEmailTemplates');

test('plain-text notifications receive the soft Rozare email layout and escape untrusted content', () => {
  const html = prepareTransactionalEmail({ subject: 'Seller <update>', text: 'A seller wrote <script>alert(1)</script>.', actionUrl: 'https://rozare.com/seller-dashboard/orders' });
  expect(html).toContain('<!DOCTYPE html>');
  expect(html).toContain('linear-gradient(110deg,#cce9fb,#e4e8fa,#efdff6)');
  expect(html).toContain('Seller &lt;update&gt;');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).toContain('https://rozare.com/seller-dashboard/orders');
  expect(html).toContain('support@rozare.com');
  expect(html).toContain('https://rozare.com/favicon-512.png');
  expect(html).not.toMatch(/Lahore|Pakistan/);
});

test('existing full HTML is not wrapped twice and external action URLs are rejected', () => {
  const existing = '<!doctype html><html><body><p>Order detail</p></body></html>';
  expect(prepareTransactionalEmail({ subject: 'Order', html: existing })).toBe(existing);
  expect(renderTransactionalEmail({ title: 'Update', body: '<p>Hi</p>', actionUrl: 'https://rozare.com.evil.test/pay' })).not.toContain('rozare.com.evil.test');
});

test('verification content matches its purpose and never promises free worldwide selling', () => {
  const seller = verificationCodeEmail({ name: '<Seller>', code: '123456', purpose: 'seller_signup', expiresMinutes: 10 });
  expect(seller.html).toContain('&lt;Seller&gt;');
  expect(seller.html).toContain('123456');
  expect(seller.html).toContain('Expires in 10 minutes');
  expect(seller.html).not.toMatch(/worldwide|all for free/i);
  const changed = verificationCodeEmail({ name: 'Sam', code: '654321', purpose: 'email_change', expiresMinutes: 10 });
  expect(changed.text).toContain('confirm this new email address');
  const reset = passwordResetEmail({ name: 'Sam', resetUrl: 'https://rozare.com/reset-password/test-token' });
  expect(reset.html).toContain('within one hour');
  expect(reset.text).toContain('https://rozare.com/reset-password/test-token');
});

test('public store actions use the assigned subdomain while private actions stay on the main site', () => {
  expect(outboundNotificationUrl('/store/atlas-aura#store-reviews')).toBe('https://atlas-aura.rozare.com/#store-reviews');
  expect(outboundNotificationUrl('/seller-dashboard/order/example')).toBe('https://rozare.com/seller-dashboard/order/example');
  expect(notificationActionLabel('/store/atlas-aura#store-reviews')).toBe('View store reviews');
  expect(notificationActionLabel('/user-dashboard/wallet')).toBe('Open Rozare Wallet');
  expect(notificationActionLabel('/seller-dashboard/subscription')).toBe('Manage subscription');
  for (const path of ['https://evil.test', '//evil.test', '/\\evil.test', '/store/admin', '/store/a%2Fb', '/store/%FF']) {
    expect(outboundNotificationUrl(path)).toBe('');
  }
  for (const url of ['https://rozare.com.evil.test', 'https://evil@rozare.com', 'http://rozare.com', 'https://rozare.com:9999']) {
    expect(trustedRozareUrl(url)).toBe('');
  }
});

test('an inline store or support link does not remove the required management action', () => {
  const html = prepareTransactionalEmail({ subject: 'Store created',
    html: '<p>Address: <a href="https://atlas-aura.rozare.com/">Atlas Aura</a></p>',
    actionUrl: 'https://rozare.com/seller-dashboard/store-settings', actionLabel: 'Open store settings' });
  expect(html).toContain('https://atlas-aura.rozare.com/');
  expect(html).toContain('Open store settings');
  const duplicate = prepareTransactionalEmail({ subject: 'Review',
    html: '<a href="https://atlas-aura.rozare.com/#store-reviews">View store reviews</a>',
    actionUrl: 'https://atlas-aura.rozare.com/#store-reviews', actionLabel: 'View store reviews' });
  expect(duplicate.match(/href="https:\/\/atlas-aura\.rozare\.com\/#store-reviews"/g)).toHaveLength(1);
});
