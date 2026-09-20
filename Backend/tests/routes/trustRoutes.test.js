const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const trustRoutes = require('../../routes/trustRoutes');
const StoreTrust = require('../../models/StoreTrust');
const Store = require('../../models/Store');
const User = require('../../models/User');
const jwt = require('jsonwebtoken');

let mongoServer;
let app;
let testUser;
let testStore;
let authToken;

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'trust-route-test-secret';
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);

  // Setup express app
  app = express();
  app.use(express.json());
  app.use('/api/stores', trustRoutes);
}, 60000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
  }
}, 60000);

beforeEach(async () => {
  await StoreTrust.deleteMany({});
  await Store.deleteMany({});
  await User.deleteMany({});

  // Create test user
  testUser = await User.create({
    username: 'testuser',
    email: 'test@example.com',
    password: 'password123',
    role: 'user'
  });

  // Create test store
  const firstSeller = await User.create({ username: 'firstseller', email: 'firstseller@example.com', role: 'seller', status: 'active' });
  testStore = await Store.create({
    storeName: 'Test Store',
    storeSlug: 'test-store',
    seller: firstSeller._id,
    visibility: { mode: 'global' },
    trustCount: 0
  });

  authToken = `Bearer ${jwt.sign({ id: testUser._id.toString(), role: testUser.role }, process.env.JWT_SECRET)}`;
});

describe('Trust API Routes', () => {
  describe('POST /api/stores/:storeId/trust', () => {
    test('should trust a store with valid data', async () => {
      const res = await request(app)
        .post(`/api/stores/${testStore._id}/trust`)
        .set('Authorization', authToken);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isTrusted).toBe(true);
      expect(res.body.data.trustCount).toBe(1);

      // Verify trust relationship was created
      const trust = await StoreTrust.findOne({ 
        user: testUser._id, 
        store: testStore._id 
      });
      expect(trust).not.toBeNull();
    });

    test('should return 400 when already trusted', async () => {
      // Trust the store first
      await StoreTrust.create({ user: testUser._id, store: testStore._id });

      const res = await request(app)
        .post(`/api/stores/${testStore._id}/trust`)
        .set('Authorization', authToken);

      expect(res.status).toBe(400);
    });

    test('should return 404 for non-existent store', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .post(`/api/stores/${fakeId}/trust`)
        .set('Authorization', authToken);

      expect(res.status).toBe(404);
    });

    test('should return 400 for invalid store ID', async () => {
      const res = await request(app)
        .post('/api/stores/invalid-id/trust')
        .set('Authorization', authToken);

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/stores/:storeId/trust', () => {
    test('should untrust a store with valid data', async () => {
      // Trust the store first
      await StoreTrust.create({ user: testUser._id, store: testStore._id });
      await Store.findByIdAndUpdate(testStore._id, { trustCount: 1 });

      const res = await request(app)
        .delete(`/api/stores/${testStore._id}/trust`)
        .set('Authorization', authToken);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isTrusted).toBe(false);
      expect(res.body.data.trustCount).toBe(0);

      // Verify trust relationship was removed
      const trust = await StoreTrust.findOne({ 
        user: testUser._id, 
        store: testStore._id 
      });
      expect(trust).toBeNull();
    });

    test('should return 400 when not trusted', async () => {
      const res = await request(app)
        .delete(`/api/stores/${testStore._id}/trust`)
        .set('Authorization', authToken);

      expect(res.status).toBe(400);
    });

    test('should return 404 for non-existent store', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .delete(`/api/stores/${fakeId}/trust`)
        .set('Authorization', authToken);

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/stores/:storeId/trust-status', () => {
    test('should return trust status for trusted store', async () => {
      await StoreTrust.create({ user: testUser._id, store: testStore._id });
      await Store.findByIdAndUpdate(testStore._id, { trustCount: 1 });

      const res = await request(app)
        .get(`/api/stores/${testStore._id}/trust-status`)
        .set('Authorization', authToken);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isTrusted).toBe(true);
      expect(res.body.data.trustCount).toBe(1);
    });

    test('should return trust status for untrusted store', async () => {
      const res = await request(app)
        .get(`/api/stores/${testStore._id}/trust-status`)
        .set('Authorization', authToken);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isTrusted).toBe(false);
      expect(res.body.data.trustCount).toBe(0);
    });

    test('should return 404 for non-existent store', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .get(`/api/stores/${fakeId}/trust-status`)
        .set('Authorization', authToken);

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/stores/trusted', () => {
    test('should return list of trusted stores', async () => {
      const secondSeller = await User.create({
        username: 'secondseller',
        email: 'secondseller@example.com',
        password: 'password123',
        role: 'seller'
      });

      // Create another store
      const store2 = await Store.create({
        storeName: 'Test Store 2',
        storeSlug: 'test-store-2',
        seller: secondSeller._id,
        visibility: { mode: 'global' },
        trustCount: 0
      });

      // Trust both stores
      await StoreTrust.create({ user: testUser._id, store: testStore._id });
      await StoreTrust.create({ user: testUser._id, store: store2._id });

      const res = await request(app)
        .get('/api/stores/trusted')
        .set('Authorization', authToken);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.trustedStores).toHaveLength(2);
      expect(res.body.data.count).toBe(2);
    });

    test('should return empty array when no stores trusted', async () => {
      const res = await request(app)
        .get('/api/stores/trusted')
        .set('Authorization', authToken);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.trustedStores).toHaveLength(0);
      expect(res.body.data.count).toBe(0);
    });
  });

  describe('Authentication', () => {
    test('should require authentication for all endpoints', async () => {
      const endpoints = [
        { method: 'post', path: `/api/stores/${testStore._id}/trust` },
        { method: 'delete', path: `/api/stores/${testStore._id}/trust` },
        { method: 'get', path: `/api/stores/${testStore._id}/trust-status` },
        { method: 'get', path: '/api/stores/trusted' }
      ];

      for (const endpoint of endpoints) {
        const res = await request(app)[endpoint.method](endpoint.path);
        expect(res.status).toBe(401);
      }
    });
  });
});
