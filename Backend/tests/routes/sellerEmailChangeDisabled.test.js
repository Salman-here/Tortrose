const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../controllers/mailController', () => ({ sendEmail: jest.fn() }));

const User = require('../../models/User');
const OTP = require('../../models/OTP');
const userRoutes = require('../../routes/userRoutes');
const { sendEmail } = require('../../controllers/mailController');

const app = express();
app.use(express.json());
app.use('/api/user', userRoutes);
const paths = ['/seller/change-email/initiate', '/seller/change-email/verify'];
const previousSecret = process.env.JWT_SECRET;
let mongo;
let seller;
let token;

beforeAll(async () => {
  process.env.JWT_SECRET = 'isolated-email-change-disabled-test';
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

beforeEach(async () => {
  jest.clearAllMocks();
  seller = await User.create({
    username: 'Seller identity test',
    email: 'unchanged-seller@example.com',
    role: 'seller',
    isVerified: true,
  });
  token = jwt.sign({ id: seller._id.toString(), role: 'seller' }, process.env.JWT_SECRET, { expiresIn: '1h' });
});

afterEach(async () => {
  await Promise.all([User.deleteMany({}), OTP.deleteMany({})]);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

describe('seller email-change pause at the authenticated HTTP boundary', () => {
  test.each(paths)('%s rejects new requests without sending or storing a code', async (path) => {
    const response = await request(app).post(`/api/user${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ newEmail: 'changed@example.com', otp: '123456', enabled: true });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      msg: 'Email changes are currently unavailable.',
      code: 'SELLER_EMAIL_CHANGE_DISABLED',
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await OTP.countDocuments({})).toBe(0);
    expect((await User.findById(seller._id)).email).toBe(seller.email);
  });

  test('a valid outstanding code cannot change email after the pause', async () => {
    await OTP.create({
      email: 'pending@example.com', otp: '123456',
      userData: { sellerId: seller._id, type: 'email-change' },
    });
    const response = await request(app).post('/api/user/seller/change-email/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({ newEmail: 'pending@example.com', otp: '123456' });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('SELLER_EMAIL_CHANGE_DISABLED');
    expect(response.body.token).toBeUndefined();
    expect((await User.findById(seller._id)).email).toBe(seller.email);
    expect((await User.findById(seller._id)).sellerInfo.lastEmailChange).toBeFalsy();
    expect(await OTP.countDocuments({})).toBe(1);
  });

  test.each(paths)('%s still requires a valid session', async (path) => {
    expect((await request(app).post(`/api/user${path}`).send({})).status).toBe(401);
    expect((await request(app).post(`/api/user${path}`)
      .set('Authorization', 'Bearer invalid').send({})).status).toBe(401);
  });

  test('the general profile update cannot bypass the email pause', async () => {
    const response = await request(app).patch('/api/user/update')
      .set('Authorization', `Bearer ${token}`)
      .send({ username: seller.username, email: 'bypass@example.com', newEmail: 'bypass@example.com' });
    expect(response.status).toBe(200);
    expect((await User.findById(seller._id)).email).toBe(seller.email);
  });
});
