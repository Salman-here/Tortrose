'use strict';

const vm = require('node:vm');
const { renderGallery } = require('../../scripts/notificationGalleryShell');
const { buildWhatsAppGalleryEntries } = require('../../scripts/whatsappGalleryEntries');
const { oldEmailTemplateByName } = require('../../scripts/previousNotificationGallery');

const element = () => {
  const classes = new Set();
  return {
    hidden: false, value: '', textContent: '', children: [], listeners: {}, attributes: {},
    classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } },
    addEventListener(event, callback) { this.listeners[event] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
    replaceChildren() { this.children = []; },
    append(child) { this.children.push(child); },
  };
};

test('the local gallery switches channel, old/new copy, and device without duplicating list entries', () => {
  const whatsapp = buildWhatsAppGalleryEntries().map(entry => {
    const { message, title, footer, buttons, ...rest } = entry;
    return { ...rest, comparison: 'Source snapshot', changed: true,
      before: { message: `Earlier: ${message}`, title, footer, buttons },
      after: { message, title, footer, buttons } };
  });
  const html = renderGallery([
    { channel: 'email', group: 'Account', name: 'Buyer code', kind: 'Actual template', comparison: 'Source snapshot', changed: true,
      before: { subject: 'Old verification', html: '<h1>Old buyer code</h1>' },
      after: { subject: 'New verification', html: '<h1>New buyer code</h1>' } },
    ...whatsapp,
  ], 1);
  const serialized = html.match(/<script id="preview-data" type="application\/json">([\s\S]*?)<\/script>/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  expect(serialized && script).toBeTruthy();
  const entries = JSON.parse(serialized[1]);
  expect(entries).toHaveLength(1 + whatsapp.length);
  expect(whatsapp[0].after.buttons).toEqual(['✅ Confirm order', '❌ Cancel order']);
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  get('preview-data').textContent = serialized[1];
  const buttons = entries.map((_, index) => ({ ...element(), dataset: { index: String(index) } }));
  const document = {
    getElementById: get,
    querySelectorAll: selector => selector === '.template' ? buttons : [],
    createElement: tagName => ({ ...element(), tagName }),
    createTextNode: textContent => ({ textContent }),
  };

  vm.runInNewContext(script[1], { document });
  expect(get('preview').srcdoc).toContain('New buyer code');
  expect(get('count').textContent).toBe('1 of 1 email templates · active definitions');
  get('oldVersion').listeners.click();
  expect(get('preview').srcdoc).toContain('Old buyer code');
  expect(get('title').textContent).toBe('Buyer code');
  expect(buttons.filter(button => !button.hidden)).toHaveLength(1);
  get('newVersion').listeners.click();
  expect(get('preview').srcdoc).toContain('New buyer code');
  get('whatsappTab').listeners.click();
  expect(get('whatsappPane').hidden).toBe(false);
  expect(get('emailPane').hidden).toBe(true);
  expect(get('waActions').children.map(row => row.textContent)).toEqual(['✅ Confirm order', '❌ Cancel order']);
  expect(get('waMessage').children.map(child => child.textContent).join('')).toContain('cash on delivery order');
  get('oldVersion').listeners.click();
  expect(get('waMessage').children.map(child => child.textContent).join('')).toContain('Earlier:');
  expect(get('waActions').children).toHaveLength(2);
  get('newVersion').listeners.click();
  expect(get('waMessage').children.map(child => child.textContent).join('')).not.toContain('Earlier:');
  expect(get('count').textContent).toBe(`${whatsapp.length} of ${whatsapp.length} whatsapp templates · active definitions`);

  get('search').value = 'wallet';
  get('search').listeners.input();
  const filtered = buttons.filter(button => !button.hidden);
  expect(filtered.length).toBeGreaterThan(1);
  expect(get('count').textContent).toMatch(/^\d+ of \d+ whatsapp templates · active definitions$/);
  expect(get('title').textContent.toLowerCase()).toContain('wallet');
  get('search').value = 'no-such-template';
  get('search').listeners.input();
  expect(get('title').textContent).toBe('No matching templates');
  get('search').value = '';
  get('search').listeners.input();
  expect(get('whatsappPane').hidden).toBe(false);
  get('phone').listeners.click();
  expect(get('waDevice').classList.contains('phone')).toBe(true);
  get('oldVersion').listeners.click();
  get('emailTab').listeners.click();
  expect(get('emailPane').hidden).toBe(false);
  expect(get('preview').srcdoc).toContain('Old buyer code');
  get('newVersion').listeners.click();
  expect(get('preview').srcdoc).toContain('New buyer code');
});

test('the pinned old account template really differs from the revised seller wording', () => {
  const sampleOrder = { orderId: 'ORD-PREVIEW', currency: 'PKR', paymentMethod: 'safepay',
    orderItems: [{ name: 'Mug', price: 1000, lineSubtotal: 1000, quantity: 1 }],
    orderSummary: { subtotal: 1000, shippingCost: 200, tax: 0, couponDiscount: 0, totalAmount: 1200 },
    shippingInfo: { fullName: 'Sam', address: 'Example Street', city: 'Example City', state: 'Example State', postalCode: '12345', country: 'Example Country' } };
  const previous = oldEmailTemplateByName(sampleOrder);
  expect(previous.size).toBe(22);
  expect(previous.get('Seller signup code').html).toContain('worldwide');
  expect(previous.get('Buyer signup code').html).toContain('Verify Your Email');
});

test('source-only versions, retained references and review-required definitions are labelled honestly', () => {
  const entries = [
    { channel: 'email', group: 'Account', name: 'Current source', kind: 'Current source template', activity: 'active',
      after: { subject: 'Preview subject', html: '<p>Current</p>' } },
    { channel: 'email', group: 'Reference', name: 'Retained source', kind: 'Retained source', activity: 'legacy',
      before: { subject: 'Old', html: '<p>Old</p>' }, after: { subject: 'Retained', html: '<p>Retained</p>' } },
    { channel: 'email', group: 'Review', name: 'Needs review', kind: 'Review required', activity: 'review-required',
      after: { subject: 'Review', html: '<p>Review</p>' } },
    { channel: 'whatsapp', group: 'Messages', name: 'Fixed reply', kind: 'Current source template', activity: 'active',
      after: { message: 'Dummy fixed reply', buttons: [] } },
  ];
  const html = renderGallery(entries, 3);
  const serialized = html.match(/<script id="preview-data" type="application\/json">([\s\S]*?)<\/script>/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  get('preview-data').textContent = serialized[1];
  const buttons = entries.map((_, index) => ({ ...element(), dataset: { index: String(index) } }));
  const document = { getElementById: get, querySelectorAll: () => buttons,
    createElement: tagName => ({ ...element(), tagName }), createTextNode: textContent => ({ textContent }) };
  vm.runInNewContext(script[1], { document });
  expect(buttons.filter(button => !button.hidden)).toHaveLength(1);
  expect(get('oldVersion').disabled).toBe(true);
  get('oldVersion').listeners.click();
  expect(get('preview').srcdoc).toContain('Current');
  get('allMessages').listeners.click();
  expect(buttons.filter(button => !button.hidden)).toHaveLength(3);
  buttons[1].listeners.click();
  expect(get('oldVersion').disabled).toBe(false);
  expect(get('meta').textContent).toContain('Retained code');
  get('oldVersion').listeners.click();
  expect(get('preview').srcdoc).toContain('Old');
  buttons[2].listeners.click();
  expect(get('meta').textContent).toContain('needs runtime review');
  expect(get('preview').srcdoc).toContain('Review');
  expect(get('oldVersion').disabled).toBe(true);
  expect(html).toContain('<iframe sandbox=""');
  expect(html).not.toContain('Old representative copy');
  expect(html).not.toContain('Representative before/after');
});

test('app/push previews filter buyer and seller audiences and keep exceptions out of active messages', () => {
  const entries = [
    { channel: 'email', name: 'Buyer email', group: 'Orders', audienceRole: 'buyer', activity: 'active', after: { subject: 'Order', html: '<p>Order</p>' } },
    { channel: 'inapp', name: 'Buyer update', group: 'Orders', audienceRole: 'buyer', activity: 'active',
      before: { title: 'Old order update', message: 'Old body' }, after: { title: 'Your order', message: 'Refund amount: Rs100.\nProcessing fee: Rs0.' } },
    { channel: 'inapp', name: 'Seller update', group: 'Orders', audienceRole: 'seller', activity: 'active', after: { title: 'Seller order', message: 'Review the order.' } },
    { channel: 'inapp', name: 'Raast original-account review', group: 'Reference', audienceRole: 'buyer', activity: 'exception', after: { title: 'Review', message: 'A review reference.' } },
    { channel: 'push', name: 'Buyer push', group: 'Orders', audienceRole: 'buyer', activity: 'active', after: { title: 'Order update', message: 'Your order was marked delivered.' } },
  ];
  const html = renderGallery(entries, 1);
  const serialized = html.match(/<script id="preview-data" type="application\/json">([\s\S]*?)<\/script>/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  get('preview-data').textContent = serialized[1];
  const buttons = entries.map((_, index) => ({ ...element(), dataset: { index: String(index) } }));
  const document = { getElementById: get, querySelectorAll: () => buttons,
    createElement: tagName => ({ ...element(), tagName }), createTextNode: textContent => ({ textContent }) };
  vm.runInNewContext(script[1], { document });
  get('inappTab').listeners.click();
  expect(get('waDevice').classList.contains('app-preview')).toBe(true);
  expect(get('waMessage').textContent).toContain('Processing fee: Rs0.');
  expect(buttons.filter(button => !button.hidden)).toHaveLength(2);
  expect(buttons[3].hidden).toBe(true);
  get('oldVersion').listeners.click();
  expect(get('waMessage').textContent).toBe('Old body');
  get('audience').value = 'seller'; get('audience').listeners.change();
  expect(get('title').textContent).toBe('Seller update');
  expect(buttons.filter(button => !button.hidden)).toHaveLength(1);
  get('pushTab').listeners.click();
  expect(get('title').textContent).toBe('No matching templates');
  get('audience').value = 'buyer'; get('audience').listeners.change();
  expect(get('waMessage').textContent).toBe('Your order was marked delivered.');
  get('inappTab').listeners.click(); get('allMessages').listeners.click(); buttons[3].listeners.click();
  expect(get('meta').textContent).toContain('Exception reference — not the normal flow');
  expect(html).toContain('id="inappTab"'); expect(html).toContain('id="pushTab"');
});
