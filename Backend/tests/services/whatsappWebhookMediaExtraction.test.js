jest.mock('../../services/whatsapp/whatsappAIChatService', () => ({
  processIncomingWhatsAppMessage: jest.fn(),
}));
jest.mock('../../services/whatsapp/inboundProcessingService', () => ({
  processInboundMessageOnce: jest.fn(async (input) => ({
    processed: true,
    value: await input.work({ attempt: 2 }),
  })),
}));

const { processIncomingWhatsAppMessage } = require('../../services/whatsapp/whatsappAIChatService');
const { processInboundMessageOnce } = require('../../services/whatsapp/inboundProcessingService');

const {
  extractMediaAttachments,
  extractMessageText,
  isFromMeMessage,
  processAIInboundDurably,
} = require('../../services/whatsapp/webhookHandler').__private;

describe('Evolution v2.3.7 webhook media extraction', () => {
  test('extracts an inline Baileys 7 PTT voice note through an ephemeral wrapper', () => {
    const bytes = Buffer.from('synthetic opus voice note');
    const message = {
      key: {
        id: 'VOICE_EPHEMERAL_1',
        remoteJid: '39767790104698@lid',
        senderPn: '923499166402@s.whatsapp.net',
        fromMe: false,
      },
      message: {
        ephemeralMessage: {
          message: {
            audioMessage: {
              mimetype: 'audio/ogg; codecs=opus',
              ptt: true,
              base64: bytes.toString('base64'),
            },
          },
        },
      },
    };

    expect(extractMediaAttachments(message, {
      instanceName: 'rozare-seller',
      instanceType: 'seller',
    })).toEqual([
      expect.objectContaining({
        kind: 'audio',
        mimetype: 'audio/ogg; codecs=opus',
        filename: 'whatsapp-voice.ogg',
        base64: bytes.toString('base64'),
        messageId: 'VOICE_EPHEMERAL_1',
        evolutionInstance: 'rozare-seller',
      }),
    ]);
  });

  test('extracts voice media and captions through view-once-v2 wrappers', () => {
    const bytes = Buffer.from('synthetic wrapped audio');
    const voice = {
      key: { id: 'VOICE_VIEWONCE_1', fromMe: 'false' },
      message: {
        viewOnceMessageV2: {
          message: {
            audioMessage: {
              mimetype: 'audio/ogg; codecs=opus',
              base64: bytes.toString('base64'),
            },
          },
        },
      },
    };
    const caption = {
      message: {
        ephemeralMessage: {
          message: { imageMessage: { caption: 'Please add this product' } },
        },
      },
    };

    expect(extractMediaAttachments(voice)[0].base64).toBe(bytes.toString('base64'));
    expect(extractMessageText(caption)).toBe('Please add this product');
  });

  test('normalizes Evolution fromMe values before accepting inbound work', () => {
    expect(isFromMeMessage({ key: { fromMe: true } })).toBe(true);
    expect(isFromMeMessage({ key: { fromMe: 'true' } })).toBe(true);
    expect(isFromMeMessage({ key: { fromMe: 1 } })).toBe(true);
    expect(isFromMeMessage({ key: { fromMe: 'false' } })).toBe(false);
  });

  test('bridges a stable Evolution message id into retry-safe AI processing', async () => {
    processIncomingWhatsAppMessage.mockResolvedValueOnce('sent');
    const attachment = { kind: 'audio', messageId: 'VOICE-DURABLE-1' };

    await expect(processAIInboundDurably({
      msg: { key: { id: 'VOICE-DURABLE-1' } },
      phone: '923001112222',
      text: '',
      instanceType: 'seller',
      instanceName: 'rozare-seller',
      attachments: [attachment],
      replyTo: '39767790104698@lid',
      candidatePhones: ['923001112222'],
    })).resolves.toMatchObject({ processed: true, value: 'sent' });

    expect(processInboundMessageOnce).toHaveBeenCalledWith(expect.objectContaining({
      instanceName: 'rozare-seller',
      messageId: 'VOICE-DURABLE-1',
      phone: '923001112222',
      work: expect.any(Function),
    }));
    expect(processIncomingWhatsAppMessage).toHaveBeenCalledWith(
      '923001112222',
      '',
      'seller',
      [attachment],
      {
        replyTo: '39767790104698@lid',
        candidatePhones: ['923001112222'],
        durableAttempt: 2,
        propagateErrors: true,
        suppressErrorResponse: true,
      }
    );
  });
});
