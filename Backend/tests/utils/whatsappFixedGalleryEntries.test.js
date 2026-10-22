'use strict';

// The preview must never load transport/controller modules, let alone send.
jest.mock('../../services/whatsapp/evolutionClient', () => { throw new Error('A preview loaded a live transport.'); });
jest.mock('../../services/whatsapp/sellerEvolutionClient', () => { throw new Error('A preview loaded a live transport.'); });
jest.mock('../../controllers/userWhatsappController', () => { throw new Error('A preview executed a controller.'); });
jest.mock('../../controllers/userController', () => { throw new Error('A preview executed a controller.'); });
jest.mock('../../controllers/sellerWhatsappController', () => { throw new Error('A preview executed a controller.'); });
jest.mock('../../services/whatsapp/webhookHandler', () => { throw new Error('A preview executed a webhook.'); });
jest.mock('../../services/whatsapp/whatsappAIChatService', () => { throw new Error('A preview executed the AI pipeline.'); });
jest.mock('axios', () => ({ get: jest.fn(() => { throw new Error('Unexpected preview network request.'); }),
  post: jest.fn(() => { throw new Error('Unexpected preview network request.'); }) }));

const fs = require('node:fs');
const path = require('node:path');
const { buildFixedWhatsAppGalleryEntries, auditFixedWhatsAppSendSites, BASELINE } = require('../../scripts/whatsappFixedGalleryEntries');

const entries = () => buildFixedWhatsAppGalleryEntries({ includeBefore: false });
const find = name => entries().find(entry => entry.name === name);

test('every direct WhatsApp send site has fixed-source coverage or an explicit transport/outbox classification', () => {
  const audit = auditFixedWhatsAppSendSites();
  expect(audit).toHaveLength(35);
  expect(audit.every(site => site.classification !== 'Unaccounted')).toBe(true);
  expect(new Set(audit.map(site => site.sourcePath)).size).toBe(7);
  expect(audit.filter(site => site.classification.startsWith('Shared text/chunk'))).toHaveLength(2);
  expect(audit.filter(site => site.classification.startsWith('Frozen outbox'))).toHaveLength(1);
  expect(audit.filter(site => site.classification.startsWith('Pure'))).toHaveLength(3);
});

test('fixed entries carry genuine source provenance and normalized render payloads', () => {
  const all = entries();
  expect(all).toHaveLength(78);
  expect(all.filter(entry => entry.activity === 'active')).toHaveLength(47);
  expect(all.filter(entry => entry.activity === 'legacy')).toHaveLength(31);
  for (const entry of all) {
    expect(entry.channel).toBe('whatsapp');
    expect(entry.sourcePath).toMatch(/^Backend\//);
    expect(Number.isInteger(entry.sourceLine) && entry.sourceLine > 0).toBe(true);
    expect(entry.after).toEqual({ message: expect.any(String), title: expect.any(String), footer: expect.any(String), buttons: expect.any(Array) });
    expect(fs.existsSync(path.resolve(__dirname, '../../..', entry.sourcePath))).toBe(true);
    expect(entry).not.toHaveProperty('before');
    expect(entry.sourceBaseline).toBeNull();
  }
});

test('OTP and interactive order previews are exact source expressions with dummy values', () => {
  expect(find('Buyer WhatsApp code').after.message).toContain('This code expires in 2 minutes.');
  expect(find('Seller WhatsApp code').after.message).toContain('*123456*');
  expect(find('Change seller WhatsApp number').after.message).toContain('confirm your new seller WhatsApp number');
  expect(find('COD order: confirm or cancel buttons').after.buttons).toEqual(['✅ Confirm order', '❌ Cancel order']);
  expect(find('COD order: interactive list').after.buttons).toEqual(['✅ Confirm order', '❌ Cancel order']);
  expect(find('COD order: confirm or cancel buttons').activity).toBe('legacy');
  expect(find('COD order: interactive list').activity).toBe('legacy');
  expect(find('COD order: secure confirmation link').activity).toBe('active');
  expect(find('COD order: secure confirmation link').after.message).toContain('/orders/confirm/preview-confirmation-token-');
  expect(find('COD order: secure confirmation link').after.buttons).toEqual([]);
  expect(find('Paid order information').after.message).toContain('Total paid: *Rs1,200.00 PKR*');
  expect(find('Reconfirm a cancelled COD order').after.buttons).toEqual(['✅ Yes, confirm again', '❌ No, keep cancelled']);
  expect(find('Legacy COD poll (not sent)').activity).toBe('legacy');
});

test('actual webhook branches include distinct email/account/status/block reasons and are not generic paraphrases', () => {
  expect(find('Email confirmation — cancellation guidance').after.message).toContain('email (sa••••@example.test)');
  expect(find('Later-stage order — cancellation or return guidance — delivered').after.message).toContain('*delivered*');
  expect(find('Cancellation unavailable in this message — paid order').after.message).toContain('review cancellation and refund options before shipment');
  expect(find('Cancellation after WhatsApp confirmation — reconfirmation — email').after.message).toContain('your email (sa••••@example.test) after confirming on WhatsApp.');
  expect(find('Legacy typed-reply hint').activity).toBe('legacy');
});

test('fixed AI-channel connection and failure messages are included without generated AI replies', () => {
  expect(find('Unlinked shopper connection instructions').after.message).toContain('Link your WhatsApp number');
  expect(find('Seller-assistant connection instructions — linked shopper').after.message).toContain('This assistant is for seller accounts.');
  expect(find('Hourly message limit').after.message).toContain('about 5 minutes');
  expect(find('Empty sanitized reply fallback').after.message).not.toMatch(/Done|I processed/);
  expect(find('Empty sanitized reply fallback').after.message).toContain('before retrying');
  expect(find('Processing failure fallback — credits unavailable').after.message).toContain('Rozare AI is temporarily unavailable');
  expect(find('Product image text fallback').after.message).toContain('https://rozare.com/preview-only-image.png');
  expect(entries().some(entry => entry.name === 'AI-generated reply')).toBe(false);
});

test('broadcast wrapper supports the actual linked and unlinked forms without inventing Wallet/admin payout messages', () => {
  expect(find('Administrator announcement wrapper — with action link').after.message).toContain('🔗 https://rozare.com/marketplace');
  expect(find('Administrator announcement wrapper — without action link').after.message).not.toContain('https://');
  expect(entries().some(entry => /Buyer Wallet (credit|liability|payment)|Admin withdrawal/.test(entry.name))).toBe(false);
  expect(require('axios').get).not.toHaveBeenCalled();
  expect(require('axios').post).not.toHaveBeenCalled();
});

test('real pinned copy alone supplies Old, while unavailable comparisons stay absent', () => {
  const all = buildFixedWhatsAppGalleryEntries();
  const sourceCopies = all.filter(entry => entry.before);
  expect(sourceCopies.length).toBeGreaterThan(20);
  for (const entry of sourceCopies) {
    expect(entry.sourceBaseline).toBe(BASELINE);
    expect(entry.comparison).toBe('Source snapshot');
    expect(entry.before.message).not.toMatch(/^Earlier:/);
  }
  expect(all.find(entry => entry.name === 'Email cancellation — reconfirmation').before).toBeUndefined();
});

test('coverage fails closed when another fixed send is added to an audited function', () => {
  const read = fs.readFileSync.bind(fs);
  const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
    const value = read(file, ...args);
    if (String(file).endsWith(`${path.sep}userWhatsappController.js`) && typeof value === 'string') {
      return value.replace('await evolution.sendText(digits, message);',
        "await evolution.sendText(digits, message); await evolution.sendText(digits, 'New fixed message');");
    }
    return value;
  });
  try { expect(() => entries()).toThrow('Fixed WhatsApp coverage changed'); }
  finally { spy.mockRestore(); }
});
