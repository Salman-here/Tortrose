'use strict';

// Runs real compiled methods with network and order effects stubbed out.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { captureRoute } = require('./check-lid-reply-routing');

async function checkMethod(source, deps) {
  let cases = 0;
  for (const number of ['155500000000000@lid', '155500000000000:2@LID']) {
    for (const selfInAuthState of [false, true]) {
      await assert.rejects(captureRoute(source, { number, selfInAuthState }, deps), /ROZARE_SELF_RECIPIENT_BLOCKED/);
      cases++;
    }
  }
  for (const jid of ['15550000000@s.whatsapp.net', '155500000000000@lid']) {
    await assert.rejects(captureRoute(source, { number: '15550000001@s.whatsapp.net', lookup: { exists: true, jid } }, deps), /ROZARE_SELF_RECIPIENT_BLOCKED/);
    cases++;
  }
  for (const number of ['15550000001@s.whatsapp.net', '155500000000001@lid']) {
    const result = await captureRoute(source, { number, lookup: { exists: true, jid: number } }, deps);
    assert.equal(result.sends[0][0], number); cases++;
  }
  const intentionalSelf = await captureRoute(source, { number: '+1 555 000 0000', lookup: { exists: true, jid: '15550000000@s.whatsapp.net' } }, deps);
  assert.equal(intentionalSelf.sends[0][0], '15550000000@s.whatsapp.net'); cases++;
  return cases;
}

function checkReceipts(body) {
  const source = '(' + body + ')', messages = [], forwarded = [], original = [];
  const method = new vm.Script(source).runInNewContext({ console: { info: line => messages.push(line) }, process: { env: { ROZARE_SKIP_MESSAGE_UPDATE_WORK: 'true' } } });
  const input = [0, 1, 2, 3, 4, 5].map(status => ({ key: { id: 'qa-receipt-' + status, fromMe: true, remoteJid: '15550000001@s.whatsapp.net' }, update: { status } }));
  input.push({ key: { id: 'inbound', fromMe: false }, update: { status: 3 } });
  const receiver = { sendDataWebhook: (event, data) => forwarded.push({ event, data }), messageHandle: { 'messages.update': (...args) => original.push(args) } };
  return Promise.resolve(method.call(receiver, { 'messages.update': input }, {})).then(() => {
    assert.equal(forwarded.length, 1); assert.equal(forwarded[0].data, input); assert.equal(original.length, 0);
    assert.equal(messages.length, 6); assert.ok(messages.every(line => !line.includes('15550000001')));
    assert.equal(JSON.parse(messages[0].split('[rozare:receipt] ')[1]).status, 0);
    return 8;
  });
}

async function main() {
  const runtimeRequire = createRequire('/evolution/package.json');
  const baileys = await import(pathToFileURL(runtimeRequire.resolve('baileys')).href), long = runtimeRequire('long');
  const entries = ['main.js', 'main.mjs', 'api/integrations/channel/whatsapp/whatsapp.baileys.service.js', 'api/integrations/channel/whatsapp/whatsapp.baileys.service.mjs'];
  let cases = 0;
  for (const entry of entries) {
    const source = fs.readFileSync('/evolution/dist/' + entry, 'utf8');
    const start = source.lastIndexOf('async sendMessageWithTyping('), end = source.indexOf('}async ', start + 27);
    assert.ok(start >= 0 && end > start);
    const method = source.slice(start, end + 1);
    assert.ok(method.includes('__rozareSelfRouteV1'));
    assert.ok(source.includes('__rozareReceiptAuditV1'));
    cases += await checkMethod(method, { baileys, long });
  }
  console.log(JSON.stringify({ qaReport: true, offline: true, runtimeEntries: entries.length,
    cases, networkSends: 0, explicitSelfLidBlocked: true, lookupSelfRedirectBlocked: true, intentionalSelfPhoneAllowed: true, recipientContentUnchanged: true }));
}

module.exports = { checkMethod, checkReceipts };
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ qaReport: true, code: error.code || 'SELF_GUARD_CHECK_FAILED', error: error.message })); process.exitCode = 1; });
