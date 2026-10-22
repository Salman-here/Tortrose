'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MARKER, ENTRIES, patchSource, patchDist } = require('../../../infra/evolution/patches/patch-baileys-lid-send');
const { captureRoute, checkMethod } = require('../../../infra/evolution/tests/check-lid-reply-routing');
const fixtures = path.resolve(__dirname, '../../../infra/evolution/tests/fixtures');
const fixtureNames = ['reply-route-main-js', 'reply-route-main-mjs', 'reply-route-component-js', 'reply-route-component-mjs'];
const originalMethod = name => fs.readFileSync(path.join(fixtures, name + '.txt'), 'utf8').trim();

describe.each(fixtureNames)('live gateway fixture %s', name => {
  const original = originalMethod(name), result = patchSource(original);
  test('recognizes both main entries and the old partial component patch, and safely re-runs', () => {
    expect(result.changed).toBe(true);
    expect(result.source).toContain(MARKER);
    expect(patchSource(result.source)).toEqual({ source: result.source, changed: false, alreadyPatched: true });
  });
  test('executes Confirm/Cancel, explicit/device/uppercase LIDs, normal phones and invalid targets', async () => {
    expect(await checkMethod(result.source)).toBe(12);
  });
  test('preserves a LID even when phone lookup would return another address', async () => {
    const input = { number: '155500000000001@lid', lookup: { exists: true, jid: '19999999999@s.whatsapp.net' } };
    const after = await captureRoute(result.source, input);
    expect(after.sends[0][0]).toBe(input.number);
    expect(after.lookups).toHaveLength(0);
  });
  test('ordinary phone recipient and validation retain their original behavior', async () => {
    const input = { number: '15550000001', lookup: { exists: true, jid: '15550000001@s.whatsapp.net' } };
    const before = await captureRoute(original, input), after = await captureRoute(result.source, input);
    expect(after.lookups).toEqual(before.lookups);
    expect(after.sends[0].slice(0, 2)).toEqual(before.sends[0].slice(0, 2));
    expect(after.result).toEqual(before.result);
  });
  test.each(['12000000000@g.us', 'status@broadcast'])('keeps the original group/broadcast behavior for %s', async number => {
    const input = { number, lookup: { exists: false, jid: number } };
    const before = await captureRoute(original, input), after = await captureRoute(result.source, input);
    expect(after.lookups).toEqual(before.lookups);
    expect(after.sends[0].slice(0, 2)).toEqual(before.sends[0].slice(0, 2));
  });
});

test('reproduces the actual main-entry misrouting before the correction', async () => {
  const before = await captureRoute(originalMethod('reply-route-main-js'), { number: '155500000000001@lid' });
  expect(before.sends[0][0]).toBe('19999999999@s.whatsapp.net');
});

describe('all-entry build safeguards', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'rozare-lid-routing-test-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  function populate() {
    ENTRIES.forEach((entry, index) => {
      const file = path.join(root, entry); fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, (entry.endsWith('.mjs') ? 'export default {' : 'module.exports={') + originalMethod(fixtureNames[index]) + '};');
    });
  }
  test('requires coverage of real main entries, not only components', () => {
    fs.writeFileSync(path.join(root, 'component.js'), 'module.exports={' + originalMethod('reply-route-component-js') + '};');
    expect(() => patchDist(root)).toThrow('Missing covered runtime entry: main.js');
  });
  test('check mode does not modify files', () => {
    populate(); const file = path.join(root, 'main.js'), before = fs.readFileSync(file, 'utf8');
    expect(patchDist(root, { check: true })).toMatchObject({ changed: 4, runtimeEntries: 4, checkOnly: true });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
  test('patches all entries, syntax-checks them, and is idempotent', () => {
    populate();
    expect(patchDist(root)).toMatchObject({ changed: 4, runtimeEntries: 4 });
    expect(patchDist(root)).toMatchObject({ changed: 0, alreadyPatched: 4 });
  });
  test('fails before any write if a bundle is unknown', () => {
    populate(); const file = path.join(root, 'main.js'), before = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(path.join(root, 'unknown.js'), 'async sendMessageWithTyping(){this.whatsappNumber({numbers:[]})}');
    expect(() => patchDist(root)).toThrow('Unrecognized Evolution routing build');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
  test('rejects duplicated and partially patched routes', () => {
    const source = originalMethod('reply-route-main-js');
    expect(() => patchSource(source + source)).toThrow('duplicate');
    expect(() => patchSource(patchSource(source).source + source)).toThrow('Mixed');
  });
});
