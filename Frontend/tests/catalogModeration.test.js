import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('seller web and mobile cards distinguish review from violations and show the saved reason', () => {
  const web = read('../src/components/layout/ProductCard.jsx');
  assert.match(web, /isPending \? 'Under review' : 'Blocked'/);
  assert.match(web, /\{blockedReason\}/);
  const mobile = read('../../MobileApp/src/screens/shared/ProductManagementScreen.js');
  assert.match(mobile, /moderationStatus === 'pending' \? 'Under review'/);
  assert.match(mobile, /getProductModerationReason/);
});
test('owner pollers reject obsolete revisions and stop after unmount in both clients', () => {
  for (const path of ['../src/hooks/useProductModerationUpdates.js', '../../MobileApp/src/hooks/useProductModerationUpdates.js']) {
    const source = read(path);
    assert.match(source, /status\.moderationRevision === product\.moderationRevision/);
    assert.match(source, /controller\.abort\(\)/); assert.match(source, /clearInterval\(timer\)/);
    assert.match(source, /product\.moderationStatus === 'pending'/);
  }
});
test('store notices remain separate from billing blocks and explain automatic correction/resubmission', () => {
  for (const path of ['../src/components/common/StoreModerationNotice.jsx', '../../MobileApp/src/components/common/StoreModerationNotice.js']) {
    const source = read(path);
    assert.match(source, /Store under review/); assert.match(source, /Store content blocked/);
    assert.match(source, /submit it for automatic checks again/);
    assert.match(source, /updated\?\.moderationRevision === revision/);
    assert.doesNotMatch(source, /subscription.*reactivate/i);
  }
});
test('both AI chat surfaces record a pending result as saved, not as published', () => {
  for (const path of ['../src/components/common/ChatBot.jsx', '../../MobileApp/src/components/ChatBot.js']) {
    const source = read(path); assert.match(source, /result\.pending/);
    assert.match(source, /under review|automatic.*checks|automatic.*review/i);
  }
});
