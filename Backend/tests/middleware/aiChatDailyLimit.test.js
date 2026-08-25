jest.mock('../../services/aiChatRateLimitService', () => ({
  consumeDailyUsageForRequest: jest.fn(),
}));

const { consumeDailyUsageForRequest } = require('../../services/aiChatRateLimitService');
const aiChatDailyLimit = require('../../middleware/aiChatDailyLimit');

const response = () => ({
  setHeader: jest.fn(),
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

describe('aiChatDailyLimit middleware', () => {
  let consoleError;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => consoleError.mockRestore());

  it('attaches one consumed usage result before continuing', async () => {
    const usage = {
      allowed: true, used: 1, limit: 5, remaining: 4, role: 'guest', resetAt: '2035-06-15T00:00:00.000Z',
    };
    consumeDailyUsageForRequest.mockResolvedValue(usage);
    const req = { ip: '203.0.113.60' };
    const res = response();
    const next = jest.fn();

    await aiChatDailyLimit(req, res, next);

    expect(req.aiChatDailyUsage).toBe(usage);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '4');
  });

  it('rejects exhausted callers without invoking later upload middleware', async () => {
    consumeDailyUsageForRequest.mockResolvedValue({
      allowed: false, used: 5, limit: 5, remaining: 0, role: 'guest', resetAt: '2035-06-15T00:00:00.000Z',
    });
    const res = response();
    const next = jest.fn();

    await aiChatDailyLimit({ ip: '203.0.113.61' }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AI_DAILY_LIMIT_REACHED' }));
  });

  it('fails closed when usage storage is unavailable', async () => {
    consumeDailyUsageForRequest.mockRejectedValue(new Error('database unavailable'));
    const res = response();
    const next = jest.fn();

    await aiChatDailyLimit({ ip: '203.0.113.62' }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AI_USAGE_UNAVAILABLE' }));
  });
});
