'use strict';

const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const lidPatch = require('../../../infra/evolution/patches/patch-baileys-lid-send');
const guard = require('../../../infra/evolution/patches/patch-self-recipient-guard');
const { captureRoute } = require('../../../infra/evolution/tests/check-lid-reply-routing');
const { checkMethod, checkReceipts } = require('../../../infra/evolution/tests/check-self-recipient-guard');
const fixtures = path.resolve(__dirname, '../../../infra/evolution/tests/fixtures');
const fixtureNames = ['reply-route-main-js', 'reply-route-main-mjs', 'reply-route-component-js', 'reply-route-component-mjs'];
const route = name => lidPatch.patchSource(fs.readFileSync(path.join(fixtures, name + '.txt'), 'utf8').trim()).source;
const updates = 'async function update(e,o){if(e["messages.update"]){let i=e["messages.update"];if(process.env.ROZARE_SKIP_MESSAGE_UPDATE_WORK==="true")this.sendDataWebhook("messages.update",i);else await this.messageHandle["messages.update"](i,o)}}';
const handler = 'const handlers={"messages.update":async(e,t)=>{if(process.env.ROZARE_SKIP_MESSAGE_UPDATE_WORK==="true"){this.sendDataWebhook("messages.update",e);return}this.logger.verbose(`Update messages ${JSON.stringify(e,void 0,2)}`);}};';

describe.each(fixtureNames)('self-recipient safety in %s', name => {
  const source = route(name), patched = guard.patchSource(source).source;
  test('blocks self-LIDs and lookup redirection, preserves valid peers and explicit self-PN', async () => {
    expect(await checkMethod(patched)).toBe(9);
  });
  test.each(['15550000001@s.whatsapp.net', '155500000000001@lid'])('leaves message text and destination untouched for %s', async number => {
    const input = { number, lookup: { exists: true, jid: number }, text: 'Original confirmation/cancellation reply' };
    const before = await captureRoute(source, input), after = await captureRoute(patched, input);
    expect(after.sends[0].slice(0, 2)).toEqual(before.sends[0].slice(0, 2));
  });
  test('is safe to re-run', () => {
    expect(guard.patchSource(patched)).toMatchObject({ source: patched, changed: false, alreadyPatched: true });
  });
});

test('receipt audit forwards original raw receipts and logs no recipient addresses', async () => {
  const result = guard.patchReceiptSource(updates + handler);
  expect(result.changed).toBe(true);
  expect(await checkReceipts(result.source.slice(0, result.source.indexOf('const handlers')))).toBe(8);
  expect(guard.patchReceiptSource(result.source)).toMatchObject({ changed: false, alreadyPatched: true });
});

describe('all-entry guard build checks', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'rozare-self-guard-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  function populate() {
    guard.ENTRIES.forEach((entry, index) => {
      const file = path.join(root, entry); fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, (entry.endsWith('.mjs') ? 'export default {' : 'module.exports={') + route(fixtureNames[index]) + '};' + updates + handler);
    });
  }
  test('requires every real runtime entry and both fast receipt paths', () => {
    expect(() => guard.patchDist(root)).toThrow('Missing guarded runtime entry');
    populate();
    expect(guard.patchDist(root, { check: true })).toMatchObject({ changed: 4, runtimeEntries: 4, checkOnly: true });
    expect(fs.readFileSync(path.join(root, 'main.js'), 'utf8')).not.toContain(guard.MARKER);
    expect(guard.patchDist(root)).toMatchObject({ changed: 4, runtimeEntries: 4 });
    expect(guard.patchDist(root)).toMatchObject({ changed: 0 });
  });
  test('does not partially write when an upstream shape is unknown', () => {
    populate(); const file = path.join(root, 'main.js'), original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(path.join(root, 'unknown.js'), 'module.exports={async sendMessageWithTyping(){}}');
    expect(() => guard.patchDist(root)).toThrow('Unrecognized self-route');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
  test('refuses a missing prerequisite or missing receipt forwarding branch', () => {
    expect(() => guard.patchSource(fs.readFileSync(path.join(fixtures, 'reply-route-main-js.txt'), 'utf8'))).toThrow('prerequisite');
    expect(() => guard.patchReceiptSource(route(fixtureNames[0]) + updates)).toThrow('Unrecognized fast receipt');
  });
});
