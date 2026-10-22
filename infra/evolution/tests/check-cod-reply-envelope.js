'use strict';

// Offline release check. Uses the real installed Baileys encoder but stubs
// BOTH network-send methods. Does not instantiate a socket or contact anyone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

async function main() {
  const runtimeRequire = createRequire('/evolution/package.json');
  const baileys = await import(pathToFileURL(runtimeRequire.resolve('baileys')).href);
  const template = {
    body: { text: '*QA COD order*\n\nQA Mug × 2\n💰 Total: *Rs200.00 PKR*\n\nReview the details, then choose Confirm order or Cancel order below.\n' },
    footer: { text: 'Rozare · Tap a button to decide' },
    nativeFlowMessage: { buttons: [
      { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '✅ Confirm order', id: 'confirm_ORD-GATEWAY-QA' }) },
      { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '❌ Cancel order', id: 'cancel_ORD-GATEWAY-QA' }) },
    ], messageParamsJson: JSON.stringify({ from: 'api', templateId: 'qa-no-send' }) },
  };
  let checked = 0;
  for (const ext of ['js', 'mjs']) {
    const source = fs.readFileSync('/evolution/dist/api/integrations/channel/whatsapp/whatsapp.baileys.service.' + ext, 'utf8');
    const index = source.lastIndexOf('async sendMessage(');
    assert.ok(index > 0);
    const end = source.indexOf('}async ', index + 18);
    const method = source.slice(index, end + 1);
    assert.ok(method.includes('__rozareCodReplyEnvelopeV1'));
    const context = {
      R: baileys, z: { isArray: Array.isArray },
      Te: baileys.isJidGroup, Mc: baileys.generateWAMessageFromContent,
      Nc: baileys.isPnUser, Gu: Array.isArray,
    };
    const service = new vm.Script('({' + method + '})').runInNewContext(context);
    for (const sender of ['15550000001@s.whatsapp.net', '15550000001@lid']) {
      const calls = [];
      const receiver = { instance: { wuid: '15550000000@s.whatsapp.net' }, client: {
        relayMessage: async (jid, message, options) => { calls.push({ jid, message, options }); return options.messageId; },
        sendMessage: async () => { throw new Error('Unexpected normal send path'); },
      } };
      const message = { viewOnceMessage: { message: { interactiveMessage: JSON.parse(JSON.stringify(template)) } } };
      const result = await service.sendMessage.call(receiver, sender, message);
      assert.equal(calls.length, 1);
      const call = calls[0];
      assert.equal(call.jid, sender);
      assert.ok(call.options.messageId);
      assert.equal(call.options.messageId, result.key.id);
      // Protobuf's prototype exposes unset message fields as null. It must
      // not be an OWN field in the encoded reply envelope.
      assert.equal(Object.prototype.hasOwnProperty.call(call.message, 'viewOnceMessage'), false);
      assert.equal(call.message.interactiveMessage.body.text, template.body.text);
      assert.equal(call.message.interactiveMessage.footer.text, template.footer.text);
      assert.equal(JSON.stringify(call.message.interactiveMessage.nativeFlowMessage.buttons), JSON.stringify(template.nativeFlowMessage.buttons));
      assert.equal(call.options.additionalNodes[0].content[0].content[0].attrs.name, 'mixed');
      const decoded = baileys.proto.Message.decode(baileys.proto.Message.encode(call.message).finish());
      assert.equal(decoded.interactiveMessage.body.text, template.body.text);
      assert.equal(decoded.interactiveMessage.nativeFlowMessage.buttons.length, 2);
      for (let i = 0; i < 2; i++) {
        assert.equal(decoded.interactiveMessage.nativeFlowMessage.buttons[i].buttonParamsJson, template.nativeFlowMessage.buttons[i].buttonParamsJson);
      }
      checked += 1;
    }
  }
  console.log(JSON.stringify({ qaReport: true, offline: true, realBaileysEncoder: true, cases: checked, networkSends: 0, exactContentPreserved: true }));
}

main().catch(error => { console.error(JSON.stringify({ qaReport: true, offline: true, code: error.code || 'ENCODER_CHECK_FAILED', error: error.message })); process.exitCode = 1; });
