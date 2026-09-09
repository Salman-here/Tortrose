'use strict';
process.env.OPENROUTER_API_KEY = 'currency-cooldown-routing-test';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Store = require('../../models/Store');
const User = require('../../models/User');
const ChatHistory = require('../../models/ChatHistory');
const { streamChat, chatOnce, processAIChatMessage } = require('../../controllers/aiChatController');
const { getStoreCurrencyCooldownReply, isSingleStoreCurrencyRequest } = require('../../services/aiStoreCurrencyService');

let replica;
let savedFetch;
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
}, 60000);
beforeEach(() => { savedFetch = global.fetch; global.fetch = jest.fn(() => { throw new Error('A locked pure currency request must not call the language model'); }); });
afterEach(async () => {
  global.fetch = savedFetch;
  await Promise.all([Store, User, ChatHistory].map(model => model.deleteMany({})));
});
afterAll(async () => { await mongoose.disconnect(); if (replica) await replica.stop(); }, 60000);

async function sellerFixture() {
  const seller = await User.create({ username: 'Cooldown seller', email: `${new mongoose.Types.ObjectId()}@example.com`, role: 'seller', currency: 'USD' });
  const lastChangedAt = new Date();
  const store = await Store.create({ seller: seller._id, storeName: 'Cooldown store', storeSlug: `cooldown-${seller._id}`, productCurrency: 'USD', isActive: true, lastProductCurrencyChangeAt: lastChangedAt });
  return { seller, store, lastChangedAt };
}

test.each(['web', 'mobile', 'whatsapp'])('%s answers a locked store-currency request directly from live state, without a model promise or mutation', async channel => {
  const { seller, lastChangedAt } = await sellerFixture();
  const text = 'Change my store back to PKR now please.';
  const request = {
    user: { id: String(seller._id), role: 'seller' },
    body: { messages: [{ role: 'user', content: text }], currency: 'USD' },
    headers: { 'idempotency-key': `cooldown-${channel}` }, on: jest.fn(),
    aiChatDailyUsage: { allowed: true, limit: -1, remaining: -1 },
  };
  const response = { setHeader: jest.fn(), flushHeaders: jest.fn(), write: jest.fn(), end: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn(), writableEnded: false, destroyed: false };
  let visible;
  if (channel === 'whatsapp') {
    const result = await processAIChatMessage({ _id: seller._id, role: 'seller', currency: 'USD' }, request.body.messages, { mode: 'whatsapp', requestKey: 'cooldown-whatsapp' });
    visible = result.responseText;
    expect(result.toolResults).toEqual([]);
  } else if (channel === 'mobile') {
    await chatOnce(request, response);
    visible = response.json.mock.calls[0]?.[0]?.message?.content;
    expect(response.json.mock.calls[0]?.[0]?.toolResults).toEqual([]);
  } else {
    await streamChat(request, response);
    visible = response.write.mock.calls.flatMap(([chunk]) => String(chunk).split('\n')).filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6))).map(event => event.choices?.[0]?.delta?.content || '').join('');
  }
  expect(visible).toContain('Your store currently uses USD');
  expect(visible).toContain('cannot change its currency again until');
  expect(visible).toContain('60-day waiting period');
  expect(visible).toContain('individual product price in another supported currency');
  expect(global.fetch).not.toHaveBeenCalled();
  expect(await Store.findOne({ seller: seller._id }).lean()).toMatchObject({ productCurrency: 'USD', lastProductCurrencyChangeAt: lastChangedAt });
});

test('same-currency requests are no-ops and individual/mixed product actions are not intercepted', async () => {
  const { seller } = await sellerFixture();
  expect(await getStoreCurrencyCooldownReply(seller._id, 'seller', 'Change my store currency to USD')).toContain('already uses USD');
  expect(await getStoreCurrencyCooldownReply(seller._id, 'seller', 'Change my store from PKR to USD')).toContain('already uses USD');
  expect(await getStoreCurrencyCooldownReply(seller._id, 'seller', 'Change this product price to 2800 PKR for my store')).toBe('');
  expect(await getStoreCurrencyCooldownReply(seller._id, 'user', 'Change my store currency to PKR')).toBe('');
  expect(isSingleStoreCurrencyRequest('Change my store name to USD Market')).toBe(false);
  expect(isSingleStoreCurrencyRequest('Change my store currency and update the product stock')).toBe(false);
});
