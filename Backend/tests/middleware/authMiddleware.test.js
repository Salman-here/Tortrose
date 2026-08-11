const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

jest.mock('../../models/User', () => ({
  findById: jest.fn(),
}));

const User = require('../../models/User');
const verifyToken = require('../../middleware/authMiddleware');

const JWT_SECRET = 'auth-middleware-contract-secret';
let app;

beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  app = express();
  app.get('/protected', verifyToken, (_req, res) => res.json({ ok: true }));
  app.get('/business-unauthorized', verifyToken, (_req, res) => res.status(401).json({
    msg: 'Payment confirmation is required.',
    code: 'PAYMENT_CONFIRMATION_REQUIRED',
  }));
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('authentication session error contract', () => {
  test('marks a missing credential as AUTH_REQUIRED', async () => {
    const response = await request(app).get('/protected');

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      code: 'AUTH_REQUIRED',
      msg: 'No token provided!',
    });
  });

  test.each([
    ['invalid', 'not-a-valid-jwt'],
    ['expired', jwt.sign({ id: 'user-1' }, JWT_SECRET, { expiresIn: -1 })],
  ])('marks an %s JWT as AUTH_SESSION_INVALID', async (_label, token) => {
    const response = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      code: 'AUTH_SESSION_INVALID',
      msg: 'Login required',
    });
    expect(User.findById).not.toHaveBeenCalled();
  });

  test('marks a valid JWT for a deleted account as AUTH_SESSION_INVALID', async () => {
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(null),
    });
    const token = jwt.sign({ id: 'deleted-user-1' }, JWT_SECRET, { expiresIn: '5m' });

    const response = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_SESSION_INVALID');
  });

  test('does not relabel a controller business 401 as an invalid session', async () => {
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        _id: { toString: () => 'active-user-1' },
        username: 'active-user',
        email: 'active@test.com',
        role: 'user',
      }),
    });
    const token = jwt.sign({ id: 'active-user-1' }, JWT_SECRET, { expiresIn: '5m' });

    const response = await request(app)
      .get('/business-unauthorized')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      msg: 'Payment confirmation is required.',
      code: 'PAYMENT_CONFIRMATION_REQUIRED',
    });
  });
});
