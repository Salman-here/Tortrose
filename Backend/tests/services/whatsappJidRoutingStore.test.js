jest.mock('../../models/WhatsAppJidMapping', () => ({
  findOneAndUpdate: jest.fn(),
  findOne: jest.fn(),
}));

const WhatsAppJidMapping = require('../../models/WhatsAppJidMapping');
const mongoose = require('mongoose');
const {
  rememberInboundRoute,
  resolveOutboundRecipient,
} = require('../../services/whatsapp/jidRoutingStore');

describe('WhatsApp JID routing store', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(mongoose.connection, 'readyState', {
      configurable: true,
      get: () => 1,
    });
  });

  test('persists a phone to LID route per instance', async () => {
    WhatsAppJidMapping.findOneAndUpdate.mockResolvedValue({
      phone: '923499166402',
      instanceType: 'seller',
      lidJid: '39767790104698@lid',
    });

    const saved = await rememberInboundRoute(
      { identityPhone: '923499166402', lidJid: '39767790104698@lid' },
      { instanceType: 'seller', instanceName: 'rozare-seller' }
    );

    expect(saved.lidJid).toBe('39767790104698@lid');
    expect(WhatsAppJidMapping.findOneAndUpdate).toHaveBeenCalledWith(
      { phone: '923499166402', instanceType: 'seller' },
      expect.objectContaining({
        $set: expect.objectContaining({
          lidJid: '39767790104698@lid',
          instanceName: 'rozare-seller',
        }),
      }),
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  });

  test('keeps an explicit phone JID unchanged', async () => {
    WhatsAppJidMapping.findOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          phone: '923000000001',
          instanceType: 'main',
          lidJid: '11111111111111@lid',
        }),
      }),
    });

    const recipient = await resolveOutboundRecipient(
      '923000000001',
      '923000000001@s.whatsapp.net',
      { instanceType: 'main' }
    );

    expect(recipient).toBe('923000000001@s.whatsapp.net');
    expect(WhatsAppJidMapping.findOne).not.toHaveBeenCalled();
  });

  test('uses a persisted route when the requested recipient is a bare phone', async () => {
    WhatsAppJidMapping.findOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          phone: '923000000001',
          instanceType: 'main',
          lidJid: '11111111111111@lid',
        }),
      }),
    });

    const recipient = await resolveOutboundRecipient(
      '923000000001',
      '923000000001',
      { instanceType: 'main' }
    );

    expect(recipient).toBe('11111111111111@lid');
    expect(WhatsAppJidMapping.findOne).toHaveBeenCalledWith({
      phone: '923000000001',
      instanceType: 'main',
    });
  });

  test('keeps an explicit LID recipient unchanged', async () => {
    const recipient = await resolveOutboundRecipient(
      '923000000002',
      '22222222222222@lid',
      { instanceType: 'main' }
    );

    expect(recipient).toBe('22222222222222@lid');
    expect(WhatsAppJidMapping.findOne).not.toHaveBeenCalled();
  });

  test('rejects a connected-owner phone JID that does not match the resolved sender', async () => {
    WhatsAppJidMapping.findOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      }),
    });

    const recipient = await resolveOutboundRecipient(
      '923499166499',
      '923028588506@s.whatsapp.net',
      { instanceType: 'seller' }
    );

    expect(recipient).toBe('923499166499@s.whatsapp.net');
    expect(recipient).not.toContain('923028588506');
  });
});
