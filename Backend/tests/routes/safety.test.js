const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const safetyRoutes = require('../../routes/safetyRoutes');
const ChatHistory = require('../../models/ChatHistory');
const Complaint = require('../../models/Complaint');
const Product = require('../../models/Product');
const Store = require('../../models/Store');
const StoreReview = require('../../models/StoreReview');
const User = require('../../models/User');
const UserBlock = require('../../models/UserBlock');

let mongo;
let app;

const tokenFor = user => `Bearer ${jwt.sign({ id: user._id.toString(), role: user.role }, process.env.JWT_SECRET)}`;
const createUser = (role, suffix) => User.create({
  username: `${role}-${suffix}`,
  email: `${role}-${suffix}@example.com`,
  password: 'Password123!',
  role,
  status: 'active',
  isVerified: true,
});

beforeAll(async () => {
  process.env.JWT_SECRET = 'safety-route-test-secret';
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/safety', safetyRoutes);
}, 60000);

afterEach(async () => {
  await Promise.all([
    ChatHistory.deleteMany({}),
    Complaint.deleteMany({}),
    Product.deleteMany({}),
    Store.deleteMany({}),
    StoreReview.deleteMany({}),
    UserBlock.deleteMany({}),
    User.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
}, 60000);

test('accepts an anonymous AI response report without exposing infrastructure details', async () => {
  const response = await request(app).post('/api/safety/reports').send({
    kind: 'ai_response',
    reason: 'misleading',
    content: 'This answer is inaccurate.',
    details: 'The product information is incorrect.',
  });

  expect(response.status).toBe(201);
  const saved = await Complaint.findById(response.body.reportId).lean();
  expect(saved.user).toBeNull();
  expect(saved.category).toBe('ai_response');
  expect(saved.report).toMatchObject({
    kind: 'ai_response',
    reason: 'misleading',
    reporterType: 'anonymous',
    contentSnapshot: 'This answer is inaccurate.',
  });
});

test('checks an authenticated AI report against the reporters saved assistant message', async () => {
  const buyer = await createUser('user', 'ai');
  const history = await ChatHistory.create({
    user: buyer._id,
    conversations: [{
      title: 'Products',
      source: 'mobile',
      messages: [
        { role: 'user', content: 'Tell me about this product' },
        { role: 'assistant', content: 'Saved assistant response' },
      ],
    }],
  });
  const conversation = history.conversations[0];
  const assistant = conversation.messages[1];

  const response = await request(app)
    .post('/api/safety/reports')
    .set('Authorization', tokenFor(buyer))
    .send({
      kind: 'ai_response',
      reason: 'inappropriate',
      conversationId: conversation._id,
      messageId: assistant._id,
      content: assistant.content,
    });

  expect(response.status).toBe(201);
  const saved = await Complaint.findById(response.body.reportId).lean();
  expect(String(saved.user)).toBe(String(buyer._id));
  expect(String(saved.report.messageId)).toBe(String(assistant._id));
});

test('reports and blocks a seller, then lists and removes the block', async () => {
  const buyer = await createUser('user', 'buyer');
  const seller = await createUser('seller', 'seller');
  const store = await Store.create({
    seller: seller._id,
    storeName: 'Safety Store',
    storeSlug: 'safety-store',
    visibility: { mode: 'global' },
  });

  const report = await request(app)
    .post('/api/safety/reports')
    .set('Authorization', tokenFor(buyer))
    .send({ kind: 'store', reason: 'spam', targetId: store._id });
  expect(report.status).toBe(201);

  const blocked = await request(app)
    .post('/api/safety/blocks')
    .set('Authorization', tokenFor(buyer))
    .send({ userId: seller._id, source: 'seller' });
  expect(blocked.status).toBe(201);

  const listed = await request(app)
    .get('/api/safety/blocks')
    .set('Authorization', tokenFor(buyer));
  expect(listed.status).toBe(200);
  expect(listed.body.blocks).toHaveLength(1);
  expect(listed.body.blocks[0].blocked.username).toBe(seller.username);

  const unblocked = await request(app)
    .delete(`/api/safety/blocks/${seller._id}`)
    .set('Authorization', tokenFor(buyer));
  expect(unblocked.status).toBe(200);
  expect(await UserBlock.countDocuments()).toBe(0);
});

test('does not allow reporting or blocking your own content or account', async () => {
  const seller = await createUser('seller', 'self');
  const product = await Product.create({
    seller: seller._id,
    name: 'Own Product',
    description: 'Own product description',
    price: 20,
    currency: 'USD',
    priceCurrency: 'USD',
    category: 'Testing',
    brand: 'Rozare',
    stock: 1,
    image: 'https://example.com/own.jpg',
  });

  const report = await request(app)
    .post('/api/safety/reports')
    .set('Authorization', tokenFor(seller))
    .send({ kind: 'product', reason: 'other', targetId: product._id });
  expect(report.status).toBe(400);

  const block = await request(app)
    .post('/api/safety/blocks')
    .set('Authorization', tokenFor(seller))
    .send({ userId: seller._id, source: 'seller' });
  expect(block.status).toBe(400);
});
