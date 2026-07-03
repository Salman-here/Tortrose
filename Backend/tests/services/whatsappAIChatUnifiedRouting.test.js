jest.mock('../../models/User', () => ({
  findOne: jest.fn(),
}));

jest.mock('../../models/AdminWhatsAppNumber', () => ({
  findOne: jest.fn(),
}));

jest.mock('../../models/WhatsAppAIChatRateLimit', () => ({}));
jest.mock('../../models/ChatHistory', () => ({}));
jest.mock('../../controllers/aiChatController', () => ({
  processAIChatMessage: jest.fn(),
}));
jest.mock('../../services/aiAttachmentService', () => ({
  processChatAttachments: jest.fn(),
}));
jest.mock('../../services/whatsapp/evolutionClient', () => ({
  isConfigured: jest.fn(() => true),
  sendText: jest.fn(),
}));
jest.mock('../../services/whatsapp/sellerEvolutionClient', () => ({
  isConfigured: jest.fn(() => true),
  sendText: jest.fn(),
}));
jest.mock('../../services/whatsapp/jidRoutingStore', () => ({
  resolveOutboundRecipient: jest.fn(async (_phone, requested) => requested),
}));

const User = require('../../models/User');
const AdminWhatsAppNumber = require('../../models/AdminWhatsAppNumber');
const {
  _identifyUserByPhoneCandidates,
} = require('../../services/whatsapp/whatsappAIChatService');

const queryWithSelect = (value) => ({
  select: jest.fn().mockResolvedValue(value),
});

const queryWithPopulate = (value) => ({
  populate: jest.fn().mockResolvedValue(value),
});

describe('WhatsApp AI unified identity routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('unified route gives admin WhatsApp numbers first priority', async () => {
    AdminWhatsAppNumber.findOne.mockReturnValue(queryWithPopulate({
      number: '923001112222',
      isActive: true,
      addedBy: { _id: 'admin-1', role: 'admin', username: 'Admin' },
    }));

    const identified = await _identifyUserByPhoneCandidates(['923001112222'], 'unified');

    expect(identified.role).toBe('admin');
    expect(identified.instanceType).toBe('seller');
    expect(identified.matchedPhone).toBe('923001112222');
    expect(User.findOne).not.toHaveBeenCalled();
  });

  test('unified route resolves verified sellers before buyer links', async () => {
    AdminWhatsAppNumber.findOne.mockReturnValue(queryWithPopulate(null));
    User.findOne.mockReturnValueOnce(queryWithSelect({
      _id: 'seller-1',
      role: 'seller',
      username: 'Seller',
      sellerInfo: { whatsappNumber: '+923001112222' },
    }));

    const identified = await _identifyUserByPhoneCandidates(['923001112222'], 'unified');

    expect(identified.role).toBe('seller');
    expect(identified.instanceType).toBe('seller');
    expect(identified.matchedPhone).toBe('923001112222');
  });

  test('unified route falls back to verified buyer WhatsApp links', async () => {
    AdminWhatsAppNumber.findOne.mockReturnValue(queryWithPopulate(null));
    User.findOne
      .mockReturnValueOnce(queryWithSelect(null))
      .mockReturnValueOnce(queryWithSelect({
        _id: 'buyer-1',
        role: 'user',
        username: 'Buyer',
        whatsappInfo: { number: '+923001112222', verified: true },
      }));

    const identified = await _identifyUserByPhoneCandidates(['923001112222'], 'unified');

    expect(identified.role).toBe('user');
    expect(identified.instanceType).toBe('main');
    expect(identified.matchedPhone).toBe('923001112222');
  });

  test('unified route returns null for unlinked numbers', async () => {
    AdminWhatsAppNumber.findOne.mockReturnValue(queryWithPopulate(null));
    User.findOne
      .mockReturnValueOnce(queryWithSelect(null))
      .mockReturnValueOnce(queryWithSelect(null));

    await expect(_identifyUserByPhoneCandidates(['923001112222'], 'unified'))
      .resolves.toBeNull();
  });
});
