process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

jest.mock('../../models/ChatHistory', () => {
  const ChatHistory = jest.fn();
  ChatHistory.findOne = jest.fn();
  ChatHistory.updateOne = jest.fn();
  return ChatHistory;
});

jest.mock('../../services/aiActionExecutor', () => ({
  executeToolCall: jest.fn(),
  isClientSideTool: jest.fn(() => false),
  storeChangeLimits: jest.fn(),
  getDurableAIActionIntentKey: jest.fn(() => null),
}));

jest.mock('../../services/aiAttachmentService', () => ({
  processChatAttachments: jest.fn(),
  appendAttachmentContextToMessages: jest.fn((messages) => messages),
}));

jest.mock('../../services/aiChatRateLimitService', () => ({
  consumeDailyUsageForRequest: jest.fn(),
}));

const ChatHistory = require('../../models/ChatHistory');
const {
  createConversation,
  getConversations,
  __private,
} = require('../../controllers/aiChatController');

const objectId = (value) => ({ toString: () => value });

const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

describe('AI conversation history contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns only web/app conversations while preserving their source metadata', async () => {
    ChatHistory.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        activeConversationId: objectId('mobile-chat'),
        conversations: [
          {
            _id: objectId('whatsapp-chat'),
            title: '[WhatsApp] Chat',
            source: 'whatsapp',
            messages: [{ role: 'user', content: 'Private WhatsApp message' }],
            lastActive: new Date('2035-06-15T10:00:00.000Z'),
          },
          {
            _id: objectId('web-chat'),
            title: 'Web ideas',
            source: 'web',
            messages: [{ role: 'user', content: 'Show me jackets' }],
            lastActive: new Date('2035-06-14T10:00:00.000Z'),
          },
          {
            _id: objectId('mobile-chat'),
            title: 'App order help',
            source: 'mobile',
            messages: [{ role: 'user', content: 'Track my order' }],
            lastActive: new Date('2035-06-15T11:00:00.000Z'),
          },
        ],
      }),
    });
    const res = response();

    await getConversations({ user: { id: 'user-1' } }, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      activeConversationId: expect.objectContaining({ toString: expect.any(Function) }),
      conversations: [
        expect.objectContaining({ _id: expect.anything(), source: 'mobile', preview: 'Track my order' }),
        expect.objectContaining({ _id: expect.anything(), source: 'web', preview: 'Show me jackets' }),
      ],
    }));
    const payload = res.json.mock.calls[0][0];
    expect(payload.conversations).toHaveLength(2);
    expect(payload.conversations.some(conversation => conversation.source === 'whatsapp')).toBe(false);
  });

  it('creates a native conversation with trimmed title and mobile source', async () => {
    const conversations = [];
    conversations.push = jest.fn(function pushConversation(value) {
      return Array.prototype.push.call(this, { ...value, _id: objectId('new-mobile-chat') });
    });
    const history = {
      conversations,
      activeConversationId: null,
      save: jest.fn().mockResolvedValue(undefined),
    };
    ChatHistory.findOne.mockResolvedValue(null);
    ChatHistory.mockImplementationOnce(() => history);
    const res = response();

    await createConversation({
      user: { id: 'user-1' },
      body: { title: '  Packing list  ', source: 'mobile' },
    }, res);

    expect(history.save).toHaveBeenCalledTimes(1);
    expect(conversations[0]).toEqual(expect.objectContaining({
      title: 'Packing list',
      source: 'mobile',
      isActive: true,
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Packing list',
      source: 'mobile',
    }));
  });

  it('never appends a mobile turn into the isolated WhatsApp conversation', async () => {
    const whatsapp = {
      _id: objectId('whatsapp-chat'),
      source: 'whatsapp',
      isActive: false,
      messages: [],
    };
    const app = {
      _id: objectId('app-chat'),
      title: 'New Chat',
      source: 'mobile',
      isActive: true,
      messages: [],
    };
    const conversations = [whatsapp, app];
    conversations.id = jest.fn(() => whatsapp);
    const history = {
      conversations,
      activeConversationId: app._id,
      save: jest.fn().mockResolvedValue(undefined),
    };
    ChatHistory.findOne.mockResolvedValue(history);

    const savedId = await __private.saveToConversation(
      'user-1',
      'whatsapp-chat',
      [{ role: 'user', content: 'Continue in the app' }],
      'mobile',
    );

    expect(savedId.toString()).toBe('app-chat');
    expect(whatsapp.messages).toHaveLength(0);
    expect(app.messages).toEqual([expect.objectContaining({
      role: 'user',
      content: 'Continue in the app',
    })]);
    expect(app.title).toBe('Continue in the app');
    expect(history.save).toHaveBeenCalledTimes(1);
  });
});
