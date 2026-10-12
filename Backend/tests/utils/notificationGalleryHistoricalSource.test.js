'use strict';

const { BASELINE, comparisonKey, verifiedRevision, parseHistoricalCapture,
  validateHistoricalEntries, mergeHistoricalComparisons, readHistoricalSourceEntries } = require('../../scripts/notificationGalleryHistoricalSource');

const entry = (overrides = {}) => ({
  channel: 'email', name: 'Order confirmed — buyer', audienceRole: 'buyer', eventType: 'order.confirmed',
  sourcePath: 'Backend/services/financialNotificationOutboxService.js', sourceLine: 20,
  after: { subject: 'Your order is confirmed', html: '<p>Current source copy</p>' }, ...overrides,
});

test('historical identity and provenance require exact named source previews', () => {
  expect(comparisonKey(entry())).toBe('email:Order confirmed — buyer');
  expect(() => comparisonKey(entry({ channel: 'ai' }))).toThrow(/identity/);
  expect(() => validateHistoricalEntries([entry(), entry()])).toThrow(/Duplicate/);
  expect(() => validateHistoricalEntries([entry({ sourcePath: 'Backend/../private.js' })])).toThrow(/provenance/);
  expect(() => validateHistoricalEntries([entry({ after: { subject: 'Old', html: '' } })])).toThrow(/empty/);
  expect(() => validateHistoricalEntries([entry({ channel: 'whatsapp', after: { message: '' } })])).toThrow(/empty/);
});

test('a source-rendered old snapshot is attached only to the exact audience and source', () => {
  const old = entry({ sourceLine: 14, after: { subject: 'Old order notice', html: '<p>Old source copy</p>' } });
  const result = mergeHistoricalComparisons([entry()], [old]);
  expect(result[0]).toMatchObject({ before: old.after, sourceBaseline: BASELINE,
    historicalSourceLine: 14, historicalSourcePath: old.sourcePath, changed: true });
  expect(result.historicalCoverage).toMatchObject({ recovered: 1, unavailable: 0, preserved: 0 });
  for (const mismatch of [{ sourcePath: 'Backend/services/other.js' }, { audienceRole: 'seller' }, { eventType: 'order.cancelled' }]) {
    const mismatchResult = mergeHistoricalComparisons([entry(mismatch)], [old]);
    expect(mismatchResult[0]).not.toHaveProperty('before');
    expect(mismatchResult.historicalCoverage.unavailable).toBe(1);
  }
});

test('existing verified comparisons are preserved and new variants never borrow another old message', () => {
  const previous = { subject: 'Earlier account notice', html: '<p>Actual earlier snapshot</p>' };
  const existing = entry({ before: previous, sourceBaseline: 'e7169e0577ac8b49b2ece10cccdf4247012a06bc' });
  const newEntry = entry({ name: 'New card refund option' });
  const result = mergeHistoricalComparisons([existing, newEntry], [entry()]);
  expect(result[0].before).toBe(previous);
  expect(result[0].sourceBaseline).toBe(existing.sourceBaseline);
  expect(result[1]).not.toHaveProperty('before');
  expect(result[1].comparison).toBe('No verified old version');
  expect(result.historicalCoverage).toMatchObject({ recovered: 0, preserved: 1, unavailable: 1,
    missing: ['email:New card refund option'] });
});

test('pinned-process output cannot silently render current source or the new email wrapper as Old', () => {
  const capture = { revision: BASELINE, sourceModes: { runtime: BASELINE, whatsapp: BASELINE, oldEmail: true }, entries: [entry()] };
  expect(parseHistoricalCapture(JSON.stringify(capture))).toHaveLength(1);
  expect(() => parseHistoricalCapture('console log instead of JSON')).toThrow(/JSON/);
  expect(() => parseHistoricalCapture(JSON.stringify({ ...capture, sourceModes: { ...capture.sourceModes, runtime: '' } }))).toThrow(/pinned source/);
  expect(() => parseHistoricalCapture(JSON.stringify({ ...capture, sourceModes: { ...capture.sourceModes, oldEmail: false } }))).toThrow(/original email/);
});

test('Git baseline is an exact available commit, not a floating branch or shell expression', () => {
  expect(verifiedRevision(BASELINE)).toBe(BASELINE);
  for (const unsafe of ['HEAD', 'a665fa0f', '; whoami', 'A'.repeat(40)]) {
    expect(() => verifiedRevision(unsafe)).toThrow(/pinned Git commit/);
  }
});

test('actual historical captures remain source-backed and include raw email presentation plus app notices', async () => {
  const old = await readHistoricalSourceEntries();
  expect(old.filter(item => item.channel === 'email').length).toBeGreaterThan(100);
  expect(old.some(item => item.channel === 'inapp')).toBe(true);
  expect(old.some(item => item.channel === 'push')).toBe(true);
  expect(old.find(item => item.channel === 'whatsapp' && item.name === 'Buyer decision acknowledgement — confirmed').after.message)
    .toContain('Awesome, Sam!');
  expect(old.find(item => item.channel === 'email' && item.name.includes('Raast original refund requires review')).after.html)
    .not.toContain('notification-body');
}, 60000);
