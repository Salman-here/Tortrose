import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createConversationRequestGate } from '../src/utils/conversationRequestGate.js';

test('a late history response cannot replace the more recently selected chat', async () => {
  const gate = createConversationRequestGate();
  const displayed = [];
  let finishOld;
  const isOldCurrent = gate.begin();
  const oldRequest = new Promise(resolve => { finishOld = resolve; }).then(() => {
    if (isOldCurrent()) displayed.push('old history');
  });
  const isNewCurrent = gate.begin();
  if (isNewCurrent()) displayed.push('new selection');
  finishOld();
  await oldRequest;
  assert.deepEqual(displayed, ['new selection']);
});

test('new-chat reset, deletion, or unmount invalidates all earlier history readers', () => {
  const gate = createConversationRequestGate();
  const oldHistory = gate.begin();
  const pendingListSelection = gate.capture();
  gate.invalidate();
  assert.equal(oldHistory(), false);
  assert.equal(pendingListSelection(), false);
  assert.equal(gate.begin()(), true);
});

test('refreshing the sidebar list does not invalidate the selected history request', () => {
  const gate = createConversationRequestGate();
  const history = gate.begin();
  const list = gate.capture();
  assert.equal(history(), true);
  assert.equal(list(), true);
});

const page = readFileSync(new URL('../src/pages/AIChatPage.jsx', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../src/components/common/ChatBot.jsx', import.meta.url), 'utf8');

test('header New chat explicitly clears parent history without clearing ordinary saved replies', () => {
  assert.match(chat, /onConversationCreated\(nextConversationId, \{ reset: true \}\)/);
  assert.match(page, /handleConversationCreated[\s\S]*?if \(reset\) \{[\s\S]*?setLoadedMessages\(\[\]\)/);
  assert.match(chat, /onConversationCreated\(parsed\.conversationId\)/);
  assert.match(page, /onConversationCreated=\{handleConversationCreated\}/);
});

test('New chat preserves the current conversation until server creation succeeds', () => {
  const clear = chat.slice(chat.indexOf('const clearChat = async'), chat.indexOf('// ─── Render a message'));
  assert.ok(clear.indexOf('if (!resp.ok) throw') < clear.indexOf('setActiveConvoId(nextConversationId)'));
  assert.ok(clear.indexOf('if (!data?._id) throw') < clear.indexOf('setMessages('));
  assert.doesNotMatch(clear, /setActiveConvoId\(null\)/);
  assert.match(clear, /Your current chat is unchanged/);
  assert.match(page, /creatingConversation && !activeConvoId && loadedMessages === null/);
});

test('history loading and history errors block sends while active mutations block sidebar switches', () => {
  assert.match(chat, /const chatBusy = isLoading \|\| isStartingNewChat \|\| waitingForHistory/);
  assert.match(chat, /pendingAttachments.length === 0\) \|\| chatBusy \|\| historyError\) return/);
  assert.match(page, /!authToken \|\| !convoId \|\| chatBusy \|\| creatingConversation/);
  assert.match(page, /onBusyChange=\{setChatBusy\}/);
  assert.match(chat, /if \(!isCurrent\(\)\) return/);
});
