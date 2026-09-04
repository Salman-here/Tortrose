import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sellerDashboard = readFileSync(
  new URL('../src/components/layout/SellerDashboard.jsx', import.meta.url),
  'utf8',
);
const aiChatPage = readFileSync(
  new URL('../src/pages/AIChatPage.jsx', import.meta.url),
  'utf8',
);

test('seller dashboard opens the same full-screen AI chat route used by buyers', () => {
  assert.match(sellerDashboard, /navigate\('\/ai-chat'\)/);
  assert.doesNotMatch(sellerDashboard, /ChatBotComponent|aiChatOpen/);
});

test('shared AI chat page passes the authenticated role into the common chat UI', () => {
  assert.match(aiChatPage, /dashboardRole=\{assistantRole\}/);
  assert.match(aiChatPage, /assistantRole === 'seller'/);
  assert.match(aiChatPage, /Create and manage products/);
});
