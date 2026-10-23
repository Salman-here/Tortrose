'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildRuntimeNotificationGalleryEntries, coverageMatrix, exclusions, runtimeGalleryCounts, notificationCallSiteInventory } = require('../../scripts/runtimeNotificationGallery');

let entries;
const one = (name, channel = 'email') => {
  const entry = entries.find(item => item.name === name && item.channel === channel);
  if (!entry) throw new Error(`Missing preview ${channel}:${name}`);
  return entry;
};

beforeAll(async () => { entries = await buildRuntimeNotificationGalleryEntries(); });

test('inventory contains source-exact active descriptors and no fabricated historical versions', () => {
  expect(entries.filter(item => item.channel === 'email' && item.activity === 'active')).toHaveLength(153);
  expect(entries.filter(item => item.channel === 'whatsapp' && item.activity === 'active')).toHaveLength(145);
  expect(new Set(entries.map(item => `${item.channel}:${item.name}`)).size).toBe(entries.length);
  for (const entry of entries) {
    expect(['active', 'legacy', 'review-required', 'exception']).toContain(entry.activity);
    expect(entry).toMatchObject({ kind: 'Current source template' });
    expect(entry).not.toHaveProperty('before');
    expect(entry.sourceLine).toBeGreaterThan(0);
    const source = fs.readFileSync(path.resolve(__dirname, '../../..', entry.sourcePath), 'utf8');
    expect(entry.sourceLine).toBeLessThanOrEqual(source.split('\n').length);
    expect(JSON.stringify(entry.after)).not.toMatch(/\{\{money\./);
    expect(entry.name).not.toMatch(/Withdrawal completed/);
    if (entry.channel === 'email') expect(entry.after.subject.length).toBeGreaterThan(0);
    else expect(entry.after.message.length).toBeGreaterThan(0);
  }
});

test('captured metadata adds correct buyer and seller order links through the production normalizer', () => {
  expect(one('Seller paid-order receipt').after.html).toContain('https://rozare.com/seller-dashboard/order/000000000000000000000003');
  expect(one('Buyer paid-order receipt').after.html).toContain('https://rozare.com/user-dashboard/order/detail/000000000000000000000003');
  expect(one('Seller paid-order receipt', 'whatsapp').after.message).toContain('View details: https://rozare.com/seller-dashboard/order/');
  expect(one('Buyer return refund full Wallet credit', 'whatsapp').after.message).toContain('?returnId=000000000000000000000005');
});

test('all current withdrawal states render frozen amount and actual status meanings', () => {
  for (const status of ['pending', 'approved', 'processing', 'manual review', 'failed', 'paid', 'rejected', 'cancelled']) {
    const entry = one(`Withdrawal ${status}`);
    expect(entry.after.html).toContain('Rs2,000.00 PKR');
    expect(entry.after.html).toContain('Bank transfer amount');
  }
  expect(one('Withdrawal approved').after.html).toContain('funds remain reserved until the bank transfer is completed');
  expect(one('Withdrawal manual review').after.html).toContain('funds remain reserved until this review is resolved');
  expect(one('Withdrawal failed').after.html).toContain('reservation was released');
  expect(one('Withdrawal paid').after.html).toContain('recorded as paid');
});

test('cancellation branches preserve exact source audience/fee/destination semantics', () => {
  expect(one('Wallet full refund — buyer').after.html).toContain('Rs1,200.00 PKR');
  expect(one('COD no refund — buyer').after.html).not.toContain('No payment was collected');
  expect(one('COD no refund — buyer', 'whatsapp').after.message).not.toContain('no refund is needed');
  expect(one('Card refund pending — buyer').after.html).toContain('Rs1,095.60 PKR');
  expect(one('Card refund pending — buyer').after.html).toContain('Processing fee: Rs104.40 PKR');
  expect(one('Card refund pending — seller').after.html).toContain('No action is required from you');
  expect(one('Card refund completed — buyer').after.html).toContain('bank may take additional time');
  expect(one('Card refund completed — no deduction — buyer').after.html).not.toContain('Processing fee');
  expect(one('Raast original refund requires review — buyer')).toMatchObject({ activity: 'exception' });
  expect(one('Raast original refund requires review — buyer').after.html).toContain('original raast account has not been confirmed');
  expect(one('Unknown original payment requires review — buyer').after.html).toContain('original payment method');
});

test('admin exception notices distinguish unsupported automatic refund from uncertain reconciliation', () => {
  expect(one('Admin Safepay refund not submitted').after.html).toContain('No automatic bank refund was submitted');
  expect(one('Admin Safepay refund outcome reconciliation').after.html).toContain('No duplicate refund was attempted');
  expect(one('Admin cancellation refund needs review').after.html).toContain('Refund amount to verify: Rs1,095.60 PKR');
});

test('billing operation and lifecycle text comes from actual source call sites', () => {
  expect(one('Safepay subscription trial started').after.subject).toBe('Your subscription introductory period has started');
  expect(one('Safepay subscription trial started').after.html).toContain('Amount due at activation: $0.00');
  expect(one('Safepay subscription updated').after.html).toContain('Amount paid: $25.65');
  expect(one('Safepay subscription payment failed').after.html).toContain('This attempt did not activate or extend your subscription');
  expect(one('Safepay cancel scheduled — payment already in progress').after.html).toContain('A payment already in progress may still complete');
  expect(one('Safepay downgrade cancelled').after.html).toContain('downgrade to Starter has been cancelled');
});

test('temporary billing previews preserve approved wording with only the time and amount substituted',()=>{
  for (const channel of ['email', 'whatsapp']) {
    for (const [plan, label, minutes] of [['starter', 'Starter', 10], ['elite', 'Elite', 15]]) {
      const preview = one(`Safepay temporary test — ${plan} introductory period`, channel).after;
      const normal = one('Safepay subscription trial started', channel).after;
      const expected = JSON.parse(JSON.stringify(normal).replaceAll('Rozare Elite + Meta Ads', `Rozare ${label}`).replaceAll('45-day', `${minutes}-minute`));
      expect(preview).toEqual(expected);
    }
    const normal = one('Safepay subscription updated', channel).after;
    const expected = JSON.parse(JSON.stringify(normal).replaceAll('Rozare Elite + Meta Ads', 'Rozare Starter').replaceAll('$25.65', '$1.00'));
    expect(one('Safepay temporary test — paid renewal', channel).after).toEqual(expected);
  }
});

test('return statuses, moderation safety and source-backed receipt channels are complete', () => {
  const statuses = require('../../services/returnPolicyService').RETURN_STATUS_LABELS;
  for (const [status, label] of Object.entries(statuses)) {
    if (['returned', 'cancelled_by_buyer'].includes(status)) continue;
    expect(one(`Buyer ${label.toLowerCase()}`).after.subject).toContain('RET-PREVIEW');
  }
  expect(one('Store created — pending').after.html).not.toContain('Atlas Aura');
  expect(one('Store created — blocked').after.html).not.toContain('Atlas Aura');
  expect(entries.some(entry => /content pending|checks delayed/.test(entry.name))).toBe(false);
  expect(one('Buyer COD confirmation').after.html).toContain('?intent=confirm');
  expect(one('Buyer COD confirmation').after.html).toContain('?intent=cancel');
  expect(one('Buyer COD confirmation', 'whatsapp').after.buttons.length).toBeGreaterThan(0);
  expect(one('Buyer COD confirmation', 'whatsapp').after.message).toContain('Sam');
  expect(one('Buyer COD confirmation', 'whatsapp').after.message).toContain('Travel Mug');
  expect(one('Safepay subdomain ownership receipt').after.html).toContain('reserved atlas-aura.rozare.com for your store through 2029-10-12');
});

test('HTML is styled, symbols are frozen and unsupported branches are explicitly documented', () => {
  for (const entry of entries.filter(item => item.channel === 'email')) {
    expect(entry.after.html).toMatch(/<!doctype html>/i);
    expect(entry.after.html).toContain('favicon-512.png');
  }
  expect(coverageMatrix).toHaveLength(13);
  expect(exclusions.join(' ')).toContain('No fake Old version');
  expect(exclusions.join(' ')).toContain('Business mutations');
});

test('repeat offline generation stays identical without accessing runtime storage or provider APIs', async () => {
  const repeated = await buildRuntimeNotificationGalleryEntries();
  expect(repeated).toEqual(entries);
});

test('retained billing helpers remain visible without claiming active Safepay eligibility', () => {
  expect(one('Retained invoice payment failed')).toMatchObject({ activity: 'legacy' });
  expect(one('Retained invoice payment failed').after.html).toContain('was unsuccessful');
  expect(one('Safepay subscription ending soon — standard')).toMatchObject({ activity: 'active' });
  expect(one('Retained downgrade scheduled — founder / bonus available').after.html).toContain('30% founder discount');
  expect(runtimeGalleryCounts(entries)).toEqual({ active: { email: 153, whatsapp: 145 }, legacy: { email: 16, whatsapp: 16 },
    exception: { email: 4, whatsapp: 4 }, reviewRequired: { email: 0, whatsapp: 0 }, sourceCallSites: 54 });
  expect(notificationCallSiteInventory()).toHaveLength(54);
});

test('renewal failure previews include all four retry days and the final day-7 cancellation warning', () => {
  for (const day of [1, 3, 5, 7]) for (const channel of ['email', 'whatsapp']) {
    const entry = one(`Safepay renewal failure — day ${day}`, channel);
    expect(JSON.stringify(entry.after)).toContain('Pakistan time');
    expect(JSON.stringify(entry.after)).toContain('Subscription');
  }
  expect(one('Safepay renewal failure — day 7').after.subject).toContain('cancels today');
  expect(one('Safepay ended — unpaid renewal').after.html).toContain('seven-day recovery period');
});

test('active previews use professional flow-accurate copy and exclude original-Raast refund exceptions', async () => {
  for (const entry of entries.filter(item => item.activity === 'active')) {
    expect(JSON.stringify(entry.after)).not.toMatch(/Prepare only your items|Store path:|frozen|persisted|immutable|optionGroups|Stripe/i);
  }
  expect(one('Store created — approved').after.html).toContain('https://atlas-aura.rozare.com/');
  expect(one('Verified-buyer store rating').after.html).toContain('https://atlas-aura.rozare.com/#store-reviews');
  expect(one('Verified-buyer store rating', 'whatsapp').after.message).not.toContain('https://rozare.com/store/');
  expect(one('Wallet debit').after.subject).toBe('Wallet payment completed');
  expect(one('Wallet debit balance adjustment').after.subject).toBe('Wallet balance updated');
  expect(one('Raast cancellation full Wallet refund — buyer').after.html).toContain('your Rozare Wallet');
  expect(one('Raast cancellation full Wallet refund — buyer').after.html).not.toContain('review by Rozare');
  expect(one('Multi-store cancellation full Wallet refund — buyer').after.html).not.toContain('Notebook');
  const all = await buildRuntimeNotificationGalleryEntries({ includeApp: true });
  expect(all.some(entry => entry.channel === 'inapp' && entry.name === 'Store content pending')).toBe(true);
  expect(all.some(entry => entry.channel === 'push' && entry.name === 'Wallet debit')).toBe(true);
  for (const entry of all.filter(item => ['inapp', 'push'].includes(item.channel))) {
    expect(entry.after.title).toBeTruthy(); expect(entry.after.message).toBeTruthy();
    expect(entry.after.message.length).toBeLessThanOrEqual(1000);
  }
});
