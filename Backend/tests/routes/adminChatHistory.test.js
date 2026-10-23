const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const routes = require('../../routes/aiChatRoutes');
const User = require('../../models/User');
const History = require('../../models/ChatHistory');
const Access = require('../../models/AdminChatAccessLog');
const { visibleText, attachmentView } = require('../../services/adminChatHistoryService');
let mongo, app;
const token = user => 'Bearer ' + jwt.sign({ id: String(user._id), role: 'admin' }, process.env.JWT_SECRET);
const createUser = (name, role = 'user', status = 'active') => User.create({ username: name, role, status,
  email: name + '@example.test', password: 'isolated-test-password' });

beforeAll(async () => {
  process.env.JWT_SECRET = 'admin-chat-history-isolated-test';
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  app = express(); app.use(express.json()); app.use('/api/ai-chat', routes);
}, 60000);
afterEach(async () => { jest.restoreAllMocks(); await Promise.all([User.deleteMany({}), History.deleteMany({}), Access.deleteMany({})]); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

async function fixture() {
  const [admin, buyer, seller] = await Promise.all([createUser('review-admin', 'admin'), createUser('buyer-one'), createUser('seller-one', 'seller')]);
  const history = await History.create({ user: buyer._id, conversations: [
    { source: 'web', title: 'Website question', messages: [{ role: 'user', content: 'I need a blue mug' }, { role: 'assistant', content: 'Here are the choices' }] },
    { source: 'mobile', title: 'Mobile question', messages: [{ role: 'user', content: 'Check my mobile cart' }] },
  ] });
  const sellerHistory = await History.create({ user: seller._id, conversations: [{ source: 'whatsapp', title: '[WhatsApp] Chat', messages: [{ role: 'user', content: 'How many orders?' }] }] });
  return { admin, buyer, seller, history, sellerHistory };
}

test('anonymous, buyers, sellers and blocked admins cannot browse or read other accounts chats', async () => {
  const f = await fixture(), blocked = await createUser('blocked-review-admin', 'admin', 'blocked');
  const paths = ['/admin/conversations', `/admin/users/${f.buyer._id}/conversations/${f.history.conversations[0]._id}`];
  for (const path of paths) {
    expect((await request(app).get('/api/ai-chat' + path)).status).toBe(401);
    for (const actor of [f.buyer, f.seller, blocked]) {
      const response = await request(app).get('/api/ai-chat' + path).set('Authorization', token(actor));
      expect(response.status).toBe(403); expect(response.text).not.toContain('blue mug');
    }
  }
  expect(await Access.countDocuments()).toBe(0);
});

test('current database role, not a previously issued admin claim, authorizes access', async () => {
  const f = await fixture(); const old = token(f.admin);
  await User.updateOne({ _id: f.admin._id }, { $set: { role: 'user' } });
  expect((await request(app).get('/api/ai-chat/admin/conversations').set('Authorization', old)).status).toBe(403);
});

test('admin lists all saved sources with pagination, role filters and no transcript/tool data', async () => {
  const f = await fixture();
  const response = await request(app).get('/api/ai-chat/admin/conversations?limit=2').set('Authorization', token(f.admin));
  expect(response.status).toBe(200); expect(response.headers['cache-control']).toContain('no-store');
  expect(response.body.pagination).toMatchObject({ total: 3, hasMore: true, page: 1, limit: 2 });
  expect(response.body.conversations).toHaveLength(2); expect(response.text).not.toContain('blue mug');
  expect(response.text).not.toContain('messages');
  for (const source of ['web', 'mobile', 'whatsapp']) {
    const filtered = await request(app).get('/api/ai-chat/admin/conversations?source=' + source).set('Authorization', token(f.admin));
    expect(filtered.body.conversations).toHaveLength(1); expect(filtered.body.conversations[0].source).toBe(source);
  }
  const seller = await request(app).get('/api/ai-chat/admin/conversations?role=seller').set('Authorization', token(f.admin));
  expect(seller.body.conversations).toHaveLength(1); expect(seller.body.conversations[0].user.role).toBe('seller');
});

test('account scoping is exact, search is literal, and accounts without histories are truthful empty results', async () => {
  const f = await fixture();
  const scoped = await request(app).get('/api/ai-chat/admin/conversations?userId=' + f.buyer._id).set('Authorization', token(f.admin));
  expect(scoped.body.conversations).toHaveLength(2); expect(scoped.body.subject.id).toBe(String(f.buyer._id));
  const literal = await request(app).get('/api/ai-chat/admin/conversations?search=' + encodeURIComponent('.*')).set('Authorization', token(f.admin));
  expect(literal.body.pagination.total).toBe(0);
  const empty = await request(app).get('/api/ai-chat/admin/conversations?userId=' + f.admin._id).set('Authorization', token(f.admin));
  expect(empty.body.conversations).toEqual([]); expect(empty.body.subject.role).toBe('admin');
});

test('legacy source is not fabricated, orphan histories are not exposed, and blocked subjects remain reviewable', async () => {
  const f = await fixture();
  await User.updateOne({ _id: f.buyer._id }, { $set: { status: 'blocked' } });
  await History.collection.updateOne({ user: f.buyer._id }, { $push: { conversations: { _id: new mongoose.Types.ObjectId(), title: 'Legacy conversation', messages: [] } } });
  await History.collection.insertOne({ user: new mongoose.Types.ObjectId(), conversations: [{ _id: new mongoose.Types.ObjectId(), title: 'Orphan private history', messages: [] }] });
  const legacy = await request(app).get('/api/ai-chat/admin/conversations?source=unknown').set('Authorization', token(f.admin));
  expect(legacy.body.conversations).toHaveLength(1); expect(legacy.body.conversations[0].source).toBe('unknown');
  expect(legacy.body.conversations[0].user.status).toBe('blocked');
  expect(JSON.stringify(legacy.body)).not.toContain('Orphan private history');
});

test.each(['page=0', 'limit=101', 'page=1.5', 'role[$ne]=admin', 'source=private', 'userId[$ne]=x', 'search[x]=y'])('rejects malformed query %s', async query => {
  const admin = await createUser('query-admin', 'admin');
  expect((await request(app).get('/api/ai-chat/admin/conversations?' + query).set('Authorization', token(admin))).status).toBe(400);
});

test('transcript is read-only, owner-bound, chronological, paginated and excludes system/internal tool data', async () => {
  const f = await fixture(); const convo = f.history.conversations[0];
  convo.messages = [{ role: 'system', content: 'PRIVATE SYSTEM PROMPT' }, ...Array.from({ length: 60 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'Visible turn ' + index }))];
  convo.messages[60].content += '\n\n[Tool memory: INTERNAL_QUOTE_TOKEN]';
  await f.history.save();
  const before = await History.findById(f.history._id).lean();
  const endpoint = `/api/ai-chat/admin/users/${f.buyer._id}/conversations/${convo._id}`;
  const response = await request(app).get(endpoint).set('Authorization', token(f.admin));
  expect(response.status).toBe(200); expect(response.body.messages).toHaveLength(50);
  expect(response.body.messages[0].content).toBe('Visible turn 10');
  expect(response.body.messages.at(-1).content).toBe('Visible turn 59');
  expect(response.body.pagination).toMatchObject({ total: 60, hasOlder: true });
  expect(response.text).not.toContain('PRIVATE SYSTEM PROMPT'); expect(response.text).not.toContain('INTERNAL_QUOTE_TOKEN');
  const earlier = await request(app).get(endpoint + '?page=2').set('Authorization', token(f.admin));
  expect(earlier.body.messages).toHaveLength(10); expect(earlier.body.messages[0].content).toBe('Visible turn 0');
  expect(earlier.body.pagination.hasOlder).toBe(false);
  const after = await History.findById(f.history._id).lean(); expect(after).toEqual(before);
  const log = await Access.findOne({ conversation: convo._id }).lean();
  expect(String(log.admin)).toBe(String(f.admin._id)); expect(String(log.subject)).toBe(String(f.buyer._id)); expect(log).not.toHaveProperty('messages');
  const wrongOwner = await request(app).get(`/api/ai-chat/admin/users/${f.seller._id}/conversations/${convo._id}`).set('Authorization', token(f.admin));
  expect(wrongOwner.status).toBe(404); expect(wrongOwner.text).not.toContain('Visible turn');
});

test('failed access-audit persistence fails closed without disclosing a transcript', async () => {
  const f = await fixture(); jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(Access, 'create').mockRejectedValue(new Error('audit storage failure'));
  const response = await request(app).get(`/api/ai-chat/admin/users/${f.buyer._id}/conversations/${f.history.conversations[0]._id}`).set('Authorization', token(f.admin));
  expect(response.status).toBe(500); expect(response.text).not.toContain('blue mug'); expect(response.text).not.toContain('audit storage failure');
});

test('retained pre-conversation histories are listed and readable without migrating or inventing their source', async () => {
  const [admin, buyer] = await Promise.all([createUser('older-admin', 'admin'), createUser('older-buyer')]);
  const historyId = new mongoose.Types.ObjectId();
  await History.collection.insertOne({ _id: historyId, user: buyer._id,
    messages: [{ role: 'user', content: 'Earlier retained question' }, { role: 'assistant', content: 'Earlier retained answer' }] });
  const listed = await request(app).get('/api/ai-chat/admin/conversations?source=unknown').set('Authorization', token(admin));
  expect(listed.status).toBe(200); expect(listed.body.conversations).toHaveLength(1);
  expect(listed.body.conversations[0]).toMatchObject({ id: String(historyId), legacy: true, source: 'unknown', messageCount: 2 });
  const response = await request(app).get(`/api/ai-chat/admin/users/${buyer._id}/conversations/${historyId}`).set('Authorization', token(admin));
  expect(response.status).toBe(200); expect(response.body.messages.map(message => message.content)).toEqual(['Earlier retained question', 'Earlier retained answer']);
  expect(response.body.messages.map(message => message.id)).toEqual(['legacy-0', 'legacy-1']);
  const raw = await History.collection.findOne({ _id: historyId }); expect(raw.conversations).toBeUndefined();
});

test('secrets and unsafe attachment destinations are not exposed', () => {
  const secret = 'sk-or-v1-' + 'x'.repeat(40);
  expect(visibleText('Password: abc123\nBearer ' + 'x'.repeat(30) + '\n' + secret)).not.toMatch(/abc123|x{20}/);
  expect(attachmentView({ url: 'javascript:alert(1)' })).toBeNull();
  expect(attachmentView({ url: 'https://user:password@images.example.com/image.png' })).toBeNull();
  expect(attachmentView({ url: 'https://images.example.com/image.png?token=private' })).toBeNull();
  expect(attachmentView({ url: 'https://images.example.com/image.png', name: 'Photo' })).toMatchObject({ name: 'Photo', type: 'file' });
});
