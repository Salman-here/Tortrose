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
jest.mock('../../services/whatsappIdentityService', () => ({
  findWhatsAppIdentityConflict: jest.fn().mockResolvedValue(null),
}));

const User = require('../../models/User');
const AdminWhatsAppNumber = require('../../models/AdminWhatsAppNumber');
const { findWhatsAppIdentityConflict } = require('../../services/whatsappIdentityService');
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
      _id: 'admin-number-1',
      number: '923001112222',
      isActive: true,
      addedBy: { _id: 'admin-1', role: 'admin', status: 'active', username: 'Admin' },
    }));

    const identified = await _identifyUserByPhoneCandidates(['923001112222'], 'unified');

    expect(identified.role).toBe('admin');
    expect(identified.instanceType).toBe('seller');
    expect(identified.matchedPhone).toBe('923001112222');
    expect(User.findOne).not.toHaveBeenCalled();
  });

  test('ignores a stale admin-number record whose owner was deleted', async () => {
    AdminWhatsAppNumber.findOne.mockReturnValue(queryWithPopulate({
      _id: 'stale-admin-number',
      number: '923001112222',
      isActive: true,
      addedBy: null,
    }));
    User.findOne
      .mockReturnValueOnce(queryWithSelect({
        _id: 'seller-1',
        role: 'seller',
        username: 'Seller',
      }));

    const identified = await _identifyUserByPhoneCandidates(['923001112222'], 'unified');

    expect(identified).toMatchObject({ role: 'seller', instanceType: 'seller' });
    expect(User.findOne).toHaveBeenCalledTimes(1);
  });

  test('never keeps admin privileges after the authorization owner is demoted', async () => {
    AdminWhatsAppNumber.findOne.mockReturnValue(queryWithPopulate({
      _id: 'demoted-admin-number',
      number: '923001112222',
      isActive: true,
      addedBy: { _id: 'former-admin', role: 'seller', status: 'active', username: 'Former Admin' },
    }));
    User.findOne.mockReturnValueOnce(queryWithSelect({
      _id: 'former-admin',
      role: 'seller',
      status: 'active',
      username: 'Former Admin',
    }));

    const identified = await _identifyUserByPhoneCandidates(['923001112222'], 'unified');

    expect(identified).toMatchObject({ role: 'seller', instanceType: 'seller' });
    expect(identified.role).not.toBe('admin');
  });

  test('never keeps admin privileges after the authorization owner is blocked', async () => {
    AdminWhatsAppNumber.findOne.mockReturnValue(queryWithPopulate({
      _id: 'blocked-admin-number',
      number: '923001112222',
      isActive: true,
      addedBy: { _id: 'blocked-admin', role: 'admin', status: 'blocked', username: 'Blocked Admin' },
    }));
    User.findOne
      .mockReturnValueOnce(queryWithSelect(null))
      .mockReturnValueOnce(queryWithSelect(null));

    const identified = await _identifyUserByPhoneCandidates(['923001112222'], 'unified');

    expect(identified).toBeNull();
  });

  test('fails closed on legacy admin and verified seller number collisions', async () => {
    AdminWhatsAppNumber.findOne.mockReturnValue(queryWithPopulate({
      _id: 'conflicting-admin-number',
      number: '923001112222',
      isActive: true,
      addedBy: { _id: 'admin-1', role: 'admin', status: 'active', username: 'Admin' },
    }));
    findWhatsAppIdentityConflict.mockResolvedValueOnce({ kind: 'seller' });
    User.findOne.mockReturnValueOnce(queryWithSelect({
      _id: 'seller-1',
      role: 'seller',
      username: 'Seller',
    }));

    const identified = await _identifyUserByPhoneCandidates(['923001112222'], 'unified');

    expect(identified).toMatchObject({ role: 'seller', instanceType: 'seller' });
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
