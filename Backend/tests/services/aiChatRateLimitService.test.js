process.env.AI_RATE_LIMIT_HASH_SECRET = 'ai-rate-limit-test-secret';

const mongoose = require('mongoose');
const crypto = require('crypto');
const { MongoMemoryServer } = require('mongodb-memory-server');
const AIChatDailyUsage = require('../../models/AIChatDailyUsage');
const {
  consumeDailyUsageForRequest,
  getDailyUsageForRequest,
} = require('../../services/aiChatRateLimitService');

const TEST_DAY = new Date('2035-06-14T12:00:00.000Z');

const guestRequest = (ip = '203.0.113.10') => ({
  ip,
  socket: { remoteAddress: ip },
});

const userRequest = (role = 'user', id = new mongoose.Types.ObjectId()) => ({
  user: { id: String(id), _id: id, role },
  ip: '203.0.113.20',
});

describe('aiChatRateLimitService', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterEach(async () => {
    await AIChatDailyUsage.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('atomically grants only five concurrent guest messages', async () => {
    const req = {
      ...guestRequest(),
      method: 'POST',
      originalUrl: '/api/ai-chat/once',
      headers: {
        'idempotency-key': 'one-key-must-not-bypass-the-guest-cap',
        'content-type': 'application/json',
      },
      body: { messages: [{ role: 'user', content: 'Repeat this model call' }] },
    };
    const attempts = await Promise.all(
      Array.from({ length: 40 }, () => consumeDailyUsageForRequest(req, { now: TEST_DAY }))
    );

    expect(attempts.filter(({ allowed }) => allowed)).toHaveLength(5);
    expect(attempts.filter(({ allowed }) => !allowed)).toHaveLength(35);
    expect(await getDailyUsageForRequest(req, { now: TEST_DAY })).toMatchObject({
      allowed: false,
      used: 5,
      limit: 5,
      remaining: 0,
      role: 'guest',
    });

    const [record] = await AIChatDailyUsage.find({}).lean();
    expect(record.messageCount).toBe(5);
    expect(record.ipHash).toHaveLength(64);
    expect(record._id).not.toContain(req.ip);
  });

  it('uses a deterministic secret-keyed guest digest and separates different IPs', async () => {
    const firstIp = guestRequest('203.0.113.71');
    const secondIp = guestRequest('203.0.113.72');
    await consumeDailyUsageForRequest(firstIp, { now: TEST_DAY });
    await consumeDailyUsageForRequest(firstIp, { now: new Date('2035-06-15T12:00:00.000Z') });
    await consumeDailyUsageForRequest(secondIp, { now: TEST_DAY });

    const records = await AIChatDailyUsage.find({}).sort({ date: 1, ipHash: 1 }).lean();
    const expectedFirstHash = crypto
      .createHmac('sha256', process.env.AI_RATE_LIMIT_HASH_SECRET)
      .update(firstIp.ip)
      .digest('hex');
    const sameIpRecords = records.filter(record => record.ipHash === expectedFirstHash);
    expect(sameIpRecords).toHaveLength(2);
    expect(new Set(records.map(record => record.ipHash)).size).toBe(2);
    expect(records.every(record => record.ipHash.length === 64)).toBe(true);
  });

  it('fails closed for a guest when no keyed-hash secret is configured', async () => {
    const originalDedicated = process.env.AI_RATE_LIMIT_HASH_SECRET;
    const originalJwt = process.env.JWT_SECRET;
    delete process.env.AI_RATE_LIMIT_HASH_SECRET;
    delete process.env.JWT_SECRET;
    try {
      await expect(consumeDailyUsageForRequest(guestRequest(), { now: TEST_DAY })).rejects.toMatchObject({
        statusCode: 503,
        code: 'AI_USAGE_HASH_SECRET_MISSING',
      });
      await expect(AIChatDailyUsage.countDocuments()).resolves.toBe(0);
    } finally {
      process.env.AI_RATE_LIMIT_HASH_SECRET = originalDedicated;
      if (originalJwt === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = originalJwt;
    }
  });

  it('atomically grants twenty buyer messages and denies the next one', async () => {
    const req = userRequest('user');
    const attempts = await Promise.all(
      Array.from({ length: 30 }, () => consumeDailyUsageForRequest(req, { now: TEST_DAY }))
    );

    expect(attempts.filter(({ allowed }) => allowed)).toHaveLength(20);
    expect(attempts.filter(({ allowed }) => !allowed)).toHaveLength(10);
    expect(await getDailyUsageForRequest(req, { now: TEST_DAY })).toMatchObject({
      allowed: false,
      used: 20,
      limit: 20,
      remaining: 0,
      role: 'user',
    });
  });

  it('charges every concurrent model attempt even when callers reuse one request key', async () => {
    const req = {
      ...userRequest('user'),
      method: 'POST',
      originalUrl: '/api/ai-chat/once',
      headers: {
        'idempotency-key': 'mobile-chat-request-123',
        'content-type': 'application/json',
      },
      body: { messages: [{ role: 'user', content: 'Show my orders' }] },
    };

    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => consumeDailyUsageForRequest(req, { now: TEST_DAY }))
    );

    expect(attempts.every(attempt => attempt.allowed)).toBe(true);
    const record = await AIChatDailyUsage.findOne().lean();
    expect(record.messageCount).toBe(10);
    expect(record.requestReceipts).toHaveLength(0);
    expect(attempts.some(attempt => attempt.idempotentReplay)).toBe(false);
  });

  it('charges changed JSON content independently even when the request key is reused', async () => {
    const req = {
      ...guestRequest(),
      method: 'POST',
      originalUrl: '/api/ai-chat/once',
      headers: { 'idempotency-key': 'guest-content-binding', 'content-type': 'application/json' },
      body: { messages: [{ role: 'user', content: 'First request' }] },
    };
    const first = await consumeDailyUsageForRequest(req, { now: TEST_DAY });
    const second = await consumeDailyUsageForRequest({
      ...req,
      body: { messages: [{ role: 'user', content: 'Different request' }] },
    }, { now: TEST_DAY });

    expect(first).toMatchObject({ allowed: true, used: 1 });
    expect(second).toMatchObject({ allowed: true, used: 2 });
    await expect(AIChatDailyUsage.findOne().then(record => record.messageCount)).resolves.toBe(2);
  });

  it('charges a retried model call when prior history and conversation location change', async () => {
    const base = {
      ...userRequest('user'),
      method: 'POST',
      originalUrl: '/api/ai-chat/once',
      headers: { 'idempotency-key': 'same-logical-final-turn', 'content-type': 'application/json' },
      body: {
        currency: 'PKR',
        conversationId: 'conversation-1',
        requestKey: 'same-logical-final-turn',
        messages: [
          { role: 'assistant', content: 'Old assistant history' },
          { role: 'user', content: 'Create this coupon once' },
        ],
      },
    };
    const first = await consumeDailyUsageForRequest(base, { now: TEST_DAY });
    const replay = await consumeDailyUsageForRequest({
      ...base,
      body: {
        ...base.body,
        conversationId: 'a-different-conversation-after-clear',
        requestKey: 'a duplicate body transport value that is intentionally ignored',
        messages: [
          { role: 'user', content: 'Different earlier history' },
          { role: 'assistant', content: 'A failure message appended after the lost response' },
          { role: 'user', content: 'Create this coupon once' },
        ],
      },
    }, { now: TEST_DAY });

    expect(first).toMatchObject({ allowed: true, used: 1 });
    expect(replay).toMatchObject({ allowed: true, used: 2 });
    await expect(AIChatDailyUsage.findOne().then(record => record.messageCount)).resolves.toBe(2);
  });

  it('charges a new model attempt when selected currency changes under one key', async () => {
    const req = {
      ...userRequest('user'),
      method: 'POST',
      originalUrl: '/api/ai-chat/once',
      headers: { 'idempotency-key': 'currency-bound-logical-turn', 'content-type': 'application/json' },
      body: {
        currency: 'USD',
        messages: [{ role: 'user', content: 'Set the price to 10' }],
      },
    };
    const first = await consumeDailyUsageForRequest(req, { now: TEST_DAY });
    const second = await consumeDailyUsageForRequest({
      ...req,
      body: { ...req.body, currency: 'PKR' },
    }, { now: TEST_DAY });

    expect(first).toMatchObject({ allowed: true, used: 1 });
    expect(second).toMatchObject({ allowed: true, used: 2 });
  });

  it('counts multipart attempts separately because their bodies are unavailable before multer', async () => {
    const req = {
      ...guestRequest(),
      method: 'POST',
      originalUrl: '/api/ai-chat/once',
      headers: {
        'idempotency-key': 'multipart-body-is-not-yet-trustworthy',
        'content-type': 'multipart/form-data; boundary=----rozare-test',
      },
      body: undefined,
    };

    const first = await consumeDailyUsageForRequest(req, { now: TEST_DAY });
    const second = await consumeDailyUsageForRequest(req, { now: TEST_DAY });

    expect(first).toMatchObject({ allowed: true, used: 1 });
    expect(second).toMatchObject({ allowed: true, used: 2 });
    const record = await AIChatDailyUsage.findOne().lean();
    expect(record.messageCount).toBe(2);
    expect(record.requestReceipts).toHaveLength(0);
  });

  it('does not let a guest bypass the cap with a caller-supplied IP header', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 6 }, (_, index) => consumeDailyUsageForRequest({
        ...guestRequest('203.0.113.21'),
        headers: { 'cf-connecting-ip': `198.51.100.${index + 1}` },
      }, { now: TEST_DAY }))
    );

    expect(attempts.filter(({ allowed }) => allowed)).toHaveLength(5);
    expect(await AIChatDailyUsage.countDocuments()).toBe(1);
  });

  it.each(['seller', 'seller_sub', 'admin'])('keeps %s chat unlimited without writing usage', async (role) => {
    const usage = await consumeDailyUsageForRequest(userRequest(role), { now: TEST_DAY });

    expect(usage).toMatchObject({
      allowed: true,
      used: 0,
      limit: -1,
      remaining: -1,
      role,
    });
    expect(await AIChatDailyUsage.countDocuments()).toBe(0);
  });

  it('isolates subjects and starts a fresh counter at the next UTC day', async () => {
    const firstGuest = guestRequest('203.0.113.30');
    const secondGuest = guestRequest('203.0.113.31');
    const beforeMidnight = new Date('2035-06-14T23:59:59.000Z');
    const afterMidnight = new Date('2035-06-15T00:00:01.000Z');

    await consumeDailyUsageForRequest(firstGuest, { now: beforeMidnight });
    await consumeDailyUsageForRequest(secondGuest, { now: beforeMidnight });
    const nextDay = await consumeDailyUsageForRequest(firstGuest, { now: afterMidnight });

    expect(nextDay).toMatchObject({ used: 1, remaining: 4, allowed: true });
    expect(await AIChatDailyUsage.countDocuments()).toBe(3);
  });
});
