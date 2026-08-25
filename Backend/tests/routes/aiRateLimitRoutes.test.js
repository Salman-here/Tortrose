const express = require('express');
const request = require('supertest');

jest.mock('../../middleware/authMiddleware', () => {
  const passThrough = (_req, _res, next) => next();
  passThrough.optionalAuth = passThrough;
  return passThrough;
});

jest.mock('../../controllers/aiActionController', () => new Proxy({}, {
  get: () => (_req, res) => res.status(501).json({ msg: 'not part of this test' }),
}));

jest.mock('../../controllers/aiRateLimitController', () => ({
  getRateLimit: jest.fn((_req, res) => res.json({ handler: 'status' })),
  preflightRateLimit: jest.fn((_req, res) => res.json({ handler: 'preflight' })),
}));

const aiRateLimitController = require('../../controllers/aiRateLimitController');
const aiActionRoutes = require('../../routes/aiActionRoutes');

describe('AI rate-limit routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/ai-actions', aiActionRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes status reads to the server-owned usage controller', async () => {
    const response = await request(app).get('/api/ai-actions/rate-limit');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ handler: 'status' });
    expect(aiRateLimitController.getRateLimit).toHaveBeenCalledTimes(1);
  });

  it('routes the legacy increment URL to read-only preflight', async () => {
    const response = await request(app).post('/api/ai-actions/rate-limit/increment');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ handler: 'preflight' });
    expect(aiRateLimitController.preflightRateLimit).toHaveBeenCalledTimes(1);
  });
});
