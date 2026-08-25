const express = require('express');
const request = require('supertest');

const mockCallOrder = [];

jest.mock('../../middleware/authMiddleware', () => {
  const protect = (_req, _res, next) => next();
  protect.optionalAuth = (_req, _res, next) => {
    mockCallOrder.push('auth');
    next();
  };
  protect.protect = protect;
  return protect;
});
jest.mock('../../middleware/aiChatDailyLimit', () => (_req, _res, next) => {
  mockCallOrder.push('limit');
  next();
});
jest.mock('../../middleware/chatUpload', () => ({
  array: () => (_req, _res, next) => {
    mockCallOrder.push('upload');
    next();
  },
}));
jest.mock('../../controllers/aiChatController', () => {
  const noOp = (_req, res) => res.json({ ok: true });
  return {
    streamChat: (req, res) => {
      mockCallOrder.push('controller');
      return res.json({ ok: true });
    },
    chatOnce: (req, res) => {
      mockCallOrder.push('controller');
      return res.json({ ok: true });
    },
    getConversations: noOp,
    getConversation: noOp,
    createConversation: noOp,
    deleteConversation: noOp,
    renameConversation: noOp,
    clearConversation: noOp,
  };
});

const aiChatRoutes = require('../../routes/aiChatRoutes');

describe('AI chat route middleware order', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/ai-chat', aiChatRoutes);

  beforeEach(() => {
    mockCallOrder.length = 0;
  });

  it.each(['/stream', '/once'])('enforces daily usage before buffering uploads on %s', async (path) => {
    const response = await request(app).post(`/api/ai-chat${path}`).send({ messages: [] });

    expect(response.status).toBe(200);
    expect(mockCallOrder).toEqual(['auth', 'limit', 'upload', 'controller']);
  });
});
