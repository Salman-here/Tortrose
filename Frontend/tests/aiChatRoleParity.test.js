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
const chatBot = readFileSync(
  new URL('../src/components/common/ChatBot.jsx', import.meta.url),
  'utf8',
);
const globalContext = readFileSync(
  new URL('../src/contexts/GlobalContext.jsx', import.meta.url),
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

test('new-conversation creation blocks sending until the durable conversation ID exists', () => {
  assert.match(aiChatPage, /creatingConversation/);
  assert.match(aiChatPage, /Starting a new conversation/);
  assert.match(chatBot, /isStartingNewChat/);
  assert.match(chatBot, /Starting a new chat/);
});

test('successful AI cart and wishlist mutations refresh the shared application state', () => {
  assert.match(chatBot, /\['add_to_wishlist', 'remove_from_wishlist'\]\.includes\(parsed\.tool\)[\s\S]*?fetchWishlist\(\)/);
  assert.match(chatBot, /\['add_to_cart', 'remove_from_cart', 'clear_cart', 'place_order'\]\.includes\(parsed\.tool\)[\s\S]*?fetchCart\(\)/);
  assert.match(chatBot, /parsed\.tool === 'update_profile'[\s\S]*?fetchAndUpdateCurrentUser\(\)/);
  assert.match(globalContext, /useEffect\(\(\) => \{\s*fetchWishlist\(\);\s*\}, \[fetchWishlist\]\)/);
});

test('tool-only assistant turns remain in follow-up context and completed actions are not replayed', () => {
  assert.match(chatBot, /Array\.isArray\(m\.toolEvents\) && m\.toolEvents\.length > 0/);
  assert.match(chatBot, /succeeded in the previous assistant turn\. Do not repeat it/);
  assert.match(chatBot, /\[content, toolMemory\]\.filter\(Boolean\)\.join/);
});

test('refreshing an AI-updated profile does not reset the visible conversation', () => {
  assert.match(chatBot, /const latestUserNameRef = useRef\(userName\)/);
  assert.match(chatBot, /greetFn\(latestUserNameRef\.current, greeting\)/);
  assert.match(chatBot, /\}, \[initialMessages, conversationId, role\]\);/);
  assert.doesNotMatch(chatBot, /\[initialMessages, conversationId, role, userName\]/);
});

test('AI cart cards use the converted buyer-currency price', () => {
  assert.match(chatBot, /toolName === 'view_cart'[\s\S]*?price: item\.price,[\s\S]*?currency: item\.currency \|\| result\.data\.currency/);
  assert.doesNotMatch(chatBot, /price: item\.originalPrice \|\| item\.price/);
});

test('seller-owned AI product cards stay in the store product currency', () => {
  assert.match(chatBot, /preserveSourceCurrency=\{toolName === 'list_my_products'\}/);
  assert.match(chatBot, /targetCurrency: preserveSourceCurrency \? productCurrency : undefined/);
});
