jest.mock('axios', () => ({
  create: jest.fn(),
}));

jest.mock('../../models/WhatsAppJidMapping', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

const axios = require('axios');
const createEvolutionClient = require('../../services/whatsapp/createEvolutionClient');

describe('Evolution client recipient routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EVOLUTION_API_URL = 'http://evolution.test';
    process.env.EVOLUTION_API_KEY = 'test-key';
    delete process.env.EVOLUTION_SELLER_INSTANCE_NAME;
  });

  test('routes a phone JID to the recent LID chat before sending text', async () => {
    let sentPayload;
    axios.create.mockReturnValue({
      post: jest.fn(async (url, payload) => {
        if (url.includes('/chat/findMessages/')) {
          return {
            data: {
              messages: {
                records: [
                  {
                    key: {
                      fromMe: false,
                      remoteJid: '39767790104698@lid',
                      remoteJidAlt: '923499166402@s.whatsapp.net',
                    },
                    message: { conversation: 'Hi' },
                  },
                ],
              },
            },
          };
        }

        sentPayload = payload;
        return { data: { key: { id: 'test-message' } } };
      }),
    });

    const client = createEvolutionClient('EVOLUTION_SELLER_INSTANCE_NAME', 'rozare-seller');
    await client.sendText('923499166402@s.whatsapp.net', 'hello');

    expect(sentPayload.number).toBe('39767790104698@lid');
    expect(sentPayload.delay).toBe(0);
  });
});
