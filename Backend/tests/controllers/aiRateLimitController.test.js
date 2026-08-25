jest.mock('../../services/aiChatRateLimitService', () => ({
  getDailyUsageForRequest: jest.fn(),
}));

const { getDailyUsageForRequest } = require('../../services/aiChatRateLimitService');
const { getRateLimit, preflightRateLimit } = require('../../controllers/aiRateLimitController');

const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

describe('aiRateLimitController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the server-owned daily usage status', async () => {
    const usage = { used: 3, limit: 5, remaining: 2, role: 'guest' };
    getDailyUsageForRequest.mockResolvedValue(usage);
    const req = { ip: '203.0.113.50' };
    const res = response();

    await getRateLimit(req, res);

    expect(getDailyUsageForRequest).toHaveBeenCalledWith(req);
    expect(res.json).toHaveBeenCalledWith(usage);
  });

  it('keeps the legacy increment endpoint read-only for released clients', async () => {
    const usage = { used: 3, limit: 5, remaining: 2, role: 'guest' };
    getDailyUsageForRequest.mockResolvedValue(usage);
    const res = response();

    await preflightRateLimit({ ip: '203.0.113.51' }, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(usage);
  });

  it('returns 429 from legacy preflight after the real chat quota is exhausted', async () => {
    getDailyUsageForRequest.mockResolvedValue({
      used: 5,
      limit: 5,
      remaining: 0,
      role: 'guest',
      resetAt: '2035-06-15T00:00:00.000Z',
    });
    const res = response();

    await preflightRateLimit({ ip: '203.0.113.52' }, res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'AI_DAILY_LIMIT_REACHED',
      remaining: 0,
    }));
  });
});
