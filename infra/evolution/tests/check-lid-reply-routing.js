'use strict';

// Offline only: real compiled routing methods, with all sends and webhooks
// stubbed. Does not instantiate a socket, send a message, or change an order.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

async function captureRoute(source, { number, lookup = { exists: true, jid: '19999999999@s.whatsapp.net' }, lookupThrows = false,
  text = 'Hi QA Buyer,\n\nYour order *#ORD-ROUTING-QA* is confirmed.\n\nTrack your order: https://rozare.com/track-order' } = {}, deps = {}) {
  const isGroup = deps.baileys?.isJidGroup || (jid => String(jid).endsWith('@g.us'));
  const context = { Date, R: { ...(deps.baileys || {}), isJidGroup: isGroup }, console: { log() {} } };
  for (const match of source.matchAll(/if\(![\w$]+\.exists&&!([\w$]+)\([\w$]+\.jid\)/g)) context[match[1]] = isGroup;
  for (const match of source.matchAll(/([\w$]+)(\.default)?\.isLong/g)) {
    const long = deps.long || { isLong: () => false };
    context[match[1]] = match[2] ? { default: long } : long;
  }
  for (const match of source.matchAll(/throw new ([\w$]+)\(/g)) {
    if (match[1] !== 'Error') context[match[1]] = class extends Error { constructor() { super('Recipient validation rejected'); } };
  }
  const methods = new vm.Script('({' + source + '})').runInNewContext(context);
  const lookups = [], sends = [], webhooks = [], payload = { conversation: text };
  const receiver = {
    instance: { wuid: '15550000000@s.whatsapp.net' }, instanceId: 'qa-instance', localWebhook: { enabled: false },
    logger: { verbose() {}, error() {} }, client: {},
    whatsappNumber: async args => { lookups.push(args); if (lookupThrows) throw new Error('Phone lookup is unavailable'); return [lookup]; },
    sendMessage: async (...args) => { sends.push(args); return { key: { id: 'qa-no-network', remoteJid: args[0], fromMe: true }, message: { conversation: text }, messageTimestamp: 1792627200 }; },
    prepareMessage: message => message, sendDataWebhook: (...args) => webhooks.push(args),
    getGroupMetadataCache: async () => ({ participants: [], ephemeralDuration: 86400 }),
    findGroup: async () => ({ participants: [], ephemeralDuration: 86400 }),
    configService: { get: key => key === 'DATABASE' ? { SAVE_DATA: { NEW_MESSAGE: false } }
      : key === 'CACHE' ? { REDIS: { ENABLED: true }, LOCAL: { ENABLED: false } } : { ENABLED: false, ENABLE: false } },
  };
  const result = await methods.sendMessageWithTyping.call(receiver, number, payload, { delay: 0 });
  return { result, lookups, sends, webhooks, payload };
}

async function checkMethod(source, deps) {
  let count = 0;
  for (const number of ['155500000000001@lid', '155500000000001:2@lid', '155500000000001@LID']) {
    for (const text of ['Your order *#ORD-ROUTING-QA* is confirmed.', 'Order *#ORD-ROUTING-QA* has been cancelled.']) {
      const result = await captureRoute(source, { number, text, lookupThrows: true }, deps);
      assert.equal(result.lookups.length, 0);
      assert.equal(result.sends.length, 1);
      assert.equal(result.sends[0][0], number.toLowerCase());
      assert.equal(result.sends[0][1], result.payload);
      assert.equal(result.sends[0][1].conversation, text);
      count += 1;
    }
  }
  for (const number of ['15550000001', '15550000001@s.whatsapp.net', '+1 555 000 0001']) {
    const result = await captureRoute(source, { number, lookup: { exists: true, jid: '15550000001@s.whatsapp.net' } }, deps);
    assert.equal(result.lookups.length, 1);
    assert.equal(result.lookups[0].numbers[0], number);
    assert.equal(result.sends[0][0], '15550000001@s.whatsapp.net');
    count += 1;
  }
  for (const number of ['not-a-number@lid', '123@lid.example', '@lid']) {
    await assert.rejects(captureRoute(source, { number, lookup: { exists: false, jid: '15550000001@s.whatsapp.net' } }, deps), /Recipient validation rejected/);
    count += 1;
  }
  return count;
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
    assert.ok(method.includes('__rozareExplicitLidV2'));
    cases += await checkMethod(method, { baileys, long });
  }
  console.log(JSON.stringify({ qaReport: true, offline: true, realRuntimeLibrary: true, runtimeEntries: entries.length,
    cases, networkSends: 0, explicitLidPreserved: true, phoneLookupUnchanged: true, replyTextUnchanged: true }));
}

module.exports = { captureRoute, checkMethod };
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ qaReport: true, offline: true, code: error.code || 'ROUTING_CHECK_FAILED', error: error.message })); process.exitCode = 1; });
