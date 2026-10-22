'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { MARKER, patchSource, patchDist, interactiveBizNode } = require('../../../infra/evolution/patches/patch-cod-reply-envelope');
const { buildOrderButtonsPayload } = require('../../services/whatsapp/messageBuilder');

const fixtures = path.resolve(__dirname, '../../../infra/evolution/tests/fixtures');
const copy = value => JSON.parse(JSON.stringify(value));
const payload = buildOrderButtonsPayload({
  orderId: 'ORD-COD-ENVELOPE-QA', currency: 'PKR',
  orderSummary: { subtotal: 200, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 200 },
  orderItems: [{ name: 'QA Mug', price: 100, lineSubtotal: 200, quantity: 2, storeName: 'QA Store' }],
  shippingInfo: { fullName: 'QA Buyer', city: 'Lahore' },
});
const packet = () => ({ viewOnceMessage: { message: { interactiveMessage: {
  body: { text: '*' + payload.title + '*\n\n' + payload.description + '\n' },
  footer: { text: payload.footer },
  nativeFlowMessage: { buttons: payload.buttons.map(button => ({
    name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: button.displayText, id: button.id }),
  })), messageParamsJson: JSON.stringify({ from: 'api', templateId: 'qa-template' }) },
} } } });

function harness(source, { missingId = false } = {}) {
  const generate = jest.fn((sender, message, options) => ({
    key: { id: missingId ? undefined : options.messageId || 'qa-generated-id' },
    message: { ...copy(message), messageContextInfo: { deviceListMetadataVersion: 2 } },
  }));
  const isGroup = jid => jid.endsWith('@g.us');
  const isPn = jid => jid.endsWith('@s.whatsapp.net');
  const methods = new vm.Script('({' + source + '})').runInNewContext({
    R: { generateWAMessageFromContent: generate, isJidGroup: isGroup, isPnUser: isPn },
    z: { isArray: Array.isArray }, Mc: generate, Te: isGroup, Nc: isPn, Gu: Array.isArray,
  });
  const receiver = { instance: { wuid: '15550000000@s.whatsapp.net' }, client: {
    relayMessage: jest.fn(async (_sender, _body, options) => options.messageId || 'qa-legacy-id'),
    sendMessage: jest.fn(async () => ({ key: { id: 'qa-normal-id' } })),
  } };
  return { generate, receiver, send: (...args) => methods.sendMessage.call(receiver, ...args) };
}

describe.each(['js', 'mjs'])('actual Oracle Evolution 2.3.7 %s reply relay', ext => {
  const original = fs.readFileSync(path.join(fixtures, 'reply-relay-2.3.7.' + ext + '.txt'), 'utf8').trim();
  const patched = patchSource(original);

  test('matches the deployed build and can be applied only once', () => {
    expect(patched.changed).toBe(true);
    expect(patched.source).toContain(MARKER);
    expect(patchSource(patched.source)).toEqual({ source: patched.source, changed: false, alreadyPatched: true });
  });

  test.each(['15550000001@s.whatsapp.net', '15550000001@lid'])('preserves the exact original COD message and both reply actions for %s', async sender => {
    const h = harness(patched.source), message = packet(), frozen = copy(message);
    const result = await h.send(sender, message);
    const [target, sent, options] = h.receiver.client.relayMessage.mock.calls[0];
    expect(target).toBe(sender);
    expect(sent.viewOnceMessage).toBeUndefined();
    expect(sent.interactiveMessage).toEqual(frozen.viewOnceMessage.message.interactiveMessage);
    expect(sent.interactiveMessage.body.text).toContain('Rs200.00 PKR');
    expect(sent.interactiveMessage.nativeFlowMessage.buttons.map(button => JSON.parse(button.buttonParamsJson)))
      .toEqual(payload.buttons.map(button => ({ display_text: button.displayText, id: button.id })));
    expect(options.additionalNodes).toEqual([interactiveBizNode()]);
    expect(options.messageId).toBe('qa-generated-id');
    expect(result.key.id).toBe(options.messageId);
    expect(sent.messageContextInfo).toEqual({ deviceListMetadataVersion: 2 });
    expect(message).toEqual(frozen);
    expect(h.receiver.client.sendMessage).not.toHaveBeenCalled();
    expect(h.receiver.client.relayMessage).toHaveBeenCalledTimes(1);
  });

  test('preserves an explicitly supplied message id and quote', async () => {
    const h = harness(patched.source), quoted = { key: { id: 'qa-quoted-id' } };
    const result = await h.send('15550000001@s.whatsapp.net', packet(), undefined, undefined, quoted, 'qa-idempotent-id');
    expect(h.generate.mock.calls[0][2]).toMatchObject({ quoted, messageId: 'qa-idempotent-id' });
    expect(h.receiver.client.relayMessage.mock.calls[0][2].messageId).toBe('qa-idempotent-id');
    expect(result.key.id).toBe('qa-idempotent-id');
  });

  test('never sends if a reply id cannot be generated', async () => {
    const h = harness(patched.source, { missingId: true });
    await expect(h.send('15550000001@s.whatsapp.net', packet())).rejects.toThrow('message id was not generated');
    expect(h.receiver.client.relayMessage).not.toHaveBeenCalled();
  });

  test.each(['cta_url', 'cta_copy', 'cta_call', 'payment_info', 'single_select', 'unknown'])('%s messages remain on their original path', async name => {
    const message = packet();
    message.viewOnceMessage.message.interactiveMessage.nativeFlowMessage.buttons[0].name = name;
    const before = harness(original), after = harness(patched.source);
    await before.send('15550000001@s.whatsapp.net', copy(message));
    await after.send('15550000001@s.whatsapp.net', copy(message));
    expect(after.receiver.client.relayMessage.mock.calls).toEqual(before.receiver.client.relayMessage.mock.calls);
    expect(after.generate.mock.calls[0].slice(0, 2)).toEqual(before.generate.mock.calls[0].slice(0, 2));
  });

  test('empty interactive buttons keep the original behavior', async () => {
    const message = packet(); message.viewOnceMessage.message.interactiveMessage.nativeFlowMessage.buttons = [];
    const h = harness(patched.source);
    await h.send('15550000001@s.whatsapp.net', message);
    expect(h.receiver.client.relayMessage.mock.calls[0][1]).toEqual(message);
    expect(h.receiver.client.relayMessage.mock.calls[0][2].additionalNodes).toBeUndefined();
  });

  test.each([{ conversation: 'An unchanged paid-order notification' }, { audio: { url: 'fixture' } },
    { poll: { name: 'fixture' } }, { sticker: { url: 'fixture' } },
    { listMessage: { title: 'The unchanged existing list fallback', listType: 2 } }])('does not change other outbound messages: %j', async message => {
    const before = harness(original), after = harness(patched.source);
    await before.send('15550000001@s.whatsapp.net', copy(message));
    await after.send('15550000001@s.whatsapp.net', copy(message));
    expect(after.receiver.client.sendMessage.mock.calls).toEqual(before.receiver.client.sendMessage.mock.calls);
    expect(after.receiver.client.relayMessage).not.toHaveBeenCalled();
  });
});

describe('gateway patch build safeguards', () => {
  const original = fs.readFileSync(path.join(fixtures, 'reply-relay-2.3.7.js.txt'), 'utf8').trim();
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'rozare-reply-envelope-test-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('rejects duplicate, unknown and partially patched relay builds', () => {
    expect(() => patchSource(original + original)).toThrow('duplicate');
    expect(() => patchSource('async buttonMessage(){this.client.relayMessage();return x.viewOnceMessage}')).toThrow('Unrecognized');
    expect(() => patchSource(patchSource(original).source + original)).toThrow('Mixed');
  });

  test('check-only mode never modifies a file', () => {
    const file = path.join(root, 'bundle.js'), source = 'module.exports={' + original + '};';
    fs.writeFileSync(file, source);
    expect(patchDist(root, { check: true })).toMatchObject({ targets: 1, changed: 1, checkOnly: true });
    expect(fs.readFileSync(file, 'utf8')).toBe(source);
  });

  test('validates all bundles before any modification', () => {
    const file = path.join(root, 'a.js'), source = 'module.exports={' + original + '};';
    fs.writeFileSync(file, source);
    fs.writeFileSync(path.join(root, 'b.js'), 'async buttonMessage(){this.client.relayMessage();return x.viewOnceMessage}');
    expect(() => patchDist(root)).toThrow('Unrecognized');
    expect(fs.readFileSync(file, 'utf8')).toBe(source);
  });

  test('applies and syntax-checks both compiled formats, then safely re-runs', () => {
    fs.writeFileSync(path.join(root, 'bundle.js'), 'module.exports={' + original + '};');
    const esm = fs.readFileSync(path.join(fixtures, 'reply-relay-2.3.7.mjs.txt'), 'utf8').trim();
    fs.writeFileSync(path.join(root, 'bundle.mjs'), 'export default {' + esm + '};');
    expect(patchDist(root)).toMatchObject({ targets: 2, changed: 2, alreadyPatched: 0 });
    expect(patchDist(root)).toMatchObject({ targets: 2, changed: 0, alreadyPatched: 2 });
  });

  test('refuses a build with no recognized relay', () => {
    fs.writeFileSync(path.join(root, 'bundle.js'), 'module.exports={};');
    expect(() => patchDist(root)).toThrow('No compatible');
  });
});
