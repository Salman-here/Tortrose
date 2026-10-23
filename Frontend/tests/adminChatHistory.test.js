import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { chatKey, inspectAdminChatList, inspectAdminChatTranscript, safeChatAttachment } from '../src/utils/adminChatHistory.js';
const user = { id: '64b000000000000000000001', name: 'QA shopper', email: 'qa@example.test', role: 'user' };
const conversation = { id: '64b000000000000000000002', user, title: 'Question', source: 'whatsapp' };

test('admin chat payloads are bounded and selected transcripts must match both account and conversation', () => {
  const list = { conversations: [conversation], pagination: { page: 1, limit: 20, total: 1, hasMore: false } };
  assert.equal(inspectAdminChatList(list), list);
  assert.throws(() => inspectAdminChatList({ ...list, conversations: Array(51).fill(conversation) }));
  assert.throws(() => inspectAdminChatList({ ...list, conversations: [{ ...conversation, source: 'invented' }] }));
  const transcript = { conversation, messages: [{ id: 'message', role: 'assistant', content: 'Saved reply' }], pagination: { page: 1, total: 1, hasOlder: false } };
  assert.equal(inspectAdminChatTranscript(transcript, chatKey(conversation)), transcript);
  assert.throws(() => inspectAdminChatTranscript(transcript, 'another-owner:' + conversation.id));
  assert.throws(() => inspectAdminChatTranscript({ ...transcript, messages: [{ id: 'system', role: 'system', content: 'Private prompt' }] }, chatKey(conversation)));
});

test('attachments cannot execute code or expose embedded authentication', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,private', 'file:///private', 'https://user:password@example.test/p.png', 'https://example.test/photo?token=private']) assert.equal(safeChatAttachment({ url }), null);
  assert.deepEqual(safeChatAttachment({ url: 'https://images.example.test/photo.png', name: 'Photo' }), { url: 'https://images.example.test/photo.png', name: 'Photo' });
});

test('the admin viewer uses guarded routes and read-only APIs, with request cancellation and no HTML execution', () => {
  const source = readFileSync(new URL('../src/components/layout/AdminChatHistory.jsx', import.meta.url), 'utf8');
  assert(source.includes("currentUser?.role === 'admin'")); assert(source.includes('AbortController'));
  assert(source.includes('inspectAdminChatTranscript(response.data, selectedKey)'));
  assert(!/dangerouslySetInnerHTML|axios\.(post|patch|delete|put)\(/.test(source));
  const routes = readFileSync(new URL('../src/routes/AppRoutes.jsx', import.meta.url), 'utf8');
  assert.match(routes, /path='\/admin-dashboard\/chats'[^\n]*ProtectedRoute role=\{'admin'\}/);
  const users = readFileSync(new URL('../src/components/layout/UserManagement.jsx', import.meta.url), 'utf8');
  assert(users.includes('/admin-dashboard/chats?userId='));
});
